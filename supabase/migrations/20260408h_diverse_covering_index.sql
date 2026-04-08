-- Covering index for get_diverse_leaderboard RPC
--
-- ROOT CAUSE: The diverse RPC uses ROW_NUMBER() OVER (PARTITION BY source)
-- which reads ALL qualifying rows. With idx_leaderboard_ranks_diverse (non-covering),
-- Postgres needs 70K+ random heap fetches to get handle, roi, pnl, avatar_url, etc.
-- On bloated tables, this takes >5s, causing SSR TTFB timeout.
--
-- Fix: INCLUDE all columns the RPC selects, enabling Index Only Scan.
-- Expected: 5000ms → <200ms (matches idx_leaderboard_ranks_ssr_v2 behavior).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leaderboard_ranks_diverse_v2
ON leaderboard_ranks (season_id, source, arena_score DESC NULLS LAST)
INCLUDE (
  id, source_type, source_trader_id, rank, roi, pnl, win_rate, max_drawdown,
  followers, trades_count, handle, avatar_url, computed_at,
  profitability_score, risk_control_score, execution_score, score_completeness,
  trading_style, avg_holding_hours, style_confidence, sharpe_ratio,
  trader_type, created_at, updated_at, is_outlier, copiers,
  sortino_ratio, profit_factor, calmar_ratio
)
WHERE arena_score > 0 AND (is_outlier IS NULL OR is_outlier = false);

-- Drop the old non-covering index (superseded)
DROP INDEX CONCURRENTLY IF EXISTS idx_leaderboard_ranks_diverse;
