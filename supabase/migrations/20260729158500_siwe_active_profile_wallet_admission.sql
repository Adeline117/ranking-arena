-- Bind SIWE identity only for a currently active application account. Wallet
-- mutation, account deletion/moderation, and verified Auth admission all use
-- the same per-subject lifecycle lock so each race has one durable ordering.

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
      RAISE EXCEPTION 'required SIWE wallet-admission role is missing: %',
        v_role;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
    OR pg_catalog.to_regprocedure(
      'public.admit_verified_auth_profile_atomic(uuid,text)'
    ) IS NULL
  THEN
    RAISE EXCEPTION 'SIWE wallet-admission prerequisites are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('auth', 'users', 'id', 'uuid'::pg_catalog.regtype),
        ('public', 'user_profiles', 'id', 'uuid'::pg_catalog.regtype),
        ('public', 'user_profiles', 'handle', 'text'::pg_catalog.regtype),
        ('public', 'user_profiles', 'email', 'text'::pg_catalog.regtype),
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
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'auth.users'::pg_catalog.regclass
      AND attribute.attname = 'email'
      AND attribute.atttypid IN (
        'text'::pg_catalog.regtype,
        'varchar'::pg_catalog.regtype
      )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'SIWE wallet-admission columns are incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.user_profiles'::pg_catalog.regclass
      AND relation.relowner = pg_catalog.to_regrole('postgres')
      AND relation.relkind IN ('r', 'p')
  ) THEN
    RAISE EXCEPTION 'public.user_profiles ownership is incompatible';
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
        'bind_siwe_wallet_for_active_profile_atomic'
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid) <>
        'p_user_id uuid, p_wallet_address text'
  ) THEN
    RAISE EXCEPTION 'unexpected SIWE wallet-admission overload exists';
  END IF;

  IF v_binding IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_binding
      AND function_row.proowner = pg_catalog.to_regrole('postgres')
      AND function_row.prosecdef
      AND pg_catalog.strpos(
        function_row.prosrc,
        '''siwe-wallet-binding:'' || p_wallet_address'
      ) > 0
  ) THEN
    RAISE EXCEPTION 'existing SIWE wallet-admission function is unfamiliar';
  END IF;
END
$preflight$;

-- This function is also the final admission authority used immediately before
-- and after Auth token creation. Check suspension before reconciling email so
-- a rejected account cannot mutate even an identity projection.
CREATE OR REPLACE FUNCTION public.admit_verified_auth_profile_atomic(
  p_user_id uuid,
  p_verified_email text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_auth_email text;
  v_banned_at timestamptz;
  v_ban_expires_at timestamptz;
  v_deleted_at timestamptz;
  v_is_banned boolean;
  v_now timestamptz;
  v_profile_email text;
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
  v_now := pg_catalog.clock_timestamp();

  SELECT auth_user.email::text
  INTO v_auth_email
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND OR v_auth_email IS DISTINCT FROM p_verified_email THEN
    RETURN 'unavailable';
  END IF;

  SELECT
    profile.email,
    profile.banned_at,
    profile.ban_expires_at,
    profile.deleted_at,
    profile.is_banned
  INTO
    v_profile_email,
    v_banned_at,
    v_ban_expires_at,
    v_deleted_at,
    v_is_banned
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;

  IF v_banned_at IS NOT NULL
    OR v_deleted_at IS NOT NULL
    OR (
      COALESCE(v_is_banned, false)
      AND (
        v_ban_expires_at IS NULL
        OR v_ban_expires_at > v_now
      )
    )
  THEN
    RETURN 'suspended';
  END IF;

  IF v_profile_email IS DISTINCT FROM v_auth_email THEN
    UPDATE public.user_profiles AS profile
    SET email = v_auth_email
    WHERE profile.id = p_user_id;
  END IF;

  RETURN 'active';
END
$function$;

ALTER FUNCTION public.admit_verified_auth_profile_atomic(uuid, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admit_verified_auth_profile_atomic(uuid, text)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.admit_verified_auth_profile_atomic(uuid, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.bind_siwe_wallet_for_active_profile_atomic(
  p_user_id uuid,
  p_wallet_address text
)
RETURNS TABLE (
  status text,
  result_user_id uuid,
  result_handle text,
  result_email text,
  result_wallet_address text
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
  v_existing_owner uuid;
  v_now timestamptz;
  v_profile public.user_profiles%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_wallet_address IS NULL
    OR p_wallet_address IS DISTINCT FROM pg_catalog.lower(p_wallet_address)
    OR p_wallet_address !~ '^0x[0-9a-f]{40}$'
  THEN
    RAISE EXCEPTION 'invalid SIWE wallet-admission input'
      USING ERRCODE = '22023';
  END IF;

  -- Subject lock first, then wallet identity. Calls for the same subject or
  -- wallet serialize without ever holding a second subject's lifecycle key.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'siwe-wallet-binding:' || p_wallet_address,
      0
    )
  );
  v_now := pg_catalog.clock_timestamp();

  SELECT true
  INTO v_auth_locked
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_user_id
  FOR SHARE;

  IF NOT FOUND OR NOT v_auth_locked THEN
    RETURN QUERY SELECT
      'missing'::text,
      NULL::uuid,
      NULL::text,
      NULL::text,
      NULL::text;
    RETURN;
  END IF;

  SELECT profile.*
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'missing'::text,
      NULL::uuid,
      NULL::text,
      NULL::text,
      NULL::text;
    RETURN;
  END IF;

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
    RETURN QUERY SELECT
      'suspended'::text,
      NULL::uuid,
      NULL::text,
      NULL::text,
      NULL::text;
    RETURN;
  END IF;

  IF v_profile.wallet_address IS NOT NULL
    AND v_profile.wallet_address IS DISTINCT FROM p_wallet_address
  THEN
    RETURN QUERY SELECT
      'conflict'::text,
      NULL::uuid,
      NULL::text,
      NULL::text,
      NULL::text;
    RETURN;
  END IF;

  IF v_profile.wallet_address IS NULL THEN
    SELECT profile.id
    INTO v_existing_owner
    FROM public.user_profiles AS profile
    WHERE pg_catalog.lower(profile.wallet_address) = p_wallet_address
      AND profile.id <> p_user_id
    LIMIT 1
    FOR KEY SHARE;

    IF FOUND THEN
      RETURN QUERY SELECT
        'conflict'::text,
        NULL::uuid,
        NULL::text,
        NULL::text,
        NULL::text;
      RETURN;
    END IF;

    BEGIN
      UPDATE public.user_profiles AS profile
      SET wallet_address = p_wallet_address
      WHERE profile.id = p_user_id
        AND profile.wallet_address IS NULL;
      GET DIAGNOSTICS v_affected_count = ROW_COUNT;
    EXCEPTION
      WHEN unique_violation THEN
        RETURN QUERY SELECT
          'conflict'::text,
          NULL::uuid,
          NULL::text,
          NULL::text,
          NULL::text;
        RETURN;
    END;

    IF v_affected_count IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'SIWE wallet admission lost its locked profile'
        USING ERRCODE = '40001';
    END IF;
    v_profile.wallet_address := p_wallet_address;
  END IF;

  RETURN QUERY SELECT
    'active'::text,
    v_profile.id,
    v_profile.handle,
    v_profile.email,
    v_profile.wallet_address;
END
$function$;

ALTER FUNCTION public.bind_siwe_wallet_for_active_profile_atomic(uuid, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.bind_siwe_wallet_for_active_profile_atomic(uuid, text)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION
  public.bind_siwe_wallet_for_active_profile_atomic(uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.bind_siwe_wallet_for_active_profile_atomic(uuid, text)
  IS 'Atomically admits an active profile and idempotently binds its verified SIWE wallet under account lifecycle locks.';

DO $postflight$
DECLARE
  v_admission pg_catalog.regprocedure :=
    'public.admit_verified_auth_profile_atomic(uuid,text)'::pg_catalog.regprocedure;
  v_binding pg_catalog.regprocedure :=
    'public.bind_siwe_wallet_for_active_profile_atomic(uuid,text)'::pg_catalog.regprocedure;
  v_service_role oid := pg_catalog.to_regrole('service_role');
  v_source text;
  v_signature pg_catalog.regprocedure;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[v_admission, v_binding]::pg_catalog.regprocedure[]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_signature
        AND function_row.proowner = pg_catalog.to_regrole('postgres')
        AND function_row.prosecdef
        AND function_row.provolatile = 'v'
        AND function_row.proconfig @>
          ARRAY[
            'search_path=pg_catalog, pg_temp',
            'row_security=off',
            'lock_timeout=5s'
          ]::text[]
    ) THEN
      RAISE EXCEPTION 'SIWE lifecycle authority function properties drifted: %',
        v_signature;
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
      WHERE function_row.oid = v_signature
        AND privilege.privilege_type = 'EXECUTE'
        AND privilege.grantee NOT IN (
          pg_catalog.to_regrole('postgres'),
          v_service_role
        )
    ) OR NOT pg_catalog.has_function_privilege(
      'service_role', v_signature, 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'SIWE lifecycle authority ACL drifted: %', v_signature;
    END IF;
  END LOOP;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_admission;

  IF pg_catalog.strpos(
      v_source,
      '''account-recovery-admission:'' || p_user_id::text'
    ) = 0
    OR pg_catalog.strpos(v_source, 'service role required') = 0
    OR pg_catalog.strpos(v_source, 'RETURN ''suspended''') = 0
    OR pg_catalog.strpos(v_source, 'SET email = v_auth_email') <
      pg_catalog.strpos(v_source, 'RETURN ''suspended''')
  THEN
    RAISE EXCEPTION 'verified Auth lifecycle admission source drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_binding;

  IF pg_catalog.strpos(
      v_source,
      '''account-recovery-admission:'' || p_user_id::text'
    ) = 0
    OR pg_catalog.strpos(
      v_source,
      '''siwe-wallet-binding:'' || p_wallet_address'
    ) = 0
    OR pg_catalog.strpos(v_source, 'v_profile.banned_at IS NOT NULL') = 0
    OR pg_catalog.strpos(v_source, 'v_profile.ban_expires_at > v_now') = 0
    OR pg_catalog.strpos(v_source, 'v_profile.deleted_at IS NOT NULL') = 0
    OR pg_catalog.strpos(v_source, 'SET wallet_address = p_wallet_address') = 0
  THEN
    RAISE EXCEPTION 'SIWE wallet lifecycle admission source drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'admit_verified_auth_profile_atomic',
        'bind_siwe_wallet_for_active_profile_atomic'
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'SIWE lifecycle authority overload count drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
