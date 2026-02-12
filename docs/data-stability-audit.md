# Data Stability Audit Report

**Date:** 2026-02-12  
**Goal:** Prevent trader count from dropping after automated scraping

---

## 1. Import Scripts — UPSERT vs DELETE

### `scripts/import/lib/save.mjs` (shared save function)
- ✅ Uses `upsert` with `onConflict` for both `trader_sources` and `trader_snapshots`
- ✅ No DELETE or TRUNCATE operations
- **Verdict: SAFE** — data is only added/updated, never removed

### Individual `import_*.mjs` scripts (checked: bybit, binance_futures_api, bingx, bitget, blofin, btcc, etc.)
- ✅ All use `upsert` with proper `onConflict` constraints
- ✅ No DELETE or TRUNCATE on `trader_snapshots` in any import script
- **Verdict: SAFE**

### `enrich_*.mjs` scripts — some have DELETE operations:
| Script | What it deletes | Risk |
|--------|----------------|------|
| `enrich_gains.mjs` | Records with ALL null fields (roi, pnl, win_rate) | ✅ Low — cleanup only |
| `enrich_*_detail.mjs` (bybit, okx, htx, kucoin, bitget) | `trader_stats_detail` rows before re-inserting | ⚠️ Medium — but targets `trader_stats_detail`, NOT `trader_snapshots` |
| `enrich_*_positions.mjs` | `trader_position_history` rows | ✅ Low — position data, not rankings |
| `supplement-trader-data.mjs` | `trader_stats_detail` and `trader_position_history` | ✅ Low — auxiliary tables only |

**Key finding:** No enrich script deletes from `trader_snapshots` except `enrich_gains.mjs` which only cleans genuinely empty records.

---

## 2. Data Retention / Expiration

- ✅ **No scheduled DELETE or TRUNCATE on `trader_snapshots`** anywhere in the codebase
- ✅ No cron job or scheduled task that purges old snapshots
- The only cleanup script is `scripts/cleanup_roi_and_dedup.mjs` which removes:
  - Records with ROI > 10000% (outliers)
  - Exact duplicate records
  - This is a **manual** script, not automated

**Verdict: SAFE** — no automatic data expiration

---

## 3. Leaderboard Compute Filters

`scripts/compute-leaderboard-local.mjs` filters:
1. **Freshness:** Only includes snapshots from last 24 hours (`captured_at >= now - 24h`)
2. **ROI cap:** Excludes traders with `|roi| > 10000`
3. **Dedup:** Keeps only the latest snapshot per source+trader

### ⚠️ Freshness filter is the main risk
If scraping fails for a source for >24h, ALL traders from that source disappear from the leaderboard. This is **by design** (stale data shouldn't rank) but could cause sudden drops.

**Recommendation:** This is acceptable behavior — stale data should drop off. The real fix is ensuring scraping runs reliably.

---

## 4. Safety Measures Added

### `scripts/import/lib/save.mjs` — New safety guard
Added a check before upserting: if the new batch has **<50% of existing records** for that source+season, the save is **skipped** with a warning:

```
⚠️  SAFETY SKIP [binance_futures/30D]: new=5 vs existing=150 (<50%). Skipping to prevent data loss.
```

This prevents:
- API returning partial/empty results from overwriting good data
- Network timeouts causing truncated imports
- Rate-limited responses with only a few traders

To bypass (e.g., when a source legitimately shrinks): pass `{ skipSafetyCheck: true }` in opts.

---

## 5. Summary

| Area | Status | Risk Level |
|------|--------|------------|
| Import scripts (upsert logic) | ✅ All use UPSERT | None |
| DELETE on trader_snapshots | ✅ Only null-cleanup in enrich_gains | None |
| Data expiration | ✅ No auto-purge | None |
| Leaderboard 24h freshness filter | ⚠️ Can drop stale sources | Low (by design) |
| API returning partial data | ✅ **FIXED** — 50% safety guard added | Was Medium, now Low |

**Bottom line:** The codebase is well-designed — all imports use UPSERT, no destructive operations on core tables. The only realistic risk was an API returning abnormally few results, which is now guarded against.
