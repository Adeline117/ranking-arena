-- Make every 2FA credential transition a single, user-bound transaction.
--
-- The expand migration deliberately leaves service_role's legacy table grants
-- in place until the application is cut over. Browser roles lose credential
-- mutation access immediately; the canonical RPCs are service-only.

BEGIN;

SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'public.two-factor-credentials:atomic-authority:v1',
    0
  )
);

DO $preflight$
DECLARE
  v_auth_users pg_catalog.regclass :=
    pg_catalog.to_regclass('auth.users');
  v_profiles pg_catalog.regclass :=
    pg_catalog.to_regclass('public.user_profiles');
  v_backup_codes pg_catalog.regclass :=
    pg_catalog.to_regclass('public.backup_codes');
  v_secrets pg_catalog.regclass :=
    pg_catalog.to_regclass('public.user_2fa_secrets');
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_invalid_columns text[];
BEGIN
  IF v_postgres_oid IS NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(
        ARRAY['anon', 'authenticated', 'service_role']::name[]
      ) AS required_role(role_name)
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.rolname = required_role.role_name
      WHERE role_row.oid IS NULL
    )
  THEN
    RAISE EXCEPTION 'required Supabase roles are missing';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure('auth.role()')
      AND function_row.prorettype = 'text'::pg_catalog.regtype
  ) THEN
    RAISE EXCEPTION 'auth.role() returning text is required';
  END IF;

  IF v_auth_users IS NULL
    OR v_profiles IS NULL
    OR v_backup_codes IS NULL
  THEN
    RAISE EXCEPTION
      'auth.users, public.user_profiles, and public.backup_codes are required';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation_row
    WHERE relation_row.oid IN (
      v_auth_users,
      v_profiles,
      v_backup_codes
    )
      AND (
        relation_row.relkind <> 'r'
        OR relation_row.relpersistence <> 'p'
        OR relation_row.relispartition
        OR relation_row.relowner <> v_postgres_oid
      )
  ) OR (
    v_secrets IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation_row
      WHERE relation_row.oid = v_secrets
        AND (
          relation_row.relkind <> 'r'
          OR relation_row.relpersistence <> 'p'
          OR relation_row.relispartition
          OR relation_row.relowner <> v_postgres_oid
        )
    )
  ) THEN
    RAISE EXCEPTION
      '2FA authority requires ordinary permanent postgres-owned tables';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance_row
    WHERE inheritance_row.inhrelid IN (
      v_auth_users,
      v_profiles,
      v_backup_codes,
      v_secrets
    )
       OR inheritance_row.inhparent IN (
         v_auth_users,
         v_profiles,
         v_backup_codes,
         v_secrets
       )
  ) THEN
    RAISE EXCEPTION '2FA authority tables must not use inheritance';
  END IF;

  SELECT pg_catalog.array_agg(
    pg_catalog.format(
      '%I.%I (expected %s%s)',
      required_column.schema_name || '.' || required_column.table_name,
      required_column.column_name,
      required_column.type_name,
      CASE
        WHEN required_column.required_not_null THEN ' NOT NULL'
        ELSE ''
      END
    )
    ORDER BY required_column.ordinality
  )
  INTO v_invalid_columns
  FROM (
    VALUES
      (1, 'auth', 'users', 'id', 'uuid', true),
      (2, 'public', 'user_profiles', 'id', 'uuid', true),
      (3, 'public', 'user_profiles', 'totp_enabled', 'boolean', false),
      (4, 'public', 'backup_codes', 'id', 'uuid', true),
      (5, 'public', 'backup_codes', 'user_id', 'uuid', false),
      (6, 'public', 'backup_codes', 'code_hash', 'text', true),
      (7, 'public', 'backup_codes', 'used', 'boolean', false),
      (8, 'public', 'backup_codes', 'used_at', 'timestamp with time zone', false)
  ) AS required_column(
    ordinality,
    schema_name,
    table_name,
    column_name,
    type_name,
    required_not_null
  )
  LEFT JOIN pg_catalog.pg_attribute AS attribute_row
    ON attribute_row.attrelid = pg_catalog.to_regclass(
      required_column.schema_name || '.' || required_column.table_name
    )
   AND attribute_row.attname = required_column.column_name
   AND attribute_row.attnum > 0
   AND NOT attribute_row.attisdropped
  WHERE attribute_row.attname IS NULL
     OR pg_catalog.format_type(
          attribute_row.atttypid,
          attribute_row.atttypmod
        ) <> required_column.type_name
     OR (
       required_column.required_not_null
       AND NOT attribute_row.attnotnull
     );

  IF v_invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION
      '2FA authority columns are missing or incompatible: %',
      v_invalid_columns;
  END IF;

  IF v_secrets IS NOT NULL AND EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('user_id', 'uuid', true),
        ('totp_secret', 'text', false),
        ('created_at', 'timestamp with time zone', false),
        ('updated_at', 'timestamp with time zone', false)
    ) AS required_column(column_name, type_name, required_not_null)
    LEFT JOIN pg_catalog.pg_attribute AS attribute_row
      ON attribute_row.attrelid = v_secrets
     AND attribute_row.attname = required_column.column_name
     AND attribute_row.attnum > 0
     AND NOT attribute_row.attisdropped
    WHERE attribute_row.attname IS NULL
       OR pg_catalog.format_type(
            attribute_row.atttypid,
            attribute_row.atttypmod
          ) <> required_column.type_name
       OR (
         required_column.required_not_null
         AND NOT attribute_row.attnotnull
       )
  ) THEN
    RAISE EXCEPTION
      'public.user_2fa_secrets has an incompatible shape';
  END IF;

  IF v_secrets IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = v_secrets
      AND index_row.indisprimary
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NULL
      AND index_row.indnkeyatts = 1
      AND index_row.indnatts = 1
      AND (
        SELECT attribute_row.attname
        FROM pg_catalog.pg_attribute AS attribute_row
        WHERE attribute_row.attrelid = index_row.indrelid
          AND attribute_row.attnum = index_row.indkey[0]
      ) = 'user_id'
  ) THEN
    RAISE EXCEPTION
      'public.user_2fa_secrets requires user_id as its exact primary key';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname IN (
        'read_two_factor_enrollment_secret',
        'stage_two_factor_enrollment_secret_atomic',
        'enable_two_factor_credentials_atomic',
        'rotate_two_factor_backup_codes_atomic',
        'disable_two_factor_credentials_atomic'
      )
      AND (
        (
          function_row.proname = 'read_two_factor_enrollment_secret'
          AND pg_catalog.pg_get_function_identity_arguments(function_row.oid)
            <> 'p_user_id uuid'
        )
        OR (
          function_row.proname = 'stage_two_factor_enrollment_secret_atomic'
          AND pg_catalog.pg_get_function_identity_arguments(function_row.oid)
            <> 'p_user_id uuid, p_totp_secret text'
        )
        OR (
          function_row.proname = 'enable_two_factor_credentials_atomic'
          AND pg_catalog.pg_get_function_identity_arguments(function_row.oid)
            <> 'p_user_id uuid, p_expected_totp_secret text, p_code_hashes text[]'
        )
        OR (
          function_row.proname = 'rotate_two_factor_backup_codes_atomic'
          AND pg_catalog.pg_get_function_identity_arguments(function_row.oid)
            <> 'p_user_id uuid, p_code_hashes text[]'
        )
        OR (
          function_row.proname = 'disable_two_factor_credentials_atomic'
          AND pg_catalog.pg_get_function_identity_arguments(function_row.oid)
            <> 'p_user_id uuid'
        )
      )
  ) THEN
    RAISE EXCEPTION 'an incompatible 2FA authority overload exists';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.user_2fa_secrets (
  user_id uuid PRIMARY KEY
    REFERENCES auth.users(id)
    ON DELETE CASCADE,
  totp_secret text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.user_2fa_secrets OWNER TO postgres;
ALTER TABLE public.user_2fa_secrets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.user_2fa_secrets
  FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.backup_codes
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.read_two_factor_enrollment_secret(
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_enabled boolean;
  v_secret text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required for 2FA enrollment read';
  END IF;

  IF p_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_user');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM auth.users AS auth_user
    WHERE auth_user.id = p_user_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'user_not_found');
  END IF;

  SELECT COALESCE(profile.totp_enabled, false)
  INTO v_enabled
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'profile_not_found');
  END IF;

  IF v_enabled THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_enabled');
  END IF;

  SELECT secret_row.totp_secret
  INTO v_secret
  FROM public.user_2fa_secrets AS secret_row
  WHERE secret_row.user_id = p_user_id;

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
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required for 2FA enrollment staging';
  END IF;

  IF p_user_id IS NULL
    OR p_totp_secret IS NULL
    OR p_totp_secret !~ '^[A-Z2-7]{16,128}$'
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM auth_user.id
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_user_id
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'user_not_found');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'two-factor-credentials:' || p_user_id::text,
      0
    )
  );

  SELECT COALESCE(profile.totp_enabled, false)
  INTO v_enabled
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'profile_not_found');
  END IF;

  IF v_enabled THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_enabled');
  END IF;

  INSERT INTO public.user_2fa_secrets AS secret_row (
    user_id,
    totp_secret,
    created_at,
    updated_at
  )
  VALUES (
    p_user_id,
    p_totp_secret,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET
    totp_secret = EXCLUDED.totp_secret,
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
  v_enabled boolean;
  v_secret text;
  v_code_count integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required for atomic 2FA enablement';
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

  PERFORM auth_user.id
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_user_id
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'user_not_found');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'two-factor-credentials:' || p_user_id::text,
      0
    )
  );

  SELECT COALESCE(profile.totp_enabled, false)
  INTO v_enabled
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'profile_not_found');
  END IF;

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

  IF v_code_count <> 8 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '2FA backup code insertion cardinality drifted';
  END IF;

  UPDATE public.user_profiles AS profile
  SET totp_enabled = true
  WHERE profile.id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '2FA profile disappeared during enablement';
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
  v_enabled boolean;
  v_code_count integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required for atomic 2FA backup code rotation';
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

  PERFORM auth_user.id
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_user_id
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'user_not_found');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'two-factor-credentials:' || p_user_id::text,
      0
    )
  );

  SELECT COALESCE(profile.totp_enabled, false)
  INTO v_enabled
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'profile_not_found');
  END IF;

  IF NOT v_enabled THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_enabled');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_2fa_secrets AS secret_row
    WHERE secret_row.user_id = p_user_id
      AND secret_row.totp_secret ~ '^[A-Z2-7]{16,128}$'
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'credential_inconsistent'
    );
  END IF;

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

  IF v_code_count <> 8 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '2FA backup code rotation cardinality drifted';
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
  v_enabled boolean;
  v_secret_count integer;
  v_code_count integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required for atomic 2FA disablement';
  END IF;

  IF p_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_user');
  END IF;

  PERFORM auth_user.id
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_user_id
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'user_not_found');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'two-factor-credentials:' || p_user_id::text,
      0
    )
  );

  SELECT COALESCE(profile.totp_enabled, false)
  INTO v_enabled
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'profile_not_found');
  END IF;

  IF NOT v_enabled THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_enabled');
  END IF;

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
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = '2FA profile disappeared during disablement';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'disabled',
    'code_count', v_code_count,
    'secret_count', v_secret_count
  );
