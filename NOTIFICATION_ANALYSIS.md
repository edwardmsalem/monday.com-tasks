# Notification Spam Analysis

**Date:** 2026-01-07
**Issue:** Users reporting too many notifications

---

## Executive Summary

Found **5 distinct notification sources** with **3 critical issues** causing notification spam:

1. **In-memory deduplication resets on server restart** (CRITICAL)
2. **Issue call pings have no maximum limit** (CRITICAL)
3. **Overdue tasks get escalating daily reminders** (BY DESIGN, but aggressive)

---

## Notification Sources Inventory

### 1. Auto Follow-Up Scheduler (`autoFollowUp.ts`)

**Frequency:** Hourly (`checkAndSendFollowUps`)

| Trigger | When | Cooldown | Dedup Method |
|---------|------|----------|--------------|
| Acknowledge reminder | 4+ hours after creation, no 👀 | 12 hours | In-memory Map |
| Due today reminder | 10 AM on due date | Once per day per task | Key includes date |
| Overdue reminder | Daily for each day overdue | 12 hours | Key includes `daysOverdue` |
| Escalated overdue | Day 2+ overdue (includes Edward) | 12 hours | Key includes `daysOverdue` |

**⚠️ PROBLEM:** The `sentFollowUps` Map (line 84) is **in-memory only**. Server restart = all dedup state lost = duplicate notifications.

```typescript
// Line 84 - IN MEMORY ONLY
const sentFollowUps = new Map<string, number>(); // key -> timestamp
```

### 2. Issue Call Tracker (`issueCallTracker.ts`)

**Frequency:** Every 20 minutes (`pingUnclaimedIssueCalls`)

| Ping # | Who Gets Pinged |
|--------|-----------------|
| 1 | Suggested supporter only (if specified) |
| 2+ | Dayna + Ruzzell |
| After 1 hour | Dayna + Ruzzell + Edward |

**⚠️ CRITICAL PROBLEM:** No maximum ping count. An unclaimed issue call will ping **indefinitely** every 20 minutes until someone claims it.

```typescript
// Line 244 - NO MAX LIMIT
const message = `${mentions} This issue call is still waiting for someone to claim it...`;
```

**Example scenario:** Issue call posted at 10 AM, never claimed:
- 10:20 AM: Ping 1 (suggested supporter)
- 10:40 AM: Ping 2 (Dayna + Ruzzell)
- 11:00 AM: Ping 3 (Dayna + Ruzzell + Edward) ← Escalation starts
- 11:20 AM: Ping 4
- 11:40 AM: Ping 5
- ...continues until 6 PM or claimed

That's **24 pings per day** for a single unclaimed issue call.

### 3. After-Hours Scheduler (`afterHoursScheduler.ts`)

**Frequency:** Minute-by-minute check, triggers at specific hours

| Job | Time | What It Does |
|-----|------|--------------|
| Release | 8 AM ET (business days) | Pings assignees for after-hours tasks |
| Reminder | 11 AM ET (business days) | Reminds unacknowledged tasks |

**✅ GOOD:** Uses disk persistence (`schedulerState.ts`) to prevent duplicate runs after restart.

### 4. Supporter Channel Replies (`relayEvents.ts`)

**Frequency:** On each reply in supporter channel threads

| Trigger | Notification |
|---------|--------------|
| Reply to supporter notification thread | "Please add your update on Monday" |

**✅ GOOD:** Uses `remindedThreads` Set with 24-hour expiry (line 51).

**⚠️ MINOR ISSUE:** Still in-memory, loses state on restart. But lower impact since it's per-thread.

### 5. Task Creation Notifications (`slack.ts`)

**Frequency:** On task creation

| Type | Who Gets Pinged |
|------|-----------------|
| During business hours | Owner + Support |
| After hours | Nobody (deferred to 8 AM) |

**✅ GOOD:** Well-controlled, no spam issues here.

---

## Root Cause Analysis

### Critical Issue #1: In-Memory Deduplication

**Location:** `autoFollowUp.ts:84`

The `sentFollowUps` Map stores "already sent" state but is **never persisted to disk**. Every server restart clears this, causing:

1. Acknowledge reminders re-sent for tasks already reminded
2. Overdue reminders re-sent for same day
3. Due-today reminders re-sent on restart during the 10 AM hour

**Impact:** If Railway restarts the service (deploys, crashes, scaling), users get duplicate reminders.

### Critical Issue #2: Unlimited Issue Call Pings

**Location:** `issueCallTracker.ts:203-297`

The `pingUnclaimedIssueCalls()` function has no stopping condition:

```typescript
for (const [threadTs, issueCall] of pendingIssueCalls.entries()) {
  if (issueCall.claimed) continue;  // Only checks if claimed
  // No check for max ping count!
```

**Impact:** A single unclaimed issue call generates ~24 pings per business day (every 20 minutes from 10 AM to 6 PM).

### Design Issue #3: Aggressive Overdue Escalation

**Location:** `autoFollowUp.ts:557-560`

Each day of being overdue generates a **new** reminder because the key includes `daysOverdue`:

```typescript
const followUpKey = `overdue-${task.id}-${daysOverdue}`;  // Different key each day
```

**Example timeline for a 5-day overdue task:**
- Day 1: "Task is overdue" (regular)
- Day 2: "2 days overdue" + Edward CC (escalation)
- Day 3: "3 days overdue" + Edward CC
- Day 4: "4 days overdue" + Edward CC
- Day 5: "5 days overdue" + Edward CC

