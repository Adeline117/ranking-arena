-- A revoked GoTrue refresh session does not invalidate an access JWT that was
-- already issued.  Reject a deleted, banned, or missing Arena subject before
-- PostgREST can serve a table read or a SECURITY DEFINER RPC, and repeat the
-- same admission from restrictive RLS for Storage and Realtime requests.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('inactive-auth-subject-request-admission', 0)
);

DO $preflight$
DECLARE
  v_authenticator_oid oid;
  v_setting text;
  v_value text;
BEGIN
  SELECT role_row.oid
  INTO v_authenticator_oid
  FROM pg_catalog.pg_roles AS role_row
  WHERE role_row.rolname = 'authenticator';

  IF v_authenticator_oid IS NULL
    OR pg_catalog.to_regrole('postgres') IS NULL
    OR pg_catalog.to_regrole('anon') IS NULL
    OR pg_catalog.to_regrole('authenticated') IS NULL
    OR pg_catalog.to_regrole('service_role') IS NULL
    OR pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR pg_catalog.to_regprocedure('auth.uid()') IS NULL
    OR pg_catalog.to_regprocedure(
      'public.install_active_authenticated_subject_mutation_barriers()'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.assert_active_authenticated_subject_mutation_barriers()'
    ) IS NULL
  THEN
    RAISE EXCEPTION 'inactive-subject request admission prerequisites are missing';
  END IF;

  -- Never silently replace a hook configured by an operator or another
  -- migration. Inspect role, database/role, and the current database session
  -- sources that are visible from SQL. The migration is idempotent only for
  -- its own exact hook name.
  FOR v_setting IN
    SELECT candidate.setting
    FROM (
      SELECT pg_catalog.unnest(
        COALESCE(
          (
            SELECT role_row.rolconfig
            FROM pg_catalog.pg_roles AS role_row
            WHERE role_row.oid = v_authenticator_oid
          ),
          ARRAY[]::text[]
        )
      ) AS setting
      UNION ALL
      SELECT pg_catalog.unnest(COALESCE(database_role.setconfig, ARRAY[]::text[]))
      FROM pg_catalog.pg_db_role_setting AS database_role
      WHERE database_role.setrole IN (0, v_authenticator_oid)
        AND database_role.setdatabase IN (
          0,
          (
            SELECT database_row.oid
            FROM pg_catalog.pg_database AS database_row
            WHERE database_row.datname = pg_catalog.current_database()
          )
        )
      UNION ALL
      SELECT 'pgrst.db_pre_request='
        || COALESCE(pg_catalog.current_setting('pgrst.db_pre_request', true), '')
    ) AS candidate
    WHERE candidate.setting LIKE 'pgrst.db_pre_request=%'
  LOOP
    v_value := pg_catalog.substr(
      v_setting,
      pg_catalog.length('pgrst.db_pre_request=') + 1
    );
    IF v_value NOT IN (
      '',
      'public.enforce_active_authenticated_subject_pre_request'
    ) THEN
      RAISE EXCEPTION 'refusing to replace existing PostgREST pre-request hook: %', v_value;
    END IF;
  END LOOP;
END
$preflight$;

-- This function intentionally returns boolean so the same proof can be used
-- as an RLS initplan. It reads the original transaction-scoped JWT settings;
-- current_user is not an identity boundary inside SECURITY DEFINER functions.
CREATE OR REPLACE FUNCTION public.require_active_authenticated_subject_request()
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_claims_text text := NULLIF(
    pg_catalog.current_setting('request.jwt.claims', true),
    ''
  );
  v_claims jsonb;
  v_json_role text;
  v_json_subject text;
  v_legacy_role text := NULLIF(
    pg_catalog.current_setting('request.jwt.claim.role', true),
    ''
  );
  v_legacy_subject text := NULLIF(
    pg_catalog.current_setting('request.jwt.claim.sub', true),
    ''
  );
  v_database_role text := NULLIF(
    pg_catalog.current_setting('role', true),
    'none'
  );
  v_claim_role text;
  v_claim_subject text;
  v_subject_id uuid;
  v_auth_uid uuid;
  v_profile record;
