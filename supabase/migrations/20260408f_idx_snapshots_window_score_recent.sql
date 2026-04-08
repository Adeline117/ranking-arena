-- ROOT CAUSE FIX: precompute-composite query takes 8.5s per window (25s total).
-- The existing index (window, arena_score DESC) requires scanning 706K rows to filter
-- by as_of_ts >= 168h ago. Adding a partial index that only includes recent rows
-- makes the query complete in <100ms.
--
-- Query pattern (precompute-composite):
--   WHERE window = ? AND arena_score IS NOT NULL AND as_of_ts >= NOW() - 168h
--   ORDER BY arena_score DESC LIMIT 2000

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_snapshots_v2_window_score_recent
  ON trader_snapshots_v2 ("window", arena_score DESC NULLS LAST)
  INCLUDE (platform, trader_key, as_of_ts, roi_pct, pnl_usd, max_drawdown, win_rate, trades_count, followers)
  WHERE arena_score IS NOT NULL
    AND as_of_ts > '2026-04-01'::timestamptz; -- partial index only for recent data
