-- Migration: LIST partition leaderboard_ranks by season_id
-- Purpose: 314K rows queried with WHERE season_id = '7D'|'30D'|'90D'.
--          Without partitioning, every query scans all 314K rows.
--          LIST partition gives automatic partition pruning → 3x scan reduction.
--
-- Strategy: Same as trader_snapshots_v2 partitioning (create → copy → swap).
--          The unique constraint already includes season_id, so PK is compatible.
--
-- NOTE: This requires a brief write lock during the atomic rename.
--       compute-leaderboard runs hourly; schedule this between runs.

-- ============================================================================
-- STEP 1: Create partitioned table with identical schema
-- ============================================================================

CREATE TABLE IF NOT EXISTS leaderboard_ranks_partitioned (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  season_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_type TEXT,
  source_trader_id TEXT NOT NULL,
  rank INTEGER CHECK (rank IS NULL OR rank > 0),
  arena_score NUMERIC(10, 2),
  roi NUMERIC(12, 4),
  pnl NUMERIC(18, 2),
  win_rate NUMERIC(5, 2) CHECK (win_rate IS NULL OR (win_rate >= 0 AND win_rate <= 100)),
  max_drawdown NUMERIC(5, 2) CHECK (max_drawdown IS NULL OR (max_drawdown >= -100 AND max_drawdown <= 0)),
  followers INTEGER CHECK (followers IS NULL OR followers >= 0),
  trades_count INTEGER,
  handle TEXT,
  avatar_url TEXT,
  computed_at TIMESTAMPTZ,
  profitability_score NUMERIC(6, 2),
  risk_control_score NUMERIC(6, 2),
  execution_score NUMERIC(6, 2),
  score_completeness TEXT,
  trading_style TEXT,
  avg_holding_hours NUMERIC(10, 2),
  style_confidence NUMERIC(6, 4),
  sharpe_ratio NUMERIC(10, 4),
  sortino_ratio NUMERIC(10, 4),
  profit_factor NUMERIC(10, 4),
  calmar_ratio NUMERIC(10, 4),
  trader_type TEXT,
  is_outlier BOOLEAN,
  metrics_estimated BOOLEAN,
  rank_change INTEGER,
  is_new BOOLEAN,
  copiers INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (id, season_id),
  UNIQUE (season_id, source, source_trader_id)
) PARTITION BY LIST (season_id);

-- ============================================================================
-- STEP 2: Create partitions for each season
-- ============================================================================

CREATE TABLE leaderboard_ranks_7d PARTITION OF leaderboard_ranks_partitioned
  FOR VALUES IN ('7D');

CREATE TABLE leaderboard_ranks_30d PARTITION OF leaderboard_ranks_partitioned
  FOR VALUES IN ('30D');

CREATE TABLE leaderboard_ranks_90d PARTITION OF leaderboard_ranks_partitioned
  FOR VALUES IN ('90D');

-- Default partition for any unexpected season_id values
CREATE TABLE leaderboard_ranks_default PARTITION OF leaderboard_ranks_partitioned
  DEFAULT;

-- ============================================================================
-- STEP 3: Recreate core indexes on partitioned table
-- (These are automatically created per-partition by PostgreSQL)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_lr_part_season_score
  ON leaderboard_ranks_partitioned (season_id, arena_score DESC);

CREATE INDEX IF NOT EXISTS idx_lr_part_source_season_score
  ON leaderboard_ranks_partitioned (source, season_id, arena_score DESC);

CREATE INDEX IF NOT EXISTS idx_lr_part_season_rank
  ON leaderboard_ranks_partitioned (season_id, rank ASC);

-- ============================================================================
-- STEP 4: Copy data from original table
-- ============================================================================

INSERT INTO leaderboard_ranks_partitioned
SELECT * FROM leaderboard_ranks
ON CONFLICT DO NOTHING;

-- Verify row counts
DO $$
DECLARE
  orig_count bigint;
  part_count bigint;
BEGIN
  SELECT count(*) INTO orig_count FROM leaderboard_ranks;
  SELECT count(*) INTO part_count FROM leaderboard_ranks_partitioned;

  IF part_count < orig_count * 0.95 THEN
    RAISE EXCEPTION 'Data migration incomplete: original=%, partitioned=% (%.1f%%)',
      orig_count, part_count, (part_count::float / GREATEST(orig_count, 1) * 100);
  END IF;

  RAISE NOTICE 'Data migration verified: original=%, partitioned=% (%.1f%%)',
    orig_count, part_count, (part_count::float / GREATEST(orig_count, 1) * 100);
END $$;

-- ============================================================================
-- STEP 5: Atomic table swap
-- ============================================================================

ALTER TABLE leaderboard_ranks RENAME TO leaderboard_ranks_old;
ALTER TABLE leaderboard_ranks_partitioned RENAME TO leaderboard_ranks;

-- ============================================================================
-- STEP 6: Re-apply RLS policies
-- ============================================================================

ALTER TABLE leaderboard_ranks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read leaderboard_ranks" ON leaderboard_ranks;
CREATE POLICY "Public read leaderboard_ranks" ON leaderboard_ranks
  FOR SELECT USING (true);

-- ============================================================================
-- STEP 7: Recreate the covering index for API queries (the 232x speedup index)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_leaderboard_ranks_api_default
  ON leaderboard_ranks (season_id, arena_score DESC NULLS LAST)
  INCLUDE (source_trader_id, handle, source, source_type, roi, pnl, win_rate, max_drawdown,
           trades_count, followers, copiers, avatar_url, rank, rank_change, is_new, computed_at,
           profitability_score, risk_control_score, execution_score, score_completeness,
           trading_style, avg_holding_hours, sharpe_ratio, sortino_ratio, calmar_ratio,
           profit_factor, trader_type, is_outlier, metrics_estimated)
  WHERE arena_score IS NOT NULL
    AND (is_outlier IS NULL OR is_outlier = false)
    AND roi BETWEEN -50000 AND 50000;

-- ============================================================================
-- STEP 8: Grant permissions
-- ============================================================================

GRANT SELECT ON leaderboard_ranks TO anon, authenticated;
GRANT ALL ON leaderboard_ranks TO service_role;

-- NOTE: Keep leaderboard_ranks_old for 7 days as backup, then drop:
-- DROP TABLE IF EXISTS leaderboard_ranks_old;