BEGIN
  -- Trusted maintenance traffic does not carry an end-user admission. In a
  -- SECURITY DEFINER call current_user changes, while this role setting keeps
  -- the original SET ROLE chosen by PostgREST.
  IF v_database_role IN ('service_role', 'postgres') THEN
    RETURN true;
  END IF;

  IF v_claims_text IS NOT NULL THEN
    BEGIN
      v_claims := v_claims_text::jsonb;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE EXCEPTION 'authenticated request JWT claims are malformed'
          USING ERRCODE = '42501';
    END;
    IF pg_catalog.jsonb_typeof(v_claims) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'authenticated request JWT claims must be an object'
        USING ERRCODE = '42501';
    END IF;
    v_json_role := NULLIF(v_claims ->> 'role', '');
    v_json_subject := NULLIF(v_claims ->> 'sub', '');
  END IF;

  IF v_json_role IS NOT NULL
    AND v_legacy_role IS NOT NULL
    AND v_json_role IS DISTINCT FROM v_legacy_role
  THEN
    RAISE EXCEPTION 'authenticated request JWT role claims conflict'
      USING ERRCODE = '42501';
  END IF;
  IF v_json_subject IS NOT NULL
    AND v_legacy_subject IS NOT NULL
    AND v_json_subject IS DISTINCT FROM v_legacy_subject
  THEN
    RAISE EXCEPTION 'authenticated request JWT subject claims conflict'
      USING ERRCODE = '42501';
  END IF;

  v_claim_role := COALESCE(v_json_role, v_legacy_role);
  v_claim_subject := COALESCE(v_json_subject, v_legacy_subject);

  IF v_claim_role IS DISTINCT FROM 'authenticated'
    AND v_database_role IS DISTINCT FROM 'authenticated'
  THEN
    RETURN true;
  END IF;

  IF v_claim_role IS DISTINCT FROM 'authenticated'
    OR v_claim_subject IS NULL
    OR v_database_role IS NOT NULL
      AND v_database_role IS DISTINCT FROM 'authenticated'
  THEN
    RAISE EXCEPTION 'authenticated request JWT identity is unavailable'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_subject_id := v_claim_subject::uuid;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'authenticated request JWT subject is malformed'
        USING ERRCODE = '42501';
  END;
  IF v_claim_subject IS DISTINCT FROM v_subject_id::text THEN
    RAISE EXCEPTION 'authenticated request JWT subject is not canonical'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_auth_uid := (SELECT auth.uid());
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'authenticated request JWT subject cannot be verified'
        USING ERRCODE = '42501';
  END;
  IF v_auth_uid IS DISTINCT FROM v_subject_id THEN
    RAISE EXCEPTION 'authenticated request JWT subject verification failed'
      USING ERRCODE = '42501';
  END IF;

  -- Readers share this lock with one another. Deletion, recovery, moderation,
  -- hard deletion, and authenticated mutations use its exclusive counterpart,
  -- so the request is wholly before or wholly after the lifecycle transition.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || v_subject_id::text,
      0
    )
  );

  SELECT
    profile.deleted_at,
    profile.banned_at,
    profile.is_banned,
    profile.ban_expires_at
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = v_subject_id;

  IF NOT FOUND
    OR v_profile.deleted_at IS NOT NULL
    OR v_profile.banned_at IS NOT NULL
    OR (
      COALESCE(v_profile.is_banned, false)
      AND (
        v_profile.ban_expires_at IS NULL
        OR v_profile.ban_expires_at > pg_catalog.clock_timestamp()
      )
    )
  THEN
    RAISE EXCEPTION 'authenticated account is not active'
      USING ERRCODE = '42501';
  END IF;

  RETURN true;
END
$function$;

ALTER FUNCTION public.require_active_authenticated_subject_request()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.require_active_authenticated_subject_request()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.require_active_authenticated_subject_request()
  TO authenticated;

CREATE OR REPLACE FUNCTION public.enforce_active_authenticated_subject_pre_request()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
BEGIN
  PERFORM public.require_active_authenticated_subject_request();
END
$function$;

ALTER FUNCTION public.enforce_active_authenticated_subject_pre_request()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_active_authenticated_subject_pre_request()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.enforce_active_authenticated_subject_pre_request()
  TO anon, authenticated, authenticator, service_role;

CREATE OR REPLACE FUNCTION public.install_active_authenticated_subject_request_admission()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_relation record;
  v_installed integer := 0;
  v_policy_name constant text :=
    '000_active_authenticated_subject_request_guard';
  v_authenticated_oid oid := pg_catalog.to_regrole('authenticated');
