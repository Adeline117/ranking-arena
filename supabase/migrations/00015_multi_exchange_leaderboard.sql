-- Multi-Exchange Leaderboard Schema
-- Version: 2.0.0
-- Adds unified tables for multi-platform trader data with proper
-- window support, quality flags, job queue, and rate limiting.

-- ============================================
-- 1. Extend trader_sources with market_type and activity tracking
-- ============================================

-- Add new columns to existing trader_sources table
ALTER TABLE trader_sources
  ADD COLUMN IF NOT EXISTS market_type TEXT DEFAULT 'futures',
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS discovered_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS raw JSONB;

-- Update unique constraint to include market_type
-- First drop old constraint if exists, then create new one
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trader_sources_source_source_trader_id_key'
  ) THEN
    ALTER TABLE trader_sources DROP CONSTRAINT trader_sources_source_source_trader_id_key;
  END IF;
END $$;

ALTER TABLE trader_sources
  ADD CONSTRAINT trader_sources_platform_market_trader_key
  UNIQUE (source, market_type, source_trader_id);

-- Rename 'source' column alias: we keep 'source' for backward compat
-- but add platform as an alias view concept

CREATE INDEX IF NOT EXISTS idx_trader_sources_platform_market
  ON trader_sources(source, market_type);
CREATE INDEX IF NOT EXISTS idx_trader_sources_active
  ON trader_sources(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_trader_sources_last_seen
  ON trader_sources(last_seen_at DESC);

-- ============================================
-- 2. Trader Profiles (enriched data)
-- ============================================

CREATE TABLE IF NOT EXISTS trader_profiles (
  id BIGSERIAL PRIMARY KEY,
  platform TEXT NOT NULL,
  market_type TEXT NOT NULL DEFAULT 'futures',
  trader_key TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  bio TEXT,
  tags TEXT[] DEFAULT '{}',
  profile_url TEXT,
  followers INTEGER,
  copiers INTEGER,
  aum NUMERIC(18, 2),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_enriched_at TIMESTAMPTZ,
  provenance JSONB DEFAULT '{}'::jsonb,
  UNIQUE (platform, market_type, trader_key)
);

CREATE INDEX IF NOT EXISTS idx_trader_profiles_lookup
  ON trader_profiles(platform, market_type, trader_key);
CREATE INDEX IF NOT EXISTS idx_trader_profiles_updated
  ON trader_profiles(updated_at DESC);

-- RLS: profiles are publicly readable
ALTER TABLE trader_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Trader profiles are viewable by everyone"
  ON trader_profiles FOR SELECT USING (true);

CREATE POLICY "Service role can manage trader profiles"
  ON trader_profiles FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================
-- 3. Trader Snapshots V2 (window-based)
-- ============================================

-- Add window and metrics columns to existing trader_snapshots
ALTER TABLE trader_snapshots
  ADD COLUMN IF NOT EXISTS market_type TEXT DEFAULT 'futures',
  ADD COLUMN IF NOT EXISTS window TEXT,
  ADD COLUMN IF NOT EXISTS as_of_ts TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS metrics JSONB,
  ADD COLUMN IF NOT EXISTS quality_flags JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS sharpe_ratio NUMERIC(8, 4),
  ADD COLUMN IF NOT EXISTS sortino_ratio NUMERIC(8, 4),
  ADD COLUMN IF NOT EXISTS copiers INTEGER,
  ADD COLUMN IF NOT EXISTS aum NUMERIC(18, 2),
  ADD COLUMN IF NOT EXISTS platform_rank INTEGER,
  ADD COLUMN IF NOT EXISTS return_score NUMERIC(6, 2),
  ADD COLUMN IF NOT EXISTS drawdown_score NUMERIC(6, 2),
  ADD COLUMN IF NOT EXISTS stability_score NUMERIC(6, 2);

-- Backfill window from season_id for existing data
UPDATE trader_snapshots
SET window = CASE
  WHEN season_id LIKE '%7D%' OR season_id LIKE '%7d%' THEN '7d'
  WHEN season_id LIKE '%30D%' OR season_id LIKE '%30d%' THEN '30d'
  WHEN season_id LIKE '%90D%' OR season_id LIKE '%90d%' THEN '90d'
  ELSE '30d'  -- default
END
WHERE window IS NULL;

-- Deduplication constraint: one snapshot per trader per window per timestamp
-- Using a partial unique index to allow the constraint alongside existing data
CREATE UNIQUE INDEX IF NOT EXISTS idx_trader_snapshots_dedup
  ON trader_snapshots(source, market_type, source_trader_id, window, as_of_ts)
  WHERE as_of_ts IS NOT NULL;

-- Leaderboard query index: platform + market_type + window sorted by score
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_leaderboard
  ON trader_snapshots(source, market_type, window, arena_score DESC NULLS LAST)
  WHERE arena_score IS NOT NULL;

-- Leaderboard by ROI
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_leaderboard_roi
  ON trader_snapshots(source, market_type, window, roi DESC NULLS LAST);

-- Trader detail lookup
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_trader_detail
  ON trader_snapshots(source, market_type, source_trader_id, window);

-- Latest snapshot per trader per window
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_latest
  ON trader_snapshots(source, market_type, source_trader_id, window, captured_at DESC);

-- ============================================
-- 4. Trader Timeseries
-- ============================================

CREATE TABLE IF NOT EXISTS trader_timeseries (
  id BIGSERIAL PRIMARY KEY,
  platform TEXT NOT NULL,
  market_type TEXT NOT NULL DEFAULT 'futures',
  trader_key TEXT NOT NULL,
  series_type TEXT NOT NULL,  -- equity_curve, daily_pnl, daily_roi, drawdown_curve, aum_history
  as_of_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (platform, market_type, trader_key, series_type)
);

CREATE INDEX IF NOT EXISTS idx_trader_timeseries_lookup
  ON trader_timeseries(platform, market_type, trader_key);
CREATE INDEX IF NOT EXISTS idx_trader_timeseries_type
  ON trader_timeseries(platform, market_type, trader_key, series_type);

ALTER TABLE trader_timeseries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Trader timeseries are viewable by everyone"
  ON trader_timeseries FOR SELECT USING (true);

CREATE POLICY "Service role can manage trader timeseries"
  ON trader_timeseries FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================
-- 5. Refresh Jobs Queue
-- ============================================

CREATE TABLE IF NOT EXISTS refresh_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type TEXT NOT NULL,  -- DISCOVER, SNAPSHOT_REFRESH, PROFILE_ENRICH, TIMESERIES_REFRESH
  platform TEXT NOT NULL,
  market_type TEXT NOT NULL DEFAULT 'futures',
  trader_key TEXT,         -- NULL for DISCOVER jobs
  window TEXT,             -- NULL for non-snapshot jobs
  priority INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, running, completed, failed, cancelled
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,          -- Worker instance ID
  last_error TEXT,
  result JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Job queue polling index (primary query for workers)
CREATE INDEX IF NOT EXISTS idx_refresh_jobs_queue
  ON refresh_jobs(status, next_run_at, priority)
  WHERE status = 'pending';

-- Job deduplication: avoid duplicate pending jobs for same target
CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_jobs_dedup
  ON refresh_jobs(job_type, platform, market_type, COALESCE(trader_key, ''), COALESCE(window, ''))
  WHERE status IN ('pending', 'running');

-- Job lookup by trader
CREATE INDEX IF NOT EXISTS idx_refresh_jobs_trader
  ON refresh_jobs(platform, market_type, trader_key)
  WHERE trader_key IS NOT NULL;

-- Stale job cleanup
CREATE INDEX IF NOT EXISTS idx_refresh_jobs_locked
  ON refresh_jobs(locked_at)
  WHERE status = 'running';

ALTER TABLE refresh_jobs ENABLE ROW LEVEL SECURITY;

-- Jobs are not publicly readable (only status via API)
CREATE POLICY "Service role can manage refresh jobs"
  ON refresh_jobs FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Authenticated users can view their own refresh requests
CREATE POLICY "Users can view pending jobs"
  ON refresh_jobs FOR SELECT
  USING (true);  -- Status is non-sensitive, allow public read

-- ============================================
-- 6. Platform Rate Limits & Circuit Breaker State
-- ============================================

CREATE TABLE IF NOT EXISTS platform_rate_limits (
  platform TEXT NOT NULL,
  market_type TEXT NOT NULL DEFAULT 'futures',
  requests_per_minute INTEGER NOT NULL DEFAULT 30,
  max_concurrency INTEGER NOT NULL DEFAULT 2,
  cooldown_until TIMESTAMPTZ,  -- Circuit breaker: don't call until this time
  consecutive_failures INTEGER DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (platform, market_type)
);

-- Insert default rate limits for all platforms
INSERT INTO platform_rate_limits (platform, market_type, requests_per_minute, max_concurrency) VALUES
  ('binance', 'futures', 20, 2),
  ('binance', 'spot', 20, 2),
  ('binance', 'web3', 15, 1),
  ('bybit', 'futures', 20, 2),
  ('bybit', 'copy', 20, 2),
  ('bitget', 'futures', 20, 2),
  ('bitget', 'spot', 20, 2),
  ('mexc', 'futures', 15, 1),
  ('coinex', 'futures', 15, 1),
  ('okx', 'futures', 15, 2),
  ('okx', 'copy', 15, 2),
  ('kucoin', 'futures', 15, 1),
  ('bitmart', 'futures', 10, 1),
  ('phemex', 'futures', 10, 1),
  ('htx', 'futures', 10, 1),
  ('weex', 'futures', 10, 1),
  ('gmx', 'perp', 30, 3),
  ('dydx', 'perp', 30, 3),
  ('hyperliquid', 'perp', 30, 3)
ON CONFLICT (platform, market_type) DO NOTHING;

ALTER TABLE platform_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform rate limits are viewable by everyone"
  ON platform_rate_limits FOR SELECT USING (true);

CREATE POLICY "Service role can manage platform rate limits"
  ON platform_rate_limits FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================
-- 7. Helper Functions
-- ============================================

-- Function to atomically claim a job from the queue
CREATE OR REPLACE FUNCTION claim_refresh_job(
  p_worker_id TEXT,
  p_platforms TEXT[] DEFAULT NULL,
  p_batch_size INTEGER DEFAULT 1
)
RETURNS SETOF refresh_jobs AS $$
BEGIN
  RETURN QUERY
  UPDATE refresh_jobs
  SET
    status = 'running',
    locked_at = NOW(),
    locked_by = p_worker_id,
    attempts = attempts + 1,
    updated_at = NOW()
  WHERE id IN (
    SELECT id FROM refresh_jobs
    WHERE status = 'pending'
      AND next_run_at <= NOW()
      AND attempts < max_attempts
      AND (p_platforms IS NULL OR platform = ANY(p_platforms))
    ORDER BY priority ASC, next_run_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$ LANGUAGE plpgsql;

-- Function to release stale jobs (locked > 5 minutes with no completion)
CREATE OR REPLACE FUNCTION release_stale_jobs(p_stale_threshold INTERVAL DEFAULT '5 minutes')
RETURNS INTEGER AS $$
DECLARE
  released_count INTEGER;
BEGIN
  UPDATE refresh_jobs
  SET
    status = 'pending',
    locked_at = NULL,
    locked_by = NULL,
    next_run_at = NOW() + (attempts * INTERVAL '30 seconds'),  -- Backoff
    updated_at = NOW()
  WHERE status = 'running'
    AND locked_at < NOW() - p_stale_threshold;

  GET DIAGNOSTICS released_count = ROW_COUNT;
  RETURN released_count;
END;
$$ LANGUAGE plpgsql;

-- Function to get latest snapshot for a trader across all windows
CREATE OR REPLACE FUNCTION get_trader_latest_snapshots(
  p_platform TEXT,
  p_market_type TEXT,
  p_trader_key TEXT
)
RETURNS TABLE (
  window TEXT,
  metrics JSONB,
  quality_flags JSONB,
  arena_score NUMERIC,
  roi NUMERIC,
  pnl NUMERIC,
  captured_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (ts.window)
    ts.window,
    ts.metrics,
    ts.quality_flags,
    ts.arena_score,
    ts.roi,
    ts.pnl,
    ts.captured_at
  FROM trader_snapshots ts
  WHERE ts.source = p_platform
    AND ts.market_type = p_market_type
    AND ts.source_trader_id = p_trader_key
    AND ts.window IS NOT NULL
  ORDER BY ts.window, ts.captured_at DESC;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 8. Updated_at Trigger
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to new tables
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trigger_trader_profiles_updated_at') THEN
    CREATE TRIGGER trigger_trader_profiles_updated_at
      BEFORE UPDATE ON trader_profiles
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trigger_trader_timeseries_updated_at') THEN
    CREATE TRIGGER trigger_trader_timeseries_updated_at
      BEFORE UPDATE ON trader_timeseries
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trigger_refresh_jobs_updated_at') THEN
    CREATE TRIGGER trigger_refresh_jobs_updated_at
      BEFORE UPDATE ON refresh_jobs
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
