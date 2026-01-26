/**
 * Migration Script: Add Status Buttons to Existing Issue Call Messages
 *
 * Scans the issue call channel, adds buttons, and auto-marks status based on reactions:
 * - ✅ (white_check_mark, heavy_check_mark) -> Done
 * - 🔴 (red_circle) -> Stuck
 * - 🟡 (large_yellow_circle) -> Working on it
 * - 🟢 (large_green_circle) -> Done
 *
 * Usage:
 *   npx ts-node src/scripts/migrateIssueCallButtons.ts
 *
 * Or via API endpoint:
 *   POST /admin/migrate/issue-call-buttons
 */

import { WebClient } from '@slack/web-api';
import { config, configCompat } from '../config/environment.js';
import * as monday from '../services/monday.js';

// ============================================================================
// Configuration
// ============================================================================

const SLACK_CLIENT = new WebClient(config.slack.botToken);

// Issue call channel ID
const ISSUE_CALL_CHANNEL_ID = configCompat.slack.issueCallChannelId;

// Skip messages older than this
const MAX_AGE_DAYS = 60;

// Delay between updates (Slack rate limit: ~50 requests/minute for chat.update)
const DELAY_BETWEEN_UPDATES_MS = 1200;

// Dry run mode - log what would happen without making changes
const DRY_RUN = process.env.DRY_RUN === 'true';

// ============================================================================
// Types
// ============================================================================

interface IssueCallMessage {
  ts: string;
  blocks: any[];
  mondayItemId: string | null;
  reactions: Array<{ name: string; count: number }>;
}

export interface MigrationResult {
  total: number;
  updated: number;
  skipped: number;
  failed: number;
  autoMarked: number;
  errors: Array<{ ts: string; error: string }>;
}

// ============================================================================
// Button Block Definition
// ============================================================================

function buildIssueCallButtonBlock(mondayItemId: string): Record<string, unknown> {
  return {
    type: 'actions',
    block_id: `issue_call_${mondayItemId}_status`,
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '🟡 Working on it', emoji: true },
        action_id: 'issue_call_working',
        value: mondayItemId,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '✅ Done', emoji: true },
        style: 'primary',
        action_id: 'issue_call_complete',
        value: mondayItemId,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '🔴 Stuck', emoji: true },
        style: 'danger',
        action_id: 'issue_call_stuck',
        value: mondayItemId,
      },
    ],
  };
}

const DIVIDER_BLOCK = { type: 'divider' };

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Fetch all messages from the issue call channel
 */
async function getIssueCallMessages(): Promise<IssueCallMessage[]> {
  if (!ISSUE_CALL_CHANNEL_ID) {
    console.error('SLACK_ISSUE_CALL_CHANNEL_ID is not configured');
    return [];
  }

  const cutoffTimestamp = (Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000) / 1000;
  const messages: IssueCallMessage[] = [];

  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const response = await SLACK_CLIENT.conversations.history({
      channel: ISSUE_CALL_CHANNEL_ID,
      oldest: cutoffTimestamp.toString(),
      limit: 100,
      cursor,
    });

    if (response.messages) {
      for (const msg of response.messages) {
        // Skip non-bot messages or messages without blocks
        if (!msg.blocks || msg.blocks.length === 0) continue;

        // Extract Monday item ID from existing "View in Monday" button or from block IDs
        const mondayItemId = extractMondayItemId(msg.blocks);

        if (mondayItemId) {
          messages.push({
            ts: msg.ts!,
            blocks: msg.blocks as any[],
            mondayItemId,
            reactions: (msg.reactions as any[]) || [],
          });
        }
      }
    }

    cursor = response.response_metadata?.next_cursor;
    hasMore = !!cursor;
  }

  return messages;
}

/**
 * Extract Monday item ID from message blocks
 */
