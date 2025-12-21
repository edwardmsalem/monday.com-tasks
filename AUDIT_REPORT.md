# FULL CODEBASE AUDIT REPORT

**Generated**: 2025-12-21
**Branch**: claude/audit-intake-router-Ja3BE

---

## DELIVERABLE 1: CURRENT STATE MAP

---

### 1) END-TO-END FLOWS

#### A. EMAIL INTAKE FLOW

**Entry Points:**
| Route | File:Line | Handler |
|-------|-----------|---------|
| `POST /webhook/email` | `src/server.ts:53-130` | Main email webhook (multipart) |
| `POST /webhook/json` | `src/server.ts:136-188` | JSON format for testing |
| `POST /webhook/make` | `src/server.ts:200-337` | Make.com with raw EML |
| `POST /webhook/make/parsed` | `src/server.ts:352-518` | Make.com with pre-converted PDF |

**Call Graph (email -> Monday + Slack):**
```
/webhook/* -> parseIncomingEmail() [emailParser.ts:19-42]
          -> executeWorkflow() [workflow.ts:40-224]
            -> findEmlAttachment() [emailParser.ts:77-89]
            -> parseEmlAttachment() [emailParser.ts:44-75]
            -> analyzeEmailSafe() [claude.ts:258-298]
            -> findUserByName() [userResolver.ts:107-166]
            -> convertEmlToPdf() [convertApi.ts:26-103]
            -> monday.createItem() [monday.ts:58-102]
            -> monday.createUpdate() [monday.ts:301-316]
            -> [optional /scan] findRelatedRecipients() [gmail.ts:99-202]
            -> [optional /scan] createSubitems() [monday.ts:399-413]
            -> slack.sendNotification() [slack.ts:66-201]
            -> monday.uploadFileToItem() [monday.ts:133-169]
            -> slack.uploadFileToThread() [slack.ts:206-221]
            -> monday.updateSlackThreadId() [monday.ts:107-127]
```

**Data Contracts:**
- **Input**: `ParsedEmail` (subject, text, fromEmail, toEmail, attachments) -> `types/index.ts:6-12`
- **Claude Output**: `AnalysisResult` (owner, dueDate, taskType, priority, notes, confidence, meeting, team) -> `claude.ts:154-159`
- **Monday Output**: `MondayItem` (id, name) -> `types/index.ts:39-42`
- **Slack Output**: `SlackMessage` (ts, channel) -> `types/index.ts:50-53`

**What Gets Written Where:**
| Location | Data Written | Code Reference |
|----------|--------------|----------------|
| Monday columns | date, owner, type, source, team, from, to | `monday.ts:62-80` |
| Monday file column | PDF file | `monday.ts:133-169` |
| Monday updates | Notes (if present) | `monday.ts:301-316` |
| Monday slackThreadId | Thread timestamp | `monday.ts:107-127` |
| Slack channel | Block Kit notification with @ mention | `slack.ts:66-201` |
| Slack thread | PDF attachment | `slack.ts:206-221` |

---

#### B. /TASK FLOW (`/monday` command)

**Entry Point**: `POST /webhook/slack/command` -> `src/server.ts:714-783`

**Call Graph:**
```
/webhook/slack/command
  -> sync.startSmartTaskCreation() [sync.ts:394-462]
    -> parseTaskWithAI() [taskParser.ts:55-206]
    -> storePendingTask() [conversationState.ts:33-51]
    -> generateQuestionBlocks() or generateConfirmationBlocks()

[If follow-up needed:]
  -> sync.continueSmartTaskCreation() [sync.ts:467-548]

[On confirm button click:]
  -> /webhook/slack/interactive [server.ts:800-836]
    -> sync.confirmSmartTask() [sync.ts:553-616]
      -> monday.createItem() [monday.ts:58-102]
```

**Data Contracts:**
- **Input**: Slack form fields (text, user_id, channel_id)
- **State**: `PendingTask` (parsed, missing, awaitingFields) -> `conversationState.ts:10-18`
- **Output**: Monday item created, ephemeral Slack confirmation

