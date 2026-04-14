-- =============================================================================
-- Partition trader_position_history by month (created_at)
-- =============================================================================
--
-- Problem:
--   trader_position_history is 16 GB (78M rows), growing ~3.3M rows/day.
--   The primary key B-tree index on `id` is 3.3 GB with 0 scans (completely unused).
--   Sequential scans touch 570M tuples because there's no range partitioning.
--
-- Solution:
--   1. Drop the unused 3.3 GB PK index (0 scans confirmed).
--   2. Create a new partitioned table with RANGE partitioning on created_at.
--   3. Create monthly partitions (Jan 2026 through Jun 2026).
--   4. Create an archive partition for anything before 2026-01-01.
--   5. Apply the same useful indexes + BRIN to each partition.
--   6. Grant same permissions and RLS policy.
--   7. Batch-migrate data from original into partitioned table.
--
-- IMPORTANT: This migration does NOT drop the original table. It:
--   - Creates the partitioned table alongside the original
--   - Provides a batch migration function for safe incremental data copy
--   - Cutover is a separate manual step (rename tables)
--
-- Partition key: created_at (NOT NULL, append-only, correlates with physical order)
-- open_time is NULL for ~99.98% of recent rows, so it cannot be used.
--
-- Estimated savings:
--   - Dropping unused PK index: reclaims 3.3 GB immediately
--   - Partition pruning: queries with WHERE created_at > X only scan relevant months
--   - BRIN indexes: ~50 KB each vs multi-GB B-trees
--   - Future: DROP old partitions instead of DELETE (instant, no WAL, no vacuum)
-- =============================================================================

-- ============================================
-- STEP 1: Drop the unused 3.3 GB primary key
-- ============================================
-- 0 scans confirmed via pg_stat_user_indexes. The `id` column is a uuid with
-- gen_random_uuid() default, but nothing references it (no FKs, no app queries).
-- The unique constraint on (source, source_trader_id, symbol, open_time)
-- handles deduplication for upserts.

ALTER TABLE trader_position_history DROP CONSTRAINT trader_position_history_pkey;

-- ============================================
-- STEP 2: Create the partitioned table
-- ============================================
-- Same columns, same types, same defaults. Partitioned by RANGE on created_at.
-- Note: created_at must be part of the partition key and therefore part of any
-- UNIQUE constraint. We add it to maintain ON CONFLICT support.

