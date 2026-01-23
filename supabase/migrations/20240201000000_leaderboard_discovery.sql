-- Leaderboard Discovery Integration Schema
-- Canonical tables for multi-platform trader data aggregation

-- ============================================
-- Table: trader_sources
-- Tracks discovered trader entries across platforms
-- ============================================
CREATE TABLE IF NOT EXISTS trader_sources_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  market_type TEXT NOT NULL DEFAULT 'futures',
  trader_key TEXT NOT NULL,
  display_name TEXT,
  profile_url TEXT,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_active BOOLEAN NOT NULL DEFAULT true,
  raw JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_trader_sources_v2 UNIQUE (platform, market_type, trader_key)
);

CREATE INDEX idx_trader_sources_v2_platform ON trader_sources_v2 (platform, market_type);
CREATE INDEX idx_trader_sources_v2_active ON trader_sources_v2 (is_active, last_seen_at DESC);

-- ============================================
-- Table: trader_profiles
-- Enriched trader profile data
-- ============================================
CREATE TABLE IF NOT EXISTS trader_profiles_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  market_type TEXT NOT NULL DEFAULT 'futures',
  trader_key TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  bio TEXT,
  tags TEXT[] DEFAULT '{}',
  profile_url TEXT,
  followers INTEGER DEFAULT 0,
  copiers INTEGER DEFAULT 0,
  aum NUMERIC,
  provenance JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_enriched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_trader_profiles_v2 UNIQUE (platform, market_type, trader_key)
);

CREATE INDEX idx_trader_profiles_v2_lookup ON trader_profiles_v2 (platform, market_type, trader_key);

-- ============================================
-- Table: trader_snapshots_v2
-- Point-in-time performance snapshots (canonical metrics)
-- ============================================
CREATE TABLE IF NOT EXISTS trader_snapshots_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  market_type TEXT NOT NULL DEFAULT 'futures',
  trader_key TEXT NOT NULL,
  window TEXT NOT NULL, -- '7d', '30d', '90d'
  as_of_ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Core metrics stored in JSONB for flexibility
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Metrics breakdown (denormalized for query performance)
  roi_pct NUMERIC,
  pnl_usd NUMERIC,
  win_rate NUMERIC,
  max_drawdown NUMERIC,
  trades_count INTEGER,
  followers INTEGER,
  copiers INTEGER,
  sharpe_ratio NUMERIC,
  arena_score NUMERIC,
  return_score NUMERIC,
  drawdown_score NUMERIC,
  stability_score NUMERIC,
  -- Quality tracking
  quality_flags JSONB DEFAULT '{}'::jsonb,
  provenance JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Deduplicate: one snapshot per trader per window per 1-hour bucket
  CONSTRAINT uq_trader_snapshots_v2 UNIQUE (platform, market_type, trader_key, window, (date_trunc('hour', as_of_ts)))
);

-- Ranking query index: platform + market_type + window, sort by roi_pct or arena_score
CREATE INDEX idx_snapshots_v2_ranking ON trader_snapshots_v2 (platform, market_type, window, arena_score DESC NULLS LAST)
  WHERE roi_pct IS NOT NULL;
CREATE INDEX idx_snapshots_v2_roi_ranking ON trader_snapshots_v2 (platform, market_type, window, roi_pct DESC NULLS LAST);
CREATE INDEX idx_snapshots_v2_trader ON trader_snapshots_v2 (platform, market_type, trader_key, window, as_of_ts DESC);
CREATE INDEX idx_snapshots_v2_freshness ON trader_snapshots_v2 (as_of_ts DESC);

-- ============================================
-- Table: trader_timeseries
-- Historical data series (equity curves, daily returns, etc.)
-- ============================================
CREATE TABLE IF NOT EXISTS trader_timeseries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  market_type TEXT NOT NULL DEFAULT 'futures',
  trader_key TEXT NOT NULL,
  series_type TEXT NOT NULL, -- 'equity_curve', 'daily_pnl', 'positions'
  as_of_ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  data JSONB NOT NULL DEFAULT '[]'::jsonb,
  provenance JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_trader_timeseries UNIQUE (platform, market_type, trader_key, series_type, (date_trunc('hour', as_of_ts)))
);

