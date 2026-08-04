-- Migration: 20260803104500_close_hot_score_batch_public_execute.sql
-- Created: 2026-08-03T10:45:00Z
-- Description: Close four legacy SECURITY DEFINER batch writers that retained
--   PostgreSQL's default PUBLIC EXECUTE grant. They are cron-only authorities;
--   browser roles must not be able to lock and rewrite recent posts via /rpc.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.post-hot-score-batch:close-public-execute:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'post hot-score batch ACL migration lock is busy';
  END IF;
END
$migration_lock$;

DO $preflight$
DECLARE
  v_missing_roles text[];
  v_plpgsql_oid oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
  v_expected record;
  v_function regprocedure;
  v_source text;
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY[
      'anon',
      'authenticated',
      'authenticator',
      'service_role',
      'postgres'
    ]::text[]
  ) AS required_role
  WHERE pg_catalog.to_regrole(required_role) IS NULL;

  IF v_missing_roles IS NOT NULL OR v_plpgsql_oid IS NULL THEN
    RAISE EXCEPTION 'post hot-score batch roles/language are missing: %',
      v_missing_roles;
  END IF;

  IF pg_catalog.to_regclass('public.posts') IS NULL THEN
    RAISE EXCEPTION 'public.posts must deploy before hot-score ACL closure';
  END IF;

  FOR v_expected IN
    SELECT *
    FROM (
      VALUES
        (
          'public.refresh_hot_scores()',
          'UPDATE posts SET',
          'calculate_hot_score'
        ),
        (
          'public.refresh_hot_scores_incremental()',
          'UPDATE posts SET',
          'last_hot_refresh_at'
        ),
        (
          'public.update_post_velocity()',
          'UPDATE posts p SET',
          'comments_last_hour'
        ),
        (
          'public.update_post_report_counts()',
          'UPDATE posts p SET',
          'content_reports'
        )
    ) AS expected_function(signature, source_marker_a, source_marker_b)
  LOOP
    v_function := pg_catalog.to_regprocedure(v_expected.signature);
    IF v_function IS NULL THEN
      RAISE EXCEPTION 'required post hot-score batch authority is missing: %',
        v_expected.signature;
    END IF;

    SELECT function_row.prosrc
    INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'integer'::pg_catalog.regtype
      AND NOT function_row.proretset
      AND function_row.prolang = v_plpgsql_oid
      AND function_row.provolatile = 'v'
      AND NOT function_row.proisstrict
      AND function_row.proparallel = 'u'
      AND NOT function_row.proleakproof
      AND function_row.pronargs = 0
      AND function_row.pronargdefaults = 0;

    IF pg_catalog.strpos(v_source, v_expected.source_marker_a) = 0
       OR pg_catalog.strpos(v_source, v_expected.source_marker_b) = 0
       OR pg_catalog.strpos(v_source, 'GET DIAGNOSTICS') = 0
    THEN
      RAISE EXCEPTION 'post hot-score batch source drifted: %',
        v_expected.signature;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'refresh_hot_scores',
        'refresh_hot_scores_incremental',
        'update_post_velocity',
        'update_post_report_counts'
      )
      AND function_row.pronargs <> 0
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'refresh_hot_scores',
        'refresh_hot_scores_incremental',
        'update_post_velocity',
        'update_post_report_counts'
      )
  ) <> 4 THEN
    RAISE EXCEPTION 'post hot-score batch overload set drifted';
  END IF;
END
$preflight$;

ALTER FUNCTION public.refresh_hot_scores()
  OWNER TO postgres;
ALTER FUNCTION public.refresh_hot_scores()
  SECURITY DEFINER VOLATILE PARALLEL UNSAFE;
ALTER FUNCTION public.refresh_hot_scores()
  SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.refresh_hot_scores()
  SET row_security TO off;
ALTER FUNCTION public.refresh_hot_scores()
  SET lock_timeout TO '5s';
ALTER FUNCTION public.refresh_hot_scores()
  SET statement_timeout TO '60s';

ALTER FUNCTION public.refresh_hot_scores_incremental()
  OWNER TO postgres;
ALTER FUNCTION public.refresh_hot_scores_incremental()
  SECURITY DEFINER VOLATILE PARALLEL UNSAFE;
ALTER FUNCTION public.refresh_hot_scores_incremental()
  SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.refresh_hot_scores_incremental()
  SET row_security TO off;
ALTER FUNCTION public.refresh_hot_scores_incremental()
  SET lock_timeout TO '5s';
