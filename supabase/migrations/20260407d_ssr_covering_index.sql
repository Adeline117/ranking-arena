-- Fix SSR query timeout (3000ms → 82ms)
--
-- The homepage SSR query was using idx_leaderboard_ranks_sync (season_id, computed_at)
-- which required a full Bitmap Heap Scan of 16K rows + sort. The existing
-- idx_leaderboard_ranks_api_default couldn't be used because its partial WHERE
-- clause includes `roi BETWEEN -50000 AND 50000` which the SSR query doesn't have.
--
-- This new index exactly matches the SSR query pattern:
--   WHERE season_id = ? AND arena_score > 0 AND (is_outlier IS NULL OR is_outlier = false)
--   ORDER BY arena_score DESC
--   LIMIT 25

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leaderboard_ranks_ssr_v2
ON leaderboard_ranks (season_id, arena_score DESC NULLS LAST)
INCLUDE (source_trader_id, handle, source, source_type, roi, pnl, win_rate,
         max_drawdown, avatar_url, rank, rank_change, is_new, followers, copiers,
         trades_count, computed_at, sharpe_ratio, trading_style, trader_type, is_outlier)
WHERE arena_score > 0 AND (is_outlier IS NULL OR is_outlier = false);
