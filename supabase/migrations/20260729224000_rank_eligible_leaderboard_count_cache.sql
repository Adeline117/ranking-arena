-- Migration: 20260729224000_rank_eligible_leaderboard_count_cache.sql
--
-- The `_gt0` cache family is public leaderboard count authority. A positive
-- score is no longer sufficient: the eligibility-aware reranker expresses
-- publication membership with rank IS NOT NULL. Keep the legacy unsuffixed
-- counts as degradation-recovery baselines, while rebuilding every public
-- count from the exact ranked cohort.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.leaderboard_ranks') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_count_cache') IS NULL THEN
    RAISE EXCEPTION 'leaderboard rank/count foundations are required';
  END IF;
  IF pg_catalog.to_regprocedure(
       'public.rerank_public_eligible_leaderboard(text)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.rerank_leaderboard(text)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.refresh_leaderboard_count_cache()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.refresh_leaderboard_count_cache_for_seasons(text[])'
     ) IS NULL THEN
    RAISE EXCEPTION 'rank and count-cache function foundations are required';
  END IF;
  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'Supabase runtime roles are required';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.refresh_public_rank_count_cache_for_seasons(
  p_season_ids text[]
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '10s'
AS $function$
DECLARE
  v_target_season_ids text[];
BEGIN
  IF p_season_ids IS NULL
     OR pg_catalog.cardinality(p_season_ids) = 0 THEN
    RAISE EXCEPTION 'season_ids must be a non-empty array'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(p_season_ids) AS requested(season_id)
    WHERE requested.season_id IS NULL
       OR requested.season_id <> ALL (
         ARRAY['7D', '30D', '90D']::text[]
       )
  ) THEN
    RAISE EXCEPTION 'season_ids may contain only non-NULL 7D, 30D, or 90D values'
      USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.cardinality(p_season_ids) IS DISTINCT FROM (
    SELECT pg_catalog.count(DISTINCT requested.season_id)::integer
    FROM pg_catalog.unnest(p_season_ids) AS requested(season_id)
  ) THEN
    RAISE EXCEPTION 'season_ids must not contain duplicates'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(requested.season_id ORDER BY requested.season_id)
    INTO STRICT v_target_season_ids
  FROM pg_catalog.unnest(p_season_ids) AS requested(season_id);

  -- Freeze rank membership across the delete/insert refresh. Rank first,
  -- count-cache second is the publication lock order used by the forthcoming
  -- single-transaction finalizer and cannot observe a concurrently rewritten
  -- cohort half a generation later.
  LOCK TABLE public.leaderboard_ranks IN SHARE MODE;
  LOCK TABLE public.leaderboard_count_cache IN SHARE ROW EXCLUSIVE MODE;

  DELETE FROM public.leaderboard_count_cache AS cache
  WHERE cache.season_id = ANY (v_target_season_ids);

  -- One statement gives all four families one MVCC snapshot and generation
  -- timestamp. Unsuffixed rows retain the legacy score-based baseline; only
  -- `_gt0` rows describe the public rank cohort.
  INSERT INTO public.leaderboard_count_cache (
    season_id,
    source,
    total_count,
    updated_at
  )
  SELECT
    ranks.season_id,
    '_all',
    pg_catalog.count(*)::integer,
    pg_catalog.statement_timestamp()
  FROM public.leaderboard_ranks AS ranks
  WHERE ranks.season_id = ANY (v_target_season_ids)
    AND ranks.arena_score > 10
    AND ranks.is_outlier IS NOT TRUE
  GROUP BY ranks.season_id

  UNION ALL

  SELECT
    ranks.season_id,
    ranks.source,
    pg_catalog.count(*)::integer,
    pg_catalog.statement_timestamp()
  FROM public.leaderboard_ranks AS ranks
  WHERE ranks.season_id = ANY (v_target_season_ids)
    AND ranks.arena_score > 10
    AND ranks.is_outlier IS NOT TRUE
  GROUP BY ranks.season_id, ranks.source

  UNION ALL

  SELECT
    ranks.season_id,
    '_all_gt0',
    pg_catalog.count(*)::integer,
    pg_catalog.statement_timestamp()
  FROM public.leaderboard_ranks AS ranks
  WHERE ranks.season_id = ANY (v_target_season_ids)
    AND ranks.rank IS NOT NULL
    AND ranks.arena_score > 0
    AND ranks.is_outlier IS NOT TRUE
  GROUP BY ranks.season_id

  UNION ALL

  SELECT
    ranks.season_id,
    ranks.source || '_gt0',
    pg_catalog.count(*)::integer,
    pg_catalog.statement_timestamp()
  FROM public.leaderboard_ranks AS ranks
  WHERE ranks.season_id = ANY (v_target_season_ids)
    AND ranks.rank IS NOT NULL
    AND ranks.arena_score > 0
    AND ranks.is_outlier IS NOT TRUE
  GROUP BY ranks.season_id, ranks.source;
