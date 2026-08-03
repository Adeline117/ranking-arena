-- Migration: 20260729220908_season_scoped_leaderboard_count_cache.sql
-- Created: 2026-07-29T22:09:08Z
-- Description: Add a service-only count-cache refresh that atomically rebuilds
--   only an exact, canonical set of leaderboard seasons. The existing full
--   refresh remains available; both functions take the same self-conflicting
--   table lock first, so full and scoped generations cannot interleave.
--
-- Forward compensation: revoke and drop the scoped function. It owns no data;
-- callers can use the existing full refresh to rebuild the cache afterwards.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
DECLARE
  v_full_refresh pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.refresh_leaderboard_count_cache()'
  );
BEGIN
  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_count_cache') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_ranks') IS NULL
     OR v_full_refresh IS NULL THEN
    RAISE EXCEPTION
      'season-scoped leaderboard count refresh prerequisites are missing';
  END IF;

  IF pg_catalog.to_regprocedure(
       'public.refresh_leaderboard_count_cache_for_seasons(text[])'
     ) IS NOT NULL THEN
    RAISE EXCEPTION
      'season-scoped leaderboard count refresh already exists';
  END IF;

  -- The shared lock is the compatibility contract with the legacy full
  -- refresh. Refuse to install if that function no longer serializes on the
  -- same cache table; silently relying on a stale assumption could mix two
  -- independently computed generations.
  IF pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(v_full_refresh),
       'LOCK TABLE public.leaderboard_count_cache IN SHARE ROW EXCLUSIVE MODE'
     ) = 0 THEN
    RAISE EXCEPTION
      'full leaderboard count refresh serialization contract drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
          'public.leaderboard_count_cache'::pg_catalog.regclass
      AND attribute.attname = ANY (
        ARRAY['season_id', 'source', 'total_count', 'updated_at']::text[]
      )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 4
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid =
             'public.leaderboard_ranks'::pg_catalog.regclass
         AND attribute.attname = ANY (
           ARRAY['season_id', 'source', 'arena_score', 'is_outlier']::text[]
         )
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
     ) <> 4 THEN
    RAISE EXCEPTION
      'leaderboard count refresh column contract drifted';
  END IF;
END
$preflight$;

CREATE FUNCTION public.refresh_leaderboard_count_cache_for_seasons(
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
    RAISE EXCEPTION
      'season_ids must be a non-empty array'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(p_season_ids) AS requested(season_id)
    WHERE requested.season_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'season_ids must not contain NULL'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(p_season_ids) AS requested(season_id)
    WHERE requested.season_id <> ALL (
      ARRAY['7D', '30D', '90D']::text[]
    )
  ) THEN
    RAISE EXCEPTION
      'season_ids may contain only 7D, 30D, or 90D'
      USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.cardinality(p_season_ids) IS DISTINCT FROM (
    SELECT pg_catalog.count(DISTINCT requested.season_id)::integer
    FROM pg_catalog.unnest(p_season_ids) AS requested(season_id)
  ) THEN
    RAISE EXCEPTION
      'season_ids must not contain duplicates'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(requested.season_id ORDER BY requested.season_id)
    INTO STRICT v_target_season_ids
    FROM pg_catalog.unnest(p_season_ids) AS requested(season_id);

  -- Always acquire the same table lock, in the same first-lock order, as the
  -- existing full refresh. SHARE ROW EXCLUSIVE conflicts with itself, so old
  -- full refreshes and new scoped refreshes cannot interleave delete/insert
  -- generations. Plain SELECT readers remain compatible through MVCC.
  LOCK TABLE public.leaderboard_count_cache
    IN SHARE ROW EXCLUSIVE MODE;

  DELETE FROM public.leaderboard_count_cache AS cache
  WHERE cache.season_id = ANY (v_target_season_ids);

  -- One INSERT statement gives all four families one READ COMMITTED statement
  -- snapshot. Every branch is scoped to the validated target set; rows for
  -- every other season, including their updated_at values, remain untouched.
  INSERT INTO public.leaderboard_count_cache (
    season_id,
    source,
    total_count,
    updated_at
  )
  SELECT
    rank_row.season_id,
    '_all',
    pg_catalog.count(*)::integer,
    pg_catalog.statement_timestamp()
  FROM public.leaderboard_ranks AS rank_row
  WHERE rank_row.season_id = ANY (v_target_season_ids)
    AND rank_row.arena_score > 10
    AND (
      rank_row.is_outlier IS NULL
      OR rank_row.is_outlier = false
    )
  GROUP BY rank_row.season_id

  UNION ALL

  SELECT
    rank_row.season_id,
    rank_row.source,
    pg_catalog.count(*)::integer,
    pg_catalog.statement_timestamp()
  FROM public.leaderboard_ranks AS rank_row
  WHERE rank_row.season_id = ANY (v_target_season_ids)
    AND rank_row.arena_score > 10
    AND (
      rank_row.is_outlier IS NULL
      OR rank_row.is_outlier = false
    )
  GROUP BY rank_row.season_id, rank_row.source

  UNION ALL

  SELECT
    rank_row.season_id,
    '_all_gt0',
    pg_catalog.count(*)::integer,
    pg_catalog.statement_timestamp()
  FROM public.leaderboard_ranks AS rank_row
  WHERE rank_row.season_id = ANY (v_target_season_ids)
    AND rank_row.arena_score > 0
    AND (
      rank_row.is_outlier IS NULL
      OR rank_row.is_outlier = false
    )
  GROUP BY rank_row.season_id

  UNION ALL

  SELECT
    rank_row.season_id,
    rank_row.source || '_gt0',
    pg_catalog.count(*)::integer,
    pg_catalog.statement_timestamp()
  FROM public.leaderboard_ranks AS rank_row
  WHERE rank_row.season_id = ANY (v_target_season_ids)
    AND rank_row.arena_score > 0
    AND (
      rank_row.is_outlier IS NULL
      OR rank_row.is_outlier = false
    )
  GROUP BY rank_row.season_id, rank_row.source;
