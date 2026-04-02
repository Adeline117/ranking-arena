# Arena Pipeline Critical Fix - Diagnosis Report
**Date**: 2026-04-02 13:33 PDT
**Subagent**: Pipeline Critical Fix

## ✅ FIXED: Build Timeout Issue

### Problem
Vercel deployments were failing during static page generation:
- `/market/funding-rates` - timeout after 3 attempts
- `/market/open-interest` - timeout after 3 attempts  
- `/library` - timeout after 2 attempts
- Build killed after exceeding 60s per-page limit

### Solution Applied
Added `export const dynamic = 'force-dynamic'` to force runtime rendering instead of build-time static generation.

**Files modified:**
- `app/market/funding-rates/page.tsx`
- `app/market/open-interest/page.tsx`
- `app/library/page.tsx`

**Result:**
- Build time: 2m (vs 4m46s timeout before)
- Status: **✅ Ready** (latest deployment successful)
- Commit: `0483cd1b3`

---

## ⚠️ ONGOING: Runtime Platform Timeout Issues

### Failed Jobs (Last 24h)
From `pipeline_logs` table query:

**batch-fetch-traders failures:**
- **a1**: binance_futures, binance_spot (timed out after 70s)
- **b**: bitget_futures, bitget_spot, bybit, bybit_spot (4/4 failed)
- **c**: gmx, bitunix, hyperliquid (3/3 failed)

**Other failures:**
- `enrich-bybit`: 6/6 enrichments failed
- `enrich-etoro`: 30/37 enrichments failed
- `sync-meilisearch`: Supabase statement timeout
- `compute-leaderboard`: degradation detected (30D)

### Health Check Status
✅ **Pipeline health check** (run 13:33 PDT):
- 19/19 platforms showing fresh data (1-8h old)
- 0 stuck tasks currently
- 6 enrichment connectors missing error handling (warnings only)

### Analysis

**Timeout Pattern:**
- Platforms timing out at 60-70s (below 140s dynamic limit)
- Suggests external API issues, not code bugs
- Possible causes:
  1. Geo-blocking from Tokyo region (Vercel hnd1)
  2. Exchange API rate limiting
  3. VPS backup cron not running

**VPS Status:**
- VPS IP: 45.76.152.169 (Singapore)
- Purpose: Backup crons for geo-blocked platforms
- Status: **NOT CHECKED** (no SSH access from current session)

### Recommendations

1. **Check VPS cron status** (SSH to 45.76.152.169):
   ```bash
   crontab -l
   systemctl status cron
   tail -100 /var/log/syslog | grep CRON
   ```

2. **Verify VPS is feeding data**:
   - Check if phemex, lbank, blofin have recent data
   - These should only run from VPS (group g)

3. **Consider region change**:
   - Current: `hnd1` (Tokyo)
   - Alternative: `sin1` (Singapore) - closer to VPS
   - Or: `iad1` (US East) - avoid Asia geo-blocking

4. **Platform-specific fixes**:
   - Binance: Check if Vercel IP is geo-blocked
   - Bitget/Bybit: VPS scraper may be down
   - GMX/Hyperliquid: Subgraph timeouts

5. **Monitor freshness**:
   - Enable `/api/cron/check-data-freshness` alerts
   - Set up Telegram notifications for consecutive failures

---

## Summary

| Issue | Status | Action |
|-------|--------|--------|
| Build timeouts | ✅ FIXED | Deployed, monitoring |
| Platform fetch timeouts | ⚠️ ONGOING | VPS check needed |
| Data freshness | ✅ OK | 19/19 platforms fresh |
| Stuck jobs | ✅ OK | 0 currently stuck |

**Next Steps:**
1. SSH to VPS and verify cron health
2. Check Vercel function logs for specific timeout errors
3. Consider region migration if geo-blocking confirmed
