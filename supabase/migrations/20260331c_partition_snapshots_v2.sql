-- Migration: Prepare monthly partitioning for trader_snapshots_v2
-- Date: 2026-03-31
-- Status: PREP ONLY — creates partitioned table + auto-partition function
--         Does NOT swap tables. Swap is a manual step during maintenance window.
--
-- Current table stats:
--   ~102K rows, data from 2025-12-28 to present, growing ~10K rows/day
--
-- IMPORTANT: Partitioned tables in PostgreSQL require the partition key to be
-- part of any UNIQUE constraint / PRIMARY KEY. This means we change the PK from
-- (id) to (id, captured_at) and unique constraints include captured_at.

-- ============================================================================
-- STEP 1: Create the partitioned table with identical schema
-- ============================================================================

CREATE TABLE IF NOT EXISTS trader_snapshots_v2_partitioned (
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  platform        text        NOT NULL,
  market_type     text        NOT NULL DEFAULT 'futures'::text,
  trader_key      text        NOT NULL,
  "window"        text        NOT NULL,
  as_of_ts        timestamptz NOT NULL DEFAULT now(),
  metrics         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  roi_pct         numeric,
  pnl_usd         numeric,
  win_rate        numeric,
  max_drawdown    numeric,
  trades_count    integer,
  followers       integer,
  copiers         integer,
  sharpe_ratio    numeric,
  arena_score     numeric,
  return_score    numeric,
  drawdown_score  numeric,
  stability_score numeric,
  quality_flags   jsonb       DEFAULT '{}'::jsonb,
  provenance      jsonb       DEFAULT '{}'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Partition key (as_of_ts) must be in PK and all unique constraints
  PRIMARY KEY (id, as_of_ts)
) PARTITION BY RANGE (as_of_ts);

-- ============================================================================
-- STEP 2: Create monthly partitions (2025-12 through 2026-06)
-- ============================================================================
-- Data starts from 2025-12-28, so we need 2025-12 as the earliest partition.
-- We create through 2026-06 (current month + 2 months buffer).

CREATE TABLE trader_snapshots_v2_p2025_12 PARTITION OF trader_snapshots_v2_partitioned
  FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');

CREATE TABLE trader_snapshots_v2_p2026_01 PARTITION OF trader_snapshots_v2_partitioned
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

CREATE TABLE trader_snapshots_v2_p2026_02 PARTITION OF trader_snapshots_v2_partitioned
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');

CREATE TABLE trader_snapshots_v2_p2026_03 PARTITION OF trader_snapshots_v2_partitioned
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

CREATE TABLE trader_snapshots_v2_p2026_04 PARTITION OF trader_snapshots_v2_partitioned
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

CREATE TABLE trader_snapshots_v2_p2026_05 PARTITION OF trader_snapshots_v2_partitioned
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE trader_snapshots_v2_p2026_06 PARTITION OF trader_snapshots_v2_partitioned
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- Default partition catches any rows outside defined ranges (safety net)
CREATE TABLE trader_snapshots_v2_p_default PARTITION OF trader_snapshots_v2_partitioned
  DEFAULT;

-- ============================================================================
-- STEP 3: Recreate indexes on partitioned table
-- ============================================================================
-- PostgreSQL automatically creates these on each partition.

-- Unique constraint for upserts: includes as_of_ts since it's the partition key
CREATE UNIQUE INDEX uq_snapshots_v2_part_upsert
  ON trader_snapshots_v2_partitioned (platform, market_type, trader_key, "window", as_of_ts);

-- Unique constraint (3-col variant) with partition key
CREATE UNIQUE INDEX uq_snapshots_v2_part_platform_key_window
  ON trader_snapshots_v2_partitioned (platform, trader_key, "window", as_of_ts);

-- Hourly dedup index
CREATE UNIQUE INDEX uq_snapshots_v2_part_hourly
  ON trader_snapshots_v2_partitioned (platform, market_type, trader_key, "window", trunc_hour(as_of_ts));

-- Freshness index (as_of_ts DESC)
CREATE INDEX idx_snapshots_v2_part_freshness
  ON trader_snapshots_v2_partitioned (as_of_ts DESC);

-- Platform + window + updated_at for cron queries
CREATE INDEX idx_snapshots_v2_part_platform_window_updated
  ON trader_snapshots_v2_partitioned (platform, "window", updated_at DESC);

-- ROI ranking index for leaderboard queries
CREATE INDEX idx_snapshots_v2_part_roi_ranking
  ON trader_snapshots_v2_partitioned (platform, market_type, "window", roi_pct DESC NULLS LAST);

-- Trader lookup index
CREATE INDEX idx_snapshots_v2_part_trader
  ON trader_snapshots_v2_partitioned (platform, market_type, trader_key, "window", as_of_ts DESC);

-- Platform + created_at freshness
CREATE INDEX idx_snapshots_v2_part_platform_freshness
  ON trader_snapshots_v2_partitioned (platform, created_at DESC);

-- ============================================================================
-- STEP 4: Auto-partition function + monthly trigger
-- ============================================================================
-- This function creates a new monthly partition if it doesn't exist.
-- Call it from a cron job (e.g., 1st of each month) or before bulk inserts.