function extractMondayItemId(blocks: any[]): string | null {
  for (const block of blocks) {
    // Check action blocks for View in Monday button with URL
    if (block.type === 'actions' && block.elements) {
      for (const element of block.elements) {
        // Check for View in Monday button
        if (element.action_id === 'view_monday' && element.url) {
          // URL format: https://mondaypro.monday.com/boards/XXX/pulses/ITEMID
          const match = element.url.match(/pulses\/(\d+)/);
          if (match) {
            return match[1];
          }
        }
        // Check for existing issue_call_* buttons that have the item ID as value
        if (element.action_id?.startsWith('issue_call_') && element.value) {
          return element.value;
        }
      }
    }

    // Check block_id for issue_call pattern
    if (block.block_id?.startsWith('issue_call_')) {
      const match = block.block_id.match(/issue_call_(\d+)/);
      if (match) {
        return match[1];
      }
    }
  }

  return null;
}

/**
 * Check if a message already has issue call status buttons
 */
function hasStatusButtonsAlready(blocks: any[]): boolean {
  if (!blocks || !Array.isArray(blocks)) return false;

  return blocks.some((block) => {
    if (block.type !== 'actions') return false;
    const elements = block.elements as Array<{ action_id?: string }> | undefined;
    return elements?.some((el) =>
      ['issue_call_working', 'issue_call_complete', 'issue_call_stuck'].includes(
        el.action_id ?? ''
      )
    );
  });
}

/**
 * Determine status based on reactions
 * Priority: green/checkmark (complete) > red (stuck) > yellow (working)
 */
function getStatusFromReactions(reactions: Array<{ name: string; count: number }>): string | null {
  const reactionNames = reactions.map(r => r.name);

  // Green checkmark or green circle = Done
  if (reactionNames.some(r =>
    r === 'white_check_mark' ||
    r === 'heavy_check_mark' ||
    r === 'large_green_circle' ||
    r === 'green_heart' ||
    r === 'ballot_box_with_check'
  )) {
    return 'Done';
  }

  // Red circle = Stuck
  if (reactionNames.some(r =>
    r === 'red_circle' ||
    r === 'x' ||
    r === 'rotating_light'
  )) {
    return 'Stuck';
  }

  // Yellow circle = Working on it
  if (reactionNames.some(r =>
    r === 'large_yellow_circle' ||
    r === 'yellow_heart' ||
    r === 'hourglass_flowing_sand' ||
    r === 'hourglass'
  )) {
    return 'Working on it';
  }

  return null;
}

/**
 * Add buttons to a message and optionally auto-mark status
 */
async function processIssueCallMessage(
  msg: IssueCallMessage
): Promise<{ success: boolean; skipped?: boolean; autoMarked?: boolean; newStatus?: string; error?: string }> {
  try {
    const existingBlocks = msg.blocks;

    // Check if buttons already exist
    if (hasStatusButtonsAlready(existingBlocks)) {
      return { success: true, skipped: true };
    }

    // Build new blocks with status buttons
    const buttonBlock = buildIssueCallButtonBlock(msg.mondayItemId!);

    // Find where to insert - after the last divider or at the end
    // Remove old context block with status legend if present
    const filteredBlocks = existingBlocks.filter((block: any) => {
      if (block.type === 'context' && block.elements) {
        const text = block.elements[0]?.text || '';
        if (text.includes('Status:') && text.includes('Acknowledged')) {
          return false; // Remove old status legend
        }
      }
      return true;
    });

    // Add button block and new context
    const updatedBlocks = [
      ...filteredBlocks,
      buttonBlock,
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '*Status:* React 👀 to acknowledge • Use buttons above to update status',
          },
        ],
      },
    ];

    // Check for reactions and determine auto-mark status
    const autoStatus = getStatusFromReactions(msg.reactions);

    if (DRY_RUN) {
      console.log(
        `[DRY RUN] Would update message ${msg.ts}${autoStatus ? ` and mark as "${autoStatus}"` : ''}`
      );
      return { success: true, autoMarked: !!autoStatus, newStatus: autoStatus || undefined };
    }

    // Update the message with buttons
    await SLACK_CLIENT.chat.update({
      channel: ISSUE_CALL_CHANNEL_ID!,
      ts: msg.ts,
      blocks: updatedBlocks,
      text: 'Issue Call', // Fallback text required
    });

    // Auto-mark status on Monday if reactions indicate status
    if (autoStatus && msg.mondayItemId) {
      try {
        await monday.updateWorkflowStatus(msg.mondayItemId, autoStatus);
        console.log(`  Auto-marked ${msg.mondayItemId} as "${autoStatus}" based on reactions`);
        return { success: true, autoMarked: true, newStatus: autoStatus };
      } catch (statusError) {
        console.error(`  Failed to auto-mark status: ${statusError}`);
        // Don't fail the whole operation if auto-mark fails
        return { success: true };
      }
    }

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Handle specific Slack errors
    if (errorMessage.includes('message_not_found')) {
      return { success: false, error: 'Message deleted' };
    }
    if (errorMessage.includes('channel_not_found')) {
      return { success: false, error: 'Channel not found' };
    }
    if (errorMessage.includes('cant_update_message')) {
      return { success: false, error: 'Cannot update message (permissions or age)' };
    }

    return { success: false, error: errorMessage };
  }
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