---

#### C. /EMAILTASK FLOW

**STATUS: DOES NOT EXIST**

Grep search confirms no `/emailtask` command exists in the codebase. There is only:
- `/monday` -> general task creation (`server.ts:714-783`)
- `/seasontask` -> restricted to specific channels (`server.ts:621-702`)

---

#### D. AFTER-HOURS SCHEDULER FLOW

**Entry Point**: `startFollowUpScheduler()` -> `src/services/autoFollowUp.ts:451-459`
**Triggered**: At server startup (`server.ts:945`)

**Call Graph:**
```
startFollowUpScheduler()
  -> checkAndSendFollowUps() runs immediately and every hour [autoFollowUp.ts:114-171]
    -> isBusinessHours() [autoFollowUp.ts:54-79]
    -> getOpenTasks() [autoFollowUp.ts:240-332]
    -> sendAcknowledgeReminder() [autoFollowUp.ts:391-406] (if no eyes after 4h)
    -> sendOverdueReminder() [autoFollowUp.ts:414-434] (if past due)
    -> slack.postToThread() [slack.ts:350-374]
```

**State Machine:**
| Condition | Action | Code Reference |
|-----------|--------|----------------|
| No status + 4h old | Send eyes reminder | `autoFollowUp.ts:147-149` |
| Past due + not complete | Send checkmark reminder | `autoFollowUp.ts:153-161` |
| 2+ days overdue | Escalation (cc manager) | `autoFollowUp.ts:425-427` |

**Anti-spam**: 12-hour cooldown per reminder type per task via `sentFollowUps` Map (`autoFollowUp.ts:82,436-445`)

---

#### E. SLACK REACTIONS FLOW (eyes + checkmark)

**Entry Point**: `POST /webhook/slack/events` -> `src/server.ts:547-602`

**Call Graph:**
```
Slack event (reaction_added)
  -> event.reaction === 'eyes'
    -> sync.markAcknowledgedFromSlack() [sync.ts:150-160]
      -> monday.findItemBySlackThread() [monday.ts:241-270]
      -> monday.updateWorkflowStatus(itemId, 'Acknowledged') [monday.ts:322-342]

  -> event.reaction === 'white_check_mark' (or heavy_check_mark, ballot_box_with_check)
    -> sync.markCompleteFromSlack() [sync.ts:165-175]
      -> monday.updateWorkflowStatus(itemId, 'Complete')

Slack event (reaction_removed - checkmark only)
  -> sync.unmarkCompleteFromSlack() [sync.ts:180-190]
    -> monday.updateWorkflowStatus(itemId, 'Working on it')
```

**How eyes Stops Reminders:**
- `markAcknowledgedFromSlack()` sets workflow status to "Acknowledged"
- `checkAndSendFollowUps()` checks `task.workflowStatus` - if truthy, skips ack reminder (`autoFollowUp.ts:147`)

**How checkmark Stops Reminders:**
- Status set to "Complete"
- Loop skips tasks with status "complete/done/completed/closed" (`autoFollowUp.ts:133-135`)

---

### 2) OWNER + SUPPORT RULES AS IMPLEMENTED

**Owner Determination:**
- **Email flow**: Claude AI extracts ONE owner from email body -> `claude.ts:98-101`
- **Slash command flow**: Parsed from natural language or "me" resolves to command user -> `taskParser.ts:163-170`
- **Resolution**: `findUserByName()` -> `userResolver.ts:107-166`
  - Priority: exact full name -> exact first name -> Slack username -> partial match (shorter preferred)

**Support Column:**
- **Column defined**: `config.monday.columns.support = 'multiple_person_mky0vdq1'` -> `environment.ts:48`
- **NEVER WRITTEN**: No code writes to the support column. Claude only extracts `owner`, not support.
- **No @mention parsing for support** - All @mentions go to owner field

