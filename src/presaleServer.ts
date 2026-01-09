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
import { scanPresales, extractCodesFromMessageIds, scanSportsTeamEmails } from './services/presaleScanner.js';
import { getFullState, getLastScan, reloadState, clearSeenPresales, declineOpportunity } from './services/presaleState.js';
import { getClient as getSlackClient } from './services/slack.js';
import { getAllCircuitStats, convertApiCircuit } from './services/circuitBreaker.js';

const app = express();

// Parse JSON bodies
app.use(express.json());

// Parse URL-encoded bodies (for Slack interactivity)
app.use('/webhook/slack', express.urlencoded({ extended: true }));

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

/**
 * POST /admin/presale/reset
 *
 * Clear all seen presales (for testing)
 */
app.post('/admin/presale/reset', (_req: Request, res: Response): void => {
  const cleared = clearSeenPresales();
  res.json({ success: true, cleared, message: `Cleared ${cleared} seen presales` });
});

// ============================================================================
// Sports Team Email Scanner Endpoint
// ============================================================================

/**
 * GET /admin/sports-team-emails
 *
 * Scan all sports team labels and extract unique "from" addresses
 * Optional query params:
 *   - maxPerLabel: Maximum emails to fetch per label (default: 500)
 *
 * Returns: { teams, totalLabels, totalUniqueAddresses, scannedAt }
 */
