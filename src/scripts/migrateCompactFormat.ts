/**
 * Migration Script: Convert Old Verbose Messages to New Compact Format
 *
 * Old format uses multiple section blocks with `fields` (Subject, Owner,
 * Support, Due, Priority, Type, From, To each as separate fields/sections
 * plus dividers). New compact format puts everything in a single mrkdwn
 * section block.
 *
 * Usage:
 *   DRY_RUN=true node dist/scripts/migrateCompactFormat.js
 *   node dist/scripts/migrateCompactFormat.js
 *
 * Or via API endpoint:
 *   POST /admin/migrate/compact-format
 */

import { configCompat, initRemoteConfig } from '../config/environment.js';
import { slack as coreApiSlack, initConfig as initCoreApiConfig } from '../services/coreApi.js';

// ============================================================================
// Configuration
// ============================================================================

const MAX_AGE_DAYS = 90;
const DELAY_BETWEEN_UPDATES_MS = 1200;
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
// Field Extraction Helpers
// ============================================================================

/**
 * Extract a named field value from old-format blocks.
 * Old format uses `*FieldName:*\nvalue` in section fields or section text.
 */
function extractField(blocks: any[], fieldName: string): string | null {
  for (const block of blocks) {
    if (block.type !== 'section') continue;

    // Check fields array
    if (block.fields) {
      for (const field of block.fields) {
        const text: string = field.text || '';
        const pattern = `*${fieldName}:*\n`;
        if (text.startsWith(pattern)) {
          return text.slice(pattern.length).trim();
        }
      }
    }

    // Check section text
    if (block.text?.text) {
      const text: string = block.text.text;
      const pattern = `*${fieldName}:*\n`;
      if (text.startsWith(pattern)) {
        return text.slice(pattern.length).trim();
      }
    }
  }
  return null;
}

/**
 * Extract the View in Monday button URL from actions block
 */
function extractViewMondayUrl(blocks: any[]): string | null {
  for (const block of blocks) {
    if (block.type !== 'actions') continue;
    for (const el of block.elements || []) {
      if (el.action_id === 'view_monday' && el.url) {
        return el.url;
      }
    }
  }
  return null;
}

/**
 * Extract meeting info from old-format blocks.
 * Old format: `:date: *Meeting Requested*\n• time1\n• time2 _(alt)_`
 */
function extractMeetingText(blocks: any[]): string | null {
  for (const block of blocks) {
    if (block.type !== 'section') continue;
    const text: string = block.text?.text || '';
    if (text.includes('Meeting Requested') || text.includes('Meeting:')) {
      return text;
    }
  }
  return null;
}

/**
 * Clean Slack mailto links: `<mailto:a@b.com|a@b.com>` → `a@b.com`
 */
function cleanMailto(text: string): string {
  return text.replace(/<mailto:([^|]+)\|[^>]+>/g, '$1');
}

/**
 * Check if a message is in the old verbose format (uses section.fields)
 */
function isOldFormat(blocks: any[]): boolean {
  const hasHeader = blocks.some((b: any) => b.type === 'header');
  const hasFields = blocks.some((b: any) => b.type === 'section' && b.fields);
  return hasHeader && hasFields;
}

/**
 * Convert old meeting format to new compact inline format.
 * Old: `:date: *Meeting Requested*\n• Wed Mar 5 @ 2:00 PM\n• Thu Mar 6 @ 10:00 AM _(alt)_`
 * New: `📅 *Meeting:* Wed Mar 5 @ 2:00 PM  ·  Thu Mar 6 @ 10:00 AM _(alt)_`
 */
function convertMeetingText(oldMeeting: string): string {
  // Extract bullet lines
  const lines = oldMeeting.split('\n').filter((l: string) => l.startsWith('•'));
  if (lines.length === 0) {
    return '📅 *Meeting:* _No specific time mentioned_';
  }

  const times = lines.map((l: string) => l.replace(/^•\s*/, '').trim());

  // Check for "Invalid Date" entries
  const validTimes = times.filter((t: string) => t !== 'Invalid Date' && !t.includes('Invalid Date'));

  if (validTimes.length === 0) {
    return '📅 *Meeting:* _No specific time mentioned_';
  }

  // First time is primary, rest with _(alt)_ suffix if not already there
  const parts = validTimes.map((t: string, i: number) => {
    // Strip existing _(alt)_ suffix for re-formatting
    const clean = t.replace(/\s*_\(alt\)_\s*$/, '').trim();
    return i === 0 ? clean : `${clean} _(alt)_`;
  });

  return `📅 *Meeting:* ${parts.join('  ·  ')}`;
}

// ============================================================================
// Transform Function
// ============================================================================

