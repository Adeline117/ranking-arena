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
  trader_type, is_outlier, copiers, sortino_ratio, profit_factor, calmar_ratio
)
WHERE arena_score > 0 AND (is_outlier IS NULL OR is_outlier = false);

-- Drop the old non-covering index (superseded)
DROP INDEX CONCURRENTLY IF EXISTS idx_leaderboard_ranks_diverse;

-- Fix RPC: old version referenced created_at/updated_at which don't exist,
-- causing the RPC to always fail and fall back to legacy query.
CREATE OR REPLACE FUNCTION get_diverse_leaderboard(
  p_season_id TEXT DEFAULT '90D',
  p_per_platform INT DEFAULT 8,
  p_total_limit INT DEFAULT 50
)
RETURNS SETOF leaderboard_ranks AS $$
  SELECT id, season_id, source, source_type, source_trader_id, rank, arena_score,
         roi, pnl, win_rate, max_drawdown, followers, trades_count, handle, avatar_url,
         computed_at, profitability_score, risk_control_score, execution_score,
         score_completeness, trading_style, avg_holding_hours, style_confidence,
         is_outlier, sharpe_ratio, sortino_ratio, profit_factor, calmar_ratio,
         trader_type, metrics_estimated, copiers, rank_change, is_new
  FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY source ORDER BY arena_score DESC NULLS LAST) AS rn
    FROM leaderboard_ranks
    WHERE season_id = p_season_id
      AND arena_score IS NOT NULL
      AND arena_score > 10
      AND (is_outlier IS NULL OR is_outlier = false)
  ) ranked
  WHERE rn <= p_per_platform
  ORDER BY arena_score DESC NULLS LAST
  LIMIT p_total_limit;
$$ LANGUAGE sql STABLE;
