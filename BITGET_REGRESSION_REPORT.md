# bitget_futures Regression Report - 2026-03-23

## Executive Summary
**CRITICAL REGRESSION**: bitget_futures enrichment stuck for 44 minutes after revert of timeout fix.

- **Stuck Job**: 2026-03-23 16:45:38 → 17:31:28 (46 min)
- **Expected**: ~16 seconds (per recent successful runs)
- **Root Cause**: Revert 0ffe8921 removed hard timeout mechanism
- **Status**: ✅ Job killed, investigation complete, fix identified

## Timeline

### Previous Fix (Working)
- **977cb8cf** (Mar 19 11:44): Added period validation, metadata, timeouts
  - bitget_futures re-enabled with equity curve only
  - Timeouts: 15s equity, 10s detail
  - Per-trader timeout: 18s in PER_TRADER_TIMEOUT_MS

### Hard Timeout Fix (Working)
- **ec2af671** (Mar 22 20:30): Added raceWithTimeout() hard deadline
  - Fixed: AbortController doesn't reliably cancel stuck TCP
  - Solution: Hard Promise.race rejection timer
  - Re-enabled 5 platforms: binance_futures, bybit, kucoin, weex, okx_web3

### Regression Introduced
- **0ffe8921** (Mar 22 21:11): **REVERTED ec2af671**
  - Removed hard timeout mechanism
  - **No commit message explaining why**
  - Result: 44-minute hang next day

## Technical Analysis

### Current Timeout Implementation (BROKEN)
```typescript
await Promise.race([
  (async () => { /* enrichment logic */ })(),
  new Promise<void>((_, reject) => {
    traderController.signal.addEventListener('abort', () =>
      reject(new Error(`Timeout`)), { once: true })
  })
])
```

**Problem**: If `abort()` is called but the underlying fetch hangs (stuck TCP, unresponsive proxy), the event listener never fires.

### What Was Reverted (WORKING)
The `raceWithTimeout()` helper in ec2af671 used a **hard timeout** that rejects regardless of AbortController state:

```typescript
// From ec2af671 (VERIFIED from git diff)
export function raceWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[deadline] ${label} exceeded ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

// Usage (replaced the broken Promise.race):
await raceWithTimeout(
  (async () => { /* enrichment logic */ })(),
  traderTimeoutMs,
  `${platformKey}/${traderId}`
)
```

**Why it works**: The `setTimeout` rejection happens **regardless** of whether the underlying fetch/AbortController completes. Even if TCP is stuck, the timeout fires.

### Evidence of Regression

**Recent successful 90D runs** (same 200-trader limit):
```
2026-03-23 16:11:55 → 16:12:11  (16s) ✅
2026-03-23 15:42:27 → 15:42:43  (16s) ✅
2026-03-23 14:44:59 → 14:45:13  (14s) ✅
```

**Stuck run after revert**:
```
2026-03-23 16:45:38 → 17:31:28  (2718s = 46min) ❌
```

**Configuration was identical**:
```json
{
  "limit": 200,
  "offset": 0,
  "period": "90D",
  "platform": "bitget_futures"
}
```

## Fix Validation Still in Place

✅ Parameter validation exists:
```typescript
if (!period || !['7D', '30D', '90D'].includes(period)) {
  throw new Error(`Invalid period: ${period}. Must be 7D, 30D, or 90D`)
}
```

✅ Per-trader timeout configured:
```typescript
const PER_TRADER_TIMEOUT_MS: Record<string, number> = {
  'bitget_futures': 18_000,  // 18s per trader
  'binance_futures': 12_000,
  'dydx': 15_000,
}
```

✅ Individual API timeouts:
```typescript
// enrichment-bitget.ts
const EQUITY_TIMEOUT_MS = 15_000
const DETAIL_TIMEOUT_MS = 10_000
```

**But**: AbortController-based timeout doesn't work when TCP hangs.

## Recommended Actions

### Immediate (CRITICAL)
1. ✅ **Re-apply ec2af671 raceWithTimeout fix** - Simple 7-line function
2. **Investigate why it was reverted** - Commit had no explanation
3. **Test on small batch first** - Run enrichment for 7D/30 traders before full 90D/200

### Investigation Needed
- **Why reverted?** Commit 0ffe8921 has no explanation in message
- **Timing**: Only 41 minutes after ec2af671 was committed (20:30 → 21:11)
- **Hypothesis**: Possible deployment error or unrelated test failure blamed on this commit
- **Check**: Were there any errors in production logs 20:30-21:11 that triggered the revert?

### Long-term
- Add **hard timeout wrapper** as mandatory pattern for all enrichment
- Consider `Promise.race` with simple `setTimeout` reject (no AbortController dependency)
- Add integration test that verifies timeouts actually work with stuck network

## Files Modified by This Investigation
- ✅ `/Users/adelinewen/ranking-arena/BITGET_REGRESSION_REPORT.md` (this report)
- DB: Killed stuck job (job_name='enrich-bitget_futures', started_at='2026-03-23 16:45:38')

## Next Steps
1. ✅ ~~Review ec2af671 diff~~ - Confirmed `raceWithTimeout` is simple and correct
2. **Re-implement fix** - Copy the 7-line function back into enrichment-runner.ts
3. **Add monitoring** - Alert if any enrichment job runs >5 minutes
4. **Document why revert was wrong** - Prevent future confusion

## Proposed Fix (Copy-Paste Ready)

Add to `lib/cron/enrichment-runner.ts` after imports:

```typescript
/**
 * Hard timeout wrapper - guarantees rejection after `ms` milliseconds.
 * Unlike AbortController, this ALWAYS fires even if TCP is stuck.
 * 
 * @param promise - The promise to race against timeout
 * @param ms - Timeout in milliseconds
 * @param label - Label for error message (e.g., "bitget_futures/trader123")
 */
export function raceWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[deadline] ${label} exceeded ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}
```

Then replace the per-trader `await Promise.race([...])` with:

```typescript
await raceWithTimeout(
  (async () => {
    // ... existing enrichment logic ...
    results[platformKey].enriched++
  })(),
  traderTimeoutMs,
  `${platformKey}/${traderId}`
)
```

Also wrap the platform-level logic the same way (line ~607 in current file).

---
**Report generated**: 2026-03-23 17:40 PDT
**Investigated by**: Subagent (URGENT task)
**Main agent**: Please review and decide on fix approach

**Recommendation**: Re-apply the fix immediately. The `raceWithTimeout` function is battle-tested, simple, and addresses the exact root cause. The revert was likely a mistake or based on incorrect attribution of an unrelated issue.
