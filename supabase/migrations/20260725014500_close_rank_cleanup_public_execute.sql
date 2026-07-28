-- Close the legacy rank cleanup SECURITY DEFINER RPC to service_role only.
--
-- The original function inherited PostgreSQL's default PUBLIC EXECUTE grant.
-- A later migration revoked anon/authenticated directly but left PUBLIC in
-- place, so both roles retained effective execution through PUBLIC. Keep the
-- callable temporarily available to the current cron writer while converging
-- every direct/delegated grant to the owner plus service_role.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
DECLARE
  v_function oid := pg_catalog.to_regprocedure(
    'public.cleanup_stale_platform_rows(text,text,text[])'
  );
BEGIN
  IF v_function IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_ranks') IS NULL THEN
    RAISE EXCEPTION
      'legacy rank cleanup callable and leaderboard_ranks must exist';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'database owner and PostgREST API roles must exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname = 'cleanup_stale_platform_rows'
      AND function_row.oid IS DISTINCT FROM v_function
  ) THEN
    RAISE EXCEPTION 'legacy rank cleanup callable has an unsupported overload';
  END IF;

  -- Do not bless an unexpected SECURITY DEFINER body with service-role access.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_function
      AND function_row.prokind = 'f'
      AND language_row.lanname = 'plpgsql'
      AND function_row.prosecdef
      AND NOT function_row.proleakproof
      AND NOT function_row.proisstrict
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND NOT function_row.proretset
      AND function_row.prorettype = 'pg_catalog.int4'::pg_catalog.regtype
      AND function_row.pronargs = 3
      AND function_row.pronargdefaults = 0
      AND function_row.proargtypes = ARRAY[
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.text[]'::pg_catalog.regtype
      ]::pg_catalog.oidvector
      AND function_row.proargnames = ARRAY[
        'p_season_id',
        'p_source',
        'p_keep_trader_ids'
      ]::pg_catalog.text[]
      AND function_row.proconfig =
        ARRAY['search_path=public']::pg_catalog.text[]
      AND pg_catalog.btrim(
        pg_catalog.regexp_replace(
          function_row.prosrc,
          '[[:space:]]+',
          ' ',
          'g'
        )
      ) =
        'DECLARE v_deleted integer; BEGIN DELETE FROM leaderboard_ranks WHERE season_id = p_season_id AND source = p_source AND source_trader_id != ALL(p_keep_trader_ids) ; GET DIAGNOSTICS v_deleted = ROW_COUNT; RETURN v_deleted; END;'
  ) THEN
    RAISE EXCEPTION 'legacy rank cleanup callable contract drifted';
  END IF;
END
$preflight$;

CREATE TEMP TABLE legacy_rank_cleanup_contract_before
ON COMMIT DROP
AS
SELECT function_row.oid
FROM pg_catalog.pg_proc AS function_row
WHERE function_row.oid =
  'public.cleanup_stale_platform_rows(text,text,text[])'
    ::pg_catalog.regprocedure;

ALTER FUNCTION public.cleanup_stale_platform_rows(text, text, text[])
  OWNER TO postgres;

DO $revoke_rogue_execute$
DECLARE
  v_grantee oid;
  v_role_name text;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT expanded.grantee
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS expanded
    WHERE function_row.oid =
      'public.cleanup_stale_platform_rows(text,text,text[])'
        ::pg_catalog.regprocedure
      AND expanded.privilege_type = 'EXECUTE'
      AND expanded.grantee <> function_row.proowner
      AND expanded.grantee <> 'service_role'::pg_catalog.regrole
    ORDER BY expanded.grantee
  LOOP
    IF v_grantee = 0 THEN
      EXECUTE
        'REVOKE EXECUTE ON FUNCTION public.cleanup_stale_platform_rows(text, text, text[]) FROM PUBLIC CASCADE';
    ELSE
      SELECT role_row.rolname
      INTO STRICT v_role_name
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_grantee;

      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON FUNCTION public.cleanup_stale_platform_rows(text, text, text[]) FROM %I CASCADE',
        v_role_name
      );
    END IF;
  END LOOP;
END
$revoke_rogue_execute$;

REVOKE EXECUTE
  ON FUNCTION public.cleanup_stale_platform_rows(text, text, text[])
  FROM PUBLIC, anon, authenticated;
REVOKE GRANT OPTION FOR EXECUTE
  ON FUNCTION public.cleanup_stale_platform_rows(text, text, text[])
  FROM service_role CASCADE;
GRANT EXECUTE
  ON FUNCTION public.cleanup_stale_platform_rows(text, text, text[])
  TO service_role;

COMMENT ON FUNCTION public.cleanup_stale_platform_rows(text, text, text[]) IS
  'Legacy per-source rank cleanup; temporarily service-only until generation-fenced publication replaces this writer.';

DO $postflight$
DECLARE
  v_before oid;
  v_after oid := pg_catalog.to_regprocedure(
    'public.cleanup_stale_platform_rows(text,text,text[])'
  );
BEGIN
  SELECT contract.oid
  INTO STRICT v_before
  FROM legacy_rank_cleanup_contract_before AS contract;

  IF v_after IS NULL OR v_after IS DISTINCT FROM v_before OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname = 'cleanup_stale_platform_rows'
      AND function_row.oid IS DISTINCT FROM v_after
  ) THEN
    RAISE EXCEPTION 'legacy rank cleanup identity or overload postflight failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_after
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prokind = 'f'
      AND language_row.lanname = 'plpgsql'
      AND function_row.prosecdef
      AND NOT function_row.proleakproof
      AND NOT function_row.proisstrict
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND NOT function_row.proretset
      AND function_row.prorettype = 'pg_catalog.int4'::pg_catalog.regtype
      AND function_row.pronargs = 3
      AND function_row.pronargdefaults = 0
      AND function_row.proargtypes = ARRAY[
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.text[]'::pg_catalog.regtype
      ]::pg_catalog.oidvector
      AND function_row.proargnames = ARRAY[
        'p_season_id',
        'p_source',
        'p_keep_trader_ids'
      ]::pg_catalog.text[]
      AND function_row.proconfig =
        ARRAY['search_path=public']::pg_catalog.text[]
  ) THEN
    RAISE EXCEPTION 'legacy rank cleanup callable postflight failed';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role', v_after, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('anon', v_after, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', v_after, 'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS expanded
       WHERE function_row.oid = v_after
         AND expanded.privilege_type = 'EXECUTE'
         AND expanded.grantee <> function_row.proowner
         AND expanded.grantee <> 'service_role'::pg_catalog.regrole
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS expanded
       WHERE function_row.oid = v_after
         AND expanded.grantee = 'service_role'::pg_catalog.regrole
         AND expanded.privilege_type = 'EXECUTE'
         AND expanded.is_grantable
     ) THEN
    RAISE EXCEPTION 'legacy rank cleanup EXECUTE ACL is not a closed set';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
