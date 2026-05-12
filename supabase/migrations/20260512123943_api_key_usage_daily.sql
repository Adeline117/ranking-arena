-- Migration: 20260512123943_api_key_usage_daily.sql
-- Daily usage rollups for API key analytics.
-- Populated by rollup_api_key_usage() called via pg_cron at midnight UTC.

CREATE TABLE IF NOT EXISTS api_key_usage_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  date date NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  UNIQUE (api_key_id, date)
);

CREATE INDEX idx_api_key_usage_daily_key_date
  ON api_key_usage_daily(api_key_id, date DESC);

ALTER TABLE api_key_usage_daily ENABLE ROW LEVEL SECURITY;

-- Users can read usage for their own keys
CREATE POLICY "Users can read own api_key_usage_daily"
  ON api_key_usage_daily FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM api_keys
      WHERE api_keys.id = api_key_usage_daily.api_key_id
        AND api_keys.user_id = auth.uid()
    )
  );

-- Rollup function: snapshot today's counts into daily table, then reset counters
CREATE OR REPLACE FUNCTION rollup_api_key_usage()
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Upsert today's counts (handles re-runs gracefully)
  INSERT INTO api_key_usage_daily (api_key_id, date, request_count)
  SELECT id, CURRENT_DATE, request_count_today
  FROM api_keys
  WHERE request_count_today > 0
  ON CONFLICT (api_key_id, date)
  DO UPDATE SET request_count = EXCLUDED.request_count;

  -- Reset daily counters
  UPDATE api_keys SET request_count_today = 0 WHERE request_count_today > 0;
END;
$$;
