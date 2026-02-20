-- 数据护城河：每日交易员快照架构
-- Migration: 2026-02-20
-- Purpose: Enable daily snapshot collection across all 27 exchanges
--          to build a multi-year historical data moat.

-- 1. Add snapshot_date column to trader_snapshots
--    snapshot_date = the calendar date this snapshot represents (DATE, not TIMESTAMPTZ)
--    Used for deduplication: one row per (source, trader, day)
ALTER TABLE trader_snapshots
  ADD COLUMN IF NOT EXISTS snapshot_date DATE;

-- 2. Backfill snapshot_date from captured_at for existing rows
--    Run in batches to avoid statement timeout
UPDATE trader_snapshots
  SET snapshot_date = DATE(captured_at)
  WHERE snapshot_date IS NULL
    AND captured_at IS NOT NULL;

-- 3. Add unique constraint to prevent duplicate snapshots per day
--    This is the core deduplication key for the daily checkpoint cron
--    NOTE: Run AFTER backfill and dedup of any same-day duplicates
-- CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
--   idx_trader_snapshots_daily_unique
--   ON trader_snapshots (source, source_trader_id, snapshot_date)
--   WHERE snapshot_date IS NOT NULL;
--
-- (Commented out: run manually after verifying no duplicates)

-- 4. Add last_seen_at to trader_sources
--    Tracks when a trader last appeared on a live leaderboard
--    Used to distinguish "gone silent" vs "dropped off leaderboard"
ALTER TABLE trader_sources
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- 5. Index on snapshot_date for time-series queries
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_date
  ON trader_snapshots (snapshot_date, source);

-- 6. Index for last_seen_at queries
CREATE INDEX IF NOT EXISTS idx_trader_sources_last_seen
  ON trader_sources (last_seen_at DESC)
  WHERE last_seen_at IS NOT NULL;

-- Summary:
-- After this migration:
--   - Each day the daily-checkpoint.mjs cron writes one row per trader per source
--   - snapshot_date makes it easy to query "what was trader X's ROI on date Y"
--   - 3-year projection: 27 exchanges × 1000 traders × 365 days = ~10M rows/year
--   - At ~500 bytes/row: 3 years ≈ 15GB, well within Supabase Pro 100GB
