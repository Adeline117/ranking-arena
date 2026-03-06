# OpenClaw Integration for Arena

Scripts and configuration for running Arena's autonomous monitoring on the local Mac Mini via OpenClaw.

## Setup

### 1. Environment Variables

Set these in OpenClaw or in a `.env` file:

```bash
ARENA_URL=https://www.arenafi.org
CRON_SECRET=<your-cron-secret>
TELEGRAM_BOT_TOKEN=<your-telegram-bot-token>
TELEGRAM_ALERT_CHAT_ID=<your-chat-id>
```

### 2. OpenClaw Skills

Configure these skills in OpenClaw:

#### Health Monitor (every 30 minutes)
```
Trigger: Every 30 minutes
Script: node scripts/openclaw/health-monitor.mjs
Action on alert: Send Telegram notification
```

#### Daily Report (8:00 AM)
```
Trigger: Daily at 08:00
Script: node scripts/openclaw/health-monitor.mjs daily
```

#### Auto-Fix Pipeline (on alert)
```
Trigger: When health-monitor detects pipeline failure
Action:
  1. Open Claude Code session in the Arena project directory
  2. Prompt: "[JOB_NAME] pipeline failed with error: [ERROR].
     Read pipeline_logs for the last 10 runs of this job.
     Analyze the error pattern, fix the root cause, run tests, and commit."
  3. Send Telegram notification with result
```

#### Bug Report Handler
```
Trigger: When receiving a bug report (Discord/Telegram)
Action:
  1. Extract bug description
  2. Open Claude Code session
  3. Prompt: "User reported: [DESCRIPTION].
     Reproduce, locate root cause, fix, test, commit.
     Log in CHANGELOG.md."
  4. Send fix summary to Telegram
  5. Wait for "ok" to deploy (auto-deploy if <3 files changed + tests pass)
```

### 3. Auto-Deploy Rules

| Condition | Action |
|-----------|--------|
| Tests pass + <3 files changed | Auto-deploy |
| Tests pass + 3+ files changed | Wait for confirmation |
| Tests fail | Block + alert |

## Scripts

| Script | Purpose |
|--------|---------|
| `health-monitor.mjs` | Health check (run every 30 min) |
| `health-monitor.mjs daily` | Daily summary report (run at 8 AM) |
