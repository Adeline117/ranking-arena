-- Fix: trader_snapshots_v2 missing unique constraint on (platform, market_type, trader_key, window)
-- Root cause: upsert with onConflict fails with 42P10, all snapshot writes silently failing since table creation
-- This migration deduplicates existing data and adds the missing constraint.

-- Step 1: Delete duplicate rows, keeping only the latest (by created_at) for each composite key
-- NOTE: "window" is a reserved word in SQL, must be quoted
DELETE FROM trader_snapshots_v2
WHERE id NOT IN (
  SELECT DISTINCT ON (platform, market_type, trader_key, "window") id
  FROM trader_snapshots_v2
  ORDER BY platform, market_type, trader_key, "window", created_at DESC
);

-- Step 2: Create the unique constraint that the upsert code expects
ALTER TABLE trader_snapshots_v2
  ADD CONSTRAINT trader_snapshots_v2_platform_market_trader_window_uniq
  UNIQUE (platform, market_type, trader_key, "window");

-- Step 3: Add index on created_at for freshness queries
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_v2_freshness
  ON trader_snapshots_v2 (platform, created_at DESC);
