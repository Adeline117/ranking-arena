-- Migration: 20260409173653_get_top_trust_ratio_rpc.sql
-- Created: 2026-04-10T00:36:53Z
-- Description: get_top_trust_ratio() RPC for the weekly metrics push.
--
-- WHY: scripts/openclaw/weekly-metrics.mjs computes "of the top-N traders in
-- the 90D leaderboard, how many have score_confidence='full'". The current
-- implementation does N+1 REST calls (1 for top-N + N for trader_sources
-- score_confidence lookup) and times out at the 30s Supabase statement limit
-- when the leaderboard_ranks → trader_sources join planner picks a bad path.
--
-- Doing it server-side as a single RPC with an explicit JOIN lets the
-- planner use the (source, source_trader_id) PK on trader_sources directly
-- and returns 3 numbers in <100ms.

CREATE OR REPLACE FUNCTION public.get_top_trust_ratio(
  p_season_id text DEFAULT '90D',
  p_top_n integer DEFAULT 10
)
RETURNS TABLE (
  full_count bigint,
  total_count bigint,
  ratio numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH top_traders AS (
    SELECT lr.source, lr.source_trader_id
    FROM leaderboard_ranks lr
    WHERE lr.season_id = p_season_id
      AND lr.rank IS NOT NULL
    ORDER BY lr.rank ASC
    LIMIT p_top_n
  ),
  joined AS (
    SELECT ts.score_confidence
    FROM top_traders tt
    JOIN trader_sources ts
      ON ts.source = tt.source
     AND ts.source_trader_id = tt.source_trader_id
  )
  SELECT
    COUNT(*) FILTER (WHERE score_confidence = 'full')::bigint AS full_count,
    COUNT(*)::bigint                                          AS total_count,
    CASE WHEN COUNT(*) > 0
      THEN ROUND(
        (COUNT(*) FILTER (WHERE score_confidence = 'full'))::numeric
        / COUNT(*)::numeric, 4)
      ELSE 0
    END AS ratio
  FROM joined;
$$;

COMMENT ON FUNCTION public.get_top_trust_ratio(text, integer) IS
  'Returns (full_count, total_count, ratio) of trust=full in the top-N of a season. '
  'Replaces the N+1 REST loop in scripts/openclaw/weekly-metrics.mjs.';

-- Permissions: anon + authenticated + service_role can call.
-- Read-only RPC, no risk of data exposure beyond what leaderboard_ranks +
-- trader_sources already return via REST.
GRANT EXECUTE ON FUNCTION public.get_top_trust_ratio(text, integer) TO anon, authenticated, service_role;
