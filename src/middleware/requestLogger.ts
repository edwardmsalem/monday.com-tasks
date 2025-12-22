/**
 * Request Logging Middleware
 *
 * Provides structured logging for all HTTP requests with:
 * - Unique request ID for tracing
 * - Request timing (duration)
 * - Response status
 * - Slow request warnings
 *
 * Security considerations:
 * - Does NOT log request body (may contain sensitive data)
 * - Does NOT log full headers (may contain tokens)
 * - Truncates user-agent to prevent log injection
 */

import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

// ============================================================================
// Types
// ============================================================================

export interface RequestLogEntry {
  timestamp: string;
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  userAgent?: string;
  contentLength?: number;
  error?: string;
}

// Extend Express Request to include requestId
declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

// ============================================================================
// Constants
// ============================================================================

/** Threshold for slow request warning (ms) */
const SLOW_REQUEST_THRESHOLD_MS = 5000;

/** Maximum length for user-agent string to prevent log injection */
const MAX_USER_AGENT_LENGTH = 100;

// ============================================================================
// Request ID Generation
// ============================================================================

/**
 * Generate unique request ID (short form for readability)
 */
export function generateRequestId(): string {
  return randomUUID().substring(0, 8);
}

/**
 * Get request ID from request object
 * Returns 'unknown' if not set (shouldn't happen if middleware is applied)
 */
export function getRequestId(req: Request): string {
  return req.requestId || 'unknown';
}

// ============================================================================
// Middleware
// ============================================================================

/**
 * Request logging middleware
 *
 * Must be applied BEFORE route handlers to capture all requests.
 * Logs structured JSON for easy parsing by log aggregators.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = generateRequestId();
  const startTime = Date.now();

  // Attach requestId to request for use in handlers
  req.requestId = requestId;

  // Add requestId to response headers for client-side correlation
  res.setHeader('X-Request-ID', requestId);

  // Log on response finish (after response is sent)
  res.on('finish', () => {
    const duration = Date.now() - startTime;

    // Get content length, handling missing/invalid values
    const contentLengthHeader = req.get('content-length');
    const contentLength = contentLengthHeader
      ? parseInt(contentLengthHeader, 10) || undefined
      : undefined;

    // Truncate user-agent to prevent log injection attacks
    const userAgent = req.get('user-agent')?.substring(0, MAX_USER_AGENT_LENGTH);

    const entry: RequestLogEntry = {
      timestamp: new Date().toISOString(),
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: duration,
      userAgent,
      contentLength,
    };

    // Log as structured JSON for easy parsing
    console.log(JSON.stringify({ type: 'request', ...entry }));

    // Warn on slow requests
    if (duration > SLOW_REQUEST_THRESHOLD_MS) {
      console.warn(JSON.stringify({
        type: 'slow_request',
        requestId,
        method: req.method,
        path: req.path,
        durationMs: duration,
      }));
    }
  });

  next();
}

// ============================================================================
// Structured Error Logging
// ============================================================================

/**
 * Log an error with request context
 * Use this in catch blocks to include requestId for correlation
 */
export function logError(req: Request, error: Error | string, context?: string): void {
  const errorMessage = error instanceof Error ? error.message : error;
  const errorStack = error instanceof Error ? error.stack : undefined;

  console.error(JSON.stringify({
    type: 'error',
    requestId: getRequestId(req),
    context,
    error: errorMessage,
    stack: errorStack?.substring(0, 500), // Limit stack trace length
  }));
}

/**
 * Log a warning with request context
 */
export function logWarning(req: Request, message: string, context?: string): void {
  console.warn(JSON.stringify({
    type: 'warning',
    requestId: getRequestId(req),
    context,
    message,
  }));
}

/**
 * Log an info message with request context
 */
export function logInfo(req: Request, message: string, context?: string): void {
  console.log(JSON.stringify({
    type: 'info',
    requestId: getRequestId(req),
    context,
    message,
  }));
}
