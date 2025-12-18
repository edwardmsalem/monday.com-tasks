# Railway Deployment Guide

Step-by-step instructions for deploying the Email Forwarding Task System on Railway.

---

## Prerequisites

Before starting, make sure you have:

1. **Railway Account** - Sign up at [railway.app](https://railway.app)
2. **GitHub Account** - Your code pushed to a GitHub repo
3. **API Keys Ready:**
   - Monday.com API Token
   - Slack Bot Token
   - Anthropic API Key
   - ConvertAPI Secret
   - Google Service Account JSON (optional)

---

## Step 1: Push Code to GitHub

If not already done:

```bash
# Initialize git (if needed)
git init

# Add all files
git add .

# Commit
git commit -m "Initial commit"

# Create GitHub repo and push
gh repo create forwarding-monday --private --push
```

---

## Step 2: Create Railway Project

1. Go to [railway.app](https://railway.app)
2. Click **"Start a New Project"**
3. Select **"Deploy from GitHub repo"**
4. Authorize Railway to access your GitHub (if first time)
5. Select your `forwarding-monday` repository
6. Railway will detect it's a Node.js project

---

## Step 3: Configure Build Settings

Railway should auto-detect, but verify:

1. Click on your service
2. Go to **Settings** tab
3. Under **Build**:
   - **Builder**: Nixpacks (default)
   - **Build Command**: `npm run build`
   - **Start Command**: `npm start`

If not auto-detected, create a `railway.json` in your repo root:

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "npm start",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

---

## Step 4: Set Environment Variables

1. Click on your service
2. Go to **Variables** tab
3. Click **"+ New Variable"** or **"RAW Editor"**

Add these variables:

### Required Variables

```
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
ANTHROPIC_API_KEY=sk-ant-your-key

# ConvertAPI
CONVERTAPI_SECRET=your_secret
```

### Optional Variables (Google Services)

```
# Google Calendar
GOOGLE_CALENDAR_ENABLED=true
GOOGLE_CALENDAR_ID=primary
GOOGLE_CALENDAR_TIMEZONE=America/New_York

# Gmail for /scan
GOOGLE_FORWARDING_EMAIL=forwarding@yourcompany.com

# Service Account (paste entire JSON, escaped)
GOOGLE_SERVICE_ACCOUNT_KEY={"type":"service_account","project_id":"..."}
```

**Tip:** For the Google Service Account JSON, you can paste it directly - Railway handles multi-line values.

---

## Step 5: Deploy

1. Railway auto-deploys when you push to GitHub
2. Or click **"Deploy"** button manually
3. Watch the build logs for any errors

Build typically takes 1-2 minutes.

---

## Step 6: Get Your Public URL

1. Go to **Settings** tab
2. Under **Networking**, click **"Generate Domain"**
3. Railway gives you a URL like: `forwarding-monday-production.up.railway.app`

Or set a custom domain if you have one.

---

## Step 7: Configure Webhooks

Now configure external services to send data to your Railway app.

### Email Webhook (Choose One Method)

#### Option A: Mailgun

1. Go to Mailgun Dashboard → Receiving → Create Route
2. Set expression: `match_recipient("forward@yourdomain.com")`
3. Set action: `forward("https://your-app.up.railway.app/webhook/email")`

#### Option B: SendGrid Inbound Parse

1. Go to SendGrid → Settings → Inbound Parse
2. Add host/domain
3. Set URL: `https://your-app.up.railway.app/webhook/email`

#### Option C: Postmark

1. Go to Postmark → Servers → Inbound
2. Set webhook URL: `https://your-app.up.railway.app/webhook/email`

### Slack Configuration

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Select your app (or create one)

#### Event Subscriptions
1. Go to **Event Subscriptions**
2. Enable Events: **On**
3. Request URL: `https://your-app.up.railway.app/webhook/slack/events`
4. Subscribe to bot events:
   - `message.channels`
   - `reaction_added`
   - `reaction_removed`
5. Save Changes

#### Slash Commands
1. Go to **Slash Commands**
2. Create `/monday` command:
   - Command: `/monday`
   - Request URL: `https://your-app.up.railway.app/webhook/slack/command`
   - Description: `Create a Monday.com task`
3. Create `/seasontask` command:
   - Command: `/seasontask`
   - Request URL: `https://your-app.up.railway.app/webhook/slack/seasontask`
   - Description: `Create a season tickets task`

#### Interactivity
1. Go to **Interactivity & Shortcuts**
2. Enable Interactivity: **On**
3. Request URL: `https://your-app.up.railway.app/webhook/slack/interactive`
4. Save Changes

#### Bot Permissions (OAuth & Permissions)
Ensure these scopes:
- `chat:write`
- `chat:write.public`
- `files:write`
- `reactions:read`
- `reactions:write`
- `users:read`
- `users:read.email`
- `reminders:write`
- `commands`

### Monday.com Webhook

1. Go to your Monday.com board
2. Click **Integrate** → **Integrations Center**
3. Search for **Webhooks**
4. Or use the API to create a webhook:

```bash
curl --request POST \
  --url https://api.monday.com/v2 \
  --header 'Authorization: YOUR_API_TOKEN' \
  --header 'Content-Type: application/json' \
  --data '{
    "query": "mutation { create_webhook(board_id: YOUR_BOARD_ID, url: \"https://your-app.up.railway.app/webhook/monday\", event: change_column_value) { id } }"
  }'
```

---

## Step 8: Test the Deployment

### Test Health Check
```bash
curl https://your-app.up.railway.app/health
```

Expected response:
```json
{"status":"ok","timestamp":"2024-12-18T..."}
```

### Test Email Webhook (JSON format)
```bash
curl -X POST https://your-app.up.railway.app/webhook/json \
  -H "Content-Type: application/json" \
  -d '{
    "subject": "Test Task",
    "text": "@yourname\ntomorrow\ngeneral\n\nThis is a test task."
  }'
```

### Test Slack Command
Type `/monday Test task for me by friday` in your Slack channel.

---

## Step 9: Monitor & Logs

### View Logs
1. Click on your service in Railway
2. Go to **Deployments** tab
3. Click on active deployment
4. View real-time logs

### Set Up Alerts (Optional)
1. Go to **Settings** → **Observability**
2. Configure alerts for failures

---

## Troubleshooting

### Build Fails

**Check package.json:**
```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js"
  }
}
```

**Check tsconfig.json has outDir:**
```json
{
  "compilerOptions": {
    "outDir": "./dist"
  }
}
```

### App Crashes on Start

1. Check logs for missing env variables
2. Verify all required variables are set
3. Check for typos in variable names

### Slack Events Not Working

1. Verify URL in Slack app settings
2. Check Railway logs for incoming requests
3. Ensure bot is in the channel

### Monday Webhook Fails

1. Check the webhook URL is correct
2. Verify API token has correct permissions
3. Look for challenge verification in logs

### Google Services Not Working

1. Verify `GOOGLE_CALENDAR_ENABLED=true`
2. Check service account JSON is valid
3. Ensure service account has access to calendar/drive

---

## Cost Estimate

Railway pricing (as of 2024):

- **Hobby Plan**: $5/month
  - Includes 500 hours execution
  - Good for low-moderate traffic

- **Pro Plan**: $20/month
  - Unlimited execution
  - Better for production

This app is lightweight and should run well on the Hobby plan for moderate usage.

---

## Quick Commands Reference

```bash
# Check deployment status
railway status

# View logs
railway logs

# Open app in browser
railway open

# Connect to shell (debugging)
railway shell

# Set variable
railway variables set KEY=value

# Redeploy
railway up
```

---

## Architecture on Railway

```
┌─────────────────────────────────────────────┐
│                  RAILWAY                     │
│  ┌─────────────────────────────────────┐    │
│  │   forwarding-monday service          │    │
│  │   - Express server on PORT 3000      │    │
│  │   - Auto-scaling                     │    │
│  │   - HTTPS enabled                    │    │
│  └─────────────────────────────────────┘    │
│              ↑                               │
│              │ HTTPS                         │
└─────────────────────────────────────────────┘
               ↑
    ┌──────────┼──────────┐
    │          │          │
┌───────┐ ┌────────┐ ┌─────────┐
│ Email │ │ Slack  │ │ Monday  │
│Service│ │  API   │ │   API   │
└───────┘ └────────┘ └─────────┘
```

---

## Next Steps After Deployment

1. **Test full workflow** - Forward a test email
2. **Verify Slack notifications** - Check channel for message
3. **Check Monday.com** - Verify item was created
4. **Test /scan** - Try with presale/relocation email
5. **Monitor logs** - Watch for any errors
6. **Set up custom domain** (optional)