**Who Gets Pinged:**
- **Email flow**: Owner gets @ mentioned in Slack notification -> `slack.ts:88-91`
- **Slash command**: Owner mentioned in confirmation message -> `sync.ts:605`
- **Reminders**: All task owners get @ mentioned -> `autoFollowUp.ts:337-349,398-399`
- **Escalation (day 2+ overdue)**: Owner + hardcoded manager `U0144K906KA` -> `autoFollowUp.ts:372-381`

**Working Hours vs After-Hours:**
- **Task creation**: NO difference - always @ mentions owner immediately
- **Reminders**: Only sent during business hours (10am-6pm ET M-F) -> `autoFollowUp.ts:54-79`

---

### 3) AFTER-HOURS BEHAVIOR AS IMPLEMENTED

**What "After-Hours" Means:**
- Hours: Before 10:00 AM or after 6:00 PM Eastern
- Days: Saturday (day 6) and Sunday (day 0)
- Holidays: US federal holidays 2024-2025 hardcoded -> `autoFollowUp.ts:17-48`
- Logic: `isBusinessHours()` -> `autoFollowUp.ts:54-79`

**What Happens When Task Created After-Hours:**
- **NOTHING SPECIAL** - Task created normally with full @ mentions
- No quiet mode, no deferred posting, no "next business day" ack expectations
- The only after-hours logic is reminders are skipped

**What Happens at Release Time:**
- **NO RELEASE TIME CONCEPT** - There's no pending/release queue
- Tasks post immediately regardless of time

**What Happens at Reminder Time:**
- If `isBusinessHours()` returns false, `checkAndSendFollowUps()` exits early -> `autoFollowUp.ts:118-120`
- Returns `{ sent: 0, skipped: 'outside_business_hours' }`

**Reminder Gating Logic:**
| Check | Skip Condition | Code |
|-------|----------------|------|
| Status | complete/done/completed/closed | `autoFollowUp.ts:133-135` |
| Slack thread | Missing | `autoFollowUp.ts:138` |
| Owners | None assigned | `autoFollowUp.ts:141` |
| eyes ack reminder | `task.workflowStatus` is truthy | `autoFollowUp.ts:147` |
| checkmark overdue | daysOverdue <= 0 | `autoFollowUp.ts:158` |
| Anti-spam | Same reminder type sent within 12h | `autoFollowUp.ts:436-441` |

---

### 4) RELOCATION BEHAVIOR AS IMPLEMENTED

**Detection Rules:**
- **Keyword-based only** - checks subject for: `presale`, `pre-sale`, `relocation`, `selection` -> `sheets.ts:166-168`
- **No automatic relocation detection** from email content analysis
- **Triggered by `/scan` command** in email body -> `gmail.ts:318-320`

**Subitems Created:**
- Format: `email@domain.com - Date, Time` (or just email if no appointment)
- Created via `createSubitems()` -> `monday.ts:399-413`
- Each recipient from Gmail search becomes a subitem -> `workflow.ts:128-129`
- **NO checklist subitems** like "accounts checked", "board setup", "logins confirmed by 10am", "card active"

**Timing Requirements:**
- **NONE ENFORCED** - No "10:00 AM ET day-of" logic exists
- Appointment times are extracted and displayed as labels only -> `gmail.ts:325-336`

**Idempotency:**
- **NONE** - No duplicate detection for subitem creation
- Running `/scan` twice creates duplicate subitems
- No uniqueness check by email address

**Owner Resolution from Pinned YAML:**
- **DOES NOT EXIST** - No pinned YAML config anywhere
- No control channel C0A4TMWDZJA referenced
- Owner comes only from Claude AI analysis or slash command input

---

### 5) CONFIG MODEL AND CHANNELS

