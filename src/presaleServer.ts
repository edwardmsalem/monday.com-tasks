/**
 * Presale Scanner Server
 *
 * A lightweight, standalone server that ONLY runs the presale scanner.
 * No webhooks, no digests, no task workflows. Just:
 * - Health endpoint (GET /health)
 * - Manual trigger endpoint (POST /admin/presale/scan)
 * - Hourly cron that calls the scanner
 *
 * Designed to run as a SEPARATE Railway service.
 * Start command: node dist/presaleServer.js
 */

import express, { type Request, type Response } from 'express';
import { config } from './config/environment.js';
import { scanPresales } from './services/presaleScanner.js';
import { getFullState, getLastScan, reloadState } from './services/presaleState.js';

const app = express();

// Parse JSON bodies
app.use(express.json());

// ============================================================================
// Health Endpoint
// ============================================================================

app.get('/health', (_req: Request, res: Response): void => {
  const lastScan = getLastScan();
  res.json({
    status: 'ok',
    service: 'presale-scanner',
    lastScan,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ============================================================================
// Manual Trigger Endpoint
// ============================================================================

/**
 * POST /admin/presale/scan
 *
 * Manually trigger a presale scan
 * Optional body: { lookbackMinutes: number }
 *
 * Returns: { scanned, newPresales, posted, skipped, errors }
 */
app.post('/admin/presale/scan', async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('[PresaleServer] Manual scan triggered');

    const lookbackMinutes = req.body?.lookbackMinutes as number | undefined;

    const result = await scanPresales(lookbackMinutes);

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('[PresaleServer] Manual scan failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================================================
// State Debug Endpoint
// ============================================================================

/**
 * GET /admin/presale/state
 *
 * View the current presale state (for debugging)
 */
app.get('/admin/presale/state', (_req: Request, res: Response): void => {
  const state = getFullState();
  res.json(state);
});

/**
 * POST /admin/presale/state/reload
 *
 * Force reload state from disk
 */
app.post('/admin/presale/state/reload', (_req: Request, res: Response): void => {
  reloadState();
  res.json({ success: true, message: 'State reloaded from disk' });
});

// ============================================================================
// Hourly Cron
// ============================================================================

let scanInterval: NodeJS.Timeout | null = null;

function startHourlyScan(): void {
  const intervalMs = config.presale.scanIntervalMs;

  console.log(`[PresaleServer] Starting hourly scan (every ${intervalMs / 1000 / 60} minutes)`);

  // Run immediately on startup
  setTimeout(async () => {
    console.log('[PresaleServer] Running initial scan...');
    try {
      const result = await scanPresales();
      console.log(`[PresaleServer] Initial scan complete: ${result.posted.length} posted, ${result.skipped} skipped`);
    } catch (error) {
      console.error('[PresaleServer] Initial scan failed:', error);
    }
  }, 5000); // 5 second delay to allow full startup

  // Then run on interval
  scanInterval = setInterval(async () => {
    console.log('[PresaleServer] Running scheduled scan...');
    try {
      const result = await scanPresales();
      console.log(`[PresaleServer] Scheduled scan complete: ${result.posted.length} posted, ${result.skipped} skipped`);
    } catch (error) {
      console.error('[PresaleServer] Scheduled scan failed:', error);
    }
  }, intervalMs);
}

function stopHourlyScan(): void {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
    console.log('[PresaleServer] Stopped hourly scan');
  }
}

// ============================================================================
// Server Startup
// ============================================================================

function validatePresaleConfig(): void {
  const missing: string[] = [];

  // Required for Gmail
  if (!config.google.clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!config.google.clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  if (!config.google.refreshToken) missing.push('GOOGLE_REFRESH_TOKEN');

  // Required for Slack
  if (!config.slack.botToken) missing.push('SLACK_BOT_TOKEN');
  if (!config.presale.slackChannel) missing.push('SLACK_PRESALE_CHANNEL');

  // Required for ConvertAPI
  if (!config.convertApi.secret) missing.push('CONVERTAPI_SECRET');

  // Required for Claude
  if (!config.anthropic.apiKey) missing.push('ANTHROPIC_API_KEY');

  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    console.error('The presale scanner may not function correctly.');
  }
}

function start(): void {
  validatePresaleConfig();

  const port = config.port;

  app.listen(port, () => {
    console.log('');
    console.log('============================================');
    console.log('  Presale Scanner Service');
    console.log('============================================');
    console.log(`  Port: ${port}`);
    console.log(`  Scan interval: ${config.presale.scanIntervalMs / 1000 / 60} minutes`);
    console.log(`  Lookback: ${config.presale.lookbackMinutes} minutes`);
    console.log(`  Slack channel: ${config.presale.slackChannel || '(not set)'}`);
    console.log('');
    console.log('  Endpoints:');
    console.log(`    GET  /health`);
    console.log(`    POST /admin/presale/scan`);
    console.log(`    GET  /admin/presale/state`);
    console.log(`    POST /admin/presale/state/reload`);
    console.log('============================================');
    console.log('');

    // Start the hourly scanner
    startHourlyScan();
  });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[PresaleServer] Received SIGTERM, shutting down...');
  stopHourlyScan();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[PresaleServer] Received SIGINT, shutting down...');
  stopHourlyScan();
  process.exit(0);
});

start();

export { app };
