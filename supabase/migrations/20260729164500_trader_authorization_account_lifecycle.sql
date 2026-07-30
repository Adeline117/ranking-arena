-- First-party exchange credentials are live account authority.  Suspend them
-- with the owning Arena account and fence every worker credential claim,
-- serving publication, snapshot, and outcome write with one monotonically
-- increasing authorization generation.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'trader-authorization-account-lifecycle-authority@1',
    0
  )
);

DO $preflight$
DECLARE
  v_function record;
  v_relation text;
  v_role text;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regprocedure(
          'public.lock_trader_claim_principals_internal(uuid[],boolean)'
        ) IS NULL
  THEN
    RAISE EXCEPTION
      'trader authorization lifecycle authority requires PostgreSQL 17 and account lock authority';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'postgres',
    'anon',
    'authenticated',
    'service_role',
    'authenticator'
  ]::text[]
  LOOP
    IF pg_catalog.to_regrole(v_role) IS NULL THEN
      RAISE EXCEPTION 'required trader authorization role is unavailable: %',
        v_role;
    END IF;
  END LOOP;

  FOREACH v_relation IN ARRAY ARRAY[
    'auth.users',
    'public.user_profiles',
    'public.trader_authorizations',
    'arena.traders',
    'arena.first_party_snapshots'
  ]::text[]
  LOOP
    IF pg_catalog.to_regclass(v_relation) IS NULL THEN
      RAISE EXCEPTION 'required trader authorization relation is unavailable: %',
        v_relation;
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = pg_catalog.to_regclass(v_relation)
        AND relation.relkind IN ('r', 'p')
        AND relation.relowner = pg_catalog.to_regrole('postgres')
    ) THEN
      RAISE EXCEPTION 'trader authorization relation contract drifted: %',
        v_relation;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('auth', 'users', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'user_profiles', 'id', 'uuid'::pg_catalog.regtype, true),
        (
          'public',
          'user_profiles',
          'deleted_at',
          'timestamptz'::pg_catalog.regtype,
          false
        ),
        (
          'public',
          'user_profiles',
          'banned_at',
          'timestamptz'::pg_catalog.regtype,
          false
        ),
        (
          'public',
          'user_profiles',
          'is_banned',
          'boolean'::pg_catalog.regtype,
          true
        ),
        (
          'public',
          'user_profiles',
          'ban_expires_at',
          'timestamptz'::pg_catalog.regtype,
          false
        ),
        ('public', 'trader_authorizations', 'id', 'uuid'::pg_catalog.regtype, true),
        (
          'public',
          'trader_authorizations',
          'user_id',
          'uuid'::pg_catalog.regtype,
          true
        ),
        (
          'public',
          'trader_authorizations',
          'platform',
          'text'::pg_catalog.regtype,
          true
        ),
        (
          'public',
          'trader_authorizations',
          'trader_id',
          'text'::pg_catalog.regtype,
          true
        ),
        (
          'public',
          'trader_authorizations',
          'encrypted_api_key',
          'text'::pg_catalog.regtype,
          true
        ),
        (
          'public',
          'trader_authorizations',
          'encrypted_api_secret',
          'text'::pg_catalog.regtype,
          true
        ),
        (
          'public',
          'trader_authorizations',
          'encrypted_passphrase',
          'text'::pg_catalog.regtype,
          false
        ),
        (
          'public',
          'trader_authorizations',
          'status',
          'text'::pg_catalog.regtype,
          true
        ),
        (
          'public',
          'trader_authorizations',
          'read_only_verified_at',
          'timestamptz'::pg_catalog.regtype,
          false
        ),
        (
          'public',
          'trader_authorizations',
          'last_sync_at',
          'timestamptz'::pg_catalog.regtype,
          false
        ),
        (
          'public',
          'trader_authorizations',
          'last_sync_status',
          'text'::pg_catalog.regtype,
          false
        ),
        (
          'public',
          'trader_authorizations',
          'consecutive_failures',
          'integer'::pg_catalog.regtype,
          true
        ),
        (
          'public',
          'trader_authorizations',
          'verification_error',
          'text'::pg_catalog.regtype,
          false
        ),
        (
          'public',
          'trader_authorizations',
          'expires_at',
          'timestamptz'::pg_catalog.regtype,
          false
        ),
        ('arena', 'traders', 'id', 'bigint'::pg_catalog.regtype, true),
        (
          'arena',
          'first_party_snapshots',
          'trader_id',
          'bigint'::pg_catalog.regtype,
          true
        ),
        (
          'arena',
          'first_party_snapshots',
          'ts',
          'timestamptz'::pg_catalog.regtype,
          true
        ),
        (
          'arena',
          'first_party_snapshots',
          'equity',
          'numeric'::pg_catalog.regtype,
          true
        ),
        (
          'arena',
          'first_party_snapshots',
          'balance',
          'numeric'::pg_catalog.regtype,
          false
        ),
        (
          'arena',
          'first_party_snapshots',
          'unrealized_pnl',
          'numeric'::pg_catalog.regtype,
          false
        ),
        (
          'arena',
          'first_party_snapshots',
          'net_transfer_cum',
          'numeric'::pg_catalog.regtype,
          false
        ),
        (
          'arena',
          'first_party_snapshots',
          'currency',
          'text'::pg_catalog.regtype,
          true
        )
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
       OR required_column.required_not_null AND NOT attribute.attnotnull
  ) THEN
    RAISE EXCEPTION 'trader authorization lifecycle column contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.trader_authorizations'::pg_catalog.regclass
      AND attribute.attname = 'authorization_generation'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND (
        attribute.atttypid <> 'bigint'::pg_catalog.regtype
        OR NOT attribute.attnotnull
      )
  ) THEN
    RAISE EXCEPTION 'existing authorization generation column is incompatible';
  END IF;

  FOR v_function IN
    SELECT *
    FROM (
      VALUES
        ('bump_trader_authorization_generation', ''),
        ('quiesce_inactive_trader_authorizations', ''),
        ('claim_first_party_authorization_sync_atomic', 'p_authorization_id uuid'),
        (
          'lock_first_party_authorization_publication_atomic',
          'p_authorization_id uuid, p_generation bigint'
        ),
        (
          'finish_first_party_authorization_sync_atomic',
          'p_authorization_id uuid, p_generation bigint, p_expected_failures integer, p_succeeded boolean, p_detail text, p_trader_id bigint, p_equity numeric, p_balance numeric, p_unrealized_pnl numeric, p_net_transfer_cum numeric, p_currency text'
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
      RAISE EXCEPTION 'unexpected trader authorization lifecycle overload exists: %',
        v_function.function_name;
    END IF;
  END LOOP;
END
$preflight$;

LOCK TABLE public.user_profiles IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.trader_authorizations IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.first_party_snapshots IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.trader_authorizations
  ADD COLUMN IF NOT EXISTS authorization_generation bigint NOT NULL DEFAULT 1;

ALTER TABLE public.trader_authorizations
  ALTER COLUMN authorization_generation SET DEFAULT 1,
  ALTER COLUMN authorization_generation SET NOT NULL;

ALTER TABLE public.trader_authorizations
  DROP CONSTRAINT IF EXISTS trader_authorizations_generation_valid;
ALTER TABLE public.trader_authorizations
  ADD CONSTRAINT trader_authorizations_generation_valid
  CHECK (authorization_generation > 0) NOT VALID;
ALTER TABLE public.trader_authorizations
  VALIDATE CONSTRAINT trader_authorizations_generation_valid;

CREATE OR REPLACE FUNCTION public.bump_trader_authorization_generation()
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
     OR TG_TABLE_NAME IS DISTINCT FROM 'trader_authorizations'
     OR TG_OP NOT IN ('INSERT', 'UPDATE')
  THEN
    RAISE EXCEPTION 'authorization generation trigger is attached outside its contract'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.authorization_generation := 1;
    RETURN NEW;
  END IF;

  v_authority_changed :=
    NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.platform IS DISTINCT FROM OLD.platform
    OR NEW.trader_id IS DISTINCT FROM OLD.trader_id
    OR NEW.encrypted_api_key IS DISTINCT FROM OLD.encrypted_api_key
    OR NEW.encrypted_api_secret IS DISTINCT FROM OLD.encrypted_api_secret
    OR NEW.encrypted_passphrase IS DISTINCT FROM OLD.encrypted_passphrase
    OR NEW.permissions IS DISTINCT FROM OLD.permissions
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.read_only_verified_at IS DISTINCT FROM OLD.read_only_verified_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at;

  IF NOT v_authority_changed THEN
    NEW.authorization_generation := OLD.authorization_generation;
    RETURN NEW;
  END IF;

  IF OLD.authorization_generation = 9223372036854775807 THEN
    -- Revocation must remain possible even after impossible/corrupt generation
    -- exhaustion.  Reactivation or credential replacement cannot safely reuse
    -- the old generation because an in-flight worker may still own it.
    IF NEW.status = 'active' THEN
      RAISE EXCEPTION 'authorization generation exhausted'
        USING ERRCODE = '54000';
    END IF;
    NEW.authorization_generation := OLD.authorization_generation;
    RETURN NEW;
  END IF;

  NEW.authorization_generation := OLD.authorization_generation + 1;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.bump_trader_authorization_generation()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.bump_trader_authorization_generation()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

DROP TRIGGER IF EXISTS aaa_bump_trader_authorization_generation
  ON public.trader_authorizations;
CREATE TRIGGER aaa_bump_trader_authorization_generation
  BEFORE INSERT OR UPDATE ON public.trader_authorizations
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_trader_authorization_generation();

CREATE OR REPLACE FUNCTION public.quiesce_inactive_trader_authorizations()
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
  v_user_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
BEGIN
  IF TG_LEVEL IS DISTINCT FROM 'ROW'
     OR TG_WHEN IS DISTINCT FROM 'AFTER'
     OR TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
     OR TG_TABLE_NAME IS DISTINCT FROM 'user_profiles'
     OR TG_OP NOT IN ('UPDATE', 'DELETE')
  THEN
    RAISE EXCEPTION 'authorization quiescence trigger is attached outside its contract'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE'
     OR NEW.deleted_at IS NOT NULL
     OR NEW.banned_at IS NOT NULL
     OR (
       COALESCE(NEW.is_banned, false)
       AND (
         NEW.ban_expires_at IS NULL
         OR NEW.ban_expires_at > pg_catalog.clock_timestamp()
       )
     )
  THEN
    UPDATE public.trader_authorizations AS authorization_row
    SET status = 'suspended',
        last_sync_status = 'inactive',
        verification_error = 'Arena account inactive'
    WHERE authorization_row.user_id = v_user_id
      AND authorization_row.status = 'active';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

ALTER FUNCTION public.quiesce_inactive_trader_authorizations()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.quiesce_inactive_trader_authorizations()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

DROP TRIGGER IF EXISTS zzz_quiesce_inactive_trader_authorizations
  ON public.user_profiles;
CREATE TRIGGER zzz_quiesce_inactive_trader_authorizations
  AFTER UPDATE OF deleted_at, banned_at, is_banned, ban_expires_at
  ON public.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.quiesce_inactive_trader_authorizations();

DROP TRIGGER IF EXISTS zzz_quiesce_deleted_profile_trader_authorizations
  ON public.user_profiles;
CREATE TRIGGER zzz_quiesce_deleted_profile_trader_authorizations
  AFTER DELETE ON public.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.quiesce_inactive_trader_authorizations();

-- Missing profiles are inactive too.  This also closes rows left active by a
-- historical direct profile deletion before the DELETE trigger existed.
UPDATE public.trader_authorizations AS authorization_row
SET status = 'suspended',
    last_sync_status = 'inactive',
    verification_error = 'Arena account inactive'
WHERE authorization_row.status = 'active'
  AND NOT EXISTS (
    SELECT 1
    FROM public.user_profiles AS profile
    WHERE profile.id = authorization_row.user_id
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

CREATE OR REPLACE FUNCTION public.claim_first_party_authorization_sync_atomic(
  p_authorization_id uuid
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
  v_authorization public.trader_authorizations%ROWTYPE;
  v_observed_user_id uuid;
BEGIN
  IF p_authorization_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  SELECT authorization_row.user_id
  INTO v_observed_user_id
  FROM public.trader_authorizations AS authorization_row
  WHERE authorization_row.id = p_authorization_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  BEGIN
    PERFORM public.lock_trader_claim_principals_internal(
      ARRAY[v_observed_user_id]::uuid[],
      true
    );
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'missing_account');
    WHEN SQLSTATE '22023' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'suspended');
  END;

  SELECT authorization_row.*
  INTO v_authorization
  FROM public.trader_authorizations AS authorization_row
  WHERE authorization_row.id = p_authorization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_authorization.user_id IS DISTINCT FROM v_observed_user_id THEN
    RAISE EXCEPTION 'authorization owner changed during active claim'
      USING ERRCODE = '40001';
  END IF;

  IF v_authorization.status = 'active'
     AND v_authorization.expires_at IS NOT NULL
     AND v_authorization.expires_at <= pg_catalog.clock_timestamp()
  THEN
    UPDATE public.trader_authorizations AS authorization_row
    SET status = 'expired',
        last_sync_status = 'inactive',
        verification_error = 'Authorization expired'
    WHERE authorization_row.id = v_authorization.id;
    RETURN pg_catalog.jsonb_build_object('status', 'inactive');
  END IF;

  IF v_authorization.status IS DISTINCT FROM 'active'
     OR v_authorization.read_only_verified_at IS NULL
     OR pg_catalog.btrim(v_authorization.encrypted_api_key) = ''
     OR pg_catalog.btrim(v_authorization.encrypted_api_secret) = ''
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'inactive');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'claimed',
    'authorization_id', v_authorization.id,
    'generation', v_authorization.authorization_generation,
    'user_id', v_authorization.user_id,
    'platform', v_authorization.platform,
    'trader_id', v_authorization.trader_id,
    'encrypted_api_key', v_authorization.encrypted_api_key,
    'encrypted_api_secret', v_authorization.encrypted_api_secret,
    'encrypted_passphrase', v_authorization.encrypted_passphrase,
    'last_sync_at', v_authorization.last_sync_at,
    'consecutive_failures', v_authorization.consecutive_failures
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.lock_first_party_authorization_publication_atomic(
  p_authorization_id uuid,
  p_generation bigint
)
RETURNS text
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
  v_authorization public.trader_authorizations%ROWTYPE;
  v_observed_user_id uuid;
BEGIN
  IF p_authorization_id IS NULL OR p_generation IS NULL OR p_generation <= 0 THEN
    RETURN 'invalid';
  END IF;

  SELECT authorization_row.user_id
  INTO v_observed_user_id
  FROM public.trader_authorizations AS authorization_row
  WHERE authorization_row.id = p_authorization_id;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  BEGIN
    PERFORM public.lock_trader_claim_principals_internal(
      ARRAY[v_observed_user_id]::uuid[],
      true
    );
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN
      RETURN 'missing_account';
    WHEN SQLSTATE '22023' THEN
      RETURN 'suspended';
  END;

  SELECT authorization_row.*
  INTO v_authorization
  FROM public.trader_authorizations AS authorization_row
  WHERE authorization_row.id = p_authorization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF v_authorization.user_id IS DISTINCT FROM v_observed_user_id THEN
    RAISE EXCEPTION 'authorization owner changed during publication lock'
      USING ERRCODE = '40001';
  END IF;
  IF v_authorization.authorization_generation IS DISTINCT FROM p_generation THEN
    RETURN 'superseded';
  END IF;
  IF v_authorization.status IS DISTINCT FROM 'active'
     OR v_authorization.read_only_verified_at IS NULL
     OR (
       v_authorization.expires_at IS NOT NULL
       AND v_authorization.expires_at <= pg_catalog.clock_timestamp()
     )
  THEN
    RETURN 'inactive';
  END IF;

  RETURN 'active';
END
$function$;

CREATE OR REPLACE FUNCTION public.finish_first_party_authorization_sync_atomic(
  p_authorization_id uuid,
  p_generation bigint,
  p_expected_failures integer,
  p_succeeded boolean,
  p_detail text,
  p_trader_id bigint,
  p_equity numeric,
  p_balance numeric,
  p_unrealized_pnl numeric,
  p_net_transfer_cum numeric,
  p_currency text
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
  v_authorization public.trader_authorizations%ROWTYPE;
  v_failures integer;
  v_now timestamptz;
  v_observed_user_id uuid;
  v_status text;
BEGIN
  IF p_authorization_id IS NULL
     OR p_generation IS NULL
     OR p_generation <= 0
     OR p_expected_failures IS NULL
     OR p_expected_failures NOT BETWEEN 0 AND 1000000
     OR p_succeeded IS NULL
     OR p_detail IS NULL
     OR pg_catalog.length(p_detail) NOT BETWEEN 1 AND 200
     OR (
       p_succeeded
       AND (
         p_trader_id IS NULL
         OR p_trader_id <= 0
         OR p_equity IS NULL
         OR p_equity::text IN ('NaN', 'Infinity', '-Infinity')
         OR pg_catalog.abs(p_equity) > 1000000000000000000::numeric
         OR p_balance::text IN ('NaN', 'Infinity', '-Infinity')
         OR p_unrealized_pnl::text IN ('NaN', 'Infinity', '-Infinity')
         OR p_net_transfer_cum::text IN ('NaN', 'Infinity', '-Infinity')
         OR p_currency IS NULL
         OR pg_catalog.length(pg_catalog.btrim(p_currency)) NOT BETWEEN 1 AND 16
       )
     )
     OR (
       NOT p_succeeded
       AND (
         p_trader_id IS NOT NULL
         OR p_equity IS NOT NULL
         OR p_balance IS NOT NULL
         OR p_unrealized_pnl IS NOT NULL
         OR p_net_transfer_cum IS NOT NULL
         OR p_currency IS NOT NULL
       )
     )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  SELECT authorization_row.user_id
  INTO v_observed_user_id
  FROM public.trader_authorizations AS authorization_row
  WHERE authorization_row.id = p_authorization_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  BEGIN
    PERFORM public.lock_trader_claim_principals_internal(
      ARRAY[v_observed_user_id]::uuid[],
      true
    );
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'missing_account');
    WHEN SQLSTATE '22023' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'suspended');
  END;

  SELECT authorization_row.*
  INTO v_authorization
  FROM public.trader_authorizations AS authorization_row
  WHERE authorization_row.id = p_authorization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_authorization.user_id IS DISTINCT FROM v_observed_user_id THEN
    RAISE EXCEPTION 'authorization owner changed during sync outcome'
      USING ERRCODE = '40001';
  END IF;
  IF v_authorization.authorization_generation IS DISTINCT FROM p_generation
     OR v_authorization.consecutive_failures IS DISTINCT FROM p_expected_failures
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'superseded',
      'current_generation', v_authorization.authorization_generation
    );
  END IF;
  IF v_authorization.status IS DISTINCT FROM 'active'
     OR v_authorization.read_only_verified_at IS NULL
     OR (
       v_authorization.expires_at IS NOT NULL
       AND v_authorization.expires_at <= pg_catalog.clock_timestamp()
     )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'inactive');
  END IF;

  v_now := pg_catalog.clock_timestamp();
  v_failures := CASE WHEN p_succeeded THEN 0 ELSE p_expected_failures + 1 END;
  v_status := CASE
    WHEN p_succeeded THEN 'active'
    WHEN v_failures >= 3 THEN 'suspended'
    ELSE 'active'
  END;

  IF p_succeeded THEN
    IF NOT EXISTS (
      SELECT 1
      FROM arena.traders AS trader
      WHERE trader.id = p_trader_id
        AND trader.exchange_trader_id = v_authorization.trader_id
    ) THEN
      RETURN pg_catalog.jsonb_build_object('status', 'identity_mismatch');
    END IF;

    INSERT INTO arena.first_party_snapshots (
      trader_id,
      ts,
      equity,
      balance,
      unrealized_pnl,
      net_transfer_cum,
      currency
    ) VALUES (
      p_trader_id,
      v_now,
      p_equity,
      p_balance,
      p_unrealized_pnl,
      p_net_transfer_cum,
      pg_catalog.upper(pg_catalog.btrim(p_currency))
    );
  END IF;

  UPDATE public.trader_authorizations AS authorization_row
  SET last_sync_at = v_now,
      last_sync_status = CASE WHEN p_succeeded THEN 'success' ELSE 'error' END,
      consecutive_failures = v_failures,
      status = v_status,
      last_verified_at = CASE
        WHEN p_succeeded THEN v_now
        ELSE authorization_row.last_verified_at
      END,
      verification_error = CASE
        WHEN p_succeeded THEN NULL
        ELSE p_detail
      END
  WHERE authorization_row.id = p_authorization_id
    AND authorization_row.authorization_generation = p_generation
    AND authorization_row.consecutive_failures = p_expected_failures
    AND authorization_row.status = 'active'
  RETURNING authorization_row.* INTO STRICT v_authorization;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'recorded',
    'authorization_status', v_authorization.status,
    'generation', v_authorization.authorization_generation,
    'consecutive_failures', v_authorization.consecutive_failures,
    'notification_needed', (
      NOT p_succeeded
      AND v_failures = 3
      AND v_authorization.status = 'suspended'
    ),
    'synced_at', v_now
  );
