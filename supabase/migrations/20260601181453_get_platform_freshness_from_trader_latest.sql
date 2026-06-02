-- Replace get_leaderboard_latest_by_source with get_platform_freshness.
-- Old RPC queried leaderboard_ranks.computed_at which only updates on scoring runs,
-- causing false "stale" alerts for platforms that fetch successfully but haven't been scored.
-- New RPC queries trader_latest.updated_at — the true data freshness signal.

CREATE OR REPLACE FUNCTION get_platform_freshness()
RETURNS TABLE (source text, latest timestamptz)
LANGUAGE SQL STABLE
SET search_path = public
AS $$
  SELECT platform AS source, max(updated_at) AS latest
  FROM trader_latest
  GROUP BY platform;
$$;

COMMENT ON FUNCTION get_platform_freshness IS 'Returns max(updated_at) per platform from trader_latest. Used by /api/health/pipeline for data freshness monitoring.';
