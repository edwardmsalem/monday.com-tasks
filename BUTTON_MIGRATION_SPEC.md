# Button Migration Script - Technical Specification

**Version:** 1.0  
**Date:** 2026-01-07  
**Status:** Ready for Implementation  
**Dependency:** Run AFTER digest system is deployed

---

## Overview

### Purpose

Add button controls to existing Slack task threads so all tasks (not just new ones) have the same interface.

### Approach

Use Slack's `chat.update` API to append a button block to existing task messages. Thread content, replies, and reactions remain untouched.

### Scope

- All open tasks in Monday.com with linked Slack threads
- Skip completed/archived tasks
- Skip threads older than 60 days (configurable)

---

## Technical Approach

### How `chat.update` Works

```
Before:
┌─────────────────────────────────────────┐
│ 📋 New Season Task: Lakers Renewal      │
│                                         │
│ Owner: @dayna                           │
│ Due: Tomorrow (Jan 8)                   │
│ Priority: 🟡 Medium                     │
│                                         │
│ Notes: Customer requested callback...   │
└─────────────────────────────────────────┘
    │
    ├── Reply from @jerry: "Called, no answer"
    ├── Reply from @dayna: "Will try again at 2"
    └── ✅ reaction from @dayna

After chat.update:
┌─────────────────────────────────────────┐
│ 📋 New Season Task: Lakers Renewal      │
│                                         │
│ Owner: @dayna                           │
│ Due: Tomorrow (Jan 8)                   │
│ Priority: 🟡 Medium                     │
│                                         │
│ Notes: Customer requested callback...   │
│                                         │
│ ─────────────────────────────────────── │
│ [👀 Ack] [🟡 Working] [✅ Done] [🔴 Stuck] │
└─────────────────────────────────────────┘
    │
    ├── Reply from @jerry: "Called, no answer"  ← UNCHANGED
    ├── Reply from @dayna: "Will try again at 2" ← UNCHANGED
    └── ✅ reaction from @dayna                  ← UNCHANGED
```

### What Stays Intact

| Element | Preserved? |
|---------|------------|
| Original message text | ✅ Yes |
| Original message blocks | ✅ Yes |
| Thread replies | ✅ Yes |
| Reactions on parent | ✅ Yes |
| Reactions on replies | ✅ Yes |
| Thread timestamp (ts) | ✅ Yes |
| Monday.com link | ✅ Yes (uses same ts) |

---

## Data Flow

```
┌─────────────────┐
│  Monday.com     │
│  Open Tasks     │
└────────┬────────┘
         │ Query: all items where status ≠ Complete
         ▼
┌─────────────────┐
│  Filter Tasks   │
│  - Has Slack ts │
│  - < 60 days    │
│  - Not complete │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  For Each Task  │──────────────────────────┐
└────────┬────────┘                          │
         │                                   │
         ▼                                   │
┌─────────────────┐                          │
│ Fetch Slack Msg │                          │
│ conversations.  │                          │
│ history         │                          │
└────────┬────────┘                          │
         │                                   │
         ▼                                   │
┌─────────────────┐                          │
│ Has buttons     │───Yes──► Skip            │
│ already?        │                          │
└────────┬────────┘                          │
         │ No                                │
         ▼                                   │
┌─────────────────┐                          │
│ Append button   │                          │
│ block to        │                          │
│ existing blocks │                          │
└────────┬────────┘                          │
         │                                   │
         ▼                                   │
┌─────────────────┐                          │
│ chat.update     │                          │
└────────┬────────┘                          │
         │                                   │
         ▼                                   │
┌─────────────────┐                          │
│ Log result      │                          │
│ Wait 1 second   │──────────────────────────┘
│ Next task       │         (rate limit)
└─────────────────┘
```

---

## File to Create

### `src/scripts/migrateThreadButtons.ts`

