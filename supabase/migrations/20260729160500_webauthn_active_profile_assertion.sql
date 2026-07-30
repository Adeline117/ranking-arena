-- Consume a verified WebAuthn assertion only for an active application
-- account. The credential CAS and lifecycle decision share one transaction;
-- browser JWTs can no longer inject or rewrite authentication credentials.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('user-profile-authority-migrations', 0)
);

DO $preflight$
DECLARE
  v_function pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.consume_webauthn_authentication_atomic(uuid,uuid,text,text,bigint,timestamptz,bigint)'
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
      RAISE EXCEPTION 'required WebAuthn assertion role is missing: %', v_role;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
    OR pg_catalog.to_regprocedure(
      'public.admit_verified_auth_profile_atomic(uuid,text)'
    ) IS NULL
  THEN
    RAISE EXCEPTION 'WebAuthn assertion prerequisites are missing';
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
    RAISE EXCEPTION 'WebAuthn assertion columns are incompatible';
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
    RAISE EXCEPTION 'WebAuthn assertion relation ownership is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.user_passkeys'::pg_catalog.regclass
      AND constraint_row.contype = 'p'
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.user_passkeys'::pg_catalog.regclass
            AND attribute.attname = 'id'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        )
      ]::smallint[]
  ) OR NOT EXISTS (
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
    RAISE EXCEPTION 'WebAuthn credential identity constraints are incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname = 'consume_webauthn_authentication_atomic'
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid) <>
        'p_user_id uuid, p_passkey_id uuid, p_credential_id text, p_expected_public_key text, p_expected_counter bigint, p_expected_last_used_at timestamp with time zone, p_new_counter bigint'
  ) THEN
    RAISE EXCEPTION 'unexpected WebAuthn authentication overload exists';
  END IF;

  IF v_function IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.proowner = pg_catalog.to_regrole('postgres')
      AND function_row.prosecdef
      AND pg_catalog.strpos(
        function_row.prosrc,
        '''account-recovery-admission:'' || p_user_id::text'
      ) > 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        'passkey.public_key IS DISTINCT FROM p_expected_public_key'
      ) > 0
  ) THEN
    RAISE EXCEPTION 'existing WebAuthn authentication function is unfamiliar';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.consume_webauthn_authentication_atomic(
  p_user_id uuid,
  p_passkey_id uuid,
  p_credential_id text,
  p_expected_public_key text,
  p_expected_counter bigint,
  p_expected_last_used_at timestamptz,
  p_new_counter bigint
)
RETURNS TABLE (
  status text,
  result_user_id uuid,
  result_passkey_id uuid,
  result_credential_id text,
  consumed_at timestamptz
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
  v_consumed_at timestamptz;
  v_now timestamptz;
  v_passkey public.user_passkeys%ROWTYPE;
  v_profile public.user_profiles%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_passkey_id IS NULL
    OR p_credential_id IS NULL
    OR p_credential_id = ''
    OR pg_catalog.length(p_credential_id) > 4096
    OR p_expected_public_key IS NULL
    OR p_expected_public_key = ''
    OR pg_catalog.length(p_expected_public_key) > 65536
    OR p_expected_counter IS NULL
    OR p_expected_counter < 0
    OR p_new_counter IS NULL
    OR p_new_counter < 0
  THEN
    RAISE EXCEPTION 'invalid WebAuthn authentication input'
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
      NULL::text,
      NULL::timestamptz;
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
      NULL::text,
      NULL::timestamptz;
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
      NULL::text,
      NULL::timestamptz;
    RETURN;
  END IF;

  SELECT passkey.*
  INTO v_passkey
  FROM public.user_passkeys AS passkey
  WHERE passkey.id = p_passkey_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_passkey.user_id IS DISTINCT FROM p_user_id
    OR v_passkey.credential_id IS DISTINCT FROM p_credential_id
    OR v_passkey.public_key IS DISTINCT FROM p_expected_public_key
    OR v_passkey.counter IS DISTINCT FROM p_expected_counter
    OR v_passkey.last_used_at IS DISTINCT FROM p_expected_last_used_at
    OR (
      p_expected_counter > 0
      AND p_new_counter <= p_expected_counter
    )
    OR (
      v_passkey.last_used_at IS NOT NULL
      AND NOT pg_catalog.isfinite(v_passkey.last_used_at)
    )
  THEN
    RETURN QUERY SELECT
      'conflict'::text,
      NULL::uuid,
      NULL::uuid,
      NULL::text,
      NULL::timestamptz;
    RETURN;
  END IF;

  -- last_used_at is also the CAS generation for counterless authenticators.
  -- Advance it by at least one PostgreSQL timestamp quantum even if two calls
  -- land in the same clock microsecond.
  v_consumed_at := pg_catalog.clock_timestamp();
  IF v_passkey.last_used_at IS NOT NULL
    AND v_consumed_at <= v_passkey.last_used_at
  THEN
    v_consumed_at := v_passkey.last_used_at + interval '1 microsecond';
  END IF;

  UPDATE public.user_passkeys AS passkey
  SET counter = p_new_counter,
      last_used_at = v_consumed_at
  WHERE passkey.id = p_passkey_id
    AND passkey.user_id = p_user_id
    AND passkey.credential_id = p_credential_id
    AND passkey.public_key = p_expected_public_key
    AND passkey.counter = p_expected_counter
    AND passkey.last_used_at IS NOT DISTINCT FROM p_expected_last_used_at;
  GET DIAGNOSTICS v_affected_count = ROW_COUNT;

  IF v_affected_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'WebAuthn assertion lost its locked credential'
      USING ERRCODE = '40001';
  END IF;

  RETURN QUERY SELECT
    'consumed'::text,
    p_user_id,
    p_passkey_id,
    p_credential_id,
    v_consumed_at;
END
$function$;

ALTER FUNCTION public.consume_webauthn_authentication_atomic(
  uuid,
  uuid,
  text,
  text,
  bigint,
  timestamptz,
  bigint
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.consume_webauthn_authentication_atomic(
  uuid,
  uuid,
  text,
  text,
  bigint,
  timestamptz,
  bigint
) FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.consume_webauthn_authentication_atomic(
  uuid,
  uuid,
  text,
  text,
  bigint,
  timestamptz,
  bigint
) TO service_role;

-- Every WebAuthn write is implemented by a server verification route. The
-- original table-level grants let a browser JWT bypass attestation and inject
-- an arbitrary public key as a durable passwordless login credential.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER
  ON TABLE public.user_passkeys
  FROM PUBLIC, anon, authenticated, authenticator;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.user_passkeys
  TO service_role;

COMMENT ON FUNCTION public.consume_webauthn_authentication_atomic(
  uuid,
  uuid,
  text,
  text,
  bigint,
  timestamptz,
  bigint
) IS 'Consumes one verified WebAuthn assertion for an active account with exact credential and counterless CAS binding.';

DO $postflight$
DECLARE
  v_anon oid := pg_catalog.to_regrole('anon');
  v_authenticated oid := pg_catalog.to_regrole('authenticated');
  v_authenticator oid := pg_catalog.to_regrole('authenticator');
  v_function pg_catalog.regprocedure :=
    'public.consume_webauthn_authentication_atomic(uuid,uuid,text,text,bigint,timestamptz,bigint)'::pg_catalog.regprocedure;
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
    OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') = 0
    OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') = 0
    OR pg_catalog.strpos(v_source, 'FROM public.user_passkeys AS passkey') = 0
    OR pg_catalog.strpos(v_source, 'passkey.public_key = p_expected_public_key') = 0
    OR pg_catalog.strpos(
      v_source,
      'passkey.last_used_at IS NOT DISTINCT FROM p_expected_last_used_at'
    ) = 0
    OR pg_catalog.strpos(v_source, 'SET counter = p_new_counter') = 0
    OR pg_catalog.strpos(
      v_source,
      '''account-recovery-admission:'' || p_user_id::text'
    ) > pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user')
    OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') >
      pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile')
    OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') >
      pg_catalog.strpos(v_source, 'FROM public.user_passkeys AS passkey')
  THEN
    RAISE EXCEPTION 'WebAuthn authentication source drifted';
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
    RAISE EXCEPTION 'WebAuthn authentication ACL drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.aclexplode(
      COALESCE(
        (
          SELECT relation.relacl
          FROM pg_catalog.pg_class AS relation
          WHERE relation.oid = 'public.user_passkeys'::pg_catalog.regclass
        ),
        pg_catalog.acldefault(
          'r',
          (
            SELECT relation.relowner
            FROM pg_catalog.pg_class AS relation
            WHERE relation.oid = 'public.user_passkeys'::pg_catalog.regclass
          )
        )
      )
    ) AS privilege
    WHERE privilege.grantee IN (
        0,
        v_anon,
        v_authenticated,
        v_authenticator
      )
      AND privilege.privilege_type IN (
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'TRIGGER'
      )
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.user_passkeys', 'SELECT,INSERT,UPDATE,DELETE'
  ) THEN
    RAISE EXCEPTION 'WebAuthn credential table authority drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname = 'consume_webauthn_authentication_atomic'
  ) <> 1 THEN
    RAISE EXCEPTION 'WebAuthn authentication overload count drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
