-- =====================================================
-- Migration 00015: Multi-Platform Trader Leaderboard System
-- =====================================================
-- Provides:
--   1. trader_sources_v2 – identity discovery & last-seen tracking
--   2. trader_profiles_v2 – enriched display data (pre-fetched)
--   3. trader_snapshots_v2 – per-window performance snapshots
--   4. trader_timeseries_v2 – equity curves, drawdown, daily PnL
--   5. refresh_jobs – async job queue for scraping
--
-- Design principles:
--   - All reads are from DB only; no sync scraping on page load.
--   - Idempotent writes: (platform, trader_key, window, date_bucket) deduplication.
--   - Quality flags stored per snapshot for UI degradation.
--   - Indexes optimized for: ranking queries, trader detail reads, job polling.
-- =====================================================

-- =====================================================
-- 1. Trader Sources (identity registry)
-- =====================================================
CREATE TABLE IF NOT EXISTS trader_sources_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  trader_key TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  profile_url TEXT,
  category TEXT NOT NULL DEFAULT 'futures', -- 'futures', 'spot', 'onchain'
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(platform, trader_key)
);

-- Index: lookup by platform
CREATE INDEX IF NOT EXISTS idx_tsv2_platform ON trader_sources_v2(platform);
-- Index: active traders per platform
CREATE INDEX IF NOT EXISTS idx_tsv2_platform_active ON trader_sources_v2(platform, is_active) WHERE is_active = TRUE;
-- Index: last seen for staleness checks
CREATE INDEX IF NOT EXISTS idx_tsv2_last_seen ON trader_sources_v2(last_seen DESC);
-- Index: category filter
CREATE INDEX IF NOT EXISTS idx_tsv2_category ON trader_sources_v2(category);

ALTER TABLE trader_sources_v2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY "trader_sources_v2_public_read" ON trader_sources_v2 FOR SELECT USING (true);
CREATE POLICY "trader_sources_v2_service_write" ON trader_sources_v2 FOR ALL USING (true) WITH CHECK (true);

-- =====================================================
-- 2. Trader Profiles (enriched display data)
-- =====================================================
CREATE TABLE IF NOT EXISTS trader_profiles_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  trader_key TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  bio TEXT,
  copier_count INTEGER,
  aum_usd DECIMAL(20, 2),
  active_since DATE,
  platform_tier TEXT,
  -- Additional metadata that varies by platform
  extra JSONB DEFAULT '{}',
  last_enriched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(platform, trader_key)
);

-- Index: fast lookup for trader detail page
CREATE INDEX IF NOT EXISTS idx_tpv2_platform_key ON trader_profiles_v2(platform, trader_key);
-- Index: enrichment staleness
CREATE INDEX IF NOT EXISTS idx_tpv2_enriched ON trader_profiles_v2(last_enriched_at ASC);

ALTER TABLE trader_profiles_v2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY "trader_profiles_v2_public_read" ON trader_profiles_v2 FOR SELECT USING (true);
CREATE POLICY "trader_profiles_v2_service_write" ON trader_profiles_v2 FOR ALL USING (true) WITH CHECK (true);

-- =====================================================
-- 3. Trader Snapshots (per-window performance data)
-- =====================================================
CREATE TABLE IF NOT EXISTS trader_snapshots_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  trader_key TEXT NOT NULL,
  window TEXT NOT NULL, -- '7d', '30d', '90d'
  as_of_ts TIMESTAMPTZ NOT NULL, -- bucket boundary (truncated to hour)
  -- Core metrics stored as JSONB for schema flexibility
  metrics JSONB NOT NULL DEFAULT '{}',
  -- Quality flags
  quality JSONB NOT NULL DEFAULT '{"is_complete": true, "missing_fields": [], "confidence": 1.0, "is_interpolated": false}',
  -- Denormalized scores for fast ranking queries
  arena_score DECIMAL(6, 2),
  roi_pct DECIMAL(12, 4),
  pnl_usd DECIMAL(20, 2),
  max_drawdown_pct DECIMAL(8, 4),
  win_rate_pct DECIMAL(6, 2),
  trades_count INTEGER,
  copier_count INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Idempotency: one snapshot per (platform, trader_key, window, hour-bucket)
  UNIQUE(platform, trader_key, window, as_of_ts)
);

