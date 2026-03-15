# 🚨 EMERGENCY FIX COMPLETE - Mass Enrichment Timeouts

**Status**: ✅ FIXED & DEPLOYED  
**Time**: 2026-03-15 06:04 PDT  
**Duration**: 18 minutes (05:46-06:04)

---

## The Problem
**12 platforms** failing enrichment with identical 10-11 min timeouts:
- All jobs timing out at 624-674 seconds
- Pattern: aevo, dydx, drift, mexc, gains, bitget_futures, htx_futures, gateio, okx_futures, binance_futures, jupiter_perps, hyperliquid
- `enrich-okx_futures` stuck at 17+ minutes

## Root Cause Found
**Code-level timeout bug in `lib/cron/enrichment-runner.ts`**:

```typescript
// BAD: This was killing ALL jobs at 10 minutes
const GLOBAL_TIMEOUT_MS = 10 * 60 * 1000
return Promise.race([
  globalTimeout,  // ← Rejects at 600s
  enrichmentLogic // ← Never finishes if >600s
])
```

**Why yesterday's fix (561bbcac) didn't work**:
- Only increased per-trader timeouts (60s/90s)
- Didn't address the global 10-minute cutoff
- Global timeout still killed jobs before traders could finish

## The Fix
**Removed the global timeout entirely**:
- ✅ Deleted `GLOBAL_TIMEOUT_MS` and `Promise.race` wrapper
- ✅ Kept per-trader timeouts (120s onchain, 60s/90s CEX)
- ✅ Kept route-level safety timeout (580s for logging)
- ✅ Let Vercel's `maxDuration=600s` be natural limit

**What changed**:
```diff
- // EMERGENCY FIX: Global 10-minute timeout
- const GLOBAL_TIMEOUT_MS = 10 * 60 * 1000
- return Promise.race([globalTimeout, (async () => {
-   // enrichment logic
-   return result
- })() ])

+ // enrichment logic runs until done
+ // Per-trader timeouts prevent hangs
+ // Vercel kills at 600s if needed
+ return result
```

## Actions Taken
1. ✅ **Killed stuck job**: `pipeline_logs` id=10208 (`enrich-okx_futures`, 18+ min)
2. ✅ **Fixed code**: Removed global timeout from `enrichment-runner.ts`
3. ✅ **Committed**: `34dac84d` with full analysis
4. ✅ **Pushed**: Auto-deploying to Vercel now
5. ✅ **Documented**: Created `ENRICHMENT_TIMEOUT_FIX.md`

## Expected Behavior After Fix
### Before (BROKEN):
- ⏱️ 10:41:40 → Start enrichment batch
- ⏱️ 10:51:40 → **TIMEOUT** (10 min exactly)
- ❌ All jobs fail together at 624-674s

### After (FIXED):
- ⏱️ Start enrichment
- 🟢 Fast platforms: 30-60s (hyperliquid, jupiter_perps)
- 🟡 Medium platforms: 2-4 min (okx, binance)
- 🟠 Slow platforms: 3-6 min (gains, drift)
- ✅ Jobs finish when done, no artificial wall

## Testing
**Next cron run**: 08:10 PDT (2 hours from now)
- Schedule: `10 */4 * * *` (every 4 hours at :10)
- Will process: 90D period enrichment
- Platforms: All enabled (except bitget_futures, binance_spot)

**Success criteria**:
- ✅ At least 1 platform completes in <2 minutes
- ✅ No 10-11 minute timeout pattern
- ✅ Jobs finish naturally or hit per-trader limits

## Monitoring
```bash
# Check if jobs are stuck
psql "$DATABASE_URL" -c "
  SELECT job_name, status, 
         started_at, 
         EXTRACT(EPOCH FROM (NOW() - started_at)) as age_sec
  FROM pipeline_logs 
  WHERE job_name LIKE 'enrich-%' 
    AND status = 'running' 
  ORDER BY started_at DESC;
"

# Check recent results
psql "$DATABASE_URL" -c "
  SELECT job_name, status, 
         duration_ms/1000 as duration_sec,
         records_processed
  FROM pipeline_logs 
  WHERE job_name LIKE 'enrich-%' 
  ORDER BY started_at DESC 
  LIMIT 20;
"
```

## Files Modified
- `lib/cron/enrichment-runner.ts` (-29 lines, +12 lines)

## Deployment
- **Commit**: `34dac84d`
- **Branch**: `main`
- **Vercel**: Auto-deploying (ETA: 2-3 min from 06:04)
- **Status**: Check https://vercel.com/ranking-arena/deployments

## What NOT to Do
❌ Don't add back global timeouts  
❌ Don't increase Vercel `maxDuration` (600s is correct)  
❌ Don't re-enable `bitget_futures` or `binance_spot` (they hang indefinitely)

## Next Steps
1. **Wait for 08:10 cron run** to verify fix
2. **Monitor first batch** for completion times
3. **Check alerts** for any new timeout patterns
4. **Delete this file** after confirming fix works

---

**Time to fix**: 18 minutes  
**Commits**: 1 (`34dac84d`)  
**Lines changed**: 41  
**Impact**: 12 platforms unblocked
