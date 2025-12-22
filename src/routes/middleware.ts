/**
 * Shared Express middleware for route handlers
 */

import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config/environment.js';

/**
 * Extended Request type with rawBody for Slack signature verification
 */
export interface SlackRequest extends Request {
  rawBody?: string;
}

/**
 * Middleware to capture raw body for Slack slash commands
 * Allows signature verification while still having parsed req.body
 */
export function slackUrlEncodedWithRawBody(
  req: SlackRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
    next();
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    req.rawBody = rawBody;

    // Parse urlencoded body manually
    const parsed: Record<string, string> = {};
    rawBody.split('&').forEach((pair) => {
      const [key, value] = pair.split('=');
      if (key) {
        parsed[decodeURIComponent(key)] = decodeURIComponent(value?.replace(/\+/g, ' ') || '');
      }
    });
    req.body = parsed;
    next();
  });
  req.on('error', (err) => next(err));
}

/**
 * Verify Slack request signature (QW-07)
 * Returns true if signature is valid, false otherwise
 * @see https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(req: SlackRequest): boolean {
  const signingSecret = config.slack.signingSecret;
  if (!signingSecret) {
    console.warn('SLACK_SIGNING_SECRET not configured - skipping signature verification');
    return true; // Skip verification if not configured (dev mode)
  }

  const timestamp = req.headers['x-slack-request-timestamp'] as string;
  const slackSignature = req.headers['x-slack-signature'] as string;

  if (!timestamp || !slackSignature) {
    console.error('Missing Slack signature headers');
    return false;
  }

  // Protect against replay attacks (request must be within 5 minutes)
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp, 10) < fiveMinutesAgo) {
    console.error('Slack request timestamp too old (possible replay attack)');
    return false;
  }

  // Get raw body - either from Buffer (events) or captured string (slash commands)
  const bodyString = req.rawBody ?? req.body?.toString() ?? '';

  // Compute expected signature
  const sigBasestring = `v0:${timestamp}:${bodyString}`;
  const expectedSignature =
    'v0=' +
    crypto.createHmac('sha256', signingSecret).update(sigBasestring).digest('hex');

  // Constant-time comparison to prevent timing attacks
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(slackSignature))) {
      console.error('Invalid Slack signature');
      return false;
    }
  } catch {
    // timingSafeEqual throws if buffers are different lengths
    console.error('Invalid Slack signature (length mismatch)');
    return false;
  }

  return true;
}