app.get('/admin/sports-team-emails', async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('[PresaleServer] Sports team email scan triggered');

    const maxPerLabel = parseInt(req.query.maxPerLabel as string, 10) || 500;

    const result = await scanSportsTeamEmails(maxPerLabel);

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('[PresaleServer] Sports team email scan failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================================================
// Circuit Breaker Debug Endpoints
// ============================================================================

/**
 * GET /admin/circuits
 *
 * View all circuit breaker states (for debugging)
 */
app.get('/admin/circuits', (_req: Request, res: Response): void => {
  const stats = getAllCircuitStats();
  res.json(stats);
});

/**
 * POST /admin/circuits/convertapi/reset
 *
 * Reset the ConvertAPI circuit breaker (if it's stuck open)
 */
app.post('/admin/circuits/convertapi/reset', (_req: Request, res: Response): void => {
  convertApiCircuit.reset();
  res.json({
    success: true,
    message: 'ConvertAPI circuit breaker reset',
    stats: convertApiCircuit.getStats(),
  });
});

// ============================================================================
// Slack Interactivity Endpoint
// ============================================================================

/**
 * POST /webhook/slack/presale-action
 *
 * Handle button clicks from presale notifications
 * - presale_interested: Post to operations channel
 * - presale_decline: Mark opportunity as declined
 */
app.post('/webhook/slack/presale-action', async (req: Request, res: Response): Promise<void> => {
  try {
    // Slack sends payload as form-encoded with "payload" field containing JSON
    const payloadStr = req.body?.payload;
    if (!payloadStr) {
      res.status(400).json({ error: 'Missing payload' });
      return;
    }

    const payload = JSON.parse(payloadStr);
    const actionId = payload.actions?.[0]?.action_id;
    const actionValue = payload.actions?.[0]?.value;
    const userId = payload.user?.id;
    const channelId = payload.channel?.id;
    const messageTs = payload.message?.ts;

    // Acknowledge immediately (Slack times out after 3 seconds)
    res.status(200).send();

    if (!actionId || !actionValue) {
      console.error('[PresaleServer] Invalid action payload');
      return;
    }

    const slack = getSlackClient();

    if (actionId === 'presale_interested') {
      // Parse the interested payload
      const data = JSON.parse(actionValue) as {
        dedupKey: string;
        team: string;
        eventName: string;
        subject: string;
        presaleType: string;
        presaleDate: string | null;
        presaleChannel: string;
        messageIds?: string[];  // Gmail message IDs for code extraction
      };

      console.log(`[PresaleServer] User ${userId} interested in: ${data.eventName}`);

      // Extract codes/links from all emails now that they're interested
      let statusInfo = '';
      let csvContent: string | null = null;
      let csvFilename = '';

      if (data.messageIds && data.messageIds.length > 0) {
        try {
          const extraction = await extractCodesFromMessageIds(data.messageIds);

          // Build status info for the message (just mention what's in the CSV)
          const statusParts: string[] = [];
          statusParts.push(`📊 ${extraction.accounts.length} accounts`);
          if (extraction.sharedCode) {
            statusParts.push(`🔑 Shared code`);
          } else if (extraction.hasUniqueCodes) {
            statusParts.push(`🔐 Unique codes per account`);
          }
          if (extraction.hasUniqueLinks) {
            statusParts.push(`🔗 Unique links per account`);
          }
          statusInfo = statusParts.join(' • ');

          // Generate CSV if we have account data
          if (extraction.accounts.length > 0) {
            const csvRows = ['Email,Code,Link'];
            for (const account of extraction.accounts) {
              // Escape CSV fields
              const email = account.email.replace(/"/g, '""');
              const code = (account.code ?? '').replace(/"/g, '""');
              const link = (account.link ?? '').replace(/"/g, '""');
              csvRows.push(`"${email}","${code}","${link}"`);
            }
            csvContent = csvRows.join('\n');
            csvFilename = `${data.team.toLowerCase().replace(/\s+/g, '-')}-${data.eventName.toLowerCase().replace(/\s+/g, '-')}.csv`;
          }
        } catch (error) {
          console.error('[PresaleServer] Failed to extract codes:', error);
          statusInfo = '⚠️ _Could not extract codes - check emails manually_';
        }
      }

      // Post to operations channel
      const operationsChannel = config.presale.operationsChannel;
      if (operationsChannel) {
        // Build the message link back to the original presale notification
        const messageLink = messageTs
          ? `https://slack.com/archives/${data.presaleChannel}/p${messageTs.replace('.', '')}`
          : '';

        // Build presale info line
        let presaleInfo = '';
        if (data.presaleType === 'registration') {
          presaleInfo = data.presaleDate ? `📝 Registration • Presale starts ${data.presaleDate}` : '📝 Registration';
        } else if (data.presaleType === 'upcoming') {
          presaleInfo = data.presaleDate ? `📅 Upcoming • 🗓️ ${data.presaleDate}` : '📅 Upcoming';
        } else {
          presaleInfo = '🎟️ Live Now';
        }
        if (statusInfo) {
          presaleInfo += `\n${statusInfo}`;
        }

        const blocks = [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `📋 *Prepare a sheet for ${data.team}*\n\n*Event:* ${data.eventName}\n${presaleInfo}`,
            },
          },
        ];

        // Add link back to original message
        if (messageLink) {
          blocks.push({
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `<${messageLink}|View original presale notification>`,
              },
            ],
          } as any);
        }

        // Post the message first
        const opsMessage = await slack.chat.postMessage({
          channel: operationsChannel,
          blocks,
          text: `📋 Prepare a sheet for ${data.team} - ${data.eventName}`,
        });

        // Upload CSV as a file in thread
        if (csvContent && opsMessage.ts) {
          try {
            await slack.filesUploadV2({
              channel_id: operationsChannel,
              thread_ts: opsMessage.ts,
              filename: csvFilename,
              file: Buffer.from(csvContent, 'utf-8'),
              title: `Account Data - ${data.eventName}`,
              initial_comment: 'Email, Code, Link for each account:',
            });
            console.log(`[PresaleServer] Uploaded CSV: ${csvFilename}`);
          } catch (uploadError) {
            console.error('[PresaleServer] Failed to upload CSV:', uploadError);
          }
        }
      }

      // Update the original message to show status
      if (channelId && messageTs) {
        const originalBlocks = payload.message?.blocks ?? [];
        // Remove the actions block and add status
        const updatedBlocks = originalBlocks.filter((b: any) => b.type !== 'actions');
        updatedBlocks.push({
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `✅ *Interested* • Posted to operations channel`,
            },
          ],
        });

        await slack.chat.update({
          channel: channelId,
          ts: messageTs,
          blocks: updatedBlocks,
          text: payload.message?.text ?? '',
        });
      }

    } else if (actionId === 'presale_decline') {
      // Parse the decline payload
      const data = JSON.parse(actionValue) as {
        domain: string;
        eventName: string;
        team: string;
      };

      console.log(`[PresaleServer] User ${userId} declined: ${data.eventName} from ${data.domain}`);

      // Mark as declined in state
      declineOpportunity(data.domain, data.eventName, data.team);

      // Update the original message to show status
      if (channelId && messageTs) {
        const originalBlocks = payload.message?.blocks ?? [];
        // Remove the actions block and add status
        const updatedBlocks = originalBlocks.filter((b: any) => b.type !== 'actions');
        updatedBlocks.push({
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `❌ *Not Interested* • Future emails for "${data.eventName}" will be skipped`,
            },
          ],
        });

        await slack.chat.update({
          channel: channelId,
          ts: messageTs,
          blocks: updatedBlocks,
          text: payload.message?.text ?? '',
        });
      }
    }

  } catch (error) {
    console.error('[PresaleServer] Interactivity error:', error);
    // Don't send error response - already acknowledged
  }
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
    console.log(`    POST /admin/presale/reset`);
    console.log(`    GET  /admin/sports-team-emails`);
    console.log(`    GET  /admin/circuits`);
    console.log(`    POST /admin/circuits/convertapi/reset`);
    console.log(`    POST /webhook/slack/presale-action`);
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