**All Environment Variables (from `environment.ts` + `.env.example`):**

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `PORT` | No | 3000 | Server port |
| `MONDAY_API_TOKEN` | **Yes** | '' | Monday.com auth |
| `MONDAY_BOARD_ID` | No | '18383923820' | Target board |
| `MONDAY_FILE_COLUMN_ID` | No | 'file_mkxv6aa0' | File column |
| `MONDAY_SLACK_THREAD_COLUMN_ID` | No | 'text_mkxxn3hz' | Thread ID storage |
| `MONDAY_BOARD_URL` | No | salemseats URL | For links |
| `SLACK_BOT_TOKEN` | **Yes** | '' | Slack auth |
| `SLACK_CHANNEL_ID` | No | 'C08QCFC4Y0H' | Notification channel |
| `SLACK_SIGNING_SECRET` | No | undefined | Signature verification |
| `CONVERTAPI_SECRET` | **Yes** | '' | PDF conversion |
| `ANTHROPIC_API_KEY` | **Yes** | '' | Claude AI |
| `GOOGLE_CALENDAR_ENABLED` | No | 'false' | Enable calendar |
| `GOOGLE_CALENDAR_ID` | No | 'primary' | Calendar target |
| `GOOGLE_CALENDAR_TIMEZONE` | No | 'America/New_York' | Timezone |
| `GOOGLE_FORWARDING_EMAIL` | No | 'forwarding@salemseats.com' | Gmail filter |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | No | undefined | Service auth |
| `GOOGLE_CLIENT_ID` | No | undefined | OAuth |
| `GOOGLE_CLIENT_SECRET` | No | undefined | OAuth |
| `GOOGLE_REFRESH_TOKEN` | No | undefined | OAuth |

**Startup Validation** (`validateConfig()` -> `environment.ts:97-109`):
- Warns but doesn't crash if missing: `MONDAY_API_TOKEN`, `SLACK_BOT_TOKEN`, `CONVERTAPI_SECRET`, `ANTHROPIC_API_KEY`

**Slack Channel Usage:**
| Channel | Purpose | Config |
|---------|---------|--------|
| `C08QCFC4Y0H` (default) | Notification channel for all task threads | `SLACK_CHANNEL_ID` |
| `C06BSL06WJK`, `C08QCFC4Y0H` | Allowed channels for `/seasontask` | Hardcoded in `server.ts:609` |

**CONTROL CHANNEL FOR PINNED YAML:**
- **DOES NOT EXIST** - No C0A4TMWDZJA reference in codebase
- No pinned config parsing anywhere

---

## DELIVERABLE 2: FULL AUDIT

---

### A. SPEC ALIGNMENT AUDIT

#### 1) /emailtask Defaults

| Requirement | Status | Evidence |
|-------------|--------|----------|
| Match defaults to EQUALS | **N/A** | `/emailtask` does not exist |
| Contains only if explicitly requested | **N/A** | `/emailtask` does not exist |
| daysBack default is today only ET | **N/A** | `/emailtask` does not exist |
| Multiple matches must not auto-pick | **N/A** | `/emailtask` does not exist |
| Single match needs confirm step | **N/A** | `/emailtask` does not exist |

**VERDICT: FAIL (NOT IMPLEMENTED)** - `/emailtask` slash command is entirely missing from codebase.

---

#### 2) After-Hours Policy

| Requirement | Status | Evidence |
|-------------|--------|----------|
| After-hours posts silent vs quiet thread | **FAIL** | Tasks post with full @ mentions 24/7. No quiet mode. `slack.ts:88-91` |
| Ack expectations start next business day | **FAIL** | No business day logic for task creation. Reminders just skip outside hours. |

**What Code Actually Does:**
- Task creation: **Always @ mentions immediately** regardless of time
- Reminders: Skip entirely outside business hours (`autoFollowUp.ts:118-120`)
- No "posted after hours, ack starts tomorrow" logic exists

---

#### 3) Owner vs Support Policy

| Requirement | Status | Evidence |
|-------------|--------|----------|
| Plain @mentions are Support (not Owner) | **FAIL** | All @mentions become Owner. Support column never written. `claude.ts:98-101`, `monday.ts:62-67` |
| Only owner gets pinged | **PASS** | Only owner field used in Slack mentions `slack.ts:88-91` |
| Support never pinged | **PASS** (vacuously) | Support never set, so never pinged |
| Override list exists | **FAIL** | No override list. Owner comes only from Claude analysis or command input |

---

#### 4) Reminder Gating

