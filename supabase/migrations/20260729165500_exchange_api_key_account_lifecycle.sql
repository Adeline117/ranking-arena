-- Fence API-key connection writes and synchronous exchange reads with the
-- canonical account lifecycle authority.  Validation and exchange requests
-- happen outside PostgreSQL, so every write/result acknowledgement must prove
-- that the account and credential generation are still current.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'public.exchange-api-key-account-lifecycle:v1',
    0
  )
);

DO $preflight$
DECLARE
  v_missing_columns text[];
  v_function record;
BEGIN
  IF pg_catalog.to_regprocedure(
       'public.lock_trader_claim_principals_internal(uuid[],boolean)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'canonical account lifecycle lock must exist before API-key fencing';
  END IF;

  IF pg_catalog.to_regclass('public.user_exchange_connections') IS NULL
     OR pg_catalog.to_regclass('public.trader_authorizations') IS NULL THEN
    RAISE EXCEPTION
      'exchange connection and trader authorization tables must exist';
  END IF;

  SELECT pg_catalog.array_agg(
    required_column.relation_name || '.' || required_column.column_name
    ORDER BY required_column.relation_name, required_column.column_name
  )
  INTO v_missing_columns
  FROM (
    VALUES
      ('user_exchange_connections', 'id', 'uuid'::pg_catalog.regtype),
      ('user_exchange_connections', 'user_id', 'uuid'::pg_catalog.regtype),
      ('user_exchange_connections', 'exchange', 'text'::pg_catalog.regtype),
      ('user_exchange_connections', 'api_key_encrypted', 'text'::pg_catalog.regtype),
      ('user_exchange_connections', 'api_secret_encrypted', 'text'::pg_catalog.regtype),
      ('user_exchange_connections', 'passphrase_encrypted', 'text'::pg_catalog.regtype),
      ('user_exchange_connections', 'exchange_user_id', 'text'::pg_catalog.regtype),
      ('user_exchange_connections', 'access_token_encrypted', 'text'::pg_catalog.regtype),
      ('user_exchange_connections', 'refresh_token_encrypted', 'text'::pg_catalog.regtype),
      ('user_exchange_connections', 'expires_at', 'timestamptz'::pg_catalog.regtype),
      ('user_exchange_connections', 'is_active', 'boolean'::pg_catalog.regtype),
      ('user_exchange_connections', 'verified_uid', 'text'::pg_catalog.regtype),
      ('user_exchange_connections', 'last_verified_at', 'timestamptz'::pg_catalog.regtype),
      ('user_exchange_connections', 'scope_permissions', 'jsonb'::pg_catalog.regtype),
      ('user_exchange_connections', 'last_sync_at', 'timestamptz'::pg_catalog.regtype),
      ('user_exchange_connections', 'last_sync_status', 'text'::pg_catalog.regtype),
      ('user_exchange_connections', 'last_sync_error', 'text'::pg_catalog.regtype),
      ('trader_authorizations', 'id', 'uuid'::pg_catalog.regtype),
      ('trader_authorizations', 'user_id', 'uuid'::pg_catalog.regtype),
      ('trader_authorizations', 'platform', 'text'::pg_catalog.regtype),
      ('trader_authorizations', 'trader_id', 'text'::pg_catalog.regtype),
      ('trader_authorizations', 'encrypted_api_key', 'text'::pg_catalog.regtype),
      ('trader_authorizations', 'encrypted_api_secret', 'text'::pg_catalog.regtype),
      ('trader_authorizations', 'encrypted_passphrase', 'text'::pg_catalog.regtype),
      ('trader_authorizations', 'permissions', 'jsonb'::pg_catalog.regtype),
      ('trader_authorizations', 'status', 'text'::pg_catalog.regtype),
      ('trader_authorizations', 'read_only_verified_at', 'timestamptz'::pg_catalog.regtype),
      ('trader_authorizations', 'authorization_generation', 'bigint'::pg_catalog.regtype)
  ) AS required_column(relation_name, column_name, type_oid)
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = pg_catalog.to_regclass(
         'public.' || required_column.relation_name
       )
   AND attribute.attname = required_column.column_name
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  WHERE attribute.attnum IS NULL
     OR attribute.atttypid <> required_column.type_oid;

  IF v_missing_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'exchange API-key lifecycle column contract drifted: %',
      v_missing_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
          'public.user_exchange_connections'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname
          ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_row.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['user_id', 'exchange']::name[]
  ) THEN
    RAISE EXCEPTION
      'exchange API-key lifecycle requires unique (user_id, exchange)';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
          'public.trader_authorizations'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname
          ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_row.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['user_id', 'platform', 'trader_id']::name[]
  ) THEN
    RAISE EXCEPTION
      'exchange API-key lifecycle requires unique authorization identity';
  END IF;

  FOR v_function IN
    SELECT *
    FROM (
      VALUES
        ('bump_exchange_connection_generation', ''),
        (
          'upsert_exchange_api_connection_without_lifecycle_internal',
          'p_user_id uuid, p_exchange text, p_api_key_encrypted text, p_api_secret_encrypted text, p_passphrase_encrypted text, p_verified_uid text, p_scope_permissions jsonb, p_verified_at timestamp with time zone'
        ),
        (
          'upsert_exchange_api_connection_for_active_profile_atomic',
          'p_user_id uuid, p_exchange text, p_api_key_encrypted text, p_api_secret_encrypted text, p_passphrase_encrypted text, p_verified_uid text, p_scope_permissions jsonb'
        ),
        (
          'bind_trader_authorization_for_active_profile_atomic',
          'p_user_id uuid, p_platform text, p_trader_id text, p_api_key_encrypted text, p_api_secret_encrypted text, p_passphrase_encrypted text, p_permissions jsonb, p_label text, p_sync_frequency text'
        ),
        (
          'claim_exchange_api_sync_atomic',
          'p_user_id uuid, p_exchange text'
        ),
        (
          'finish_exchange_api_sync_atomic',
          'p_user_id uuid, p_connection_id uuid, p_generation bigint, p_succeeded boolean, p_error text'
        )
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
      RAISE EXCEPTION
        'unexpected exchange API-key lifecycle overload exists: %',
        v_function.function_name;
    END IF;
  END LOOP;
END
$preflight$;

LOCK TABLE public.user_profiles IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.user_exchange_connections IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.trader_authorizations IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.user_exchange_connections
  ADD COLUMN IF NOT EXISTS connection_generation bigint NOT NULL DEFAULT 1;

ALTER TABLE public.user_exchange_connections
  ALTER COLUMN connection_generation SET DEFAULT 1,
  ALTER COLUMN connection_generation SET NOT NULL;

ALTER TABLE public.user_exchange_connections
  DROP CONSTRAINT IF EXISTS user_exchange_connections_generation_valid;
ALTER TABLE public.user_exchange_connections
  ADD CONSTRAINT user_exchange_connections_generation_valid
  CHECK (connection_generation > 0) NOT VALID;
ALTER TABLE public.user_exchange_connections
  VALIDATE CONSTRAINT user_exchange_connections_generation_valid;

CREATE OR REPLACE FUNCTION public.bump_exchange_connection_generation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_authority_changed boolean;
BEGIN
  IF TG_LEVEL IS DISTINCT FROM 'ROW'
     OR TG_WHEN IS DISTINCT FROM 'BEFORE'
     OR TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
     OR TG_TABLE_NAME IS DISTINCT FROM 'user_exchange_connections'
     OR TG_OP NOT IN ('INSERT', 'UPDATE')
  THEN
    RAISE EXCEPTION
      'exchange connection generation trigger is outside its contract'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.connection_generation := 1;
    RETURN NEW;
  END IF;

  v_authority_changed :=
    NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.exchange IS DISTINCT FROM OLD.exchange
    OR NEW.api_key_encrypted IS DISTINCT FROM OLD.api_key_encrypted
    OR NEW.api_secret_encrypted IS DISTINCT FROM OLD.api_secret_encrypted
    OR NEW.passphrase_encrypted IS DISTINCT FROM OLD.passphrase_encrypted
    OR NEW.exchange_user_id IS DISTINCT FROM OLD.exchange_user_id
    OR NEW.access_token_encrypted IS DISTINCT FROM OLD.access_token_encrypted
    OR NEW.refresh_token_encrypted IS DISTINCT FROM OLD.refresh_token_encrypted
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.is_active IS DISTINCT FROM OLD.is_active
    OR NEW.verified_uid IS DISTINCT FROM OLD.verified_uid
    OR NEW.last_verified_at IS DISTINCT FROM OLD.last_verified_at
    OR NEW.scope_permissions IS DISTINCT FROM OLD.scope_permissions;

  IF NOT v_authority_changed THEN
    NEW.connection_generation := OLD.connection_generation;
    RETURN NEW;
  END IF;

  IF OLD.connection_generation = 9223372036854775807 THEN
    -- Revocation must still be possible after impossible/corrupt exhaustion.
    -- No active authority may reuse the exhausted generation.
    IF NEW.is_active IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'exchange connection generation exhausted'
        USING ERRCODE = '54000';
    END IF;
    NEW.connection_generation := OLD.connection_generation;
    RETURN NEW;
  END IF;

  NEW.connection_generation := OLD.connection_generation + 1;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.bump_exchange_connection_generation()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.bump_exchange_connection_generation()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

DROP TRIGGER IF EXISTS aaa_bump_exchange_connection_generation
  ON public.user_exchange_connections;
CREATE TRIGGER aaa_bump_exchange_connection_generation
  BEFORE INSERT OR UPDATE ON public.user_exchange_connections
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_exchange_connection_generation();

-- This helper deliberately does not acquire lifecycle locks.  It is private
-- and may only be called by the public atomic authorities below after they
-- have locked Auth, profile, and account lifecycle state.
CREATE OR REPLACE FUNCTION
  public.upsert_exchange_api_connection_without_lifecycle_internal(
    p_user_id uuid,
    p_exchange text,
    p_api_key_encrypted text,
    p_api_secret_encrypted text,
    p_passphrase_encrypted text,
    p_verified_uid text,
    p_scope_permissions jsonb,
    p_verified_at timestamptz
  )
RETURNS public.user_exchange_connections
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_connection public.user_exchange_connections%ROWTYPE;
BEGIN
  IF p_user_id IS NULL
     OR p_exchange IS NULL
     OR p_exchange !~ '^[a-z0-9][a-z0-9_-]{0,31}$'
     OR p_exchange IS DISTINCT FROM pg_catalog.lower(pg_catalog.btrim(p_exchange))
     OR p_api_key_encrypted IS NULL
     OR p_api_key_encrypted !~ '^[0-9a-fA-F]{32}:[0-9a-fA-F]{32}:([0-9a-fA-F]{2})+$'
     OR pg_catalog.length(p_api_key_encrypted) > 32768
     OR p_api_secret_encrypted IS NULL
     OR p_api_secret_encrypted !~ '^[0-9a-fA-F]{32}:[0-9a-fA-F]{32}:([0-9a-fA-F]{2})+$'
     OR pg_catalog.length(p_api_secret_encrypted) > 32768
     OR (
       p_passphrase_encrypted IS NOT NULL
       AND (
         p_passphrase_encrypted !~
           '^[0-9a-fA-F]{32}:[0-9a-fA-F]{32}:([0-9a-fA-F]{2})+$'
         OR pg_catalog.length(p_passphrase_encrypted) > 32768
       )
     )
     OR ((p_verified_uid IS NULL) IS DISTINCT FROM
         (p_scope_permissions IS NULL))
     OR ((p_verified_uid IS NULL) IS DISTINCT FROM (p_verified_at IS NULL))
     OR (
       p_verified_uid IS NOT NULL
       AND (
         pg_catalog.length(pg_catalog.btrim(p_verified_uid)) NOT BETWEEN 1 AND 255
         OR pg_catalog.jsonb_typeof(p_scope_permissions) IS DISTINCT FROM 'array'
         OR pg_catalog.jsonb_array_length(p_scope_permissions) = 0
         OR pg_catalog.jsonb_array_length(p_scope_permissions) > 100
         OR EXISTS (
           SELECT 1
           FROM pg_catalog.jsonb_array_elements(p_scope_permissions)
             AS permission(value)
           WHERE pg_catalog.jsonb_typeof(permission.value) IS DISTINCT FROM 'string'
              OR pg_catalog.length(permission.value #>> '{}') NOT BETWEEN 1 AND 128
         )
       )
     )
  THEN
    RAISE EXCEPTION 'invalid API-key exchange connection input'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.user_exchange_connections AS connection (
    user_id,
    exchange,
    api_key_encrypted,
    api_secret_encrypted,
    passphrase_encrypted,
    exchange_user_id,
    access_token_encrypted,
    refresh_token_encrypted,
    expires_at,
    is_active,
    verified_uid,
    last_verified_at,
    scope_permissions,
    last_sync_at,
    last_sync_status,
    last_sync_error
  ) VALUES (
    p_user_id,
    p_exchange,
    p_api_key_encrypted,
    p_api_secret_encrypted,
    p_passphrase_encrypted,
    NULL,
    NULL,
    NULL,
    NULL,
    true,
    CASE WHEN p_verified_uid IS NULL
      THEN NULL ELSE pg_catalog.btrim(p_verified_uid) END,
    p_verified_at,
    p_scope_permissions,
    NULL,
    'pending',
    NULL
  )
  ON CONFLICT (user_id, exchange) DO UPDATE SET
    api_key_encrypted = EXCLUDED.api_key_encrypted,
    api_secret_encrypted = EXCLUDED.api_secret_encrypted,
    passphrase_encrypted = EXCLUDED.passphrase_encrypted,
    exchange_user_id = NULL,
    access_token_encrypted = NULL,
    refresh_token_encrypted = NULL,
    expires_at = NULL,
    is_active = true,
    verified_uid = EXCLUDED.verified_uid,
    last_verified_at = EXCLUDED.last_verified_at,
    scope_permissions = EXCLUDED.scope_permissions,
    last_sync_at = NULL,
    last_sync_status = 'pending',
    last_sync_error = NULL
  RETURNING connection.* INTO v_connection;

  RETURN v_connection;
END
$function$;

ALTER FUNCTION
  public.upsert_exchange_api_connection_without_lifecycle_internal(
    uuid,
    text,
    text,
    text,
    text,
    text,
    jsonb,
    timestamptz
  ) OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.upsert_exchange_api_connection_without_lifecycle_internal(
    uuid,
    text,
    text,
    text,
    text,
    text,
    jsonb,
    timestamptz
  ) FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION
  public.upsert_exchange_api_connection_for_active_profile_atomic(
    p_user_id uuid,
    p_exchange text,
    p_api_key_encrypted text,
    p_api_secret_encrypted text,
    p_passphrase_encrypted text,
    p_verified_uid text,
    p_scope_permissions jsonb
  )
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '20s'
AS $function$
DECLARE
  v_connection public.user_exchange_connections%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;

  IF p_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  BEGIN
    PERFORM public.lock_trader_claim_principals_internal(
      ARRAY[p_user_id]::uuid[],
      true
    );
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'missing_account');
    WHEN SQLSTATE '22023' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'suspended');
  END;

  v_now := pg_catalog.clock_timestamp();
  BEGIN
    v_connection :=
      public.upsert_exchange_api_connection_without_lifecycle_internal(
        p_user_id,
        p_exchange,
        p_api_key_encrypted,
        p_api_secret_encrypted,
        p_passphrase_encrypted,
        p_verified_uid,
        p_scope_permissions,
        CASE WHEN p_verified_uid IS NULL THEN NULL ELSE v_now END
      );
  EXCEPTION
    WHEN SQLSTATE '22023' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'saved',
    'user_id', v_connection.user_id,
    'exchange', v_connection.exchange,
    'connection_id', v_connection.id,
    'generation', v_connection.connection_generation,
    'verified', v_connection.verified_uid IS NOT NULL
  );
