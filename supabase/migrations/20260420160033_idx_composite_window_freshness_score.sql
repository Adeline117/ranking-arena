-- FIX: precompute-composite 7D query hits 30s statement_timeout.
--
-- The query pattern:
--   SELECT platform, trader_key, as_of_ts, arena_score, roi_pct, pnl_usd,
--          max_drawdown, win_rate, trades_count, followers
--   FROM trader_snapshots_v2
--   WHERE window = $1 AND arena_score IS NOT NULL AND as_of_ts >= $2
--   ORDER BY arena_score DESC NULLS LAST
--   LIMIT 2500
--
-- Current index: idx_snapshots_v2_window_arena_score (window, arena_score DESC)
--   - Provides correct ordering for the ORDER BY
--   - But requires heap fetches for every row to get platform, trader_key, etc.
--   - Also requires heap fetch to evaluate as_of_ts >= $2 filter
--   - For 7D with ~50K eligible rows per partition, heap fetches dominate runtime
--
-- Old partial index: idx_snapshots_v2_window_score_recent uses a static date
-- (as_of_ts > '2026-04-01') which becomes stale and requires manual updates.
--
-- NEW INDEX: covering index on (window, arena_score DESC) that INCLUDEs all
-- columns needed by the precompute-composite query. This enables an index-only
-- scan: Postgres walks the index in arena_score DESC order, applies as_of_ts
-- filter from the included column (no heap fetch needed), and returns all
-- required data directly from the index.
--
-- Expected improvement: 7D query from 30s+ (timeout) to <3s (index-only scan).
-- Trade-off: ~100MB additional index storage (acceptable for a hot query path).

-- Drop the old static-date partial index (superseded by this one)
DROP INDEX CONCURRENTLY IF EXISTS idx_snapshots_v2_window_score_recent;

-- Covering index for precompute-composite queries.
-- Key columns: (window, arena_score DESC) — provides equality + ordering
-- Included columns: all SELECT columns — enables index-only scan
-- Partial: WHERE arena_score IS NOT NULL — matches query filter exactly
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_snapshots_v2_composite_covering
  ON trader_snapshots_v2 ("window", arena_score DESC NULLS LAST)
  INCLUDE (platform, trader_key, as_of_ts, roi_pct, pnl_usd, max_drawdown, win_rate, trades_count, followers)
  WHERE arena_score IS NOT NULL;