| Requirement | Status | Evidence |
|-------------|--------|----------|
| 11 AM reminder only if NOT eyes AND NOT checkmark | **PARTIAL PASS** | Logic correct but timing is "every hour during business hours" not specifically 11 AM. `autoFollowUp.ts:147,133-135` |

**Details:**
- Ack reminder: Sent if `!task.workflowStatus && hoursSinceCreation >= 4` -> `autoFollowUp.ts:147`
- Overdue reminder: Sent if past due AND status not complete -> `autoFollowUp.ts:153-161`
- 12-hour cooldown prevents spam -> `autoFollowUp.ts:436-441`

---

### B. RELIABILITY + SAFETY AUDIT

#### Idempotency

| Area | Status | Risk | Location |
|------|--------|------|----------|
| Email -> Monday item | **NO** | Duplicate tasks if webhook retried | `workflow.ts:101-110` |
| Email -> Slack thread | **NO** | Duplicate threads possible | `workflow.ts:163-175` |
| Subitem creation | **NO** | `/scan` run twice = duplicate subitems | `monday.ts:399-413` |
| Reminder sending | **YES** | 12-hour cooldown per task+type | `autoFollowUp.ts:436-445` |
| Reaction handling | **YES** | Monday API is idempotent for status updates | `monday.ts:322-342` |

#### Race Conditions

| Area | Risk | Detail |
|------|------|--------|
| Automation detection delays | **LOW** | No automation detection logic exists |
| Marker scanning | **LOW** | Single scheduler, no concurrent access issues |
| Retry scheduling | **MEDIUM** | No retry queue - failures are lost |
| Slack->Monday sync | **MEDIUM** | Thread reply during processing could duplicate | `sync.ts:87-116` |

#### Failure Modes

| Scenario | Visibility | Code |
|----------|------------|------|
| Claude AI failure | Fallback to line-by-line parsing | `claude.ts:269-297` |
| Monday API failure | Exception propagates, logged, 500 returned | `monday.ts:27-35` |
| Monday file upload fail | Logged but non-fatal | `server.ts:488-494` |
| Slack API failure | Exception propagates | `slack.ts:192-195` |
| ConvertAPI failure | Workflow fails | `convertApi.ts` |
| Gmail search failure | Caught, logged, workflow continues | `workflow.ts:152-155` |
| Sheets creation failure | Caught, logged, workflow continues | `workflow.ts:145-147` |

**Missing**: No Monday update or Slack thread note on failures - failures are only in server logs.

#### Permission Boundaries

| Check | Status | Location |
|-------|--------|----------|
| Who can create tasks | **NONE** | Any email to webhook creates task |
| Who can override owner | **NONE** | No owner override mechanism |
| Slash command whitelist | **PARTIAL** | `/seasontask` restricted to 2 channels. `/monday` unrestricted. `server.ts:609,633-634` |
| Slack signature verification | **OPTIONAL** | `SLACK_SIGNING_SECRET` not required | `environment.ts:64` |

#### Data Leakage Risks

| Risk | Status | Detail |
|------|--------|--------|
| Email content in logs | **YES** | Subject, body previews logged throughout |
| BCC parsing | **N/A** | No BCC extraction occurs |
| Sensitive data exposure | **LOW** | PDF uploaded to Monday/Slack contains full email |

#### Loop/Duplication Prevention

| Path | Prevention | Code |
|------|------------|------|
| Slack->Monday->Slack | Prefix check `[From Monday` / `[From Slack` | `server.ts:569,898` |
| Monday->Slack->Monday | Prefix check | `sync.ts:113,142` |
| Duplicate reactions | Slack prevents double-adding, code catches error | `slack.ts:391-395` |

---

### C. CODE HYGIENE AUDIT

#### Hardcoded Human Names

