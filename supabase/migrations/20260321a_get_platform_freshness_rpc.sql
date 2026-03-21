-- Create the get_platform_freshness RPC function
-- Returns the latest snapshot timestamp for each platform
-- Used by pipeline-health-check.mjs to verify all platforms are being refreshed

CREATE OR REPLACE FUNCTION get_platform_freshness()
RETURNS TABLE (
  platform text,
  latest_snapshot timestamptz,
  trader_count bigint
) AS $$
  SELECT
    s.platform,
    MAX(s.as_of_ts) AS latest_snapshot,
    COUNT(DISTINCT s.source_trader_id) AS trader_count
  FROM trader_snapshots_v2 s
  WHERE s.as_of_ts > NOW() - INTERVAL '7 days'
  GROUP BY s.platform
  ORDER BY s.platform;
$$ LANGUAGE sql STABLE;

-- Grant access to anon and authenticated roles
GRANT EXECUTE ON FUNCTION get_platform_freshness() TO anon;
GRANT EXECUTE ON FUNCTION get_platform_freshness() TO authenticated;