-- Index: ranking query (sorted by arena_score within a window)
CREATE INDEX IF NOT EXISTS idx_tsnapv2_ranking
  ON trader_snapshots_v2(window, arena_score DESC NULLS LAST)
  WHERE arena_score IS NOT NULL;

-- Index: ranking with platform filter
CREATE INDEX IF NOT EXISTS idx_tsnapv2_ranking_platform
  ON trader_snapshots_v2(window, platform, arena_score DESC NULLS LAST)
  WHERE arena_score IS NOT NULL;

-- Index: trader detail page (latest snapshot per window)
CREATE INDEX IF NOT EXISTS idx_tsnapv2_trader_detail
  ON trader_snapshots_v2(platform, trader_key, window, as_of_ts DESC);

-- Index: ROI ranking
CREATE INDEX IF NOT EXISTS idx_tsnapv2_roi
  ON trader_snapshots_v2(window, roi_pct DESC NULLS LAST);

-- Index: PnL ranking
CREATE INDEX IF NOT EXISTS idx_tsnapv2_pnl
  ON trader_snapshots_v2(window, pnl_usd DESC NULLS LAST);

-- Index: freshness check
CREATE INDEX IF NOT EXISTS idx_tsnapv2_created
  ON trader_snapshots_v2(created_at DESC);

ALTER TABLE trader_snapshots_v2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY "trader_snapshots_v2_public_read" ON trader_snapshots_v2 FOR SELECT USING (true);
CREATE POLICY "trader_snapshots_v2_service_write" ON trader_snapshots_v2 FOR ALL USING (true) WITH CHECK (true);

-- =====================================================
-- 4. Trader Timeseries (equity curve, drawdown, daily PnL)
-- =====================================================
CREATE TABLE IF NOT EXISTS trader_timeseries_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  trader_key TEXT NOT NULL,
  series_type TEXT NOT NULL, -- 'equity_curve', 'drawdown', 'daily_pnl', 'position_count'
  -- Data stored as JSONB array: [{ts, value}, ...]
  data JSONB NOT NULL DEFAULT '[]',
  as_of_ts TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One series per type per day
  UNIQUE(platform, trader_key, series_type, (as_of_ts::date))
);

-- Index: trader detail page timeseries lookup
CREATE INDEX IF NOT EXISTS idx_ttsv2_trader_series
  ON trader_timeseries_v2(platform, trader_key, series_type, as_of_ts DESC);

ALTER TABLE trader_timeseries_v2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY "trader_timeseries_v2_public_read" ON trader_timeseries_v2 FOR SELECT USING (true);
CREATE POLICY "trader_timeseries_v2_service_write" ON trader_timeseries_v2 FOR ALL USING (true) WITH CHECK (true);

-- =====================================================
-- 5. Refresh Jobs (async scraping queue)
-- =====================================================
CREATE TABLE IF NOT EXISTS refresh_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type TEXT NOT NULL, -- 'discovery', 'snapshot', 'profile', 'timeseries', 'full_refresh'
  platform TEXT NOT NULL,
  trader_key TEXT, -- NULL for discovery jobs
  priority INTEGER NOT NULL DEFAULT 3, -- 1=highest, 5=lowest
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'running', 'completed', 'failed', 'cancelled'
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Idempotency: one active job per target per day
  idempotency_key TEXT NOT NULL,
  UNIQUE(idempotency_key)
);

-- Index: job polling (pending jobs ordered by priority then next_run_at)
CREATE INDEX IF NOT EXISTS idx_rj_pending
  ON refresh_jobs(priority ASC, next_run_at ASC)
  WHERE status = 'pending' AND next_run_at <= NOW();

-- Index: running jobs (for timeout detection)
CREATE INDEX IF NOT EXISTS idx_rj_running
  ON refresh_jobs(started_at ASC)
  WHERE status = 'running';

-- Index: job lookup by trader
CREATE INDEX IF NOT EXISTS idx_rj_trader
  ON refresh_jobs(platform, trader_key, status);

-- Index: cleanup old completed/failed jobs
CREATE INDEX IF NOT EXISTS idx_rj_completed
  ON refresh_jobs(completed_at ASC)
  WHERE status IN ('completed', 'failed');

ALTER TABLE refresh_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "refresh_jobs_public_read" ON refresh_jobs FOR SELECT USING (true);
CREATE POLICY "refresh_jobs_service_write" ON refresh_jobs FOR ALL USING (true) WITH CHECK (true);

