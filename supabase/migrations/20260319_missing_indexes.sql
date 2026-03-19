-- Migration: Add missing indexes for query performance
-- Date: 2026-03-19
-- Purpose: Cover common query patterns that lack index support

-- Partial index for active leaderboard entries (filters out outliers)
CREATE INDEX IF NOT EXISTS idx_leaderboard_ranks_active_filtered
ON leaderboard_ranks(season_id, arena_score DESC)
WHERE (is_outlier IS NULL OR is_outlier = false) AND arena_score > 0;

-- Equity curve queries on trader_snapshots_v2
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_v2_equity
ON trader_snapshots_v2(platform, trader_key, as_of_ts DESC);

-- Daily snapshots platform+date for aggregate queries
CREATE INDEX IF NOT EXISTS idx_daily_snapshots_platform_date
ON trader_daily_snapshots(platform, date DESC);

-- Snapshot cleanup by age
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_v2_as_of_ts
ON trader_snapshots_v2(as_of_ts);
