-- Project the exchange-reported account equity from a successful lifecycle-
-- fenced sync. Leveraged position notional is exposure, never account equity.
-- Legacy snapshots have mixed provenance, so only snapshots marked by this
-- atomic publication transaction may feed the user-facing equity series.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('public.portfolio-exchange-equity:v1', 0)
);

DO $preflight$
DECLARE
  v_portfolio_columns integer;
  v_snapshot_columns integer;
  v_function record;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer < 170000 THEN
    RAISE EXCEPTION 'portfolio equity projection requires PostgreSQL 17';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regprocedure(
          'public.lock_trader_claim_principals_internal(uuid[],boolean)'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'public.publish_active_portfolio_sync_atomic(uuid,uuid,bigint,bigint,timestamp with time zone,jsonb,numeric,numeric,numeric)'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'public.publish_portfolio_sync_atomic(uuid,uuid,bigint,timestamp with time zone,jsonb,numeric,numeric,numeric)'
        ) IS NULL
  THEN
    RAISE EXCEPTION 'portfolio lifecycle publication authority is incomplete';
  END IF;

  IF pg_catalog.to_regclass('public.user_portfolios') IS NULL
     OR pg_catalog.to_regclass('public.user_portfolio_snapshots') IS NULL
  THEN
    RAISE EXCEPTION 'portfolio equity projection tables are incomplete';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_portfolio_columns
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.user_portfolios'::pg_catalog.regclass
    AND attribute.attname IN (
      'current_equity',
      'current_pnl',
      'current_pnl_pct',
      'current_equity_at',
      'current_equity_generation'
    )
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT pg_catalog.count(*)::integer
  INTO v_snapshot_columns
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid =
        'public.user_portfolio_snapshots'::pg_catalog.regclass
    AND attribute.attname = 'snapshot_source'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF v_portfolio_columns NOT IN (0, 5) OR v_snapshot_columns NOT IN (0, 1) THEN
    RAISE EXCEPTION 'portfolio equity projection columns were partially applied';
  END IF;

  FOR v_function IN
    SELECT *
    FROM (
      VALUES
        ('bump_portfolio_credential_generation', ''),
        ('enforce_portfolio_current_equity_commit', ''),
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
      RAISE EXCEPTION 'unexpected portfolio equity overload exists: %',
        v_function.function_name;
    END IF;
  END LOOP;
END
$preflight$;

LOCK TABLE public.user_portfolios IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.user_portfolio_snapshots IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.user_portfolios
  ADD COLUMN IF NOT EXISTS current_equity numeric,
  ADD COLUMN IF NOT EXISTS current_pnl numeric,
  ADD COLUMN IF NOT EXISTS current_pnl_pct numeric,
  ADD COLUMN IF NOT EXISTS current_equity_at timestamptz,
  ADD COLUMN IF NOT EXISTS current_equity_generation bigint NOT NULL DEFAULT 0;

ALTER TABLE public.user_portfolios
  ALTER COLUMN current_equity_generation SET DEFAULT 0,
  ALTER COLUMN current_equity_generation SET NOT NULL;

ALTER TABLE public.user_portfolio_snapshots
  ADD COLUMN IF NOT EXISTS snapshot_source text NOT NULL DEFAULT 'legacy_unverified';
ALTER TABLE public.user_portfolio_snapshots
  ALTER COLUMN snapshot_source SET DEFAULT 'legacy_unverified',
  ALTER COLUMN snapshot_source SET NOT NULL;

ALTER TABLE public.user_portfolios
  DROP CONSTRAINT IF EXISTS user_portfolios_current_equity_projection_valid;
ALTER TABLE public.user_portfolios
  ADD CONSTRAINT user_portfolios_current_equity_projection_valid
  CHECK (
    current_equity_generation >= 0
    AND (
      (
        current_equity_generation = 0
        AND current_equity IS NULL
        AND current_pnl IS NULL
        AND current_pnl_pct IS NULL
        AND current_equity_at IS NULL
      )
      OR (
        current_equity_generation > 0
        AND is_active = true
        -- The private generation writer advances published_sync_generation in
        -- the statement immediately before this wrapper advances the current
        -- projection. The transaction is atomic, so no lag is externally
        -- visible; <= keeps that intra-transaction intermediate row valid.
        AND current_equity_generation <= published_sync_generation
        AND current_equity IS NOT NULL
        AND current_equity >= 0
        AND current_equity::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND pg_catalog.abs(current_equity) <= 1000000000000000000::numeric
        AND current_pnl IS NOT NULL
        AND current_pnl::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND pg_catalog.abs(current_pnl) <= 1000000000000000000::numeric
        AND current_pnl_pct IS NOT NULL
        AND current_pnl_pct::text NOT IN ('NaN', 'Infinity', '-Infinity')
        AND pg_catalog.abs(current_pnl_pct) <= 1000000000::numeric
        AND current_equity_at IS NOT NULL
        AND current_equity_at <= last_synced_at
      )
    )
  ) NOT VALID;

ALTER TABLE public.user_portfolio_snapshots
  DROP CONSTRAINT IF EXISTS user_portfolio_snapshots_source_valid;
ALTER TABLE public.user_portfolio_snapshots
  ADD CONSTRAINT user_portfolio_snapshots_source_valid
  CHECK (snapshot_source IN ('legacy_unverified', 'exchange_sync')) NOT VALID;

ALTER TABLE public.user_portfolios
  VALIDATE CONSTRAINT user_portfolios_current_equity_projection_valid;
ALTER TABLE public.user_portfolio_snapshots
  VALIDATE CONSTRAINT user_portfolio_snapshots_source_valid;

-- Preserve the credential fence while ensuring any owner, credential, proof,
-- or active-state mutation also clears the financial projection that belonged
-- to the previous authority generation.
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
    NEW.current_equity := NULL;
    NEW.current_pnl := NULL;
    NEW.current_pnl_pct := NULL;
    NEW.current_equity_at := NULL;
    NEW.current_equity_generation := 0;
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

  NEW.current_equity := NULL;
  NEW.current_pnl := NULL;
  NEW.current_pnl_pct := NULL;
  NEW.current_equity_at := NULL;
  NEW.current_equity_generation := 0;

  IF OLD.credential_generation = 9223372036854775807 THEN
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

-- The generation-only writer and this projection wrapper use two consecutive
-- UPDATE statements in one transaction. Re-read the final tuple at deferred
-- constraint time so the temporary intra-transaction lag can never commit.
CREATE OR REPLACE FUNCTION public.enforce_portfolio_current_equity_commit()
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
  v_current_generation bigint;
  v_published_generation bigint;
  v_current_at timestamptz;
  v_last_synced_at timestamptz;
BEGIN
  IF TG_LEVEL IS DISTINCT FROM 'ROW'
     OR TG_WHEN IS DISTINCT FROM 'AFTER'
     OR TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
     OR TG_TABLE_NAME IS DISTINCT FROM 'user_portfolios'
     OR TG_OP NOT IN ('INSERT', 'UPDATE')
     OR TG_NAME IS DISTINCT FROM 'zzz_enforce_portfolio_current_equity_commit'
  THEN
    RAISE EXCEPTION 'portfolio equity constraint trigger is outside its contract'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    portfolio.current_equity_generation,
    portfolio.published_sync_generation,
    portfolio.current_equity_at,
    portfolio.last_synced_at
  INTO
    v_current_generation,
    v_published_generation,
    v_current_at,
    v_last_synced_at
  FROM public.user_portfolios AS portfolio
  WHERE portfolio.id = NEW.id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF v_current_generation > 0
     AND (
       v_current_generation IS DISTINCT FROM v_published_generation
       OR v_current_at IS DISTINCT FROM v_last_synced_at
     )
  THEN
    RAISE EXCEPTION 'portfolio equity projection is not current at commit'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.enforce_portfolio_current_equity_commit()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_portfolio_current_equity_commit()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

DROP TRIGGER IF EXISTS zzz_enforce_portfolio_current_equity_commit
  ON public.user_portfolios;
CREATE CONSTRAINT TRIGGER zzz_enforce_portfolio_current_equity_commit
  AFTER INSERT OR UPDATE ON public.user_portfolios
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_portfolio_current_equity_commit();

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
  v_result jsonb;
  v_snapshot_count integer;
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

  v_result := public.publish_portfolio_sync_atomic(
    p_actor_id,
    p_portfolio_id,
    p_generation,
    p_synced_at,
    p_positions,
    p_total_equity,
    p_total_pnl,
    p_total_pnl_pct
  );

  IF v_result ->> 'status' = 'published' THEN
    UPDATE public.user_portfolio_snapshots AS snapshot
    SET snapshot_source = 'exchange_sync'
    WHERE snapshot.portfolio_id = p_portfolio_id
      AND snapshot.snapshot_at = p_synced_at
      AND snapshot.total_equity = p_total_equity
      AND snapshot.total_pnl = p_total_pnl
      AND snapshot.total_pnl_pct = p_total_pnl_pct
      AND snapshot.snapshot_source = 'legacy_unverified';
    GET DIAGNOSTICS v_snapshot_count = ROW_COUNT;
    IF v_snapshot_count < 1 THEN
      RAISE EXCEPTION 'authoritative portfolio snapshot was not projected'
        USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.user_portfolios AS portfolio
    SET current_equity = p_total_equity,
        current_pnl = p_total_pnl,
        current_pnl_pct = p_total_pnl_pct,
        current_equity_at = p_synced_at,
        current_equity_generation = p_generation
    WHERE portfolio.id = p_portfolio_id
      AND portfolio.user_id = p_actor_id
      AND portfolio.is_active = true
      AND portfolio.credential_generation = p_credential_generation
      AND portfolio.sync_generation = p_generation
      AND portfolio.published_sync_generation = p_generation
      AND portfolio.last_synced_at = p_synced_at
    RETURNING portfolio.* INTO STRICT v_portfolio;
  END IF;

  RETURN v_result;
END
$function$;

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

GRANT SELECT (
  current_equity,
  current_pnl,
  current_pnl_pct,
  current_equity_at,
  current_equity_generation
) ON public.user_portfolios TO authenticated;

COMMENT ON COLUMN public.user_portfolios.current_equity IS
  'Latest exchange-reported account equity committed by a lifecycle-fenced sync; never derived from position notional.';
COMMENT ON COLUMN public.user_portfolios.current_equity_generation IS
  'Published sync generation that owns the current exchange equity projection, or zero when no current projection exists.';
COMMENT ON COLUMN public.user_portfolio_snapshots.snapshot_source IS
  'exchange_sync only when the lifecycle-fenced publication transaction marked the exchange-reported snapshot; legacy rows are not user-facing.';
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
  'Atomically publishes positions, an exchange-sourced equity snapshot, and the current equity projection while lifecycle and credential generations remain current.';

DO $postflight$
DECLARE
  v_source text;
  v_role name;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_portfolios'::pg_catalog.regclass
      AND trigger_row.tgname = 'aaa_bump_portfolio_credential_generation'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgfoid =
        'public.bump_portfolio_credential_generation()'::pg_catalog.regprocedure
  ) THEN
    RAISE EXCEPTION 'portfolio equity generation trigger postflight failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_portfolios'::pg_catalog.regclass
      AND trigger_row.tgname = 'zzz_enforce_portfolio_current_equity_commit'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgconstraint <> 0
      AND trigger_row.tgdeferrable
      AND trigger_row.tginitdeferred
      AND trigger_row.tgfoid =
        'public.enforce_portfolio_current_equity_commit()'::pg_catalog.regprocedure
  ) THEN
    RAISE EXCEPTION 'portfolio equity commit constraint postflight failed';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(
    'public.bump_portfolio_credential_generation()'::pg_catalog.regprocedure
  ) INTO v_source;
  IF pg_catalog.strpos(v_source, 'NEW.current_equity := NULL') = 0
     OR pg_catalog.strpos(v_source, 'NEW.current_equity_generation := 0') = 0
  THEN
    RAISE EXCEPTION 'portfolio authority mutation does not clear equity';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(
    'public.publish_active_portfolio_sync_atomic(uuid,uuid,bigint,bigint,timestamptz,jsonb,numeric,numeric,numeric)'::pg_catalog.regprocedure
  ) INTO v_source;
  IF pg_catalog.strpos(v_source, 'lock_trader_claim_principals_internal') = 0
     OR pg_catalog.strpos(v_source, 'current_equity = p_total_equity') = 0
     OR pg_catalog.strpos(v_source, 'snapshot_source = ''exchange_sync''') = 0
  THEN
    RAISE EXCEPTION 'portfolio equity publication postflight failed';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
  LOOP
    IF pg_catalog.has_function_privilege(
      v_role,
      'public.publish_active_portfolio_sync_atomic(uuid,uuid,bigint,bigint,timestamptz,jsonb,numeric,numeric,numeric)',
      'EXECUTE'
    ) THEN
      RAISE EXCEPTION '% can publish portfolio equity', v_role;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.publish_active_portfolio_sync_atomic(uuid,uuid,bigint,bigint,timestamptz,jsonb,numeric,numeric,numeric)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'service cannot publish portfolio equity';
  END IF;
END
$postflight$;

COMMIT;
