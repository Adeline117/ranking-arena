-- Add get_active_connections() RPC for pool monitoring
-- Without this, /api/health/supabase-pool returns degraded status
-- and we have zero visibility into connection pool saturation.

-- Returns total active connections for current database
CREATE OR REPLACE FUNCTION get_active_connections()
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::integer
  FROM pg_stat_activity
  WHERE datname = current_database()
    AND state IS NOT NULL;
$$;

-- Returns detailed connection breakdown by state
-- Useful for diagnosing whether connections are idle, active, or waiting on locks
CREATE OR REPLACE FUNCTION get_connection_stats()
RETURNS TABLE (
  state text,
  count integer,
  oldest_query_seconds numeric
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(state, 'null_state') AS state,
    count(*)::integer AS count,
    COALESCE(
      EXTRACT(EPOCH FROM (now() - min(query_start)))::numeric,
      0
    ) AS oldest_query_seconds
  FROM pg_stat_activity
  WHERE datname = current_database()
  GROUP BY state
  ORDER BY count DESC;
$$;

-- Grant execute to authenticated and service_role
GRANT EXECUTE ON FUNCTION get_active_connections() TO service_role;
GRANT EXECUTE ON FUNCTION get_connection_stats() TO service_role;
