-- Unlink SIWE identity only for a currently active account. The operation uses
-- the same subject and wallet advisory locks as binding, so link/unlink and
-- moderation/deletion have one serial order instead of a service-role race.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('user-profile-authority-migrations', 0)
);

DO $preflight$
DECLARE
  v_binding pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.bind_siwe_wallet_for_active_profile_atomic(uuid,text)'
  );
  v_function pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.unbind_siwe_wallet_for_active_profile_atomic(uuid)'
  );
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY[
    'postgres',
    'anon',
    'authenticated',
    'authenticator',
    'service_role'
  ]::text[]
  LOOP
    IF pg_catalog.to_regrole(v_role) IS NULL THEN
      RAISE EXCEPTION 'required SIWE wallet-unlink role is missing: %', v_role;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
    OR v_binding IS NULL
  THEN
    RAISE EXCEPTION 'SIWE wallet-unlink prerequisites are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('auth', 'users', 'id', 'uuid'::pg_catalog.regtype),
        ('public', 'user_profiles', 'id', 'uuid'::pg_catalog.regtype),
        ('public', 'user_profiles', 'wallet_address', 'text'::pg_catalog.regtype),
        ('public', 'user_profiles', 'banned_at', 'timestamptz'::pg_catalog.regtype),
        ('public', 'user_profiles', 'ban_expires_at', 'timestamptz'::pg_catalog.regtype),
        ('public', 'user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype),
        ('public', 'user_profiles', 'is_banned', 'boolean'::pg_catalog.regtype)
    ) AS required_column(schema_name, relation_name, column_name, type_oid)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = pg_catalog.to_regclass(
          required_column.schema_name || '.' || required_column.relation_name
        )
        AND attribute.attname = required_column.column_name
        AND attribute.atttypid = required_column.type_oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
  ) THEN
    RAISE EXCEPTION 'SIWE wallet-unlink columns are incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('auth.users'::pg_catalog.regclass),
        ('public.user_profiles'::pg_catalog.regclass)
    ) AS required_relation(relation_id)
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = required_relation.relation_id
    WHERE relation.relowner <> pg_catalog.to_regrole('postgres')
      OR relation.relkind NOT IN ('r', 'p')
  ) THEN
    RAISE EXCEPTION 'SIWE wallet-unlink relation ownership is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_binding
      AND function_row.proowner = pg_catalog.to_regrole('postgres')
      AND function_row.prosecdef
      AND pg_catalog.strpos(
        function_row.prosrc,
        '''account-recovery-admission:'' || p_user_id::text'
      ) > 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        '''siwe-wallet-binding:'' || p_wallet_address'
      ) > 0
  ) THEN
    RAISE EXCEPTION 'SIWE wallet-binding prerequisite is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indexrelid = pg_catalog.to_regclass(
        'public.user_profiles_wallet_address_lower_unique'
      )
      AND index_row.indrelid = 'public.user_profiles'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND pg_catalog.pg_get_expr(
        index_row.indexprs,
        index_row.indrelid
      ) = 'lower(wallet_address)'
      AND pg_catalog.pg_get_expr(
        index_row.indpred,
        index_row.indrelid
      ) = '(wallet_address IS NOT NULL)'
  ) THEN
    RAISE EXCEPTION 'canonical wallet identity index is missing or incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname =
        'unbind_siwe_wallet_for_active_profile_atomic'
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid) <>
        'p_user_id uuid'
  ) THEN
    RAISE EXCEPTION 'unexpected SIWE wallet-unlink overload exists';
  END IF;

  IF v_function IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.proowner = pg_catalog.to_regrole('postgres')
      AND function_row.prosecdef
      AND pg_catalog.strpos(
        function_row.prosrc,
        '''siwe-wallet-binding:'' || v_observed_wallet'
      ) > 0
  ) THEN
    RAISE EXCEPTION 'existing SIWE wallet-unlink function is unfamiliar';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.unbind_siwe_wallet_for_active_profile_atomic(
  p_user_id uuid
)
RETURNS TABLE (
  status text,
  result_user_id uuid,
  released_wallet_address text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_affected_count integer;
  v_auth_locked boolean := false;
  v_now timestamptz;
  v_observed_wallet text;
  v_profile public.user_profiles%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user id is required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );

  -- Observe only the wallet-lock identity. The subject lifecycle key prevents
  -- every canonical same-account writer from changing it. A legacy writer is
  -- detected by the locked-row recheck below and causes a retryable rollback.
  SELECT profile.wallet_address
  INTO v_observed_wallet
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id;

  IF FOUND AND v_observed_wallet IS NOT NULL THEN
    -- Use the binding namespace, not a separate unlink namespace: a different
    -- account trying to claim this wallet must serialize with its release.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'siwe-wallet-binding:' || v_observed_wallet,
        0
      )
    );
  END IF;

  -- Lock order exactly matches binding after advisory acquisition:
  -- auth.users first, then user_profiles.
  SELECT true
  INTO v_auth_locked
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_user_id
  FOR SHARE;

  IF NOT FOUND OR NOT v_auth_locked THEN
    RETURN QUERY SELECT 'missing'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  SELECT profile.*
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'missing'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  IF v_profile.wallet_address IS DISTINCT FROM v_observed_wallet THEN
    RAISE EXCEPTION 'SIWE wallet changed outside its lifecycle authority'
      USING ERRCODE = '40001';
  END IF;

  v_now := pg_catalog.clock_timestamp();
  IF v_profile.banned_at IS NOT NULL
    OR v_profile.deleted_at IS NOT NULL
    OR (
      COALESCE(v_profile.is_banned, false)
      AND (
        v_profile.ban_expires_at IS NULL
        OR v_profile.ban_expires_at > v_now
      )
    )
  THEN
    RETURN QUERY SELECT 'suspended'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  IF v_profile.wallet_address IS NULL THEN
    RETURN QUERY SELECT
      'already_unbound'::text,
      v_profile.id,
      NULL::text;
    RETURN;
  END IF;

  UPDATE public.user_profiles AS profile
  SET wallet_address = NULL
  WHERE profile.id = p_user_id
    AND profile.wallet_address = v_observed_wallet;
  GET DIAGNOSTICS v_affected_count = ROW_COUNT;

  IF v_affected_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'SIWE wallet unlink lost its locked profile'
      USING ERRCODE = '40001';
  END IF;

  RETURN QUERY SELECT
    'unbound'::text,
    v_profile.id,
    v_observed_wallet;
END
$function$;

ALTER FUNCTION public.unbind_siwe_wallet_for_active_profile_atomic(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.unbind_siwe_wallet_for_active_profile_atomic(uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION
  public.unbind_siwe_wallet_for_active_profile_atomic(uuid)
  TO service_role;

COMMENT ON FUNCTION public.unbind_siwe_wallet_for_active_profile_atomic(uuid)
  IS 'Atomically admits an active profile and idempotently releases its SIWE wallet under account and wallet lifecycle locks.';

DO $postflight$
DECLARE
  v_function pg_catalog.regprocedure :=
    'public.unbind_siwe_wallet_for_active_profile_atomic(uuid)'::pg_catalog.regprocedure;
  v_service_role oid := pg_catalog.to_regrole('service_role');
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function
    AND function_row.proowner = pg_catalog.to_regrole('postgres')
    AND function_row.prorettype = 'record'::pg_catalog.regtype
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.proconfig @>
      ARRAY[
        'search_path=pg_catalog, pg_temp',
        'row_security=off',
        'lock_timeout=5s'
      ]::text[];

  IF pg_catalog.strpos(
      v_source,
      '''account-recovery-admission:'' || p_user_id::text'
    ) = 0
    OR pg_catalog.strpos(
      v_source,
      '''siwe-wallet-binding:'' || v_observed_wallet'
    ) = 0
    OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') = 0
    OR pg_catalog.strpos(v_source, 'FOR SHARE') = 0
    OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') = 0
    OR pg_catalog.strpos(v_source, 'FOR UPDATE') = 0
    OR pg_catalog.strpos(v_source, 'v_profile.banned_at IS NOT NULL') = 0
    OR pg_catalog.strpos(v_source, 'v_profile.ban_expires_at > v_now') = 0
    OR pg_catalog.strpos(v_source, 'v_profile.deleted_at IS NOT NULL') = 0
    OR pg_catalog.strpos(v_source, 'SET wallet_address = NULL') = 0
    OR pg_catalog.strpos(
      v_source,
      '''account-recovery-admission:'' || p_user_id::text'
    ) > pg_catalog.strpos(
      v_source,
      '''siwe-wallet-binding:'' || v_observed_wallet'
    )
    OR pg_catalog.strpos(
      v_source,
      '''siwe-wallet-binding:'' || v_observed_wallet'
    ) > pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user')
    OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') >
      pg_catalog.strpos(v_source, 'FOR UPDATE')
  THEN
    RAISE EXCEPTION 'SIWE wallet-unlink source drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS privilege
    WHERE function_row.oid = v_function
      AND privilege.privilege_type = 'EXECUTE'
      AND privilege.grantee NOT IN (
        pg_catalog.to_regrole('postgres'),
        v_service_role
      )
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', v_function, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'SIWE wallet-unlink ACL drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname =
        'unbind_siwe_wallet_for_active_profile_atomic'
  ) <> 1 THEN
    RAISE EXCEPTION 'SIWE wallet-unlink overload count drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