END
$function$;

ALTER FUNCTION public.refresh_leaderboard_count_cache_for_seasons(text[])
  OWNER TO postgres;

COMMENT ON FUNCTION
  public.refresh_leaderboard_count_cache_for_seasons(text[]) IS
  'Service-only atomic refresh of the four leaderboard count-cache families for a unique, non-empty subset of 7D/30D/90D; serializes with the legacy full refresh and preserves non-target seasons.';

-- CREATE FUNCTION can inherit grants from ALTER DEFAULT PRIVILEGES. Remove
-- every non-owner ACL entry before granting the one intended runtime caller.
DO $close_acl$
DECLARE
  v_function pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.refresh_leaderboard_count_cache_for_seasons(text[])'
  );
  v_owner oid;
  v_grantee oid;
  v_grantee_name name;
BEGIN
  SELECT function_row.proowner
    INTO STRICT v_owner
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function;

  FOR v_grantee IN
    SELECT DISTINCT acl_row.grantee
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_row
    WHERE function_row.oid = v_function
      AND acl_row.grantee <> v_owner
  LOOP
    IF v_grantee = 0 THEN
      EXECUTE
        'REVOKE ALL PRIVILEGES ON FUNCTION '
        'public.refresh_leaderboard_count_cache_for_seasons(text[]) '
        'FROM PUBLIC';
    ELSE
      SELECT role_row.rolname
        INTO STRICT v_grantee_name
        FROM pg_catalog.pg_roles AS role_row
        WHERE role_row.oid = v_grantee;

      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION '
        'public.refresh_leaderboard_count_cache_for_seasons(text[]) FROM %I',
        v_grantee_name
      );
    END IF;
  END LOOP;
END
$close_acl$;

-- Keep these explicit revokes as a readable application-role contract even
-- though the ACL sweep above also closes their inherited/default grants.
REVOKE ALL ON FUNCTION
  public.refresh_leaderboard_count_cache_for_seasons(text[])
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.refresh_leaderboard_count_cache_for_seasons(text[])
  TO service_role;

DO $postflight$
DECLARE
  v_function pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.refresh_leaderboard_count_cache_for_seasons(text[])'
  );
  v_service_role oid := pg_catalog.to_regrole('service_role');
BEGIN
  IF v_function IS NULL
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', v_function, 'EXECUTE'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = v_function
         AND function_row.prokind = 'f'
         AND function_row.proowner = 'postgres'::pg_catalog.regrole
         AND function_row.prosecdef
         AND function_row.provolatile = 'v'
         AND function_row.proparallel = 'u'
         AND NOT function_row.proretset
         AND function_row.prorettype = 'pg_catalog.void'::pg_catalog.regtype
         AND function_row.proargnames = ARRAY['p_season_ids']::text[]
         AND function_row.pronargdefaults = 0
         AND pg_catalog.array_length(function_row.proconfig, 1) = 2
         AND function_row.proconfig @> ARRAY[
           'search_path=pg_catalog, pg_temp',
           'statement_timeout=10s'
         ]::text[]
         AND NOT EXISTS (
           SELECT 1
           FROM pg_catalog.aclexplode(
             COALESCE(
               function_row.proacl,
               pg_catalog.acldefault('f', function_row.proowner)
             )
           ) AS acl_row
           WHERE acl_row.privilege_type <> 'EXECUTE'
              OR acl_row.grantee NOT IN (
                function_row.proowner,
                v_service_role
              )
              OR acl_row.is_grantable
         )
         AND (
           SELECT pg_catalog.count(*)
           FROM pg_catalog.aclexplode(
             COALESCE(
               function_row.proacl,
               pg_catalog.acldefault('f', function_row.proowner)
             )
           ) AS acl_row
         ) = 2
         AND EXISTS (
           SELECT 1
           FROM pg_catalog.aclexplode(
             COALESCE(
               function_row.proacl,
               pg_catalog.acldefault('f', function_row.proowner)
             )
           ) AS acl_row
           WHERE acl_row.grantee = function_row.proowner
             AND acl_row.privilege_type = 'EXECUTE'
         )
         AND EXISTS (
           SELECT 1
           FROM pg_catalog.aclexplode(
             COALESCE(
               function_row.proacl,
               pg_catalog.acldefault('f', function_row.proowner)
             )
           ) AS acl_row
           WHERE acl_row.grantee = v_service_role
             AND acl_row.privilege_type = 'EXECUTE'
         )
     ) THEN
    RAISE EXCEPTION
      'season-scoped leaderboard count refresh authority drifted';
  END IF;
END
$postflight$;

COMMIT;
