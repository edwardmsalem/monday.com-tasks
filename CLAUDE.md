# Claude Code Context for forwarding-monday

## CRITICAL: Use core-api for ALL External APIs

**If you see "Not Authenticated" errors, check for direct API calls!**

This service MUST use core-api for all external API calls. Direct `fetch()` to Monday/Slack/Claude APIs will fail because API keys are only stored in core-api.

### Troubleshooting "Not Authenticated"
1. Find the code making the API call
2. Check if it uses direct `fetch('https://api.monday.com/...')`
3. Replace with: `import { monday } from './services/coreApi.js'` and `monday.query(...)`

---

## Core-API Migration (IMPORTANT)

### Objective
All external API calls (Monday.com, Slack, Claude AI, Google APIs) should go through **core-api** instead of making direct API calls from this service.

### Why?
1. **Centralized authentication** - API keys stored in one place (core-api), not scattered across services
2. **Rate limiting** - core-api handles rate limits and retries for all services
3. **Easier maintenance** - Update API integrations in one place
4. **Security** - Services don't need individual API keys

### Architecture
```
┌─────────────────────┐     ┌─────────────────────┐
│  forwarding-monday  │────▶│      core-api       │────▶ Monday.com
│                     │     │                     │────▶ Slack
│  ta-pipeline-mgr    │────▶│  (centralized hub)  │────▶ Claude AI
│                     │     │                     │────▶ Google APIs
│  other services...  │────▶│                     │────▶ ConvertAPI
└─────────────────────┘     └─────────────────────┘
```

### How to Use core-api

**Import the client:**
```typescript
import { monday, slack, claude, google } from './services/coreApi.js';
```

**Make API calls:**
```typescript
// Monday query
const result = await monday.query(graphqlQuery, { boardId: '123' });

// Slack message
await slack.postMessage({ channel: 'C123', text: 'Hello' });

// Claude analysis
const analysis = await claude.analyze({ content: 'text', systemPrompt: '...' });
```

### DO NOT
- Make direct `fetch()` calls to `api.monday.com`
- Make direct `fetch()` calls to Slack API
- Make direct `fetch()` calls to `api.anthropic.com`
- Store API keys in this service's environment variables (except CORE_API_KEY)

### Required Environment Variables
```bash
CORE_API_URL=http://core-api.railway.internal:8080
CORE_API_KEY=<shared-api-key>
```

### Boards & Channels (from core-api config)

**Monday.com Boards:**
| Key | Purpose |
|-----|---------|
| `seasonTicketTasks` | Main task board for forwarding-monday |

**Slack Channels:**
| Key | Purpose |
|-----|---------|
| `seasonTicketAdmin` | Main channel for task notifications |
| `issueCall` | Issue call digests |
| `control` | Control/admin notifications |
| `supporterPrimary` | Primary supporter channel |
| `supporterSecondary` | Secondary supporter channels (comma-separated) |

Access via: `import { getCachedConfig } from './services/coreApi.js'`
```typescript
const config = getCachedConfig();
const boardId = config.monday.boards.seasonTicketTasks;
const channelId = config.slack.channels.seasonTicketAdmin;
```

### Files Using core-api
- `src/services/coreApi.ts` - The client (already complete)
- `src/services/digest.ts` - Uses `monday.query()` for task fetching
- `src/services/monday.ts` - Should use core-api (may need migration)
- `src/services/slack.ts` - Should use core-api (may need migration)

### Migration Status
- [x] digest.ts - Migrated to core-api for Monday queries
- [x] sheets.ts - Migrated to core-api for all Sheets operations (create, batchUpdate, getMetadata, getValues, updateValues)
- [ ] monday.ts - Check if using direct API calls
- [ ] slack.ts - Check if using direct API calls
- [ ] Other files - Audit for direct API usage

## Project Overview
Email-to-Monday.com task management system with Slack integration and scheduled digests.

## How to talk to me

Talk to me as a non-technical front-end user. I understand some dev concepts but explain things in plain English, not jargon. When something has a slow-vs-fast or one-time-vs-every-time distinction hidden in it, spell it out instead of assuming I'll catch it. Don't walk me through code unless I ask. Tell me what a change does in plain terms before you make it. If I say "plain it," that means stop and re-explain without the jargon.

## Workflow Capture

If we develop a reusable workflow, SOP, debugging playbook, deployment checklist, research routine, or coding process during a session, do not silently save it. Before ending the task, ASK me:

"Should I make a skill of this?"

If I say yes, create the skill at `.claude/skills/<slug>/SKILL.md` with:
- YAML frontmatter including a `description` field explaining when to use it
- `disable-model-invocation: true` if it should only run on explicit command
- Body: purpose, when to use, step-by-step, expected output

If I say no, drop it. Do not save it as a fallback to CLAUDE.md unless I specifically ask.

Never assume the chat transcript is sufficient long-term storage for a process, but never save behind my back either. Always ask first.
