-- ============================================
-- Trading Platform MVP - Phase 1
-- Migration: 00015_trading_platform_mvp.sql
-- Idempotent: safe to run multiple times
-- ============================================

-- ============================================
-- 1. trader_sources (extended)
--    Discovery registry: where each trader was found
-- ============================================
ALTER TABLE trader_sources
  ADD COLUMN IF NOT EXISTS platform TEXT,
  ADD COLUMN IF NOT EXISTS trader_key TEXT,
  ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'leaderboard',
  ADD COLUMN IF NOT EXISTS discovered_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

-- Backfill platform/trader_key from existing source/source_trader_id
UPDATE trader_sources
  SET platform = source,
      trader_key = source_trader_id
  WHERE platform IS NULL AND source IS NOT NULL;

-- Unique constraint on (platform, trader_key)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_trader_sources_platform_key'
  ) THEN
    -- Only add if no duplicates exist
    ALTER TABLE trader_sources
      ADD CONSTRAINT uq_trader_sources_platform_key UNIQUE (platform, trader_key);
  END IF;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'uq_trader_sources_platform_key already exists or duplicates prevent creation';
END $$;

CREATE INDEX IF NOT EXISTS idx_trader_sources_platform_key
  ON trader_sources(platform, trader_key);
CREATE INDEX IF NOT EXISTS idx_trader_sources_is_active
  ON trader_sources(is_active) WHERE is_active = TRUE;

-- ============================================
-- 2. trader_profiles
--    Enriched profile data (display info, bio, tags)
-- ============================================
CREATE TABLE IF NOT EXISTS trader_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  trader_key TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  bio TEXT,
  tags JSONB DEFAULT '[]'::jsonb,
  follower_count INTEGER,
  copier_count INTEGER,
  aum DECIMAL(18, 2),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_enriched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(platform, trader_key)
);

CREATE INDEX IF NOT EXISTS idx_trader_profiles_platform_key
  ON trader_profiles(platform, trader_key);
CREATE INDEX IF NOT EXISTS idx_trader_profiles_updated
  ON trader_profiles(updated_at DESC);

-- ============================================
-- 3. trader_snapshots_v2
--    Window-based performance snapshots with JSONB metrics
--    Keeps existing trader_snapshots intact for backwards compat
-- ============================================
CREATE TABLE IF NOT EXISTS trader_snapshots_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  trader_key TEXT NOT NULL,
  window TEXT NOT NULL,  -- '7D', '30D', '90D'
  as_of_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- metrics schema: { roi, pnl, win_rate, max_drawdown, trades_count,
  --                   followers, aum, arena_score, return_score,
  --                   drawdown_score, stability_score, rank }
  quality_flags JSONB DEFAULT '{}'::jsonb,
  -- quality_flags: { is_suspicious, suspicion_reasons, data_completeness }
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unique constraint: one snapshot per (platform, trader_key, window, as_of_ts bucket)
-- We use a unique index on truncated timestamp (hourly bucket) to prevent duplicates
CREATE UNIQUE INDEX IF NOT EXISTS uq_trader_snapshots_v2_bucket
  ON trader_snapshots_v2(platform, trader_key, window, date_trunc('hour', as_of_ts));