```typescript
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
import { config } from '../config/environment.js';
import * as monday from '../services/monday.js';

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

interface MigrationResult {
  total: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: Array<{ taskId: string; error: string }>;
}

// ============================================================================
// Button Block Definition
// ============================================================================

const TASK_BUTTON_BLOCK = {
  type: 'actions',
  block_id: 'task_migration_controls',
  elements: [
    {
      type: 'button',
      text: { type: 'plain_text', text: '👀 Acknowledge', emoji: true },
      action_id: 'task_acknowledge',
      value: '', // Will be set per-task
    },
    {
      type: 'button',
      text: { type: 'plain_text', text: '🟡 Working', emoji: true },
      action_id: 'task_working',
      value: '',
    },
    {
      type: 'button',
      text: { type: 'plain_text', text: '✅ Complete', emoji: true },
      style: 'primary',
      action_id: 'task_complete',
      value: '',
    },
    {
      type: 'button',
      text: { type: 'plain_text', text: '🔴 Stuck', emoji: true },
      style: 'danger',
      action_id: 'task_stuck',
      value: '',
    },
  ],
};

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

  const response = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': config.monday.apiToken,
      'API-Version': '2024-01',
    },
    body: JSON.stringify({
      query,
      variables: { boardId: config.monday.boardId },
    }),
  });

  const result = await response.json();
  const items = result.data?.boards?.[0]?.items_page?.items ?? [];

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - MAX_AGE_DAYS);

  const tasks: TaskToMigrate[] = [];

  for (const item of items) {
    const getValue = (columnId: string) =>
      item.column_values.find((cv: any) => cv.id === columnId)?.text ?? '';

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
      slackChannelId = config.slack.channelId;
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
function hasButtonsAlready(blocks: any[]): boolean {
  if (!blocks || !Array.isArray(blocks)) return false;
  
  return blocks.some(block => 
    block.type === 'actions' && 
    block.elements?.some((el: any) => 
      ['task_acknowledge', 'task_working', 'task_complete', 'task_stuck'].includes(el.action_id)
    )
  );
}

/**
 * Fetch existing message and append button block
 */
async function addButtonsToThread(task: TaskToMigrate): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
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
    const existingBlocks = existingMessage.blocks || [];

    // Check if buttons already exist
    if (hasButtonsAlready(existingBlocks)) {
      return { success: true, skipped: true };
    }

    // Build button block with task ID in values
    const buttonBlock = JSON.parse(JSON.stringify(TASK_BUTTON_BLOCK));
    buttonBlock.block_id = `task_${task.mondayItemId}_controls`;
    buttonBlock.elements.forEach((el: any) => {
      el.value = task.mondayItemId;
    });

    // Append divider and buttons to existing blocks
    const updatedBlocks = [
      ...existingBlocks,
      DIVIDER_BLOCK,
      buttonBlock,
    ];

    if (DRY_RUN) {
      console.log(`[DRY RUN] Would update thread ${task.slackThreadTs} for task ${task.mondayItemId}`);
      return { success: true };
    }

    // Update the message
    await SLACK_CLIENT.chat.update({
      channel: task.slackChannelId,
      ts: task.slackThreadTs,
      blocks: updatedBlocks,
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
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Main Migration Function
// ============================================================================

export async function runMigration(): Promise<MigrationResult> {
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
        console.log(`${progress} SKIP: ${task.taskName.substring(0, 40)}... (already has buttons)`);
      } else {
        result.updated++;
        console.log(`${progress} ✓ ${task.taskName.substring(0, 40)}...`);
      }
    } else {
      result.failed++;
      result.errors.push({ taskId: task.mondayItemId, error: updateResult.error || 'Unknown error' });
      console.log(`${progress} ✗ ${task.taskName.substring(0, 40)}... - ${updateResult.error}`);
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

// ============================================================================
// CLI Entry Point
// ============================================================================

if (require.main === module) {
  runMigration()
    .then(result => {
      process.exit(result.failed > 0 ? 1 : 0);
    })
    .catch(error => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}
```