END
$function$;

CREATE OR REPLACE FUNCTION
  public.bind_trader_authorization_for_active_profile_atomic(
    p_user_id uuid,
    p_platform text,
    p_trader_id text,
    p_api_key_encrypted text,
    p_api_secret_encrypted text,
    p_passphrase_encrypted text,
    p_permissions jsonb,
    p_label text,
    p_sync_frequency text
  )
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '20s'
AS $function$
DECLARE
  v_platform text;
  v_connection_exchange text;
  v_connection public.user_exchange_connections%ROWTYPE;
  v_authorization public.trader_authorizations%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;

  v_platform := pg_catalog.lower(pg_catalog.btrim(p_platform));
  v_connection_exchange := pg_catalog.regexp_replace(
    v_platform,
    '_(futures|spot)$',
    ''
  );
  IF v_connection_exchange = 'gate' THEN
    v_connection_exchange := 'gateio';
  END IF;

  IF p_user_id IS NULL
     OR p_platform IS NULL
     OR v_platform !~ '^[a-z0-9][a-z0-9_-]{0,31}$'
     OR p_platform IS DISTINCT FROM v_platform
     OR p_trader_id IS NULL
     OR pg_catalog.length(pg_catalog.btrim(p_trader_id)) NOT BETWEEN 1 AND 255
     OR p_permissions IS NULL
     OR pg_catalog.jsonb_typeof(p_permissions) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(p_permissions) = 0
     OR pg_catalog.jsonb_array_length(p_permissions) > 100
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements(p_permissions) AS permission(value)
       WHERE pg_catalog.jsonb_typeof(permission.value) IS DISTINCT FROM 'string'
          OR pg_catalog.length(permission.value #>> '{}') NOT BETWEEN 1 AND 128
     )
     OR p_sync_frequency IS NULL
     OR p_sync_frequency NOT IN ('realtime', '5min', '15min', '1hour')
     OR (
       p_label IS NOT NULL
       AND pg_catalog.length(pg_catalog.btrim(p_label)) NOT BETWEEN 1 AND 255
     )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  BEGIN
    PERFORM public.lock_trader_claim_principals_internal(
      ARRAY[p_user_id]::uuid[],
      true
    );
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'missing_account');
    WHEN SQLSTATE '22023' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'suspended');
  END;

  v_now := pg_catalog.clock_timestamp();
  BEGIN
    v_connection :=
      public.upsert_exchange_api_connection_without_lifecycle_internal(
        p_user_id,
        v_connection_exchange,
        p_api_key_encrypted,
        p_api_secret_encrypted,
        p_passphrase_encrypted,
        pg_catalog.btrim(p_trader_id),
        p_permissions,
        v_now
      );
  EXCEPTION
    WHEN SQLSTATE '22023' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END;

  INSERT INTO public.trader_authorizations AS authorization_row (
    user_id,
    platform,
    trader_id,
    encrypted_api_key,
    encrypted_api_secret,
    encrypted_passphrase,
    permissions,
    read_only_verified_at,
    status,
    last_verified_at,
    verification_error,
    last_sync_at,
    last_sync_status,
    consecutive_failures,
    label,
    sync_frequency
  ) VALUES (
    p_user_id,
    v_platform,
    pg_catalog.btrim(p_trader_id),
    p_api_key_encrypted,
    p_api_secret_encrypted,
    p_passphrase_encrypted,
    p_permissions,
    v_now,
    'active',
    v_now,
    NULL,
    NULL,
    'pending',
    0,
    CASE WHEN p_label IS NULL THEN NULL ELSE pg_catalog.btrim(p_label) END,
    p_sync_frequency
  )
  ON CONFLICT (user_id, platform, trader_id) DO UPDATE SET
    encrypted_api_key = EXCLUDED.encrypted_api_key,
    encrypted_api_secret = EXCLUDED.encrypted_api_secret,
    encrypted_passphrase = EXCLUDED.encrypted_passphrase,
    permissions = EXCLUDED.permissions,
    read_only_verified_at = EXCLUDED.read_only_verified_at,
    status = 'active',
    last_verified_at = EXCLUDED.last_verified_at,
    verification_error = NULL,
    last_sync_at = NULL,
    last_sync_status = 'pending',
    consecutive_failures = 0,
    label = CASE
      WHEN p_label IS NULL THEN authorization_row.label
      ELSE EXCLUDED.label
    END,
    sync_frequency = EXCLUDED.sync_frequency
  RETURNING authorization_row.* INTO v_authorization;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'bound',
    'user_id', v_authorization.user_id,
    'platform', v_authorization.platform,
    'trader_id', v_authorization.trader_id,
    'connection_id', v_connection.id,
    'connection_generation', v_connection.connection_generation,
    'authorization_id', v_authorization.id,
    'authorization_generation', v_authorization.authorization_generation
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.claim_exchange_api_sync_atomic(
  p_user_id uuid,
  p_exchange text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '20s'
AS $function$
DECLARE
  v_connection public.user_exchange_connections%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;

  IF p_user_id IS NULL
     OR p_exchange IS NULL
     OR p_exchange !~ '^[a-z0-9][a-z0-9_-]{0,31}$'
     OR p_exchange IS DISTINCT FROM pg_catalog.lower(pg_catalog.btrim(p_exchange))
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  BEGIN
    PERFORM public.lock_trader_claim_principals_internal(
      ARRAY[p_user_id]::uuid[],
      true
    );
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'missing_account');
    WHEN SQLSTATE '22023' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'suspended');
  END;

  SELECT connection.* INTO v_connection
  FROM public.user_exchange_connections AS connection
  WHERE connection.user_id = p_user_id
    AND connection.exchange = p_exchange
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_connection.is_active IS DISTINCT FROM true THEN
    RETURN pg_catalog.jsonb_build_object('status', 'inactive');
  END IF;
  IF v_connection.api_key_encrypted = 'oauth'
     OR v_connection.api_secret_encrypted = 'oauth'
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'oauth_connection');
  END IF;
  IF pg_catalog.length(v_connection.api_key_encrypted) = 0
     OR pg_catalog.length(v_connection.api_secret_encrypted) = 0
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_credentials');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'claimed',
    'user_id', v_connection.user_id,
    'exchange', v_connection.exchange,
    'connection_id', v_connection.id,
    'generation', v_connection.connection_generation,
    'api_key_encrypted', v_connection.api_key_encrypted,
    'api_secret_encrypted', v_connection.api_secret_encrypted,
    'passphrase_encrypted', v_connection.passphrase_encrypted,
    -- Retain the historical Bitget fallback until every legacy connection is
    -- replaced. New API-key writes always clear this OAuth-only column.
    'legacy_access_token_encrypted', v_connection.access_token_encrypted
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.finish_exchange_api_sync_atomic(
  p_user_id uuid,
  p_connection_id uuid,
  p_generation bigint,
  p_succeeded boolean,
  p_error text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '20s'
AS $function$
DECLARE
  v_connection public.user_exchange_connections%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;

  IF p_user_id IS NULL
     OR p_connection_id IS NULL
     OR p_generation IS NULL
     OR p_generation <= 0
     OR p_succeeded IS NULL
     OR (
       p_succeeded
       AND p_error IS NOT NULL
     )
     OR (
       NOT p_succeeded
       AND (
         p_error IS NULL
         OR pg_catalog.length(pg_catalog.btrim(p_error)) NOT BETWEEN 1 AND 500
       )
     )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  BEGIN
    PERFORM public.lock_trader_claim_principals_internal(
      ARRAY[p_user_id]::uuid[],
      true
    );
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'missing_account');
    WHEN SQLSTATE '22023' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'suspended');
  END;

  SELECT connection.* INTO v_connection
  FROM public.user_exchange_connections AS connection
  WHERE connection.id = p_connection_id
    AND connection.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_connection.connection_generation IS DISTINCT FROM p_generation THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'superseded',
      'current_generation', v_connection.connection_generation
    );
  END IF;
  IF v_connection.is_active IS DISTINCT FROM true THEN
    RETURN pg_catalog.jsonb_build_object('status', 'inactive');
  END IF;
  IF v_connection.api_key_encrypted = 'oauth'
     OR v_connection.api_secret_encrypted = 'oauth'
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'superseded');
  END IF;

  v_now := pg_catalog.clock_timestamp();
  UPDATE public.user_exchange_connections AS connection
  SET last_sync_at = v_now,
      last_sync_status = CASE WHEN p_succeeded THEN 'success' ELSE 'error' END,
      last_sync_error = CASE
        WHEN p_succeeded THEN NULL
        ELSE pg_catalog.btrim(p_error)
      END
  WHERE connection.id = v_connection.id
    AND connection.user_id = p_user_id
    AND connection.connection_generation = p_generation
    AND connection.is_active = true
  RETURNING connection.* INTO STRICT v_connection;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'recorded',
    'user_id', v_connection.user_id,
    'connection_id', v_connection.id,
    'generation', v_connection.connection_generation,
    'sync_status', v_connection.last_sync_status,
    'synced_at', v_connection.last_sync_at
  );
