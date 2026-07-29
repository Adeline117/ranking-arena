-- Platform statistics are public ranking data and must be aggregated from the
-- same immutable cohort and exact source scope authorized by the application.
-- The legacy get_platform_stats RPC accepts only a season, so an atomic
-- publication cutover can otherwise mix old and new rank generations.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
DECLARE
  v_relation pg_catalog.regclass := pg_catalog.to_regclass('public.leaderboard_ranks');
  v_expected_columns integer;
BEGIN
  IF v_relation IS NULL THEN
    RAISE EXCEPTION 'public.leaderboard_ranks is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation
      AND relation.relkind IN ('r', 'p')
  ) THEN
    RAISE EXCEPTION 'public.leaderboard_ranks must be a table or partitioned table';
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_expected_columns
  FROM (
    VALUES
      (
        'season_id',
        ARRAY[
          'text'::pg_catalog.regtype::oid,
          'character varying'::pg_catalog.regtype::oid
        ]
      ),
      (
        'source',
        ARRAY[
          'text'::pg_catalog.regtype::oid,
          'character varying'::pg_catalog.regtype::oid
        ]
      ),
      (
        'rank_publication_id',
        ARRAY['uuid'::pg_catalog.regtype::oid]
      ),
      (
        'arena_score',
        ARRAY['numeric'::pg_catalog.regtype::oid]
      ),
      (
        'roi',
        ARRAY['numeric'::pg_catalog.regtype::oid]
      ),
      (
        'win_rate',
        ARRAY['numeric'::pg_catalog.regtype::oid]
      ),
      (
        'is_outlier',
        ARRAY['boolean'::pg_catalog.regtype::oid]
      )
  ) AS expected(attname, allowed_type_oids)
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = v_relation
   AND attribute.attname = expected.attname
   AND attribute.atttypid = ANY(expected.allowed_type_oids)
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped;

  IF v_expected_columns <> 7 THEN
    RAISE EXCEPTION 'public.leaderboard_ranks platform-stat column contract is invalid';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.get_public_platform_stats(
  p_season_id text,
  p_score_cohort_id uuid,
  p_allowed_sources text[]
)
RETURNS TABLE(
  platform text,
  trader_count bigint,
  avg_score numeric,
  avg_roi numeric,
  median_score numeric,
  avg_win_rate numeric
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF p_season_id IS NULL OR p_season_id NOT IN ('7D', '30D', '90D') THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'p_season_id must be exactly 7D, 30D, or 90D';
  END IF;

  IF p_score_cohort_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'p_score_cohort_id is required';
  END IF;

  IF p_allowed_sources IS NULL
     OR COALESCE(pg_catalog.array_ndims(p_allowed_sources), 0) <> 1
     OR pg_catalog.array_lower(p_allowed_sources, 1) <> 1
     OR pg_catalog.cardinality(p_allowed_sources) < 1
     OR pg_catalog.cardinality(p_allowed_sources) > 256 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'p_allowed_sources must contain between 1 and 256 canonical sources';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(p_allowed_sources) AS input(source)
    WHERE input.source IS NULL
       OR pg_catalog.length(input.source) > 128
       OR input.source !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'p_allowed_sources contains a malformed canonical source';
  END IF;

  IF (
    SELECT pg_catalog.count(*) <> pg_catalog.count(DISTINCT input.source)
    FROM pg_catalog.unnest(p_allowed_sources) AS input(source)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'p_allowed_sources must not contain duplicates';
  END IF;

  RETURN QUERY
  WITH allowed AS MATERIALIZED (
    SELECT input.source
    FROM pg_catalog.unnest(p_allowed_sources) AS input(source)
  )
  SELECT
    ranks.source::text AS platform,
    pg_catalog.count(*)::bigint AS trader_count,
    pg_catalog.round(pg_catalog.avg(ranks.arena_score)::numeric, 2) AS avg_score,
    pg_catalog.round(
      COALESCE(pg_catalog.avg(ranks.roi), 0)::numeric,
      2
    ) AS avg_roi,
    pg_catalog.round(
      pg_catalog.percentile_cont(0.5) WITHIN GROUP (ORDER BY ranks.arena_score)::numeric,
      2
    ) AS median_score,
    pg_catalog.round(pg_catalog.avg(ranks.win_rate)::numeric, 2) AS avg_win_rate
  FROM public.leaderboard_ranks AS ranks
  JOIN allowed
    ON allowed.source = ranks.source
  WHERE ranks.season_id = p_season_id
    AND ranks.rank_publication_id = p_score_cohort_id
    AND ranks.arena_score > 0
    AND (ranks.is_outlier IS NULL OR ranks.is_outlier = false)
  GROUP BY ranks.source
  ORDER BY ranks.source ASC;
END
$function$;

REVOKE ALL ON FUNCTION public.get_public_platform_stats(
  text,
  uuid,
  text[]
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_public_platform_stats(
  text,
  uuid,
  text[]
) TO service_role;

COMMENT ON FUNCTION public.get_public_platform_stats(
  text,
  uuid,
  text[]
) IS
  'Aggregates public platform statistics inside one exact leaderboard publication cohort and caller-authorized source scope.';

NOTIFY pgrst, 'reload schema';

COMMIT;
