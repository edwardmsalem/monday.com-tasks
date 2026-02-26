/**
 * Migration Script: Move "View in Monday" Button to Bottom of Messages
 *
 * Scans the season-ticket-admin channel for messages that have the
 * "View in Monday" button as a section accessory (floating next to text)
 * and moves it to a standalone actions block at the bottom.
 *
 * Usage:
 *   DRY_RUN=true npx ts-node src/scripts/migrateViewButtonPosition.ts
 *   npx ts-node src/scripts/migrateViewButtonPosition.ts
 *
 * Or via API endpoint:
 *   POST /admin/migrate/view-button-position
 */

import { configCompat, initRemoteConfig } from '../config/environment.js';
import { slack as coreApiSlack, initConfig as initCoreApiConfig } from '../services/coreApi.js';

// ============================================================================
// Configuration
// ============================================================================

// Skip messages older than this
const MAX_AGE_DAYS = 60;

// Delay between updates (Slack rate limit: ~50 requests/minute for chat.update)
const DELAY_BETWEEN_UPDATES_MS = 1200;

// Dry run mode
const DRY_RUN = process.env.DRY_RUN === 'true';

// ============================================================================
// Types
// ============================================================================

export interface MigrationResult {
  total: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: Array<{ ts: string; error: string }>;
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Check if a section block has a "View in Monday" accessory button
 */
function hasAccessoryViewButton(block: any): boolean {
  return (
    block.type === 'section' &&
    block.accessory?.type === 'button' &&
    block.accessory?.action_id === 'view_monday'
  );
}

/**
 * Check if message already has the button as a standalone actions block
 */
function hasStandaloneViewButton(blocks: any[]): boolean {
  return blocks.some(
    (block) =>
      block.type === 'actions' &&
      block.elements?.some((el: any) => el.action_id === 'view_monday')
  );
}

/**
 * Transform blocks: remove accessory button from section, add as actions block at bottom
 */
function transformBlocks(blocks: any[]): { transformed: any[]; changed: boolean } {
  let accessoryButton: any = null;

  // Find and extract the accessory button
  const updatedBlocks = blocks.map((block) => {
    if (hasAccessoryViewButton(block)) {
      accessoryButton = block.accessory;
      // Return section without the accessory
      const { accessory, ...rest } = block;
      return rest;
    }
    return block;
  });

  if (!accessoryButton) {
    return { transformed: blocks, changed: false };
  }

  // Add standalone actions block at the bottom
  updatedBlocks.push({
    type: 'actions',
    elements: [accessoryButton],
  });

  return { transformed: updatedBlocks, changed: true };
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Main Migration Function
// ============================================================================

export async function runMigration(): Promise<MigrationResult> {
  await initRemoteConfig();
  await initCoreApiConfig();

  const channelId = configCompat.slack.channelId;

  console.log('='.repeat(60));
  console.log('VIEW BUTTON POSITION MIGRATION');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Channel: ${channelId}`);
  console.log(`Max age: ${MAX_AGE_DAYS} days`);
  console.log('='.repeat(60));

  const result: MigrationResult = {
    total: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  // Calculate oldest timestamp to fetch
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - MAX_AGE_DAYS);
  const oldestTs = String(cutoffDate.getTime() / 1000);

  // Paginate through channel history
  let cursor: string | undefined;
  const allMessages: any[] = [];

  console.log('\nFetching messages from channel...');

  do {
    const historyResult = await coreApiSlack.getConversationHistory({
      channel: channelId,
      limit: 200,
      oldest: oldestTs,
    });

    const messages = historyResult.messages || [];
    allMessages.push(...messages);

    cursor = (historyResult as any).response_metadata?.next_cursor;

    if (messages.length > 0) {
      console.log(`  Fetched ${allMessages.length} messages so far...`);
    }

    // Rate limit between pages
    if (cursor) {
      await sleep(500);
    }
  } while (cursor);

  console.log(`Total messages fetched: ${allMessages.length}`);

  // Filter to messages with the accessory button pattern
  const messagesToFix = allMessages.filter((msg) => {
    if (!msg.blocks || !Array.isArray(msg.blocks)) return false;
    // Has accessory button but NOT already a standalone one
    return (
      msg.blocks.some(hasAccessoryViewButton) &&
      !hasStandaloneViewButton(msg.blocks)
    );
  });

  result.total = messagesToFix.length;
  console.log(`\nFound ${messagesToFix.length} messages to update\n`);

  if (messagesToFix.length === 0) {
    console.log('Nothing to migrate.');
    return result;
  }

  // Process each message
  for (let i = 0; i < messagesToFix.length; i++) {
    const msg = messagesToFix[i];
    const progress = `[${i + 1}/${messagesToFix.length}]`;

    try {
      const { transformed, changed } = transformBlocks(msg.blocks);

      if (!changed) {
        result.skipped++;
        console.log(`${progress} SKIP: ${msg.ts} (no change needed)`);
        continue;
      }

      if (DRY_RUN) {
        result.updated++;
        console.log(`${progress} [DRY RUN] Would update: ${msg.ts}`);
        continue;
      }

      await coreApiSlack.updateMessage({
        channel: channelId,
        ts: msg.ts,
        blocks: transformed,
        text: msg.text || 'Task notification',
      });

      result.updated++;
      console.log(`${progress} Updated: ${msg.ts}`);
    } catch (error) {
      result.failed++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.errors.push({ ts: msg.ts, error: errorMessage });
      console.log(`${progress} FAILED: ${msg.ts} - ${errorMessage}`);
    }

    // Rate limiting
    if (i < messagesToFix.length - 1) {
      await sleep(DELAY_BETWEEN_UPDATES_MS);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('MIGRATION COMPLETE');
  console.log('='.repeat(60));
  console.log(`Total messages: ${result.total}`);
  console.log(`Updated:        ${result.updated}`);
  console.log(`Skipped:        ${result.skipped}`);
  console.log(`Failed:         ${result.failed}`);

  if (result.errors.length > 0) {
    console.log('\nErrors:');
    result.errors.forEach(({ ts, error }) => {
      console.log(`  - Message ${ts}: ${error}`);
    });
  }

  return result;
}

// Run directly
runMigration()
  .then((result) => {
    process.exit(result.failed > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
