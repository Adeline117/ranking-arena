-- Migration: 20260729187000_close_legacy_post_edit_signature.sql
-- Created: 2026-07-30T02:10:00Z
-- Description: Complete the zero-downtime facet-aware edit cutover after the
--   matching application is fully deployed. Remove only the obsolete seven-
--   argument service RPC and re-attest the canonical facet-aware authority.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.posts:close-legacy-post-edit-signature:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'legacy post edit signature closure lock is busy';
  END IF;
END
$migration_lock$;

DO $preflight$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_missing_roles text[];
  v_new_function regprocedure := pg_catalog.to_regprocedure(
    'public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[],text,text[],text[])'
  );
  v_old_function regprocedure := pg_catalog.to_regprocedure(
    'public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[])'
  );
  v_count_function regprocedure := pg_catalog.to_regprocedure(
    'public.maintain_post_hashtag_count()'
  );
  v_source text;
  v_comment text;
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
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = required_role
  );

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'legacy post edit closure roles are missing: %',
      v_missing_roles;
  END IF;

  IF v_new_function IS NULL
     OR pg_catalog.to_regclass('public.posts') IS NULL
     OR pg_catalog.to_regclass('public.hashtags') IS NULL
     OR pg_catalog.to_regclass('public.post_hashtags') IS NULL
     OR v_count_function IS NULL
  THEN
    RAISE EXCEPTION
      'facet-aware edit and hashtag count authorities must deploy first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'edit_post_atomic'
      AND function_row.oid NOT IN (
        v_new_function::oid,
        COALESCE(v_old_function::oid, 0::oid)
      )
  ) THEN
    RAISE EXCEPTION 'unexpected edit_post_atomic overload blocks closure';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_new_function
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prorettype = 'jsonb'::regtype
    AND function_row.proargnames = ARRAY[
      'p_actor_id',
      'p_post_id',
      'p_expected_version',
      'p_title',
      'p_content',
      'p_update_images',
      'p_images',
      'p_language',
      'p_mention_handles',
      'p_hashtag_tags'
    ]::text[]
    AND pg_catalog.cardinality(function_row.proconfig) = 4
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off',
      'lock_timeout=5s',
      'statement_timeout=15s'
    ];

  IF v_comment IS DISTINCT FROM
       'atomic-post-edit-facets:v2:' || pg_catalog.md5(v_source)
     OR pg_catalog.strpos(v_source, 'p_language') = 0
     OR pg_catalog.strpos(v_source, 'p_mention_handles') = 0
     OR pg_catalog.strpos(v_source, 'p_hashtag_tags') = 0
     OR pg_catalog.strpos(
       v_source,
       'UPDATE public.hashtags AS hashtag'
     ) = 0
     OR NOT pg_catalog.has_function_privilege(
       v_service_oid,
       v_new_function,
       'EXECUTE'
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS acl_entry
       WHERE function_row.oid = v_new_function
         AND acl_entry.privilege_type = 'EXECUTE'
         AND acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
     )
  THEN
    RAISE EXCEPTION 'facet-aware edit authority is not safe to cut over';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.post_hashtags'::regclass
      AND trigger_row.tgname =
        'trg_post_hashtags_90_maintain_post_count'
      AND trigger_row.tgfoid = v_count_function
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION
      'canonical hashtag count trigger must precede legacy edit closure';
  END IF;
END
$preflight$;

-- IF EXISTS makes the closure replayable. The preflight still rejects every
-- unknown overload, so this can never hide a widened or misspelled signature.
DROP FUNCTION IF EXISTS public.edit_post_atomic(
  uuid, uuid, bigint, text, text, boolean, text[]
);

DO $converge_new_acl$
DECLARE
  v_function regprocedure :=
    'public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[],text,text[],text[])'::regprocedure;
  v_owner oid;
  v_grantee record;
BEGIN
  SELECT function_row.proowner
  INTO STRICT v_owner
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee, role_row.rolname
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = acl_entry.grantee
    WHERE function_row.oid = v_function
      AND acl_entry.grantee <> v_owner
  LOOP
    IF v_grantee.grantee = 0 THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC',
        v_function
      );
    ELSIF v_grantee.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I',
        v_function,
        v_grantee.rolname
      );
    END IF;
  END LOOP;

  REVOKE ALL PRIVILEGES
    ON FUNCTION public.edit_post_atomic(
      uuid, uuid, bigint, text, text, boolean, text[], text, text[], text[]
    )
    FROM PUBLIC, anon, authenticated, authenticator, service_role;
  GRANT EXECUTE
    ON FUNCTION public.edit_post_atomic(
      uuid, uuid, bigint, text, text, boolean, text[], text, text[], text[]
    )
    TO service_role;
END
$converge_new_acl$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[],text,text[],text[])'::regprocedure;
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
BEGIN
  IF pg_catalog.to_regprocedure(
       'public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[])'
     ) IS NOT NULL OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.pronamespace = 'public'::regnamespace
         AND function_row.proname = 'edit_post_atomic'
     ) <> 1 OR NOT pg_catalog.has_function_privilege(
       v_service_oid,
       v_function,
       'EXECUTE'
     ) OR EXISTS (
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
  THEN
    RAISE EXCEPTION 'legacy post edit signature closure is incomplete';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
