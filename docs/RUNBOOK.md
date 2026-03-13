# Arena Operations Runbook

Emergency operations manual for the Arena crypto trader ranking platform.

## Table of Contents

- [Pipeline Failure Troubleshooting](#pipeline-failure-troubleshooting)
- [Leaderboard Anomaly Troubleshooting](#leaderboard-anomaly-troubleshooting)
- [Telegram Alert Response](#telegram-alert-response)
- [Manual Data Collection](#manual-data-collection)
- [Manual Leaderboard Recompute](#manual-leaderboard-recompute)
- [Arena Score Recalculation](#arena-score-recalculation)
- [Deployment Rollback](#deployment-rollback)
- [Database Emergency Operations](#database-emergency-operations)
- [Common Errors and Solutions](#common-errors-and-solutions)
- [Key Infrastructure](#key-infrastructure)

---

## Pipeline Failure Troubleshooting

### Symptom: Platform has no fresh data

1. **Diagnose** which platform is stale:
   ```bash
   node scripts/pipeline-health-check.mjs
   # or quick mode:
   node scripts/pipeline-health-check.mjs --quick
   ```

2. **Check pipeline logs** for the failing job:
   ```bash
   npx tsx scripts/pipeline-report.ts
   ```

3. **Check Vercel function logs** for errors:
   ```bash
   vercel logs --since 2h
   ```

4. **Common causes and fixes**:

   | Cause | Fix |
   |-------|-----|
   | Exchange API changed format | Update the fetcher/connector to match new response shape |
   | VPS scraper down | SSH to VPS, check PM2: `pm2 status`, `pm2 restart arena-scraper` |
   | Rate limited (429) | Wait for cooldown or increase delay in connector config |
   | Geo-blocked | Route through VPS proxy or Cloudflare Worker |
   | Timeout (524/504) | Reduce batch size or increase `timeoutMs` in connector config |
   | Supabase error 42P10 | Missing unique constraint on target table -- check ON CONFLICT clause |

5. **Generate automated fix script**:
   ```bash
   node scripts/pipeline-health-check.mjs --fix
   ```

### Symptom: Cron job stuck in "running" status

```sql
-- Find stuck jobs (running > 10 minutes)
UPDATE pipeline_logs
SET status = 'error', error = 'Force-closed: stuck job', ended_at = NOW()
WHERE status = 'running' AND started_at < NOW() - INTERVAL '10 minutes';
```

---

## Leaderboard Anomaly Troubleshooting

### Symptom: Trader with impossibly high ROI

1. Check the raw data:
   ```sql
   SELECT source, source_trader_id, roi, pnl, arena_score, captured_at
   FROM trader_snapshots
   WHERE source_trader_id = '<trader_key>'
   ORDER BY captured_at DESC LIMIT 5;
   ```

2. If ROI is a data error (e.g., > 5000%):
   - The `/api/rankings` route already filters `roi <= 5000` and `roi >= -5000`
   - For persistent issues, mark as outlier:
     ```sql
     UPDATE trader_snapshots SET is_outlier = true
     WHERE source_trader_id = '<trader_key>';
     ```

### Symptom: Leaderboard shows stale data

1. Check freshness of the compute-leaderboard cron:
   ```sql
   SELECT * FROM pipeline_logs
   WHERE job_name = 'compute-leaderboard'
   ORDER BY started_at DESC LIMIT 5;
   ```

2. Trigger a manual recompute (see [Manual Leaderboard Recompute](#manual-leaderboard-recompute)).

### Symptom: Duplicate traders in rankings

- The `trader_snapshots` table has a unique constraint on `(source, source_trader_id, season_id)`.
- The frontend also deduplicates 0x addresses case-insensitively.
- If duplicates appear, check for inconsistent casing in `source_trader_id`.

---

## Telegram Alert Response

Alerts are sent via `lib/alerts/send-alert.ts` with 5-minute rate limiting per platform:level.

| Alert Level | Action |
|-------------|--------|
| `info` | No action needed, informational |
| `warning` | Monitor -- check within 1 hour. Examples: 0 results returned, slow response |
| `critical` | Act immediately. Examples: 3+ consecutive failures, database unreachable |

### Common alert patterns

- **"<platform> consecutive failures 3+"**: Check platform API status, VPS proxy, and connector logs.
- **"<platform> returned 0 results"**: API may have changed or be temporarily down. Wait 1 cycle, then investigate.
- **"<platform> slow response"**: Check if the exchange is under maintenance or if VPS is overloaded.

---

## Manual Data Collection

### Trigger a single platform fetch

```bash
# Via unified connector endpoint (requires CRON_SECRET)
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://www.arenafi.org/api/cron/unified-connector?platform=hyperliquid&window=90d"
```

### Trigger batch fetch for a group

```bash
# Groups: a, a2, b, c, d1, d2, e, f, h, g1, g2, i
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://www.arenafi.org/api/cron/batch-fetch-traders?group=a"
```

### Run enrichment for a platform

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://www.arenafi.org/api/cron/batch-enrich?platform=binance_futures&period=90D"
```

### VPS Scraper manual trigger

```bash
# Bybit example (VPS SG: 45.76.152.169)
curl "http://45.76.152.169:3456/bybit/leaderboard"

# Bitget example
curl "http://45.76.152.169:3456/bitget/leaderboard"
```

---

## Manual Leaderboard Recompute

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://www.arenafi.org/api/cron/compute-leaderboard"
```

This reads from `trader_snapshots`, computes Arena Scores, and writes to `leaderboard_ranks`.

The cron normally runs every 30 minutes (`0,30 * * * *`).

---

## Arena Score Recalculation

The Arena Score formula:
- `ReturnScore = 60 * tanh(coeff * ROI)^exponent` (0-60 points)
- `PnlScore = 40 * tanh(coeff * ln(1 + PnL/base))` (0-40 points)
- `ArenaScore = (ReturnScore + PnlScore) * confidenceMultiplier * trustWeight`
- Overall composite: `90D * 0.70 + 30D * 0.25 + 7D * 0.05`

To force recalculation:

1. Trigger `compute-leaderboard` (see above).
2. For composite scores, also trigger:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" \
     "https://www.arenafi.org/api/cron/precompute-composite"
   ```

Source: `lib/utils/arena-score.ts`

---

## Deployment Rollback

### Vercel instant rollback

```bash
# List recent deployments
vercel ls

# Rollback to previous deployment
vercel rollback <deployment-url>
```

### Via Vercel dashboard

1. Go to https://vercel.com/team/ranking-arena/deployments
2. Find the last known-good deployment
3. Click "..." > "Promote to Production"

### Emergency: disable a cron job

If a cron job is causing issues, remove or comment it out in `vercel.json` and redeploy:

```bash
# Edit vercel.json, remove the problematic cron entry
git commit -am "disable broken cron: <job-name>"
git push origin main
```

---

## Database Emergency Operations

### High connection count

```sql
-- Check active connections
SELECT count(*) FROM pg_stat_activity;

-- Kill idle connections older than 5 minutes
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'idle' AND query_start < NOW() - INTERVAL '5 minutes';
```

### Slow queries

```sql
-- Find slow queries (running > 10 seconds)
SELECT pid, now() - pg_stat_activity.query_start AS duration, query
FROM pg_stat_activity
WHERE state = 'active' AND (now() - pg_stat_activity.query_start) > INTERVAL '10 seconds'
ORDER BY duration DESC;

-- Kill a specific slow query
SELECT pg_cancel_backend(<pid>);
```

### Table bloat / VACUUM

```sql
-- Check table sizes
SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC LIMIT 10;

-- Manual VACUUM (non-blocking)
VACUUM (VERBOSE) trader_snapshots;
```

**WARNING**: Never DELETE historical data (daily snapshots, equity curves, timeseries). These are retained for long-term analysis.

---

## Common Errors and Solutions

| Error | Cause | Solution |
|-------|-------|----------|
| `42P10` in upsert | Missing unique constraint on ON CONFLICT columns | Add the constraint via migration |
| `PGRST301` | JWT expired or invalid | Check Supabase keys in env vars |
| `524` from Cloudflare | Request took > 100s | Reduce batch size, use inline calls instead of HTTP sub-calls |
| `401` from VERCEL_URL | Deployment protection blocking internal calls | Use inline (in-process) calls, never HTTP sub-calls in crons |
| `429` from exchange | Rate limited | Increase backoff, use VPS proxy |
| `CircuitOpenError` | Too many consecutive failures | Wait for circuit breaker reset (60s default) |
| Redis `WRONGTYPE` | Key type mismatch from old data | Delete the key: `await redis.del(key)` |
| Build OOM | Not enough memory | Set `--max-old-space-size=3584` (already in npm scripts) |

---

## Key Infrastructure

| Resource | Value |
|----------|-------|
| **Supabase Project** | `iknktzifjdyujdccyhsv` |
| **Vercel Region** | `hnd1` (Tokyo) |
| **VPS Singapore** | `45.76.152.169` (scraper port 3456, proxy port 3001) |
| **VPS Japan** | `149.28.27.242` (proxy port 3001) |
| **CF Worker** | `ranking-arena-proxy.broosbook.workers.dev` |
| **Live Site** | `https://www.arenafi.org` |
| **Cron Schedule** | 42 active jobs, staggered across groups A-I |
| **Scraper PM2 name** | `arena-scraper` |