-- Rankings query: platform + window + metric ordering
CREATE INDEX IF NOT EXISTS idx_snapshots_v2_rankings
  ON trader_snapshots_v2(platform, window, as_of_ts DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_v2_trader
  ON trader_snapshots_v2(platform, trader_key, window);
CREATE INDEX IF NOT EXISTS idx_snapshots_v2_as_of
  ON trader_snapshots_v2(as_of_ts DESC);

-- GIN index for JSONB metrics queries (e.g. filtering by roi > X)
CREATE INDEX IF NOT EXISTS idx_snapshots_v2_metrics
  ON trader_snapshots_v2 USING GIN (metrics);

-- ============================================
-- 4. trader_timeseries
--    Time-series data (equity curves, daily PnL, etc.)
-- ============================================
CREATE TABLE IF NOT EXISTS trader_timeseries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  trader_key TEXT NOT NULL,
  series_type TEXT NOT NULL,  -- 'equity_curve', 'daily_pnl', 'asset_breakdown'
  as_of_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- For equity_curve: [{ date, roi, pnl, equity }]
  -- For daily_pnl: [{ date, pnl, trades }]
  -- For asset_breakdown: [{ symbol, weight_pct, count }]
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unique: one timeseries per (platform, trader_key, series_type, hourly bucket)
CREATE UNIQUE INDEX IF NOT EXISTS uq_trader_timeseries_bucket
  ON trader_timeseries(platform, trader_key, series_type, date_trunc('hour', as_of_ts));

CREATE INDEX IF NOT EXISTS idx_timeseries_trader
  ON trader_timeseries(platform, trader_key, series_type);
CREATE INDEX IF NOT EXISTS idx_timeseries_as_of
  ON trader_timeseries(as_of_ts DESC);

-- ============================================
-- 5. refresh_jobs
--    Background job queue for data refresh
-- ============================================
CREATE TABLE IF NOT EXISTS refresh_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type TEXT NOT NULL DEFAULT 'full_refresh',
  -- job_type: 'full_refresh', 'profile_only', 'snapshot_only', 'timeseries_only'
  platform TEXT NOT NULL,
  trader_key TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5,
  -- priority: 1=highest (user-triggered), 5=normal (scheduled), 9=lowest (backfill)
  status TEXT NOT NULL DEFAULT 'pending',
  -- status: 'pending', 'running', 'success', 'failed', 'cancelled'
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,  -- worker instance ID
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  result JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Job polling: pending jobs sorted by priority then next_run_at
CREATE INDEX IF NOT EXISTS idx_refresh_jobs_poll
  ON refresh_jobs(status, next_run_at, priority)
  WHERE status = 'pending';

-- Prevent duplicate pending/running jobs for same trader
CREATE UNIQUE INDEX IF NOT EXISTS uq_refresh_jobs_active
  ON refresh_jobs(platform, trader_key, job_type)
  WHERE status IN ('pending', 'running');

-- Lookup by trader
CREATE INDEX IF NOT EXISTS idx_refresh_jobs_trader
  ON refresh_jobs(platform, trader_key, status);

-- Cleanup old jobs
CREATE INDEX IF NOT EXISTS idx_refresh_jobs_completed
  ON refresh_jobs(completed_at)
  WHERE status IN ('success', 'failed');

-- ============================================
-- 6. RLS Policies
-- ============================================

-- trader_profiles: public read, service-role write
ALTER TABLE trader_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trader_profiles_public_read" ON trader_profiles;
CREATE POLICY "trader_profiles_public_read"
  ON trader_profiles FOR SELECT USING (true);

DROP POLICY IF EXISTS "trader_profiles_service_write" ON trader_profiles;
CREATE POLICY "trader_profiles_service_write"
  ON trader_profiles FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- trader_snapshots_v2: public read, service-role write
ALTER TABLE trader_snapshots_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "snapshots_v2_public_read" ON trader_snapshots_v2;
CREATE POLICY "snapshots_v2_public_read"
  ON trader_snapshots_v2 FOR SELECT USING (true);

DROP POLICY IF EXISTS "snapshots_v2_service_write" ON trader_snapshots_v2;
CREATE POLICY "snapshots_v2_service_write"
  ON trader_snapshots_v2 FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- trader_timeseries: public read, service-role write
ALTER TABLE trader_timeseries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "timeseries_public_read" ON trader_timeseries;
CREATE POLICY "timeseries_public_read"
  ON trader_timeseries FOR SELECT USING (true);

DROP POLICY IF EXISTS "timeseries_service_write" ON trader_timeseries;
CREATE POLICY "timeseries_service_write"
  ON trader_timeseries FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- refresh_jobs: public read (status only), service-role write
ALTER TABLE refresh_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "refresh_jobs_public_read" ON refresh_jobs;
CREATE POLICY "refresh_jobs_public_read"
  ON refresh_jobs FOR SELECT USING (true);

DROP POLICY IF EXISTS "refresh_jobs_service_write" ON refresh_jobs;
CREATE POLICY "refresh_jobs_service_write"
  ON refresh_jobs FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================
-- 7. Helper functions
-- ============================================

-- Function to claim a pending job (atomic lock)
CREATE OR REPLACE FUNCTION claim_refresh_job(
  p_worker_id TEXT,
  p_limit INTEGER DEFAULT 1
)
RETURNS SETOF refresh_jobs
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE refresh_jobs
  SET
    status = 'running',
    locked_at = NOW(),
    locked_by = p_worker_id,
    started_at = NOW(),
    attempts = attempts + 1,
    updated_at = NOW()
  WHERE id IN (
    SELECT id FROM refresh_jobs
    WHERE status = 'pending'
      AND next_run_at <= NOW()
      AND (locked_at IS NULL OR locked_at < NOW() - INTERVAL '5 minutes')
    ORDER BY priority ASC, next_run_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;

-- Function to complete a job
CREATE OR REPLACE FUNCTION complete_refresh_job(
  p_job_id UUID,
  p_status TEXT,
  p_result JSONB DEFAULT NULL,
  p_error TEXT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE refresh_jobs
  SET
    status = p_status,
    completed_at = NOW(),
    result = p_result,
    last_error = p_error,
    locked_at = NULL,
    locked_by = NULL,
    updated_at = NOW(),
    -- If failed and retries remaining, reschedule
    next_run_at = CASE
      WHEN p_status = 'failed' AND attempts < max_attempts
        THEN NOW() + (INTERVAL '1 minute' * power(2, attempts))
      ELSE next_run_at
    END,
    -- If failed and retries remaining, reset to pending
    status = CASE
      WHEN p_status = 'failed' AND attempts < max_attempts THEN 'pending'
      ELSE p_status
    END
  WHERE id = p_job_id;
END;
$$;

-- ============================================
-- 8. Cleanup function for old jobs (call periodically)
-- ============================================
CREATE OR REPLACE FUNCTION cleanup_old_refresh_jobs(
  p_retention_days INTEGER DEFAULT 7
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM refresh_jobs
  WHERE status IN ('success', 'failed', 'cancelled')
    AND completed_at < NOW() - (p_retention_days || ' days')::INTERVAL;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
