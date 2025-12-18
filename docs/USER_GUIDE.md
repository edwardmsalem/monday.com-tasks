# Email Forwarding Task System - User Guide

A smart email forwarding system that automatically creates Monday.com tasks and Slack notifications from forwarded emails.

---

## Quick Start

Forward any email to your designated forwarding inbox with instructions in the body.

### Basic Format

```
@AssigneeName
due date
task type (optional)

Any additional notes here...
```

**Example:**
```
@Dayna
tomorrow
payment plan

Customer wants to set up monthly installments for their season tickets.
```

---

## How It Works

1. **Forward an email** to the designated inbox
2. **AI analyzes** the email and extracts:
   - Who to assign it to
   - Due date
   - Task type
   - Priority (based on urgency keywords)
   - Meeting requests (if detected)
3. **Monday.com item** is created automatically
4. **Slack notification** is posted with all details
5. **PDF attachment** of the original email is added to both platforms
6. **Reminder** is set for the assignee on the due date

---

## Assigning Tasks

Mention a team member by first name or full name:

- `@Dayna` or `@Dayna Smith`
- `@Mike` or `@Michael Johnson`

The system matches names intelligently, so partial matches work.

---

## Due Dates

You can specify due dates in many formats:

| Format | Example | Result |
|--------|---------|--------|
| Relative | `tomorrow` | Next day |
| Relative | `next week` | 7 days |
| Relative | `in 3 days` | 3 days |
| Specific | `12/25/24` | December 25, 2024 |
| Named | `next Friday` | Upcoming Friday |

If no date is specified, it defaults to **tomorrow**.

---

## Task Types

The system recognizes these task types (you can use any alias):

| Task Type | Aliases |
|-----------|---------|
| Payment Plan | payment, installments, pp |
| Refund | refund, money back |
| Decline | declined, decline, card issue |
| Revoked | revoked, cancelled, cancellation |
| Renewal | renewal, renew, season renewal |
| Relocation | relocation, move, relocate, seat move |
| Opportunity | opportunity, upsell, sales |
| Issue Call | issue, complaint, escalation |
| General | general, other (default) |

---

## Priority Detection

Priority is automatically detected based on keywords:

| Priority | Keywords |
|----------|----------|
| **High** | ASAP, urgent, immediately, critical, emergency, escalation |
| **Medium** | Standard tasks with deadlines |
| **Low** | FYI, informational, no rush, when you get a chance |

---

## Special Commands

### `/scan` - Recipient Search

Add `/scan` anywhere in your forwarding email to search for related emails and create subtasks.

**Best for:** Presale appointments, relocation scheduling, selection events

**What it does:**
1. Searches your inbox for emails with the same subject (last 48 hours)
2. Extracts each recipient's appointment date and time
3. Creates subtasks on Monday.com for each recipient
4. Creates a Google Sheet with tracking columns (for presale/relocation emails)

**Example:**
```
@Mike
next week
relocation

/scan

Please process all the relocation appointments.
```

**Result:**
- Monday.com subtasks created:
  - `john@client.com - Tue Dec 20, 2:00 PM`
  - `jane@client.com - Wed Dec 21, 10:00 AM`
  - `bob@client.com - Thu Dec 22, 3:30 PM`
- Google Sheet created with columns:
  - Email | Date | Time | Status | Notes

---

## What You'll See

### In Slack

When an email is forwarded, a notification appears with:

- Task type badge
- Subject line
- Assigned person (@ mentioned)
- Due date
- Priority indicator
- From/To email addresses
- Notes
- Meeting info (if detected)
- "View in Monday" button
- PDF attachment of the original email

**For /scan emails:** A link to the Google Sheet tracking spreadsheet.

### In Monday.com

A new item is created with:

- Task name (email subject, cleaned up)
- Due date
- Owner
- Task type
- Source column marked as "Forwarding Tasks"
- From/To email information
- Notes
- Slack thread ID (for reference)
- Attached PDF of original email

**For /scan emails:** Subtasks for each recipient with appointment times.

### Google Calendar (if enabled)

A calendar event is created for the assignee with:

- Task title
- Due date
- Notes
- Link to Monday.com item

### Slack Reminders

The assignee receives a Slack reminder at 9 AM on the due date.

---

## Follow-Up Reminders

The system monitors tasks and sends reminders:

### No Acknowledgment (4+ hours)
If no one reacts to the Slack notification:
> "Please react with eyes (observe) to acknowledge this task"

### Overdue Tasks
If a task is past due:
> "Task is X days overdue. React with checkmark when complete."

**React with:**
- Eyes emoji to acknowledge you've seen the task
- Checkmark when the task is complete

---

## Tips

1. **Keep it simple** - The AI is smart, so natural language works great
2. **Use urgency words** when needed - "ASAP" or "urgent" will flag high priority
3. **Include context** in notes - helps the assignee understand the task
4. **Use `/scan`** for batch emails with individual appointments
5. **Check the Google Sheet** link in Slack for presale/relocation tracking

---

## Examples

### Simple Task
```
@Sarah
friday
refund

Customer requesting refund for cancelled game.
```

### Urgent Task
```
@Mike
ASAP
issue

URGENT: Customer escalation - needs immediate callback.
```

### Batch Processing with /scan
```
@Team
next monday
relocation

/scan

Process all seat relocation appointments from this week's batch.
```

### Meeting Request
```
@Dayna
tomorrow

Customer wants to discuss payment options. They're available Tuesday at 2pm or Wednesday morning.
```
*The system detects and displays meeting times in Slack.*

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Task assigned to wrong person | Check spelling of name, use full name if needed |
| Wrong due date | Use specific format like MM/DD/YY |
| No Slack notification | Check that the assignee has a Slack account |
| /scan didn't find recipients | Emails must be within last 48 hours with matching subject |

---

## Questions?

Contact your system administrator for:
- Adding new team members
- Changing task type options
- Modifying the notification channel
