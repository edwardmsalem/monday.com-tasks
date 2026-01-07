# Digest Notification System - Build Guide

**Hand this entire document to Claude Code along with the other spec files.**

---

## Overview

You're building a new notification system that replaces the current task-centric pings with user-centric daily digests and button-based interactions.

**Reference Specs (in this repo):**
- `NOTIFICATION_ANALYSIS.md` - Background on current problems
- `DIGEST_SYSTEM_SPEC.md` - Full system specification
- `BUTTON_MIGRATION_SPEC.md` - Migration for existing threads

---

## Build Order

**DO NOT skip ahead. Each phase depends on the previous one.**

```
Phase 1: Interactivity Foundation
    ↓
Phase 2: Test Buttons Manually
    ↓
Phase 3: Migrate Existing Threads
    ↓
Phase 4: Build Digest System
    ↓
Phase 5: Remove Old Notification System
    ↓
Phase 6: Launch
```

---

## Phase 1: Interactivity Foundation

### 1.1 Create `/src/routes/interactivity.ts`

Handles all Slack button clicks and modal submissions.

```typescript
/**
 * Slack Interactivity Webhook
 * 
 * Receives POST requests when users:
 * - Click buttons
 * - Submit modals
 * - Use select menus
 * 
 * Slack sends payload as application/x-www-form-urlencoded with a "payload" field
 * containing JSON.
 */

import { Router, Request, Response } from 'express';
import { WebClient } from '@slack/web-api';
import { config } from '../config/environment.js';
import * as sync from '../services/sync.js';
import * as monday from '../services/monday.js';
import * as slack from '../services/slack.js';

const router = Router();
const slackClient = new WebClient(config.slack.botToken);

// ============================================================================
// Types
// ============================================================================

interface InteractivityPayload {
  type: 'block_actions' | 'view_submission' | 'shortcut';
  user: {
    id: string;
    username: string;
    name: string;
  };
  trigger_id: string;
  response_url: string;
  actions?: Array<{
    action_id: string;
    block_id: string;
    value: string;
    type: string;
  }>;
  view?: {
    id: string;
    callback_id: string;
    state: {
      values: Record<string, Record<string, any>>;
    };
    private_metadata?: string;
  };
  container?: {
    type: string;
    message_ts: string;
    channel_id: string;
    thread_ts?: string;
  };
  channel?: {
    id: string;
  };
  message?: {
    ts: string;
    thread_ts?: string;
  };
}

// ============================================================================
// Main Handler
// ============================================================================

router.post('/webhook/slack/interactivity', async (req: Request, res: Response): Promise<void> => {
  try {
    // Slack sends payload as form-encoded
    const payloadString = req.body.payload;
    if (!payloadString) {
      res.status(400).send('Missing payload');
      return;
    }

    const payload: InteractivityPayload = JSON.parse(payloadString);
    
    console.log('[Interactivity] Received:', {
      type: payload.type,
      user: payload.user.id,
      actions: payload.actions?.map(a => a.action_id),
    });

    // Acknowledge immediately (Slack requires response within 3 seconds)
    res.status(200).send();

    // Route to appropriate handler
    if (payload.type === 'block_actions' && payload.actions) {
      for (const action of payload.actions) {
        await handleBlockAction(payload, action);
      }
    } else if (payload.type === 'view_submission' && payload.view) {
      await handleViewSubmission(payload);
    }

  } catch (error) {
    console.error('[Interactivity] Error:', error);
    // Don't send error response - already sent 200
  }
});

// ============================================================================
// Block Action Handlers
// ============================================================================

async function handleBlockAction(
  payload: InteractivityPayload,
  action: { action_id: string; block_id: string; value: string }
): Promise<void> {
  const { action_id, value } = action;
  const userId = payload.user.id;
  
  // Get thread info for posting confirmations
  const channelId = payload.channel?.id || payload.container?.channel_id;
  const threadTs = payload.message?.thread_ts || payload.message?.ts || payload.container?.message_ts;

  console.log(`[Interactivity] Action: ${action_id}, Value: ${value}, User: ${userId}`);

  switch (action_id) {
    case 'task_acknowledge':
      await handleTaskAcknowledge(value, userId, channelId, threadTs);
      break;
      
    case 'task_working':
      await handleTaskWorking(value, userId, channelId, threadTs);
      break;
      
    case 'task_complete':
      await handleTaskComplete(value, userId, channelId, threadTs);
      break;
      
    case 'task_stuck':
      await handleTaskStuck(value, userId, channelId, threadTs);
      break;
      
    case 'task_confirm_today':
      await handleTaskConfirmToday(value, userId, channelId, threadTs);
      break;
      
    case 'task_reschedule':
      await handleTaskReschedule(value, userId, payload.trigger_id);
      break;
      
    case 'issue_call_claim':
      await handleIssueCallClaim(value, userId, channelId, threadTs);
      break;
      
    default:
      console.log(`[Interactivity] Unknown action: ${action_id}`);
  }
}

// ============================================================================
// Task Action Handlers
// ============================================================================

async function handleTaskAcknowledge(
  mondayItemId: string,
  userId: string,
  channelId?: string,
  threadTs?: string
): Promise<void> {
  try {
    // Update Monday.com status
    await monday.updateWorkflowStatus(mondayItemId, 'Acknowledged');
    
    // Post confirmation to thread
    if (channelId && threadTs) {
      await slack.postToThread(
        threadTs,
        `👀 Acknowledged by <@${userId}>`,
        channelId
      );
    }
    
    console.log(`[Interactivity] Task ${mondayItemId} acknowledged by ${userId}`);
  } catch (error) {
    console.error(`[Interactivity] Failed to acknowledge task ${mondayItemId}:`, error);
  }
}

async function handleTaskWorking(
  mondayItemId: string,
  userId: string,
  channelId?: string,
  threadTs?: string
): Promise<void> {
  try {
    await monday.updateWorkflowStatus(mondayItemId, 'Working on it');
    
    if (channelId && threadTs) {
      await slack.postToThread(
        threadTs,
        `🟡 Working on it - <@${userId}>`,
        channelId
      );
    }
    
    console.log(`[Interactivity] Task ${mondayItemId} marked working by ${userId}`);
  } catch (error) {
    console.error(`[Interactivity] Failed to mark task ${mondayItemId} working:`, error);
  }
}

async function handleTaskComplete(
  mondayItemId: string,
  userId: string,
  channelId?: string,
  threadTs?: string
): Promise<void> {
  try {
    await monday.updateWorkflowStatus(mondayItemId, 'Complete');
    
    if (channelId && threadTs) {
      await slack.postToThread(
        threadTs,
        `✅ Completed by <@${userId}>`,
        channelId
      );
    }
    
    console.log(`[Interactivity] Task ${mondayItemId} completed by ${userId}`);
  } catch (error) {
    console.error(`[Interactivity] Failed to complete task ${mondayItemId}:`, error);
  }
}

async function handleTaskStuck(
  mondayItemId: string,
  userId: string,
  channelId?: string,
  threadTs?: string
): Promise<void> {
  try {
    await monday.updateWorkflowStatus(mondayItemId, 'Stuck');
    
    if (channelId && threadTs) {
      await slack.postToThread(
        threadTs,
        `🔴 Stuck - <@${userId}> needs help`,
        channelId
      );
    }
    
    console.log(`[Interactivity] Task ${mondayItemId} marked stuck by ${userId}`);
  } catch (error) {
    console.error(`[Interactivity] Failed to mark task ${mondayItemId} stuck:`, error);
  }
}

async function handleTaskConfirmToday(
  mondayItemId: string,
  userId: string,
  channelId?: string,
  threadTs?: string
): Promise<void> {
  try {
    // This is for digest confirmations - user confirms they'll complete today
    // Could store in digest state, or just mark as acknowledged
    await monday.updateWorkflowStatus(mondayItemId, 'Working on it');
    
    if (channelId && threadTs) {
      await slack.postToThread(
        threadTs,
        `✅ <@${userId}> confirmed - will complete today`,
        channelId
      );
    }
    
    console.log(`[Interactivity] Task ${mondayItemId} confirmed for today by ${userId}`);
  } catch (error) {
    console.error(`[Interactivity] Failed to confirm task ${mondayItemId}:`, error);
  }
}

async function handleTaskReschedule(
  mondayItemId: string,
  userId: string,
  triggerId: string
): Promise<void> {
  try {
    // Open a modal for date selection
    await slackClient.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        callback_id: 'reschedule_task',
        private_metadata: JSON.stringify({ mondayItemId, userId }),
        title: {
          type: 'plain_text',
          text: 'Reschedule Task',
        },
        submit: {
          type: 'plain_text',
          text: 'Reschedule',
        },
        close: {
          type: 'plain_text',
          text: 'Cancel',
        },
        blocks: [
          {
            type: 'input',
            block_id: 'new_date_block',
            element: {
              type: 'datepicker',
              action_id: 'new_date',
              placeholder: {
                type: 'plain_text',
                text: 'Select new due date',
              },
            },
            label: {
              type: 'plain_text',
              text: 'New Due Date',
            },
          },
          {
            type: 'input',
            block_id: 'reason_block',
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'reason',
              multiline: true,
              placeholder: {
                type: 'plain_text',
                text: 'Why are you rescheduling? (optional)',
              },
            },
            label: {
              type: 'plain_text',
              text: 'Reason',
            },
          },
        ],
      },
    });
    
    console.log(`[Interactivity] Opened reschedule modal for task ${mondayItemId}`);
  } catch (error) {
    console.error(`[Interactivity] Failed to open reschedule modal:`, error);
  }
}

// ============================================================================
// Issue Call Handlers
// ============================================================================

async function handleIssueCallClaim(
  issueCallId: string,
  userId: string,
  channelId?: string,
  threadTs?: string
): Promise<void> {
  try {
    // Import issue call tracker
    const { claimIssueCall } = await import('../services/issueCallTracker.js');
    
    // threadTs is the issue call thread - use it to claim
    if (threadTs) {
      const result = await claimIssueCall(threadTs, userId);
      if (!result.success) {
        console.error(`[Interactivity] Failed to claim issue call: ${result.error}`);
      }
    }
    
    console.log(`[Interactivity] Issue call claimed by ${userId}`);
  } catch (error) {
    console.error(`[Interactivity] Failed to claim issue call:`, error);
  }
}

// ============================================================================
// View Submission Handlers
// ============================================================================

async function handleViewSubmission(payload: InteractivityPayload): Promise<void> {
  const view = payload.view;
  if (!view) return;

  const callbackId = view.callback_id;
  
  switch (callbackId) {
    case 'reschedule_task':
      await handleRescheduleSubmission(payload);
      break;
      
    default:
      console.log(`[Interactivity] Unknown view submission: ${callbackId}`);
  }
}

async function handleRescheduleSubmission(payload: InteractivityPayload): Promise<void> {
  try {
    const view = payload.view!;
    const metadata = JSON.parse(view.private_metadata || '{}');
    const { mondayItemId, userId } = metadata;
    
    const newDate = view.state.values.new_date_block?.new_date?.selected_date;
    const reason = view.state.values.reason_block?.reason?.value || '';
    
    if (!newDate || !mondayItemId) {
      console.error('[Interactivity] Missing data for reschedule');
      return;
    }
    
    // Update Monday.com due date
    await monday.updateDueDate(mondayItemId, newDate);
    
    // Get the task's Slack thread to post update
    const item = await monday.getItem(mondayItemId);
    if (item) {
      const slackThreadValue = item.column_values?.find(
        (cv: any) => cv.id === config.monday.columns.slackThreadId
      )?.text;
      
      if (slackThreadValue) {
        let channelId = config.slack.channelId;
        let threadTs = slackThreadValue;
        
        if (slackThreadValue.includes(':')) {
          [channelId, threadTs] = slackThreadValue.split(':');
        }
        
        const reasonText = reason ? `\nReason: ${reason}` : '';
        await slack.postToThread(
          threadTs,
          `📅 Rescheduled to ${newDate} by <@${userId}>${reasonText}`,
          channelId
        );
      }
    }
    
    console.log(`[Interactivity] Task ${mondayItemId} rescheduled to ${newDate}`);
  } catch (error) {
    console.error('[Interactivity] Failed to process reschedule:', error);
  }
}

export default router;
```

