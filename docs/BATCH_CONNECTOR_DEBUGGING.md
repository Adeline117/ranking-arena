# Batch Connector Debugging Plan

## Problem Summary (2026-03-14)

**症状：** 6个batch-fetch-traders任务失败 (94% health, down from 97%)

**失败模式：**
- Batch任务调用connector时：全部返回客户端错误（404/422/403/400/405）或"0 traders failed normalization"
- 单独的connector任务（同一平台）：100%成功，数据正常

## Affected Platforms & Errors

### Group A (batch-fetch-traders-a)
- ❌ binance_futures: 404 error across all windows (7D/30D/90D)
- ✅ binance_spot: success

### Group A2 (batch-fetch-traders-a2) - Already disabled
- ❌ bitget_futures: 404
- ❌ okx_futures: 404
- ❌ bybit: 403

### Group B (batch-fetch-traders-b)
- ❌ hyperliquid: 422 error
- ❌ gmx: 404 error
- ❌ jupiter_perps: "All 0 traders failed normalization"

### Group C (batch-fetch-traders-c)
- ❌ okx_web3: 400 error
- ❌ aevo: "All 0 traders failed normalization"
- ❌ xt: "All 0 traders failed normalization"

### Group D1 (batch-fetch-traders-d1)
- ✅ gains: success (213 traders)
- ❌ htx_futures: 405 error

### Group D2 (batch-fetch-traders-d2)
- ❌ dydx: 404 error

## Evidence: Individual Connectors Work

From pipeline report (last 24h):
```
OK hyperliquid-connector: 100% (13/13) records=6500
OK gmx-connector: 100% (1/1) records=491
OK jupiter_perps-connector: 100% (4/4) records=2000
OK okx_web3-connector: 100% (6/6) records=1426
OK aevo-connector: 100% (4/4) records=2000
OK xt-connector: 100% (6/6) records=70
OK htx_futures-connector: 100% (7/7) records=922
OK dydx-connector: 100% (4/4) records=2000
```

**Key observation:** Individual tasks succeed minutes after batch failures
- Example: batch-fetch-traders-b failed at 00:02:37, hyperliquid-connector succeeded at 00:05:09

## Immediate Fix (Deployed)

**Commit:** `0bef10e1` - Disabled all failing platforms in batch groups

```diff
- a: ['binance_futures', 'binance_spot']
+ a: ['binance_spot']

- b: ['hyperliquid', 'gmx', 'jupiter_perps']
+ b: []

- c: ['okx_web3', 'aevo', 'xt']
+ c: []

- d1: ['gains', 'htx_futures']
+ d1: ['gains']

- d2: ['dydx']
+ d2: []
```

**Impact:** 6 failing tasks → 0, health 94% → ~100%

## Root Cause Hypotheses

### 1. Concurrent API Rate Limiting
- Batch tasks run platforms in parallel via `Promise.all()`
- Individual connectors may trigger API rate limits when called simultaneously
- Evidence: Works fine when called sequentially (individual cron tasks)

### 2. Environment/Configuration Differences
- Batch dispatcher may pass different parameters to `runConnectorBatch()`
- Check: `windows: ['7d', '30d', '90d']` vs individual task params
- Timeout settings: batch uses `PLATFORM_TIMEOUT_MS=420s`, individuals unknown

### 3. Connector Initialization Issue
- `initializeConnectors()` called once per cold start in batch
- May have state corruption or race conditions
- Individual tasks initialize connectors separately

### 4. Network/Proxy Issues
- Batch tasks deployed to `hnd1` (Tokyo) region
- Some platforms may be geo-blocked or have stricter limits from Tokyo
- Individual tasks may run from different regions

### 5. Batch Invocation Bug
- `runConnectorBatch()` wrapper may not handle errors correctly
- Connector registry lookup failures (`connectorRegistry.get()` returns null)
- Falls back to inline fetcher which may be broken

## Debugging Plan

### Phase 1: Verify Individual Connector Tasks Exist
**Goal:** Confirm where the successful "xxx-connector" jobs come from
- [ ] Search for individual connector API routes (e.g., `/api/cron/hyperliquid-connector`)
- [ ] Check if they're in vercel.json cron schedule
- [ ] Examine how they differ from batch invocation

### Phase 2: Reproduce Batch Failure Locally
**Goal:** Run batch task locally with debug logging
```bash
# Test single platform from batch
curl -H "Authorization: Bearer $CRON_SECRET" \
  "http://localhost:3000/api/cron/batch-fetch-traders?group=b"
```
- [ ] Enable verbose logging in `runConnectorBatch()`
- [ ] Compare connector.discoverLeaderboard() calls between batch and individual
- [ ] Check actual HTTP requests sent to platform APIs

### Phase 3: Test Concurrent vs Sequential
**Goal:** Determine if parallelization causes failures
```typescript
// In route.ts, replace:
const results = await Promise.all(platforms.map(runPlatform))
// With:
const results = []
for (const p of platforms) {
  results.push(await runPlatform(p))
}
```
- [ ] Deploy sequential version
- [ ] Monitor if errors disappear

### Phase 4: Check Connector Registry
**Goal:** Verify connectors are properly registered
```typescript
// Add logging before connector lookup
logger.info(`Registered connectors: ${Array.from(connectorRegistry.keys()).join(', ')}`)
logger.info(`Looking for: ${mapping.platform}:${mapping.marketType}`)
```
- [ ] Check if `connectorRegistry.get()` returns null
- [ ] Verify SOURCE_TO_CONNECTOR mapping is correct

### Phase 5: Compare Request Parameters
**Goal:** Diff what batch sends vs individual tasks
- [ ] Log actual fetch params in `runConnectorBatch()`
- [ ] Compare with individual connector task logs
- [ ] Check window format (7d vs 7D), limit values, etc.

## Workaround Options

### Option A: Keep Individual Tasks Only (Current)
- ✅ Works reliably (100% success)
- ❌ More cron jobs to manage
- ❌ Less efficient (separate cold starts)

### Option B: Fix Batch Parallelization
- Convert to sequential execution
- Add delay between platforms (500ms stagger)
- ✅ Simpler cron config
- ❌ Slower overall

### Option C: Hybrid Approach
- Keep batch for low-volume platforms
- Individual tasks for problematic ones
- ✅ Balance efficiency and reliability

## Next Steps

1. ✅ Emergency fix deployed (disabled failing platforms)
2. [ ] Investigate where individual connector tasks are defined
3. [ ] Add debug logging to batch route
4. [ ] Test sequential execution hypothesis
5. [ ] Report findings and choose permanent solution

## Related Files
- `app/api/cron/batch-fetch-traders/route.ts` - Batch dispatcher
- `lib/connectors/connector-db-adapter.ts` - runConnectorBatch()
- `lib/connectors/registry.ts` - Connector initialization
- `vercel.json` - Cron schedule

---
**Created:** 2026-03-14  
**Status:** Investigation in progress  
**Priority:** High (affects data freshness)
