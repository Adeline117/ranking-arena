-- ROOT CAUSE FIX: pipeline health endpoint timed out fetching 50K leaderboard rows.
-- This RPC returns one row per platform via server-side GROUP BY (~31 rows total).

CREATE OR REPLACE FUNCTION get_leaderboard_latest_by_source()
RETURNS TABLE (source text, computed_at timestamptz)
LANGUAGE sql
STABLE
SET statement_timeout = '15s'
AS $$
  SELECT source, MAX(computed_at) AS computed_at
  FROM leaderboard_ranks
  WHERE computed_at >= NOW() - INTERVAL '7 days'
  GROUP BY source
$$;

GRANT EXECUTE ON FUNCTION get_leaderboard_latest_by_source() TO anon, authenticated, service_role;