-- =====================================================
-- 6. Helper: Latest Snapshot View (materialized for speed)
-- =====================================================
-- This view gives the latest snapshot per (platform, trader_key, window).
-- Used for ranking queries and trader detail pages.
CREATE OR REPLACE VIEW latest_trader_snapshots AS
SELECT DISTINCT ON (platform, trader_key, window)
  id,
  platform,
  trader_key,
  window,
  as_of_ts,
  metrics,
  quality,
  arena_score,
  roi_pct,
  pnl_usd,
  max_drawdown_pct,
  win_rate_pct,
  trades_count,
  copier_count,
  created_at
FROM trader_snapshots_v2
ORDER BY platform, trader_key, window, as_of_ts DESC;

-- =====================================================
-- 7. Function: Claim next job from queue (atomic)
-- =====================================================
CREATE OR REPLACE FUNCTION claim_next_refresh_job(p_platform TEXT DEFAULT NULL)
RETURNS SETOF refresh_jobs
LANGUAGE plpgsql
AS $$
DECLARE
  v_job refresh_jobs;
BEGIN
  -- Atomically claim the highest-priority pending job
  SELECT * INTO v_job
  FROM refresh_jobs
  WHERE status = 'pending'
    AND next_run_at <= NOW()
    AND (p_platform IS NULL OR platform = p_platform)
  ORDER BY priority ASC, next_run_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_job.id IS NOT NULL THEN
    UPDATE refresh_jobs
    SET status = 'running',
        started_at = NOW(),
        attempts = attempts + 1
    WHERE id = v_job.id;

    v_job.status := 'running';
    v_job.started_at := NOW();
    v_job.attempts := v_job.attempts + 1;
    RETURN NEXT v_job;
  END IF;
  RETURN;
END;
$$;

-- =====================================================
-- 8. Function: Complete/fail a job
-- =====================================================
CREATE OR REPLACE FUNCTION complete_refresh_job(
  p_job_id UUID,
  p_status TEXT, -- 'completed' or 'failed'
  p_error TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_status = 'failed' THEN
    UPDATE refresh_jobs
    SET status = CASE
          WHEN attempts >= max_attempts THEN 'failed'
          ELSE 'pending'
        END,
        last_error = p_error,
        completed_at = CASE WHEN attempts >= max_attempts THEN NOW() ELSE NULL END,
        next_run_at = CASE
          WHEN attempts >= max_attempts THEN next_run_at
          ELSE NOW() + (POWER(2, attempts) || ' minutes')::INTERVAL
        END
    WHERE id = p_job_id;
  ELSE
    UPDATE refresh_jobs
    SET status = 'completed',
        completed_at = NOW(),
        last_error = NULL
    WHERE id = p_job_id;
  END IF;
END;
$$;

-- =====================================================
-- 9. Function: Enqueue refresh job (idempotent)
-- =====================================================
CREATE OR REPLACE FUNCTION enqueue_refresh_job(
  p_job_type TEXT,
  p_platform TEXT,
  p_trader_key TEXT,
  p_priority INTEGER DEFAULT 3
)
RETURNS refresh_jobs
LANGUAGE plpgsql
AS $$
DECLARE
  v_key TEXT;
  v_job refresh_jobs;
BEGIN
  -- Idempotency key: one job per target per day
  v_key := p_job_type || ':' || p_platform || ':' || COALESCE(p_trader_key, '*') || ':' || CURRENT_DATE::TEXT;

  -- Try to insert; if conflict, return existing
  INSERT INTO refresh_jobs (job_type, platform, trader_key, priority, idempotency_key)
  VALUES (p_job_type, p_platform, p_trader_key, p_priority, v_key)
  ON CONFLICT (idempotency_key) DO UPDATE
    SET priority = LEAST(refresh_jobs.priority, EXCLUDED.priority) -- escalate priority if higher
  RETURNING * INTO v_job;

  RETURN v_job;
END;
$$;

-- =====================================================
-- 10. Cleanup: Auto-delete old completed jobs (>7 days)
-- =====================================================
CREATE OR REPLACE FUNCTION cleanup_old_jobs()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  DELETE FROM refresh_jobs
  WHERE status IN ('completed', 'failed', 'cancelled')
    AND completed_at < NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- =====================================================
-- 11. Trigger: Auto-update updated_at
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_trader_sources_v2_updated
  BEFORE UPDATE ON trader_sources_v2
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_trader_profiles_v2_updated
  BEFORE UPDATE ON trader_profiles_v2
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
