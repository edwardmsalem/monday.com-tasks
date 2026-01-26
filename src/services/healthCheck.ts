/**
 * Comprehensive Health Check Service
 *
 * All external services (Monday, Slack, Gmail, ConvertAPI) are accessed via core-api.
 * This service verifies core-api connectivity and reports system health.
 * Results are cached for 30 seconds to avoid hammering the API.
 */

import { config, configCompat } from '../config/environment.js';
import { HEALTH_CHECK_CACHE_TTL_MS, HEALTH_CHECK_TIMEOUT_MS } from '../config/constants.js';
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

// ============================================================================
// Individual Service Checks
// ============================================================================

/**
 * Check core-api health (all external services are accessed via core-api)
 */
async function checkCoreApiHealth(): Promise<ServiceHealth> {
  const start = Date.now();

  // Monday is now accessed via core-api - check core-api connectivity instead
  if (!config.coreApi.apiKey) {
    return {
      ok: true, // Not configured via core-api is ok if using legacy direct access
      latencyMs: 0,
      error: 'Core API not configured',
      lastChecked: new Date(),
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

    // Check core-api health endpoint instead of Monday directly
    const response = await fetch(`${config.coreApi.url}/health`, {
      method: 'GET',
      headers: {
        'X-API-Key': config.coreApi.apiKey,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Core API HTTP ${response.status}: ${response.statusText}`);
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
 * Check Slack API health
 * Now accessed via core-api, so just verify core-api is configured
 * Core-api's own health check verifies Slack connectivity
 */
async function checkSlackHealth(): Promise<ServiceHealth> {
  // Slack is now accessed via core-api
  // Core-api health is already checked in checkMondayHealth
  // Just return ok if core-api is configured
  return {
    ok: !!config.coreApi.apiKey,
    latencyMs: 0,
    error: config.coreApi.apiKey ? undefined : 'Slack accessed via core-api (not configured)',
    lastChecked: new Date(),
  };
}

/**
 * Check Gmail API health
 * Now accessed via core-api, so just verify core-api is configured
 * Core-api's own health check verifies Gmail connectivity
 */
async function checkGmailHealth(): Promise<ServiceHealth> {
  // Gmail is now accessed via core-api
  // Core-api health is already checked in checkMondayHealth
  // Just return ok if core-api is configured
  return {
    ok: !!config.coreApi.apiKey,
    latencyMs: 0,
    error: config.coreApi.apiKey ? undefined : 'Gmail accessed via core-api (not configured)',
    lastChecked: new Date(),
  };
}

/**
 * Check ConvertAPI health
 * Now accessed via core-api, so just verify core-api is reachable
 */
async function checkConvertApiHealth(): Promise<ServiceHealth> {
  // ConvertAPI is now accessed via core-api
  // Core-api health is already checked in checkMondayHealth
  // Just return ok if core-api is configured
  return {
    ok: !!config.coreApi.apiKey,
    latencyMs: 0,
    error: config.coreApi.apiKey ? undefined : 'ConvertAPI accessed via core-api',
    lastChecked: new Date(),
  };
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
  if (!forceRefresh && cachedResult && Date.now() - cacheTimestamp < HEALTH_CHECK_CACHE_TTL_MS) {
    return cachedResult;
  }

  // Run all health checks in parallel
  // All services now go through core-api, so we check core-api connectivity
  const [monday, slack, gmail, convertApi] = await Promise.all([
    checkCoreApiHealth(),  // Checks actual connectivity to core-api
    checkSlackHealth(),    // Returns ok if core-api configured
    checkGmailHealth(),    // Returns ok if core-api configured
    checkConvertApiHealth(), // Returns ok if core-api configured
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