| File:Line | Content | Severity |
|-----------|---------|----------|
| `autoFollowUp.ts:372` | `const ESCALATION_SLACK_ID = 'U0144K906KA'; // Edward Salem` | **HIGH** - hardcoded manager ID |
| `claude.ts:83` | `"Send this to Dayna for next Friday"` | **LOW** - example in prompt |
| `emailParser.ts:40` | `@dayna` in comment | **LOW** - example |
| `userResolver.ts:100-105` | `Elia Smith`, `Eliana` examples | **LOW** - documentation |
| `blueprint.json:1046` | Hardcoded user ID mapping: `dayna->52969342, ruzzell->60625739...` | **HIGH** - stale if staff changes |
| `blueprint.json:449,1204,1415,1504,1556,1629,1990` | `edward@salemseats.com`, `SalemSeats Ed Monday Connection` | **MEDIUM** - credential labels |

#### Stale Defaults

| File:Line | Default | Risk |
|-----------|---------|------|
| `environment.ts:38` | `boardId: '18383923820'` | Production board ID as default |
| `environment.ts:41` | `boardUrl: 'https://salemseats.monday.com/boards/18383923820'` | Production URL |
| `environment.ts:63` | `channelId: 'C08QCFC4Y0H'` | Production channel |
| `environment.ts:83` | `forwardingEmail: 'forwarding@salemseats.com'` | Production email |
| `server.ts:609` | `SEASONTASK_ALLOWED_CHANNELS = ['C06BSL06WJK', 'C08QCFC4Y0H']` | Hardcoded channel IDs |

#### Dead Code / Unused Files

| Item | Status | Location |
|------|--------|----------|
| `support` column | **DEAD** - Defined but never written | `environment.ts:48` |
| `setReminder()` | **UNUSED** - Comment says "requires user token" | `slack.ts:315-345` |
| `verifySlackSignature()` | **UNUSED** - Never called | `slack.ts:548-563` |
| `deleteRecentBotMessages()` | **UTILITY** - Debug/cleanup, not in main flow | `slack.ts:441-523` |
| `WorkflowInput` type | **STALE** - Different structure than actual usage | `types/index.ts:55-58` |
| `sendResponseUrl()` | **UNUSED** | `slack.ts:529-543` |
| `addBookmark()` | **UNUSED** | `slack.ts:243-260` |
| `calendar.ts` entire service | **CONDITIONALLY USED** - Only if `GOOGLE_CALENDAR_ENABLED=true` |

---

## DELIVERABLE 3: OPEN DECISIONS (PENDING)

These cannot be determined from repo alone:

1. **Notification Channel ID** - Currently defaults to `C08QCFC4Y0H`. Should this be required via env var?

2. **Control Channel for Pinned YAML** - C0A4TMWDZJA mentioned in spec but no implementation exists. Need:
   - Should there be owner override lists?
   - Should config be dynamic via pinned YAML?

3. **After-Hours Policy Decision**:
   - Option A: Silent mode (no Slack post until next business day)
   - Option B: Quiet posting (post without @ mention, add @ at 10am next business day)
   - Option C: Current behavior (always @ mention immediately)
   - Code to change: `slack.ts:88-91`, need new queue/scheduler

4. **/emailtask Command** - Does this need to be built? Spec mentions it but code doesn't have it.

5. **Support vs Owner Parsing**:
   - How should @mentions be distinguished? (e.g., first = owner, rest = support?)
   - Should Claude prompt be updated to extract both?
   - Code to change: `claude.ts:34-86`, `monday.ts:62-67`

6. **Relocation Checklist Subitems** - Spec mentions specific items:
   - "accounts checked"
   - "board setup"
   - "logins confirmed by 10am ET day-of"
   - "card active"
   - Currently only creates recipient-based subitems

7. **Owner Override List** - How should this be stored and applied?
   - Pinned YAML in control channel?
   - Environment variable?
   - Monday board column?

8. **Escalation Manager** - `U0144K906KA` (Edward Salem) is hardcoded. Should this be:
   - Environment variable?
   - Pinned YAML config?
   - Monday-based lookup?

9. **11 AM Reminder Timing** - Currently runs every hour during business hours. Should it be:
   - Exactly 11 AM ET only?
   - Current behavior (hourly with 12h cooldown)?

10. **Signature Verification** - `SLACK_SIGNING_SECRET` is optional. Should it be required for security?
