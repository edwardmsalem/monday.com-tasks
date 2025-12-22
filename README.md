# Forwarding Monday

An intelligent email-to-task automation system that creates Monday.com tasks from forwarded emails and Slack commands, powered by Claude AI.

## Overview

**forwarding-monday** automates task creation by:
- Accepting forwarded emails → Creates Monday.com tasks + Slack notifications
- Processing Slack slash commands (`/task`, `/emailtask`) for direct task creation
- Using Claude AI for natural language parsing (dates, priorities, owners)
- Syncing updates bidirectionally between Slack threads and Monday.com
- Implementing after-hours notification deferral (quiet hours)
- Providing robust error handling with retries and circuit breakers

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Environment Variables](#environment-variables)
3. [Slack Commands](#slack-commands)
4. [Email Webhooks](#email-webhooks)
5. [Monday.com Integration](#mondaycom-integration)
6. [Features](#features)
7. [Architecture](#architecture)
8. [Troubleshooting](#troubleshooting)

---

## Quick Start

### Prerequisites

- Node.js 18+
- Monday.com account with API token
- Slack workspace with bot token
- ConvertAPI account (for PDF conversion)
- Anthropic API key (for Claude AI)
- Gmail OAuth credentials (optional, for `/emailtask`)

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd forwarding-monday

# Install dependencies
npm install

# Build TypeScript
npm run build

# Start server
npm start
```

### Health Check

Once running, verify all services are connected:

```
GET https://your-domain.com/health
```

Returns:
```json
{
  "status": "healthy",
  "services": {
    "monday": { "ok": true, "latencyMs": 145 },
    "slack": { "ok": true, "latencyMs": 89 },
    "gmail": { "ok": true, "latencyMs": 234 },
    "convertApi": { "ok": true, "latencyMs": 156 }
  },
  "circuitBreakers": {
    "monday": "CLOSED",
    "slack": "CLOSED"
  },
  "jobQueue": { "pending": 0, "failed": 0 }
}
```

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `MONDAY_API_TOKEN` | Monday.com API token |
| `MONDAY_BOARD_ID` | Target board ID |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token |
| `SLACK_CHANNEL_ID` | Channel for task notifications |
| `CONVERTAPI_SECRET` | ConvertAPI key for PDF conversion |
| `ANTHROPIC_API_KEY` | Claude AI API key |

### Monday.com Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MONDAY_BOARD_URL` | - | Board URL for links |
| `MONDAY_FILE_COLUMN_ID` | `file_mkxv6aa0` | File attachment column |
| `MONDAY_SLACK_THREAD_COLUMN_ID` | `text_mkxxn3hz` | Slack thread ID column |

### Slack Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SLACK_SIGNING_SECRET` | - | Webhook signature verification |
| `SLACK_CONTROL_CHANNEL_ID` | `C0A4TMWDZJA` | Channel for pinned config |
| `SLACK_TASK_COMMAND_WHITELIST` | - | Comma-separated user IDs allowed to use `/task` |
| `SLACK_OWNER_OVERRIDE_USER_IDS` | - | Users who can assign tasks to others |
| `SLACK_SEASONTASK_ALLOWED_CHANNELS` | - | Channels where `/seasontask` works |

### Quiet Hours (After-Hours Notifications)

| Variable | Default | Description |
|----------|---------|-------------|
| `SLACK_QUIET_HOURS_ENABLED` | `true` | Enable/disable quiet hours |
| `SLACK_TIMEZONE` | `America/New_York` | Business timezone |
| `SLACK_WORKING_HOURS_START` | `8` | Start of working hours (8 AM) |
| `SLACK_WORKING_HOURS_END` | `20` | End of working hours (8 PM) |
| `SLACK_RELEASE_HOUR` | `8` | When to release deferred notifications |
| `SLACK_ACK_DEADLINE_HOUR` | `11` | Reminder deadline (11 AM) |
| `SLACK_ON_CALL_USER_ID` | - | On-call user for after-hours routing |

### Gmail Integration (Optional)

| Variable | Description |
|----------|-------------|
| `GOOGLE_CALENDAR_ENABLED` | Enable calendar event creation |
| `GOOGLE_CALENDAR_ID` | Calendar ID (default: `primary`) |
| `GOOGLE_CALENDAR_TIMEZONE` | Calendar timezone |
| `GOOGLE_FORWARDING_EMAIL` | Forwarding inbox email |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Base64-encoded service account JSON |
| `GOOGLE_CLIENT_ID` | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | OAuth refresh token |

### Safety Valves

| Variable | Default | Description |
|----------|---------|-------------|
| `DISABLE_EMAIL_AUTOMATION` | `false` | Log emails only, skip processing |
| `ATTACHMENTS_MODE` | `both` | `off`, `slack_only`, `monday_only`, `both` |

### Optional Integrations

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_TODOIST_SYNC` | `false` | Project tasks to Todoist |
| `TODOIST_API_TOKEN` | - | Todoist API token |

---

## Slack Commands

### `/task` - Create Task Directly

Create tasks from Slack with natural language.

**Single-line syntax:**
```
/task @john Fix the login bug due friday urgency high notes: customer reported twice
```

**Multi-line syntax:**
```
/task
@john
due friday
Fix the login bug
notes: customer reported twice
```

**Options:**
| Option | Examples | Description |
|--------|----------|-------------|
| `@mention` | `@john`, `@jane` | Task owner (required) |
| `due` | `fri`, `12/25`, `tomorrow`, `ASAP` | Due date |
| `urgency` | `high`, `medium`, `low` | Priority level |
| `type` | `refund`, `renewal`, `relo` | Task type |
| `notes:` | `notes: any text here` | Additional context |

**What happens:**
1. Creates Monday.com item with parsed fields
2. Posts to Slack channel with owner mention
3. Returns Monday URL + Slack thread URL + Run ID

---

### `/emailtask` - Create Task from Gmail

Search your Gmail inbox and create a task from an email.

**Search:**
```
/emailtask Knicks Presale 2025
/emailtask Yankees relocation from last week
```

**Select from results:**
```
/emailtask 1          # Select first result
/emailtask 2          # Select second result
/emailtask confirm    # Confirm single match
```

**Shortcuts:**
```
/emailtask Rangers email use most recent
```

**What happens:**
1. Claude AI parses your search query
2. Searches Gmail (default: today only, Eastern Time)
3. Shows up to 5 matching emails
4. You select one → PDF generated → Task created

---

### `/monday` - AI-Assisted Task Creation

Natural language task creation with follow-up questions.

```
/monday Fix the login bug
/monday Review contract for John by Friday
/monday urgent: deploy hotfix asap
```

Claude AI will ask follow-up questions if fields are missing.

---

### `/taskdebug` - Debug Task by ID

```
/taskdebug 1234567890
```

Returns task details: Monday link, Run ID, status, owner, due date, attachment state, etc.

---

## Email Webhooks

### Supported Endpoints

| Endpoint | Content-Type | Description |
|----------|--------------|-------------|
| `POST /webhook/email` | `message/rfc822`, `application/json`, `multipart/form-data` | Main email intake |
| `POST /webhook/json` | `application/json` | Direct JSON payload |
| `POST /webhook/make` | `multipart/form-data` | Make.com integration |
| `POST /webhook/make/parsed` | `application/json` | Pre-converted PDF from Make.com |

### Email Webhook Flow

```
1. Receive email (from Mailgun, SendGrid, Make.com, etc.)
2. Check idempotency (skip duplicates)
3. Extract EML attachment
4. Claude AI analyzes: owner, due date, type, priority, notes
5. Resolve user names → Monday/Slack IDs
6. Convert EML → PDF
7. Create Monday.com item
8. Post initial update with context
9. Apply intent modes (Relocation checklist, Presale scan)
10. Send Slack notification (respects quiet hours)
11. Upload PDF to Slack thread + Monday item
```

### JSON Payload Format

```json
{
  "subject": "Task: Fix login bug",
  "text": "Please handle ASAP\n\nNotes: Customer John Doe reported",
  "attachments": [
    {
      "filename": "original.eml",
      "content": "base64-encoded-eml-content"
    }
  ]
}
```

---

## Monday.com Integration

### Board Columns

The system uses these Monday.com columns:

| Column | Type | Description |
|--------|------|-------------|
| Name | text | Task title (normalized subject) |
| Owner | person | Primary assignee |
| Support | multiple_person | Support team members |
| Type | status | Task type (Refund, Renewal, etc.) |
| Workflow Status | status | State (New, Working, Complete) |
| Urgency | status | Priority (High, Medium, Low) |
| Date | date | Due date |
| Source | status | Origin (Forwarding Tasks, Slack) |
| Team | dropdown | Sports team (if applicable) |
| Run ID | text | 8-char UUID for tracing |
| Slack Thread ID | text | Link to Slack thread |
| Attachment State | status | Upload status |
| PDF URL | text | Durable URL for manual recovery |

### Updates/Comments Format

Context goes to Updates (not columns):

```
📝 Forwarding notes here

📧 From: sender@company.com

📬 To: recipient@domain.com

🔗 Run ID: a1b2c3d4
```

### Task Types

| Type | Aliases |
|------|---------|
| General | `general` |
| Payment Plan | `pp`, `payment plan` |
| Refund | `refund` |
| Decline | `decline` |
| Revoked | `revoked` |
| Renewal | `renewal` |
| Relocation | `relo`, `relocation` |
| Opportunity | `opp`, `opportunity` |
| Issue Call | `ic`, `issue call` |

---

## Features

### Idempotency (Duplicate Prevention)

Prevents duplicate tasks from webhook retries or double-clicks.

| Flow | Dedup Window | Key Based On |
|------|--------------|--------------|
| Email webhook | 5 minutes | subject + sender + timestamp |
| `/task` command | 1 minute | user + description |
| `/emailtask` | 1 hour | user + email ID |

### Circuit Breakers

Protects against cascading failures when external services are down.

| Service | Failure Threshold | Reset Time |
|---------|-------------------|------------|
| Monday.com | 5 failures | 60 seconds |
| Slack | 5 failures | 60 seconds |
| Gmail | 3 failures | 30 seconds |
| ConvertAPI | 3 failures | 30 seconds |
| Claude | 4 failures | 45 seconds |

### Job Queue (Retry Logic)

Failed operations are queued for retry with exponential backoff:

```
Attempt 1: Immediate
Attempt 2: 1 minute
Attempt 3: 5 minutes
Attempt 4: 15 minutes
Attempt 5: 1 hour (final)
```

Persisted to disk - survives server restarts.

### Quiet Hours

Tasks created after-hours (nights/weekends) defer @ mentions:
- Task created immediately (no blocking)
- Owner shown as italic text (no ping)
- At 8 AM next business day: owner pinged with original message
- At 11 AM: reminder if not acknowledged (no 👀 reaction)

### Intent Modes

**Relocation Mode:** Creates 4 checklist subitems:
1. Accounts Checked
2. Board Setup
3. Logins Confirmed (10:00 AM ET day-of)
4. Card Active

**Presale Mode:** Enables `/scan` to find all recipients with appointment times.

### Slack ↔ Monday Sync

- Slack thread replies → Monday updates
- Monday updates → Slack thread replies
- 👀 reaction → Marks acknowledged
- ✅ reaction → Marks complete

---

## Architecture

### Data Persistence

Files created in `./data/`:

| File | Purpose | TTL |
|------|---------|-----|
| `idempotency-keys.json` | Duplicate prevention | 1 hour |
| `job-queue.json` | Retry jobs | Until processed |
| `pending-state.json` | Smart task conversations | 10 minutes |
| `scheduler-state.json` | Release/reminder times | Permanent |
| `slack-config-cache.json` | User mappings | 5 minutes |

### Request Flow

```
Request → Request Logger → Route Handler → Idempotency Check
    → Claude AI Analysis → User Resolution → Monday.com API
    → Slack API → PDF Upload → Response
```

### Health Check

```
GET /health?refresh=true
```

- **healthy**: All core services (Monday + Slack) operational
- **degraded**: Core services OK, non-core (Gmail, ConvertAPI) failing
- **unhealthy**: Core services down

---

## Troubleshooting

### Build Fails on Railway

Create `railpack.json`:
```json
{
  "secrets": [],
  "steps": {
    "build": {
      "commands": ["npm run build"],
      "secrets": []
    }
  },
  "deploy": {
    "startCommand": "npm start"
  }
}
```

### "Circuit Open" Errors

Service has too many failures. Wait for reset timeout or check service status.

### Duplicate Tasks

Check idempotency keys in `./data/idempotency-keys.json`. Clear file to reset.

### PDF Upload Failures

1. Check `ATTACHMENTS_MODE` env var
2. Check ConvertAPI quota
3. Check job queue: `./data/job-queue.json`
4. Use durable URL from Monday item's PDF URL column

### Missing Slack Notifications

1. Check `SLACK_CHANNEL_ID` is correct
2. Verify bot is in channel
3. Check quiet hours settings
4. Check circuit breaker state in `/health`

### User Not Found

Add user to the Owners map in your Slack control channel's pinned config.

---

## API Reference

### Health Check
```
GET /health
GET /health?refresh=true
```

### Email Webhooks
```
POST /webhook/email
POST /webhook/json
POST /webhook/make
POST /webhook/make/parsed
```

### Slack Webhooks
```
POST /webhook/slack/events
POST /webhook/slack/interactive
```

### Monday Webhook
```
POST /webhook/monday
```

---

## License

MIT