export async function runIssueCallButtonMigration(): Promise<MigrationResult> {
  console.log('='.repeat(60));
  console.log('ISSUE CALL BUTTON MIGRATION');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Max age: ${MAX_AGE_DAYS} days`);
  console.log(`Channel: ${ISSUE_CALL_CHANNEL_ID || 'NOT CONFIGURED'}`);
  console.log('='.repeat(60));

  const result: MigrationResult = {
    total: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    autoMarked: 0,
    errors: [],
  };

  if (!ISSUE_CALL_CHANNEL_ID) {
    console.error('SLACK_ISSUE_CALL_CHANNEL_ID is not configured');
    return result;
  }

  // Get messages from issue call channel
  console.log('\nFetching messages from issue call channel...');
  const messages = await getIssueCallMessages();
  result.total = messages.length;
  console.log(`Found ${messages.length} issue call messages\n`);

  if (messages.length === 0) {
    console.log('Nothing to migrate.');
    return result;
  }

  // Process each message
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const progress = `[${i + 1}/${messages.length}]`;

    const processResult = await processIssueCallMessage(msg);

    if (processResult.success) {
      if (processResult.skipped) {
        result.skipped++;
        console.log(`${progress} SKIP: ${msg.ts} (already has buttons)`);
      } else {
        result.updated++;
        if (processResult.autoMarked) {
          result.autoMarked++;
          console.log(`${progress} ✓ ${msg.ts} (auto-marked: ${processResult.newStatus})`);
        } else {
          console.log(`${progress} ✓ ${msg.ts}`);
        }
      }
    } else {
      result.failed++;
      result.errors.push({
        ts: msg.ts,
        error: processResult.error || 'Unknown error',
      });
      console.log(`${progress} ✗ ${msg.ts} - ${processResult.error}`);
    }

    // Rate limiting
    if (i < messages.length - 1) {
      await sleep(DELAY_BETWEEN_UPDATES_MS);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('MIGRATION COMPLETE');
  console.log('='.repeat(60));
  console.log(`Total messages:  ${result.total}`);
  console.log(`Updated:         ${result.updated}`);
  console.log(`Auto-marked:     ${result.autoMarked}`);
  console.log(`Skipped:         ${result.skipped} (already had buttons)`);
  console.log(`Failed:          ${result.failed}`);

  if (result.errors.length > 0) {
    console.log('\nErrors:');
    result.errors.forEach(({ ts, error }) => {
      console.log(`  - Message ${ts}: ${error}`);
    });
  }

  return result;
}

// ============================================================================
// CLI Entry Point
// ============================================================================

// Run if executed directly
const isDirectRun = process.argv[1]?.includes('migrateIssueCallButtons');
if (isDirectRun) {
  runIssueCallButtonMigration()
    .then((result) => {
      process.exit(result.failed > 0 ? 1 : 0);
    })
    .catch((error) => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}
