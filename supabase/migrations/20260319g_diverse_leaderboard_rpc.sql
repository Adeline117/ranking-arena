-- RPC function to fetch a diverse leaderboard with per-platform caps.
-- Replaces the 2000-row JS-side diversity filter in getInitialTraders.ts,
-- reducing SSR payload from ~400KB to ~10KB.

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
         sharpe_ratio, trader_type, created_at, updated_at, is_outlier
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
