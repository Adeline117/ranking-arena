-- Judge data gaps on SEALED publication (2026-11 audit P2-2).
--
-- public.get_data_gap_summary (20260507125805, read by the data-reconciliation
-- cron and admin monitoring) measured a trader's last update as
-- MAX(leaderboard_ranks.computed_at). Rank rows can be written and never
-- sealed, so a stalled publication looked gap-free (same blind spot as the
-- compute watchdog, audit P1-1).
--
-- Now a trader's last update is the newest seal time
-- (leaderboard_source_freshness.recorded_at, written by the seal RPC) of a
-- season in which public.public_ranked_leaderboard currently serves that
-- trader. A trader the public view does not serve at all has no last update
-- and is a gap.
--
-- Signature, return type, owner, SECURITY DEFINER and grants are unchanged
-- (CREATE OR REPLACE keeps the service-role-only ACL of 20260611190924).
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.public_ranked_leaderboard') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_source_freshness') IS NULL
     OR pg_catalog.to_regclass('public.trader_sources') IS NULL
     OR pg_catalog.to_regprocedure('public.get_data_gap_summary(integer)') IS NULL THEN
    RAISE EXCEPTION 'sealed gap summary requires the public serving authority and 20260507125805';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.get_data_gap_summary(p_max_age_hours INT DEFAULT 48)
RETURNS TABLE(
  source TEXT,
  gap_count BIGINT,
  avg_gap_hours NUMERIC,
  max_gap_hours NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RETURN QUERY
  WITH served AS MATERIALIZED (
    SELECT
      ranked.source,
      ranked.source_trader_id,
      MAX(freshness.recorded_at) AS last_published
    FROM public.public_ranked_leaderboard AS ranked
    JOIN public.leaderboard_source_freshness AS freshness
      ON freshness.season_id = ranked.season_id
     AND freshness.source = ranked.source
    GROUP BY ranked.source, ranked.source_trader_id
  ),
  trader_gaps AS (
    SELECT
      ts.source,
      MAX(served.last_published) AS last_published
    FROM public.trader_sources AS ts
    LEFT JOIN served
      ON served.source = ts.source
     AND served.source_trader_id = ts.source_trader_id
    WHERE ts.source NOT IN (
      'perpetual_protocol', 'whitebit', 'bitmart', 'btse',
      'vertex', 'apex_pro', 'rabbitx', 'bitget_spot', 'web3_bot', 'lbank'
    )
    GROUP BY ts.source, ts.source_trader_id
    HAVING MAX(served.last_published) IS NULL
       OR MAX(served.last_published) < NOW() - make_interval(hours => p_max_age_hours)
  )
  SELECT
    tg.source,
    COUNT(*)::BIGINT AS gap_count,
    ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - COALESCE(tg.last_published, '2020-01-01'::timestamptz))) / 3600), 1) AS avg_gap_hours,
    ROUND(MAX(EXTRACT(EPOCH FROM (NOW() - COALESCE(tg.last_published, '2020-01-01'::timestamptz))) / 3600), 1) AS max_gap_hours
  FROM trader_gaps AS tg
  GROUP BY tg.source
  ORDER BY gap_count DESC;
END;
$function$;

COMMENT ON FUNCTION public.get_data_gap_summary(integer) IS
  'Per-platform count of traders without a fresh sealed public publication';

COMMIT;
