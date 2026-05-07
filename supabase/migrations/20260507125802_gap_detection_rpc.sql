-- Migration: Gap detection RPCs for automated data reconciliation
-- Purpose: Find traders in trader_sources with no recent leaderboard data.
--          Called by /api/cron/data-reconciliation to identify and queue backfills.

CREATE OR REPLACE FUNCTION find_data_gaps(
  p_max_age_hours INT DEFAULT 48,
  p_limit INT DEFAULT 500
)
RETURNS TABLE(
  source TEXT,
  source_trader_id TEXT,
  last_computed TIMESTAMPTZ,
  gap_hours NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ts.source,
    ts.source_trader_id,
    MAX(lr.computed_at) AS last_computed,
    ROUND(EXTRACT(EPOCH FROM (NOW() - COALESCE(MAX(lr.computed_at), '2020-01-01'::timestamptz))) / 3600, 1) AS gap_hours
  FROM trader_sources ts
  LEFT JOIN leaderboard_ranks lr
    ON ts.source = lr.source
    AND ts.source_trader_id = lr.source_trader_id
  WHERE ts.source NOT IN (
    -- Dead/blocked platforms (DEAD_BLOCKED_PLATFORMS from lib/constants/exchanges.ts)
    'perpetual_protocol', 'whitebit', 'bitmart', 'btse',
    'vertex', 'apex_pro', 'rabbitx', 'bitget_spot', 'web3_bot', 'lbank'
  )
  GROUP BY ts.source, ts.source_trader_id
  HAVING MAX(lr.computed_at) IS NULL
     OR MAX(lr.computed_at) < NOW() - make_interval(hours => p_max_age_hours)
  ORDER BY gap_hours DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public;

-- Summary: count gaps per platform (for monitoring dashboard)
CREATE OR REPLACE FUNCTION get_data_gap_summary(p_max_age_hours INT DEFAULT 48)
RETURNS TABLE(
  source TEXT,
  gap_count BIGINT,
  avg_gap_hours NUMERIC,
  max_gap_hours NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  WITH trader_gaps AS (
    SELECT
      ts.source,
      MAX(lr.computed_at) AS last_computed
    FROM trader_sources ts
    LEFT JOIN leaderboard_ranks lr
      ON ts.source = lr.source AND ts.source_trader_id = lr.source_trader_id
    WHERE ts.source NOT IN (
      'perpetual_protocol', 'whitebit', 'bitmart', 'btse',
      'vertex', 'apex_pro', 'rabbitx', 'bitget_spot', 'web3_bot', 'lbank'
    )
    GROUP BY ts.source, ts.source_trader_id
    HAVING MAX(lr.computed_at) IS NULL
       OR MAX(lr.computed_at) < NOW() - make_interval(hours => p_max_age_hours)
  )
  SELECT
    tg.source,
    COUNT(*)::BIGINT AS gap_count,
    ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - COALESCE(tg.last_computed, '2020-01-01'::timestamptz))) / 3600), 1) AS avg_gap_hours,
    ROUND(MAX(EXTRACT(EPOCH FROM (NOW() - COALESCE(tg.last_computed, '2020-01-01'::timestamptz))) / 3600), 1) AS max_gap_hours
  FROM trader_gaps tg
  GROUP BY tg.source
  ORDER BY gap_count DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public;

COMMENT ON FUNCTION find_data_gaps IS 'Find traders with stale/missing leaderboard data for backfill';
COMMENT ON FUNCTION get_data_gap_summary IS 'Per-platform gap count summary for monitoring';
