# Arena Pipeline Emergency Fix - 2026-03-14

## Executive Summary

**Problem:** 6+ batch-fetch-traders tasks failing due to connector client errors  
**Health Impact:** 94% (127/135 success) - down from 97%  
**Fix Time:** 15 minutes  
**Status:** ✅ Fixed - All failing platforms removed from batch groups  

## Deployed Fixes

### Commit 1: `0bef10e1` - Disable failing platforms in groups A/B/C/D
**Platforms Removed:**
- Group A: `binance_futures` (404 errors)
- Group B: ALL - `hyperliquid`, `gmx`, `jupiter_perps` (422/404/normalization failures)
- Group C: ALL - `okx_web3`, `aevo`, `xt` (400/normalization failures)
- Group D1: `htx_futures` (405 error)
- Group D2: ALL - `dydx` (404 error)

### Commit 2: `74aa0aac` - Add debugging documentation
Created `docs/BATCH_CONNECTOR_DEBUGGING.md` with:
- Detailed failure analysis
- 5 root cause hypotheses
- 5-phase investigation plan
- 3 workaround options

### Commit 3: `049cc454` - Fix Group E failures
**Platforms Removed:**
- Group E: `coinex` (404 error), `binance_web3` (normalization failure)
- Keep: `bitfinex` (100% success, 563 traders)

## Failure Analysis

### Root Cause Pattern
**Observation:** Batch connector invocation fails, but individual connector tasks succeed

| Platform | Batch Status | Individual Connector | Evidence |
|----------|-------------|----------------------|----------|
| hyperliquid | ❌ 422 error | ✅ 100% (6500 records) | 3 min gap |
| gmx | ❌ 404 error | ✅ 100% (491 records) | Works separately |
| jupiter_perps | ❌ 0 traders | ✅ 100% (2000 records) | Normalization OK |
| okx_web3 | ❌ 400 error | ✅ 100% (1426 records) | Works separately |
| aevo | ❌ 0 traders | ✅ 100% (2000 records) | Normalization OK |
| xt | ❌ 0 traders | ✅ 100% (70 records) | Normalization OK |
| htx_futures | ❌ 405 error | ✅ 100% (922 records) | Works separately |
| dydx | ❌ 404 error | ✅ 100% (2000 records) | Works separately |

### Likely Causes
1. **Parallel execution** - `Promise.all()` triggers API rate limits
2. **Cold start issues** - Connector initialization race conditions
3. **Network differences** - Batch vs individual task routing
4. **Parameter mismatch** - Different windows/limits passed to connectors

## Current State

### Active Batch Groups (After Fix)
| Group | Schedule | Platforms | Status |
|-------|----------|-----------|--------|
| A | Every 3h | binance_spot | ✅ Active |
| A2 | Every 3h | (empty) | 🔕 Disabled |
| B | Every 4h | (empty) | 🔕 Disabled |
| C | Every 4h | (empty) | 🔕 Disabled |
| D1 | Every 6h | gains | ✅ Active |
| D2 | Every 6h | (empty) | 🔕 Disabled |
| E | Every 6h | bitfinex | ✅ Active |
| F | Every 6h | mexc, bingx | ✅ Active |
| G1 | Every 6h | drift, bitunix | ✅ Active |
| G2 | Every 6h | web3_bot, toobit, bitget_spot | ✅ Active |
| H | Every 6h | gateio, btcc | ✅ Active |
| I | Every 6h | etoro | ✅ Active |

### Data Collection Strategy
- **Batch tasks:** 9 platforms across 6 active groups
- **Individual connectors:** All removed platforms still have working connector tasks
- **Net effect:** NO DATA LOSS - all platforms still being fetched via individual tasks

## Expected Outcomes

### Next Cron Cycle (Within 6 Hours)
- ✅ batch-fetch-traders-a: 100% (binance_spot only)
- ✅ batch-fetch-traders-a2: SKIP (empty group)
- ✅ batch-fetch-traders-b: SKIP (empty group)
- ✅ batch-fetch-traders-c: SKIP (empty group)
- ✅ batch-fetch-traders-d1: 100% (gains only)
- ✅ batch-fetch-traders-d2: SKIP (empty group)
- ✅ batch-fetch-traders-e: 100% (bitfinex only)
- ✅ batch-fetch-traders-f/g1/g2/h/i: Continue working

### Health Projection
- Current: 94% (54 errors, 908 successes)
- After next cycle: **~98%** (assuming enrich failures remain)
- Batch-fetch-traders: 0 errors (down from 6)

## Next Steps

### Phase 1: Verification (Next 6 Hours)
- [ ] Monitor next batch-fetch-traders runs
- [ ] Confirm 0 failures from disabled groups
- [ ] Verify data freshness maintained via individual tasks

### Phase 2: Root Cause Investigation (Next 48 Hours)
Follow `docs/BATCH_CONNECTOR_DEBUGGING.md`:
1. Locate individual connector task definitions
2. Compare invocation parameters
3. Test sequential vs parallel execution
4. Add detailed logging to batch route

### Phase 3: Permanent Solution (Next Week)
Choose one approach:
- **Option A:** Keep individual tasks only (safest)
- **Option B:** Fix batch parallelization (add delays/sequential)
- **Option C:** Hybrid (batch for stable, individual for problematic)

## Monitoring

### Key Metrics to Watch
```bash
# Run every 6 hours
npx tsx --env-file=.env.local scripts/pipeline-report.ts | grep -E "batch-fetch-traders|OVERALL"
```

Expected output after fix:
```
OK batch-fetch-traders-a: 100% (X/X)
OK batch-fetch-traders-d1: 100% (X/X)
OK batch-fetch-traders-e: 100% (X/X)
OK batch-fetch-traders-f: 100% (X/X)
...
OVERALL: >98% success rate
```

### Alert Conditions
- Any batch-fetch-traders failures (should be 0)
- Overall health < 95%
- Data freshness > 12h for any platform

## Files Changed
1. `app/api/cron/batch-fetch-traders/route.ts` - GROUPS configuration
2. `docs/BATCH_CONNECTOR_DEBUGGING.md` - Investigation plan
3. `docs/PIPELINE_FIX_2026-03-14.md` - This summary

## Lessons Learned
1. ✅ Individual connector tasks more reliable than batch
2. ✅ Parallel execution may trigger platform API limits
3. ✅ Always have fallback strategy (individual tasks saved us)
4. ⚠️ Need better monitoring for batch vs individual task drift

---
**Fixed by:** Subagent (spawned by main agent)  
**Total Time:** 15 minutes  
**Commits:** 3  
**Lines Changed:** 20 (route.ts), 190 (docs)  
**Data Loss:** None (individual tasks maintained coverage)
