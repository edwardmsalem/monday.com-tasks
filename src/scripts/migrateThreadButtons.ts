/**
 * Migration Script: Add Button Controls to Existing Task Threads
 *
 * Run once after deploying the digest system.
 * Safe to re-run (skips threads that already have buttons).
 *
 * Usage:
 *   npx ts-node src/scripts/migrateThreadButtons.ts
 *
 * Or via API endpoint:
 *   POST /admin/migrate/thread-buttons
 */

import { WebClient } from '@slack/web-api';
import { config, configCompat, initRemoteConfig } from '../config/environment.js';
import { monday as coreApiMonday, initConfig as initCoreApiConfig } from '../services/coreApi.js';

// ============================================================================
// Configuration
// ============================================================================

const SLACK_CLIENT = new WebClient(config.slack.botToken);

// Skip tasks older than this
const MAX_AGE_DAYS = 60;

// Delay between updates (Slack rate limit: ~50 requests/minute for chat.update)
const DELAY_BETWEEN_UPDATES_MS = 1200;

// Dry run mode - log what would happen without making changes
const DRY_RUN = process.env.DRY_RUN === 'true';

// ============================================================================
// Types
// ============================================================================

interface TaskToMigrate {
  mondayItemId: string;
  taskName: string;
  slackThreadTs: string;
  slackChannelId: string;
  createdAt: Date;
  status: string;
}

export interface MigrationResult {
  total: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: Array<{ taskId: string; error: string }>;
}

// ============================================================================
// Button Block Definition
// ============================================================================

function buildTaskButtonBlock(taskId: string): Record<string, unknown> {
  return {
    type: 'actions',
    block_id: `task_${taskId}_controls`,
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '👀 Acknowledge', emoji: true },
        action_id: 'task_acknowledge',
        value: taskId,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '🟡 Working', emoji: true },
        action_id: 'task_working',
        value: taskId,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '✅ Complete', emoji: true },
        style: 'primary',
        action_id: 'task_complete',
        value: taskId,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '🔴 Stuck', emoji: true },
        style: 'danger',
        action_id: 'task_stuck',
        value: taskId,
      },
    ],
  };
}

const DIVIDER_BLOCK = { type: 'divider' };

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Fetch all open tasks from Monday.com that have Slack threads
 */
async function getTasksToMigrate(): Promise<TaskToMigrate[]> {
  const query = `
    query GetOpenTasks($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 500) {
          items {
            id
            name
            created_at
            column_values {
              id
              text
              value
            }
          }
        }
      }
    }
  `;

  interface MondayQueryResult {
    boards?: Array<{
      items_page?: {
        items?: Array<{
          id: string;
          name: string;
          created_at: string;
          column_values: Array<{ id: string; text: string; value: string }>;
        }>;
      };
    }>;
  }

  const result = (await coreApiMonday.query(query, { boardId: configCompat.monday.boardId })) as MondayQueryResult;
  const items = result.boards?.[0]?.items_page?.items ?? [];

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - MAX_AGE_DAYS);

  const tasks: TaskToMigrate[] = [];

  for (const item of items) {
    const getValue = (columnId: string) =>
      item.column_values.find((cv) => cv.id === columnId)?.text ?? '';

    const status = getValue(config.monday.columns.workflowStatus).toLowerCase();

    // Skip completed tasks
    if (['complete', 'done', 'completed', 'closed'].includes(status)) {
      continue;
    }

    // Parse Slack thread info
    const slackThreadValue = getValue(config.monday.columns.slackThreadId);
    if (!slackThreadValue) continue;

    let slackThreadTs: string;
    let slackChannelId: string;

    if (slackThreadValue.includes(':')) {
      [slackChannelId, slackThreadTs] = slackThreadValue.split(':');
    } else {
      slackThreadTs = slackThreadValue;
      slackChannelId = configCompat.slack.channelId;
    }

    const createdAt = new Date(item.created_at);

    // Skip tasks older than cutoff
    if (createdAt < cutoffDate) {
      continue;
    }

    tasks.push({
      mondayItemId: item.id,
      taskName: item.name,
      slackThreadTs,
      slackChannelId,
      createdAt,
      status,
    });
  }

  return tasks;
}

