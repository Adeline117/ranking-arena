-- Migration: Execute trader_snapshots_v2 partition swap
-- Date: 2026-04-05
-- Prereq: 20260331c_partition_snapshots_v2.sql (creates partitioned table + auto-partition fn)
--
-- This migration:
-- 1. Ensures future partitions exist (through 2026-08)
-- 2. Migrates data from unpartitioned → partitioned table
-- 3. Performs atomic swap
-- 4. Re-applies RLS policies
-- 5. Creates the hourly dedup index for upserts
--
-- WHY: trader_snapshots_v2 grows ~10K rows/day. At ~150K+ rows unpartitioned,
-- full table scans degrade from 1-10ms to 500ms+ within 6 months.
-- Monthly partitioning keeps each partition small (~300K rows max).

-- ============================================================================
-- STEP 1: Ensure partitioned table and partitions exist
-- ============================================================================

-- Create partitions through 2026-08 (current + 4 months buffer)
SELECT ensure_future_partitions(4);

-- ============================================================================
-- STEP 2: Migrate data in one batch (table is ~150K rows, safe for bulk insert)
-- ============================================================================

INSERT INTO trader_snapshots_v2_partitioned
SELECT * FROM trader_snapshots_v2
ON CONFLICT DO NOTHING;  -- safe re-run

-- Verify row counts
DO $$
DECLARE
  orig_count bigint;
  part_count bigint;
BEGIN
  SELECT count(*) INTO orig_count FROM trader_snapshots_v2;
  SELECT count(*) INTO part_count FROM trader_snapshots_v2_partitioned;

  IF part_count < orig_count * 0.95 THEN
    RAISE EXCEPTION 'Data migration incomplete: original=%, partitioned=% (%.1f%%)',
      orig_count, part_count, (part_count::float / GREATEST(orig_count, 1) * 100);
  END IF;

  RAISE NOTICE 'Data migration verified: original=%, partitioned=% (%.1f%%)',
    orig_count, part_count, (part_count::float / GREATEST(orig_count, 1) * 100);
END $$;

-- ============================================================================
-- STEP 3: Atomic table swap
-- ============================================================================

ALTER TABLE trader_snapshots_v2 RENAME TO trader_snapshots_v2_old;
ALTER TABLE trader_snapshots_v2_partitioned RENAME TO trader_snapshots_v2;

-- ============================================================================
-- STEP 4: Re-apply RLS policies on the swapped table
-- ============================================================================

ALTER TABLE trader_snapshots_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_snapshots" ON trader_snapshots_v2;
CREATE POLICY "anon_read_snapshots" ON trader_snapshots_v2
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "service_write_snapshots" ON trader_snapshots_v2;
CREATE POLICY "service_write_snapshots" ON trader_snapshots_v2
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================================
-- STEP 5: Create hourly dedup index for upserts
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_v2_hourly_dedup
  ON trader_snapshots_v2 (platform, market_type, trader_key, "window", date_trunc('hour', as_of_ts));

-- ============================================================================
-- STEP 6: Recreate performance indexes on the new partitioned table
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_snapshots_v2_platform_window
  ON trader_snapshots_v2 (platform, "window");

CREATE INDEX IF NOT EXISTS idx_snapshots_v2_platform_updated
  ON trader_snapshots_v2 (platform, "window", updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_snapshots_v2_trader_key
  ON trader_snapshots_v2 (trader_key);

-- ============================================================================
-- STEP 7: Grant permissions
-- ============================================================================

GRANT SELECT ON trader_snapshots_v2 TO anon, authenticated;
GRANT ALL ON trader_snapshots_v2 TO service_role;

-- NOTE: Do NOT drop trader_snapshots_v2_old yet.
-- Keep it as backup for 7 days, then drop manually:
-- DROP TABLE IF EXISTS trader_snapshots_v2_old;