CREATE OR REPLACE FUNCTION create_monthly_partition(
  p_table_name text DEFAULT 'trader_snapshots_v2_partitioned',
  p_target_date date DEFAULT (CURRENT_DATE + INTERVAL '1 month')::date
)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_partition_name text;
  v_start_date     date;
  v_end_date       date;
BEGIN
  -- Calculate month boundaries
  v_start_date := date_trunc('month', p_target_date)::date;
  v_end_date   := (v_start_date + INTERVAL '1 month')::date;

  -- Build partition name: trader_snapshots_v2_p2026_07
  v_partition_name := p_table_name || '_p' ||
    to_char(v_start_date, 'YYYY') || '_' || to_char(v_start_date, 'MM');

  -- Remove the _partitioned suffix for cleaner child names
  v_partition_name := replace(v_partition_name, '_partitioned_p', '_p');

  -- Check if partition already exists
  IF EXISTS (
    SELECT 1 FROM pg_class WHERE relname = v_partition_name
  ) THEN
    RETURN 'already exists: ' || v_partition_name;
  END IF;

  -- Create partition
  EXECUTE format(
    'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
    v_partition_name,
    p_table_name,
    v_start_date,
    v_end_date
  );

  RETURN 'created: ' || v_partition_name;
END;
$$;

-- Convenience: create partitions for N months ahead
CREATE OR REPLACE FUNCTION ensure_future_partitions(
  p_months_ahead int DEFAULT 2
)
RETURNS text[]
LANGUAGE plpgsql
AS $$
DECLARE
  v_results text[] := '{}';
  v_month   date;
  v_result  text;
BEGIN
  FOR i IN 0..p_months_ahead LOOP
    v_month := (CURRENT_DATE + (i || ' months')::interval)::date;
    v_result := create_monthly_partition('trader_snapshots_v2_partitioned', v_month);
    v_results := array_append(v_results, v_result);
  END LOOP;
  RETURN v_results;
END;
$$;

-- ============================================================================
-- STEP 5 (COMMENTED OUT): Data migration — run during maintenance window
-- ============================================================================
-- Migrate data in batches to avoid long locks. Run these manually:
--
-- -- Option A: Bulk insert (fastest, requires brief write pause)
-- INSERT INTO trader_snapshots_v2_partitioned
-- SELECT * FROM trader_snapshots_v2;
--
-- -- Option B: Batch by month (safer, can run while app is live with some lag)
-- INSERT INTO trader_snapshots_v2_partitioned
-- SELECT * FROM trader_snapshots_v2
-- WHERE as_of_ts >= '2025-12-01' AND as_of_ts < '2026-01-01';
--
-- INSERT INTO trader_snapshots_v2_partitioned
-- SELECT * FROM trader_snapshots_v2
-- WHERE as_of_ts >= '2026-01-01' AND as_of_ts < '2026-02-01';
--
-- INSERT INTO trader_snapshots_v2_partitioned
-- SELECT * FROM trader_snapshots_v2
-- WHERE as_of_ts >= '2026-02-01' AND as_of_ts < '2026-03-01';
--
-- INSERT INTO trader_snapshots_v2_partitioned
-- SELECT * FROM trader_snapshots_v2
-- WHERE as_of_ts >= '2026-03-01' AND as_of_ts < '2026-04-01';
--
-- INSERT INTO trader_snapshots_v2_partitioned
-- SELECT * FROM trader_snapshots_v2
-- WHERE as_of_ts >= '2026-04-01' AND as_of_ts < '2026-05-01';
--
-- -- Verify row counts match:
-- SELECT
--   (SELECT count(*) FROM trader_snapshots_v2) AS original,
--   (SELECT count(*) FROM trader_snapshots_v2_partitioned) AS partitioned;

-- ============================================================================
-- STEP 6 (COMMENTED OUT): Atomic table swap — run during maintenance window
-- ============================================================================
-- After verifying data migration is complete and correct:
--
-- BEGIN;
--   ALTER TABLE trader_snapshots_v2 RENAME TO trader_snapshots_v2_old;
--   ALTER TABLE trader_snapshots_v2_partitioned RENAME TO trader_snapshots_v2;
-- COMMIT;
--
-- IMPORTANT: After the swap, you MUST re-apply RLS policies:
--
-- ALTER TABLE trader_snapshots_v2 ENABLE ROW LEVEL SECURITY;
--
-- CREATE POLICY anon_read_snapshots ON trader_snapshots_v2
--   FOR SELECT TO anon, authenticated USING (true);
--
-- CREATE POLICY service_write_snapshots ON trader_snapshots_v2
--   FOR ALL TO service_role USING (true) WITH CHECK (true);
--
-- Also verify ON CONFLICT upserts still work — the unique constraint columns
-- now include as_of_ts, so application code using:
--   ON CONFLICT (platform, market_type, trader_key, window)
-- will need to be updated to:
--   ON CONFLICT (platform, market_type, trader_key, window, as_of_ts)
-- OR use the hourly dedup index with trunc_hour(as_of_ts).
--
-- After verifying everything works, drop the old table:
-- DROP TABLE trader_snapshots_v2_old;

-- ============================================================================
-- STEP 7: Schedule auto-partition creation
-- ============================================================================
-- Add a monthly cron job (e.g., in vercel.json or pg_cron) that calls:
--   SELECT ensure_future_partitions(2);
-- This creates partitions for the current month + 2 months ahead.
-- The default partition catches anything that falls outside, so no data is lost.