---

## Server Endpoint (Optional)

Add to `server.ts` for triggering via API:

```typescript
// Admin endpoint for button migration
// Protect with auth in production
app.post('/admin/migrate/thread-buttons', async (req, res) => {
  const { runMigration } = await import('./scripts/migrateThreadButtons.js');
  
  try {
    const result = await runMigration();
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});
```

---

## Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_AGE_DAYS` | 60 | Skip tasks older than this |
| `DELAY_BETWEEN_UPDATES_MS` | 1200 | Rate limit delay (Slack allows ~50/min) |
| `DRY_RUN` | false | Set `DRY_RUN=true` to preview without changes |

---

## Running the Migration

### Option A: Command Line

```bash
# Dry run first (see what would happen)
DRY_RUN=true npx ts-node src/scripts/migrateThreadButtons.ts

# Live run
npx ts-node src/scripts/migrateThreadButtons.ts
```

### Option B: API Endpoint

```bash
# Trigger via curl
curl -X POST https://your-app.railway.app/admin/migrate/thread-buttons
```

---

## Expected Output

```
============================================================
THREAD BUTTON MIGRATION
Mode: LIVE
Max age: 60 days
============================================================

Fetching tasks from Monday.com...
Found 47 open tasks with Slack threads

[1/47] ✓ Lakers Season Renewal - Box Office...
[2/47] ✓ Knicks Corporate Suite Inquiry...
[3/47] SKIP: Heat Catering Follow-up... (already has buttons)
[4/47] ✗ Celtics Group Sales... - Message deleted
[5/47] ✓ MSG Suite Pricing Request...
...

============================================================
MIGRATION COMPLETE
============================================================
Total tasks:    47
Updated:        41
Skipped:        3 (already had buttons)
Failed:         3

Errors:
  - Task 12345: Message deleted
  - Task 12346: Channel not found
  - Task 12347: Cannot update message (permissions or age)
```

---

## Rollback Plan

If something goes wrong, buttons can be removed by running a reverse migration:

```typescript
// Remove button blocks from messages
const updatedBlocks = existingBlocks.filter(block => 
  !(block.type === 'actions' && block.block_id?.startsWith('task_')) &&
  !(block.type === 'divider' && /* is the one before buttons */)
);
```

But realistically, adding buttons is non-destructive. Worst case: some messages have buttons that don't work until the interactivity endpoint is deployed. Safe to leave them.

---

## Pre-Flight Checklist

Before running migration:

- [ ] Digest system is deployed
- [ ] `/webhook/slack/interactivity` endpoint is live
- [ ] Button action handlers are working
- [ ] Run dry run first: `DRY_RUN=true`
- [ ] Check dry run output for expected task count
- [ ] Run live migration
- [ ] Verify buttons appear on a few threads
- [ ] Verify button clicks trigger correct actions

---

## Timing Estimate

| Task Count | Estimated Time |
|------------|----------------|
| 50 tasks | ~1 minute |
| 100 tasks | ~2 minutes |
| 200 tasks | ~4 minutes |
| 500 tasks | ~10 minutes |

Based on 1.2 second delay between updates.

---

## Edge Cases Handled

| Scenario | Behavior |
|----------|----------|
| Message already has buttons | Skip (idempotent) |
| Message was deleted | Log error, continue |
| Channel archived/private | Log error, continue |
| Message too old to edit | Log error, continue |
| Task has no Slack thread | Excluded from query |
| Task is complete | Excluded from query |
| Task older than 60 days | Excluded from query |

---

## Summary

This migration script:

1. Queries Monday.com for open tasks with Slack threads
2. Fetches each Slack message
3. Appends button controls (divider + action block)
4. Updates message in place via `chat.update`
5. Preserves all existing content, replies, and reactions

Run once after deploying the digest system. Safe to re-run (skips threads that already have buttons).