### 1.2 Add `updateDueDate` to `src/services/monday.ts`

If it doesn't exist already:

```typescript
/**
 * Update a task's due date
 */
export async function updateDueDate(itemId: string, date: string): Promise<void> {
  const mutation = `
    mutation UpdateDueDate($itemId: ID!, $boardId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value(
        item_id: $itemId
        board_id: $boardId
        column_id: $columnId
        value: $value
      ) {
        id
      }
    }
  `;

  await executeQuery(mutation, {
    itemId,
    boardId: config.monday.boardId,
    columnId: config.monday.columns.date,
    value: JSON.stringify({ date }),
  });
}
```

### 1.3 Update `src/server.ts`

Add the interactivity router:

```typescript
// Add import at top
import interactivityRouter from './routes/interactivity.js';

// Add middleware for parsing form-encoded payloads (needed for Slack interactivity)
// This should be BEFORE the JSON body parser for this route
app.use('/webhook/slack/interactivity', express.urlencoded({ extended: true }));

// Mount the router
app.use(interactivityRouter);
```

### 1.4 Configure Slack App

In your Slack App settings (api.slack.com):

1. Go to **Interactivity & Shortcuts**
2. Turn ON **Interactivity**
3. Set Request URL: `https://your-railway-url.up.railway.app/webhook/slack/interactivity`
4. Save Changes

