-- ============================================================
-- 20260305: Load capacity optimization indexes
--
-- Covers high-frequency query patterns from /api/traders and /api/rankings
-- to reduce DB load under concurrent users
-- ============================================================

-- leaderboard_ranks: covering index for the main /api/traders query
-- Filters: season_id, is_outlier, arena_score > 10, ORDER BY rank
-- This partial index excludes outliers at the index level, reducing scan size
CREATE INDEX IF NOT EXISTS idx_leaderboard_ranks_active
  ON leaderboard_ranks(season_id, rank ASC)
  WHERE (is_outlier IS NULL OR is_outlier = false) AND arena_score > 10;

-- trader_snapshots: covering index for /api/rankings fallback query
-- The main query filters season_id + arena_score NOT NULL + ROI range + ORDER BY arena_score
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_rankings_v2
  ON trader_snapshots(season_id, arena_score DESC NULLS LAST)
  WHERE arena_score IS NOT NULL AND roi BETWEEN -5000 AND 5000;

-- trader_snapshots: covering index for freshness check (latest captured_at per season)
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_freshness
  ON trader_snapshots(season_id, captured_at DESC)
  WHERE arena_score IS NOT NULL;

-- leaderboard_ranks: source extraction for available sources filter
-- Uses DISTINCT-like access pattern - only needs source column per season
CREATE INDEX IF NOT EXISTS idx_leaderboard_ranks_source_season
  ON leaderboard_ranks(season_id, source);

-- trader_snapshots: support sort-by-drawdown in rankings
-- Used when users sort by max_drawdown instead of arena_score
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_season_drawdown
  ON trader_snapshots(season_id, max_drawdown DESC NULLS LAST)
  WHERE max_drawdown IS NOT NULL;

-- posts: support group + hot_score sort for group feed queries
CREATE INDEX IF NOT EXISTS idx_posts_group_hot_score
  ON posts(group_id, hot_score DESC NULLS LAST)
  WHERE group_id IS NOT NULL;
