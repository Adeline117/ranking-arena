-- WebAuthn registration and deletion are credential lifecycle mutations. Run
-- each under the same account lock and Auth/profile/credential lock order as
-- assertion consumption so a concurrent suspension has one durable outcome.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('user-profile-authority-migrations', 0)
);

DO $preflight$
DECLARE
  v_delete pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.delete_webauthn_credential_for_active_profile_atomic(uuid,uuid)'
  );
  v_register pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.register_webauthn_credential_for_active_profile_atomic(uuid,text,text,bigint,text[],text)'
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
      RAISE EXCEPTION 'required WebAuthn credential-mutation role is missing: %',
        v_role;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
    OR pg_catalog.to_regprocedure(
      'public.consume_webauthn_authentication_atomic(uuid,uuid,text,text,bigint,timestamptz,bigint)'
    ) IS NULL
  THEN
    RAISE EXCEPTION 'WebAuthn credential-mutation prerequisites are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('auth', 'users', 'id', 'uuid'::pg_catalog.regtype),
        ('public', 'user_profiles', 'id', 'uuid'::pg_catalog.regtype),
        ('public', 'user_profiles', 'banned_at', 'timestamptz'::pg_catalog.regtype),
        ('public', 'user_profiles', 'ban_expires_at', 'timestamptz'::pg_catalog.regtype),
        ('public', 'user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype),
        ('public', 'user_profiles', 'is_banned', 'boolean'::pg_catalog.regtype),
        ('public', 'user_passkeys', 'id', 'uuid'::pg_catalog.regtype),
        ('public', 'user_passkeys', 'user_id', 'uuid'::pg_catalog.regtype),
        ('public', 'user_passkeys', 'credential_id', 'text'::pg_catalog.regtype),
        ('public', 'user_passkeys', 'public_key', 'text'::pg_catalog.regtype),
        ('public', 'user_passkeys', 'counter', 'bigint'::pg_catalog.regtype),
        ('public', 'user_passkeys', 'transports', 'text[]'::pg_catalog.regtype),
        ('public', 'user_passkeys', 'device_name', 'text'::pg_catalog.regtype),
        ('public', 'user_passkeys', 'created_at', 'timestamptz'::pg_catalog.regtype),
        ('public', 'user_passkeys', 'last_used_at', 'timestamptz'::pg_catalog.regtype)
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
    RAISE EXCEPTION 'WebAuthn credential-mutation columns are incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('auth.users'::pg_catalog.regclass),
        ('public.user_profiles'::pg_catalog.regclass),
        ('public.user_passkeys'::pg_catalog.regclass)
    ) AS required_relation(relation_id)
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = required_relation.relation_id
    WHERE relation.relowner <> pg_catalog.to_regrole('postgres')
      OR relation.relkind NOT IN ('r', 'p')
  ) THEN
    RAISE EXCEPTION 'WebAuthn credential-mutation relation ownership is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.user_passkeys'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 1
      AND index_row.indnatts = 1
      AND pg_catalog.pg_get_indexdef(
        index_row.indexrelid,
        1,
        true
      ) = 'credential_id'
  ) THEN
    RAISE EXCEPTION 'WebAuthn credential identity constraint is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'register_webauthn_credential_for_active_profile_atomic',
        'delete_webauthn_credential_for_active_profile_atomic'
      )
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid) NOT IN (
        'p_user_id uuid, p_credential_id text, p_public_key text, p_counter bigint, p_transports text[], p_device_name text',
        'p_user_id uuid, p_passkey_id uuid'
      )
  ) THEN
    RAISE EXCEPTION 'unexpected WebAuthn credential-mutation overload exists';
  END IF;

  IF v_register IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_register
      AND function_row.proowner = pg_catalog.to_regrole('postgres')
      AND function_row.prosecdef
      AND pg_catalog.strpos(
        function_row.prosrc,
        '''webauthn-credential:'' || p_credential_id'
      ) > 0
  ) THEN
    RAISE EXCEPTION 'existing WebAuthn registration function is unfamiliar';
  END IF;

  IF v_delete IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_delete
      AND function_row.proowner = pg_catalog.to_regrole('postgres')
      AND function_row.prosecdef
      AND pg_catalog.strpos(
        function_row.prosrc,
        'WHERE passkey.id = p_passkey_id'
      ) > 0
  ) THEN
    RAISE EXCEPTION 'existing WebAuthn deletion function is unfamiliar';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.register_webauthn_credential_for_active_profile_atomic(
  p_user_id uuid,
  p_credential_id text,
  p_public_key text,
  p_counter bigint,
  p_transports text[],
  p_device_name text
)
RETURNS TABLE (
  status text,
  result_user_id uuid,
  result_passkey_id uuid,
  result_credential_id text
)
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
  v_passkey_id uuid := pg_catalog.gen_random_uuid();
  v_profile public.user_profiles%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_credential_id IS NULL
    OR p_credential_id = ''
    OR pg_catalog.length(p_credential_id) > 4096
    OR p_public_key IS NULL
    OR p_public_key = ''
    OR pg_catalog.length(p_public_key) > 65536
    OR p_counter IS NULL
    OR p_counter < 0
    OR (
      p_device_name IS NOT NULL
      AND (
        p_device_name = ''
        OR p_device_name IS DISTINCT FROM pg_catalog.btrim(p_device_name)
        OR pg_catalog.length(p_device_name) > 60
      )
    )
    OR pg_catalog.cardinality(p_transports) > 16
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(p_transports) AS transport(value)
      WHERE transport.value IS NULL
        OR transport.value = ''
        OR pg_catalog.length(transport.value) > 64
    )
  THEN
    RAISE EXCEPTION 'invalid WebAuthn registration input'
      USING ERRCODE = '22023';
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
    RETURN QUERY SELECT
      'missing'::text,
      NULL::uuid,
      NULL::uuid,
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
      NULL::uuid,
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
      NULL::uuid,
      NULL::text;
    RETURN;
  END IF;

  -- Different accounts can register concurrently without taking each other's
  -- subject locks. Serialize the globally unique credential identity only
  -- after each call owns its Auth/profile locks.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'webauthn-credential:' || p_credential_id,
      0
    )
  );

  PERFORM 1
  FROM public.user_passkeys AS passkey
  WHERE passkey.credential_id = p_credential_id
  FOR KEY SHARE;
  IF FOUND THEN
    RETURN QUERY SELECT
      'conflict'::text,
      NULL::uuid,
      NULL::uuid,
      NULL::text;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.user_passkeys (
      id,
      user_id,
      credential_id,
      public_key,
      counter,
      transports,
      device_name,
      created_at,
      last_used_at
    ) VALUES (
      v_passkey_id,
      p_user_id,
      p_credential_id,
      p_public_key,
      p_counter,
      p_transports,
      p_device_name,
      v_now,
      NULL
    );
  EXCEPTION
    WHEN unique_violation THEN
      RETURN QUERY SELECT
        'conflict'::text,
        NULL::uuid,
        NULL::uuid,
        NULL::text;
      RETURN;
  END;

  RETURN QUERY SELECT
    'registered'::text,
    p_user_id,
    v_passkey_id,
    p_credential_id;
END
$function$;

CREATE OR REPLACE FUNCTION public.delete_webauthn_credential_for_active_profile_atomic(
  p_user_id uuid,
  p_passkey_id uuid
)
RETURNS TABLE (
  status text,
  result_user_id uuid,
  result_passkey_id uuid
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
  v_passkey public.user_passkeys%ROWTYPE;
  v_profile public.user_profiles%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_passkey_id IS NULL THEN
    RAISE EXCEPTION 'invalid WebAuthn deletion input'
      USING ERRCODE = '22023';
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
    RETURN QUERY SELECT 'missing'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  SELECT profile.*
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'missing'::text, NULL::uuid, NULL::uuid;
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
    RETURN QUERY SELECT 'suspended'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  SELECT passkey.*
  INTO v_passkey
  FROM public.user_passkeys AS passkey
  WHERE passkey.id = p_passkey_id
  FOR UPDATE;

  IF NOT FOUND OR v_passkey.user_id IS DISTINCT FROM p_user_id THEN
    RETURN QUERY SELECT
      'not_found'::text,
      p_user_id,
      p_passkey_id;
    RETURN;
  END IF;

  DELETE FROM public.user_passkeys AS passkey
  WHERE passkey.id = p_passkey_id
    AND passkey.user_id = p_user_id;
  GET DIAGNOSTICS v_affected_count = ROW_COUNT;

  IF v_affected_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'WebAuthn deletion lost its locked credential'
      USING ERRCODE = '40001';
  END IF;

  RETURN QUERY SELECT
    'deleted'::text,
    p_user_id,
    p_passkey_id;
END
$function$;

ALTER FUNCTION public.register_webauthn_credential_for_active_profile_atomic(
  uuid,
  text,
  text,
  bigint,
  text[],
  text
) OWNER TO postgres;
ALTER FUNCTION public.delete_webauthn_credential_for_active_profile_atomic(
  uuid,
  uuid
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.register_webauthn_credential_for_active_profile_atomic(
  uuid,
  text,
  text,
  bigint,
  text[],
  text
) FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.delete_webauthn_credential_for_active_profile_atomic(
  uuid,
  uuid
) FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.register_webauthn_credential_for_active_profile_atomic(
  uuid,
  text,
  text,
  bigint,
  text[],
  text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_webauthn_credential_for_active_profile_atomic(
  uuid,
  uuid
) TO service_role;

COMMENT ON FUNCTION public.register_webauthn_credential_for_active_profile_atomic(
  uuid,
  text,
  text,
  bigint,
  text[],
  text
) IS 'Registers one server-verified WebAuthn credential for an active account under lifecycle and credential locks.';
COMMENT ON FUNCTION public.delete_webauthn_credential_for_active_profile_atomic(
  uuid,
  uuid
) IS 'Deletes one owned WebAuthn credential for an active account under lifecycle and credential locks.';

DO $postflight$
DECLARE
  v_delete pg_catalog.regprocedure :=
    'public.delete_webauthn_credential_for_active_profile_atomic(uuid,uuid)'::pg_catalog.regprocedure;
  v_function pg_catalog.regprocedure;
  v_register pg_catalog.regprocedure :=
    'public.register_webauthn_credential_for_active_profile_atomic(uuid,text,text,bigint,text[],text)'::pg_catalog.regprocedure;
  v_service_role oid := pg_catalog.to_regrole('service_role');
  v_source text;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[v_register, v_delete]::pg_catalog.regprocedure[]
  LOOP
    IF NOT EXISTS (
      SELECT 1
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
          ]::text[]
    ) THEN
      RAISE EXCEPTION 'WebAuthn credential-mutation properties drifted: %',
        v_function;
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
      RAISE EXCEPTION 'WebAuthn credential-mutation ACL drifted: %',
        v_function;
    END IF;
  END LOOP;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_register;

  IF pg_catalog.strpos(
      v_source,
      '''account-recovery-admission:'' || p_user_id::text'
    ) = 0
    OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') = 0
    OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') = 0
    OR pg_catalog.strpos(
      v_source,
      '''webauthn-credential:'' || p_credential_id'
    ) = 0
    OR pg_catalog.strpos(v_source, 'INSERT INTO public.user_passkeys') = 0
    OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') >
      pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile')
    OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') >
      pg_catalog.strpos(
        v_source,
        '''webauthn-credential:'' || p_credential_id'
      )
  THEN
    RAISE EXCEPTION 'WebAuthn registration source drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_delete;

  IF pg_catalog.strpos(
      v_source,
      '''account-recovery-admission:'' || p_user_id::text'
    ) = 0
    OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') = 0
    OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') = 0
    OR pg_catalog.strpos(v_source, 'FROM public.user_passkeys AS passkey') = 0
    OR pg_catalog.strpos(v_source, 'DELETE FROM public.user_passkeys AS passkey') = 0
    OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') >
      pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile')
    OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') >
      pg_catalog.strpos(v_source, 'FROM public.user_passkeys AS passkey')
  THEN
    RAISE EXCEPTION 'WebAuthn deletion source drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'register_webauthn_credential_for_active_profile_atomic',
        'delete_webauthn_credential_for_active_profile_atomic'
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'WebAuthn credential-mutation overload count drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
