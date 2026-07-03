-- Migration: 20260702173435_hero_stats_count_distinct_exchange.sql
-- Created: 2026-07-03T00:34:35Z
-- Description: get_hero_stats() counts exchanges by exchange prefix, not raw source.
--
-- Problem: hero stat "exchange_count" used COUNT(DISTINCT source), but `source`
-- is <exchange>_<market> (binance_futures / binance_spot / binance_web3, etc.).
-- ~18 real exchanges were being counted as ~45 sources. Fix: dedupe on
-- split_part(source, '_', 1) (the exchange prefix) in BOTH the fast path (cache)
-- and the fallback path (direct leaderboard_ranks scan).
--
-- Extra wrinkle (verified in prod 2026-07-02): leaderboard_count_cache never
-- purges retired sources — refresh_leaderboard_count_cache() only UPSERTs rows
-- for sources still present, so retired exchanges (aevo/kucoin/dydx/weex/etc.)
-- keep stale positive counts forever. That leaves 45 raw _gt0 rows spanning 32
-- exchange prefixes, while live leaderboard_ranks has only 18. A plain
-- split_part on the cache would therefore report 32, not ~18. The fast path
-- adds a freshness filter (updated_at within 2 days) so retired rows drop out —
-- every live source is refreshed together each cycle (~20 min), so live rows
-- share one recent timestamp while retired rows are 5–74 days old. The fallback
-- path reads live leaderboard_ranks directly and needs no such filter.
--
-- No schema change; STABLE SECURITY DEFINER SET search_path = public preserved.

-- Up
CREATE OR REPLACE FUNCTION public.get_hero_stats()
RETURNS TABLE(exchange_count bigint, trader_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '2s'
AS $$
DECLARE
  v_exchange_count bigint;
  v_trader_count bigint;
BEGIN
  -- Fast path: read from leaderboard_count_cache using the _gt0 threshold entries.
  SELECT total_count INTO v_trader_count
  FROM leaderboard_count_cache
  WHERE season_id = '90D' AND source = '_all_gt0'
  LIMIT 1;

  -- Count DISTINCT exchange prefix (split_part on first '_'), excluding stale
  -- rows for retired sources that the cache never purges (see header note).
  SELECT COUNT(DISTINCT split_part(source, '_', 1)) INTO v_exchange_count
  FROM leaderboard_count_cache
  WHERE season_id = '90D'
    AND source LIKE '%_gt0'
    AND source <> '_all_gt0'
    AND total_count > 0
    AND updated_at > NOW() - interval '2 days';

  -- Fallback: if cache is empty (cold deploy), direct COUNT query.
  IF v_trader_count IS NULL OR v_exchange_count = 0 THEN
    SELECT
      COUNT(DISTINCT split_part(source, '_', 1)) AS exchange_count,
      COUNT(*) AS trader_count
    INTO v_exchange_count, v_trader_count
    FROM leaderboard_ranks
    WHERE season_id = '90D'
      AND arena_score > 0
      AND (is_outlier IS NULL OR is_outlier = false);
  END IF;

  RETURN QUERY SELECT v_exchange_count, v_trader_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_hero_stats() TO anon, authenticated, service_role;