END
$function$;

ALTER FUNCTION public.refresh_public_rank_count_cache_for_seasons(text[])
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.refresh_leaderboard_count_cache_for_seasons(
  p_season_ids text[]
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '10s'
AS $function$
BEGIN
  PERFORM public.refresh_public_rank_count_cache_for_seasons(p_season_ids);
END
$function$;

ALTER FUNCTION public.refresh_leaderboard_count_cache_for_seasons(text[])
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.refresh_leaderboard_count_cache()
RETURNS void
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '10s'
AS $function$
BEGIN
  PERFORM public.refresh_public_rank_count_cache_for_seasons(
    ARRAY['7D', '30D', '90D']::text[]
  );
END
$function$;

ALTER FUNCTION public.refresh_leaderboard_count_cache()
  OWNER TO postgres;

-- Cut the rolling-deploy legacy entry point over only inside the transaction
-- that also repairs every rank and derived count. Until this transaction
-- commits, old application instances continue seeing the old rank/count pair.
CREATE OR REPLACE FUNCTION public.rerank_leaderboard(
  p_season_id text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '10s'
AS $function$
BEGIN
  RETURN public.rerank_public_eligible_leaderboard(p_season_id);
END
$function$;

ALTER FUNCTION public.rerank_leaderboard(text)
  OWNER TO postgres;

-- CREATE OR REPLACE may preserve a legacy ACL and CREATE FUNCTION may inherit
-- ALTER DEFAULT PRIVILEGES. Remove every non-owner grant from all four entry
-- points before granting the sole runtime caller.
DO $close_acl$
DECLARE
  v_target record;
  v_owner oid;
  v_grantee oid;
  v_grantee_name name;
BEGIN
  FOR v_target IN
    SELECT *
    FROM (
      VALUES
        (
          'public.refresh_public_rank_count_cache_for_seasons(text[])'::text,
          pg_catalog.to_regprocedure(
            'public.refresh_public_rank_count_cache_for_seasons(text[])'
          )
        ),
        (
          'public.refresh_leaderboard_count_cache_for_seasons(text[])'::text,
          pg_catalog.to_regprocedure(
            'public.refresh_leaderboard_count_cache_for_seasons(text[])'
          )
        ),
        (
          'public.refresh_leaderboard_count_cache()'::text,
          pg_catalog.to_regprocedure(
            'public.refresh_leaderboard_count_cache()'
          )
        ),
        (
          'public.rerank_leaderboard(text)'::text,
          pg_catalog.to_regprocedure(
            'public.rerank_leaderboard(text)'
          )
        )
    ) AS required(signature, function_oid)
  LOOP
    SELECT function_row.proowner
      INTO STRICT v_owner
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_target.function_oid;

    FOR v_grantee IN
      SELECT DISTINCT privilege.grantee
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS privilege
      WHERE function_row.oid = v_target.function_oid
        AND privilege.grantee <> v_owner
    LOOP
      IF v_grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE',
          v_target.signature
        );
      ELSE
        SELECT role_row.rolname
          INTO STRICT v_grantee_name
        FROM pg_catalog.pg_roles AS role_row
        WHERE role_row.oid = v_grantee;
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
          v_target.signature,
          v_grantee_name
        );
      END IF;
    END LOOP;
  END LOOP;