/**
 * Transform old-format blocks into new compact format
 */
function transformToCompact(blocks: any[]): { transformed: any[]; changed: boolean } {
  if (!isOldFormat(blocks)) {
    return { transformed: blocks, changed: false };
  }

  // Extract header (keep as-is)
  const headerBlock = blocks.find((b: any) => b.type === 'header');
  if (!headerBlock) {
    return { transformed: blocks, changed: false };
  }

  // Extract all fields from old format
  const subject = extractField(blocks, 'Subject');
  const owner = extractField(blocks, 'Owner');
  const support = extractField(blocks, 'Support');
  const due = extractField(blocks, 'Due');
  const priority = extractField(blocks, 'Priority');
  const taskType = extractField(blocks, 'Type');
  const from = extractField(blocks, 'From');
  const to = extractField(blocks, 'To');
  const notes = extractField(blocks, 'Notes');
  const meetingText = extractMeetingText(blocks);
  const mondayUrl = extractViewMondayUrl(blocks);

  // Build compact detail lines
  const detailLines: string[] = [];

  // Subject line (bold)
  if (subject) {
    detailLines.push(`*${subject}*`);
  }

  // Owner + Support line
  let ownerLine = owner ? `*Owner:* ${owner}` : '';
  if (support) {
    ownerLine += `  ·  *Support:* ${support}`;
  }
  if (ownerLine) {
    detailLines.push(ownerLine);
  }

  // Due · Priority · Type line
  const dueParts: string[] = [];
  if (due) dueParts.push(`*Due:* ${due}`);
  if (priority) dueParts.push(priority);
  if (taskType) dueParts.push(taskType);
  if (dueParts.length > 0) {
    detailLines.push(dueParts.join('  ·  '));
  }

  // From → To line
  const fromClean = from ? cleanMailto(from) : 'N/A';
  const toClean = to ? cleanMailto(to) : 'N/A';
  detailLines.push(`*From:* ${fromClean}  →  *To:* ${toClean}`);

  // Notes (with spacing)
  if (notes) {
    detailLines.push(`\n*Notes:* ${notes}\n`);
  }

  // Meeting info (converted to inline format)
  if (meetingText) {
    detailLines.push(convertMeetingText(meetingText));
  }

  // Build new blocks
  const newBlocks: any[] = [
    headerBlock,
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: detailLines.join('\n'),
      },
    },
  ];

  // Add View in Monday button as standalone actions block
  if (mondayUrl) {
    newBlocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'View in Monday',
            emoji: true,
          },
          url: mondayUrl,
          action_id: 'view_monday',
        },
      ],
    });
  }

  return { transformed: newBlocks, changed: true };
}

// ============================================================================
// Helpers
// ============================================================================

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
  console.log('COMPACT FORMAT MIGRATION');
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

  // Calculate oldest timestamp
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - MAX_AGE_DAYS);
  const oldestTs = String(cutoffDate.getTime() / 1000);

  // Fetch all messages
  const allMessages: any[] = [];
  console.log('\nFetching messages from channel...');

  const historyResult = await coreApiSlack.getConversationHistory({
    channel: channelId,
    limit: 200,
    oldest: oldestTs,
  });
  allMessages.push(...(historyResult.messages || []));
  console.log(`  Fetched ${allMessages.length} messages`);

  // Filter to old-format messages
  const messagesToMigrate = allMessages.filter((msg) => {
    if (!msg.blocks || !Array.isArray(msg.blocks)) return false;
    return isOldFormat(msg.blocks);
  });

  result.total = messagesToMigrate.length;
  console.log(`\nFound ${messagesToMigrate.length} old-format messages to compact\n`);

  if (messagesToMigrate.length === 0) {
    console.log('Nothing to migrate.');
    return result;
  }

  // Process each message
  for (let i = 0; i < messagesToMigrate.length; i++) {
    const msg = messagesToMigrate[i];
    const progress = `[${i + 1}/${messagesToMigrate.length}]`;

    try {
      const { transformed, changed } = transformToCompact(msg.blocks);

      if (!changed) {
        result.skipped++;
        console.log(`${progress} SKIP: ${msg.ts} (no change needed)`);
        continue;
      }

      if (DRY_RUN) {
        result.updated++;
        // Show a preview of the compacted text
        const sectionBlock = transformed.find((b: any) => b.type === 'section' && b.text);
        const preview = sectionBlock?.text?.text?.split('\n')[0] || '(unknown)';
        console.log(`${progress} [DRY RUN] Would compact: ${msg.ts} - ${preview}`);
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

    // Rate limiting between updates
    if (i < messagesToMigrate.length - 1) {
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
