# Email Forwarding Task System - Complete Technical Documentation

**Version:** 1.0.0
**Last Updated:** December 2024

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture](#2-architecture)
3. [Installation & Configuration](#3-installation--configuration)
4. [Email Forwarding Workflow](#4-email-forwarding-workflow)
5. [Slack Integration](#5-slack-integration)
6. [Monday.com Integration](#6-mondaycom-integration)
7. [Google Services Integration](#7-google-services-integration)
8. [Claude AI Integration](#8-claude-ai-integration)
9. [Two-Way Sync System](#9-two-way-sync-system)
10. [Auto Follow-Up Reminders](#10-auto-follow-up-reminders)
11. [Slash Commands](#11-slash-commands)
12. [Special Features](#12-special-features)
13. [API Reference](#13-api-reference)
14. [Data Types & Interfaces](#14-data-types--interfaces)
15. [User Guide](#15-user-guide)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. System Overview

### What This System Does

This system automates task creation from forwarded emails. It replaces a Make.com workflow with a TypeScript-based solution that provides:

- **Intelligent Email Parsing**: Uses Claude AI to understand natural language emails
- **Automatic Task Creation**: Creates Monday.com items with all relevant fields
- **Slack Notifications**: Posts rich notifications with Block Kit formatting
- **PDF Generation**: Converts .eml attachments to PDF for reference
- **Two-Way Sync**: Syncs messages and status between Slack and Monday.com
- **Smart Reminders**: Action-oriented follow-ups for unacknowledged/overdue tasks
- **Batch Processing**: `/scan` command for presale/relocation emails with Google Sheets
- **Calendar Integration**: Creates Google Calendar events for task due dates
- **AI-Powered Slash Commands**: Natural language task creation from Slack

### Core Technologies

| Technology | Purpose |
|------------|---------|
| TypeScript | Core language |
| Express.js | HTTP server for webhooks |
| Claude AI (Anthropic) | Natural language processing |
| Monday.com GraphQL API | Task management |
| Slack Web API | Notifications and commands |
| Gmail API | Email search for `/scan` |
| Google Sheets API | Recipient tracking spreadsheets |
| Google Calendar API | Calendar events |
| ConvertAPI | EML to PDF conversion |
| mailparser | Email parsing |

---

## 2. Architecture

### File Structure

```
src/
├── server.ts                 # Express server with all webhook endpoints
├── workflow.ts               # Main workflow orchestration
├── config/
│   ├── environment.ts        # Environment variable configuration
│   └── taskTypes.ts          # Task type definitions and aliases
├── services/
│   ├── emailParser.ts        # Email and EML parsing
│   ├── claude.ts             # Claude AI email analysis
│   ├── monday.ts             # Monday.com GraphQL operations
│   ├── slack.ts              # Slack Web API operations
│   ├── gmail.ts              # Gmail search and appointment extraction
│   ├── sheets.ts             # Google Sheets creation
│   ├── calendar.ts           # Google Calendar events
│   ├── convertApi.ts         # EML to PDF conversion
│   ├── userResolver.ts       # Dynamic user lookup (Monday + Slack)
│   ├── sync.ts               # Two-way sync between platforms
│   ├── autoFollowUp.ts       # Automatic reminder system
│   ├── taskParser.ts         # AI-powered slash command parsing
│   └── conversationState.ts  # Multi-turn conversation state
├── types/
│   └── index.ts              # TypeScript interfaces
└── utils/
    └── dateParser.ts         # Date parsing utilities
```

### Request Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        EMAIL FORWARDING FLOW                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. Email arrives → /webhook/email                                   │
│          ↓                                                          │
│  2. Parse email + extract .eml attachment                           │
│          ↓                                                          │
│  3. Parse EML headers + body                                        │
│          ↓                                                          │
│  4. Claude AI analyzes email → extracts task details                │
│          ↓                                                          │
│  5. Resolve assignee (Monday + Slack user matching)                 │
│          ↓                                                          │
│  6. Convert EML to PDF                                              │
│          ↓                                                          │
│  7. Create Monday.com item                                          │
│          ↓                                                          │
│  8. [If /scan] Search Gmail → Create subtasks + Google Sheet        │
│          ↓                                                          │
│  9. Send Slack notification with Block Kit                          │
│          ↓                                                          │
│  10. Upload PDF to Monday + Slack                                   │
│          ↓                                                          │
│  11. Create Google Calendar event (if enabled)                      │
│          ↓                                                          │
│  12. Set Slack reminder for assignee                                │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Installation & Configuration

### Prerequisites

- Node.js 18+
- npm or yarn
- Monday.com account with API access
- Slack workspace with bot permissions
- Anthropic API key
- ConvertAPI account
- Google Cloud project (for Gmail, Sheets, Calendar)

### Environment Variables

Create a `.env` file with the following:

```bash
# Server
PORT=3000

# Monday.com
MONDAY_API_TOKEN=your_monday_api_token
MONDAY_BOARD_ID=18383923820
MONDAY_BOARD_URL=https://yourworkspace.monday.com/boards/18383923820
MONDAY_FILE_COLUMN_ID=file_mkxv6aa0
MONDAY_SLACK_THREAD_COLUMN_ID=text_mkxxn3hz

# Slack
SLACK_BOT_TOKEN=xoxb-your-slack-bot-token
SLACK_CHANNEL_ID=C08QCFC4Y0H
SLACK_SIGNING_SECRET=your_signing_secret

# Anthropic (Claude AI)
ANTHROPIC_API_KEY=sk-ant-your-anthropic-key

# ConvertAPI
CONVERTAPI_SECRET=your_convertapi_secret

# Google (Optional - for Calendar, Gmail, Sheets)
GOOGLE_CALENDAR_ENABLED=true
GOOGLE_CALENDAR_ID=primary
GOOGLE_CALENDAR_TIMEZONE=America/New_York
GOOGLE_FORWARDING_EMAIL=forwarding@yourcompany.com
GOOGLE_SERVICE_ACCOUNT_KEY={"type":"service_account",...}

# OR OAuth (alternative to service account)
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REFRESH_TOKEN=your_refresh_token
```

### Monday.com Column Configuration

The system expects these column IDs on your Monday.com board:

| Column | Column ID | Type | Purpose |
|--------|-----------|------|---------|
| Due Date | `date4` | Date | Task due date |
| Owner | `person` | Person | Task assignee |
| Support | `multiple_person_mky0vdq1` | Multi-Person | Additional assignees |
| From Email | `email_mkxvy5nq` | Email | Original sender |
| To Email | `email_mkxv1hyd` | Email | Original recipient |
| Notes | `long_text_mkxv1vhb` | Long Text | Task notes |
| Type | `status` | Status | Task type (General, Refund, etc.) |
| Workflow Status | `color_mkxvxxxn` | Status | Acknowledged/Working/Complete |
| Source | `color_mky0b1yr` | Status | Forwarding Tasks/Slack Tasks |
| Team | `dropdown_mkyqe4we` | Dropdown | Sports team |
| Slack Thread ID | `text_mkxxn3hz` | Text | Links to Slack thread |
| File | `file_mkxv6aa0` | File | PDF attachment |

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd forwarding-monday

# Install dependencies
npm install

# Build TypeScript
npm run build

# Start the server
npm start

# Or run in development mode
npm run dev
```

### Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.32.0",
    "@slack/web-api": "^7.0.0",
    "convertapi": "^1.14.0",
    "express": "^4.18.2",
    "form-data": "^4.0.0",
    "googleapis": "^144.0.0",
    "mailparser": "^3.6.6",
    "multer": "^1.4.5-lts.1"
  }
}
```

---

## 4. Email Forwarding Workflow

### Main Workflow (`workflow.ts`)

The `executeWorkflow` function orchestrates the entire process:

```typescript
export async function executeWorkflow(input: WorkflowInput): Promise<WorkflowResult> {
  // 1. Find EML attachment
  // 2. Parse EML headers + body
  // 3. Claude AI analysis
  // 4. Resolve task type
  // 5. Parse due date
  // 6. Resolve user (Monday + Slack)
  // 7. Convert EML to PDF
  // 8. Create Monday.com item
  // 8.5. Handle /scan command (if present)
  // 9. Resolve Slack mention
  // 10. Send Slack notification
  // 11. Upload PDF to both services
  // 11.5. Post Google Sheet link (if created)
  // 12. Update Monday with Slack thread ID
  // 13. Create Google Calendar event
  // 14. Set Slack reminder
}
```

### Email Parsing (`emailParser.ts`)

**Functions:**

| Function | Purpose |
|----------|---------|
| `parseIncomingEmail(raw)` | Parses the forwarding email (with .eml attachment) |
| `parseEmlAttachment(content)` | Parses the .eml attachment headers AND body |
| `parseTaskDetails(text)` | Legacy line-by-line parsing (fallback) |
| `findEmlAttachment(attachments)` | Finds .eml file in attachments |
| `extractEmail(text)` | Extracts email address from various formats |

**Parsed Email Structure:**

```typescript
interface ParsedEmail {
  subject: string;
  text: string;           // Body of forwarding email (with instructions)
  fromEmail: string | null;
  toEmail: string | null;
  attachments: EmailAttachment[];
}

interface EmlHeaders {
  subject: string | null;
  from: string | null;
  to: string | null;
  body: string | null;    // Actual content of the forwarded email
}
```

### PDF Conversion (`convertApi.ts`)

Converts .eml files to PDF using ConvertAPI:

```typescript
export async function convertEmlToPdf(
  emlContent: Buffer,
  filename: string
): Promise<ConvertedFile>
```

**PDF Settings:**
- Page Size: A4
- Margins: 5mm all sides
- Orientation: Portrait

---

## 5. Slack Integration

### Slack Service (`slack.ts`)

**Main Functions:**

| Function | Purpose |
|----------|---------|
| `sendNotification(input)` | Sends Block Kit formatted task notification |
| `uploadFileToThread(ts, filename, data)` | Uploads PDF to thread |
| `postToThread(ts, text)` | Posts a message to existing thread |
| `addReaction(ts, emoji)` | Adds emoji reaction to message |
| `removeReaction(ts, emoji)` | Removes emoji reaction |
| `setReminder(input)` | Sets a Slack reminder for user |
| `getAllUsers()` | Fetches all workspace users |
| `findUserByEmail(email)` | Looks up user by email |
| `postEphemeral(channel, user, text)` | Posts ephemeral message |

### Notification Format (Block Kit)

```
┌────────────────────────────────────────────┐
│ 📧 New [Task Type] Email                   │
├────────────────────────────────────────────┤
│ Subject: [Email Subject]                   │
│ Assigned to: @user                         │
│ Due: Dec 25, 2024                          │
│ Priority: 🔴 High / 🟡 Medium / 🟢 Low     │
│ Type: [Task Type]                          │
│ From: sender@email.com                     │
│ To: recipient@email.com                    │
├────────────────────────────────────────────┤
│ Notes:                                     │
│ [Any extracted notes]                      │
├────────────────────────────────────────────┤
│ 📅 Meeting Requested (if detected)         │
│ • Wed Dec 20, 2:00 PM EST                  │
│ • Thu Dec 21, 10:00 AM EST (alt)           │
├────────────────────────────────────────────┤
│ [View in Monday] button                    │
└────────────────────────────────────────────┘
+ PDF attachment
```

### Priority Display

| Priority | Emoji | Detection Keywords |
|----------|-------|-------------------|
| High | 🔴 | ASAP, urgent, immediately, critical, emergency, escalation |
| Medium | 🟡 | Standard tasks with deadlines |
| Low | 🟢 | FYI, informational, no rush, when you get a chance |

---

## 6. Monday.com Integration

### Monday Service (`monday.ts`)

**GraphQL Operations:**

| Function | GraphQL Mutation/Query | Purpose |
|----------|----------------------|---------|
| `createItem(input)` | `create_item` | Creates new task item |
| `updateSlackThreadId(id, ts)` | `change_multiple_column_values` | Links to Slack thread |
| `uploadFileToItem(id, filename, data)` | `add_file_to_column` | Uploads PDF |
| `createUpdate(id, body)` | `create_update` | Adds comment to item |
| `updateWorkflowStatus(id, status)` | `change_multiple_column_values` | Updates status |
| `updateType(id, type)` | `change_multiple_column_values` | Updates task type |
| `createSubitem(parentId, name)` | `create_subitem` | Creates subtask |
| `createSubitems(parentId, names[])` | Multiple `create_subitem` | Batch subtasks |
| `findItemBySlackThread(ts)` | `items_page_by_column_values` | Finds item by Slack thread |
| `getSlackThreadId(id)` | `items` query | Gets linked Slack thread |
| `getItem(id)` | `items` query | Gets item details |
| `getUser(id)` | `users` query | Gets user info |
| `getAllUsers()` | `users` query | Gets all users |
| `findUserByEmail(email)` | `users` query | Finds user by email |

### Task Types (`taskTypes.ts`)

```typescript
const TASK_TYPE_MAPPINGS = [
  { aliases: ['general'], displayName: 'General' },
  { aliases: ['pp', 'payment plan'], displayName: 'Payment Plan' },
  { aliases: ['refund'], displayName: 'Refund' },
  { aliases: ['decline'], displayName: 'Decline' },
  { aliases: ['revoked'], displayName: 'Revoked' },
  { aliases: ['renewal'], displayName: 'Renewal' },
  { aliases: ['relo', 'relocation'], displayName: 'Relocation' },
  { aliases: ['opp', 'opportunity'], displayName: 'Opportunity' },
  { aliases: ['ic', 'issue call'], displayName: 'Issue Call' },
];
```

### Item URL Format

```typescript
function getItemUrl(itemId: string): string {
  return `${config.monday.boardUrl}/pulses/${itemId}`;
}
```

---

## 7. Google Services Integration

### Gmail Service (`gmail.ts`)

Used for the `/scan` feature to search for related emails.

**Functions:**

| Function | Purpose |
|----------|---------|
| `findRelatedRecipients(subject)` | Searches Gmail for emails with same subject (48h) |
| `extractAppointmentTime(body)` | Uses Claude to extract appointment date/time |
| `normalizeSubject(subject)` | Strips FWD:/RE: prefixes |
| `shouldScanForRecipients(body)` | Checks for `/scan` command |
| `formatRecipientSubtaskName(recipient)` | Formats subtask name with appointment |

**Appointment Keywords (triggers extraction):**
- presale, pre-sale
- relocation
- selection
- appointment
- scheduled
- your time, your slot

**Recipient With Appointment:**

```typescript
interface RecipientWithAppointment {
  email: string;
  appointmentDate: string | null;  // e.g., "Tue Dec 20"
  appointmentTime: string | null;  // e.g., "2:00 PM"
  rawDateTime: string | null;      // ISO format for sorting
}
```

### Google Sheets Service (`sheets.ts`)

Creates tracking spreadsheets for presale/relocation emails.

**Functions:**

| Function | Purpose |
|----------|---------|
| `createRecipientSheet(title, recipients)` | Creates new spreadsheet |
| `shouldCreateSheet(subject)` | Checks if sheet should be created |

**Sheet Structure:**

| Email | Date | Time | Status | Notes |
|-------|------|------|--------|-------|
| john@example.com | Tue Dec 20 | 2:00 PM | | |
| jane@example.com | Wed Dec 21 | 10:00 AM | | |

**Features:**
- Frozen header row
- Blue header background with white bold text
- Auto-sized columns
- Anyone with link can edit

### Google Calendar Service (`calendar.ts`)

Creates calendar events for tasks.

**Functions:**

| Function | Purpose |
|----------|---------|
| `createTaskEvent(input)` | Creates all-day event on due date |
| `updateTaskEvent(eventId, updates)` | Updates existing event |
| `deleteTaskEvent(eventId)` | Deletes event |
| `isCalendarEnabled()` | Checks if calendar is configured |

**Event Features:**
- All-day event on due date
- Invites assignee (sends email)
- Includes Monday.com link
- Reminders: 1 day before, 2 hours before

---

## 8. Claude AI Integration

### Email Analysis (`claude.ts`)

**Functions:**

| Function | Purpose |
|----------|---------|
| `analyzeEmail(...)` | Full AI analysis with tool use |
| `analyzeEmailSafe(...)` | Analysis with fallback to manual parsing |

**Analysis Extracts:**

```typescript
interface AnalysisResult {
  owner: string;           // Assignee name
  dueDate: string;         // Parsed date (+N or MM/DD/YY)
  taskType: string;        // Task type alias
  priority: 'high' | 'medium' | 'low';
  notes: string;           // Additional context
  confidence: number;      // 0-1 confidence score
  meeting: MeetingInfo;    // Meeting request detection
}

interface MeetingInfo {
  hasMeetingRequest: boolean;
  meetingDateTime: string | null;     // ISO 8601
  meetingDateTimeAlt: string | null;  // Alternative time
}
```

**Claude Tool Definition:**

```typescript
{
  name: 'extract_task_details',
  input_schema: {
    properties: {
      owner: { type: 'string' },
      dueDate: { type: 'string' },
      taskType: { type: 'string', enum: [...] },
      priority: { type: 'string', enum: ['high', 'medium', 'low'] },
      notes: { type: 'string' },
      confidence: { type: 'number' },
      hasMeetingRequest: { type: 'boolean' },
      meetingDateTime: { type: 'string' },
      meetingDateTimeAlt: { type: 'string' },
    }
  }
}
```

### Task Parser for Slash Commands (`taskParser.ts`)

Parses natural language from Slack slash commands.

```typescript
interface ParsedTask {
  name: string | null;
  assignee: string | null;
  dueDate: string | null;       // YYYY-MM-DD
  taskType: string | null;
  priority: 'high' | 'medium' | 'low' | null;
  rawDueDate: string | null;    // Original text
  team: string | null;          // Sports team
}

interface MissingFields {
  needsName: boolean;
  needsAssignee: boolean;
  needsDueDate: boolean;
}
```

---

## 9. Two-Way Sync System

### Sync Service (`sync.ts`)

**Slack → Monday:**

| Trigger | Action |
|---------|--------|
| Thread reply | Creates Monday update |
| 👀 reaction | Marks "Acknowledged" |
| ✅ reaction | Marks "Complete" |
| ✅ removed | Marks "Working on it" |

**Monday → Slack:**

| Trigger | Action |
|---------|--------|
| Update created | Posts to Slack thread |
| Status → Complete | Posts completion message + adds ✅ |

**Mention Translation:**
- Slack `<@U12345>` → Monday `@John Smith`
- Monday `@John Smith` → Slack `<@U12345>`

### User Resolution (`userResolver.ts`)

Dynamically matches users between Monday.com and Slack by email.

```typescript
interface UnifiedUser {
  name: string;           // From Monday
  email: string;          // Used to match
  mondayId: number;       // Monday.com user ID
  slackId: string | null; // Slack user ID
  slackName: string | null;
}
```

**Matching Priority:**
1. Exact full name: "Elia Smith" → Elia Smith
2. Exact first name: "elia" → Elia Smith (not Eliana)
3. Slack username: "esmith" → Elia Smith
4. Partial match (prefers shorter): "eli" → Elia over Eliana

**Cache:** 5 minutes TTL

---

## 10. Auto Follow-Up Reminders

### Auto Follow-Up Service (`autoFollowUp.ts`)

Runs on a schedule (default: hourly) to send reminders.

**Triggers:**

| Condition | Reminder |
|-----------|----------|
| No 👀 after 4 hours | "Please react with 👀 to acknowledge" |
| Past due | "Task is X days overdue. React with ✅ when complete." |

**Reminder Messages (randomly selected):**

**Acknowledgment:**
- `{mentions} - please react with 👀 to acknowledge "{task.name}"`
- `Hey {mentions}, don't forget to 👀 this task`
- `{mentions} - add a 👀 reaction to acknowledge you're on this`

**Overdue:**
- `{mentions} - "{task.name}" is X days overdue. React with ✅ when complete.`
- `Hey {mentions}, this task is past due. Add ✅ once it's done.`
- `{mentions} - overdue by X days. Mark complete with ✅ when finished.`

**Deduplication:** Same follow-up not sent within 12 hours

---

## 11. Slash Commands

### `/monday` Command

General-purpose task creation with AI.

**Endpoint:** `POST /webhook/slack/command`

**Examples:**
```
/monday Fix the login bug
/monday Review contract for @john by friday
/monday urgent: deploy hotfix asap
/monday Schedule meeting with team next week
```

### `/seasontask` Command

Restricted to season tickets channels only.

**Allowed Channels:** `C06BSL06WJK`, `C08QCFC4Y0H`

**Endpoint:** `POST /webhook/slack/seasontask`

**Examples:**
```
/seasontask Follow up on Yankees renewal
/seasontask Call John about Knicks tickets by friday
/seasontask urgent: Rangers invoice needs review
/seasontask Schedule Giants meeting next week @sarah
```

**Sports Teams Recognized:**
- Yankees, Mets
- Knicks, Nets
- Rangers, Islanders
- Giants, Jets

### Command Flow

```
1. User types /monday Fix the bug
           ↓
2. Claude AI parses → extracts what it can
           ↓
3. If missing required fields → asks follow-up questions
           ↓
4. User answers → "john, friday"
           ↓
5. Claude parses answers → fills in missing fields
           ↓
6. Shows confirmation with Create/Cancel buttons
           ↓
7. User clicks Create → Monday item created
           ↓
8. Ephemeral confirmation with link
```

### Conversation State (`conversationState.ts`)

Tracks multi-turn conversations for incomplete tasks.

```typescript
interface PendingTask {
  parsed: ParsedTask;
  missing: MissingFields;
  slackUserId: string;
  slackChannelId: string;
  awaitingFields: Array<'name' | 'assignee' | 'dueDate'>;
  createdAt: number;
}
```

**Timeout:** 10 minutes

---

## 12. Special Features

### `/scan` Command

Add `/scan` to your forwarding email body to:

1. Search Gmail for emails with same subject (last 48 hours)
2. Extract each recipient's appointment date/time (for presale/relocation)
3. Create Monday.com subtasks for each recipient
4. Create Google Sheet for tracking (presale/relocation keywords)
5. Post Google Sheet link to Monday update and Slack thread

**Subtask Format:** `email@example.com - Tue Dec 20, 2:00 PM`

### Meeting Detection

Claude AI automatically detects meeting requests in emails:

- Looks for: "let's meet", "can we schedule", "are you available"
- Extracts proposed date/time(s)
- Supports alternative times
- Defaults to EST/America/New_York timezone

### Date Parsing (`dateParser.ts`)

**Supported Formats:**

| Input | Output |
|-------|--------|
| `+3` | 3 days from now |
| `+1` | tomorrow |
| `12/25` | Dec 25 (current year) |
| `12/25/24` | Dec 25, 2024 |
| `12/25/2024` | Dec 25, 2024 |

**Claude AI also understands:**
- "tomorrow", "next week", "in 3 days"
- "friday", "next friday"
- "end of week", "asap" (marks urgent, still asks for date)

### Subject Normalization

Automatically strips prefixes from email subjects:
- FWD:, Fwd:, FW:, Fw:
- RE:, Re:

Handles nested: "RE: FWD: Original Subject" → "Original Subject"

---

## 13. API Reference

### Server Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check |
| POST | `/webhook/email` | Main email webhook |
| POST | `/webhook/json` | JSON format webhook |
| POST | `/webhook/slack/events` | Slack Events API |
| POST | `/webhook/slack/command` | `/monday` slash command |
| POST | `/webhook/slack/seasontask` | `/seasontask` slash command |
| POST | `/webhook/slack/interactive` | Button clicks |
| POST | `/webhook/monday` | Monday.com webhooks |

### Email Webhook Formats

**1. Raw Email (message/rfc822):**
```
Content-Type: message/rfc822

[Raw email content]
```

**2. JSON Payload:**
```json
{
  "email": "base64_encoded_email_content"
}
```

**3. Multipart Form Data:**
```
Content-Type: multipart/form-data
email: [file or field]
```

**4. JSON Webhook:**
```json
{
  "subject": "Task Subject",
  "text": "@assignee\n+3\nrefund\n\nNotes here",
  "attachments": [
    {
      "filename": "email.eml",
      "content": "base64_encoded_content",
      "contentType": "message/rfc822"
    }
  ]
}
```

### Response Formats

**Success:**
```json
{
  "success": true,
  "mondayItemId": "1234567890",
  "slackThreadTs": "1234567890.123456"
}
```

**Error:**
```json
{
  "success": false,
  "error": "Error message"
}
```

---

## 14. Data Types & Interfaces

### Core Types (`types/index.ts`)

```typescript
interface TaskTypeMapping {
  aliases: string[];
  displayName: string;
}

interface ParsedEmail {
  subject: string;
  text: string;
  fromEmail: string | null;
  toEmail: string | null;
  attachments: EmailAttachment[];
}

interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

interface TaskDetails {
  owner: string;
  dueDate: string;
  taskType: string;
  notes: string;
}

interface EmlHeaders {
  subject: string | null;
  from: string | null;
  to: string | null;
  body: string | null;
}

interface ConvertedFile {
  filename: string;
  data: Buffer;
}

interface MondayItem {
  id: string;
  name: string;
}

interface MondayUser {
  id: number;
  name: string;
  email: string;
}

interface SlackMessage {
  ts: string;
  channel: string;
}

interface WorkflowResult {
  mondayItemId: string;
  slackThreadTs: string;
  success: boolean;
  error?: string;
}
```

---

## 15. User Guide

### Forwarding Emails

**Basic Format:**
```
@AssigneeName
due date
task type (optional)

Any notes here...
```

**Examples:**

```
@Dayna
tomorrow
payment plan

Customer wants to set up monthly installments.
```

```
@Mike
+3
refund

URGENT: Customer requesting refund - unhappy with seats.
```

```
@Sarah
12/25
relo

/scan

Process all relocation appointments.
```

### Due Date Formats

| Format | Example | Result |
|--------|---------|--------|
| Relative | `tomorrow` | Next day |
| Relative | `+3` | 3 days from now |
| Relative | `next week` | 7 days |
| Specific | `12/25` | December 25 |
| Specific | `12/25/24` | December 25, 2024 |
| Named | `friday` | Upcoming Friday |

### Task Types

| Type | Aliases |
|------|---------|
| General | general |
| Payment Plan | pp, payment plan |
| Refund | refund |
| Decline | decline |
| Revoked | revoked |
| Renewal | renewal |
| Relocation | relo, relocation |
| Opportunity | opp, opportunity |
| Issue Call | ic, issue call |

### Priority Keywords

| Priority | Keywords |
|----------|----------|
| **High** | ASAP, urgent, immediately, critical, emergency |
| **Medium** | (default for normal tasks) |
| **Low** | FYI, no rush, when you get a chance |

### Reacting to Tasks

| Emoji | Action |
|-------|--------|
| 👀 | Acknowledge you've seen the task |
| ✅ / ☑️ | Mark task as complete |

### Using /scan

Add `/scan` anywhere in your email body:

```
@Team
next monday
relocation

/scan

Please process all the relocation appointments from this week.
```

**Result:**
- Searches Gmail for same subject (48 hours)
- Creates subtasks: `john@client.com - Tue Dec 20, 2:00 PM`
- Creates Google Sheet (for presale/relocation)
- Posts sheet link to Monday and Slack

---

## 16. Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| "Unknown user" error | Name not matched | Use full name or check spelling |
| Wrong due date | Ambiguous date | Use specific format: MM/DD/YY |
| No Slack notification | User not in Slack | Verify user has Slack account with matching email |
| `/scan` finds nothing | Time window | Emails must be within last 48 hours |
| PDF not attached | ConvertAPI issue | Check ConvertAPI credits/limits |
| Calendar event not created | Not enabled | Set `GOOGLE_CALENDAR_ENABLED=true` |
| No Google Sheet | Keywords missing | Subject must contain presale/relocation/selection |
| Subtasks not created | No recipients found | Check Gmail search results |

### Logs

The server logs all major steps:

```
Starting workflow for email: Subject Line
Parsing EML attachment...
EML headers: {...}
EML body length: 1234 chars
Analyzing email with Claude AI...
Claude analysis: {...}
Confidence: 95%
Task type: Refund
Due date: 2024-12-25
Resolved user: Dayna Smith Monday ID: 12345 Slack ID: U12345
Converting EML to PDF...
PDF generated: email.pdf
Creating Monday.com item...
Monday item created: 1234567890
/scan detected - searching for related recipients...
Found 5 related recipients, creating subtasks...
Created 5 subtasks for recipients
Creating Google Sheet for recipient tracking...
Google Sheet created: https://docs.google.com/spreadsheets/d/...
Sending Slack notification...
Slack message sent: 1234567890.123456
Uploading PDF to Monday and Slack...
PDF uploaded to both services
Posting Google Sheet link to Slack thread...
Updating Monday with Slack thread ID...
Creating Google Calendar event...
Calendar event created: abc123
Setting Slack reminder...
Workflow completed successfully!
```

### Error Handling

The system has graceful error handling:

- `/scan` failures don't stop the main workflow
- Google Sheet failures don't stop subtask creation
- Calendar failures don't stop the workflow
- Reminder failures are logged but don't throw

Use `executeWorkflowSafe` for production to catch all errors:

```typescript
const result = await executeWorkflowSafe({ email });
if (!result.success) {
  console.error('Workflow failed:', result.error);
}
```

---

## Appendix: Quick Reference Card

### Email Format
```
@name
due_date
task_type

notes...
```

### Slash Commands
```
/monday [task description]
/monday help
/monday cancel

/seasontask [task description]
/seasontask help
/seasontask cancel
```

### Special Commands in Email
```
/scan    → Search for related emails and create subtasks
```

### Slack Reactions
```
👀 eyes         → Acknowledged
✅ check mark   → Complete
```

### Webhook Endpoints
```
POST /webhook/email          → Email ingestion
POST /webhook/json           → JSON format
POST /webhook/slack/events   → Slack events
POST /webhook/slack/command  → /monday command
POST /webhook/slack/seasontask → /seasontask command
POST /webhook/slack/interactive → Button clicks
POST /webhook/monday         → Monday webhooks
GET  /health                 → Health check
```
