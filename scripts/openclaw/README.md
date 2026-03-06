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

#### Daily R2 Backup (3:00 AM)
```
Trigger: Daily at 03:00
Script: cd ~/ranking-arena && npm run backup:r2
Action: Dump 31 trader tables → gzip → upload to R2
Full backup (weekly, Sunday): cd ~/ranking-arena && npm run backup:r2:full
```

### 4. Mac Mini Crontab

Add these lines to `crontab -e`:

```cron
# Arena Health Monitor (every 30 min)
*/30 * * * * cd ~/ranking-arena && node scripts/openclaw/health-monitor.mjs >> /tmp/arena-health.log 2>&1

# Arena Daily Report (8 AM)
0 8 * * * cd ~/ranking-arena && node scripts/openclaw/health-monitor.mjs daily >> /tmp/arena-daily.log 2>&1

# Arena UX Patrol (9 AM)
0 9 * * * cd ~/ranking-arena && node scripts/openclaw/ux-patrol.mjs >> /tmp/arena-ux.log 2>&1

# Arena Daily Backup to R2 (3 AM)
0 3 * * * cd ~/ranking-arena && npm run backup:r2 >> /tmp/arena-backup.log 2>&1

# Arena Full Backup to R2 (Sunday 4 AM)
0 4 * * 0 cd ~/ranking-arena && npm run backup:r2:full >> /tmp/arena-backup-full.log 2>&1
```

## Scripts

| Script | Purpose |
|--------|---------|
| `health-monitor.mjs` | Health check (run every 30 min) |
| `health-monitor.mjs daily` | Daily summary report (run at 8 AM) |
| `ux-patrol.mjs` | UX health check — pages, APIs, data quality, SSR (daily at 9 AM) |
| `../maintenance/backup-to-r2.mjs` | Daily trader data backup to R2 (3 AM) |
| `../maintenance/backup-to-r2.mjs --full` | Full DB backup to R2 (Sunday 4 AM) |