ALTER FUNCTION public.refresh_hot_scores_incremental()
  SET statement_timeout TO '60s';

ALTER FUNCTION public.update_post_velocity()
  OWNER TO postgres;
ALTER FUNCTION public.update_post_velocity()
  SECURITY DEFINER VOLATILE PARALLEL UNSAFE;
ALTER FUNCTION public.update_post_velocity()
  SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.update_post_velocity()
  SET row_security TO off;
ALTER FUNCTION public.update_post_velocity()
  SET lock_timeout TO '5s';
ALTER FUNCTION public.update_post_velocity()
  SET statement_timeout TO '60s';

ALTER FUNCTION public.update_post_report_counts()
  OWNER TO postgres;
ALTER FUNCTION public.update_post_report_counts()
  SECURITY DEFINER VOLATILE PARALLEL UNSAFE;
ALTER FUNCTION public.update_post_report_counts()
  SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.update_post_report_counts()
  SET row_security TO off;
ALTER FUNCTION public.update_post_report_counts()
  SET lock_timeout TO '5s';
ALTER FUNCTION public.update_post_report_counts()
  SET statement_timeout TO '60s';

REVOKE ALL ON FUNCTION public.refresh_hot_scores()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.refresh_hot_scores_incremental()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.update_post_velocity()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.update_post_report_counts()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

GRANT EXECUTE ON FUNCTION public.refresh_hot_scores()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_hot_scores_incremental()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.update_post_velocity()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.update_post_report_counts()
  TO service_role;

DO $attest_sources$
DECLARE
  v_function regprocedure;
  v_source text;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.refresh_hot_scores()'::pg_catalog.regprocedure,
    'public.refresh_hot_scores_incremental()'::pg_catalog.regprocedure,
    'public.update_post_velocity()'::pg_catalog.regprocedure,
    'public.update_post_report_counts()'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT function_row.prosrc
    INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function;

    EXECUTE pg_catalog.format(
      'COMMENT ON FUNCTION %s IS %L',
      v_function,
      'post-hot-score-service-authority:v1:' || pg_catalog.md5(v_source)
    );
  END LOOP;
END
$attest_sources$;

DO $postflight$
DECLARE
  v_postgres_oid oid := pg_catalog.to_regrole('postgres');
  v_service_oid oid := pg_catalog.to_regrole('service_role');
  v_plpgsql_oid oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
  v_function regprocedure;
  v_source text;
  v_comment text;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.refresh_hot_scores()'::pg_catalog.regprocedure,
    'public.refresh_hot_scores_incremental()'::pg_catalog.regprocedure,
    'public.update_post_velocity()'::pg_catalog.regprocedure,
    'public.update_post_report_counts()'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT function_row.prosrc,
           pg_catalog.obj_description(function_row.oid, 'pg_proc')
    INTO STRICT v_source, v_comment
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'integer'::pg_catalog.regtype
      AND NOT function_row.proretset
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.prolang = v_plpgsql_oid
      AND function_row.provolatile = 'v'
      AND NOT function_row.proisstrict
      AND function_row.proparallel = 'u'
      AND NOT function_row.proleakproof
      AND function_row.pronargs = 0
      AND function_row.pronargdefaults = 0
      AND pg_catalog.cardinality(function_row.proconfig) = 4
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, public, pg_temp',
        'row_security=off',
        'lock_timeout=5s',
        'statement_timeout=60s'
      ]::text[];

    IF v_comment IS DISTINCT FROM
         'post-hot-score-service-authority:v1:' || pg_catalog.md5(v_source)
       OR NOT pg_catalog.has_function_privilege(
         'service_role', v_function, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
         'anon', v_function, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
         'authenticated', v_function, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
         'authenticator', v_function, 'EXECUTE'
       )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             function_row.proacl,
             pg_catalog.acldefault('f', function_row.proowner)
           )
         ) AS acl_entry
         WHERE function_row.oid = v_function
           AND acl_entry.privilege_type = 'EXECUTE'
           AND acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
       )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             function_row.proacl,
             pg_catalog.acldefault('f', function_row.proowner)
           )
         ) AS acl_entry
         WHERE function_row.oid = v_function
           AND acl_entry.privilege_type = 'EXECUTE'
           AND acl_entry.grantee = v_service_oid
           AND acl_entry.is_grantable
       )
    THEN
      RAISE EXCEPTION 'post hot-score batch authority drifted: %',
        v_function;
    END IF;
  END LOOP;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