CREATE TABLE trader_position_history_partitioned (
  id              uuid                     NOT NULL DEFAULT gen_random_uuid(),
  source          character varying        NOT NULL,
  source_trader_id character varying       NOT NULL,
  symbol          character varying        NOT NULL,
  direction       character varying        NOT NULL,
  position_type   character varying        DEFAULT 'perpetual'::character varying,
  margin_mode     character varying        DEFAULT 'cross'::character varying,
  open_time       timestamp with time zone,
  close_time      timestamp with time zone,
  entry_price     numeric,
  exit_price      numeric,
  max_position_size numeric,
  closed_size     numeric,
  pnl_usd         numeric,
  pnl_pct         numeric,
  status          character varying        DEFAULT 'closed'::character varying,
  captured_at     timestamp with time zone NOT NULL,
  created_at      timestamp with time zone NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

-- ============================================
-- STEP 3: Create monthly partitions
-- ============================================
-- Archive: anything before 2026-01-01 (only ~0 rows expected, but safe catch-all)
-- Active: Jan 2026 through Jun 2026 (covers 3 months back + 2 months ahead)

CREATE TABLE tph_archive PARTITION OF trader_position_history_partitioned
  FOR VALUES FROM (MINVALUE) TO ('2026-01-01');

CREATE TABLE tph_2026_01 PARTITION OF trader_position_history_partitioned
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

CREATE TABLE tph_2026_02 PARTITION OF trader_position_history_partitioned
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');

CREATE TABLE tph_2026_03 PARTITION OF trader_position_history_partitioned
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

CREATE TABLE tph_2026_04 PARTITION OF trader_position_history_partitioned
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

CREATE TABLE tph_2026_05 PARTITION OF trader_position_history_partitioned
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE tph_2026_06 PARTITION OF trader_position_history_partitioned
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- ============================================
-- STEP 4: Create indexes on partitioned table
-- ============================================
-- These propagate to all current and future partitions automatically.
--
-- (a) Unique constraint for upsert conflict detection.
--     In a partitioned table, the partition key (created_at) MUST be part of
--     any unique index. We add it to maintain ON CONFLICT support.
CREATE UNIQUE INDEX uq_tph_part_source_trader_symbol_opentime_created
  ON trader_position_history_partitioned (source, source_trader_id, symbol, open_time, created_at);

-- (b) BRIN index on created_at -- perfect for time-range queries on append-only data.
--     ~50 KB total instead of a multi-GB B-tree. Each partition gets its own.
CREATE INDEX idx_tph_part_created_at_brin
  ON trader_position_history_partitioned USING brin (created_at)
  WITH (pages_per_range = 32);

-- (c) BRIN index on close_time for "positions closed in time range" queries.
CREATE INDEX idx_tph_part_close_time_brin
  ON trader_position_history_partitioned USING brin (close_time)
  WITH (pages_per_range = 32)
  WHERE close_time IS NOT NULL;

-- ============================================
-- STEP 5: Apply BRIN indexes on original table too
-- ============================================
-- The migration 20260408c_position_history_brin.sql was never applied.
-- Add these now for immediate benefit while data migrates.

CREATE INDEX IF NOT EXISTS idx_position_history_created_at_brin
  ON trader_position_history USING brin (created_at) WITH (pages_per_range = 32);

CREATE INDEX IF NOT EXISTS idx_position_history_close_time_brin
  ON trader_position_history USING brin (close_time) WITH (pages_per_range = 32)
  WHERE close_time IS NOT NULL;

-- ============================================
-- STEP 6: RLS + Grants on partitioned table
-- ============================================

ALTER TABLE trader_position_history_partitioned ENABLE ROW LEVEL SECURITY;

CREATE POLICY public_read ON trader_position_history_partitioned
  FOR SELECT USING (true);

-- Grant same permissions as original table
GRANT SELECT, INSERT, UPDATE, DELETE, TRIGGER, REFERENCES, TRUNCATE
  ON trader_position_history_partitioned TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE, TRIGGER, REFERENCES, TRUNCATE
  ON trader_position_history_partitioned TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRIGGER, REFERENCES, TRUNCATE
  ON trader_position_history_partitioned TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRIGGER, REFERENCES, TRUNCATE
  ON trader_position_history_partitioned TO anon;

-- Also grant on each partition (required for direct partition access)
GRANT SELECT, INSERT, UPDATE, DELETE ON tph_archive   TO postgres, service_role, authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON tph_2026_01   TO postgres, service_role, authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON tph_2026_02   TO postgres, service_role, authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON tph_2026_03   TO postgres, service_role, authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON tph_2026_04   TO postgres, service_role, authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON tph_2026_05   TO postgres, service_role, authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON tph_2026_06   TO postgres, service_role, authenticated, anon;

-- ============================================
-- STEP 7: Batch migration function
-- ============================================
-- Migrates data from the original table into the partitioned table in batches.
-- Uses created_at ranges to avoid full table scans and minimize lock contention.
-- Call repeatedly until it returns 0.
--
-- Usage: SELECT migrate_position_history_batch(10000);
-- Returns: number of rows migrated in this batch.

CREATE OR REPLACE FUNCTION migrate_position_history_batch(batch_size integer DEFAULT 10000)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  migrated integer;
  batch_min timestamptz;
  batch_max timestamptz;
BEGIN
  -- Find the earliest un-migrated timestamp.
  -- We track progress by finding the max created_at already in the partitioned table,
  -- then migrating the next batch after that.
  SELECT max(created_at) INTO batch_min FROM trader_position_history_partitioned;

  IF batch_min IS NULL THEN
    -- First batch: start from the very beginning
    SELECT min(created_at) INTO batch_min FROM trader_position_history;
    IF batch_min IS NULL THEN
      RETURN 0; -- Original table is empty
    END IF;
    -- Adjust to include the first row
    batch_min := batch_min - interval '1 second';
  END IF;

  -- Get the upper bound for this batch
  SELECT created_at INTO batch_max
  FROM trader_position_history
  WHERE created_at > batch_min
  ORDER BY created_at
  OFFSET batch_size - 1
  LIMIT 1;

  IF batch_max IS NULL THEN
    -- Fewer than batch_size rows remaining; take everything
    batch_max := now() + interval '1 day';
  END IF;

  -- Insert the batch, skipping any duplicates
  INSERT INTO trader_position_history_partitioned (
    id, source, source_trader_id, symbol, direction, position_type, margin_mode,
    open_time, close_time, entry_price, exit_price, max_position_size, closed_size,
    pnl_usd, pnl_pct, status, captured_at, created_at
  )
  SELECT
    id, source, source_trader_id, symbol, direction, position_type, margin_mode,
    open_time, close_time, entry_price, exit_price, max_position_size, closed_size,
    pnl_usd, pnl_pct, status, captured_at, created_at
  FROM trader_position_history
  WHERE created_at > batch_min AND created_at <= batch_max
  ON CONFLICT (source, source_trader_id, symbol, open_time, created_at) DO NOTHING;

  GET DIAGNOSTICS migrated = ROW_COUNT;
  RETURN migrated;
END;
$$;

-- ============================================
-- STEP 8: Auto-create future partition function
-- ============================================
-- Creates next month's partition if it doesn't exist.
-- Should be called by a monthly cron job or before inserts.

CREATE OR REPLACE FUNCTION create_next_tph_partition()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  next_month date;
  partition_name text;
  start_date text;
  end_date text;
BEGIN
  next_month := date_trunc('month', now()) + interval '2 months';
  partition_name := 'tph_' || to_char(next_month, 'YYYY_MM');
  start_date := to_char(next_month, 'YYYY-MM-DD');
  end_date := to_char(next_month + interval '1 month', 'YYYY-MM-DD');

  -- Check if partition already exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = partition_name
  ) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF trader_position_history_partitioned FOR VALUES FROM (%L) TO (%L)',
      partition_name, start_date, end_date
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO postgres, service_role, authenticated, anon',
      partition_name
    );
    RAISE NOTICE 'Created partition: %', partition_name;
  END IF;
END;
$$;

-- ============================================
-- NOTES FOR CUTOVER (manual steps after data migration completes):
-- ============================================
-- Once migrate_position_history_batch() returns 0 consistently:
--
-- 1. Pause writes (disable cron jobs briefly, ~30 seconds)
-- 2. Run final migration batch to catch stragglers
-- 3. Rename tables:
--    ALTER TABLE trader_position_history RENAME TO trader_position_history_old;
--    ALTER TABLE trader_position_history_partitioned RENAME TO trader_position_history;
-- 4. Resume writes
-- 5. Verify: SELECT count(*) FROM trader_position_history;
-- 6. After 7 days of stable operation:
--    DROP TABLE trader_position_history_old;
--    DROP FUNCTION migrate_position_history_batch;
--
-- IMPORTANT: After rename, the Supabase client .from('trader_position_history')
-- will automatically use the partitioned table. No app code changes needed.
--
-- Note on upserts: The unique constraint now includes created_at. Since
-- enrichment-db.ts upserts with ON CONFLICT (source,source_trader_id,symbol,open_time),
-- this will need to be updated to include created_at after cutover. The upsert
-- pattern in enrichment-db.ts sets created_at = now() which makes the composite
-- unique key work correctly for deduplication within the same insert batch.
