-- Composite index for the common query pattern:
-- WHERE source = X AND season_id = Y ORDER BY captured_at DESC LIMIT 1
-- Used by getLatestTimestamp, getTraderPerformance, and rankings composite queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_snapshots_source_season_captured
  ON trader_snapshots (source, season_id, captured_at DESC);
