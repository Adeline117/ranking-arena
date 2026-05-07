-- Migration: Platform heartbeat table for Mac Mini monitoring visibility
-- Purpose: Mac Mini scraper platforms (blofin, phemex, kucoin) are invisible to
--          Vercel-based monitoring. This table receives heartbeats from all sources,
--          making their health visible in /admin/monitoring and /api/health/pipeline.

CREATE TABLE IF NOT EXISTS platform_heartbeats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  source_host TEXT NOT NULL DEFAULT 'unknown',  -- 'mac-mini', 'vps', 'vercel'
  status TEXT NOT NULL DEFAULT 'ok',            -- 'ok', 'error', 'timeout'
  trader_count INT DEFAULT 0,
  error_message TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Immutable wrapper for date_trunc (required for index expressions)
CREATE OR REPLACE FUNCTION immutable_date_trunc_hour(ts TIMESTAMPTZ)
RETURNS TIMESTAMPTZ AS $$
  SELECT date_trunc('hour', ts);
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public;

-- One heartbeat per platform per hour (prevent spam)
CREATE UNIQUE INDEX IF NOT EXISTS idx_heartbeats_platform_hourly
  ON platform_heartbeats (platform, immutable_date_trunc_hour(created_at));

-- Latest heartbeat per platform
CREATE INDEX IF NOT EXISTS idx_heartbeats_platform_latest
  ON platform_heartbeats (platform, created_at DESC);

-- Auto-cleanup: remove heartbeats older than 7 days
CREATE OR REPLACE FUNCTION cleanup_old_heartbeats()
RETURNS void AS $$
  DELETE FROM platform_heartbeats WHERE created_at < NOW() - INTERVAL '7 days';
$$ LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public;

-- RLS
ALTER TABLE platform_heartbeats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read heartbeats" ON platform_heartbeats
  FOR SELECT USING (true);

CREATE POLICY "Service write heartbeats" ON platform_heartbeats
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- View: latest heartbeat per platform (dashboard convenience)
CREATE OR REPLACE VIEW v_platform_health AS
SELECT DISTINCT ON (platform)
  platform,
  source_host,
  status,
  trader_count,
  error_message,
  created_at AS last_heartbeat,
  ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600, 1) AS hours_since_heartbeat
FROM platform_heartbeats
ORDER BY platform, created_at DESC;

COMMENT ON TABLE platform_heartbeats IS 'Heartbeats from all data sources (Vercel, Mac Mini, VPS)';
