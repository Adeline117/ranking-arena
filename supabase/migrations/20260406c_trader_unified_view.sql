-- Unified trader view: single source of truth for trader detail page.
-- Joins leaderboard_ranks (scores) + traders (profile) + trader_profiles_v2 (bio).
-- Used by getTraderDetail() for single-trader lookups (WHERE platform=X AND trader_key=Y).
-- NOT used for leaderboard pagination (leaderboard reads leaderboard_ranks directly for speed).
--
-- Performance: 2 LEFT JOINs are fast for single-row lookups because:
-- - leaderboard_ranks has composite index on (source, source_trader_id, season_id)
-- - traders needs (platform, trader_key) index (added below)
-- - trader_profiles_v2 needs (platform, trader_key) index (added below)

-- Ensure JOIN columns are indexed (traders table only had single-column indexes)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_traders_platform_trader_key
  ON traders (platform, trader_key);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_profiles_v2_platform_trader_key
  ON trader_profiles_v2 (platform, trader_key);

CREATE OR REPLACE VIEW trader_unified_view AS
SELECT
  lr.source                     AS platform,
  lr.source_trader_id           AS trader_key,
  lr.season_id                  AS period,
  -- Profile (prefer traders.handle, fallback to lr.handle)
  COALESCE(t.handle, lr.handle) AS handle,
  COALESCE(t.avatar_url, lr.avatar_url) AS avatar_url,
  t.profile_url,
  COALESCE(t.market_type, lr.source_type) AS market_type,
  p.bio,
  p.display_name,
  -- Core metrics (from leaderboard_ranks — single source of truth)
  lr.roi,
  lr.pnl,
  lr.win_rate,
  lr.max_drawdown,
  lr.trades_count,
  lr.followers,
  lr.copiers,
  lr.arena_score,
  lr.rank,
  -- Score breakdown
  lr.profitability_score,
  lr.risk_control_score,
  lr.score_completeness,
  -- Advanced metrics
  lr.sharpe_ratio,
  lr.sortino_ratio,
  lr.calmar_ratio,
  lr.profit_factor,
  -- Classification
  lr.trading_style,
  lr.avg_holding_hours,
  lr.trader_type,
  lr.is_outlier,
  -- Metadata
  lr.computed_at,
  lr.source_type
FROM leaderboard_ranks lr
LEFT JOIN traders t
  ON t.platform = lr.source
  AND t.trader_key = lr.source_trader_id
LEFT JOIN trader_profiles_v2 p
  ON p.platform = lr.source
  AND p.trader_key = lr.source_trader_id;

-- Grant read access
GRANT SELECT ON trader_unified_view TO authenticated, anon;

COMMENT ON VIEW trader_unified_view IS 'Unified trader data: leaderboard_ranks (scores) + traders (profile) + trader_profiles_v2 (bio). Frontend should read from this view for guaranteed consistency.';
