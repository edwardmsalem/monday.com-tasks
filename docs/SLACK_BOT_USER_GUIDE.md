# Slack Bot User Guide

This guide explains all slash commands, reactions, and automated messages from the Salem Seats task management bot.

---

## Table of Contents

1. [Slash Commands](#slash-commands)
   - [/task](#task)
   - [/issuecall](#issuecall)
   - [/emailtask](#emailtask)
2. [Reactions](#reactions)
3. [Automated Messages](#automated-messages)
   - [Task Creation](#task-creation)
   - [Acknowledgment Reminders](#acknowledgment-reminders)
   - [Due Today Reminders](#due-today-reminders)
   - [Overdue Reminders](#overdue-reminders)
   - [Issue Call Reminders](#issue-call-reminders)
4. [Email Forwarding](#email-forwarding)

---

## Slash Commands

### /task

Create a task using natural language. The AI will parse your request and extract the owner, supporters, due date, and task details.

**Usage:**
```
/task [natural language description]
```

**Examples:**
```
/task @jamie needs to call the Astros account holder by Friday
/task Follow up with John about the invoice - assign to @sarah, due tomorrow
/task High priority: Fix the seating chart issue for Rangers game
```

**What happens:**
1. AI analyzes your text and extracts:
   - Owner (who's responsible)
   - Supporters (who can help)
   - Due date
   - Task type
   - Priority
   - Team (if mentioned)
2. Creates a Monday.com task
3. Posts to the main Slack channel
4. Pings the assigned owner

---

### /issuecall

Create an issue call task with automatic account lookup from Google Sheets.

**Usage:**
```
/issuecall [team] [email]
```

**Examples:**
```
/issuecall astros john@example.com
/issuecall houston astros jane.doe@email.com
/issuecall texans customer@gmail.com
```

**What happens:**
1. Looks up account info from Google Sheets:
   - Name
   - Phone number
   - Seat locations (all seats if multiple)
   - Address
   - Card info (Last 4, Exp, CVC)
2. Creates Monday.com task:
   - Owners: Dayna + Ruzzell Garcia
   - Type: Issue Call
   - Priority: High
   - Due: Today (or tomorrow if after 4 PM EST)
3. Posts to the Issue Call channel with full account info
4. Waits for someone to claim it

**Claiming an Issue Call:**
- React with 👀 or reply to the thread
- First person to react/reply becomes the Supporter on Monday

**Escalation (if unclaimed):**
| Time | Who gets pinged |
|------|-----------------|
| Every 20 min | @closers + Dayna + Ruzzell |
| After 1 hour | @closers + Dayna + Ruzzell + Edward |

---

### /emailtask

Search Gmail for an email and create a task from it.

**Usage:**
```
/emailtask [search query]
```

**Examples:**
```
/emailtask from:john@example.com subject:invoice
/emailtask astros presale newer_than:1d
```

**What happens:**
1. Searches Gmail using your query
2. If multiple results, shows you options to choose from
3. AI analyzes the email content
4. Creates task with email attached as PDF
5. Posts to Slack with task details

---

## Reactions

Use emoji reactions on task messages to update status:

| Reaction | What it does |
|----------|--------------|
| 👀 (eyes) | **Acknowledge** - Marks you've seen the task. Sets status to "Acknowledged" on Monday. |
| ✅ (white_check_mark) | **Complete** - Marks the task as done. Sets status to "Complete" on Monday. |
| ☑️ (ballot_box_with_check) | **Complete** - Same as ✅ |
| ✔️ (heavy_check_mark) | **Complete** - Same as ✅ |

**Removing reactions:**
- Removing ✅ will unmark the task as complete on Monday

---

## Automated Messages

The bot sends reminders and updates automatically. Here's what to expect:

### Task Creation

When a task is created, you'll see a message like:
```
📋 New Task: [Task Name]

Owner: @jamie
Supporter: @sarah
Due: 2024-01-15
Type: General
Priority: High

[View on Monday.com]
```

### Acknowledgment Reminders

**When:** 4 hours after task creation, if no 👀 reaction

**Messages (randomized):**
- "@owner - please react with 👀 to acknowledge "[Task Name]""
- "Hey @owner, don't forget to 👀 this task to let us know you've seen it."
- "@owner - add a 👀 reaction to acknowledge you're on this."

**What to do:** React with 👀 to acknowledge you've seen the task.

---

### Due Today Reminders

**When:** 10 AM on the day the task is due

**Messages (randomized):**
- "@owner - "[Task Name]" is due today. Please share any blockers you have, or extend to a more realistic date with an update explaining why."
- "Hey @owner, this task is due today! Will it be completed? If you need more time, please post an update with the reason and set a new due date."
- "@owner - Reminder: "[Task Name]" is due today. Share any blockers or extend the due date with an explanation if needed."

**What to do:**
1. Complete the task and react with ✅, OR
2. Post an update explaining blockers and set a new due date on Monday

---

### Overdue Reminders

#### Day 1 (Past Due)

**Messages (randomized):**
- "@owner - "[Task Name]" is now past due. Please post an update with current status and reason for delay, then mark ✅ when complete."
- "Hey @owner, this task is overdue! Post an update explaining the delay and when it will be done. React with ✅ once complete."
- "@owner - Overdue by 1 day. Share what's blocking this and extend if needed. Mark ✅ when finished."

#### Day 2+ (Escalation)

**Includes Edward for visibility:**

**Messages (randomized):**
- "⚠️ @owner - "[Task Name]" is now X days overdue. @Edward for visibility. This requires immediate attention - post an update with status and plan to complete."
- "🚨 Hey @owner, this task has been overdue for X days. Looping in @Edward. Please update with current status and expected completion date."
- "⚠️ @owner - X days overdue! cc @Edward. Post an update immediately with reason for delay and new target date."

**What to do:**
1. Post an update in the thread explaining the delay
2. Set a new realistic due date on Monday
3. Complete the task and react with ✅

---

### Issue Call Reminders

**When:** Every 20 minutes while unclaimed

**Standard ping (first hour):**
```
@closers @dayna @ruzzell This issue call is still waiting for someone to claim it. React with 👀 or reply to this thread to be assigned.
```

**Escalated ping (after 1 hour):**
```
@closers @dayna @ruzzell @edward This issue call is still waiting for someone to claim it. React with 👀 or reply to this thread to be assigned.
```

**What to do:** React with 👀 or reply to claim the issue call and be assigned as Supporter.

---

## Email Forwarding

Forward emails to `forwarding@salemseats.com` to automatically create tasks.

### Special Keywords

Include these in the email body for special handling:

| Keyword | What it does |
|---------|--------------|
| `/scan` | Scans email recipients and creates a Google Sheet with appointment times |

### How it works:

1. Forward an email to the forwarding address
2. AI analyzes the email content
3. Extracts task details (owner, due date, priority, etc.)
4. Creates Monday.com task with email as PDF attachment
5. Posts to Slack channel
6. Pings assigned owner

### After Hours

Tasks created after business hours (after 8 PM or on weekends):
- Created quietly (no immediate pings)
- Assignee pinged at 10 AM next business day
- Acknowledgment expected by 11 AM

---

## Quick Reference

### Commands
| Command | Purpose |
|---------|---------|
| `/task [description]` | Create task from natural language |
| `/issuecall [team] [email]` | Issue call with account lookup |
| `/emailtask [search]` | Create task from Gmail email |

### Reactions
| Emoji | Action |
|-------|--------|
| 👀 | Acknowledge task |
| ✅ ☑️ ✔️ | Mark complete |

### Timing
| Event | When |
|-------|------|
| Ack reminder | 4 hours after creation |
| Due today reminder | 10 AM on due date |
| Overdue reminder | Daily until complete |
| Issue call ping | Every 20 minutes |
| Issue call escalation | After 1 hour |

---

## Need Help?

- Contact your manager
- Check the Monday.com task for full details
- Reply in the Slack thread for updates
