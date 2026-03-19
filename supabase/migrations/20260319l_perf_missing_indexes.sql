-- Performance: add missing indexes for high-frequency query patterns
--
-- idx_lr_source_trader_season: used by ranking-change notifications and trader
-- detail fallback queries that filter on (source, source_trader_id, season_id)
--
-- idx_tsv2_platform_trader_window: used by trader detail API and aggregate-daily-snapshots
-- fallback path that filters on (platform, trader_key, window) ordered by updated_at DESC

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lr_source_trader_season
  ON leaderboard_ranks(source, source_trader_id, season_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tsv2_platform_trader_window
  ON trader_snapshots_v2(platform, trader_key, window, updated_at DESC);
