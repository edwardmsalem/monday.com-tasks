# Claude Code Session Notes

Last updated: 2025-12-23

## Project Overview

This is a task management integration system called **Salem Seats** that connects:
- **Slack** (slash commands, reactions, threads)
- **Monday.com** (task board)
- **Gmail** (email forwarding)
- **Google Sheets** (account lookups)

## Recent Work Completed

### Issue Call Workflow Enhancements

The `/issuecall` command was significantly enhanced:

1. **Account Lookup from Google Sheets**
   - Looks up account info by team + email
   - Returns: Name, Phone, Seats (all locations), Address, Card Info (Last 4, Exp, CVC)
   - Sport-specific spreadsheet IDs configured via env vars

2. **@mention Suggested Supporter**
   - Syntax: `/issuecall [team] [email] [@supporter]`
   - If @mentioned, that person gets pinged first
   - Ping escalation:
     - 1st ping (20 min): @suggested_supporter only
     - 2nd+ ping (every 20 min): @dayna @ruzzell
     - After 1 hour: add @edward

3. **Claiming via Reaction/Reply**
   - First person to 👀 or reply gets assigned as Supporter on Monday
   - Posts confirmation to thread

4. **Completion via ✅ Reaction**
   - React with ✅ to mark issue call complete
   - Updates Monday status
   - Posts completion confirmation

5. **Due Date Logic**
   - Default: Today
   - If after 4 PM EST: Tomorrow

6. **Owners**
   - All issue calls owned by: Dayna + Ruzzell Garcia

7. **Reminders**
   - Due today reminders at 10 AM (sent to issue call channel)
   - Overdue reminders daily (escalates to Edward on day 2+)
   - Business hours only: M-F 10am-6pm ET

---

## System Architecture

### Slash Commands

| Command | Endpoint | Features |
|---------|----------|----------|
| `/task` | `/webhook/slack/task` | AI-powered natural language parsing |
| `/issuecall` | `/webhook/slack/issuecall` | Account lookup, claim tracking, escalation |
| `/emailtask` | `/webhook/slack/emailtask` | Gmail search, email-to-PDF |
| `/monday` | `/webhook/slack/command` | Multi-step AI with follow-up questions |
| `/seasontask` | `/webhook/slack/seasontask` | Channel-restricted task creation |

### Key Services

| Service | File | Purpose |
|---------|------|---------|
| Issue Call Tracker | `src/services/issueCallTracker.ts` | Tracks pending issue calls, claiming, pings |
| Auto Follow-Up | `src/services/autoFollowUp.ts` | Reminders (ack, due today, overdue) |
| Sheets | `src/services/sheets.ts` | Google Sheets account lookup |
| Sync | `src/services/sync.ts` | Slack ↔ Monday two-way sync |
| Slack | `src/services/slack.ts` | Slack API operations |
| Monday | `src/services/monday.ts` | Monday.com API operations |

### Event Handling

| Route | File | Purpose |
|-------|------|---------|
| Relay Events | `src/routes/relayEvents.ts` | Slack events via relay hub (reactions, replies) |
| Monday Webhook | `src/routes/mondayWebhook.ts` | Monday update → Slack sync |
| Email Webhook | `src/routes/emailWebhook.ts` | Email forwarding → task creation |

---

## Feature Matrix

### What works system-wide (all workflows):
- Slack → Monday thread sync (replies become Monday updates)
- Monday → Slack sync (Monday updates post to Slack thread)
- 👀 reaction = Acknowledged
- ✅ reaction = Complete
- Acknowledgment reminders (4h after creation)
- Due today reminders (10 AM)
- Overdue reminders (daily, escalates day 2+)
- Quiet hours / after-hours deferral

### Email-only features (not in other workflows):
- PDF archiving
- Google Calendar event creation
- Google Sheets recipient tracking
- Todoist projection
- `/scan` keyword for appointment extraction

---

## Configuration

### Environment Variables (Key Ones)

```
# Slack
SLACK_CHANNEL_ID - Main notification channel
SLACK_ISSUE_CALL_CHANNEL_ID - Issue call channel
SLACK_BOT_TOKEN
SLACK_SIGNING_SECRET

# Monday
MONDAY_API_TOKEN
MONDAY_BOARD_ID

# Google Sheets (Sport-specific)
SHEETS_ASTROS_ID
SHEETS_ROCKETS_ID
SHEETS_TEXANS_ID
(etc.)

# Relay
RELAY_API_KEY
```

### Monday Columns

```typescript
columns: {
  owner: 'person',
  support: 'multiple_person_mky0vdq1',
  type: 'status',  // "Issue Call", "General", etc.
  workflowStatus: 'color_mkxvxxxn',
  urgency: 'color_mkytzsrj',
  date: 'date4',
  slackThreadId: 'text_mkxxn3hz',
  team: 'dropdown_mkyqe4we',
  // ... more
}
```

---

## Important IDs

- **Edward's Slack ID**: `U0144K906KA` (for escalation)
- **@closers Group ID**: `S07QVQVMQMB`

---

## Files Modified in This Session

1. `src/services/issueCallTracker.ts`
   - Added `suggestedSupporterSlackId` field
   - Added `pingCount` tracking
   - Added `completeIssueCall()`, `isIssueCall()`, `getIssueCall()`
   - Updated ping logic for tiered escalation

2. `src/services/autoFollowUp.ts`
   - Added `taskType` to TaskForFollowUp interface
   - Added `getChannelForTask()` helper
   - Reminders now route to correct channel by task type

3. `src/routes/relayEvents.ts`
   - Handle ✅ for issue calls via `completeIssueCall()`

4. `src/server.ts`
   - `/issuecall` parses optional @mention after email
   - Posts "Suggested Supporter" in message if provided

5. `docs/SLACK_BOT_USER_GUIDE.md`
   - Full user guide with all commands, reactions, automated messages
   - Updated with @mention supporter feature
   - Updated with ✅ completion for issue calls

---

## Pending/Future Considerations

The user mentioned these are NOT needed yet:
- Google Calendar integration for `/task`
- PDF generation for `/task`
- Google Sheets recipient tracking for non-email workflows

These could be added later for consistency across all workflows.

---

## Git Branch

Currently on: `claude/read-claude-context-1NJNB`
Main branch: `monday-workflow`

All changes have been committed and pushed.