BEGIN
  -- A single future-migration call converges both the mutation trigger and the
  -- read/RPC admission layers for newly created tables and partitions.
  PERFORM public.install_active_authenticated_subject_mutation_barriers();

  FOR v_relation IN
    SELECT
      namespace.nspname AS schema_name,
      relation.relname AS relation_name,
      relation.oid AS relation_id
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('public', 'storage')
      AND relation.relkind IN ('r', 'p')
      AND relation.relrowsecurity
    ORDER BY namespace.nspname, relation.relname
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_relation.relation_id
        AND policy.polname = v_policy_name
        AND (
          policy.polpermissive
          OR policy.polcmd IS DISTINCT FROM '*'
          OR policy.polroles IS DISTINCT FROM ARRAY[v_authenticated_oid]::oid[]
          OR COALESCE(
            pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true),
            ''
          ) IS DISTINCT FROM
            '( SELECT public.require_active_authenticated_subject_request() AS require_active_authenticated_subject_request)'
          OR COALESCE(
            pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, true),
            ''
          ) IS DISTINCT FROM
            '( SELECT public.require_active_authenticated_subject_request() AS require_active_authenticated_subject_request)'
        )
    ) THEN
      EXECUTE pg_catalog.format(
        'DROP POLICY %I ON %I.%I',
        v_policy_name,
        v_relation.schema_name,
        v_relation.relation_name
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_relation.relation_id
        AND policy.polname = v_policy_name
    ) THEN
      EXECUTE pg_catalog.format(
        'CREATE POLICY %I ON %I.%I AS RESTRICTIVE FOR ALL '
          || 'TO authenticated '
          || 'USING ((SELECT public.require_active_authenticated_subject_request())) '
          || 'WITH CHECK ((SELECT public.require_active_authenticated_subject_request()))',
        v_policy_name,
        v_relation.schema_name,
        v_relation.relation_name
      );
      v_installed := v_installed + 1;
    END IF;
  END LOOP;

  RETURN v_installed;
END
$function$;

ALTER FUNCTION public.install_active_authenticated_subject_request_admission()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.install_active_authenticated_subject_request_admission()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

CREATE OR REPLACE FUNCTION public.assert_active_authenticated_subject_request_admission()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_policy_name constant text :=
    '000_active_authenticated_subject_request_guard';
  v_authenticated_oid oid := pg_catalog.to_regrole('authenticated');
  v_helper_signature pg_catalog.regprocedure :=
    'public.require_active_authenticated_subject_request()'::pg_catalog.regprocedure;
  v_pre_request_signature pg_catalog.regprocedure :=
    'public.enforce_active_authenticated_subject_pre_request()'::pg_catalog.regprocedure;
  v_installer_signature pg_catalog.regprocedure :=
    'public.install_active_authenticated_subject_request_admission()'::pg_catalog.regprocedure;
  v_relation_count integer;
  v_role_hook_count integer;
  v_source text;
