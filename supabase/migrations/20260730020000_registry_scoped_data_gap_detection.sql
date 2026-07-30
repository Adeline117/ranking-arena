-- Replace the May 2026 hand-maintained dead-platform denylist with the current
-- database ranking authority. A source is eligible for reconciliation only
-- when arena_freshness_expected_sources() declares an active+serving ranking
-- window for its public filter identity.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE OR REPLACE FUNCTION public.find_data_gaps(
  p_max_age_hours integer DEFAULT 48,
  p_limit integer DEFAULT 500
)
RETURNS TABLE(
  source text,
  source_trader_id text,
  last_computed timestamptz,
  gap_hours numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH eligible_sources AS MATERIALIZED (
    SELECT DISTINCT authority.filter_source AS source
    FROM public.arena_freshness_expected_sources() AS authority
  ),
  trader_gaps AS (
    SELECT
      trader.source,
      trader.source_trader_id,
      pg_catalog.max(rank.computed_at) AS last_computed
    FROM public.trader_sources AS trader
    JOIN eligible_sources AS eligible
      ON eligible.source = trader.source
    LEFT JOIN public.leaderboard_ranks AS rank
      ON rank.source = trader.source
     AND rank.source_trader_id = trader.source_trader_id
    GROUP BY trader.source, trader.source_trader_id
    HAVING pg_catalog.max(rank.computed_at) IS NULL
       OR pg_catalog.max(rank.computed_at) <
          pg_catalog.now() - pg_catalog.make_interval(hours => p_max_age_hours)
  )
  SELECT
    gap.source,
    gap.source_trader_id,
    gap.last_computed,
    pg_catalog.round(
      EXTRACT(
        EPOCH FROM (
          pg_catalog.now() -
          COALESCE(gap.last_computed, '2020-01-01 00:00:00+00'::timestamptz)
        )
      ) / 3600,
      1
    ) AS gap_hours
  FROM trader_gaps AS gap
  ORDER BY gap_hours DESC, gap.source, gap.source_trader_id
  LIMIT p_limit;
$function$;

CREATE OR REPLACE FUNCTION public.get_data_gap_summary(
  p_max_age_hours integer DEFAULT 48
)
RETURNS TABLE(
  source text,
  gap_count bigint,
  avg_gap_hours numeric,
  max_gap_hours numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH eligible_sources AS MATERIALIZED (
    SELECT DISTINCT authority.filter_source AS source
    FROM public.arena_freshness_expected_sources() AS authority
  ),
  trader_gaps AS (
    SELECT
      trader.source,
      trader.source_trader_id,
      pg_catalog.max(rank.computed_at) AS last_computed
    FROM public.trader_sources AS trader
    JOIN eligible_sources AS eligible
      ON eligible.source = trader.source
    LEFT JOIN public.leaderboard_ranks AS rank
      ON rank.source = trader.source
     AND rank.source_trader_id = trader.source_trader_id
    GROUP BY trader.source, trader.source_trader_id
    HAVING pg_catalog.max(rank.computed_at) IS NULL
       OR pg_catalog.max(rank.computed_at) <
          pg_catalog.now() - pg_catalog.make_interval(hours => p_max_age_hours)
  )
  SELECT
    gap.source,
    pg_catalog.count(*)::bigint AS gap_count,
    pg_catalog.round(
      pg_catalog.avg(
        EXTRACT(
          EPOCH FROM (
            pg_catalog.now() -
            COALESCE(gap.last_computed, '2020-01-01 00:00:00+00'::timestamptz)
          )
        ) / 3600
      ),
      1
    ) AS avg_gap_hours,
    pg_catalog.round(
      pg_catalog.max(
        EXTRACT(
          EPOCH FROM (
            pg_catalog.now() -
            COALESCE(gap.last_computed, '2020-01-01 00:00:00+00'::timestamptz)
          )
        ) / 3600
      ),
      1
    ) AS max_gap_hours
  FROM trader_gaps AS gap
  GROUP BY gap.source
  ORDER BY gap_count DESC, gap.source;
$function$;

ALTER FUNCTION public.find_data_gaps(integer, integer) OWNER TO postgres;
ALTER FUNCTION public.get_data_gap_summary(integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.find_data_gaps(integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_data_gap_summary(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_data_gaps(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_data_gap_summary(integer) TO service_role;

COMMENT ON FUNCTION public.find_data_gaps(integer, integer) IS
  'Service-only stale/missing rank details scoped to database-authoritative active serving ranking sources.';
COMMENT ON FUNCTION public.get_data_gap_summary(integer) IS
  'Service-only stale/missing rank summary scoped to database-authoritative active serving ranking sources.';

NOTIFY pgrst, 'reload schema';

COMMIT;
