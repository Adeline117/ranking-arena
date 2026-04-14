# Spec: Batch Enrichment-to-V2 Sync

## Problem
`upsertStatsDetail()` in `enrichment-db.ts` does a per-row UPDATE to `trader_snapshots_v2` for each enriched trader. With 2,742 calls averaging 3.9s each, this consumes **10,822 seconds** of DB time per day — the #1 performance bottleneck.

## Root Cause
Each enrichment call chain:
1. `enrichment-runner.ts:884` calls `upsertStatsDetail(supabase, platform, traderId, period, stats)`
2. `enrichment-db.ts:197` writes to `trader_stats_detail` (upsert, fast)
3. `enrichment-db.ts:251` writes to `trader_snapshots_v2` (per-row UPDATE, **slow**)
4. `enrichment-db.ts:272` retries with previous hour window (another UPDATE, **slow**)

Step 3-4 is the bottleneck: 2 UPDATE queries per trader, each ~2-4s due to index updates on the 8.7GB April partition.

## Solution: Batch V2 Sync via RPC

### Phase 1: Add skipV2Sync option to upsertStatsDetail
```typescript
// enrichment-db.ts
export async function upsertStatsDetail(
  supabase, source, traderId, period, stats,
  options?: { skipV2Sync?: boolean }  // NEW
): Promise<{ saved: boolean; v2Update?: V2UpdatePayload }> {
  // ... existing trader_stats_detail upsert ...

  if (options?.skipV2Sync) {
    // Return the update payload instead of executing it
    return { saved: true, v2Update: { platform: source, trader_key: traderId, window: period, ...v2Update } }
  }
  // ... existing per-row UPDATE (backward compat) ...
}
```

### Phase 2: Collect updates in enrichment-runner
```typescript
// enrichment-runner.ts, inside the platform loop
const pendingV2Syncs: V2UpdatePayload[] = []

// For each trader:
const result = await upsertStatsDetail(supabase, platform, traderId, period, stats, { skipV2Sync: true })
if (result.v2Update) pendingV2Syncs.push(result.v2Update)

// After all traders processed:
if (pendingV2Syncs.length > 0) {
  // Batch call existing RPC
  for (let i = 0; i < pendingV2Syncs.length; i += 500) {
    const batch = pendingV2Syncs.slice(i, i + 500)
    await supabase.rpc('bulk_update_snapshot_metrics', { updates: batch })
  }
}
```

### Phase 3: Optimize bulk_update_snapshot_metrics RPC
The existing RPC already handles Sharpe/MDD/WR. Extend to also handle trades_count and other enrichment fields.

## Expected Impact
- **Before**: 2,742 UPDATE calls × 3.9s = 10,822s DB time/day
- **After**: ~6 RPC calls × ~5s = 30s DB time/day
- **Improvement**: **99.7% reduction in enrichment DB time**

## Files to Change
1. `lib/cron/fetchers/enrichment-db.ts` — Add skipV2Sync option
2. `lib/cron/enrichment-runner.ts` — Collect and batch syncs
3. `supabase/migrations/` — Extend bulk_update_snapshot_metrics if needed

## Acceptance Criteria
- [ ] Per-row v2 UPDATEs eliminated during batch enrichment
- [ ] bulk_update_snapshot_metrics handles all enrichment fields
- [ ] Backward compatible (skipV2Sync defaults to false)
- [ ] type-check passes
- [ ] Tests pass