---

## Phase 2: Test Buttons Manually

Before migrating anything, verify buttons work.

### 2.1 Deploy Phase 1 Code

Push to Railway, wait for deploy.

### 2.2 Post a Test Message with Buttons

Create a temporary test endpoint or use Railway shell:

```typescript
// Quick test - post a message with buttons to yourself
const testButtons = async () => {
  const client = new WebClient(process.env.SLACK_BOT_TOKEN);
  
  await client.chat.postMessage({
    channel: 'U0144K906KA', // Edward's DM
    text: 'Button test',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Test Task*\nThis is a test.' },
      },
      {
        type: 'actions',
        block_id: 'test_task_controls',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '👀 Acknowledge' },
            action_id: 'task_acknowledge',
            value: 'TEST_ITEM_ID', // Use a real Monday item ID for full test
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ Complete' },
            style: 'primary',
            action_id: 'task_complete',
            value: 'TEST_ITEM_ID',
          },
        ],
      },
    ],
  });
};
```

### 2.3 Verify

1. Click a button
2. Check server logs - should see `[Interactivity] Received`
3. Check Monday - status should update
4. Check Slack thread - should see confirmation message

**DO NOT proceed to Phase 3 until buttons work.**

---

## Phase 3: Migrate Existing Threads

Now that buttons work, add them to existing tasks.

