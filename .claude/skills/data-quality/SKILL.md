# Skill: Data Quality Audit

## Audit Trigger
Run this audit before any enrichment work, at the start of each session, or whenever
traders complain about wrong/missing data.

## Quick Health Check (run first)
```bash
npm run check:status        # overall connector status
npm run check:freshness     # data staleness per exchange
npm run check:enrichment    # field fill rates
npm run check:platforms     # per-platform counts
```

## Known P0 Issues (as of 2026-02-23)
These are confirmed broken. Check if still open before starting any data work.

### 1. trader_daily_snapshots — 0 rows (CRITICAL)
- **Impact**: Equity curve is broken on ALL trader pages
- **Diagnosis**: `SELECT COUNT(*) FROM trader_daily_snapshots;`
- **Root cause**: Snapshot cron job never ran / schema mismatch
- **Fix pattern**: Check `app/api/cron/` for snapshot job; verify cron schedule in `vercel.json`;
  run manually: `curl /api/cron/daily-snapshots`; check for upsert conflict errors in logs

### 2. Hyperliquid — 11 days stale + WR always 0%
- **Diagnosis**: `SELECT MAX(updated_at), COUNT(*) FROM traders WHERE exchange='hyperliquid'`
- **WR=0 fix**: Check connector field mapping — raw API field for win rate vs DB column `wr`
- **Stale fix**: Check `worker/src/scrapers/hyperliquid.ts`; test standalone; check cron in `vercel.json`

### 3. GMX — 14 days stale
- **Diagnosis**: `SELECT MAX(updated_at) FROM traders WHERE exchange='gmx'`
- **Fix**: `worker/src/scrapers/gmx.ts` — connector likely failing silently; add error logging

### 4. BloFin — Cloudflare 403
- **Diagnosis**: Run connector; look for 403 in response
- **Fix options** (priority order):
  1. `puppeteer-extra` + stealth plugin
  2. Residential proxy via `PROXY_URL` env var
  3. BloFin official API (check docs.blofin.com)

### 5. dYdX — WR/MDD null + ROI semantic error
- **WR/MDD null**: Fields exist in API but not mapped in connector
- **ROI error**: Current value is total return; should be annualized or labeled correctly
  - Fix: change DB column label OR recalculate as `(total_return / days) * 365`

### 6. BitMart — connector never ran
- **Diagnosis**: `SELECT COUNT(*) FROM traders WHERE exchange='bitmart'` → likely 0
- **Fix**: Check `worker/src/scrapers/bitmart.ts` exists; add to cron schedule in `vercel.json`

### 7. Sharpe/Sortino/avg_holding — <10% global fill rate
- **Diagnosis**: `SELECT COUNT(*) FILTER (WHERE sharpe IS NOT NULL) / COUNT(*)::float FROM traders`
- **Fix**: These metrics require position history — check if position history pipeline runs;
  calculate from `trader_positions` if available

### 8. BingX futures — only 3 rows
- **Diagnosis**: `SELECT COUNT(*), MAX(updated_at) FROM traders WHERE exchange='bingx' AND type='futures'`
- **Fix**: Check BingX futures scraper; different endpoint from spot

### 9. Gains — upsert losing 497/500 rows
- **Diagnosis**: Check upsert conflict key in connector vs actual unique constraint:
  ```sql
  SELECT indexname, indexdef FROM pg_indexes WHERE tablename='traders' AND indexdef LIKE '%unique%';
  ```
- **Fix pattern**: The conflict key in `.upsert(rows, { onConflict: 'uid,exchange' })` must
  exactly match the DB unique constraint. If constraint is `(uid, exchange, date)`, update the upsert call.

## Systematic Audit Procedure

### Step 1: Freshness audit
```sql
SELECT exchange,
       COUNT(*) AS trader_count,
       MAX(updated_at) AS last_update,
       NOW() - MAX(updated_at) AS staleness
FROM traders
GROUP BY exchange
ORDER BY staleness DESC;
```
Flag any exchange with staleness > 24h.

### Step 2: Field fill rate audit
```sql
SELECT
  exchange,
  COUNT(*) AS total,
  ROUND(100.0 * COUNT(wr) / COUNT(*), 1) AS wr_pct,
  ROUND(100.0 * COUNT(mdd) / COUNT(*), 1) AS mdd_pct,
  ROUND(100.0 * COUNT(sharpe) / COUNT(*), 1) AS sharpe_pct,
  ROUND(100.0 * COUNT(roi) / COUNT(*), 1) AS roi_pct,
  ROUND(100.0 * COUNT(avatar_url) / COUNT(*), 1) AS avatar_pct
FROM traders
GROUP BY exchange
ORDER BY exchange;
```
Target: all fields >80% fill rate.

### Step 3: Snapshot audit
```sql
SELECT DATE(snapshot_date), COUNT(*) FROM trader_daily_snapshots
GROUP BY 1 ORDER BY 1 DESC LIMIT 7;
```
Should have rows for each of the last 7 days.

### Step 4: Sample-verify values (avoid trusting counts alone)
```sql
-- Spot-check Hyperliquid WR values
SELECT handle, wr, roi, mdd, updated_at FROM traders
WHERE exchange='hyperliquid' LIMIT 10;

-- Check Gains data integrity
SELECT uid, exchange, roi, updated_at FROM traders
WHERE exchange='gains' ORDER BY updated_at DESC LIMIT 10;
```

## Enrichment Script Debug Pattern
1. Run script with `--dry-run` flag first
2. Add `console.log('fetched:', JSON.stringify(row, null, 2))` for first row
3. Verify field names match DB columns exactly
4. Verify upsert conflict key matches DB unique constraint
5. Check concurrency — reduce to 1 to isolate rate-limit issues

## Sub-Agent Task Template for Data Audits
When spawning a sub-agent for data quality work:
- Scope: ONE exchange at a time
- Do NOT touch: other connectors, UI components, migrations
- Required output: fill rate before/after, SQL verification query, dry-run logs
- Verification: run audit queries above after fix; include counts in commit message

## End-of-Audit Checklist
- [ ] Freshness: all exchanges updated within 24h
- [ ] Fill rates: WR, MDD, ROI >80% per exchange
- [ ] Snapshots: last 7 days have data
- [ ] Spot-check: 5 rows per exchange visually verified
- [ ] Document findings in `docs/session-notes/YYYY-MM-DD.md`