END
$function$;

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

REVOKE ALL ON FUNCTION public.read_two_factor_enrollment_secret(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.stage_two_factor_enrollment_secret_atomic(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enable_two_factor_credentials_atomic(uuid, text, text[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.rotate_two_factor_backup_codes_atomic(uuid, text[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.disable_two_factor_credentials_atomic(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

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

DO $postflight$
DECLARE
  v_function_name text;
  v_function pg_catalog.regprocedure;
BEGIN
  FOREACH v_function_name IN ARRAY ARRAY[
    'public.read_two_factor_enrollment_secret(uuid)',
    'public.stage_two_factor_enrollment_secret_atomic(uuid,text)',
    'public.enable_two_factor_credentials_atomic(uuid,text,text[])',
    'public.rotate_two_factor_backup_codes_atomic(uuid,text[])',
    'public.disable_two_factor_credentials_atomic(uuid)'
  ]::text[]
  LOOP
    v_function := pg_catalog.to_regprocedure(v_function_name);

    IF v_function IS NULL OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      JOIN pg_catalog.pg_roles AS owner_role
        ON owner_role.oid = function_row.proowner
      WHERE function_row.oid = v_function
        AND owner_role.rolname = 'postgres'
        AND function_row.prosecdef
        AND function_row.provolatile IN ('s', 'v')
        AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
        AND function_row.proconfig @> ARRAY[
          'search_path=pg_catalog, pg_temp',
          'row_security=off',
          'lock_timeout=5s'
        ]::text[]
    ) THEN
      RAISE EXCEPTION '2FA authority function is incompatible: %',
        v_function_name;
    END IF;

    IF NOT pg_catalog.has_function_privilege(
      'service_role',
      v_function,
      'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticated',
      v_function,
      'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'anon',
      v_function,
      'EXECUTE'
    ) THEN
      RAISE EXCEPTION '2FA authority function ACL drifted: %',
        v_function_name;
    END IF;
  END LOOP;

  IF pg_catalog.has_table_privilege(
    'authenticated',
    'public.backup_codes',
    'INSERT'
  ) OR pg_catalog.has_table_privilege(
    'authenticated',
    'public.backup_codes',
    'UPDATE'
  ) OR pg_catalog.has_table_privilege(
    'authenticated',
    'public.backup_codes',
    'DELETE'
  ) OR pg_catalog.has_table_privilege(
    'authenticated',
    'public.user_2fa_secrets',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'browser 2FA credential table authority remains open';
  END IF;
END
$postflight$;

COMMIT;
