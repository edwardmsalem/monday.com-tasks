/**
 * Comprehensive Health Check Service
 *
 * Verifies connectivity to all external services and reports system health.
 * Results are cached for 30 seconds to avoid hammering external APIs.
 */

import { config } from '../config/environment.js';
import { getAllCircuitStats } from './circuitBreaker.js';
import { getQueueStats } from './jobQueue.js';

// ============================================================================
// Types
// ============================================================================

export interface ServiceHealth {
  ok: boolean;
  latencyMs: number;
  error?: string;
  lastChecked: Date;
}

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: Date;
  uptime: number; // seconds
  services: {
    monday: ServiceHealth;
    slack: ServiceHealth;
    gmail: ServiceHealth;
    convertApi: ServiceHealth;
  };
  circuitBreakers: Record<string, string>; // circuit name → state
  jobQueue: {
    pending: number;
    failed: number;
  };
}

// ============================================================================
// State
// ============================================================================

const startTime = Date.now();
let cachedResult: HealthCheckResult | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL_MS = 30 * 1000; // 30 seconds

// ============================================================================
// Individual Service Checks
// ============================================================================

/**
 * Check Monday.com API health
 */
async function checkMondayHealth(): Promise<ServiceHealth> {
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: config.monday.apiToken,
        'API-Version': '2024-01',
      },
      body: JSON.stringify({ query: 'query { me { id } }' }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    if (result.errors?.length > 0) {
      throw new Error(result.errors[0].message);
    }

    return {
      ok: true,
      latencyMs: Date.now() - start,
      lastChecked: new Date(),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
      lastChecked: new Date(),
    };
  }
}

/**
 * Check Slack API health using auth.test
 */
async function checkSlackHealth(): Promise<ServiceHealth> {
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.slack.botToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    if (!result.ok) {
      throw new Error(result.error || 'Unknown Slack error');
    }

    return {
      ok: true,
      latencyMs: Date.now() - start,
      lastChecked: new Date(),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
      lastChecked: new Date(),
    };
  }
}

/**
 * Check Gmail API health using labels.list
 */
async function checkGmailHealth(): Promise<ServiceHealth> {
  const start = Date.now();

  // Check if Gmail is configured
  if (!config.google.clientId || !config.google.clientSecret || !config.google.refreshToken) {
    return {
      ok: true, // Not configured is not an error
      latencyMs: 0,
      error: 'Gmail not configured',
      lastChecked: new Date(),
    };
  }

  try {
    // Get access token using refresh token
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        refresh_token: config.google.refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!tokenResponse.ok) {
      throw new Error(`Token refresh failed: ${tokenResponse.status}`);
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    // Test Gmail API with labels.list
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/labels?maxResults=1',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return {
      ok: true,
      latencyMs: Date.now() - start,
      lastChecked: new Date(),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
      lastChecked: new Date(),
    };
  }
}

/**
 * Check ConvertAPI health
 * Uses the user endpoint to verify API key validity
 */
async function checkConvertApiHealth(): Promise<ServiceHealth> {
  const start = Date.now();

  // Check if ConvertAPI is configured
  if (!config.convertApi.secret) {
    return {
      ok: true, // Not configured is not an error
      latencyMs: 0,
      error: 'ConvertAPI not configured',
      lastChecked: new Date(),
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    // ConvertAPI user endpoint to check API key validity
    const response = await fetch(
      `https://v2.convertapi.com/user?Secret=${config.convertApi.secret}`,
      { signal: controller.signal }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    if (result.Code) {
      throw new Error(result.Message || 'ConvertAPI error');
    }

    return {
      ok: true,
      latencyMs: Date.now() - start,
      lastChecked: new Date(),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
      lastChecked: new Date(),
    };
  }
}

// ============================================================================
// Main Health Check
// ============================================================================

/**
 * Perform comprehensive health check
 *
 * @param forceRefresh - Bypass cache and perform fresh checks
 * @returns Health check result with all service statuses
 */
export async function checkHealth(forceRefresh: boolean = false): Promise<HealthCheckResult> {
  // Return cached result if valid and not forcing refresh
  if (!forceRefresh && cachedResult && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedResult;
  }

  // Run all health checks in parallel
  const [monday, slack, gmail, convertApi] = await Promise.all([
    checkMondayHealth(),
    checkSlackHealth(),
    checkGmailHealth(),
    checkConvertApiHealth(),
  ]);

  // Get circuit breaker states
  const circuitStats = getAllCircuitStats();
  const circuitBreakers: Record<string, string> = {};
  for (const [name, stats] of Object.entries(circuitStats)) {
    circuitBreakers[name] = stats.state;
  }

  // Get job queue stats
  const queueStats = getQueueStats();

  // Determine overall status
  // Core services: Monday and Slack (must be up for "healthy")
  // Non-core: Gmail and ConvertAPI (can be down for "degraded")
  const coreServicesOk = monday.ok && slack.ok;
  const allServicesOk = coreServicesOk && gmail.ok && convertApi.ok;

  let status: 'healthy' | 'degraded' | 'unhealthy';
  if (allServicesOk) {
    status = 'healthy';
  } else if (coreServicesOk) {
    status = 'degraded';
  } else {
    status = 'unhealthy';
  }

  const result: HealthCheckResult = {
    status,
    timestamp: new Date(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    services: {
      monday,
      slack,
      gmail,
      convertApi,
    },
    circuitBreakers,
    jobQueue: {
      pending: queueStats.pending,
      failed: queueStats.failed,
    },
  };

  // Cache the result
  cachedResult = result;
  cacheTimestamp = Date.now();

  return result;
}

/**
 * Get uptime in seconds
 */
export function getUptime(): number {
  return Math.floor((Date.now() - startTime) / 1000);
}

/**
 * Format uptime as human-readable string
 */
export function formatUptime(): string {
  const seconds = getUptime();
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);

  return parts.join(' ');
}
