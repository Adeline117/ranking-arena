-- Exchange OAuth completion persists long-lived credentials. Bind state
-- consumption, active-account admission, and credential publication in one
-- transaction; serialize refresh leases with the same lifecycle boundary;
-- and quiesce every exchange connection when an account becomes inactive.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('exchange-oauth-account-lifecycle@1', 0)
);

DO $preflight$
DECLARE
  v_role text;
  v_postgres_oid oid := pg_catalog.to_regrole('postgres');
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'exchange OAuth account lifecycle requires PostgreSQL 17';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'postgres', 'anon', 'authenticated', 'service_role', 'authenticator'
  ]::text[]
  LOOP
    IF pg_catalog.to_regrole(v_role) IS NULL THEN
      RAISE EXCEPTION 'required exchange OAuth role is unavailable: %', v_role;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.oauth_states') IS NULL
     OR pg_catalog.to_regclass('public.user_exchange_connections') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.lock_trader_claim_principals_internal(uuid[],boolean)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.claim_exchange_oauth_state_atomic(uuid,text,text,integer)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.finish_exchange_oauth_state_claim_atomic(uuid,text,text,uuid,boolean)'
     ) IS NULL THEN
    RAISE EXCEPTION 'exchange OAuth lifecycle foundations are incomplete';
  END IF;

  IF (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure('auth.role()')
  ) <> 'text'::pg_catalog.regtype OR (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure(
      'public.lock_trader_claim_principals_internal(uuid[],boolean)'
    )
  ) <> 'void'::pg_catalog.regtype THEN
    RAISE EXCEPTION 'exchange OAuth lifecycle function signatures drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'auth.users'::pg_catalog.regclass,
      'public.user_profiles'::pg_catalog.regclass,
      'public.oauth_states'::pg_catalog.regclass,
      'public.user_exchange_connections'::pg_catalog.regclass
    )
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.user_profiles'::pg_catalog.regclass,
      'public.oauth_states'::pg_catalog.regclass,
      'public.user_exchange_connections'::pg_catalog.regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION 'exchange OAuth lifecycle requires canonical permanent relations';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('auth', 'users', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'user_profiles', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'user_profiles', 'banned_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'user_profiles', 'is_banned', 'boolean'::pg_catalog.regtype, true),
        ('public', 'user_profiles', 'ban_expires_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'oauth_states', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'oauth_states', 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'oauth_states', 'exchange', 'text'::pg_catalog.regtype, true),
        ('public', 'oauth_states', 'state', 'text'::pg_catalog.regtype, true),
        ('public', 'oauth_states', 'expires_at', 'timestamptz'::pg_catalog.regtype, true),
        ('public', 'oauth_states', 'claim_token', 'uuid'::pg_catalog.regtype, false),
        ('public', 'oauth_states', 'claim_expires_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'user_exchange_connections', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'user_exchange_connections', 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'user_exchange_connections', 'exchange', 'text'::pg_catalog.regtype, true),
        ('public', 'user_exchange_connections', 'api_key_encrypted', 'text'::pg_catalog.regtype, true),
        ('public', 'user_exchange_connections', 'api_secret_encrypted', 'text'::pg_catalog.regtype, true),
        ('public', 'user_exchange_connections', 'passphrase_encrypted', 'text'::pg_catalog.regtype, false),
        ('public', 'user_exchange_connections', 'verified_uid', 'text'::pg_catalog.regtype, false),
        ('public', 'user_exchange_connections', 'last_verified_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'user_exchange_connections', 'scope_permissions', 'jsonb'::pg_catalog.regtype, false),
        ('public', 'user_exchange_connections', 'is_active', 'boolean'::pg_catalog.regtype, false)
    ) AS required_column(
      schema_name,
      relation_name,
      column_name,
      type_oid,
      required_not_null
    )
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = pg_catalog.to_regclass(
        required_column.schema_name || '.' || required_column.relation_name
      )
     AND attribute.attname = required_column.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
       OR attribute.atttypid <> required_column.type_oid
       OR (required_column.required_not_null AND NOT attribute.attnotnull)
  ) THEN
    RAISE EXCEPTION 'exchange OAuth lifecycle column contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = 'public.oauth_states'::pg_catalog.regclass
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 3
      AND index_metadata.indnatts = 3
      AND (
        SELECT pg_catalog.array_agg(attribute.attname ORDER BY key_column.ordinality)
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['user_id', 'exchange', 'state']::name[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid =
      'public.user_exchange_connections'::pg_catalog.regclass
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 2
      AND index_metadata.indnatts = 2
      AND (
        SELECT pg_catalog.array_agg(attribute.attname ORDER BY key_column.ordinality)
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['user_id', 'exchange']::name[]
  ) THEN
    RAISE EXCEPTION 'exchange OAuth lifecycle unique identity contract drifted';
  END IF;
END
$preflight$;

LOCK TABLE public.user_profiles IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.oauth_states IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.user_exchange_connections IN SHARE ROW EXCLUSIVE MODE;

-- These OAuth columns existed only as out-of-band schema drift in some
-- stacks. Make them part of the replayable repository contract before the
-- transactional credential authority starts depending on them.
ALTER TABLE public.user_exchange_connections
  ADD COLUMN IF NOT EXISTS exchange_user_id text,
  ADD COLUMN IF NOT EXISTS access_token_encrypted text,
  ADD COLUMN IF NOT EXISTS refresh_token_encrypted text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_sync_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_sync_status text,
  ADD COLUMN IF NOT EXISTS last_sync_error text;

DO $oauth_column_contract$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('exchange_user_id', 'text'::pg_catalog.regtype),
        ('access_token_encrypted', 'text'::pg_catalog.regtype),
        ('refresh_token_encrypted', 'text'::pg_catalog.regtype),
        ('expires_at', 'timestamptz'::pg_catalog.regtype),
        ('last_sync_at', 'timestamptz'::pg_catalog.regtype),
        ('last_sync_status', 'text'::pg_catalog.regtype),
        ('last_sync_error', 'text'::pg_catalog.regtype)
    ) AS required_column(column_name, type_oid)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid =
        'public.user_exchange_connections'::pg_catalog.regclass
     AND attribute.attname = required_column.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
       OR attribute.atttypid <> required_column.type_oid
  ) THEN
    RAISE EXCEPTION 'exchange OAuth credential column contract drifted';
  END IF;
END
$oauth_column_contract$;

CREATE OR REPLACE FUNCTION public.quiesce_inactive_exchange_connections()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_user_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
BEGIN
  IF TG_OP = 'DELETE'
     OR NEW.deleted_at IS NOT NULL
     OR NEW.banned_at IS NOT NULL
     OR (
       COALESCE(NEW.is_banned, false)
       AND (
         NEW.ban_expires_at IS NULL
         OR NEW.ban_expires_at > pg_catalog.clock_timestamp()
       )
    ) THEN
    UPDATE public.user_exchange_connections AS connection
    SET is_active = false,
        last_sync_status = 'inactive',
        last_sync_error = 'Arena account inactive'
    WHERE connection.user_id = v_user_id
      AND connection.is_active IS DISTINCT FROM false;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.quiesce_inactive_exchange_connections()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.quiesce_inactive_exchange_connections()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

DROP TRIGGER IF EXISTS zzz_quiesce_inactive_exchange_connections
  ON public.user_profiles;
CREATE TRIGGER zzz_quiesce_inactive_exchange_connections
  AFTER UPDATE OF deleted_at, banned_at, is_banned, ban_expires_at
  ON public.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.quiesce_inactive_exchange_connections();

DROP TRIGGER IF EXISTS zzz_quiesce_deleted_profile_exchange_connections
  ON public.user_profiles;
CREATE TRIGGER zzz_quiesce_deleted_profile_exchange_connections
  AFTER DELETE ON public.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.quiesce_inactive_exchange_connections();

-- Converge credentials whose profile is absent or inactive at deploy.
UPDATE public.user_exchange_connections AS connection
SET is_active = false,
    last_sync_status = 'inactive',
    last_sync_error = 'Arena account inactive'
WHERE connection.is_active IS DISTINCT FROM false
  AND NOT EXISTS (
    SELECT 1
    FROM public.user_profiles AS profile
    WHERE profile.id = connection.user_id
      AND profile.deleted_at IS NULL
      AND profile.banned_at IS NULL
      AND (
        NOT COALESCE(profile.is_banned, false)
        OR (
          profile.ban_expires_at IS NOT NULL
          AND profile.ban_expires_at <= pg_catalog.clock_timestamp()
        )
      )
  );

CREATE OR REPLACE FUNCTION public.complete_exchange_oauth_callback_atomic(
  p_user_id uuid,
  p_exchange text,
  p_state text,
  p_state_id uuid,
  p_claim_token uuid,
  p_exchange_user_id text,
  p_access_token_encrypted text,
  p_refresh_token_encrypted text,
  p_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '20s'
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_state_id uuid;
  v_connection_id uuid;
  v_affected integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;

  IF p_user_id IS NULL
     OR p_state_id IS NULL
     OR p_claim_token IS NULL
     OR p_exchange IS NULL
     OR p_exchange !~ '^[a-z0-9][a-z0-9_-]{0,31}$'
     OR p_state IS NULL
     OR pg_catalog.length(p_state) < 32
     OR pg_catalog.length(p_state) > 512
     OR p_access_token_encrypted IS NULL
     OR p_access_token_encrypted !~ '^v2:[0-9a-f]{24}:[0-9a-f]{32}:([0-9a-f]{2})+$'
     OR pg_catalog.length(p_access_token_encrypted) > 16384
     OR (
       p_refresh_token_encrypted IS NOT NULL
       AND (
         p_refresh_token_encrypted !~
           '^v2:[0-9a-f]{24}:[0-9a-f]{32}:([0-9a-f]{2})+$'
         OR pg_catalog.length(p_refresh_token_encrypted) > 16384
       )
     )
     OR (
       p_exchange_user_id IS NOT NULL
       AND (
         pg_catalog.length(p_exchange_user_id) = 0
         OR pg_catalog.length(p_exchange_user_id) > 255
       )
     )
     THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'reason', 'INVALID');
  END IF;

  BEGIN
    PERFORM public.lock_trader_claim_principals_internal(
      ARRAY[p_user_id]::uuid[],
      true
    );
  EXCEPTION
    WHEN SQLSTATE 'P0002' OR SQLSTATE '22023' THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'ACTOR_UNAVAILABLE'
      );
  END;

  -- Lifecycle admission can wait behind a concurrent ban/delete. Never use
  -- the pre-wait timestamp to admit an OAuth state or token expiry.
  v_now := pg_catalog.clock_timestamp();
  IF p_expires_at IS NOT NULL
     AND (
       p_expires_at <= v_now
       OR p_expires_at > v_now + '366 days'::interval
     ) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'reason', 'INVALID');
  END IF;

  SELECT oauth_state.id INTO v_state_id
  FROM public.oauth_states AS oauth_state
  WHERE oauth_state.id = p_state_id
    AND oauth_state.user_id = p_user_id
    AND oauth_state.exchange = p_exchange
    AND oauth_state.state = p_state
    AND oauth_state.claim_token = p_claim_token
    AND oauth_state.expires_at > v_now
    AND oauth_state.claim_expires_at > v_now
  FOR UPDATE;

  IF v_state_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'STALE_CLAIM'
    );
  END IF;

  INSERT INTO public.user_exchange_connections AS connection (
    user_id,
    exchange,
    exchange_user_id,
    access_token_encrypted,
    refresh_token_encrypted,
    expires_at,
    is_active,
    last_sync_at,
    last_sync_status,
    last_sync_error,
    api_key_encrypted,
    api_secret_encrypted,
    passphrase_encrypted,
    verified_uid,
    last_verified_at,
    scope_permissions
  ) VALUES (
    p_user_id,
    p_exchange,
    p_exchange_user_id,
    p_access_token_encrypted,
    p_refresh_token_encrypted,
    p_expires_at,
    true,
    v_now,
    'success',
    NULL,
    'oauth',
    'oauth',
    NULL,
    NULL,
    NULL,
    NULL
  )
  ON CONFLICT (user_id, exchange) DO UPDATE SET
    exchange_user_id = EXCLUDED.exchange_user_id,
    access_token_encrypted = EXCLUDED.access_token_encrypted,
    refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
    expires_at = EXCLUDED.expires_at,
    is_active = true,
    last_sync_at = EXCLUDED.last_sync_at,
    last_sync_status = 'success',
    last_sync_error = NULL,
    api_key_encrypted = 'oauth',
    api_secret_encrypted = 'oauth',
    passphrase_encrypted = NULL,
    verified_uid = NULL,
    last_verified_at = NULL,
    scope_permissions = NULL
  RETURNING connection.id INTO v_connection_id;

  DELETE FROM public.oauth_states AS oauth_state
  WHERE oauth_state.id = v_state_id
    AND oauth_state.user_id = p_user_id
    AND oauth_state.exchange = p_exchange
    AND oauth_state.state = p_state
    AND oauth_state.claim_token = p_claim_token;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'OAuth state consumption lost its locked claim';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'status', 'connected',
    'user_id', p_user_id,
    'exchange', p_exchange,
    'state_id', v_state_id,
    'connection_id', v_connection_id
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.claim_exchange_oauth_refresh_atomic(
  p_user_id uuid,
  p_exchange text,
  p_connection_id uuid,
  p_expected_refresh_token_encrypted text,
  p_lease_refresh_token_encrypted text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
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
     OR p_connection_id IS NULL
     OR p_exchange IS NULL
     OR p_exchange !~ '^[a-z0-9][a-z0-9_-]{0,31}$'
     OR p_expected_refresh_token_encrypted IS NULL
     OR pg_catalog.length(p_expected_refresh_token_encrypted) = 0
     OR pg_catalog.length(p_expected_refresh_token_encrypted) > 32768
     OR p_lease_refresh_token_encrypted IS NULL
     OR p_lease_refresh_token_encrypted !~
       '^refresh-lease-v1:[0-9]{13}:[0-9a-f]{32}:[A-Za-z0-9_-]+$'
     OR pg_catalog.length(p_lease_refresh_token_encrypted) > 32768 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'reason', 'INVALID');
  END IF;

  BEGIN
    PERFORM public.lock_trader_claim_principals_internal(
      ARRAY[p_user_id]::uuid[],
      true
    );
  EXCEPTION
    WHEN SQLSTATE 'P0002' OR SQLSTATE '22023' THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'ACTOR_UNAVAILABLE'
      );
  END;

  SELECT connection.* INTO v_connection
  FROM public.user_exchange_connections AS connection
  WHERE connection.id = p_connection_id
    AND connection.user_id = p_user_id
    AND connection.exchange = p_exchange
  FOR UPDATE;

  IF v_connection.id IS NULL
     OR v_connection.is_active IS DISTINCT FROM true
     OR v_connection.refresh_token_encrypted IS DISTINCT FROM
       p_expected_refresh_token_encrypted THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'CONNECTION_CHANGED'
    );
  END IF;

  UPDATE public.user_exchange_connections AS connection
  SET refresh_token_encrypted = p_lease_refresh_token_encrypted
  WHERE connection.id = v_connection.id;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'status', 'claimed',
    'user_id', p_user_id,
    'exchange', p_exchange,
    'connection_id', v_connection.id,
    'refresh_token_encrypted', p_lease_refresh_token_encrypted
  );