### 3.1 Dry Run

```bash
# Via Railway CLI or shell
DRY_RUN=true npx ts-node src/scripts/migrateThreadButtons.ts
```

Review output. Should show list of tasks that WOULD be updated.

### 3.2 Live Run

```bash
npx ts-node src/scripts/migrateThreadButtons.ts
```

Or via API:
```bash
curl -X POST https://your-app.railway.app/admin/migrate/thread-buttons
```

### 3.3 Verify

1. Check a few Slack threads - buttons should appear
2. Click buttons - should work (Phase 2 confirmed this)
3. Check Monday - statuses should update

---

## Phase 4: Build Digest System

Now build the full digest system per `DIGEST_SYSTEM_SPEC.md`.

### Build Order:

1. `src/services/workingHours.ts` - Date/time utilities
2. `src/services/digestState.ts` - State persistence
3. `src/services/blockKit.ts` - Message block builders
4. `src/services/digest.ts` - Core digest functions
5. `src/services/digestScheduler.ts` - Scheduler

### Key Files from Spec:

Reference `DIGEST_SYSTEM_SPEC.md` for:
- All TypeScript interfaces
- Function signatures
- Message templates
- Block Kit JSON examples
- Escalation logic flowcharts

### Test Each Digest Type:

Add manual trigger endpoints:

```typescript
// In server.ts
app.post('/admin/digest/test-personal/:userId', async (req, res) => {
  const { sendPersonalDigest } = await import('./services/digest.js');
  await sendPersonalDigest(req.params.userId);
  res.json({ success: true });
});

app.post('/admin/digest/test-team', async (req, res) => {
  const { sendTeamOverview } = await import('./services/digest.js');
  await sendTeamOverview();
  res.json({ success: true });
});

// etc.
```

