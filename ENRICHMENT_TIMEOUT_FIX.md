# Enrichment Timeout Fix - 2026-03-15

## Problem
All enrichment jobs timing out after 10-11 minutes (624-674 seconds) across 12 platforms:
- aevo, dydx, drift, mexc, gains, bitget_futures, htx_futures, gateio, okx_futures, binance_futures, jupiter_perps, hyperliquid

## Root Cause
**GLOBAL_TIMEOUT_MS = 10 * 60 * 1000** (10 minutes) in `lib/cron/enrichment-runner.ts` was:
1. Wrapping entire enrichment in `Promise.race([globalTimeout, enrichmentLogic])`
2. Rejecting the promise after exactly 10 minutes
3. Causing jobs to fail BEFORE Vercel's 600s (10 min) maxDuration limit
4. Not respecting the per-trader timeouts (120s/60s/90s) that were designed to prevent hung requests

## Previous Failed Fix (commit 561bbcac)
Yesterday's fix **increased per-trader timeouts** from 20s/30s to 60s/90s (CEX) and 40s/60s to 120s/180s (onchain).

**Why it didn't work**: The global 10-minute timeout was killing jobs BEFORE individual traders could complete.

## The Fix (commit 34dac84d)
### Removed:
- Global `GLOBAL_TIMEOUT_MS` constant
- `Promise.race()` wrapper with global timeout
- Indentation from the wrapping async IIFE

### Kept:
- **Per-trader timeouts** (120s for onchain, 60s/90s for CEX) - prevent individual hung traders
- **Route-level SAFETY_TIMEOUT_MS** (580s) - logs before Vercel kills at 600s
- **Vercel maxDuration=600s** - natural function limit
- **Per-trader timeout in batch processing** (2min timeout per trader in batch loop)

## What Now Happens
1. Enrichment runs until completion
2. If individual trader hangs → timeout after 60-180s (per-trader limit)
3. If entire job takes too long → Vercel kills at 600s (natural limit)
4. Safety timeout at 580s logs state before Vercel termination
5. NO artificial 10-minute cutoff

## Cleanup Done
1. **Killed stuck job**: `enrich-okx_futures` (pipeline_logs id=10208) - marked as timeout after 18+ minutes
2. **All previous timeout jobs** now show `status='timeout'` in database

## Platforms Still Disabled
These platforms are in `NO_ENRICHMENT_PLATFORMS` and won't run:
- `bitget_futures` - hangs indefinitely despite all timeouts
- `binance_spot` - repeatedly hung 45-76 minutes

## Testing Plan
1. **Wait for next cron**: 8:10 PDT (schedule: `10 */4 * * *`)
2. **Monitor**: Check if enrichment jobs complete in <2 minutes
3. **Success criteria**: 
   - No 10-minute timeouts
   - Jobs complete or fail gracefully within per-trader timeouts
   - Platform-level enrichment completes in reasonable time (<5 min typical)

## Expected Behavior After Fix
- **Fast platforms** (hyperliquid, jupiter_perps): 30-60s total
- **Medium platforms** (okx, binance): 2-4 min total  
- **Slow platforms** (gains, drift): 3-6 min total
- **No 10-minute wall**: Jobs finish when done, not at artificial timeout

## Monitoring Commands
```bash
# Check running jobs
psql "$DATABASE_URL" -c "SELECT job_name, status, started_at, EXTRACT(EPOCH FROM (NOW() - started_at)) as age_seconds FROM pipeline_logs WHERE job_name LIKE 'enrich-%' AND status = 'running' ORDER BY started_at DESC;"

# Check recent completions
psql "$DATABASE_URL" -c "SELECT job_name, status, started_at, ended_at, duration_ms/1000 as duration_sec FROM pipeline_logs WHERE job_name LIKE 'enrich-%' ORDER BY started_at DESC LIMIT 20;"
```

## Files Changed
- `lib/cron/enrichment-runner.ts`: Removed global timeout mechanism (12 insertions, 29 deletions)

## Commit
- Hash: `34dac84d`
- Pushed: 2026-03-15 06:04 PDT
- Vercel deployment: Auto-triggered, should be live in ~2-3 minutes