BEGIN
  PERFORM public.assert_active_authenticated_subject_mutation_barriers();

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_helper_signature
    AND function_row.proowner = pg_catalog.to_regrole('postgres')
    AND function_row.prorettype = 'boolean'::pg_catalog.regtype
    AND function_row.prokind = 'f'
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off'
    ]::text[];
  IF pg_catalog.strpos(v_source, 'request.jwt.claims') = 0
    OR pg_catalog.strpos(v_source, 'request.jwt.claim.role') = 0
    OR pg_catalog.strpos(v_source, 'request.jwt.claim.sub') = 0
    OR pg_catalog.strpos(v_source, 'pg_advisory_xact_lock_shared') = 0
    OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') = 0
    OR pg_catalog.strpos(v_source, 'v_profile.deleted_at IS NOT NULL') = 0
    OR pg_catalog.strpos(v_source, 'v_profile.banned_at IS NOT NULL') = 0
    OR pg_catalog.strpos(v_source, 'COALESCE(v_profile.is_banned, false)') = 0
  THEN
    RAISE EXCEPTION 'inactive-subject request admission helper drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_pre_request_signature
    AND function_row.proowner = pg_catalog.to_regrole('postgres')
    AND function_row.prorettype = 'void'::pg_catalog.regtype
    AND function_row.prokind = 'f'
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off'
    ]::text[];
  IF pg_catalog.regexp_replace(v_source, '[[:space:]]+', ' ', 'g')
    IS DISTINCT FROM
      ' BEGIN PERFORM public.require_active_authenticated_subject_request(); END '
  THEN
    RAISE EXCEPTION 'inactive-subject PostgREST pre-request function drifted';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_role_hook_count
  FROM pg_catalog.pg_roles AS role_row
  CROSS JOIN LATERAL pg_catalog.unnest(
    COALESCE(role_row.rolconfig, ARRAY[]::text[])
  ) AS setting(value)
  WHERE role_row.rolname = 'authenticator'
    AND setting.value =
      'pgrst.db_pre_request=public.enforce_active_authenticated_subject_pre_request';
  IF v_role_hook_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'PostgREST inactive-subject pre-request hook drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('public', 'storage')
      AND relation.relkind IN ('r', 'p')
      AND relation.relrowsecurity
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid = relation.oid
          AND policy.polname = v_policy_name
          AND NOT policy.polpermissive
          AND policy.polcmd = '*'
          AND policy.polroles = ARRAY[v_authenticated_oid]::oid[]
          AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true) =
            '( SELECT public.require_active_authenticated_subject_request() AS require_active_authenticated_subject_request)'
          AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, true) =
            '( SELECT public.require_active_authenticated_subject_request() AS require_active_authenticated_subject_request)'
      )
  ) THEN
    RAISE EXCEPTION 'inactive-subject restrictive RLS coverage drifted: %', (
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'relation', policy.polrelid::pg_catalog.regclass::text,
          'qual', pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true),
          'check', pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, true)
        )
        ORDER BY policy.polrelid
      )
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polname = v_policy_name
    );
  END IF;

  IF pg_catalog.to_regclass('storage.objects') IS NOT NULL
    AND NOT (
      SELECT relation.relrowsecurity
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = 'storage.objects'::pg_catalog.regclass
    )
  THEN
    RAISE EXCEPTION 'storage.objects must retain row level security';
  END IF;

  IF pg_catalog.has_function_privilege(
    'anon',
    v_helper_signature,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticator',
    v_helper_signature,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    v_helper_signature,
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'authenticated',
    v_helper_signature,
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'anon',
    v_pre_request_signature,
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'authenticated',
    v_pre_request_signature,
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'authenticator',
    v_pre_request_signature,
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    v_pre_request_signature,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    v_installer_signature,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    v_installer_signature,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticator',
    v_installer_signature,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    v_installer_signature,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'inactive-subject request admission privileges drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'require_active_authenticated_subject_request',
        'enforce_active_authenticated_subject_pre_request',
        'install_active_authenticated_subject_request_admission',
        'assert_active_authenticated_subject_request_admission'
      )
  ) <> 4 THEN
    RAISE EXCEPTION 'inactive-subject request admission overload count drifted';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_relation_count
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('public', 'storage')
    AND relation.relkind IN ('r', 'p')
    AND relation.relrowsecurity;

  RETURN v_relation_count;
END
$function$;

ALTER FUNCTION public.assert_active_authenticated_subject_request_admission()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.assert_active_authenticated_subject_request_admission()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.assert_active_authenticated_subject_request_admission()
  TO service_role;

ALTER ROLE authenticator
  SET pgrst.db_pre_request =
    'public.enforce_active_authenticated_subject_pre_request';

SELECT public.install_active_authenticated_subject_request_admission();
SELECT public.assert_active_authenticated_subject_request_admission();

NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';

COMMENT ON FUNCTION public.require_active_authenticated_subject_request() IS
  'Original-JWT account admission shared by PostgREST, Storage, and Realtime RLS requests.';
COMMENT ON FUNCTION public.enforce_active_authenticated_subject_pre_request() IS
  'PostgREST pre-request hook rejecting missing, deleted, or actively banned authenticated subjects before table or RPC execution.';
COMMENT ON FUNCTION public.install_active_authenticated_subject_request_admission() IS
  'Private migration helper converging mutation triggers and restrictive authenticated RLS admission on public/storage RLS relations.';
COMMENT ON FUNCTION public.assert_active_authenticated_subject_request_admission() IS
  'Service-readable coverage assertion for PostgREST and restrictive RLS inactive-subject request admission.';

COMMIT;