/**
 * Check if a message already has task control buttons
 */
function hasButtonsAlready(blocks: unknown[]): boolean {
  if (!blocks || !Array.isArray(blocks)) return false;

  return blocks.some((block) => {
    const b = block as Record<string, unknown>;
    if (b.type !== 'actions') return false;
    const elements = b.elements as Array<{ action_id?: string }> | undefined;
    return elements?.some((el) =>
      ['task_acknowledge', 'task_working', 'task_complete', 'task_stuck'].includes(
        el.action_id ?? ''
      )
    );
  });
}

/**
 * Fetch existing message and append button block
 */
async function addButtonsToThread(
  task: TaskToMigrate
): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  try {
    // Fetch the existing message
    const historyResult = await SLACK_CLIENT.conversations.history({
      channel: task.slackChannelId,
      latest: task.slackThreadTs,
      inclusive: true,
      limit: 1,
    });

    if (!historyResult.messages || historyResult.messages.length === 0) {
      return { success: false, error: 'Message not found' };
    }

    const existingMessage = historyResult.messages[0];
    const existingBlocks = (existingMessage.blocks as unknown[]) || [];

    // Check if buttons already exist
    if (hasButtonsAlready(existingBlocks)) {
      return { success: true, skipped: true };
    }

    // Build button block with task ID
    const buttonBlock = buildTaskButtonBlock(task.mondayItemId);

    // Append divider and buttons to existing blocks
    const updatedBlocks = [...existingBlocks, DIVIDER_BLOCK, buttonBlock];

    if (DRY_RUN) {
      console.log(
        `[DRY RUN] Would update thread ${task.slackThreadTs} for task ${task.mondayItemId}`
      );
      return { success: true };
    }

    // Update the message
    await SLACK_CLIENT.chat.update({
      channel: task.slackChannelId,
      ts: task.slackThreadTs,
      blocks: updatedBlocks as any[],
      text: existingMessage.text || 'Task notification', // Fallback text required
    });

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

export async function runMigration(): Promise<MigrationResult> {
  // Initialize remote config from core-api
  await initRemoteConfig();
  await initCoreApiConfig();

  console.log('='.repeat(60));
  console.log('THREAD BUTTON MIGRATION');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Max age: ${MAX_AGE_DAYS} days`);
  console.log('='.repeat(60));

  const result: MigrationResult = {
    total: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  // Get tasks to migrate
  console.log('\nFetching tasks from Monday.com...');
  const tasks = await getTasksToMigrate();
  result.total = tasks.length;
  console.log(`Found ${tasks.length} open tasks with Slack threads\n`);

  if (tasks.length === 0) {
    console.log('Nothing to migrate.');
    return result;
  }

  // Process each task
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const progress = `[${i + 1}/${tasks.length}]`;

    const updateResult = await addButtonsToThread(task);

    if (updateResult.success) {
      if (updateResult.skipped) {
        result.skipped++;
        console.log(
          `${progress} SKIP: ${task.taskName.substring(0, 40)}... (already has buttons)`
        );
      } else {
        result.updated++;
        console.log(`${progress} ✓ ${task.taskName.substring(0, 40)}...`);
      }
    } else {
      result.failed++;
      result.errors.push({
        taskId: task.mondayItemId,
        error: updateResult.error || 'Unknown error',
      });
      console.log(
        `${progress} ✗ ${task.taskName.substring(0, 40)}... - ${updateResult.error}`
      );
    }

    // Rate limiting
    if (i < tasks.length - 1) {
      await sleep(DELAY_BETWEEN_UPDATES_MS);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('MIGRATION COMPLETE');
  console.log('='.repeat(60));
  console.log(`Total tasks:    ${result.total}`);
  console.log(`Updated:        ${result.updated}`);
  console.log(`Skipped:        ${result.skipped} (already had buttons)`);
  console.log(`Failed:         ${result.failed}`);

  if (result.errors.length > 0) {
    console.log('\nErrors:');
    result.errors.forEach(({ taskId, error }) => {
      console.log(`  - Task ${taskId}: ${error}`);
    });
  }

  return result;
}