END
$function$;

ALTER FUNCTION
  public.upsert_exchange_api_connection_for_active_profile_atomic(
    uuid,
    text,
    text,
    text,
    text,
    text,
    jsonb
  ) OWNER TO postgres;
ALTER FUNCTION
  public.bind_trader_authorization_for_active_profile_atomic(
    uuid,
    text,
    text,
    text,
    text,
    text,
    jsonb,
    text,
    text
  ) OWNER TO postgres;
ALTER FUNCTION public.claim_exchange_api_sync_atomic(uuid, text)
  OWNER TO postgres;
ALTER FUNCTION public.finish_exchange_api_sync_atomic(
  uuid,
  uuid,
  bigint,
  boolean,
  text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION
  public.upsert_exchange_api_connection_for_active_profile_atomic(
    uuid,
    text,
    text,
    text,
    text,
    text,
    jsonb
  ) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION
  public.bind_trader_authorization_for_active_profile_atomic(
    uuid,
    text,
    text,
    text,
    text,
    text,
    jsonb,
    text,
    text
  ) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.claim_exchange_api_sync_atomic(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.finish_exchange_api_sync_atomic(
  uuid,
  uuid,
  bigint,
  boolean,
  text
) FROM PUBLIC, anon, authenticated, service_role, authenticator;

GRANT EXECUTE ON FUNCTION
  public.upsert_exchange_api_connection_for_active_profile_atomic(
    uuid,
    text,
    text,
    text,
    text,
    text,
    jsonb
  ) TO service_role;
GRANT EXECUTE ON FUNCTION
  public.bind_trader_authorization_for_active_profile_atomic(
    uuid,
    text,
    text,
    text,
    text,
    text,
    jsonb,
    text,
    text
  ) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_exchange_api_sync_atomic(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_exchange_api_sync_atomic(
  uuid,
  uuid,
  bigint,
  boolean,
  text
) TO service_role;

COMMENT ON COLUMN public.user_exchange_connections.connection_generation IS
  'Monotonic fence bumped when connection identity, credentials, verification proof, expiry, or active status changes.';
COMMENT ON FUNCTION
  public.upsert_exchange_api_connection_for_active_profile_atomic(
    uuid,
    text,
    text,
    text,
    text,
    text,
    jsonb
  ) IS
  'Service-only API-key connection upsert under canonical active-account lifecycle locks.';
COMMENT ON FUNCTION
  public.bind_trader_authorization_for_active_profile_atomic(
    uuid,
    text,
    text,
    text,
    text,
    text,
    jsonb,
    text,
    text
  ) IS
  'Atomically stores verified API-key connection proof and matching trader authorization for an active account.';
COMMENT ON FUNCTION public.claim_exchange_api_sync_atomic(uuid, text) IS
  'Claims one active API-key credential generation after locking canonical account lifecycle state.';
COMMENT ON FUNCTION public.finish_exchange_api_sync_atomic(
  uuid,
  uuid,
  bigint,
  boolean,
  text
) IS
  'Records a synchronous exchange result only while its account and credential generation remain current.';

DO $postflight$
DECLARE
  v_function record;
  v_source text;
  v_role name;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
          'public.user_exchange_connections'::pg_catalog.regclass
      AND attribute.attname = 'connection_generation'
      AND attribute.atttypid = 'bigint'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'connection generation column postflight failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
          'public.user_exchange_connections'::pg_catalog.regclass
      AND trigger_row.tgname = 'aaa_bump_exchange_connection_generation'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgfoid =
          'public.bump_exchange_connection_generation()'::pg_catalog.regprocedure
  ) THEN
    RAISE EXCEPTION 'connection generation trigger postflight failed';
  END IF;

  FOR v_function IN
    SELECT *
    FROM (
      VALUES
        (
          'public.upsert_exchange_api_connection_for_active_profile_atomic(uuid,text,text,text,text,text,jsonb)',
          true
        ),
        (
          'public.bind_trader_authorization_for_active_profile_atomic(uuid,text,text,text,text,text,jsonb,text,text)',
          true
        ),
        ('public.claim_exchange_api_sync_atomic(uuid,text)', true),
        (
          'public.finish_exchange_api_sync_atomic(uuid,uuid,bigint,boolean,text)',
          true
        ),
        (
          'public.upsert_exchange_api_connection_without_lifecycle_internal(uuid,text,text,text,text,text,jsonb,timestamptz)',
          false
        )
    ) AS required(function_identity, service_executable)
  LOOP
    IF pg_catalog.to_regprocedure(v_function.function_identity) IS NULL THEN
      RAISE EXCEPTION 'exchange lifecycle function missing: %',
        v_function.function_identity;
    END IF;

    SELECT pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(v_function.function_identity)
    ) INTO v_source;

    IF v_function.service_executable
       AND pg_catalog.strpos(v_source, 'lock_trader_claim_principals_internal') = 0
    THEN
      RAISE EXCEPTION 'exchange lifecycle authority omitted account lock: %',
        v_function.function_identity;
    END IF;

    -- anon/authenticated inherit PUBLIC grants, so these checks also prove
    -- that the default PUBLIC EXECUTE privilege was removed.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
    LOOP
      IF pg_catalog.has_function_privilege(
        v_role,
        pg_catalog.to_regprocedure(v_function.function_identity),
        'EXECUTE'
      ) THEN
        RAISE EXCEPTION '% can execute %', v_role, v_function.function_identity;
      END IF;
    END LOOP;

    IF pg_catalog.has_function_privilege(
         'service_role',
         pg_catalog.to_regprocedure(v_function.function_identity),
         'EXECUTE'
       ) IS DISTINCT FROM v_function.service_executable
    THEN
      RAISE EXCEPTION 'service role privilege drift for %',
        v_function.function_identity;
    END IF;
  END LOOP;
END
$postflight$;

COMMIT;