END
$function$;

ALTER FUNCTION public.complete_exchange_oauth_callback_atomic(
  uuid,
  text,
  text,
  uuid,
  uuid,
  text,
  text,
  text,
  timestamptz
) OWNER TO postgres;
ALTER FUNCTION public.claim_exchange_oauth_refresh_atomic(
  uuid,
  text,
  uuid,
  text,
  text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.complete_exchange_oauth_callback_atomic(
  uuid,
  text,
  text,
  uuid,
  uuid,
  text,
  text,
  text,
  timestamptz
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.claim_exchange_oauth_refresh_atomic(
  uuid,
  text,
  uuid,
  text,
  text
) FROM PUBLIC, anon, authenticated, service_role, authenticator;

GRANT EXECUTE ON FUNCTION public.complete_exchange_oauth_callback_atomic(
  uuid,
  text,
  text,
  uuid,
  uuid,
  text,
  text,
  text,
  timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_exchange_oauth_refresh_atomic(
  uuid,
  text,
  uuid,
  text,
  text
) TO service_role;

COMMENT ON FUNCTION public.complete_exchange_oauth_callback_atomic(
  uuid,
  text,
  text,
  uuid,
  uuid,
  text,
  text,
  text,
  timestamptz
) IS 'Service-only active-account OAuth state consumption and exchange credential publication in one transaction.';
COMMENT ON FUNCTION public.claim_exchange_oauth_refresh_atomic(
  uuid,
  text,
  uuid,
  text,
  text
) IS 'Service-only active-account CAS claim of one exchange OAuth refresh-token generation.';

DO $postflight$
DECLARE
  v_callback pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.complete_exchange_oauth_callback_atomic(uuid,text,text,uuid,uuid,text,text,text,timestamp with time zone)'
  );
  v_refresh pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.claim_exchange_oauth_refresh_atomic(uuid,text,uuid,text,text)'
  );
  v_quiesce pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.quiesce_inactive_exchange_connections()'
  );
  v_postgres_oid oid := pg_catalog.to_regrole('postgres');
  v_role text;
  v_source text;
