-- Migration: Leaderboard Snapshots for O(1) reads
-- Date: 2026-02-08
-- Purpose: Pre-computed leaderboard table refreshed on schedule
-- Eliminates complex joins and sorts at read time

-- ============================================================
-- 1. leaderboard_snapshots table
-- ============================================================

CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  
  -- Dimensions
  source text NOT NULL,
  market_type text,
  time_window text NOT NULL DEFAULT '7D',
  
  -- Trader info (denormalized for O(1) read)
  source_trader_id text NOT NULL,
  handle text,
  avatar_url text,
  
  -- Metrics (snapshot at compute time)
  rank integer NOT NULL,
  arena_score numeric,
  roi numeric,
  pnl numeric,
  win_rate numeric,
  trade_count integer,
  followers_count integer,
  
  -- Metadata
  computed_at timestamptz NOT NULL DEFAULT now(),
  
  -- Unique constraint for upsert
  CONSTRAINT uq_leaderboard_snapshot 
    UNIQUE (source, market_type, time_window, source_trader_id, computed_at)
);

-- ============================================================
-- 2. Indexes for fast reads
-- ============================================================

-- Primary read pattern: source + window + rank order
CREATE INDEX IF NOT EXISTS idx_leaderboard_snapshots_read
  ON leaderboard_snapshots(source, time_window, rank ASC)
  WHERE computed_at = (SELECT MAX(computed_at) FROM leaderboard_snapshots);

-- Latest snapshot lookup
CREATE INDEX IF NOT EXISTS idx_leaderboard_snapshots_latest
  ON leaderboard_snapshots(computed_at DESC);

-- Source + market_type + window combo
CREATE INDEX IF NOT EXISTS idx_leaderboard_snapshots_full
  ON leaderboard_snapshots(source, market_type, time_window, computed_at DESC, rank ASC);

-- ============================================================
-- 3. Function to compute fresh leaderboard snapshot
-- ============================================================

CREATE OR REPLACE FUNCTION compute_leaderboard_snapshot()
RETURNS integer AS $$
DECLARE
  inserted_count integer;
  snapshot_time timestamptz := now();
BEGIN
  INSERT INTO leaderboard_snapshots (
    source, market_type, time_window, source_trader_id,
    handle, avatar_url, rank, arena_score, roi, pnl,
    win_rate, trade_count, followers_count, computed_at
  )
  SELECT
    ts.source,
    ts.market_type,
    ts.time_window,
    ts.source_trader_id,
    src.handle,
    src.avatar_url,
    ROW_NUMBER() OVER (
      PARTITION BY ts.source, ts.market_type, ts.time_window
      ORDER BY ts.arena_score DESC NULLS LAST
    ) AS rank,
    ts.arena_score,
    ts.roi,
    ts.pnl,
    ts.win_rate,
    ts.trade_count,
    ts.followers_count,
    snapshot_time
  FROM trader_snapshots ts
  LEFT JOIN trader_sources src
    ON ts.source = src.source AND ts.source_trader_id = src.source_trader_id
  WHERE ts.arena_score IS NOT NULL;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  
  -- Cleanup: keep only last 48 hours of snapshots
  DELETE FROM leaderboard_snapshots
  WHERE computed_at < now() - interval '48 hours';
  
  RETURN inserted_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 4. Note on trader_snapshots partitioning
-- ============================================================
-- Current row count: ~34K rows (as of 2026-02-08)
-- Partitioning is NOT needed yet. Revisit when >500K rows.
-- When ready, partition by range on captured_at (monthly).
-- Migration template:
--   CREATE TABLE trader_snapshots_partitioned (...) PARTITION BY RANGE (captured_at);
--   CREATE TABLE trader_snapshots_y2026m01 PARTITION OF ... FOR VALUES FROM (...) TO (...);