**This is likely by design** but may feel excessive to users.

---

## Overlap Analysis

A single overdue task can trigger **multiple notification systems**:

| Time | Source | Notification |
|------|--------|--------------|
| 8 AM | After-hours scheduler | Release ping (if created after hours) |
| 10 AM | Auto follow-up | Due-today reminder |
| 11 AM | After-hours scheduler | Ack reminder (if not acknowledged) |
| Hourly | Auto follow-up | Overdue reminder |
| +20 min | Issue call tracker | Issue call ping (if issue call type) |

**Worst case:** An unacknowledged, overdue issue call created after hours could generate **5+ notifications in a single morning**.

---

## Recommended Fixes

### 🔴 Priority 1: Persist Follow-Up Deduplication State

**File:** `autoFollowUp.ts`

Replace in-memory Map with disk persistence (similar to issue call tracker):

```typescript
// Replace lines 84-94 with disk-persisted state
const FOLLOWUP_STATE_FILE = path.join(process.cwd(), '.followup-state.json');

function loadFollowUpState(): Map<string, number> {
  try {
    if (fs.existsSync(FOLLOWUP_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(FOLLOWUP_STATE_FILE, 'utf-8'));
      return new Map(Object.entries(data));
    }
  } catch (e) {
    console.error('Failed to load follow-up state:', e);
  }
  return new Map();
}

function saveFollowUpState(state: Map<string, number>): void {
  try {
    const data: Record<string, number> = {};
    for (const [key, value] of state.entries()) {
      data[key] = value;
    }
    fs.writeFileSync(FOLLOWUP_STATE_FILE, JSON.stringify(data));
  } catch (e) {
    console.error('Failed to save follow-up state:', e);
  }
}
```

**Effort:** 30 minutes
**Impact:** Eliminates duplicate reminders after restart

### 🔴 Priority 2: Add Max Ping Limit for Issue Calls

**File:** `issueCallTracker.ts`

Add a maximum ping count to prevent infinite pings:

```typescript
// Add constant at top
const MAX_PING_COUNT = 6;  // 2 hours of pings (20 min x 6)

// In pingUnclaimedIssueCalls(), add check:
for (const [threadTs, issueCall] of pendingIssueCalls.entries()) {
  if (issueCall.claimed) continue;
  
  // Stop pinging after max attempts
  if (issueCall.pingCount >= MAX_PING_COUNT) {
    console.log(`[IssueCallTracker] Max pings reached for ${threadTs}, stopping`);
    continue;
  }
  
  // ... rest of function
}
```

**Effort:** 15 minutes
**Impact:** Caps issue call pings at 6 (2 hours)

### 🟡 Priority 3: Reduce Overdue Reminder Frequency

**File:** `autoFollowUp.ts`

Option A: Only send escalation reminder once per task (not daily):

```typescript
// Change line 559 from:
const followUpKey = `overdue-${task.id}-${daysOverdue}`;
// To:
const followUpKey = `overdue-${task.id}`;  // One reminder per task ever
```

Option B: Only escalate on specific days (day 2, day 5, day 10):

```typescript
const ESCALATION_DAYS = [2, 5, 10];
if (!ESCALATION_DAYS.includes(daysOverdue)) continue;
```

**Effort:** 10 minutes
**Impact:** Reduces daily "X days overdue" spam

### 🟡 Priority 4: Add Notification Dashboard

Create an endpoint to see pending notifications:

```typescript
// Add to server.ts
app.get('/debug/notifications', async (req, res) => {
  const followUpState = loadFollowUpState();
  const pendingIssueCalls = getAllPendingIssueCalls();
  const deferredNotifications = await findDeferredNotifications();
  
  res.json({
    followUpsSentToday: followUpState.size,
    pendingIssueCalls: pendingIssueCalls.length,
    deferredNotifications: deferredNotifications.length,
  });
});
```

**Effort:** 30 minutes
**Impact:** Visibility into notification volume

---

## Quick Wins (< 15 minutes each)

| Fix | File | Change |
|-----|------|--------|
| Add MAX_PING_COUNT | `issueCallTracker.ts` | Add `if (pingCount >= 6) continue` |
| Log notification counts | `autoFollowUp.ts` | Add `console.log(\`Sent ${count} follow-ups\`)` |
| Extend reminder cooldown | `constants.ts` | Change `REPEAT_REMINDER_COOLDOWN_MS` from 12h to 24h |

---

## Testing Checklist

After implementing fixes:

1. [ ] Deploy and immediately restart service - verify no duplicate notifications
2. [ ] Create issue call, wait 2+ hours unclaimed - verify pings stop at max
3. [ ] Create overdue task - verify escalation doesn't repeat daily
4. [ ] Check `/debug/notifications` endpoint for volume metrics

---

## Summary

| Problem | Severity | Fix Effort | User Impact |
|---------|----------|------------|-------------|
| In-memory dedup resets | 🔴 Critical | 30 min | High - duplicates after restart |
| Unlimited issue call pings | 🔴 Critical | 15 min | High - spam for unclaimed calls |
| Daily overdue escalation | 🟡 Medium | 10 min | Medium - annoying but correct |
| No notification visibility | 🟢 Low | 30 min | Low - ops inconvenience |

**Recommended action:** Implement Priority 1 and 2 fixes immediately. These address the most likely causes of the complaint.