END
$function$;

ALTER FUNCTION public.claim_first_party_authorization_sync_atomic(uuid)
  OWNER TO postgres;
ALTER FUNCTION public.lock_first_party_authorization_publication_atomic(uuid, bigint)
  OWNER TO postgres;
ALTER FUNCTION public.finish_first_party_authorization_sync_atomic(
  uuid,
  bigint,
  integer,
  boolean,
  text,
  bigint,
  numeric,
  numeric,
  numeric,
  numeric,
  text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.claim_first_party_authorization_sync_atomic(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION
  public.lock_first_party_authorization_publication_atomic(uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.finish_first_party_authorization_sync_atomic(
  uuid,
  bigint,
  integer,
  boolean,
  text,
  bigint,
  numeric,
  numeric,
  numeric,
  numeric,
  text
) FROM PUBLIC, anon, authenticated, service_role, authenticator;

GRANT EXECUTE ON FUNCTION public.claim_first_party_authorization_sync_atomic(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.lock_first_party_authorization_publication_atomic(uuid, bigint)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_first_party_authorization_sync_atomic(
  uuid,
  bigint,
  integer,
  boolean,
  text,
  bigint,
  numeric,
  numeric,
  numeric,
  numeric,
  text
) TO service_role;

-- Credential mutation is server-owned.  Authenticated readers keep their
-- existing safe-status access, but browser JWTs can no longer fabricate or
-- reactivate a worker credential row directly through PostgREST.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.trader_authorizations
  FROM PUBLIC, anon, authenticated, authenticator;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.trader_authorizations
  TO service_role;

COMMENT ON COLUMN public.trader_authorizations.authorization_generation IS
  'Monotonic worker fence bumped whenever credentials, identity, verification, expiry, or active status changes.';
COMMENT ON FUNCTION public.claim_first_party_authorization_sync_atomic(uuid) IS
  'Service-only active-account credential claim under lifecycle, Auth, profile, then authorization locks.';
COMMENT ON FUNCTION
  public.lock_first_party_authorization_publication_atomic(uuid, bigint) IS
  'Locks and verifies one active-account authorization generation for the caller transaction before serving publication.';
COMMENT ON FUNCTION public.finish_first_party_authorization_sync_atomic(
  uuid,
  bigint,
  integer,
  boolean,
  text,
  bigint,
  numeric,
  numeric,
  numeric,
  numeric,
  text
) IS
  'Generation-CAS first-party snapshot and sync outcome boundary, serialized with account sanctions and deletion.';

DO $postflight$
DECLARE
  v_function oid;
  v_function_name text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.trader_authorizations'::pg_catalog.regclass
      AND attribute.attname = 'authorization_generation'
      AND attribute.atttypid = 'bigint'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.atthasdef
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
          'public.trader_authorizations'::pg_catalog.regclass
      AND constraint_row.conname = 'trader_authorizations_generation_valid'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) =
          'CHECK (authorization_generation > 0)'
  ) THEN
    RAISE EXCEPTION 'authorization generation postflight drifted';
  END IF;

  FOREACH v_function_name IN ARRAY ARRAY[
    'public.claim_first_party_authorization_sync_atomic(uuid)',
    'public.lock_first_party_authorization_publication_atomic(uuid,bigint)',
    'public.finish_first_party_authorization_sync_atomic(uuid,bigint,integer,boolean,text,bigint,numeric,numeric,numeric,numeric,text)'
  ]::text[]
  LOOP
    v_function := pg_catalog.to_regprocedure(v_function_name);
    IF v_function IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         WHERE function_row.oid = v_function
           AND function_row.proowner = pg_catalog.to_regrole('postgres')
           AND function_row.prosecdef
           AND function_row.provolatile = 'v'
           AND function_row.proparallel = 'u'
           AND function_row.proconfig @> ARRAY[
             'search_path=pg_catalog, pg_temp',
             'row_security=off',
             'lock_timeout=5s',
             'statement_timeout=20s'
           ]::text[]
       )
       OR NOT pg_catalog.has_function_privilege(
         'service_role', v_function, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege(
         'authenticated', v_function, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
         'authenticator', v_function, 'EXECUTE'
       )
    THEN
      RAISE EXCEPTION 'worker authorization function contract drifted: %',
        v_function_name;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'bump_trader_authorization_generation',
        'quiesce_inactive_trader_authorizations',
        'claim_first_party_authorization_sync_atomic',
        'lock_first_party_authorization_publication_atomic',
        'finish_first_party_authorization_sync_atomic'
      )
      AND function_row.oid NOT IN (
        'public.bump_trader_authorization_generation()'::pg_catalog.regprocedure,
        'public.quiesce_inactive_trader_authorizations()'::pg_catalog.regprocedure,
        'public.claim_first_party_authorization_sync_atomic(uuid)'::pg_catalog.regprocedure,
        'public.lock_first_party_authorization_publication_atomic(uuid,bigint)'::pg_catalog.regprocedure,
        'public.finish_first_party_authorization_sync_atomic(uuid,bigint,integer,boolean,text,bigint,numeric,numeric,numeric,numeric,text)'::pg_catalog.regprocedure
      )
  ) THEN
    RAISE EXCEPTION 'worker authorization overload count drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.trader_authorizations'::pg_catalog.regclass
      AND trigger_row.tgname = 'aaa_bump_trader_authorization_generation'
      AND trigger_row.tgfoid =
          'public.bump_trader_authorization_generation()'::pg_catalog.regprocedure
      AND trigger_row.tgtype = 23
      AND trigger_row.tgenabled IN ('O', 'A')
      AND NOT trigger_row.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_profiles'::pg_catalog.regclass
      AND trigger_row.tgname = 'zzz_quiesce_inactive_trader_authorizations'
      AND trigger_row.tgfoid =
          'public.quiesce_inactive_trader_authorizations()'::pg_catalog.regprocedure
      AND trigger_row.tgtype = 17
      AND trigger_row.tgenabled IN ('O', 'A')
      AND NOT trigger_row.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_profiles'::pg_catalog.regclass
      AND trigger_row.tgname = 'zzz_quiesce_deleted_profile_trader_authorizations'
      AND trigger_row.tgfoid =
          'public.quiesce_inactive_trader_authorizations()'::pg_catalog.regprocedure
      AND trigger_row.tgtype = 9
      AND trigger_row.tgenabled IN ('O', 'A')
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'worker authorization trigger contract drifted';
  END IF;

  IF pg_catalog.has_table_privilege(
       'authenticated',
       'public.trader_authorizations',
       'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     OR pg_catalog.has_table_privilege(
       'anon',
       'public.trader_authorizations',
       'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
  THEN
    RAISE EXCEPTION 'browser authorization mutation authority remains open';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
