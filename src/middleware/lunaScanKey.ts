/**
 * Scan-only key for Luna (Eddie, 2026-10-16: Luna should get the tracking
 * sheet and calendar events the app's Scan button makes, for the accounts that
 * got a team email).
 *
 * What it checks: requests carrying TRIAGE_SCAN_KEY_LUNA as a Bearer token.
 * That key opens exactly one route, POST /tasks/scan. Any other method or path
 * with it gets 403 before any router runs. An hourly guard limits how many
 * scans it can start, since each scan reads every matching email with the AI
 * and writes a sheet and calendar events.
 */

import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

export function lunaScanAllowed(method: string, path: string): boolean {
  return method === 'POST' && /^\/tasks\/scan\/?$/.test(path);
}

export function isLunaScanKey(req: Request, key = process.env['TRIAGE_SCAN_KEY_LUNA']): boolean {
  const h = req.headers.authorization;
  if (!key || !h || !h.startsWith('Bearer ')) return false;
  const a = Buffer.from(h.slice(7)), b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const perHour = () => Number(process.env['LUNA_SCAN_PER_HOUR']) || 20;
let windowStart = 0;
let used = 0;
export function resetLunaScanWindow(): void { windowStart = 0; used = 0; }

/** Mount before every router. Requests without the key pass through untouched. */
export function lunaScanGuard(req: Request, res: Response, next: NextFunction): void {
  if (!isLunaScanKey(req)) { next(); return; }
  if (!lunaScanAllowed(req.method, req.path)) {
    res.status(403).json({ success: false, error: 'Scan-only key: route not allowed' });
    return;
  }
  const now = Date.now();
  if (now - windowStart >= 3_600_000) { windowStart = now; used = 0; }
  if (++used > perHour()) {
    res.setHeader('Retry-After', String(Math.ceil((windowStart + 3_600_000 - now) / 1000)));
    res.status(429).json({ success: false, error: `Scan-only key: limit ${perHour()} scans per hour` });
    return;
  }
  (req as any).lunaScan = true;
  next();
}
