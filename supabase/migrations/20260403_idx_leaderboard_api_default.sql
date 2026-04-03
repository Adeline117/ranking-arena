-- Covering partial index for the rankings API default query
-- Enables Index Only Scan (0 heap fetches) for the hot path:
-- SELECT ... FROM leaderboard_ranks WHERE season_id = ? AND arena_score IS NOT NULL
--   AND (is_outlier IS NULL OR is_outlier = false) AND roi BETWEEN -50000 AND 50000
--   ORDER BY arena_score DESC LIMIT 100
-- Before: 6.5s (Bitmap Heap Scan + Sort). After: 28ms (Index Only Scan).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leaderboard_ranks_api_default
ON leaderboard_ranks (season_id, arena_score DESC NULLS LAST)
INCLUDE (source_trader_id, handle, source, source_type, roi, pnl, win_rate, max_drawdown,
         trades_count, followers, copiers, avatar_url, rank, rank_change, is_new, computed_at,
         profitability_score, risk_control_score, execution_score, score_completeness,
         trading_style, avg_holding_hours, sharpe_ratio, sortino_ratio, calmar_ratio, profit_factor, trader_type, is_outlier, metrics_estimated)
WHERE arena_score IS NOT NULL
  AND (is_outlier IS NULL OR is_outlier = false)
  AND roi BETWEEN -50000 AND 50000;
