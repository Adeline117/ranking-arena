-- 2FA secrets and backup codes are account-security credentials. Serialize
-- every read and mutation with account suspension/deletion before taking the
-- per-user 2FA namespace and credential-row locks.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('user-profile-authority-migrations', 0)
);

DO $preflight$
DECLARE
  v_function record;
  v_helper pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.lock_active_two_factor_profile(uuid)'
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
      RAISE EXCEPTION 'required active-profile 2FA role is missing: %',
        v_role;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
    OR pg_catalog.to_regprocedure(
      'public.lock_account_lifecycle_subject_transition()'
    ) IS NULL
  THEN
    RAISE EXCEPTION 'active-profile 2FA prerequisites are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('auth', 'users', 'id', 'uuid'::pg_catalog.regtype),
        ('public', 'user_profiles', 'id', 'uuid'::pg_catalog.regtype),
        ('public', 'user_profiles', 'totp_enabled', 'boolean'::pg_catalog.regtype),
        ('public', 'user_profiles', 'banned_at', 'timestamptz'::pg_catalog.regtype),
        ('public', 'user_profiles', 'ban_expires_at', 'timestamptz'::pg_catalog.regtype),
        ('public', 'user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype),
        ('public', 'user_profiles', 'is_banned', 'boolean'::pg_catalog.regtype),
        ('public', 'user_2fa_secrets', 'user_id', 'uuid'::pg_catalog.regtype),
        ('public', 'user_2fa_secrets', 'totp_secret', 'text'::pg_catalog.regtype),
        ('public', 'user_2fa_secrets', 'created_at', 'timestamptz'::pg_catalog.regtype),
        ('public', 'user_2fa_secrets', 'updated_at', 'timestamptz'::pg_catalog.regtype),
        ('public', 'backup_codes', 'id', 'uuid'::pg_catalog.regtype),
        ('public', 'backup_codes', 'user_id', 'uuid'::pg_catalog.regtype),
        ('public', 'backup_codes', 'code_hash', 'text'::pg_catalog.regtype),
        ('public', 'backup_codes', 'used', 'boolean'::pg_catalog.regtype)
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
    RAISE EXCEPTION 'active-profile 2FA columns are incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('auth.users'::pg_catalog.regclass),
        ('public.user_profiles'::pg_catalog.regclass),
        ('public.user_2fa_secrets'::pg_catalog.regclass),
        ('public.backup_codes'::pg_catalog.regclass)
    ) AS required_relation(relation_id)
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = required_relation.relation_id
    WHERE relation.relowner <> pg_catalog.to_regrole('postgres')
      OR relation.relkind NOT IN ('r', 'p')
  ) THEN
    RAISE EXCEPTION 'active-profile 2FA relation ownership is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.user_2fa_secrets'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 1
      AND index_row.indnatts = 1
      AND pg_catalog.pg_get_indexdef(index_row.indexrelid, 1, true) = 'user_id'
  ) THEN
    RAISE EXCEPTION '2FA secret user identity constraint is incompatible';
  END IF;

  FOR v_function IN
    SELECT *
    FROM (
      VALUES
        ('lock_active_two_factor_profile', 'p_user_id uuid'),
        ('read_two_factor_enrollment_secret', 'p_user_id uuid'),
        (
          'stage_two_factor_enrollment_secret_atomic',
          'p_user_id uuid, p_totp_secret text'
        ),
        (
          'enable_two_factor_credentials_atomic',
          'p_user_id uuid, p_expected_totp_secret text, p_code_hashes text[]'
        ),
        (
          'rotate_two_factor_backup_codes_atomic',
          'p_user_id uuid, p_code_hashes text[]'
        ),
        ('disable_two_factor_credentials_atomic', 'p_user_id uuid')
    ) AS expected(function_name, identity_arguments)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
        AND function_row.proname = v_function.function_name
        AND pg_catalog.pg_get_function_identity_arguments(function_row.oid)
          <> v_function.identity_arguments
    ) THEN
      RAISE EXCEPTION 'unexpected active-profile 2FA overload exists: %',
        v_function.function_name;
    END IF;
  END LOOP;

  IF v_helper IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_helper
        AND function_row.proowner = pg_catalog.to_regrole('postgres')
        AND function_row.prosecdef
        AND pg_catalog.strpos(
          function_row.prosrc,
          '''account-recovery-admission:'' || p_user_id::text'
        ) > 0
    )
  THEN
    RAISE EXCEPTION 'existing active-profile 2FA lock authority is unfamiliar';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.lock_active_two_factor_profile(
  p_user_id uuid
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
  v_auth_locked boolean := false;
  v_now timestamptz;
  v_profile public.user_profiles%ROWTYPE;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN 'invalid_user';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
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
    RETURN 'user_not_found';
  END IF;

  SELECT profile.*
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'profile_not_found';
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
    RETURN 'suspended';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'two-factor-credentials:' || p_user_id::text,
      0
    )
  );

  RETURN 'active';
END
$function$;

CREATE OR REPLACE FUNCTION public.read_two_factor_enrollment_secret(
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_enabled boolean;
  v_secret text;
  v_status text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required for 2FA enrollment read'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_user');
  END IF;

  v_status := public.lock_active_two_factor_profile(p_user_id);
  IF v_status IS DISTINCT FROM 'active' THEN
    RETURN pg_catalog.jsonb_build_object('status', v_status);
  END IF;

  SELECT COALESCE(profile.totp_enabled, false)
  INTO STRICT v_enabled
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id;

  IF v_enabled THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_enabled');
  END IF;

  SELECT secret_row.totp_secret
  INTO v_secret
  FROM public.user_2fa_secrets AS secret_row
  WHERE secret_row.user_id = p_user_id
  FOR SHARE;

  IF NOT FOUND
    OR v_secret IS NULL
    OR v_secret !~ '^[A-Z2-7]{16,128}$'
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'secret_not_found');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ready',
    'totp_secret', v_secret
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.stage_two_factor_enrollment_secret_atomic(
  p_user_id uuid,
  p_totp_secret text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_enabled boolean;
  v_status text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required for 2FA enrollment staging'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_totp_secret IS NULL
    OR p_totp_secret !~ '^[A-Z2-7]{16,128}$'
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  v_status := public.lock_active_two_factor_profile(p_user_id);
  IF v_status IS DISTINCT FROM 'active' THEN
    RETURN pg_catalog.jsonb_build_object('status', v_status);
  END IF;

  SELECT COALESCE(profile.totp_enabled, false)
  INTO STRICT v_enabled
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id;

  IF v_enabled THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_enabled');
  END IF;

  PERFORM 1
  FROM public.user_2fa_secrets AS secret_row
  WHERE secret_row.user_id = p_user_id
  FOR UPDATE;

  INSERT INTO public.user_2fa_secrets AS secret_row (
    user_id,
    totp_secret,
    created_at,
    updated_at
  ) VALUES (
    p_user_id,
    p_totp_secret,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET totp_secret = EXCLUDED.totp_secret,
      updated_at = EXCLUDED.updated_at;

  RETURN pg_catalog.jsonb_build_object('status', 'staged');
END
$function$;

CREATE OR REPLACE FUNCTION public.enable_two_factor_credentials_atomic(
  p_user_id uuid,
  p_expected_totp_secret text,
  p_code_hashes text[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_code_count integer;
  v_enabled boolean;
  v_secret text;
  v_status text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required for atomic 2FA enablement'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_expected_totp_secret IS NULL
    OR p_expected_totp_secret !~ '^[A-Z2-7]{16,128}$'
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  IF p_code_hashes IS NULL
    OR pg_catalog.cardinality(p_code_hashes) <> 8
    OR pg_catalog.array_position(p_code_hashes, NULL) IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(p_code_hashes) AS supplied_hash(code_hash)
      WHERE supplied_hash.code_hash !~ '^[0-9a-f]{64}$'
    )
    OR (
      SELECT pg_catalog.count(DISTINCT supplied_hash.code_hash)
      FROM pg_catalog.unnest(p_code_hashes) AS supplied_hash(code_hash)
    ) <> 8
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_codes');
  END IF;

  v_status := public.lock_active_two_factor_profile(p_user_id);
  IF v_status IS DISTINCT FROM 'active' THEN
    RETURN pg_catalog.jsonb_build_object('status', v_status);
  END IF;

  SELECT COALESCE(profile.totp_enabled, false)
  INTO STRICT v_enabled
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id;

  IF v_enabled THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_enabled');
  END IF;

  SELECT secret_row.totp_secret
  INTO v_secret
  FROM public.user_2fa_secrets AS secret_row
  WHERE secret_row.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_secret IS NULL
    OR v_secret !~ '^[A-Z2-7]{16,128}$'
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'secret_not_found');
  END IF;
  IF v_secret IS DISTINCT FROM p_expected_totp_secret THEN
    RETURN pg_catalog.jsonb_build_object('status', 'secret_changed');
  END IF;

  PERFORM 1
  FROM public.backup_codes AS backup_code
  WHERE backup_code.user_id = p_user_id
  ORDER BY backup_code.id
  FOR UPDATE;

  DELETE FROM public.backup_codes AS backup_code
  WHERE backup_code.user_id = p_user_id;

  INSERT INTO public.backup_codes (
    user_id,
    code_hash,
    used
  )
  SELECT
    p_user_id,
    supplied_hash.code_hash,
    false
  FROM pg_catalog.unnest(p_code_hashes)
    WITH ORDINALITY AS supplied_hash(code_hash, ordinality)
  ORDER BY supplied_hash.ordinality;
  GET DIAGNOSTICS v_code_count = ROW_COUNT;

  IF v_code_count IS DISTINCT FROM 8 THEN
    RAISE EXCEPTION '2FA backup code insertion cardinality drifted';
  END IF;

  UPDATE public.user_profiles AS profile
  SET totp_enabled = true
  WHERE profile.id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '2FA profile disappeared during enablement'
      USING ERRCODE = '40001';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'enabled',
    'code_count', v_code_count
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.rotate_two_factor_backup_codes_atomic(
  p_user_id uuid,
  p_code_hashes text[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_code_count integer;
  v_enabled boolean;
  v_secret text;
  v_status text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required for atomic 2FA backup code rotation'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_user');
  END IF;
  IF p_code_hashes IS NULL
    OR pg_catalog.cardinality(p_code_hashes) <> 8
    OR pg_catalog.array_position(p_code_hashes, NULL) IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(p_code_hashes) AS supplied_hash(code_hash)
      WHERE supplied_hash.code_hash !~ '^[0-9a-f]{64}$'
    )
    OR (
      SELECT pg_catalog.count(DISTINCT supplied_hash.code_hash)
      FROM pg_catalog.unnest(p_code_hashes) AS supplied_hash(code_hash)
    ) <> 8
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_codes');
  END IF;

  v_status := public.lock_active_two_factor_profile(p_user_id);
  IF v_status IS DISTINCT FROM 'active' THEN
    RETURN pg_catalog.jsonb_build_object('status', v_status);
  END IF;

  SELECT COALESCE(profile.totp_enabled, false)
  INTO STRICT v_enabled
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id;
  IF NOT v_enabled THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_enabled');
  END IF;

  SELECT secret_row.totp_secret
  INTO v_secret
  FROM public.user_2fa_secrets AS secret_row
  WHERE secret_row.user_id = p_user_id
  FOR SHARE;
  IF NOT FOUND
    OR v_secret IS NULL
    OR v_secret !~ '^[A-Z2-7]{16,128}$'
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'credential_inconsistent'
    );
  END IF;

  PERFORM 1
  FROM public.backup_codes AS backup_code
  WHERE backup_code.user_id = p_user_id
  ORDER BY backup_code.id
  FOR UPDATE;

  DELETE FROM public.backup_codes AS backup_code
  WHERE backup_code.user_id = p_user_id;

  INSERT INTO public.backup_codes (
    user_id,
    code_hash,
    used
  )
  SELECT
    p_user_id,
    supplied_hash.code_hash,
    false
  FROM pg_catalog.unnest(p_code_hashes)
    WITH ORDINALITY AS supplied_hash(code_hash, ordinality)
  ORDER BY supplied_hash.ordinality;
  GET DIAGNOSTICS v_code_count = ROW_COUNT;

  IF v_code_count IS DISTINCT FROM 8 THEN
    RAISE EXCEPTION '2FA backup code rotation cardinality drifted';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'rotated',
    'code_count', v_code_count
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.disable_two_factor_credentials_atomic(
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_code_count integer;
  v_enabled boolean;
  v_secret_count integer;
  v_status text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required for atomic 2FA disablement'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_user');
  END IF;

  v_status := public.lock_active_two_factor_profile(p_user_id);
  IF v_status IS DISTINCT FROM 'active' THEN
    RETURN pg_catalog.jsonb_build_object('status', v_status);
  END IF;

  SELECT COALESCE(profile.totp_enabled, false)
  INTO STRICT v_enabled
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id;
  IF NOT v_enabled THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_enabled');
  END IF;

  PERFORM 1
  FROM public.user_2fa_secrets AS secret_row
  WHERE secret_row.user_id = p_user_id
  FOR UPDATE;

  PERFORM 1
  FROM public.backup_codes AS backup_code
  WHERE backup_code.user_id = p_user_id
  ORDER BY backup_code.id
  FOR UPDATE;

  DELETE FROM public.backup_codes AS backup_code
  WHERE backup_code.user_id = p_user_id;
  GET DIAGNOSTICS v_code_count = ROW_COUNT;

  DELETE FROM public.user_2fa_secrets AS secret_row
  WHERE secret_row.user_id = p_user_id;
  GET DIAGNOSTICS v_secret_count = ROW_COUNT;

  UPDATE public.user_profiles AS profile
  SET totp_enabled = false
  WHERE profile.id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '2FA profile disappeared during disablement'
      USING ERRCODE = '40001';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'disabled',
    'code_count', v_code_count,
    'secret_count', v_secret_count
  );
END
$function$;

ALTER FUNCTION public.lock_active_two_factor_profile(uuid)
  OWNER TO postgres;
ALTER FUNCTION public.read_two_factor_enrollment_secret(uuid)
  OWNER TO postgres;
ALTER FUNCTION public.stage_two_factor_enrollment_secret_atomic(uuid, text)
  OWNER TO postgres;
ALTER FUNCTION public.enable_two_factor_credentials_atomic(uuid, text, text[])
  OWNER TO postgres;
ALTER FUNCTION public.rotate_two_factor_backup_codes_atomic(uuid, text[])
  OWNER TO postgres;
ALTER FUNCTION public.disable_two_factor_credentials_atomic(uuid)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.lock_active_two_factor_profile(uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.read_two_factor_enrollment_secret(uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.stage_two_factor_enrollment_secret_atomic(uuid, text)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.enable_two_factor_credentials_atomic(uuid, text, text[])
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.rotate_two_factor_backup_codes_atomic(uuid, text[])
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.disable_two_factor_credentials_atomic(uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

GRANT EXECUTE ON FUNCTION public.read_two_factor_enrollment_secret(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.stage_two_factor_enrollment_secret_atomic(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.enable_two_factor_credentials_atomic(uuid, text, text[])
  TO service_role;
GRANT EXECUTE ON FUNCTION public.rotate_two_factor_backup_codes_atomic(uuid, text[])
  TO service_role;
GRANT EXECUTE ON FUNCTION public.disable_two_factor_credentials_atomic(uuid)
  TO service_role;

COMMENT ON FUNCTION public.lock_active_two_factor_profile(uuid) IS
  'Private lock authority: lifecycle, Auth, active profile, then 2FA namespace.';
COMMENT ON FUNCTION public.read_two_factor_enrollment_secret(uuid) IS
  'Reads a staged TOTP secret only for an active account under lifecycle locks.';
COMMENT ON FUNCTION public.stage_two_factor_enrollment_secret_atomic(uuid, text) IS
  'Stages a TOTP secret only for an active account under lifecycle locks.';
COMMENT ON FUNCTION public.enable_two_factor_credentials_atomic(uuid, text, text[]) IS
  'Enables TOTP and publishes backup hashes only for an active account.';
COMMENT ON FUNCTION public.rotate_two_factor_backup_codes_atomic(uuid, text[]) IS
  'Rotates backup hashes only for an active account under lifecycle locks.';
COMMENT ON FUNCTION public.disable_two_factor_credentials_atomic(uuid) IS
  'Disables TOTP only for an active account; suspended and deleted accounts are immutable.';

DO $postflight$
DECLARE
  v_function pg_catalog.regprocedure;
  v_function_name text;
  v_helper pg_catalog.regprocedure :=
    'public.lock_active_two_factor_profile(uuid)'::pg_catalog.regprocedure;
  v_service_role oid := pg_catalog.to_regrole('service_role');
  v_source text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_helper
      AND function_row.proowner = pg_catalog.to_regrole('postgres')
      AND function_row.prorettype = 'text'::pg_catalog.regtype
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'row_security=off',
        'lock_timeout=5s'
      ]::text[]
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS privilege
    WHERE function_row.oid = v_helper
      AND privilege.privilege_type = 'EXECUTE'
      AND privilege.grantee <> pg_catalog.to_regrole('postgres')
  ) THEN
    RAISE EXCEPTION 'active-profile 2FA lock authority drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_helper;

  IF pg_catalog.strpos(
      v_source,
      '''account-recovery-admission:'' || p_user_id::text'
    ) = 0
    OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') = 0
    OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') = 0
    OR pg_catalog.strpos(
      v_source,
      '''two-factor-credentials:'' || p_user_id::text'
    ) = 0
    OR pg_catalog.strpos(v_source, 'v_profile.banned_at IS NOT NULL') = 0
    OR pg_catalog.strpos(v_source, 'v_profile.deleted_at IS NOT NULL') = 0
    OR pg_catalog.strpos(
      v_source,
      '''account-recovery-admission:'' || p_user_id::text'
    ) > pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user')
    OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') >
      pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile')
    OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') >
      pg_catalog.strpos(
        v_source,
        '''two-factor-credentials:'' || p_user_id::text'
      )
  THEN
    RAISE EXCEPTION 'active-profile 2FA lock ordering drifted';
  END IF;

  FOREACH v_function_name IN ARRAY ARRAY[
    'public.read_two_factor_enrollment_secret(uuid)',
    'public.stage_two_factor_enrollment_secret_atomic(uuid,text)',
    'public.enable_two_factor_credentials_atomic(uuid,text,text[])',
    'public.rotate_two_factor_backup_codes_atomic(uuid,text[])',
    'public.disable_two_factor_credentials_atomic(uuid)'
  ]::text[]
  LOOP
    v_function := v_function_name::pg_catalog.regprocedure;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_function
        AND function_row.proowner = pg_catalog.to_regrole('postgres')
        AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
        AND function_row.prosecdef
        AND function_row.provolatile = 'v'
        AND function_row.proconfig @> ARRAY[
          'search_path=pg_catalog, pg_temp',
          'row_security=off',
          'lock_timeout=5s'
        ]::text[]
        AND pg_catalog.strpos(
          function_row.prosrc,
          'public.lock_active_two_factor_profile(p_user_id)'
        ) > 0
    ) THEN
      RAISE EXCEPTION 'active-profile 2FA function drifted: %',
        v_function_name;
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
      RAISE EXCEPTION 'active-profile 2FA function ACL drifted: %',
        v_function_name;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'lock_active_two_factor_profile',
        'read_two_factor_enrollment_secret',
        'stage_two_factor_enrollment_secret_atomic',
        'enable_two_factor_credentials_atomic',
        'rotate_two_factor_backup_codes_atomic',
        'disable_two_factor_credentials_atomic'
      )
  ) <> 6 THEN
    RAISE EXCEPTION 'active-profile 2FA overload count drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
