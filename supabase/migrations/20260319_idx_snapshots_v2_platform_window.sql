-- Performance: add composite index on trader_snapshots_v2 for (platform, window, updated_at DESC)
-- This index covers the hot path in compute-leaderboard cron which filters by platform + window
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tsv2_platform_window
  ON trader_snapshots_v2(platform, window, updated_at DESC);
