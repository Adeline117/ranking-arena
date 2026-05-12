-- Migration: 20260512123105_create_api_keys_table.sql
-- Self-service API keys for the B2B Data API.
-- Users create/revoke keys from /settings; validated in /api/v3.

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT 'Default',
  active boolean NOT NULL DEFAULT true,
  tier text NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'starter', 'pro')),
  daily_limit integer NOT NULL DEFAULT 100,
  request_count_today integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

-- Indexes
CREATE INDEX idx_api_keys_user_id ON api_keys(user_id) WHERE active = true;
CREATE INDEX idx_api_keys_key ON api_keys(key) WHERE active = true;

-- RLS
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own api_keys"
  ON api_keys FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own api_keys"
  ON api_keys FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own api_keys"
  ON api_keys FOR UPDATE
  USING (auth.uid() = user_id);

-- Daily counter reset (call via pg_cron at midnight UTC)
CREATE OR REPLACE FUNCTION reset_api_key_daily_counts()
RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  UPDATE api_keys SET request_count_today = 0 WHERE request_count_today > 0;
$$;

-- Atomic increment for request counting from /api/v3
CREATE OR REPLACE FUNCTION increment_api_key_usage(p_key text)
RETURNS TABLE(allowed boolean, remaining integer, daily_limit integer)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_daily_limit integer;
  v_new_count integer;
BEGIN
  UPDATE api_keys
  SET request_count_today = request_count_today + 1,
      last_used_at = now()
  WHERE key = p_key AND active = true
  RETURNING api_keys.daily_limit, request_count_today
  INTO v_daily_limit, v_new_count;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0, 0;
    RETURN;
  END IF;

  -- daily_limit = 0 means unlimited
  IF v_daily_limit = 0 THEN
    RETURN QUERY SELECT true, -1, 0;
  ELSE
    RETURN QUERY SELECT v_new_count <= v_daily_limit,
                        GREATEST(v_daily_limit - v_new_count, 0),
                        v_daily_limit;
  END IF;
END;
$$;