CREATE INDEX idx_timeseries_lookup ON trader_timeseries (platform, market_type, trader_key, series_type, as_of_ts DESC);

-- ============================================
-- Table: refresh_jobs
-- Queue for background data refresh tasks
-- ============================================
CREATE TABLE IF NOT EXISTS refresh_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type TEXT NOT NULL, -- 'DISCOVER', 'SNAPSHOT', 'PROFILE', 'TIMESERIES'
  platform TEXT NOT NULL,
  market_type TEXT NOT NULL DEFAULT 'futures',
  trader_key TEXT,
  priority INTEGER NOT NULL DEFAULT 50, -- 0=highest, 100=lowest
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'running', 'completed', 'failed', 'dead'
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Job queue pickup index
CREATE INDEX idx_refresh_jobs_queue ON refresh_jobs (status, next_run_at, priority)
  WHERE status IN ('pending', 'failed');
CREATE INDEX idx_refresh_jobs_platform ON refresh_jobs (platform, market_type, job_type);
CREATE INDEX idx_refresh_jobs_trader ON refresh_jobs (platform, market_type, trader_key)
  WHERE trader_key IS NOT NULL;
CREATE INDEX idx_refresh_jobs_locked ON refresh_jobs (locked_at)
  WHERE status = 'running';

-- ============================================
-- Table: platform_health
-- Circuit breaker state per platform
-- ============================================
CREATE TABLE IF NOT EXISTS platform_health (
  platform TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'healthy', -- 'healthy', 'degraded', 'circuit_open'
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_error TEXT,
  circuit_opened_at TIMESTAMPTZ,
  circuit_closes_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- RLS Policies
-- ============================================

-- Enable RLS on all tables
ALTER TABLE trader_sources_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE trader_profiles_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE trader_snapshots_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE trader_timeseries ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_health ENABLE ROW LEVEL SECURITY;

-- Anonymous read access for public data
CREATE POLICY "anon_read_sources" ON trader_sources_v2
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "anon_read_profiles" ON trader_profiles_v2
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "anon_read_snapshots" ON trader_snapshots_v2
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "anon_read_timeseries" ON trader_timeseries
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "anon_read_health" ON platform_health
  FOR SELECT TO anon, authenticated USING (true);

-- Service role write access
CREATE POLICY "service_write_sources" ON trader_sources_v2
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_write_profiles" ON trader_profiles_v2
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_write_snapshots" ON trader_snapshots_v2
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_write_timeseries" ON trader_timeseries
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_write_jobs" ON refresh_jobs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_write_health" ON platform_health
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- Helper functions
-- ============================================

-- Function to claim next available job
CREATE OR REPLACE FUNCTION claim_refresh_job(
  p_worker_id TEXT,
  p_platforms TEXT[] DEFAULT NULL,
  p_job_types TEXT[] DEFAULT NULL
) RETURNS SETOF refresh_jobs AS $$
  UPDATE refresh_jobs
  SET status = 'running',
      locked_at = now(),
      locked_by = p_worker_id,
      attempts = attempts + 1,
      updated_at = now()
  WHERE id = (
    SELECT id FROM refresh_jobs
    WHERE status IN ('pending', 'failed')
      AND next_run_at <= now()
      AND attempts < max_attempts
      AND (p_platforms IS NULL OR platform = ANY(p_platforms))
      AND (p_job_types IS NULL OR job_type = ANY(p_job_types))
    ORDER BY priority ASC, next_run_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$ LANGUAGE SQL;

-- Function to release stale locks (jobs locked > 5 minutes)
CREATE OR REPLACE FUNCTION release_stale_locks() RETURNS INTEGER AS $$
  WITH released AS (
    UPDATE refresh_jobs
    SET status = 'pending',
        locked_at = NULL,
        locked_by = NULL,
        updated_at = now()
    WHERE status = 'running'
      AND locked_at < now() - interval '5 minutes'
    RETURNING id
  )
  SELECT count(*)::integer FROM released;
$$ LANGUAGE SQL;