---

## Phase 5: Remove Old Notification System

Once digest system is tested and working:

### 5.1 Remove Old Scheduler Calls from `server.ts`:

```typescript
// DELETE these lines:
import { startFollowUpScheduler } from './services/autoFollowUp.js';
import { startScheduler as startAfterHoursScheduler } from './services/afterHoursScheduler.js';

// DELETE these calls:
startFollowUpScheduler();
startAfterHoursScheduler();

// REPLACE with:
import { startDigestScheduler } from './services/digestScheduler.js';
startDigestScheduler();
```

### 5.2 Delete Old Files:

- `src/services/autoFollowUp.ts`
- `src/services/afterHoursScheduler.ts`  
- `src/services/schedulerState.ts`

### 5.3 Clean Up Issue Call Tracker:

Remove the 20-minute ping interval from `src/services/issueCallTracker.ts` (digest system handles this now).

---

## Phase 6: Launch

### 6.1 Deploy Final Code

Push all changes to Railway.

### 6.2 Trigger Initial Digests

```bash
# Send morning digest to everyone
curl -X POST https://your-app.railway.app/admin/digest/trigger-morning

# Send team overview
curl -X POST https://your-app.railway.app/admin/digest/trigger-team

# Send issue call digest
curl -X POST https://your-app.railway.app/admin/digest/trigger-issue-calls
```

### 6.3 Announce to Team

Post in main Slack channel:

```
📢 New Task Management System is Live!

What's new:
• Daily digest DMs at 10 AM with your task roadmap
• Buttons on tasks: Acknowledge, Working, Complete, Stuck
• Due-today confirmations required
• End-of-day prep for tomorrow

Reactions still work, but buttons are the new primary way to update tasks.

Questions? Ask Edward.
```

---

## Quick Reference: All New Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/webhook/slack/interactivity` | POST | Slack button clicks |
| `/admin/migrate/thread-buttons` | POST | Run button migration |
| `/admin/digest/test-personal/:userId` | POST | Test personal digest |
| `/admin/digest/test-team` | POST | Test team overview |
| `/admin/digest/test-issue-calls` | POST | Test issue call digest |
| `/admin/digest/trigger-morning` | POST | Trigger all morning digests |
| `/admin/digest/trigger-escalation` | POST | Trigger escalation check |

---

## Checklist

### Phase 1
- [ ] Create `src/routes/interactivity.ts`
- [ ] Add `updateDueDate` to monday.ts (if needed)
- [ ] Update server.ts with interactivity router
- [ ] Configure Slack App interactivity URL
- [ ] Deploy

### Phase 2
- [ ] Post test message with buttons
- [ ] Verify button clicks reach server
- [ ] Verify Monday status updates
- [ ] Verify Slack thread confirmations

### Phase 3
- [ ] Run migration dry run
- [ ] Review dry run output
- [ ] Run live migration
- [ ] Verify buttons on existing threads

### Phase 4
- [ ] Build workingHours.ts
- [ ] Build digestState.ts
- [ ] Build blockKit.ts
- [ ] Build digest.ts
- [ ] Build digestScheduler.ts
- [ ] Test each digest type manually

### Phase 5
- [ ] Remove old scheduler imports
- [ ] Delete old files
- [ ] Clean up issue call tracker
- [ ] Deploy

### Phase 6
- [ ] Trigger initial digests
- [ ] Announce to team
- [ ] Monitor for issues

---

## Troubleshooting

### Buttons Don't Work

1. Check Slack App interactivity URL is correct
2. Check server logs for `[Interactivity]` entries
3. Verify endpoint is mounted: `curl -X POST your-url/webhook/slack/interactivity`
4. Check Slack App has correct scopes

### Migration Fails

1. Check `DRY_RUN=true` output first
2. Look for `Message deleted` or `Channel not found` errors (normal for old threads)
3. Check rate limiting - increase `DELAY_BETWEEN_UPDATES_MS` if needed

### Digests Not Sending

1. Check scheduler is running: look for `[DigestScheduler]` in logs
2. Verify timezone settings
3. Check for holidays blocking send
4. Test manually with admin endpoints

---

**Give this document + the three spec files to Claude Code. Say "Build this in order, starting with Phase 1."**
