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

#### Incident Response (on alert)

The monitor is alert-only. Investigate failures against the active source
registry, reproduce them in an isolated worktree, run the required checks, and
ship changes through a reviewed pull request. Monitoring must never launch a
code-writing process or push directly to a deployment branch.

#### Bug Report Handler

```
Trigger: When receiving a bug report (Discord/Telegram)
Action:
  1. Capture the report and reproducible evidence
  2. Open or update a tracked incident
  3. Prepare an isolated, tested pull request when a code change is required
  4. Send the incident/PR link to Telegram for human review
  5. Deploy only through the normal reviewed main-branch release gate
```

### 3. Change-Control Rules

| Condition                       | Action                                  |
| ------------------------------- | --------------------------------------- |
| Tests and required checks pass  | Open a pull request for review          |
| Any required check fails        | Block release and keep the alert active |
| Production mutation is required | Use the approved runbook and audit log  |

#### Daily R2 Backup (3:00 AM)

```
Trigger: Daily at 03:00
Script: cd ~/ranking-arena && BACKUP_SCHEMAS=arena,public npm run backup:r2
Action: Dump the arena+public application schemas → gzip → multipart upload + HEAD attestation in R2
Full-database capture (weekly, Sunday): cd ~/ranking-arena && npm run backup:r2:full
```

`arena+public` is an application-data backup, not a managed-auth recovery point.
The full-database capture is also not a proven restore point until it passes the
managed scratch compatibility drill documented in `docs/RUNBOOK.md`.

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
0 3 * * * cd ~/ranking-arena && BACKUP_SCHEMAS=arena,public npm run backup:r2 >> /tmp/arena-backup.log 2>&1

# Arena Full-Database Capture to R2 (Sunday 4 AM; recovery is not yet certified)
0 4 * * 0 cd ~/ranking-arena && npm run backup:r2:full >> /tmp/arena-backup-full.log 2>&1

# Sentry Error Convergence (Friday 10 AM)
0 10 * * 5 cd ~/ranking-arena && node scripts/openclaw/sentry-convergence.mjs --resolve-stale >> /tmp/arena-sentry.log 2>&1

# Field-coverage canary — detects silent field loss (parser/upstream drift) daily at 7:45
45 7 * * * cd ~/ranking-arena && npx tsx --env-file=.env.local scripts/openclaw/field-coverage-canary.mts >> /tmp/arena-field-canary.log 2>&1
```

## Scripts

| Script                                   | Purpose                                                          |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `health-monitor.mjs`                     | Health check (run every 30 min)                                  |
| `health-monitor.mjs daily`               | Daily summary report (run at 8 AM)                               |
| `ux-patrol.mjs`                          | UX health check — pages, APIs, data quality, SSR (daily at 9 AM) |
| `../maintenance/backup-to-r2.mjs`        | Daily trader data backup to R2 (3 AM)                            |
| `../maintenance/backup-to-r2.mjs --full` | Full DB backup to R2 (Sunday 4 AM)                               |
| `sentry-convergence.mjs`                 | Weekly Sentry error report + stale issue cleanup (Friday 10 AM)  |

`health-monitor.mjs` requires both Telegram credentials and exits non-zero
when the authoritative health verdict is degraded/critical, when a response is
invalid or stale, or when alert delivery is rejected. A logged `ALERT SENT`
therefore means Telegram acknowledged the message, not merely that an HTTP
request was attempted.
