# Digest Notification System - Technical Specification

**Version:** 1.0  
**Date:** 2026-01-07  
**Status:** Ready for Implementation

---

## Table of Contents

1. [Overview](#overview)
2. [People & Roles](#people--roles)
3. [Schedule](#schedule)
4. [Digest Types](#digest-types)
5. [Escalation Logic](#escalation-logic)
6. [Button Interactions](#button-interactions)
7. [Data Structures](#data-structures)
8. [New Files to Create](#new-files-to-create)
9. [Files to Modify](#files-to-modify)
10. [Files to Remove/Deprecate](#files-to-removedeprecate)
11. [Edge Cases](#edge-cases)
12. [Message Templates](#message-templates)

---

## Overview

### Current System (Problems)
- Task-centric: Each task sends its own notifications
- In-memory deduplication resets on restart
- Unlimited issue call pings every 20 minutes
- No user acknowledgment of daily workload
- Escalation happens too late (after tasks are overdue)

### New System (Solution)
- User-centric: Daily digests summarize each person's workload
- Scheduled notifications at predictable times
- Button-based interactions replace reactions
- Proactive escalation BEFORE deadlines
- Zero tolerance for overdue tasks (4 PM hard deadline)

### Core Working Hours
- **10 AM - 4 PM EST**: Core hours, all deadlines based on 4 PM
- **4 PM - 6 PM EST**: Buffer to complete confirmed work
- **Weekends + US Holidays**: No notifications

---

## People & Roles

### Users with Custom Schedules

| Slack ID | Name | Morning Digest Time |
|----------|------|---------------------|
| U05BRER83HT | Dayna | 12 PM EST |
| (all others) | — | 10 AM EST |

### Escalation Contacts

| Slack ID | Name | Role | Escalation Type |
|----------|------|------|-----------------|
| U04CFCNAN4Q | Garet | Operations Manager | Regular tasks (first) |
| U08FY4FAJ9J | Eliana | Edward's Assistant | Regular tasks (first) |
| U0144K906KA | Edward | Owner | Regular tasks (final) |
| U072TG6N57A | Ruzzell | Issue Call Manager | Issue calls (first) |
| U05BRER83HT | Dayna | Issue Call Manager | Issue calls (first) |
| U08M6BP6X3N | Elia | — | Issue calls (final) |

### Channels

| Channel ID | Purpose |
|------------|---------|
| C07JS45GTQC | Issue call digests (@closers) |
| C08QCFC4Y0H | Team overview (all task types) |

### User Groups

| Group ID | Name | Used For |
|----------|------|----------|
| S07QVQVMQMB | @closers | Issue call notifications |

---

## Schedule

### Daily Schedule (Business Days Only)

| Time (EST) | Event | Destination | Content |
|------------|-------|-------------|---------|
| 10:00 AM | Morning Digest | DM (most users) | Personal task roadmap |
| 10:00 AM | Issue Call Digest | C07JS45GTQC | All issue calls status |
| 10:00 AM | Team Overview | C08QCFC4Y0H | Everyone's task status |
| 12:00 PM | Morning Digest | DM (Dayna only) | Personal task roadmap |
| 12:00 PM | Due-Today Escalation (First) | DM to Garet + Eliana | Unconfirmed due-today tasks |
| 1:30 PM | Due-Today Escalation (Final) | DM to Edward | Still unconfirmed tasks |
| 5:30 PM | Tomorrow Prep | DM (everyone) | Tomorrow's tasks (Fri→Mon) |
| 5:30 PM | Issue Call EOD | C07JS45GTQC | End of day status |

### Issue Call Claiming Escalation (Dynamic)

Runs continuously during business hours, checks every 15 minutes:

| Time Unclaimed | Action |
|----------------|--------|
| ≥ 1 hour | First escalation → Ruzzell + Dayna |
| ≥ 2 hours | Second escalation → Edward + Elia |

### Issue Call Completion Escalation (Dynamic)

For CLAIMED issue calls, runs continuously:

| Working Hours Until 4 PM | Action |
|--------------------------|--------|
| > 4 hours | No escalation |
| ≤ 4 hours | First escalation → Ruzzell + Dayna |
| ≤ 2 hours | Second escalation → Edward + Elia |

### Skip Days
- Saturdays
- Sundays
- US Federal Holidays (maintain existing `US_HOLIDAYS` array, extend through 2026)

---

## Digest Types

### 1. Personal Morning Digest (DM)

**Recipients:** All users with tasks  
**Time:** 10 AM EST (12 PM for Dayna)  
**Purpose:** Show week roadmap, get confirmation on due-today tasks

**Content Sections:**
1. Overdue tasks (if any) - with action buttons
2. Due today tasks - with confirmation buttons
3. This week tasks (next 7 days, excluding today) - view links only

### 2. Issue Call Digest (C07JS45GTQC)

**Recipients:** @closers group  
**Time:** 10 AM EST  
**Purpose:** Show all issue call status, enable claiming

**Content Sections:**
1. Overdue issue calls (with assignee)
2. Due today issue calls (with assignee or UNCLAIMED flag)
3. This week issue calls
4. Unclaimed calls get [🙋 Claim This] button

### 3. Team Overview (C08QCFC4Y0H)

**Recipients:** Channel members (managers/leads)  
**Time:** 10 AM EST  
**Purpose:** Bird's eye view of team workload

**Content Sections:**
1. 🔴 Needs Attention - users with overdue or unconfirmed due-today
2. 🟡 Heavy Load - users with 5+ tasks this week
3. 🟢 On Track - everyone else
4. 📞 Issue Call Summary - overdue count, unclaimed count
5. Footer stats - total tasks, overdue, due today

### 4. Tomorrow Prep (DM)

**Recipients:** All users with tasks due tomorrow  
**Time:** 5:30 PM EST  
**Purpose:** Preview tomorrow's work, catch unacknowledged items

**Content Sections:**
1. Due tomorrow tasks (Friday digest shows Monday)
2. Still unacknowledged from today (if any)

### 5. Issue Call EOD (C07JS45GTQC)

**Recipients:** @closers group  
**Time:** 5:30 PM EST  
**Purpose:** End of day status check

**Content Sections:**
1. Completed today
2. Still open (carrying to tomorrow)
3. Unclaimed (critical - needs morning attention)

### 6. Escalation DMs

**Recipients:** Escalation contacts (varies by type)  
**Time:** Dynamic based on triggers  
**Purpose:** Alert managers to at-risk items

---

## Escalation Logic

### Regular Tasks - Due Today Flow

```
10 AM (12 PM Dayna)
    │
    ▼
User receives Morning Digest with due-today tasks
Each task has: [✅ Will complete today] [📅 Reschedule]
    │
    ▼
12 PM ─── Any unconfirmed due-today tasks? ───┐
    │                                          │
    │ No                                   Yes │
    ▼                                          ▼
  (done)                          DM to Garet + Eliana:
                                  "X has unconfirmed tasks due today"
                                               │
                                               ▼
1:30 PM ─── Still unconfirmed? ───────────────┐
    │                                          │
    │ No                                   Yes │
    ▼                                          ▼
  (done)                          DM to Edward:
                                  "X tasks still unconfirmed"
                                               │
                                               ▼
4 PM ─── Deadline. Task either done, confirmed, or failed.
```

### Issue Calls - Claiming Flow

```
Issue call created (unclaimed)
    │
    ▼
Every 15 min check: How long unclaimed?
    │
    ├── < 1 hour ──────────────► No action
    │
    ├── ≥ 1 hour, < 2 hours ───► DM to Ruzzell + Dayna
    │                            "Issue call unclaimed for 1+ hour"
    │
    └── ≥ 2 hours ─────────────► DM to Edward + Elia
                                 "Issue call unclaimed for 2+ hours"
```

### Issue Calls - Completion Flow (After Claimed)

```
Issue call claimed
    │
    ▼
Every 15 min check: Working hours until 4 PM deadline?
    │
    ├── > 4 hours ─────────────► No escalation
    │
    ├── ≤ 4 hours, > 2 hours ──► DM to Ruzzell + Dayna
    │                            "Issue call due in <4 hours"
    │
    └── ≤ 2 hours ─────────────► DM to Edward + Elia
                                 "Issue call due in <2 hours"
```

### Working Hours Calculation

```typescript
/**
 * Calculate working hours between now and a deadline
 * Working hours: 10 AM - 4 PM EST, Mon-Fri, excluding holidays
 */
function getWorkingHoursUntil(deadline: Date, now: Date = new Date()): number {
  // Convert to EST
  // Count hours only within 10 AM - 4 PM windows
  // Skip weekends and holidays
  // Return total working hours remaining
}
```

---

## Button Interactions

### Slack Interactivity Endpoint

**Path:** `POST /webhook/slack/interactivity`  
**Content-Type:** `application/x-www-form-urlencoded` (Slack sends payload as form data)

### Button Action IDs

| action_id | Payload | Handler |
|-----------|---------|---------|
| `task_confirm_today` | `{taskId, userId}` | Mark task confirmed for today |
| `task_reschedule` | `{taskId, userId}` | Open modal to pick new date |
| `task_acknowledge` | `{taskId, userId}` | Mark task acknowledged (👀) |
| `task_working` | `{taskId, userId}` | Mark task working (🟡) |
| `task_complete` | `{taskId, userId}` | Mark task complete (✅) |
| `task_stuck` | `{taskId, userId}` | Mark task stuck (🔴) |
| `issue_call_claim` | `{issueCallId, userId}` | Claim issue call |
| `digest_acknowledged` | `{digestId, userId}` | User acknowledged digest |

### Button Click Flow

```
User clicks [✅ Will complete today]
    │
    ▼
Slack POST /webhook/slack/interactivity
    │
    ▼
Parse payload, extract action_id + values
    │
    ▼
Route to handler:
    - Update Monday.com status
    - Update local state (mark confirmed)
    - Post thread confirmation message
    │
    ▼
Return 200 OK (Slack requires fast response)
    │
    ▼
Update original message to show new state
(use chat.update with modified blocks)
```

### Reschedule Modal

When user clicks [📅 Reschedule]:

1. Open Slack modal with date picker
2. User selects new date + provides reason (optional)
3. On submit:
   - Update Monday.com due date
   - Post to task thread: "Rescheduled to [date] by @user: [reason]"
   - Update digest message to reflect change

---

## Data Structures

### DigestState (Persisted to Disk)

```typescript
// File: .digest-state.json
interface DigestState {
  // Track which digests have been sent today
  lastDigestDate: string;  // "2026-01-07"
  
  // Track user confirmations for due-today tasks
  confirmedTasks: {
    [taskId: string]: {
      usedId: string;
      confirmedAt: number;  // timestamp
      type: 'will_complete' | 'rescheduled';
      newDueDate?: string;  // if rescheduled
    };
  };
  
  // Track escalations sent (prevent duplicates)
  escalationsSent: {
    [key: string]: number;  // "regular-first-2026-01-07" -> timestamp
  };
  
  // Track digest acknowledgments
  digestAcks: {
    [usedId: string]: {
      date: string;
      ackedAt: number;
    };
  };
}
```

### IssueCallState (Extend Existing)

```typescript
// Extend PendingIssueCall in issueCallTracker.ts
interface PendingIssueCall {
  // ... existing fields ...
  
  // New fields for escalation tracking
  claimEscalationLevel: 0 | 1 | 2;  // 0=none, 1=first, 2=second
  completionEscalationLevel: 0 | 1 | 2;
  lastClaimEscalationAt?: number;
  lastCompletionEscalationAt?: number;
}
```

### UserSchedule

```typescript
// In config/constants.ts or environment.ts
interface UserScheduleOverride {
  usedId: string;
  morningDigestHour: number;  // 24-hour format, EST
}

const USER_SCHEDULE_OVERRIDES: UserScheduleOverride[] = [
  { usedId: 'U05BRER83HT', morningDigestHour: 12 },  // Dayna
];

const DEFAULT_MORNING_DIGEST_HOUR = 10;  // EST
```

### EscalationConfig

```typescript
// In config/constants.ts
const ESCALATION_CONFIG = {
  regularTasks: {
    first: {
      hour: 12,  // EST
      recipients: ['U04CFCNAN4Q', 'U08FY4FAJ9J'],  // Garet, Eliana
    },
    final: {
      hour: 13.5,  // 1:30 PM EST
      recipients: ['U0144K906KA'],  // Edward
    },
  },
  issueCalls: {
    claiming: {
      first: {
        afterMinutes: 60,
        recipients: ['U072TG6N57A', 'U05BRER83HT'],  // Ruzzell, Dayna
      },
      final: {
        afterMinutes: 120,
        recipients: ['U0144K906KA', 'U08M6BP6X3N'],  // Edward, Elia
      },
    },
    completion: {
      first: {
        hoursBeforeDeadline: 4,
        recipients: ['U072TG6N57A', 'U05BRER83HT'],  // Ruzzell, Dayna
      },
      final: {
        hoursBeforeDeadline: 2,
        recipients: ['U0144K906KA', 'U08M6BP6X3N'],  // Edward, Elia
      },
    },
  },
};
```

---

## New Files to Create

### 1. `src/services/digest.ts`

Main digest service. Exports:

```typescript
// Send personal morning digest to a user
export async function sendPersonalDigest(userId: string): Promise<void>;

// Send issue call digest to channel
export async function sendIssueCallDigest(): Promise<void>;

// Send team overview to channel
export async function sendTeamOverview(): Promise<void>;

// Send tomorrow prep to a user
export async function sendTomorrowPrep(userId: string): Promise<void>;

// Send issue call EOD to channel
export async function sendIssueCallEOD(): Promise<void>;

// Check and send escalations
export async function checkRegularTaskEscalations(): Promise<void>;
export async function checkIssueCallEscalations(): Promise<void>;
```

### 2. `src/services/digestState.ts`

State management for digest system:

```typescript
export function loadDigestState(): DigestState;
export function saveDigestState(state: DigestState): void;

export function markTaskConfirmed(taskId: string, userId: string, type: 'will_complete' | 'rescheduled', newDueDate?: string): void;
export function isTaskConfirmed(taskId: string): boolean;
export function getUnconfirmedDueTodayTasks(userId: string): Task[];

export function markEscalationSent(key: string): void;
export function hasEscalationBeenSent(key: string): boolean;

export function markDigestAcked(userId: string): void;
export function hasDigestBeenAcked(userId: string, date: string): boolean;
```

### 3. `src/services/digestScheduler.ts`

Scheduler for all digest-related jobs:

```typescript
export function startDigestScheduler(): void;
export function stopDigestScheduler(): void;
export function getSchedulerStatus(): SchedulerStatus;

// Manual triggers for testing
export async function triggerMorningDigests(): Promise<void>;
export async function triggerIssueCallDigest(): Promise<void>;
export async function triggerTeamOverview(): Promise<void>;
export async function triggerTomorrowPrep(): Promise<void>;
export async function triggerEscalationCheck(): Promise<void>;
```

### 4. `src/services/workingHours.ts`

Working hours calculations:

```typescript
export function isBusinessDay(date: Date): boolean;
export function isWorkingHours(date: Date): boolean;
export function getWorkingHoursUntil(deadline: Date, from?: Date): number;
export function getNextBusinessDay(from: Date): Date;
export function get4PMDeadline(date: Date): Date;
```

### 5. `src/routes/interactivity.ts`

Slack interactivity webhook handler:

```typescript
const router = Router();

// Main interactivity endpoint
router.post('/webhook/slack/interactivity', handleInteractivity);

// Handlers for each action type
async function handleTaskConfirmToday(payload: InteractivityPayload): Promise<void>;
async function handleTaskReschedule(payload: InteractivityPayload): Promise<void>;
async function handleTaskAcknowledge(payload: InteractivityPayload): Promise<void>;
async function handleTaskWorking(payload: InteractivityPayload): Promise<void>;
async function handleTaskComplete(payload: InteractivityPayload): Promise<void>;
async function handleTaskStuck(payload: InteractivityPayload): Promise<void>;
async function handleIssueCallClaim(payload: InteractivityPayload): Promise<void>;
async function handleDigestAcknowledged(payload: InteractivityPayload): Promise<void>;

export default router;
```

### 6. `src/services/blockKit.ts`

Block Kit message builders:

```typescript
// Personal digest blocks
export function buildPersonalDigestBlocks(tasks: TasksByCategory): KnownBlock[];

// Issue call digest blocks
export function buildIssueCallDigestBlocks(issueCalls: IssueCallsByCategory): KnownBlock[];

// Team overview blocks
export function buildTeamOverviewBlocks(teamStatus: TeamStatus): KnownBlock[];

// Tomorrow prep blocks
export function buildTomorrowPrepBlocks(tasks: Task[], unacked: Task[]): KnownBlock[];

// Escalation message blocks
export function buildEscalationBlocks(type: EscalationType, data: EscalationData): KnownBlock[];

// Task notification blocks (for original task posts)
export function buildTaskNotificationBlocks(task: Task): KnownBlock[];

// Issue call notification blocks
export function buildIssueCallNotificationBlocks(issueCall: IssueCall): KnownBlock[];
```

---

## Files to Modify

### 1. `src/server.ts`

- Import and mount interactivity router
- Replace `startFollowUpScheduler()` with `startDigestScheduler()`
- Remove `startAfterHoursScheduler()` (merged into digest scheduler)
- Add manual trigger endpoints for testing

```typescript
// Add
import interactivityRouter from './routes/interactivity.js';
import { startDigestScheduler } from './services/digestScheduler.js';

// Mount
app.use(interactivityRouter);

// Replace scheduler starts
startDigestScheduler();
```

### 2. `src/services/slack.ts`

- Add `sendDM(userId: string, blocks: KnownBlock[]): Promise<string>`
- Add `updateMessage(channel: string, ts: string, blocks: KnownBlock[]): Promise<void>`
- Keep existing functions for backward compatibility during transition

### 3. `src/services/issueCallTracker.ts`

- Add new fields to `PendingIssueCall` interface
- Add escalation level tracking functions
- Remove the 20-minute ping interval (replaced by digest system)

### 4. `src/config/environment.ts`

- Add digest-specific config options
- Add escalation recipient config

### 5. `src/config/constants.ts`

- Add `ESCALATION_CONFIG`
- Add `USER_SCHEDULE_OVERRIDES`
- Add `DEFAULT_MORNING_DIGEST_HOUR`
- Add working hours constants

---

## Files to Remove/Deprecate

### Remove Entirely

| File | Reason |
|------|--------|
| `src/services/autoFollowUp.ts` | Replaced by digest system |
| `src/services/afterHoursScheduler.ts` | Merged into digestScheduler |
| `src/services/schedulerState.ts` | Replaced by digestState |

### Deprecate (Keep for Transition)

| File | Notes |
|------|-------|
| Reaction handlers in `relayEvents.ts` | Keep working, but buttons are primary |
| `sentFollowUps` Map | Remove after digest system is stable |

---

## Edge Cases

### 1. User Has No Tasks

Don't send empty digest. Skip that user for the day.

### 2. Task Created After Morning Digest

- If due today: Send individual DM notification with buttons
- If due later: Will appear in next morning digest

### 3. Task Rescheduled to Today After Morning Digest

Send individual DM: "Task X was rescheduled to today. [✅ Will complete] [📅 Reschedule again]"

### 4. User Doesn't Exist in System

Skip user, log warning. Don't crash digest run.

### 5. Slack API Rate Limits

- Process digests with 1-second delays between users
- Batch escalation checks to avoid burst traffic
- Use circuit breaker for Slack calls

### 6. Server Restart Mid-Day

- State is persisted to disk
- On restart, check what was already sent today
- Don't re-send digests, do continue escalation checks

### 7. Holiday Handling

- Check `US_HOLIDAYS` array before any scheduled job
- Friday before Monday holiday: Tomorrow prep shows Tuesday
- Update holiday list through 2026

### 8. Task Marked Complete via Reaction

- Still works (backward compatibility)
- Updates task status in Monday
- Digest state should reflect this (check Monday status, not just local state)

### 9. Issue Call Claimed via Reaction

- Still works (backward compatibility)
- Stops claiming escalation
- Starts completion escalation tracking

### 10. Multiple Owners on Task

- Send digest to ALL owners
- Any owner can confirm
- Once one confirms, task is confirmed for all

---

## Message Templates

### Personal Morning Digest

```
Good morning {firstName}! Here's your week:

⚠️ OVERDUE ({count})
• {taskName} ({daysLate} day{s} late) [View]
  [👀 Acknowledge] [✅ Complete] [🔴 Stuck]

🔴 DUE TODAY ({count})
• {taskName} [View]
  [✅ Will complete today] [📅 Reschedule]

📅 THIS WEEK ({count})
• {dayOfWeek}: {taskName} [View]
• {dayOfWeek}: {taskName} [View]

───────────────────────────
Reply with any questions or concerns.
```

### Due Today Check-In (If Unconfirmed at 12 PM)

```
⏰ Checking in on today's tasks:

Still need confirmation:
• {taskName} [View]
  [✅ On it] [📅 Reschedule] [🔴 Blocked]

Please confirm by 1:30 PM.
```

### Escalation - First (Garet + Eliana)

```
⚠️ Due-Today Alert

{firstName} has {count} unconfirmed task{s} due today:

• {taskName} [View]
• {taskName} [View]

No confirmation received by 12 PM deadline.
```

### Escalation - Final (Edward)

```
🚨 Escalation Required

{firstName} still has {count} unconfirmed task{s}:

• {taskName} [View]

First escalation was sent at 12 PM to Garet + Eliana.
No response as of 1:30 PM.
```

### Issue Call Digest

```
📞 ISSUE CALL STATUS

<!subteam^S07QVQVMQMB>

⚠️ OVERDUE ({count})
• {customerName} - {issue} ({daysLate}d late) [View]
  Assigned: @{assignee}

🔴 DUE TODAY ({count})
• {customerName} - {issue} [View]
  Assigned: @{assignee}
• {customerName} - {issue} [View]
  ⚠️ UNCLAIMED [🙋 Claim This]

📅 THIS WEEK ({count})
• {dayOfWeek}: {customerName} - {issue} [View]

───────────────────────────
React 👀 on the thread or click [Claim] to take an issue.
```

### Issue Call - Claim Escalation (First)

```
⚠️ Unclaimed Issue Call

{customerName} - {issue}

Created {timeAgo}, still unclaimed.

[View Thread]
```

### Issue Call - Claim Escalation (Final)

```
🚨 Issue Call Needs Immediate Attention

{customerName} - {issue}

Unclaimed for {hours}+ hours.
First escalation sent to Ruzzell + Dayna at {time}.

[View Thread]
```

### Team Overview

```
📊 TEAM STATUS - {dayOfWeek} {date}

🔴 NEEDS ATTENTION
• {name}: {overdueCount} overdue, {dueTodayCount} due today ({unconfirmedCount} unconfirmed)
• {name}: {overdueCount} overdue ({oldestDays} days)

🟡 HEAVY LOAD (5+ this week)
• {name}: {weekCount} tasks this week
• {name}: {weekCount} tasks this week

🟢 ON TRACK
• {name}, {name}, {name}

📞 ISSUE CALLS
• {overdueCount} overdue
• {unclaimedCount} unclaimed
• {dueTodayCount} due today

───────────────────────────
Total: {total} tasks | Overdue: {overdue} | Due Today: {dueToday}
```

### Tomorrow Prep

```
Wrapping up! Here's {tomorrow/Monday}:

📅 DUE {TOMORROW/MONDAY} ({count})
• {taskName} [View]
• {taskName} [View]

{IF unacknowledged}
👀 Still unacknowledged from today:
• {taskName} [View]
{/IF}

{Have a good evening! / Enjoy your weekend!}
```

### Issue Call EOD

```
📞 END OF DAY - Issue Calls

✅ COMPLETED TODAY ({count})
• {customerName} - {issue} (by @{assignee})

📋 CARRYING TO TOMORROW ({count})
• {customerName} - {issue} (@{assignee})

{IF unclaimed}
⚠️ STILL UNCLAIMED ({count})
• {customerName} - {issue} [View]
  Needs morning attention!
{/IF}
```

---

## Block Kit Examples

### Button Block for Due-Today Task

```json
{
  "type": "section",
  "text": {
    "type": "mrkdwn",
    "text": "• Call back Maria about suite <https://monday.com/...|[View]>"
  },
  "accessory": {
    "type": "overflow",
    "action_id": "task_actions",
    "options": [
      {
        "text": { "type": "plain_text", "text": "✅ Will complete today" },
        "value": "confirm_today|12345"
      },
      {
        "text": { "type": "plain_text", "text": "📅 Reschedule" },
        "value": "reschedule|12345"
      }
    ]
  }
}
```

### Actions Block with Multiple Buttons

```json
{
  "type": "actions",
  "block_id": "task_12345_actions",
  "elements": [
    {
      "type": "button",
      "text": { "type": "plain_text", "text": "✅ Will complete today" },
      "style": "primary",
      "action_id": "task_confirm_today",
      "value": "12345"
    },
    {
      "type": "button",
      "text": { "type": "plain_text", "text": "📅 Reschedule" },
      "action_id": "task_reschedule",
      "value": "12345"
    }
  ]
}
```

### Claim Button for Issue Call

```json
{
  "type": "actions",
  "block_id": "issue_call_67890_claim",
  "elements": [
    {
      "type": "button",
      "text": { "type": "plain_text", "text": "🙋 Claim This" },
      "style": "primary",
      "action_id": "issue_call_claim",
      "value": "67890"
    }
  ]
}
```

---

## Implementation Order

### Phase 1: Foundation
1. Create `workingHours.ts` - date/time utilities
2. Create `digestState.ts` - state management
3. Create `blockKit.ts` - message builders
4. Create `/webhook/slack/interactivity` endpoint

### Phase 2: Core Digests
5. Create `digest.ts` - main digest functions
6. Create `digestScheduler.ts` - scheduler
7. Implement personal morning digest
8. Implement team overview

### Phase 3: Issue Calls
9. Update `issueCallTracker.ts` with escalation fields
10. Implement issue call digest
11. Implement issue call escalation logic

### Phase 4: Escalation & EOD
12. Implement due-today escalation (12 PM, 1:30 PM)
13. Implement tomorrow prep (5:30 PM)
14. Implement issue call EOD (5:30 PM)

### Phase 5: Cleanup
15. Remove `autoFollowUp.ts`
16. Remove `afterHoursScheduler.ts`
17. Update `server.ts` to use new scheduler
18. Test all flows end-to-end

---

## Testing Checklist

### Manual Triggers (Add to Server)

```typescript
// In server.ts, add test endpoints (protect with auth)
app.post('/test/digest/morning', async (req, res) => {
  await triggerMorningDigests();
  res.json({ success: true });
});

app.post('/test/digest/issue-calls', async (req, res) => {
  await triggerIssueCallDigest();
  res.json({ success: true });
});

// ... etc for each digest type
```

### Test Scenarios

- [ ] Morning digest shows correct task categorization
- [ ] Due-today buttons work (confirm, reschedule)
- [ ] Reschedule opens modal, updates Monday
- [ ] 12 PM escalation fires for unconfirmed tasks
- [ ] 1:30 PM escalation fires if still unconfirmed
- [ ] Issue call digest shows correct status
- [ ] Claim button works, stops claim escalation
- [ ] Issue call completion escalation fires at thresholds
- [ ] Tomorrow prep shows correct tasks (Fri → Mon)
- [ ] No digests on weekends
- [ ] No digests on holidays
- [ ] State persists across restart
- [ ] Reactions still work (backward compatibility)

---

## Summary

This spec replaces the current fragmented, task-centric notification system with a unified, user-centric digest system featuring:

- **Predictable schedule** - Users know when to expect notifications
- **Button interactions** - Better UX than reactions
- **Proactive escalation** - Issues caught BEFORE deadlines
- **Zero tolerance** - 4 PM hard deadline, no overdue allowed
- **Persistent state** - Survives restarts
- **Clear ownership** - Defined escalation paths for every scenario

Hand this to Claude Code and say "build it."