BEGIN
  IF v_callback IS NULL OR v_refresh IS NULL OR v_quiesce IS NULL THEN
    RAISE EXCEPTION 'exchange OAuth lifecycle functions are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_profiles'::pg_catalog.regclass
      AND trigger_row.tgname = 'zzz_quiesce_inactive_exchange_connections'
      AND trigger_row.tgfoid = v_quiesce::oid
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 17
      AND trigger_row.tgnargs = 0
      AND trigger_row.tgqual IS NULL
  ) THEN
    RAISE EXCEPTION 'exchange connection update quiescence trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_profiles'::pg_catalog.regclass
      AND trigger_row.tgname = 'zzz_quiesce_deleted_profile_exchange_connections'
      AND trigger_row.tgfoid = v_quiesce::oid
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 9
      AND trigger_row.tgnargs = 0
      AND trigger_row.tgqual IS NULL
  ) THEN
    RAISE EXCEPTION 'exchange connection delete quiescence trigger is missing';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname = 'complete_exchange_oauth_callback_atomic'
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname = 'claim_exchange_oauth_refresh_atomic'
  ) <> 1 THEN
    RAISE EXCEPTION 'unknown exchange OAuth lifecycle overload remains installed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid IN (v_callback::oid, v_refresh::oid)
      AND (
        function_row.proowner <> v_postgres_oid
        OR NOT function_row.prosecdef
        OR function_row.provolatile <> 'v'
        OR function_row.proparallel <> 'u'
        OR function_row.prorettype <> 'jsonb'::pg_catalog.regtype
        OR function_row.prokind <> 'f'
        OR NOT COALESCE(
          function_row.proconfig @> ARRAY[
            'search_path=pg_catalog, pg_temp',
            'row_security=off',
            'lock_timeout=5s',
            'statement_timeout=20s'
          ]::text[],
          false
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_quiesce::oid
      AND (
        function_row.proowner <> v_postgres_oid
        OR NOT function_row.prosecdef
        OR function_row.provolatile <> 'v'
        OR function_row.proparallel <> 'u'
        OR function_row.prorettype <> 'trigger'::pg_catalog.regtype
        OR function_row.prokind <> 'f'
        OR NOT COALESCE(
          function_row.proconfig @> ARRAY[
            'search_path=pg_catalog, pg_temp',
            'row_security=off'
          ]::text[],
          false
        )
      )
  ) THEN
    RAISE EXCEPTION 'exchange OAuth lifecycle function metadata drifted';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(v_callback) INTO v_source;
  IF pg_catalog.strpos(v_source, 'lock_trader_claim_principals_internal') = 0
     OR pg_catalog.strpos(v_source, 'FOR UPDATE') = 0
     OR pg_catalog.strpos(v_source, 'ON CONFLICT (user_id, exchange)') = 0
     OR pg_catalog.strpos(v_source, 'DELETE FROM public.oauth_states') = 0 THEN
    RAISE EXCEPTION 'exchange OAuth callback transaction contract drifted';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(v_refresh) INTO v_source;
  IF pg_catalog.strpos(v_source, 'lock_trader_claim_principals_internal') = 0
     OR pg_catalog.strpos(v_source, 'FOR UPDATE') = 0
     OR pg_catalog.strpos(v_source, 'refresh_token_encrypted IS DISTINCT FROM') = 0 THEN
    RAISE EXCEPTION 'exchange OAuth refresh claim contract drifted';
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
    WHERE function_row.oid IN (v_callback::oid, v_refresh::oid, v_quiesce::oid)
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'PUBLIC can execute an exchange OAuth lifecycle function';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'anon', 'authenticated', 'authenticator'
  ]::text[]
  LOOP
    IF pg_catalog.has_function_privilege(v_role, v_callback, 'EXECUTE')
       OR pg_catalog.has_function_privilege(v_role, v_refresh, 'EXECUTE')
       OR pg_catalog.has_function_privilege(v_role, v_quiesce, 'EXECUTE') THEN
      RAISE EXCEPTION 'exchange OAuth lifecycle function remains executable by %', v_role;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_function_privilege('service_role', v_callback, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_refresh, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute exchange OAuth lifecycle functions';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.user_exchange_connections AS connection
    WHERE connection.is_active IS DISTINCT FROM false
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_profiles AS profile
        WHERE profile.id = connection.user_id
          AND profile.deleted_at IS NULL
          AND profile.banned_at IS NULL
          AND (
            NOT COALESCE(profile.is_banned, false)
            OR (
              profile.ban_expires_at IS NOT NULL
              AND profile.ban_expires_at <= pg_catalog.clock_timestamp()
            )
          )
      )
  ) THEN
    RAISE EXCEPTION 'unavailable account retains an active exchange connection';
  END IF;
END
$postflight$;

COMMIT;
