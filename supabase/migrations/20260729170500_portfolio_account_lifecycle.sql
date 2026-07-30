-- Bind portfolio credential storage and remote-sync publication to the
-- canonical account lifecycle. A portfolio sync spans an untrusted remote
-- exchange request, so its final financial snapshot must prove both the
-- account and the exact credential generation are still active.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('public.portfolio-account-lifecycle:v1', 0)
);

DO $preflight$
DECLARE
  v_present_columns integer;
  v_function record;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer < 170000 THEN
    RAISE EXCEPTION 'portfolio account lifecycle requires PostgreSQL 17';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regprocedure(
          'public.lock_trader_claim_principals_internal(uuid[],boolean)'
        ) IS NULL
  THEN
    RAISE EXCEPTION 'canonical account lifecycle authority is incomplete';
  END IF;

  IF pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.user_portfolios') IS NULL
     OR pg_catalog.to_regclass('public.user_positions') IS NULL
     OR pg_catalog.to_regclass('public.user_portfolio_snapshots') IS NULL
  THEN
    RAISE EXCEPTION 'portfolio lifecycle tables are incomplete';
  END IF;

  IF pg_catalog.to_regprocedure(
       'public.claim_portfolio_sync_generation_atomic(uuid,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.publish_portfolio_sync_atomic(uuid,uuid,bigint,timestamp with time zone,jsonb,numeric,numeric,numeric)'
     ) IS NULL
  THEN
    RAISE EXCEPTION 'atomic portfolio publication authority is incomplete';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_present_columns
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.user_portfolios'::pg_catalog.regclass
    AND attribute.attname IN (
      'is_active',
      'credential_generation',
      'read_only_permissions',
      'read_only_verified_at'
    )
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF v_present_columns NOT IN (0, 4) THEN
    RAISE EXCEPTION 'portfolio lifecycle columns were partially applied';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.user_portfolios'::pg_catalog.regclass
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
      ) = ARRAY['user_id', 'exchange', 'label']::name[]
  ) THEN
    RAISE EXCEPTION 'portfolio lifecycle requires unique owner/exchange/label';
  END IF;

  FOR v_function IN
    SELECT *
    FROM (
      VALUES
        ('portfolio_ciphertext_valid_internal', 'p_ciphertext text'),
        (
          'portfolio_permissions_valid_internal',
          'p_permissions jsonb'
        ),
        ('bump_portfolio_credential_generation', ''),
        ('quiesce_inactive_user_portfolios', ''),
        (
          'claim_portfolio_sync_generation_atomic',
          'p_actor_id uuid, p_portfolio_id uuid'
        ),
        (
          'publish_portfolio_sync_atomic',
          'p_actor_id uuid, p_portfolio_id uuid, p_generation bigint, p_synced_at timestamp with time zone, p_positions jsonb, p_total_equity numeric, p_total_pnl numeric, p_total_pnl_pct numeric'
        ),
        (
          'save_user_portfolio_for_active_profile_atomic',
          'p_user_id uuid, p_exchange text, p_api_key_encrypted text, p_api_secret_encrypted text, p_api_passphrase_encrypted text, p_label text, p_read_only_permissions jsonb'
        ),
        (
          'publish_active_portfolio_sync_atomic',
          'p_actor_id uuid, p_portfolio_id uuid, p_generation bigint, p_credential_generation bigint, p_synced_at timestamp with time zone, p_positions jsonb, p_total_equity numeric, p_total_pnl numeric, p_total_pnl_pct numeric'
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
      RAISE EXCEPTION 'unexpected portfolio lifecycle overload exists: %',
        v_function.function_name;
    END IF;
  END LOOP;
END
$preflight$;

LOCK TABLE public.user_profiles IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.user_portfolios IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.user_positions IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.user_portfolio_snapshots IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.user_portfolios
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS credential_generation bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS read_only_permissions jsonb,
  ADD COLUMN IF NOT EXISTS read_only_verified_at timestamptz;

ALTER TABLE public.user_portfolios
  ALTER COLUMN is_active SET DEFAULT false,
  ALTER COLUMN is_active SET NOT NULL,
  ALTER COLUMN credential_generation SET DEFAULT 1,
  ALTER COLUMN credential_generation SET NOT NULL;

CREATE OR REPLACE FUNCTION public.portfolio_ciphertext_valid_internal(
  p_ciphertext text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_ciphertext jsonb;
  v_key_count integer;
BEGIN
  IF p_ciphertext IS NULL
     OR pg_catalog.length(p_ciphertext) NOT BETWEEN 2 AND 65536
  THEN
    RETURN false;
  END IF;

  BEGIN
    v_ciphertext := p_ciphertext::jsonb;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RETURN false;
  END;

  IF pg_catalog.jsonb_typeof(v_ciphertext) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_key_count
  FROM pg_catalog.jsonb_object_keys(v_ciphertext);

  RETURN v_key_count = 5
    AND v_ciphertext ?& ARRAY['version', 'salt', 'iv', 'tag', 'ciphertext']
    AND v_ciphertext -> 'version' = '1'::jsonb
    AND pg_catalog.jsonb_typeof(v_ciphertext -> 'salt') = 'string'
    AND (v_ciphertext ->> 'salt') ~ '^[0-9a-f]{64}$'
    AND pg_catalog.jsonb_typeof(v_ciphertext -> 'iv') = 'string'
    AND (v_ciphertext ->> 'iv') ~ '^[0-9a-f]{32}$'
    AND pg_catalog.jsonb_typeof(v_ciphertext -> 'tag') = 'string'
    AND (v_ciphertext ->> 'tag') ~ '^[0-9a-f]{32}$'
    AND pg_catalog.jsonb_typeof(v_ciphertext -> 'ciphertext') = 'string'
    AND (v_ciphertext ->> 'ciphertext') ~ '^[0-9a-f]+$'
    AND pg_catalog.length(v_ciphertext ->> 'ciphertext') BETWEEN 2 AND 32768
    AND pg_catalog.mod(
          pg_catalog.length(v_ciphertext ->> 'ciphertext'),
          2
        ) = 0;
END
$function$;

CREATE OR REPLACE FUNCTION public.portfolio_permissions_valid_internal(
  p_permissions jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
BEGIN
  IF p_permissions IS NULL
     OR pg_catalog.jsonb_typeof(p_permissions) IS DISTINCT FROM 'array'
  THEN
    RETURN false;
  END IF;
  IF pg_catalog.jsonb_array_length(p_permissions) NOT BETWEEN 1 AND 100 THEN
    RETURN false;
  END IF;

  RETURN NOT EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_permissions) AS permission(value)
    WHERE pg_catalog.jsonb_typeof(permission.value) IS DISTINCT FROM 'string'
       OR pg_catalog.length(permission.value #>> '{}') NOT BETWEEN 1 AND 128
  );
END
$function$;

ALTER FUNCTION public.portfolio_ciphertext_valid_internal(text)
  OWNER TO postgres;
ALTER FUNCTION public.portfolio_permissions_valid_internal(jsonb)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.portfolio_ciphertext_valid_internal(text)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.portfolio_permissions_valid_internal(jsonb)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

ALTER TABLE public.user_portfolios
  DROP CONSTRAINT IF EXISTS user_portfolios_credential_generation_valid;
ALTER TABLE public.user_portfolios
  ADD CONSTRAINT user_portfolios_credential_generation_valid
  CHECK (credential_generation > 0) NOT VALID;

ALTER TABLE public.user_portfolios
  DROP CONSTRAINT IF EXISTS user_portfolios_active_credential_proof_valid;
ALTER TABLE public.user_portfolios
  ADD CONSTRAINT user_portfolios_active_credential_proof_valid
  CHECK (
    NOT is_active
    OR (
      exchange = ANY (ARRAY['binance', 'bybit', 'okx', 'bitget']::text[])
      AND public.portfolio_ciphertext_valid_internal(api_key_encrypted)
      AND public.portfolio_ciphertext_valid_internal(api_secret_encrypted)
      AND (
        api_passphrase_encrypted IS NULL
        OR public.portfolio_ciphertext_valid_internal(api_passphrase_encrypted)
      )
      AND (
        exchange <> ALL (ARRAY['okx', 'bitget']::text[])
        OR api_passphrase_encrypted IS NOT NULL
      )
      AND public.portfolio_permissions_valid_internal(read_only_permissions)
      AND read_only_verified_at IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE public.user_portfolios
  VALIDATE CONSTRAINT user_portfolios_credential_generation_valid;

CREATE OR REPLACE FUNCTION public.bump_portfolio_credential_generation()
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
     OR TG_TABLE_NAME IS DISTINCT FROM 'user_portfolios'
     OR TG_OP NOT IN ('INSERT', 'UPDATE')
  THEN
    RAISE EXCEPTION 'portfolio generation trigger is outside its contract'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.credential_generation := 1;
    RETURN NEW;
  END IF;

  v_authority_changed :=
    NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.exchange IS DISTINCT FROM OLD.exchange
    OR NEW.api_key_encrypted IS DISTINCT FROM OLD.api_key_encrypted
    OR NEW.api_secret_encrypted IS DISTINCT FROM OLD.api_secret_encrypted
    OR NEW.api_passphrase_encrypted IS DISTINCT FROM OLD.api_passphrase_encrypted
    OR NEW.is_active IS DISTINCT FROM OLD.is_active
    OR NEW.read_only_permissions IS DISTINCT FROM OLD.read_only_permissions
    OR NEW.read_only_verified_at IS DISTINCT FROM OLD.read_only_verified_at;

  IF NOT v_authority_changed THEN
    NEW.credential_generation := OLD.credential_generation;
    RETURN NEW;
  END IF;

  IF OLD.credential_generation = 9223372036854775807 THEN
    -- Revocation remains possible even after corrupt/impossible exhaustion.
    -- No active credential is allowed to reuse an exhausted generation.
    IF NEW.is_active IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'portfolio credential generation exhausted'
        USING ERRCODE = '54000';
    END IF;
    NEW.credential_generation := OLD.credential_generation;
    RETURN NEW;
  END IF;

  NEW.credential_generation := OLD.credential_generation + 1;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.bump_portfolio_credential_generation()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.bump_portfolio_credential_generation()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

DROP TRIGGER IF EXISTS aaa_bump_portfolio_credential_generation
  ON public.user_portfolios;
CREATE TRIGGER aaa_bump_portfolio_credential_generation
  BEFORE INSERT OR UPDATE ON public.user_portfolios
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_portfolio_credential_generation();

CREATE OR REPLACE FUNCTION public.quiesce_inactive_user_portfolios()
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
    RAISE EXCEPTION 'portfolio quiescence trigger is outside its contract'
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
    UPDATE public.user_portfolios AS portfolio
    SET is_active = false
    WHERE portfolio.user_id = v_user_id
      AND portfolio.is_active IS DISTINCT FROM false;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

ALTER FUNCTION public.quiesce_inactive_user_portfolios()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.quiesce_inactive_user_portfolios()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

DROP TRIGGER IF EXISTS zzz_quiesce_inactive_user_portfolios
  ON public.user_profiles;
CREATE TRIGGER zzz_quiesce_inactive_user_portfolios
  AFTER UPDATE OF deleted_at, banned_at, is_banned, ban_expires_at
  ON public.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.quiesce_inactive_user_portfolios();

DROP TRIGGER IF EXISTS zzz_quiesce_deleted_user_portfolios
  ON public.user_profiles;
CREATE TRIGGER zzz_quiesce_deleted_user_portfolios
  AFTER DELETE ON public.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.quiesce_inactive_user_portfolios();

-- Existing portfolio rows receive is_active=false from the new safe default,
-- retaining encrypted data for user-directed removal but never using it for a
-- remote request. This predicate also converges hostile/out-of-band active rows
-- without deactivating valid rows when the migration is replayed.
UPDATE public.user_portfolios AS portfolio
SET is_active = false
WHERE portfolio.is_active = true
  AND (
    NOT public.portfolio_ciphertext_valid_internal(
      portfolio.api_key_encrypted
    )
    OR NOT public.portfolio_ciphertext_valid_internal(
      portfolio.api_secret_encrypted
    )
    OR (
      portfolio.api_passphrase_encrypted IS NOT NULL
      AND NOT public.portfolio_ciphertext_valid_internal(
        portfolio.api_passphrase_encrypted
      )
    )
    OR NOT public.portfolio_permissions_valid_internal(
      portfolio.read_only_permissions
    )
    OR portfolio.read_only_verified_at IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM public.user_profiles AS profile
      WHERE profile.id = portfolio.user_id
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
  );

ALTER TABLE public.user_portfolios
  VALIDATE CONSTRAINT user_portfolios_active_credential_proof_valid;

CREATE OR REPLACE FUNCTION public.save_user_portfolio_for_active_profile_atomic(
  p_user_id uuid,
  p_exchange text,
  p_api_key_encrypted text,
  p_api_secret_encrypted text,
  p_api_passphrase_encrypted text,
  p_label text,
  p_read_only_permissions jsonb
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
  v_portfolio public.user_portfolios%ROWTYPE;
  v_verified_at timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;

  IF p_user_id IS NULL
     OR p_exchange IS NULL
     OR p_exchange <> ALL (ARRAY['binance', 'bybit', 'okx', 'bitget']::text[])
     OR p_exchange IS DISTINCT FROM pg_catalog.lower(pg_catalog.btrim(p_exchange))
     OR NOT public.portfolio_ciphertext_valid_internal(p_api_key_encrypted)
     OR NOT public.portfolio_ciphertext_valid_internal(p_api_secret_encrypted)
     OR (
       p_api_passphrase_encrypted IS NOT NULL
       AND NOT public.portfolio_ciphertext_valid_internal(
         p_api_passphrase_encrypted
       )
     )
     OR (
       p_exchange = ANY (ARRAY['okx', 'bitget']::text[])
       AND p_api_passphrase_encrypted IS NULL
     )
     OR p_label IS NULL
     OR pg_catalog.length(p_label) NOT BETWEEN 1 AND 255
     OR p_label IS DISTINCT FROM pg_catalog.btrim(p_label)
     OR NOT public.portfolio_permissions_valid_internal(
       p_read_only_permissions
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

  v_verified_at := pg_catalog.clock_timestamp();

  BEGIN
    INSERT INTO public.user_portfolios AS portfolio (
      user_id,
      exchange,
      api_key_encrypted,
      api_secret_encrypted,
      api_passphrase_encrypted,
      label,
      is_active,
      read_only_permissions,
      read_only_verified_at,
      published_sync_generation,
      last_synced_at
    ) VALUES (
      p_user_id,
      p_exchange,
      p_api_key_encrypted,
      p_api_secret_encrypted,
      p_api_passphrase_encrypted,
      p_label,
      true,
      p_read_only_permissions,
      v_verified_at,
      0,
      NULL
    )
    RETURNING portfolio.* INTO v_portfolio;
  EXCEPTION
    WHEN unique_violation THEN
      -- Never silently replace a possibly different exchange account or erase
      -- its financial history. The user must explicitly remove the old label.
      RETURN pg_catalog.jsonb_build_object('status', 'already_exists');
  END;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'saved',
    'user_id', v_portfolio.user_id,
    'portfolio_id', v_portfolio.id,
    'exchange', v_portfolio.exchange,
    'label', v_portfolio.label,
    'credential_generation', v_portfolio.credential_generation,
    'created_at', v_portfolio.created_at
  );
END
$function$;

-- Replace the old generation-only claim. The service receives credentials only
-- after the canonical active-account lock and portfolio row lock are held.
CREATE OR REPLACE FUNCTION public.claim_portfolio_sync_generation_atomic(
  p_actor_id uuid,
  p_portfolio_id uuid
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
  v_portfolio public.user_portfolios%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;
  IF p_actor_id IS NULL OR p_portfolio_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  BEGIN
    PERFORM public.lock_trader_claim_principals_internal(
      ARRAY[p_actor_id]::uuid[],
      true
    );
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'missing_account');
    WHEN SQLSTATE '22023' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'suspended');
  END;

  SELECT portfolio.*
  INTO v_portfolio
  FROM public.user_portfolios AS portfolio
  WHERE portfolio.id = p_portfolio_id
    AND portfolio.user_id = p_actor_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_portfolio.is_active IS DISTINCT FROM true THEN
    RETURN pg_catalog.jsonb_build_object('status', 'inactive');
  END IF;
  IF v_portfolio.sync_generation = 9223372036854775807 THEN
    RAISE EXCEPTION 'portfolio sync generation exhausted'
      USING ERRCODE = '54000';
  END IF;

  UPDATE public.user_portfolios AS portfolio
  SET sync_generation = portfolio.sync_generation + 1
  WHERE portfolio.id = v_portfolio.id
    AND portfolio.user_id = p_actor_id
    AND portfolio.is_active = true
    AND portfolio.credential_generation = v_portfolio.credential_generation
  RETURNING portfolio.* INTO STRICT v_portfolio;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'claimed',
    'user_id', v_portfolio.user_id,
    'portfolio_id', v_portfolio.id,
    'exchange', v_portfolio.exchange,
    'generation', v_portfolio.sync_generation,
    'credential_generation', v_portfolio.credential_generation,
    'api_key_encrypted', v_portfolio.api_key_encrypted,
    'api_secret_encrypted', v_portfolio.api_secret_encrypted,
    'api_passphrase_encrypted', v_portfolio.api_passphrase_encrypted
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.publish_active_portfolio_sync_atomic(
  p_actor_id uuid,
  p_portfolio_id uuid,
  p_generation bigint,
  p_credential_generation bigint,
  p_synced_at timestamptz,
  p_positions jsonb,
  p_total_equity numeric,
  p_total_pnl numeric,
  p_total_pnl_pct numeric
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
  v_portfolio public.user_portfolios%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;
  IF p_actor_id IS NULL
     OR p_portfolio_id IS NULL
     OR p_generation IS NULL
     OR p_generation <= 0
     OR p_credential_generation IS NULL
     OR p_credential_generation <= 0
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  BEGIN
    PERFORM public.lock_trader_claim_principals_internal(
      ARRAY[p_actor_id]::uuid[],
      true
    );
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'missing_account');
    WHEN SQLSTATE '22023' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'suspended');
  END;

  SELECT portfolio.*
  INTO v_portfolio
  FROM public.user_portfolios AS portfolio
  WHERE portfolio.id = p_portfolio_id
    AND portfolio.user_id = p_actor_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_portfolio.is_active IS DISTINCT FROM true THEN
    RETURN pg_catalog.jsonb_build_object('status', 'inactive');
  END IF;
  IF v_portfolio.credential_generation IS DISTINCT FROM
       p_credential_generation
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'superseded',
      'generation', p_generation,
      'current_generation', v_portfolio.sync_generation,
      'credential_generation', p_credential_generation,
      'current_credential_generation', v_portfolio.credential_generation
    );
  END IF;

  -- Locks acquired above remain held while the proven generation-only writer
  -- performs its validated, rollback-safe financial publication.
  RETURN public.publish_portfolio_sync_atomic(
    p_actor_id,
    p_portfolio_id,
    p_generation,
    p_synced_at,
    p_positions,
    p_total_equity,
    p_total_pnl,
    p_total_pnl_pct
  );
END
$function$;

ALTER FUNCTION public.save_user_portfolio_for_active_profile_atomic(
  uuid,
  text,
  text,
  text,
  text,
  text,
  jsonb
) OWNER TO postgres;
ALTER FUNCTION public.claim_portfolio_sync_generation_atomic(uuid, uuid)
  OWNER TO postgres;
ALTER FUNCTION public.publish_active_portfolio_sync_atomic(
  uuid,
  uuid,
  bigint,
  bigint,
  timestamptz,
  jsonb,
  numeric,
  numeric,
  numeric
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.save_user_portfolio_for_active_profile_atomic(
  uuid,
  text,
  text,
  text,
  text,
  text,
  jsonb
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.claim_portfolio_sync_generation_atomic(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.publish_active_portfolio_sync_atomic(
  uuid,
  uuid,
  bigint,
  bigint,
  timestamptz,
  jsonb,
  numeric,
  numeric,
  numeric
) FROM PUBLIC, anon, authenticated, service_role, authenticator;

-- The old generation-only publication has no account/credential fence. Keep it
-- callable by the postgres-owned wrapper, but close it to every API role.
REVOKE ALL ON FUNCTION public.publish_portfolio_sync_atomic(
  uuid,
  uuid,
  bigint,
  timestamptz,
  jsonb,
  numeric,
  numeric,
  numeric
) FROM PUBLIC, anon, authenticated, service_role, authenticator;

GRANT EXECUTE ON FUNCTION public.save_user_portfolio_for_active_profile_atomic(
  uuid,
  text,
  text,
  text,
  text,
  text,
  jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_portfolio_sync_generation_atomic(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_active_portfolio_sync_atomic(
  uuid,
  uuid,
  bigint,
  bigint,
  timestamptz,
  jsonb,
  numeric,
  numeric,
  numeric
) TO service_role;

-- Server authorities are the only mutation boundary. Browser reads remain
-- owner-scoped through RLS, and credential ciphertext is not selectable.
DROP POLICY IF EXISTS "Users can manage own portfolios"
  ON public.user_portfolios;
CREATE POLICY "Users can manage own portfolios"
  ON public.user_portfolios
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can view own positions"
  ON public.user_positions;
CREATE POLICY "Users can view own positions"
  ON public.user_positions
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    portfolio_id IN (
      SELECT portfolio.id
      FROM public.user_portfolios AS portfolio
      WHERE portfolio.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Users can view own snapshots"
  ON public.user_portfolio_snapshots;
CREATE POLICY "Users can view own snapshots"
  ON public.user_portfolio_snapshots
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    portfolio_id IN (
      SELECT portfolio.id
      FROM public.user_portfolios AS portfolio
      WHERE portfolio.user_id = (SELECT auth.uid())
    )
  );

REVOKE ALL PRIVILEGES ON TABLE public.user_portfolios
  FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL PRIVILEGES ON TABLE public.user_positions
  FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL PRIVILEGES ON TABLE public.user_portfolio_snapshots
  FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL PRIVILEGES ON TABLE public.user_portfolios FROM service_role;
REVOKE ALL PRIVILEGES ON TABLE public.user_positions FROM service_role;
REVOKE ALL PRIVILEGES ON TABLE public.user_portfolio_snapshots FROM service_role;

GRANT SELECT (
  id,
  user_id,
  exchange,
  label,
  created_at,
  is_active,
  credential_generation,
  sync_generation,
  published_sync_generation,
  last_synced_at,
  read_only_permissions,
  read_only_verified_at
) ON public.user_portfolios TO authenticated;
GRANT SELECT ON public.user_positions TO authenticated;
GRANT SELECT ON public.user_portfolio_snapshots TO authenticated;
GRANT SELECT, DELETE ON public.user_portfolios TO service_role;
GRANT SELECT ON public.user_positions TO service_role;
-- The existing daily rollup still inserts snapshots directly. Credential and
-- live-position writes remain confined to postgres-owned atomic authorities.
GRANT SELECT, INSERT ON public.user_portfolio_snapshots TO service_role;

COMMENT ON COLUMN public.user_portfolios.is_active IS
  'False after account inactivity or until a fresh read-only proof is saved.';
COMMENT ON COLUMN public.user_portfolios.credential_generation IS
  'Monotonic fence bumped when portfolio owner, exchange, credential, proof, or active status changes.';
COMMENT ON FUNCTION public.save_user_portfolio_for_active_profile_atomic(
  uuid,
  text,
  text,
  text,
  text,
  text,
  jsonb
) IS
  'Stores a new verified read-only portfolio credential under canonical active-account locks without replacing or deleting an existing portfolio.';
COMMENT ON FUNCTION public.claim_portfolio_sync_generation_atomic(uuid, uuid) IS
  'Claims one sync generation and returns its active credential only under canonical account lifecycle locks.';
COMMENT ON FUNCTION public.publish_active_portfolio_sync_atomic(
  uuid,
  uuid,
  bigint,
  bigint,
  timestamptz,
  jsonb,
  numeric,
  numeric,
  numeric
) IS
  'Publishes a portfolio financial snapshot only while account, portfolio, sync generation, and credential generation remain current.';

DO $postflight$
DECLARE
  v_function record;
  v_role name;
  v_source text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_portfolios'::pg_catalog.regclass
      AND trigger_row.tgname = 'aaa_bump_portfolio_credential_generation'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgfoid =
        'public.bump_portfolio_credential_generation()'::pg_catalog.regprocedure
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_profiles'::pg_catalog.regclass
      AND trigger_row.tgname = 'zzz_quiesce_inactive_user_portfolios'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgfoid =
        'public.quiesce_inactive_user_portfolios()'::pg_catalog.regprocedure
  ) THEN
    RAISE EXCEPTION 'portfolio lifecycle trigger postflight failed';
  END IF;

  FOR v_function IN
    SELECT *
    FROM (
      VALUES
        (
          'public.save_user_portfolio_for_active_profile_atomic(uuid,text,text,text,text,text,jsonb)',
          true,
          true
        ),
        (
          'public.claim_portfolio_sync_generation_atomic(uuid,uuid)',
          true,
          true
        ),
        (
          'public.publish_active_portfolio_sync_atomic(uuid,uuid,bigint,bigint,timestamptz,jsonb,numeric,numeric,numeric)',
          true,
          true
        ),
        (
          'public.publish_portfolio_sync_atomic(uuid,uuid,bigint,timestamptz,jsonb,numeric,numeric,numeric)',
          false,
          false
        ),
        (
          'public.portfolio_ciphertext_valid_internal(text)',
          false,
          false
        ),
        (
          'public.portfolio_permissions_valid_internal(jsonb)',
          false,
          false
        )
    ) AS required(function_identity, service_executable, lifecycle_locked)
  LOOP
    IF pg_catalog.to_regprocedure(v_function.function_identity) IS NULL THEN
      RAISE EXCEPTION 'portfolio lifecycle function missing: %',
        v_function.function_identity;
    END IF;

    SELECT pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(v_function.function_identity)
    ) INTO v_source;
    IF v_function.lifecycle_locked
       AND pg_catalog.strpos(
         v_source,
         'lock_trader_claim_principals_internal'
       ) = 0
    THEN
      RAISE EXCEPTION 'portfolio authority omitted lifecycle lock: %',
        v_function.function_identity;
    END IF;

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

  IF pg_catalog.has_column_privilege(
       'authenticated',
       'public.user_portfolios',
       'api_key_encrypted',
       'SELECT'
     )
     OR pg_catalog.has_column_privilege(
       'authenticated',
       'public.user_portfolios',
       'api_secret_encrypted',
       'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'public.user_portfolios', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'public.user_portfolios', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'public.user_portfolios', 'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'public.user_positions', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'public.user_positions', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'public.user_positions', 'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'public.user_portfolio_snapshots', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'public.user_portfolio_snapshots', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'public.user_portfolio_snapshots', 'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'public.user_portfolios', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'public.user_portfolios', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'public.user_positions', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'public.user_positions', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'public.user_positions', 'DELETE'
     )
  THEN
    RAISE EXCEPTION 'portfolio credential/publication boundary drifted';
  END IF;
END
$postflight$;

COMMIT;
