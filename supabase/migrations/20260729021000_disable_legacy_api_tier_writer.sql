-- Postdeploy half of the API-tier billing cutover.
--
-- 20260729020000 is intentionally additive: it installs the sealed event
-- ledger and keeps update_user_api_tier executable by service_role so the old
-- webhook remains healthy while the application is replaced. Apply this file
-- only after the release using apply_user_api_tier_stripe_event is serving.

BEGIN;

SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'public.api-tier-stripe-event-authority:v1',
    0
  )
);

DO $preflight$
DECLARE
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_service oid := pg_catalog.to_regrole('service_role');
  v_old_rpc pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure(
      'public.update_user_api_tier(uuid,text,text,integer)'
    );
  v_new_rpc pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure(
      'public.apply_user_api_tier_stripe_event(uuid,uuid,uuid,text,uuid,text,text,integer,text,bigint,text,bigint,boolean,boolean,boolean,text,text,text,text)'
    );
  v_persisted_rpc pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure(
      'public.apply_user_api_tier_persisted_non_grant_event(text,text,text,bigint,text,bigint,boolean,boolean)'
    );
BEGIN
  IF v_postgres IS NULL
    OR v_service IS NULL
    OR v_old_rpc IS NULL
    OR v_new_rpc IS NULL
    OR v_persisted_rpc IS NULL
  THEN
    RAISE EXCEPTION
      'API tier postdeploy cutover prerequisites are missing';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.pronamespace = 'public'::pg_catalog.regnamespace
      AND routine.proname IN (
        'update_user_api_tier',
        'apply_user_api_tier_stripe_event',
        'apply_user_api_tier_persisted_non_grant_event'
      )
  ) <> 3 THEN
    RAISE EXCEPTION
      'API tier postdeploy cutover found an unreviewed routine overload';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.oid = v_old_rpc
      AND (
        routine.proowner <> v_postgres
        OR routine.prokind <> 'f'
        OR NOT routine.prosecdef
        OR routine.prorettype <> 'void'::pg_catalog.regtype
        OR routine.proretset
        OR routine.pronargs <> 4
        OR routine.pronargdefaults <> 0
        OR routine.proargnames IS DISTINCT FROM ARRAY[
          'p_user_id',
          'p_api_tier',
          'p_stripe_subscription_id',
          'p_daily_limit'
        ]::text[]
        OR routine.proconfig IS DISTINCT FROM
          ARRAY['search_path=public']::text[]
      )
  ) THEN
    RAISE EXCEPTION
      'legacy API tier writer catalog contract drifted before cutover';
  END IF;

  -- This postdeploy migration is both replay-safe and convergent: the old
  -- writer can have its reviewed compatibility grant, be owner-only after a
  -- prior run, or carry an unexpected direct grant that this transaction will
  -- remove. The replacement authorities must already be live in every case.
  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    v_new_rpc,
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    v_persisted_rpc,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'additive API tier authority ACLs are not safe before postdeploy cutover';
  END IF;
END
$preflight$;

DO $revoke_legacy_writer$
DECLARE
  v_routine pg_catalog.regprocedure :=
    'public.update_user_api_tier(uuid,text,text,integer)'::pg_catalog.regprocedure;
  v_routine_sql text;
  v_owner oid;
  v_grantee oid;
  v_grantee_name name;
  v_grantee_sql text;
BEGIN
  SELECT
    pg_catalog.format(
      '%I.%I(%s)',
      namespace.nspname,
      routine.proname,
      pg_catalog.pg_get_function_identity_arguments(routine.oid)
    ),
    routine.proowner
  INTO v_routine_sql, v_owner
  FROM pg_catalog.pg_proc AS routine
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = routine.pronamespace
  WHERE routine.oid = v_routine;

  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee
    FROM pg_catalog.pg_proc AS routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        routine.proacl,
        pg_catalog.acldefault('f', routine.proowner)
      )
    ) AS acl_entry
    WHERE routine.oid = v_routine
      AND acl_entry.grantee <> v_owner
  LOOP
    IF v_grantee = 0::oid THEN
      v_grantee_sql := 'PUBLIC';
    ELSE
      SELECT role_row.rolname
      INTO v_grantee_name
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_grantee;

      IF v_grantee_name IS NULL THEN
        RAISE EXCEPTION
          'dangling legacy API tier writer ACL grantee oid: %',
          v_grantee;
      END IF;
      v_grantee_sql := pg_catalog.format('%I', v_grantee_name);
    END IF;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s CASCADE',
      v_routine_sql,
      v_grantee_sql
    );
  END LOOP;
END
$revoke_legacy_writer$;

DO $postflight$
DECLARE
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_old_rpc pg_catalog.regprocedure :=
    'public.update_user_api_tier(uuid,text,text,integer)'::pg_catalog.regprocedure;
  v_new_rpc pg_catalog.regprocedure :=
    'public.apply_user_api_tier_stripe_event(uuid,uuid,uuid,text,uuid,text,text,integer,text,bigint,text,bigint,boolean,boolean,boolean,text,text,text,text)'::pg_catalog.regprocedure;
  v_persisted_rpc pg_catalog.regprocedure :=
    'public.apply_user_api_tier_persisted_non_grant_event(text,text,text,bigint,text,bigint,boolean,boolean)'::pg_catalog.regprocedure;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        routine.proacl,
        pg_catalog.acldefault('f', routine.proowner)
      )
    ) AS acl_entry
    WHERE routine.oid = v_old_rpc
      AND acl_entry.grantee <> v_postgres
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    v_old_rpc,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    v_old_rpc,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    v_old_rpc,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticator',
    v_old_rpc,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'legacy API tier writer remained executable after postdeploy cutover';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    v_new_rpc,
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    v_persisted_rpc,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'postdeploy cutover damaged the replacement API tier authority';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
