-- Hero stats count the sealed public cohort.
--
-- get_hero_stats (last defined by 20260717130000) read leaderboard_count_cache
-- and, on a cold cache, counted raw public.leaderboard_ranks. Neither knows
-- whether the season is sealed or fresh, so the homepage hero could advertise
-- traders and boards the public leaderboard does not serve (an unsealed or
-- expired cohort, an isolated source).
--
-- It now counts public.public_ranked_leaderboard (90D): the view serves rows
-- only while the season's serving head is valid and every witnessed source is
-- inside the 48h freshness bound, so a stale or unsealed season counts 0
-- (lib/data/hero-stats.ts shows a real 0 as 0). Return shape, owner,
-- SECURITY DEFINER and grants are unchanged.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.public_ranked_leaderboard') IS NULL THEN
    RAISE EXCEPTION 'sealed hero stats require public.public_ranked_leaderboard (20260816151614)';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.get_hero_stats()
RETURNS TABLE(exchange_count bigint, trader_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '2s'
AS $function$
  SELECT pg_catalog.count(DISTINCT ranked.source), pg_catalog.count(*)
  FROM public.public_ranked_leaderboard AS ranked
  WHERE ranked.season_id = '90D';
$function$;

ALTER FUNCTION public.get_hero_stats() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_hero_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_hero_stats() TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