END
$close_acl$;

REVOKE ALL ON FUNCTION
  public.refresh_public_rank_count_cache_for_seasons(text[]),
  public.refresh_leaderboard_count_cache_for_seasons(text[]),
  public.refresh_leaderboard_count_cache(),
  public.rerank_leaderboard(text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.refresh_public_rank_count_cache_for_seasons(text[]),
  public.refresh_leaderboard_count_cache_for_seasons(text[]),
  public.refresh_leaderboard_count_cache(),
  public.rerank_leaderboard(text)
  TO service_role;

COMMENT ON FUNCTION
  public.refresh_public_rank_count_cache_for_seasons(text[]) IS
  'Service-only scoped refresh: legacy unsuffixed degradation baselines plus rank-authoritative public _gt0 counts.';

COMMENT ON FUNCTION public.rerank_leaderboard(text) IS
  'Compatibility wrapper cut over atomically with rank-authoritative public counts; delegates to rerank_public_eligible_leaderboard(text).';

-- Repair ranks and their derived count authority in this one migration
-- transaction. The function-install migration deliberately performs no live
-- repair, so a failed count migration cannot strand a rank/count split-brain.
SELECT public.rerank_public_eligible_leaderboard(season.season_id)
FROM (
  VALUES ('7D'::text), ('30D'::text), ('90D'::text)
) AS season(season_id)
ORDER BY season.season_id;

SELECT public.refresh_public_rank_count_cache_for_seasons(
  ARRAY['7D', '30D', '90D']::text[]
);

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
          'public.rerank_leaderboard(text)'::pg_catalog.regprocedure
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prosecdef
      AND function_row.prosrc LIKE
          '%RETURN public.rerank_public_eligible_leaderboard(p_season_id)%'
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=10s'
      ]::pg_catalog.text[]
  )
     OR NOT pg_catalog.has_function_privilege(
          'service_role',
          'public.rerank_leaderboard(text)',
          'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'anon',
          'public.rerank_leaderboard(text)',
          'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'authenticated',
          'public.rerank_leaderboard(text)',
          'EXECUTE'
        ) THEN
    RAISE EXCEPTION 'legacy rerank cutover postflight failed';
  END IF;

  IF EXISTS (
    WITH expected AS (
      SELECT
        ranks.season_id,
        '_all_gt0'::text AS source,
        pg_catalog.count(*)::integer AS total_count
      FROM public.leaderboard_ranks AS ranks
      WHERE ranks.season_id IN ('7D', '30D', '90D')
        AND ranks.rank IS NOT NULL
        AND ranks.arena_score > 0
        AND ranks.is_outlier IS NOT TRUE
      GROUP BY ranks.season_id
      UNION ALL
      SELECT
        ranks.season_id,
        ranks.source || '_gt0',
        pg_catalog.count(*)::integer
      FROM public.leaderboard_ranks AS ranks
      WHERE ranks.season_id IN ('7D', '30D', '90D')
        AND ranks.rank IS NOT NULL
        AND ranks.arena_score > 0
        AND ranks.is_outlier IS NOT TRUE
      GROUP BY ranks.season_id, ranks.source
    ), actual AS (
      SELECT cache.season_id, cache.source, cache.total_count
      FROM public.leaderboard_count_cache AS cache
      WHERE cache.season_id IN ('7D', '30D', '90D')
        AND (
          cache.source = '_all_gt0'
          OR cache.source LIKE '%\_gt0' ESCAPE '\'
        )
    )
    SELECT 1 FROM expected
    FULL JOIN actual USING (season_id, source, total_count)
    WHERE expected.source IS NULL OR actual.source IS NULL
  ) THEN
    RAISE EXCEPTION 'rank-authoritative leaderboard count postflight failed'
      USING ERRCODE = '23514';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
