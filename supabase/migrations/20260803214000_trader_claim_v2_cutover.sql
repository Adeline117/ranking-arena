-- Phase B (post-deploy): irreversible trader-claim V2 cutoff.
--
-- Apply only after the V2 application has submitted and rejected/cancelled a
-- staging claim through the phase-A RPCs. Until this migration commits, old
-- immutable deployments and direct service-role table DML remain a security
-- gap. Once it commits, those old deployments fail closed.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('public.trader_claim:v2-cutover', 0)
);

DO $preflight$
DECLARE
  v_missing_roles text[];
  v_relation regclass;
  v_relation_owner name;
  v_unexpected_overloads text[];
BEGIN
  IF pg_catalog.to_regclass('public.trader_claims') IS NULL
     OR pg_catalog.to_regclass('public.verified_traders') IS NULL
     OR pg_catalog.to_regclass('public.user_linked_traders') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.user_exchange_connections') IS NULL
     OR pg_catalog.to_regclass('public.trader_authorizations') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL THEN
    RAISE EXCEPTION 'trader identity tables must exist before the V2 cutoff';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.trader_claims'::regclass,
      'public.trader_authorizations'::regclass,
      'public.user_exchange_connections'::regclass
    )
      AND relation.relkind IS DISTINCT FROM 'r'
  ) THEN
    RAISE EXCEPTION
      'Phase-B sweep relations must be ordinary tables for exact trigger inventory';
  END IF;

  FOREACH v_relation IN ARRAY ARRAY[
    'public.trader_claims'::regclass,
    'public.verified_traders'::regclass,
    'public.user_linked_traders'::regclass,
    'public.user_profiles'::regclass,
    'public.user_exchange_connections'::regclass,
    'public.trader_authorizations'::regclass,
    'arena.traders'::regclass
  ]::regclass[]
  LOOP
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    INTO STRICT v_relation_owner
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation;

    IF CURRENT_USER IS DISTINCT FROM v_relation_owner THEN
      RAISE EXCEPTION
        'Phase-B migration role must own % (expected %, got %)',
        v_relation,
        v_relation_owner,
        CURRENT_USER;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'auth.uid() must exist before linked-trader ACL convergence';
  END IF;

  IF pg_catalog.to_regprocedure('extensions.digest(text,text)') IS NULL THEN
    RAISE EXCEPTION 'extensions.digest(text,text) is required for canonical activation';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM (
         VALUES
           ('user_id', 'uuid'),
           ('trader_id', 'text'),
           ('source', 'text'),
           ('is_primary', 'bool')
       ) AS required_column(column_name, type_name)
       WHERE NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
         JOIN pg_catalog.pg_type AS type_row
           ON type_row.oid = attribute.atttypid
         WHERE attribute.attrelid = 'public.user_linked_traders'::regclass
           AND attribute.attname = required_column.column_name
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND type_row.typname = required_column.type_name
       )
     ) THEN
    RAISE EXCEPTION 'linked-trader identity columns are missing';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM (
         VALUES
           ('is_verified_trader', 'bool'),
           ('verified_trader_id', 'text'),
           ('verified_trader_source', 'text'),
           ('linked_trader_count', 'int4')
       ) AS required_column(column_name, type_name)
       WHERE NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
         JOIN pg_catalog.pg_type AS type_row
           ON type_row.oid = attribute.atttypid
         WHERE attribute.attrelid = 'public.user_profiles'::regclass
           AND attribute.attname = required_column.column_name
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND type_row.typname = required_column.type_name
       )
     ) THEN
    RAISE EXCEPTION 'profile trader-identity columns are missing';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = 'arena.sources'::regclass
         AND attribute.attname = 'meta'
         AND attribute.atttypid = 'jsonb'::regtype
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = 'arena.traders'::regclass
         AND attribute.attname = 'meta'
         AND attribute.atttypid = 'jsonb'::regtype
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
     ) THEN
    RAISE EXCEPTION 'Arena claimed-owner projection columns are missing';
  END IF;

  IF pg_catalog.to_regprocedure(
       'public.submit_trader_claim_v2(uuid,text,text,text,timestamptz,timestamptz,text,text)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.reject_trader_claim_v2(uuid,uuid,text)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.cancel_trader_claim_v2(uuid,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.activate_trader_claim(uuid,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.submit_trader_claim(uuid,text,text,text,jsonb)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.unlink_linked_trader(uuid,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.set_primary_linked_trader(uuid,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.arena_set_trader_claimed(text,text,uuid,boolean)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'phase-A, activation, and legacy RPCs must exist before the V2 cutoff';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = 'public.trader_claims'::regclass
         AND attribute.attname = 'submission_version'
         AND attribute.atttypid = 'smallint'::regtype
         AND attribute.attnotnull
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
     ) THEN
    RAISE EXCEPTION
      'phase-A typed submission_version must exist before the V2 cutoff';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM (
         VALUES
           ('permissions', 'jsonb'),
           ('status', 'text'),
           ('encrypted_api_key', 'text'),
           ('encrypted_api_secret', 'text'),
           ('read_only_verified_at', 'timestamptz'),
           ('last_verified_at', 'timestamptz'),
           ('verification_error', 'text'),
           ('updated_at', 'timestamptz')
       ) AS required_column(column_name, type_name)
       WHERE NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
         JOIN pg_catalog.pg_type AS type_row
           ON type_row.oid = attribute.atttypid
         WHERE attribute.attrelid = 'public.trader_authorizations'::regclass
           AND attribute.attname = required_column.column_name
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND type_row.typname = required_column.type_name
       )
     ) THEN
    RAISE EXCEPTION 'trader authorization trust columns are missing';
  END IF;

  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['anon', 'authenticated', 'service_role']::text[]
  ) AS required_role
  WHERE pg_catalog.to_regrole(required_role) IS NULL;

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'Supabase API roles are missing: %', v_missing_roles;
  END IF;

  WITH expected(proname, signature) AS (
    VALUES
      ('submit_trader_claim'::name, 'public.submit_trader_claim(uuid,text,text,text,jsonb)'::text),
      ('submit_trader_claim_v2'::name, 'public.submit_trader_claim_v2(uuid,text,text,text,timestamptz,timestamptz,text,text)'::text),
      ('reject_trader_claim_v2'::name, 'public.reject_trader_claim_v2(uuid,uuid,text)'::text),
      ('cancel_trader_claim_v2'::name, 'public.cancel_trader_claim_v2(uuid,uuid)'::text),
      ('activate_trader_claim'::name, 'public.activate_trader_claim(uuid,uuid)'::text),
      ('activate_trader_claim_v2'::name, 'public.activate_trader_claim_v2(uuid,uuid)'::text),
      ('set_primary_linked_trader'::name, 'public.set_primary_linked_trader(uuid,uuid)'::text),
      ('set_primary_linked_trader_v2'::name, 'public.set_primary_linked_trader_v2(uuid,uuid)'::text),
      ('unlink_linked_trader'::name, 'public.unlink_linked_trader(uuid,uuid)'::text),
      ('unlink_linked_trader_v2'::name, 'public.unlink_linked_trader_v2(uuid,uuid)'::text),
      ('arena_set_trader_claimed'::name, 'public.arena_set_trader_claimed(text,text,uuid,boolean)'::text),
      ('update_linked_trader_metadata_v1'::name, 'public.update_linked_trader_metadata_v1(uuid,uuid,boolean,text,boolean,integer)'::text),
      ('guard_trader_claim_activation_expiry'::name, 'public.guard_trader_claim_activation_expiry()'::text),
      ('guard_trader_authorization_v1_contract'::name, 'public.guard_trader_authorization_v1_contract()'::text),
      ('serialize_exchange_connection_v1_mutation'::name, 'public.serialize_exchange_connection_v1_mutation()'::text),
      ('guard_exchange_connection_authorization_v1_contract'::name, 'public.guard_exchange_connection_authorization_v1_contract()'::text),
      ('guard_user_profile_trader_identity_v1'::name, 'public.guard_user_profile_trader_identity_v1()'::text),
      ('guard_arena_trader_claimed_meta_v1'::name, 'public.guard_arena_trader_claimed_meta_v1()'::text),
      ('update_updated_at_column'::name, 'public.update_updated_at_column()'::text),
      ('update_trader_authorizations_updated_at'::name, 'public.update_trader_authorizations_updated_at()'::text)
  )
  SELECT pg_catalog.array_agg(
    pg_catalog.format(
      '%I(%s)',
      procedure_row.proname,
      pg_catalog.pg_get_function_identity_arguments(procedure_row.oid)
    )
    ORDER BY procedure_row.proname, procedure_row.oid
  )
  INTO v_unexpected_overloads
  FROM pg_catalog.pg_proc AS procedure_row
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = procedure_row.pronamespace
  WHERE namespace_row.nspname = 'public'
    AND procedure_row.proname IN (SELECT expected.proname FROM expected)
    AND NOT EXISTS (
      SELECT 1
      FROM expected
      WHERE expected.proname = procedure_row.proname
        AND procedure_row.oid IS NOT DISTINCT FROM
              pg_catalog.to_regprocedure(expected.signature)
    );

  IF v_unexpected_overloads IS NOT NULL THEN
    RAISE EXCEPTION
      'unexpected trader-claim cutoff overloads must be retired first: %',
      v_unexpected_overloads;
  END IF;
END
$preflight$;

-- Match the live activation transaction's row-lock order before taking the
-- account tables. Otherwise an in-flight activation can hold a claim row while
-- waiting on connection, as the cutoff holds connection while waiting on the
-- claim table. One ordered statement also makes future lock-order review
-- explicit.
LOCK TABLE public.trader_claims, public.verified_traders,
  public.user_linked_traders, public.user_profiles,
  public.user_exchange_connections, public.trader_authorizations,
  arena.traders
  IN ACCESS EXCLUSIVE MODE;

DO $pre_dml_trigger_inventory$
DECLARE
  v_unexpected_triggers text[];
BEGIN
  SELECT pg_catalog.array_agg(
    pg_catalog.format('%s.%I', trigger_row.tgrelid::regclass, trigger_row.tgname)
    ORDER BY trigger_row.tgrelid::regclass::text, trigger_row.tgname
  )
  INTO v_unexpected_triggers
  FROM pg_catalog.pg_trigger AS trigger_row
  WHERE trigger_row.tgrelid IN (
    'public.trader_claims'::regclass,
    'public.trader_authorizations'::regclass,
    'public.user_exchange_connections'::regclass
  )
    AND NOT trigger_row.tgisinternal
    AND NOT (
      (
        trigger_row.tgrelid = 'public.trader_claims'::regclass
        AND trigger_row.tgname IN (
          'trigger_trader_claims_updated_at',
          'trader_claim_activation_expiry_guard'
        )
      ) OR (
        trigger_row.tgrelid = 'public.trader_authorizations'::regclass
        AND trigger_row.tgname IN (
          'trigger_update_trader_authorizations_updated_at',
          'trader_authorization_v1_contract_guard'
        )
      ) OR (
        trigger_row.tgrelid =
            'public.user_exchange_connections'::regclass
        AND trigger_row.tgname IN (
          'trigger_user_exchange_connections_updated_at',
          'exchange_connection_v1_mutation_serializer',
          'exchange_connection_authorization_v1_contract_guard'
        )
      )
    );

  IF v_unexpected_triggers IS NOT NULL THEN
    RAISE EXCEPTION
      'unexpected claim-cutoff triggers must be retired before sweep DML: %',
      v_unexpected_triggers;
  END IF;
END
$pre_dml_trigger_inventory$;

-- Do not let a historical canonical-name trigger execute before its function
-- body and owner have been replaced by this cutoff. All five triggers are
-- rebuilt from reviewed definitions and postflighted to their exact event shape.
DROP TRIGGER IF EXISTS trigger_trader_claims_updated_at
  ON public.trader_claims;
DROP TRIGGER IF EXISTS trader_claim_activation_expiry_guard
  ON public.trader_claims;
DROP TRIGGER IF EXISTS trigger_update_trader_authorizations_updated_at
  ON public.trader_authorizations;
DROP TRIGGER IF EXISTS trader_authorization_v1_contract_guard
  ON public.trader_authorizations;
DROP TRIGGER IF EXISTS trigger_user_exchange_connections_updated_at
  ON public.user_exchange_connections;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  NEW.updated_at = pg_catalog.now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_trader_authorizations_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  NEW.updated_at = pg_catalog.now();
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.update_updated_at_column() OWNER TO CURRENT_USER;
ALTER FUNCTION public.update_trader_authorizations_updated_at()
  OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION public.update_updated_at_column()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.update_trader_authorizations_updated_at()
  FROM PUBLIC, anon, authenticated, service_role;

-- Quarantine every reviewable row not created by the typed V2 writer while
-- the table lock prevents a final concurrent legacy insert from escaping the
-- sweep. Already-verified history is deliberately left unchanged for owner
-- audit; it is never silently downgraded or deleted.
UPDATE public.trader_claims AS claim
SET status = 'expired',
    updated_at = pg_catalog.statement_timestamp()
WHERE claim.status IN ('pending', 'reviewing')
  AND (
    claim.submission_version IS DISTINCT FROM 2
    OR claim.verification_method IS DISTINCT FROM 'signature'
    OR pg_catalog.lower(pg_catalog.btrim(claim.source))
         NOT IN ('hyperliquid', 'gmx')
    OR NOT COALESCE(
      pg_catalog.jsonb_typeof(claim.verification_data) = 'object'
      AND claim.verification_data ?& ARRAY[
        'proof_version',
        'challenge_id',
        'domain',
        'challenge_issued_at',
        'challenge_expires_at',
        'verified_at',
        'message_sha256',
        'signature_sha256'
      ]::text[]
      AND claim.verification_data - ARRAY[
        'proof_version',
        'challenge_id',
        'domain',
        'challenge_issued_at',
        'challenge_expires_at',
        'verified_at',
        'message_sha256',
        'signature_sha256'
      ]::text[] = '{}'::jsonb
      AND claim.verification_data->>'proof_version' = 'arena-wallet-claim@2'
      AND claim.verification_data->>'domain' = 'www.arenafi.org'
      AND claim.verification_data->>'challenge_id' ~ '^[0-9a-f]{64}$'
      AND claim.verification_data->>'message_sha256' ~ '^[0-9a-f]{64}$'
      AND claim.verification_data->>'signature_sha256' ~ '^[0-9a-f]{64}$',
      false
    )
  );

-- Retire the legacy bind-wallet projection and every active authorization
-- that lacks the read-only credential attestation required by the current
-- first-party worker. These rows are account-sync state, never claim proof.
UPDATE public.trader_authorizations AS auth_row
SET status = 'revoked',
    permissions = CASE
      WHEN pg_catalog.jsonb_typeof(auth_row.permissions) = 'array'
       AND EXISTS (
         SELECT 1
         FROM pg_catalog.jsonb_array_elements_text(
           auth_row.permissions
         ) AS permission(value)
         WHERE pg_catalog.lower(permission.value) = 'wallet_owner'
       )
      THEN '[]'::jsonb
      ELSE auth_row.permissions
    END,
    encrypted_api_key = CASE
      WHEN auth_row.encrypted_api_key LIKE 'wallet:%' THEN 'retired-wallet-marker'
      ELSE auth_row.encrypted_api_key
    END,
    encrypted_api_secret = CASE
      WHEN auth_row.encrypted_api_secret LIKE 'signature_verified:%'
      THEN 'retired-wallet-marker'
      ELSE auth_row.encrypted_api_secret
    END,
    read_only_verified_at = CASE
      WHEN auth_row.read_only_verified_at
             > pg_catalog.statement_timestamp() + pg_catalog.make_interval(mins => 5)
      THEN NULL
      ELSE auth_row.read_only_verified_at
    END,
    verification_error = 'Retired authorization did not satisfy the V1 read-only account-sync contract',
    updated_at = pg_catalog.statement_timestamp()
WHERE (
    pg_catalog.jsonb_typeof(auth_row.permissions) = 'array'
    AND EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements_text(
        auth_row.permissions
      ) AS permission(value)
      WHERE pg_catalog.lower(permission.value) = 'wallet_owner'
    )
  )
  OR auth_row.encrypted_api_key LIKE 'wallet:%'
  OR auth_row.encrypted_api_secret LIKE 'signature_verified:%'
  OR (
    auth_row.status = 'active'
    AND (
      auth_row.read_only_verified_at IS NULL
      OR auth_row.last_verified_at IS NULL
      OR auth_row.read_only_verified_at
           > pg_catalog.statement_timestamp() + pg_catalog.make_interval(mins => 5)
      OR pg_catalog.btrim(auth_row.encrypted_api_key) = ''
      OR pg_catalog.btrim(auth_row.encrypted_api_secret) = ''
    )
  );

-- Phase B is also the final compatibility bridge for stacks that applied an
-- earlier authorization ACL migration before the continuous projection guard
-- existed. Quarantine every active credential consumer whose complete trust
-- material is not byte-for-byte projected by one active canonical connection.
WITH active_authorizations AS (
  SELECT
    auth_row.id,
    auth_row.user_id,
    auth_row.trader_id,
    auth_row.encrypted_api_key,
    auth_row.encrypted_api_secret,
    auth_row.encrypted_passphrase,
    auth_row.permissions,
    auth_row.read_only_verified_at,
    auth_row.last_verified_at,
    CASE
      WHEN auth_row.platform
             IN ('binance', 'binance_futures', 'binance_spot') THEN 'binance'
      WHEN auth_row.platform IN ('bybit', 'bybit_spot') THEN 'bybit'
      WHEN auth_row.platform IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
      WHEN auth_row.platform
             IN ('bitget', 'bitget_futures', 'bitget_spot') THEN 'bitget'
      ELSE NULL
    END AS canonical_exchange
  FROM public.trader_authorizations AS auth_row
  WHERE auth_row.status = 'active'
), unsafe_authorizations AS (
  SELECT candidate.id
  FROM active_authorizations AS candidate
  WHERE candidate.canonical_exchange IS NULL
     OR candidate.read_only_verified_at IS NULL
     OR candidate.last_verified_at IS NULL
     OR candidate.last_verified_at
          IS DISTINCT FROM candidate.read_only_verified_at
     OR candidate.read_only_verified_at
          > pg_catalog.statement_timestamp() + pg_catalog.make_interval(mins => 5)
     OR pg_catalog.btrim(candidate.encrypted_api_key) = ''
     OR pg_catalog.btrim(candidate.encrypted_api_secret) = ''
     OR pg_catalog.jsonb_typeof(candidate.permissions) <> 'array'
     OR pg_catalog.jsonb_array_length(candidate.permissions) = 0
     OR (
       candidate.canonical_exchange IN ('okx', 'bitget')
       AND (
         candidate.encrypted_passphrase IS NULL
         OR pg_catalog.btrim(candidate.encrypted_passphrase) = ''
       )
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.user_exchange_connections AS connection
       WHERE connection.user_id = candidate.user_id
         AND connection.exchange = candidate.canonical_exchange
         AND connection.verified_uid = candidate.trader_id
         AND connection.is_active IS TRUE
         AND connection.api_key_encrypted = candidate.encrypted_api_key
         AND connection.api_secret_encrypted = candidate.encrypted_api_secret
         AND connection.passphrase_encrypted
               IS NOT DISTINCT FROM candidate.encrypted_passphrase
         AND connection.scope_permissions
               IS NOT DISTINCT FROM candidate.permissions
         AND connection.last_verified_at
               IS NOT DISTINCT FROM candidate.read_only_verified_at
         AND connection.last_verified_at
               IS NOT DISTINCT FROM candidate.last_verified_at
     )
)
UPDATE public.trader_authorizations AS auth_row
SET status = 'revoked',
    verification_error =
      'Quarantined: credential projection diverged from canonical account connection',
    updated_at = pg_catalog.statement_timestamp()
WHERE auth_row.id IN (
  SELECT unsafe.id
  FROM unsafe_authorizations AS unsafe
);

-- Restore timestamp maintenance only after every quarantine sweep has written
-- its explicit statement timestamp. The invariant triggers stay absent until
-- their reviewed bodies are rebuilt below.
CREATE TRIGGER trigger_trader_claims_updated_at
  BEFORE UPDATE ON public.trader_claims
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trigger_update_trader_authorizations_updated_at
  BEFORE UPDATE ON public.trader_authorizations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_trader_authorizations_updated_at();
CREATE TRIGGER trigger_user_exchange_connections_updated_at
  BEFORE UPDATE ON public.user_exchange_connections
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Phase B restores these three Phase-A service capabilities. Rebuild their
-- reviewed definitions before ownership and ACL convergence so a substituted
-- owner cannot carry a modified body through the irreversible cutoff.
CREATE OR REPLACE FUNCTION public.submit_trader_claim_v2(
  p_user_id uuid,
  p_trader_id text,
  p_source text,
  p_challenge_id text,
  p_challenge_issued_at timestamptz,
  p_verified_at timestamptz,
  p_message_digest text,
  p_signature_digest text
)
RETURNS public.trader_claims
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_trader_id text := pg_catalog.btrim(p_trader_id);
  v_source text := pg_catalog.lower(pg_catalog.btrim(p_source));
  v_challenge_id text := pg_catalog.btrim(p_challenge_id);
  v_message_digest text := pg_catalog.btrim(p_message_digest);
  v_signature_digest text := pg_catalog.btrim(p_signature_digest);
  v_issued_iso text;
  v_expires_iso text;
  v_verified_iso text;
  v_expected_message text;
  v_verification_data jsonb;
  v_claim public.trader_claims%ROWTYPE;
BEGIN
  IF p_user_id IS NULL
     OR v_trader_id IS NULL
     OR v_source IS NULL
     OR v_challenge_id IS NULL
     OR p_challenge_issued_at IS NULL
     OR p_verified_at IS NULL
     OR v_message_digest IS NULL
     OR v_signature_digest IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'complete typed V2 wallet-claim attestation is required';
  END IF;

  -- V1 claim support is deliberately narrower than the ingestion matrix. The
  -- public leaderboard identity must be the exact wallet signing this proof.
  IF p_source IS DISTINCT FROM v_source
     OR v_source NOT IN ('hyperliquid', 'gmx') THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'unsupported V1 trader claim source';
  END IF;

  IF p_trader_id IS DISTINCT FROM v_trader_id
     OR v_trader_id IS DISTINCT FROM pg_catalog.lower(v_trader_id)
     OR v_trader_id !~ '^0x[0-9a-f]{40}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'canonical EVM trader identity is required';
  END IF;

  IF v_challenge_id !~ '^[0-9a-f]{64}$'
     OR v_message_digest !~ '^[0-9a-f]{64}$'
     OR v_signature_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'canonical V2 challenge and digest fields are required';
  END IF;

  -- JavaScript challenges are emitted at millisecond precision. Rejecting
  -- hidden sub-millisecond values keeps the DB reconstruction byte-exact.
  IF p_challenge_issued_at IS DISTINCT FROM
       pg_catalog.date_trunc('milliseconds', p_challenge_issued_at)
     OR p_verified_at IS DISTINCT FROM
       pg_catalog.date_trunc('milliseconds', p_verified_at)
     OR p_challenge_issued_at < v_now - pg_catalog.make_interval(mins => 5)
     OR p_challenge_issued_at > v_now + pg_catalog.make_interval(secs => 30)
     OR p_verified_at < p_challenge_issued_at
     OR p_verified_at >= p_challenge_issued_at + pg_catalog.make_interval(mins => 5)
     OR p_verified_at > v_now + pg_catalog.make_interval(secs => 30)
     OR v_now >= p_challenge_issued_at + pg_catalog.make_interval(mins => 5) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'V2 wallet challenge attestation is stale or inconsistent';
  END IF;

  v_issued_iso := pg_catalog.to_char(
    p_challenge_issued_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  v_expires_iso := pg_catalog.to_char(
    (p_challenge_issued_at + pg_catalog.make_interval(mins => 5))
      AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  v_verified_iso := pg_catalog.to_char(
    p_verified_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );

  v_expected_message :=
    'Arena Trader Claim' || E'\n' ||
    'Domain: www.arenafi.org' || E'\n' ||
    'User ID: ' || p_user_id::text || E'\n' ||
    'Source: ' || v_source || E'\n' ||
    'Trader ID: ' || v_trader_id || E'\n' ||
    'Nonce: ' || v_challenge_id || E'\n' ||
    'Issued At: ' || v_issued_iso || E'\n' ||
    'Expiration Time: ' || v_expires_iso;

  IF v_message_digest IS DISTINCT FROM pg_catalog.encode(
       extensions.digest(v_expected_message, 'sha256'),
       'hex'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'V2 wallet challenge message digest does not match its identity';
  END IF;

  -- The database, rather than the caller, owns the stored audit shape. These
  -- fields record the server verification result; they are not described as a
  -- separately verifiable cryptographic attestation.
  v_verification_data := pg_catalog.jsonb_build_object(
    'proof_version', 'arena-wallet-claim@2',
    'challenge_id', v_challenge_id,
    'domain', 'www.arenafi.org',
    'challenge_issued_at', v_issued_iso,
    'challenge_expires_at', v_expires_iso,
    'verified_at', v_verified_iso,
    'message_sha256', v_message_digest,
    'signature_sha256', v_signature_digest
  );

  UPDATE public.trader_claims AS claim
  SET status = 'expired',
      updated_at = v_now
  WHERE claim.trader_id = v_trader_id
    AND claim.source = v_source
    AND claim.status IN ('pending', 'reviewing')
    AND claim.created_at
          < v_now - pg_catalog.make_interval(days => 30);

  INSERT INTO public.trader_claims (
    user_id,
    trader_id,
    source,
    verification_method,
    verification_data,
    submission_version,
    status,
    created_at,
    updated_at
  ) VALUES (
    p_user_id,
    v_trader_id,
    v_source,
    'signature',
    v_verification_data,
    2,
    'reviewing',
    v_now,
    v_now
  )
  RETURNING * INTO STRICT v_claim;

  RETURN v_claim;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reject_trader_claim_v2(
  p_claim_id uuid,
  p_reviewer_id uuid,
  p_reject_reason text
)
RETURNS public.trader_claims
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_reason text := pg_catalog.btrim(p_reject_reason);
  v_claim public.trader_claims%ROWTYPE;
BEGIN
  IF p_claim_id IS NULL
     OR p_reviewer_id IS NULL
     OR v_reason IS NULL
     OR v_reason = ''
     OR pg_catalog.length(v_reason) > 500 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'claim id, reviewer id, and bounded rejection reason are required';
  END IF;

  UPDATE public.trader_claims AS claim
  SET status = 'rejected',
      reviewed_by = p_reviewer_id,
      reviewed_at = pg_catalog.statement_timestamp(),
      reject_reason = v_reason,
      updated_at = pg_catalog.statement_timestamp()
  WHERE claim.id = p_claim_id
    AND claim.status IN ('pending', 'reviewing')
  RETURNING * INTO v_claim;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'trader claim is no longer reviewable';
  END IF;

  RETURN v_claim;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_trader_claim_v2(
  p_claim_id uuid,
  p_user_id uuid
)
RETURNS public.trader_claims
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_claim public.trader_claims%ROWTYPE;
BEGIN
  IF p_claim_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'claim id and claimant id are required';
  END IF;

  -- Cancellation is terminal but audit-preserving; never delete the ownership
  -- proof or reuse the same row for a later attempt.
  UPDATE public.trader_claims AS claim
  SET status = 'rejected',
      reject_reason = 'Cancelled by claimant',
      updated_at = pg_catalog.statement_timestamp()
  WHERE claim.id = p_claim_id
    AND claim.user_id = p_user_id
    AND claim.status IN ('pending', 'reviewing')
  RETURNING * INTO v_claim;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'trader claim is no longer cancellable';
  END IF;

  RETURN v_claim;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_trader_authorization_v1_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_canonical_exchange text;
  v_connection_id uuid;
BEGIN
  IF pg_catalog.jsonb_typeof(NEW.permissions) = 'array'
     AND EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements_text(NEW.permissions)
         AS permission(value)
       WHERE pg_catalog.lower(permission.value) = 'wallet_owner'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'wallet_owner trader authorization is retired; use the reviewed claim flow';
  END IF;

  IF NEW.encrypted_api_key LIKE 'wallet:%'
     OR NEW.encrypted_api_secret LIKE 'signature_verified:%' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'retired bind-wallet pseudo-credentials are forbidden';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status = 'active'
     AND NEW.status = 'active'
     AND NEW.last_verified_at IS NOT DISTINCT FROM OLD.last_verified_at
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.platform IS NOT DISTINCT FROM OLD.platform
     AND NEW.trader_id IS NOT DISTINCT FROM OLD.trader_id
     AND NEW.encrypted_api_key IS NOT DISTINCT FROM OLD.encrypted_api_key
     AND NEW.encrypted_api_secret IS NOT DISTINCT FROM OLD.encrypted_api_secret
     AND NEW.encrypted_passphrase IS NOT DISTINCT FROM OLD.encrypted_passphrase
     AND NEW.permissions IS NOT DISTINCT FROM OLD.permissions
     AND NEW.read_only_verified_at IS NOT DISTINCT FROM OLD.read_only_verified_at
  THEN
    RETURN NEW;
  END IF;

  IF NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;

  v_canonical_exchange := CASE
    WHEN NEW.platform IN ('binance', 'binance_futures', 'binance_spot')
      THEN 'binance'
    WHEN NEW.platform IN ('bybit', 'bybit_spot') THEN 'bybit'
    WHEN NEW.platform IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
    WHEN NEW.platform IN ('bitget', 'bitget_futures', 'bitget_spot')
      THEN 'bitget'
    ELSE NULL
  END;

  IF v_canonical_exchange IS NULL
     OR NEW.read_only_verified_at IS NULL
     OR NEW.last_verified_at IS NULL
     OR NEW.read_only_verified_at
          > pg_catalog.statement_timestamp() + pg_catalog.make_interval(mins => 5)
     OR NEW.last_verified_at IS DISTINCT FROM NEW.read_only_verified_at
     OR pg_catalog.btrim(NEW.encrypted_api_key) = ''
     OR pg_catalog.btrim(NEW.encrypted_api_secret) = ''
     OR pg_catalog.jsonb_typeof(NEW.permissions) <> 'array'
     OR pg_catalog.jsonb_array_length(NEW.permissions) = 0
     OR (
       v_canonical_exchange IN ('okx', 'bitget')
       AND (
         NEW.encrypted_passphrase IS NULL
         OR pg_catalog.btrim(NEW.encrypted_passphrase) = ''
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'active trader authorization requires current read-only credential attestation';
  END IF;

  IF NOT pg_catalog.pg_try_advisory_xact_lock(
       pg_catalog.hashtextextended(
         'trader-account:' || NEW.user_id::text || ':' || v_canonical_exchange,
         0
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'account authorization changed concurrently; retry through the atomic binder';
  END IF;

  SELECT connection.id
  INTO v_connection_id
  FROM public.user_exchange_connections AS connection
  WHERE connection.user_id = NEW.user_id
    AND connection.exchange = v_canonical_exchange
    AND connection.verified_uid = NEW.trader_id
    AND connection.is_active IS TRUE
    AND connection.api_key_encrypted = NEW.encrypted_api_key
    AND connection.api_secret_encrypted = NEW.encrypted_api_secret
    AND connection.passphrase_encrypted
          IS NOT DISTINCT FROM NEW.encrypted_passphrase
    AND connection.scope_permissions IS NOT DISTINCT FROM NEW.permissions
    AND connection.last_verified_at
          IS NOT DISTINCT FROM NEW.read_only_verified_at
    AND connection.last_verified_at
          IS NOT DISTINCT FROM NEW.last_verified_at;

  IF v_connection_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'active trader authorization requires one exact active canonical account connection';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trader_authorization_v1_contract_guard
  ON public.trader_authorizations;
CREATE TRIGGER trader_authorization_v1_contract_guard
  BEFORE INSERT OR UPDATE ON public.trader_authorizations
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_trader_authorization_v1_contract();

REVOKE ALL ON FUNCTION public.guard_trader_authorization_v1_contract()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.serialize_exchange_connection_v1_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_user_id uuid;
  v_exchange text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.exchange IS DISTINCT FROM OLD.exchange
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'account connection identity is immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
    v_exchange := pg_catalog.lower(pg_catalog.btrim(OLD.exchange));
  ELSE
    v_user_id := NEW.user_id;
    v_exchange := pg_catalog.lower(pg_catalog.btrim(NEW.exchange));
  END IF;

  v_exchange := CASE
    WHEN v_exchange IN ('binance', 'binance_futures', 'binance_spot')
      THEN 'binance'
    WHEN v_exchange IN ('bybit', 'bybit_spot') THEN 'bybit'
    WHEN v_exchange IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
    WHEN v_exchange IN ('bitget', 'bitget_futures', 'bitget_spot')
      THEN 'bitget'
    ELSE NULL
  END;

  IF v_exchange IS NOT NULL
     AND NOT pg_catalog.pg_try_advisory_xact_lock(
       pg_catalog.hashtextextended(
         'trader-account:' || v_user_id::text || ':' || v_exchange,
         0
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'account connection changed concurrently; retry through the atomic lifecycle RPC';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS exchange_connection_v1_mutation_serializer
  ON public.user_exchange_connections;
CREATE TRIGGER exchange_connection_v1_mutation_serializer
  BEFORE INSERT OR UPDATE OR DELETE ON public.user_exchange_connections
  FOR EACH ROW
  EXECUTE FUNCTION public.serialize_exchange_connection_v1_mutation();

REVOKE ALL ON FUNCTION public.serialize_exchange_connection_v1_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_exchange_connection_authorization_v1_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_old_user_id uuid;
  v_old_exchange text;
  v_new_user_id uuid;
  v_new_exchange text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old_user_id := OLD.user_id;
    v_old_exchange := OLD.exchange;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new_user_id := NEW.user_id;
    v_new_exchange := NEW.exchange;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT
        auth_row.user_id,
        auth_row.trader_id,
        auth_row.encrypted_api_key,
        auth_row.encrypted_api_secret,
        auth_row.encrypted_passphrase,
        auth_row.permissions,
        auth_row.read_only_verified_at,
        auth_row.last_verified_at,
        CASE
          WHEN auth_row.platform
                 IN ('binance', 'binance_futures', 'binance_spot')
            THEN 'binance'
          WHEN auth_row.platform IN ('bybit', 'bybit_spot') THEN 'bybit'
          WHEN auth_row.platform IN ('okx', 'okx_futures', 'okx_spot')
            THEN 'okx'
          WHEN auth_row.platform
                 IN ('bitget', 'bitget_futures', 'bitget_spot')
            THEN 'bitget'
          ELSE NULL
        END AS canonical_exchange
      FROM public.trader_authorizations AS auth_row
      WHERE auth_row.status = 'active'
    ) AS candidate
    WHERE (
      (
        v_old_user_id IS NOT NULL
        AND candidate.user_id = v_old_user_id
        AND candidate.canonical_exchange = v_old_exchange
      ) OR (
        v_new_user_id IS NOT NULL
        AND candidate.user_id = v_new_user_id
        AND candidate.canonical_exchange = v_new_exchange
      )
    )
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_exchange_connections AS connection
        WHERE connection.user_id = candidate.user_id
          AND connection.exchange = candidate.canonical_exchange
          AND connection.verified_uid = candidate.trader_id
          AND connection.is_active IS TRUE
          AND connection.api_key_encrypted = candidate.encrypted_api_key
          AND connection.api_secret_encrypted = candidate.encrypted_api_secret
          AND connection.passphrase_encrypted
                IS NOT DISTINCT FROM candidate.encrypted_passphrase
          AND connection.scope_permissions
                IS NOT DISTINCT FROM candidate.permissions
          AND connection.last_verified_at
                IS NOT DISTINCT FROM candidate.read_only_verified_at
          AND connection.last_verified_at
                IS NOT DISTINCT FROM candidate.last_verified_at
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'account connection mutation would orphan an active trader authorization';
  END IF;

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS exchange_connection_authorization_v1_contract_guard
  ON public.user_exchange_connections;
CREATE CONSTRAINT TRIGGER exchange_connection_authorization_v1_contract_guard
  AFTER INSERT OR UPDATE OR DELETE ON public.user_exchange_connections
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_exchange_connection_authorization_v1_contract();

REVOKE ALL ON FUNCTION public.guard_exchange_connection_authorization_v1_contract()
  FROM PUBLIC, anon, authenticated, service_role;

-- Re-assert the July linked-trader server-write boundary under the same table
-- lock as the identity cutoff. Historical dashboard grants and unknown policy
-- names are converged dynamically instead of relying on a finite drop list.
ALTER TABLE public.user_linked_traders ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.user_linked_traders
  FROM PUBLIC, anon, authenticated, service_role;

DO $revoke_linked_trader_non_owner_table_acl$
DECLARE
  v_grantee oid;
  v_role_sql text;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl_entry
    WHERE relation.oid = 'public.user_linked_traders'::regclass
      AND acl_entry.grantee <> relation.relowner
  LOOP
    v_role_sql := CASE
      WHEN v_grantee = 0::oid THEN 'PUBLIC'
      ELSE pg_catalog.format(
        '%I',
        (SELECT role_row.rolname FROM pg_catalog.pg_roles AS role_row
         WHERE role_row.oid = v_grantee)
      )
    END;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.user_linked_traders FROM %s',
      v_role_sql
    );
  END LOOP;
END
$revoke_linked_trader_non_owner_table_acl$;

DO $revoke_linked_trader_column_privileges$
DECLARE
  v_column_list text;
  v_grantee oid;
  v_role_sql text;
BEGIN
  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', '
    ORDER BY attribute.attnum
  )
  INTO STRICT v_column_list
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.user_linked_traders'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  EXECUTE pg_catalog.format(
    'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
      || 'ON TABLE public.user_linked_traders '
      || 'FROM PUBLIC, anon, authenticated, service_role',
    v_column_list
  );

  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = attribute.attrelid
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = 'public.user_linked_traders'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> relation.relowner
  LOOP
    v_role_sql := CASE
      WHEN v_grantee = 0::oid THEN 'PUBLIC'
      ELSE pg_catalog.format(
        '%I',
        (SELECT role_row.rolname FROM pg_catalog.pg_roles AS role_row
         WHERE role_row.oid = v_grantee)
      )
    END;

    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
        || 'ON TABLE public.user_linked_traders FROM %2$s',
      v_column_list,
      v_role_sql
    );
  END LOOP;
END
$revoke_linked_trader_column_privileges$;

GRANT SELECT ON TABLE public.user_linked_traders TO authenticated;
GRANT SELECT ON TABLE public.user_linked_traders TO service_role;

DO $drop_linked_trader_policy_drift$
DECLARE
  v_policy_name name;
BEGIN
  FOR v_policy_name IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_linked_traders'::regclass
    ORDER BY policy.polname
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.user_linked_traders',
      v_policy_name
    );
  END LOOP;
END
$drop_linked_trader_policy_drift$;

CREATE POLICY "Authenticated users can view own linked traders"
  ON public.user_linked_traders
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Service role reads linked traders"
  ON public.user_linked_traders
  AS PERMISSIVE
  FOR SELECT
  TO service_role
  USING (true);

-- Metadata edits are the last legitimate non-claim browser-facing mutation.
-- Keep them behind a narrow service-only definer RPC so immutable deployments
-- cannot use direct service table DML to forge identity or primary state.
CREATE OR REPLACE FUNCTION public.update_linked_trader_metadata_v1(
  p_user_id uuid,
  p_link_id uuid,
  p_update_label boolean,
  p_label text,
  p_update_display_order boolean,
  p_display_order integer
)
RETURNS public.user_linked_traders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_link public.user_linked_traders%ROWTYPE;
  v_label text := CASE
    WHEN p_label IS NULL THEN NULL
    ELSE NULLIF(pg_catalog.btrim(p_label), '')
  END;
BEGIN
  IF p_user_id IS NULL OR p_link_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'linked-trader metadata owner and link id are required';
  END IF;

  IF p_update_label IS NULL
     OR p_update_display_order IS NULL
     OR (NOT p_update_label AND NOT p_update_display_order) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'at least one linked-trader metadata field must be selected';
  END IF;

  IF (NOT p_update_label AND p_label IS NOT NULL)
     OR (NOT p_update_display_order AND p_display_order IS NOT NULL) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'unselected linked-trader metadata parameters must be null';
  END IF;

  IF p_update_label
     AND p_label IS NOT NULL
     AND pg_catalog.char_length(pg_catalog.btrim(p_label)) > 50 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'linked-trader label is too long';
  END IF;

  IF p_update_display_order
     AND (
       p_display_order IS NULL
       OR p_display_order < 0
       OR p_display_order > 10000
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'linked-trader display order is invalid';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('linked-trader:' || p_user_id::text, 0)
  );

  SELECT linked.*
  INTO STRICT v_link
  FROM public.user_linked_traders AS linked
  WHERE linked.id = p_link_id
    AND linked.user_id = p_user_id
  FOR UPDATE;

  UPDATE public.user_linked_traders AS linked
  SET label = CASE WHEN p_update_label THEN v_label ELSE linked.label END,
      display_order = CASE
        WHEN p_update_display_order THEN p_display_order
        ELSE linked.display_order
      END,
      updated_at = pg_catalog.statement_timestamp()
  WHERE linked.id = v_link.id
    AND linked.user_id = p_user_id
  RETURNING linked.* INTO STRICT v_link;

  RETURN v_link;
END;
$function$;

REVOKE ALL ON FUNCTION public.update_linked_trader_metadata_v1(
  uuid,
  uuid,
  boolean,
  text,
  boolean,
  integer
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_linked_trader_metadata_v1(
  uuid,
  uuid,
  boolean,
  text,
  boolean,
  integer
) TO service_role;

-- Table and column mutation ACLs are independent, and either can preserve a
-- hostile writer. Converge every non-owner mutation grant, normalize the
-- service role to non-grantable CRUD, then restore only the established
-- browser self-service UPDATE surface. Trader identity remains RPC-owned.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.user_profiles
  FROM PUBLIC, anon, authenticated;

DO $converge_profile_trader_identity_acl$
DECLARE
  v_all_columns text;
  v_safe_columns text;
  v_grantee oid;
  v_role_sql text;
BEGIN
  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', '
    ORDER BY attribute.attnum
  )
  INTO STRICT v_all_columns
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.user_profiles'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl_entry
    WHERE relation.oid = 'public.user_profiles'::regclass
      AND acl_entry.grantee <> relation.relowner
      AND acl_entry.grantee <> pg_catalog.to_regrole('service_role')
      AND acl_entry.privilege_type = ANY(ARRAY[
        'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ]::text[])
  LOOP
    v_role_sql := CASE
      WHEN v_grantee = 0::oid THEN 'PUBLIC'
      ELSE pg_catalog.format(
        '%I',
        (SELECT role_row.rolname FROM pg_catalog.pg_roles AS role_row
         WHERE role_row.oid = v_grantee)
      )
    END;

    EXECUTE pg_catalog.format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER '
        || 'ON TABLE public.user_profiles FROM %s',
      v_role_sql
    );
  END LOOP;

  -- Remove dashboard drift such as WITH GRANT OPTION before rebuilding the
  -- exact service CRUD capability.
  REVOKE ALL PRIVILEGES ON TABLE public.user_profiles FROM service_role;

  EXECUTE pg_catalog.format(
    'REVOKE INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
      || 'ON TABLE public.user_profiles '
      || 'FROM PUBLIC, anon, authenticated',
    v_all_columns
  );

  -- Table-level REVOKE ALL does not touch pg_attribute ACLs. Remove every
  -- historical service column SELECT (including WITH GRANT OPTION) before the
  -- non-grantable table SELECT is restored below.
  EXECUTE pg_catalog.format(
    'REVOKE SELECT (%1$s) ON TABLE public.user_profiles FROM service_role',
    v_all_columns
  );

  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = attribute.attrelid
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = 'public.user_profiles'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> relation.relowner
      AND acl_entry.privilege_type = ANY(ARRAY[
        'INSERT', 'UPDATE', 'REFERENCES'
      ]::text[])
  LOOP
    v_role_sql := CASE
      WHEN v_grantee = 0::oid THEN 'PUBLIC'
      ELSE pg_catalog.format(
        '%I',
        (SELECT role_row.rolname FROM pg_catalog.pg_roles AS role_row
         WHERE role_row.oid = v_grantee)
      )
    END;

    EXECUTE pg_catalog.format(
      'REVOKE INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
        || 'ON TABLE public.user_profiles FROM %2$s',
      v_all_columns,
      v_role_sql
    );
  END LOOP;

  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', '
    ORDER BY attribute.attnum
  )
  INTO v_safe_columns
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.user_profiles'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
    AND attribute.attname = ANY(ARRAY[
      'handle',
      'bio',
      'avatar_url',
      'cover_url',
      'market_pairs',
      'notify_follow',
      'notify_like',
      'notify_comment',
      'notify_mention',
      'notify_message',
      'notify_trader_events',
      'show_followers',
      'show_following',
      'dm_permission',
      'email_digest',
      'settings_version',
      'show_pro_badge',
      'last_seen_at',
      'is_online',
      'interests',
      'onboarding_completed',
      'search_history'
    ]::name[]);

  IF v_safe_columns IS NOT NULL THEN
    EXECUTE pg_catalog.format(
      'GRANT UPDATE (%s) ON TABLE public.user_profiles TO authenticated',
      v_safe_columns
    );
  END IF;

  GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE public.user_profiles TO service_role;
END
$converge_profile_trader_identity_acl$;

-- Column ACLs alone cannot narrow an inherited/table-level service grant in a
-- stack that drifted after migration. Keep ordinary profile editing intact,
-- but reject non-neutral inserts, identity-changing updates, and deletion of
-- authoritative profiles unless a reviewed owner-definer RPC is executing.
CREATE OR REPLACE FUNCTION public.guard_user_profile_trader_identity_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_relation_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(relation.relowner)
  INTO STRICT v_relation_owner
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = 'public.user_profiles'::regclass;

  IF CURRENT_USER IS NOT DISTINCT FROM v_relation_owner THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.is_verified_trader IS NOT TRUE
       AND NEW.verified_trader_id IS NULL
       AND NEW.verified_trader_source IS NULL
       AND COALESCE(NEW.linked_trader_count, 0) = 0 THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.id IS NOT DISTINCT FROM OLD.id
       AND NEW.is_verified_trader IS NOT DISTINCT FROM OLD.is_verified_trader
       AND NEW.verified_trader_id IS NOT DISTINCT FROM OLD.verified_trader_id
       AND NEW.verified_trader_source
             IS NOT DISTINCT FROM OLD.verified_trader_source
       AND NEW.linked_trader_count
             IS NOT DISTINCT FROM OLD.linked_trader_count THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.is_verified_trader IS NOT TRUE
       AND OLD.verified_trader_id IS NULL
       AND OLD.verified_trader_source IS NULL
       AND COALESCE(OLD.linked_trader_count, 0) = 0 THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '42501',
    MESSAGE = 'trader identity profile fields are RPC-owned';
END;
$function$;

DROP TRIGGER IF EXISTS user_profile_trader_identity_v1_guard
  ON public.user_profiles;
CREATE TRIGGER user_profile_trader_identity_v1_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_user_profile_trader_identity_v1();

REVOKE ALL ON FUNCTION public.guard_user_profile_trader_identity_v1()
  FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.trader_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verified_traders ENABLE ROW LEVEL SECURITY;

-- Table and per-column ACLs are independent in PostgreSQL. Remove both before
-- rebuilding the exact read/RPC boundary.
REVOKE ALL PRIVILEGES ON TABLE public.trader_claims, public.verified_traders
  FROM PUBLIC, anon, authenticated, service_role;

DO $revoke_identity_non_owner_table_acl$
DECLARE
  v_acl record;
  v_role_sql text;
BEGIN
  FOR v_acl IN
    SELECT DISTINCT
      relation.relname AS relation_name,
      acl_entry.grantee
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl_entry
    WHERE relation.oid IN (
      'public.trader_claims'::regclass,
      'public.verified_traders'::regclass
    )
      AND acl_entry.grantee <> relation.relowner
    ORDER BY relation.relname, acl_entry.grantee
  LOOP
    v_role_sql := CASE
      WHEN v_acl.grantee = 0::oid THEN 'PUBLIC'
      ELSE pg_catalog.format(
        '%I',
        (SELECT role_row.rolname FROM pg_catalog.pg_roles AS role_row
         WHERE role_row.oid = v_acl.grantee)
      )
    END;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %s',
      v_acl.relation_name,
      v_role_sql
    );
  END LOOP;
END
$revoke_identity_non_owner_table_acl$;

DO $revoke_column_privileges$
DECLARE
  v_relation regclass;
  v_column_list text;
  v_grantee oid;
  v_role_sql text;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.trader_claims'::regclass,
    'public.verified_traders'::regclass
  ]::regclass[]
  LOOP
    SELECT pg_catalog.string_agg(
      pg_catalog.format('%I', attribute.attname),
      ', '
      ORDER BY attribute.attnum
    )
    INTO v_column_list
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF v_column_list IS NULL THEN
      RAISE EXCEPTION 'identity relation % has no columns to secure', v_relation;
    END IF;

    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
        || 'ON TABLE %2$s FROM PUBLIC, anon, authenticated, service_role',
      v_column_list,
      v_relation
    );

    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = attribute.attrelid
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee <> relation.relowner
    LOOP
      v_role_sql := CASE
        WHEN v_grantee = 0::oid THEN 'PUBLIC'
        ELSE pg_catalog.format(
          '%I',
          (SELECT role_row.rolname FROM pg_catalog.pg_roles AS role_row
           WHERE role_row.oid = v_grantee)
        )
      END;

      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
          || 'ON TABLE %2$s FROM %3$s',
        v_column_list,
        v_relation,
        v_role_sql
      );
    END LOOP;
  END LOOP;
END
$revoke_column_privileges$;

GRANT SELECT ON TABLE public.trader_claims
  TO authenticated, service_role;
GRANT SELECT ON TABLE public.verified_traders
  TO anon, authenticated, service_role;

-- The only remaining direct identity-table mutation is the existing scoped
-- profile editor. Column ACLs prevent it from changing ownership, verification
-- method/status, or capability flags. Activation retains owner-executed RPC
-- access for INSERT/UPDATE through SECURITY DEFINER.
GRANT UPDATE (
  display_name,
  bio,
  avatar_url,
  twitter_url,
  telegram_url,
  discord_url,
  website_url,
  can_receive_messages
) ON TABLE public.verified_traders TO service_role;

DO $replace_identity_policies$
DECLARE
  v_relation regclass;
  v_policy_name name;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.trader_claims'::regclass,
    'public.verified_traders'::regclass
  ]::regclass[]
  LOOP
    FOR v_policy_name IN
      SELECT policy.polname
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_relation
      ORDER BY policy.polname
    LOOP
      EXECUTE pg_catalog.format(
        'DROP POLICY %I ON %s',
        v_policy_name,
        v_relation
      );
    END LOOP;
  END LOOP;
END
$replace_identity_policies$;

CREATE POLICY "Authenticated users read own trader claims"
  ON public.trader_claims
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Service role reads trader claims"
  ON public.trader_claims
  AS PERMISSIVE
  FOR SELECT
  TO service_role
  USING (true);

CREATE POLICY "Public reads verified traders"
  ON public.verified_traders
  AS PERMISSIVE
  FOR SELECT
  TO anon, authenticated, service_role
  USING (true);

CREATE POLICY "Service role edits verified trader profile"
  ON public.verified_traders
  AS PERMISSIVE
  FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Old immutable deployments call this exact legacy signature. Removing its
-- capability, in addition to direct table DML, makes those deployments fail
-- closed even though they still possess the shared service-role credential.
REVOKE ALL ON FUNCTION public.submit_trader_claim(
  uuid, text, text, text, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.submit_trader_claim_v2(
  uuid, text, text, text, timestamptz, timestamptz, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reject_trader_claim_v2(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.cancel_trader_claim_v2(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.activate_trader_claim(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_trader_claim_activation_expiry()
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.submit_trader_claim_v2(
  uuid, text, text, text, timestamptz, timestamptz, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.reject_trader_claim_v2(uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_trader_claim_v2(uuid, uuid)
  TO service_role;

-- Keep all three primary-identity projections atomic. The historical helper
-- changed only the linked row and profile, leaving verified_traders.is_primary
-- stale until a later activation/unlink happened to repair it.
CREATE OR REPLACE FUNCTION public.set_primary_linked_trader_v2(
  p_user_id uuid,
  p_link_id uuid
)
RETURNS public.user_linked_traders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_target public.user_linked_traders%ROWTYPE;
  v_linked_count integer;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF p_user_id IS NULL OR p_link_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'user id and linked trader id are required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('linked-trader:' || p_user_id::text, 0)
  );

  PERFORM 1
  FROM public.user_linked_traders AS linked
  WHERE linked.user_id = p_user_id
  ORDER BY linked.id
  FOR UPDATE;

  SELECT linked.*
  INTO v_target
  FROM public.user_linked_traders AS linked
  WHERE linked.id = p_link_id
    AND linked.user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'linked trader not found';
  END IF;

  PERFORM 1
  FROM public.verified_traders AS verified
  WHERE verified.user_id = p_user_id
  ORDER BY verified.id
  FOR UPDATE;

  IF EXISTS (
       SELECT 1
       FROM public.user_linked_traders AS linked
       WHERE linked.user_id = p_user_id
         AND NOT EXISTS (
           SELECT 1
           FROM public.verified_traders AS verified
           WHERE verified.user_id = p_user_id
             AND verified.trader_id = linked.trader_id
             AND verified.source = linked.source
         )
     ) OR EXISTS (
       SELECT 1
       FROM public.verified_traders AS verified
       WHERE verified.user_id = p_user_id
         AND NOT EXISTS (
           SELECT 1
           FROM public.user_linked_traders AS linked
           WHERE linked.user_id = p_user_id
             AND linked.trader_id = verified.trader_id
             AND linked.source = verified.source
         )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'linked trader projection drift requires manual audit';
  END IF;

  PERFORM 1
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'user profile not found';
  END IF;

  -- The partial unique index is immediate, so clear the previous primary
  -- before promoting the target; one multi-row toggle can visit the target
  -- first and fail transiently even though the final state is unique.
  UPDATE public.user_linked_traders AS linked
  SET is_primary = false,
      updated_at = v_now
  WHERE linked.user_id = p_user_id
    AND linked.id <> p_link_id
    AND linked.is_primary IS TRUE;

  UPDATE public.user_linked_traders AS linked
  SET is_primary = true,
      updated_at = v_now
  WHERE linked.id = p_link_id
    AND linked.user_id = p_user_id
    AND linked.is_primary IS FALSE;

  UPDATE public.verified_traders AS verified
  SET is_primary = (
        verified.trader_id = v_target.trader_id
        AND verified.source = v_target.source
      ),
      updated_at = v_now
  WHERE verified.user_id = p_user_id
    AND verified.is_primary IS DISTINCT FROM (
      verified.trader_id = v_target.trader_id
      AND verified.source = v_target.source
    );

  SELECT pg_catalog.count(*)::integer
  INTO v_linked_count
  FROM public.user_linked_traders AS linked
  WHERE linked.user_id = p_user_id;

  UPDATE public.user_profiles AS profile
  SET is_verified_trader = true,
      verified_trader_id = v_target.trader_id,
      verified_trader_source = v_target.source,
      linked_trader_count = v_linked_count,
      updated_at = v_now
  WHERE profile.id = p_user_id;

  SELECT linked.*
  INTO STRICT v_target
  FROM public.user_linked_traders AS linked
  WHERE linked.id = p_link_id
    AND linked.user_id = p_user_id;

  RETURN v_target;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_primary_linked_trader(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_primary_linked_trader_v2(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_primary_linked_trader_v2(uuid, uuid)
  TO service_role;

-- Harden the shared Arena projection before exposing atomic unlink. Activation
-- may create a missing trader, but revocation must never create one or clear a
-- claim owned by somebody else. The owner check is performed under the Arena
-- row lock so a false projection rolls the caller's whole transaction back.
CREATE OR REPLACE FUNCTION public.arena_set_trader_claimed(
  p_platform text,
  p_trader_key text,
  p_user_id uuid,
  p_claimed boolean
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_platform text := pg_catalog.lower(pg_catalog.btrim(p_platform));
  v_trader_key text := pg_catalog.btrim(p_trader_key);
  v_source_id smallint;
  v_trader_id bigint;
  v_meta jsonb;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF p_user_id IS NULL
     OR p_claimed IS NULL
     OR v_platform IS NULL
     OR v_platform = ''
     OR v_trader_key IS NULL
     OR v_trader_key = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'complete Arena claimed projection identity is required';
  END IF;

  SELECT source_row.id
  INTO v_source_id
  FROM arena.sources AS source_row
  WHERE source_row.slug = v_platform
     OR source_row.meta->>'legacy_platform' = v_platform
  ORDER BY (source_row.slug = v_platform) DESC, source_row.id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'unknown Arena trader source';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'trader-claim:' || v_platform || ':' || v_trader_key,
      0
    )
  );

  IF p_claimed THEN
    INSERT INTO arena.traders (source_id, exchange_trader_id, meta)
    VALUES (v_source_id, v_trader_key, '{}'::jsonb)
    ON CONFLICT (source_id, exchange_trader_id) DO NOTHING;

    SELECT trader.id, trader.meta
    INTO v_trader_id, v_meta
    FROM arena.traders AS trader
    WHERE trader.source_id = v_source_id
      AND trader.exchange_trader_id = v_trader_key
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0002',
        MESSAGE = 'Arena trader projection was not created';
    END IF;

    IF v_meta->>'claimed' = 'true'
       AND v_meta->>'claimed_by_user_id' IS DISTINCT FROM p_user_id::text THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'Arena trader claim is owned by another user';
    END IF;

    UPDATE arena.traders AS trader
    SET meta = COALESCE(trader.meta, '{}'::jsonb)
      || pg_catalog.jsonb_build_object(
        'claimed', true,
        'claimed_at', v_now,
        'claimed_by_user_id', p_user_id::text
      )
    WHERE trader.id = v_trader_id;

    RETURN v_trader_id;
  END IF;

  SELECT trader.id, trader.meta
  INTO v_trader_id, v_meta
  FROM arena.traders AS trader
  WHERE trader.source_id = v_source_id
    AND trader.exchange_trader_id = v_trader_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'Arena trader claim projection is missing';
  END IF;

  IF v_meta->>'claimed' IS DISTINCT FROM 'true'
     OR v_meta->>'claimed_by_user_id' IS DISTINCT FROM p_user_id::text THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Arena trader claim projection is not owned by this user';
  END IF;

  UPDATE arena.traders AS trader
  SET meta = (
        COALESCE(trader.meta, '{}'::jsonb)
        - 'claimed_at'
        - 'claimed_by_user_id'
      ) || pg_catalog.jsonb_build_object('claimed', false)
  WHERE trader.id = v_trader_id;

  RETURN v_trader_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.arena_set_trader_claimed(
  text, text, uuid, boolean
) FROM PUBLIC, anon, authenticated, service_role;

-- Workers may legitimately update unrelated Arena metadata, so a blanket
-- table revoke would be unnecessarily disruptive. Reserve only the three
-- claimed-owner keys for the owner-executed helper above, including INSERT and
-- DELETE paths that could otherwise bypass an UPDATE-only guard.
CREATE OR REPLACE FUNCTION public.guard_arena_trader_claimed_meta_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_relation_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(relation.relowner)
  INTO STRICT v_relation_owner
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = 'arena.traders'::regclass;

  IF CURRENT_USER IS NOT DISTINCT FROM v_relation_owner THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.meta, '{}'::jsonb) ?| ARRAY[
         'claimed', 'claimed_at', 'claimed_by_user_id'
       ]::text[] THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'Arena claimed-owner metadata is RPC-owned';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF COALESCE(OLD.meta, '{}'::jsonb) ?| ARRAY[
         'claimed', 'claimed_at', 'claimed_by_user_id'
       ]::text[] THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'claimed Arena trader rows require canonical revocation';
    END IF;
    RETURN OLD;
  END IF;

  IF (COALESCE(NEW.meta, '{}'::jsonb) ? 'claimed')
       IS DISTINCT FROM (COALESCE(OLD.meta, '{}'::jsonb) ? 'claimed')
     OR NEW.meta->'claimed' IS DISTINCT FROM OLD.meta->'claimed'
     OR (COALESCE(NEW.meta, '{}'::jsonb) ? 'claimed_at')
       IS DISTINCT FROM (COALESCE(OLD.meta, '{}'::jsonb) ? 'claimed_at')
     OR NEW.meta->'claimed_at' IS DISTINCT FROM OLD.meta->'claimed_at'
     OR (COALESCE(NEW.meta, '{}'::jsonb) ? 'claimed_by_user_id')
       IS DISTINCT FROM (
         COALESCE(OLD.meta, '{}'::jsonb) ? 'claimed_by_user_id'
       )
     OR NEW.meta->'claimed_by_user_id'
       IS DISTINCT FROM OLD.meta->'claimed_by_user_id' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Arena claimed-owner metadata is RPC-owned';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS arena_trader_claimed_meta_v1_guard
  ON arena.traders;
CREATE TRIGGER arena_trader_claimed_meta_v1_guard
  BEFORE INSERT OR UPDATE OR DELETE ON arena.traders
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_arena_trader_claimed_meta_v1();

REVOKE ALL ON FUNCTION public.guard_arena_trader_claimed_meta_v1()
  FROM PUBLIC, anon, authenticated, service_role;

-- The approved-review entrypoint is fully rebuilt here rather than delegating
-- to the historical activator. Phase B therefore establishes its own atomic
-- projection contract even if an older stack drifted before this cutoff.
CREATE OR REPLACE FUNCTION public.activate_trader_claim_v2(
  p_claim_id uuid,
  p_reviewer_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_claim public.trader_claims%ROWTYPE;
  v_verified public.verified_traders%ROWTYPE;
  v_link public.user_linked_traders%ROWTYPE;
  v_primary public.user_linked_traders%ROWTYPE;
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_issued_at timestamptz;
  v_expires_at timestamptz;
  v_proof_verified_at timestamptz;
  v_expected_message text;
  v_linked_count integer;
  v_next_display_order integer;
  v_arena_trader_id bigint;
BEGIN
  IF p_claim_id IS NULL OR p_reviewer_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'claim id and reviewer id are required';
  END IF;

  SELECT claim.*
  INTO v_claim
  FROM public.trader_claims AS claim
  WHERE claim.id = p_claim_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'trader claim not found';
  END IF;

  IF v_claim.submission_version IS DISTINCT FROM 2
     OR v_claim.verification_method IS DISTINCT FROM 'signature'
     OR v_claim.source IS DISTINCT FROM pg_catalog.lower(
          pg_catalog.btrim(v_claim.source)
        )
     OR v_claim.source NOT IN ('hyperliquid', 'gmx')
     OR v_claim.trader_id IS DISTINCT FROM pg_catalog.lower(
          pg_catalog.btrim(v_claim.trader_id)
        )
     OR v_claim.trader_id !~ '^0x[0-9a-f]{40}$'
     OR v_claim.status NOT IN ('reviewing', 'verified') THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'trader claim is not eligible for V2 activation';
  END IF;

  IF v_claim.status = 'reviewing'
     AND v_claim.created_at
           < v_now - pg_catalog.make_interval(days => 30) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'trader claim is no longer reviewable';
  END IF;

  IF NOT COALESCE(
       pg_catalog.jsonb_typeof(v_claim.verification_data) = 'object'
       AND v_claim.verification_data ?& ARRAY[
         'proof_version',
         'challenge_id',
         'domain',
         'challenge_issued_at',
         'challenge_expires_at',
         'verified_at',
         'message_sha256',
         'signature_sha256'
       ]::text[]
       AND v_claim.verification_data - ARRAY[
         'proof_version',
         'challenge_id',
         'domain',
         'challenge_issued_at',
         'challenge_expires_at',
         'verified_at',
         'message_sha256',
         'signature_sha256'
       ]::text[] = '{}'::jsonb
       AND v_claim.verification_data->>'proof_version'
             = 'arena-wallet-claim@2'
       AND v_claim.verification_data->>'domain' = 'www.arenafi.org'
       AND v_claim.verification_data->>'challenge_id' ~ '^[0-9a-f]{64}$'
       AND v_claim.verification_data->>'message_sha256' ~ '^[0-9a-f]{64}$'
       AND v_claim.verification_data->>'signature_sha256' ~ '^[0-9a-f]{64}$'
       AND v_claim.verification_data->>'challenge_issued_at'
             ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
       AND v_claim.verification_data->>'challenge_expires_at'
             ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
       AND v_claim.verification_data->>'verified_at'
             ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$',
       false
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'trader claim V2 proof shape is invalid';
  END IF;

  -- A suffix-Z cast is timezone independent. Round-tripping through the exact
  -- millisecond format rejects PostgreSQL's otherwise permissive timestamp
  -- parser and proves the stored expiration/verification relations.
  v_issued_at := (
    v_claim.verification_data->>'challenge_issued_at'
  )::timestamptz;
  v_expires_at := (
    v_claim.verification_data->>'challenge_expires_at'
  )::timestamptz;
  v_proof_verified_at := (
    v_claim.verification_data->>'verified_at'
  )::timestamptz;

  IF NOT pg_catalog.isfinite(v_issued_at)
     OR NOT pg_catalog.isfinite(v_expires_at)
     OR NOT pg_catalog.isfinite(v_proof_verified_at)
     OR pg_catalog.to_char(
          v_issued_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) IS DISTINCT FROM v_claim.verification_data->>'challenge_issued_at'
     OR pg_catalog.to_char(
          v_expires_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) IS DISTINCT FROM v_claim.verification_data->>'challenge_expires_at'
     OR pg_catalog.to_char(
          v_proof_verified_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) IS DISTINCT FROM v_claim.verification_data->>'verified_at'
     OR v_expires_at IS DISTINCT FROM
          v_issued_at + pg_catalog.make_interval(mins => 5)
     OR v_proof_verified_at < v_issued_at
     OR v_proof_verified_at >= v_expires_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'trader claim V2 proof timestamps are inconsistent';
  END IF;

  v_expected_message :=
    'Arena Trader Claim' || E'\n' ||
    'Domain: www.arenafi.org' || E'\n' ||
    'User ID: ' || v_claim.user_id::text || E'\n' ||
    'Source: ' || v_claim.source || E'\n' ||
    'Trader ID: ' || v_claim.trader_id || E'\n' ||
    'Nonce: ' || (v_claim.verification_data->>'challenge_id') || E'\n' ||
    'Issued At: ' || (
      v_claim.verification_data->>'challenge_issued_at'
    ) || E'\n' ||
    'Expiration Time: ' || (
      v_claim.verification_data->>'challenge_expires_at'
    );

  IF v_claim.verification_data->>'message_sha256' IS DISTINCT FROM
       pg_catalog.encode(
         extensions.digest(v_expected_message, 'sha256'),
         'hex'
       ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'trader claim V2 proof does not match its identity';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'linked-trader:' || v_claim.user_id::text,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'trader-claim:' || v_claim.source || ':' || v_claim.trader_id,
      0
    )
  );

  PERFORM 1
  FROM public.user_profiles AS profile
  WHERE profile.id = v_claim.user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'user profile not found';
  END IF;

  SELECT verified.*
  INTO v_verified
  FROM public.verified_traders AS verified
  WHERE verified.trader_id = v_claim.trader_id
    AND verified.source = v_claim.source
  FOR UPDATE;

  IF FOUND AND v_verified.user_id <> v_claim.user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'trader identity is already verified by another user';
  END IF;

  IF FOUND THEN
    UPDATE public.verified_traders AS verified
    SET verification_method = 'signature',
        verified_at = COALESCE(verified.verified_at, v_now),
        updated_at = v_now
    WHERE verified.id = v_verified.id
    RETURNING verified.* INTO STRICT v_verified;
  ELSE
    INSERT INTO public.verified_traders (
      user_id,
      trader_id,
      source,
      verified_at,
      verification_method,
      is_primary
    ) VALUES (
      v_claim.user_id,
      v_claim.trader_id,
      v_claim.source,
      v_now,
      'signature',
      false
    )
    RETURNING * INTO STRICT v_verified;
  END IF;

  SELECT linked.*
  INTO v_link
  FROM public.user_linked_traders AS linked
  WHERE linked.trader_id = v_claim.trader_id
    AND linked.source = v_claim.source
  FOR UPDATE;

  IF FOUND AND v_link.user_id <> v_claim.user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'trader identity is already linked to another user';
  END IF;

  IF FOUND THEN
    UPDATE public.user_linked_traders AS linked
    SET verification_method = 'signature',
        verified_at = COALESCE(linked.verified_at, v_now),
        updated_at = v_now
    WHERE linked.id = v_link.id
    RETURNING linked.* INTO STRICT v_link;
  ELSE
    SELECT
      pg_catalog.count(*)::integer,
      COALESCE(pg_catalog.max(linked.display_order), -1) + 1
    INTO v_linked_count, v_next_display_order
    FROM public.user_linked_traders AS linked
    WHERE linked.user_id = v_claim.user_id;

    INSERT INTO public.user_linked_traders (
      user_id,
      trader_id,
      source,
      is_primary,
      display_order,
      verified_at,
      verification_method
    ) VALUES (
      v_claim.user_id,
      v_claim.trader_id,
      v_claim.source,
      v_linked_count = 0,
      v_next_display_order,
      v_now,
      'signature'
    )
    RETURNING * INTO STRICT v_link;
  END IF;

  -- Do not silently repair an ownership split unrelated to this claim. Every
  -- retained verified identity and linked identity must be an exact pair.
  IF EXISTS (
       SELECT 1
       FROM public.user_linked_traders AS linked
       WHERE linked.user_id = v_claim.user_id
         AND NOT EXISTS (
           SELECT 1
           FROM public.verified_traders AS verified
           WHERE verified.user_id = v_claim.user_id
             AND verified.trader_id = linked.trader_id
             AND verified.source = linked.source
         )
     ) OR EXISTS (
       SELECT 1
       FROM public.verified_traders AS verified
       WHERE verified.user_id = v_claim.user_id
         AND NOT EXISTS (
           SELECT 1
           FROM public.user_linked_traders AS linked
           WHERE linked.user_id = v_claim.user_id
             AND linked.trader_id = verified.trader_id
             AND linked.source = verified.source
         )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'linked trader projection drift requires manual audit';
  END IF;

  IF (
       SELECT pg_catalog.count(*)
       FROM public.user_linked_traders AS linked
       WHERE linked.user_id = v_claim.user_id
         AND linked.is_primary IS TRUE
     ) > 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'multiple primary linked traders require manual audit';
  END IF;

  SELECT linked.*
  INTO v_primary
  FROM public.user_linked_traders AS linked
  WHERE linked.user_id = v_claim.user_id
    AND linked.is_primary IS TRUE
  ORDER BY linked.display_order ASC NULLS LAST,
           linked.created_at ASC NULLS LAST,
           linked.id ASC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    SELECT linked.*
    INTO STRICT v_primary
    FROM public.user_linked_traders AS linked
    WHERE linked.user_id = v_claim.user_id
    ORDER BY linked.display_order ASC NULLS LAST,
             linked.created_at ASC NULLS LAST,
             linked.id ASC
    LIMIT 1
    FOR UPDATE;

    UPDATE public.user_linked_traders AS linked
    SET is_primary = true,
        updated_at = v_now
    WHERE linked.id = v_primary.id
    RETURNING linked.* INTO STRICT v_primary;
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_linked_count
  FROM public.user_linked_traders AS linked
  WHERE linked.user_id = v_claim.user_id;

  UPDATE public.verified_traders AS verified
  SET is_primary = (
        verified.trader_id = v_primary.trader_id
        AND verified.source = v_primary.source
      ),
      updated_at = v_now
  WHERE verified.user_id = v_claim.user_id
    AND verified.is_primary IS DISTINCT FROM (
      verified.trader_id = v_primary.trader_id
      AND verified.source = v_primary.source
    );

  UPDATE public.user_profiles AS profile
  SET is_verified_trader = true,
      verified_trader_id = v_primary.trader_id,
      verified_trader_source = v_primary.source,
      linked_trader_count = v_linked_count,
      updated_at = v_now
  WHERE profile.id = v_claim.user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'user profile not found';
  END IF;

  v_arena_trader_id := public.arena_set_trader_claimed(
    v_claim.source,
    v_claim.trader_id,
    v_claim.user_id,
    true
  );

  IF v_arena_trader_id IS NULL OR v_arena_trader_id <= 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'Arena trader claim projection was not created';
  END IF;

  -- The visible review state is committed last. Replays reconcile every
  -- projection but preserve the first successful reviewer and timestamps.
  UPDATE public.trader_claims AS claim
  SET status = 'verified',
      reviewed_by = COALESCE(claim.reviewed_by, p_reviewer_id),
      reviewed_at = COALESCE(claim.reviewed_at, v_now),
      verified_at = COALESCE(claim.verified_at, v_now),
      reject_reason = NULL,
      updated_at = v_now
  WHERE claim.id = v_claim.id
  RETURNING claim.* INTO STRICT v_claim;

  RETURN pg_catalog.jsonb_build_object(
    'claim', pg_catalog.to_jsonb(v_claim),
    'linked_trader_id', v_link.id,
    'primary_link_id', v_primary.id,
    'linked_count', v_linked_count,
    'authorization_id', NULL,
    'arena_trader_id', v_arena_trader_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.activate_trader_claim_v2(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.activate_trader_claim_v2(uuid, uuid)
  TO service_role;

-- Replace the historical link-only delete with one atomic ownership revocation.
-- The same identity keys that activation wrote are removed together, the
-- verified claim becomes terminal audit history, and Arena's claimed bit is
-- cleared before commit. Exact legacy CEX credentials are stopped only when the
-- source/trader identity proves the mapping; ambiguous historical connection
-- rows are deliberately left for the launch-time manual audit gate.
CREATE OR REPLACE FUNCTION public.unlink_linked_trader_v2(
  p_user_id uuid,
  p_link_id uuid
)
RETURNS TABLE (
  remaining_count integer,
  removed_trader_id text,
  removed_source text,
  promoted_link_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_existing public.user_linked_traders%ROWTYPE;
  v_verified public.verified_traders%ROWTYPE;
  v_primary public.user_linked_traders%ROWTYPE;
  v_remaining_count integer;
  v_promoted_link_id uuid;
  v_connection_exchange text;
  v_exact_connection boolean := false;
  v_arena_trader_id bigint;
  v_target_trader_id text;
  v_target_source text;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF p_user_id IS NULL OR p_link_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'user id and linked trader id are required';
  END IF;

  -- Resolve only enough immutable identity material to enter the shared lock
  -- namespaces. Ownership is re-read under row lock below.
  SELECT linked.*
  INTO v_existing
  FROM public.user_linked_traders AS linked
  WHERE linked.id = p_link_id
    AND linked.user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'linked trader not found';
  END IF;

  v_target_trader_id := v_existing.trader_id;
  v_target_source := v_existing.source;

  -- activate_trader_claim locks the claim row before entering the shared
  -- advisory namespaces. Match that order so an activation replay and an
  -- unlink cannot deadlock while each waits on the other's first lock.
  PERFORM 1
  FROM public.trader_claims AS claim
  WHERE claim.user_id = p_user_id
    AND claim.trader_id = v_target_trader_id
    AND claim.source = v_target_source
    AND claim.status IN ('pending', 'reviewing', 'verified')
  ORDER BY claim.id
  FOR UPDATE;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('linked-trader:' || p_user_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'trader-claim:' || v_target_source || ':' || v_target_trader_id,
      0
    )
  );

  SELECT linked.*
  INTO v_existing
  FROM public.user_linked_traders AS linked
  WHERE linked.id = p_link_id
    AND linked.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'linked trader not found';
  END IF;

  IF v_existing.trader_id IS DISTINCT FROM v_target_trader_id
     OR v_existing.source IS DISTINCT FROM v_target_source THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'linked trader identity changed during revocation';
  END IF;

  PERFORM 1
  FROM public.user_linked_traders AS linked
  WHERE linked.user_id = p_user_id
  ORDER BY linked.id
  FOR UPDATE;

  SELECT verified.*
  INTO v_verified
  FROM public.verified_traders AS verified
  WHERE verified.trader_id = v_existing.trader_id
    AND verified.source = v_existing.source
  FOR UPDATE;

  IF FOUND AND v_verified.user_id <> p_user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'verified trader identity is owned by another user';
  END IF;

  -- Every retained verified identity must have an exact retained link and vice
  -- versa. Do not guess how to repair historical projection drift during a user
  -- revocation; fail atomically so the owner audit can resolve it explicitly.
  IF EXISTS (
       SELECT 1
       FROM public.verified_traders AS verified
       WHERE verified.user_id = p_user_id
         AND NOT (
           verified.trader_id = v_existing.trader_id
           AND verified.source = v_existing.source
         )
         AND NOT EXISTS (
           SELECT 1
           FROM public.user_linked_traders AS linked
           WHERE linked.user_id = p_user_id
             AND linked.trader_id = verified.trader_id
             AND linked.source = verified.source
         )
     ) OR EXISTS (
       SELECT 1
       FROM public.user_linked_traders AS linked
       WHERE linked.user_id = p_user_id
         AND linked.id <> p_link_id
         AND NOT EXISTS (
           SELECT 1
           FROM public.verified_traders AS verified
           WHERE verified.user_id = p_user_id
             AND verified.trader_id = linked.trader_id
             AND verified.source = linked.source
         )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'linked trader projection drift requires manual audit';
  END IF;

  -- Activation takes the profile row before entering the account-credential
  -- control plane. Match that order so activate/unlink cannot deadlock on
  -- profile versus connection locks.
  PERFORM 1
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'user profile not found';
  END IF;

  IF v_existing.verification_method = 'api_key' THEN
    v_connection_exchange := CASE pg_catalog.lower(pg_catalog.btrim(v_existing.source))
      WHEN 'binance' THEN 'binance'
      WHEN 'binance_futures' THEN 'binance'
      WHEN 'binance_spot' THEN 'binance'
      WHEN 'bybit' THEN 'bybit'
      WHEN 'bybit_futures' THEN 'bybit'
      WHEN 'bybit_spot' THEN 'bybit'
      WHEN 'okx' THEN 'okx'
      WHEN 'okx_futures' THEN 'okx'
      WHEN 'okx_spot' THEN 'okx'
      WHEN 'bitget' THEN 'bitget'
      WHEN 'bitget_futures' THEN 'bitget'
      WHEN 'bitget_spot' THEN 'bitget'
      ELSE NULL
    END;
  END IF;

  IF v_connection_exchange IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'trader-account:' || p_user_id::text || ':' || v_connection_exchange,
        0
      )
    );

    -- Preserve the CEX control-plane lock order: lock the complete normalized
    -- connection family first, then every exactly matching authorization row.
    PERFORM 1
    FROM public.user_exchange_connections AS connection
    WHERE connection.user_id = p_user_id
      AND CASE
        WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
               IN ('binance', 'binance_futures', 'binance_spot') THEN 'binance'
        WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
               IN ('bybit', 'bybit_spot') THEN 'bybit'
        WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
               IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
        WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
               IN ('bitget', 'bitget_futures', 'bitget_spot') THEN 'bitget'
        ELSE NULL
      END = v_connection_exchange
    ORDER BY connection.id
    FOR UPDATE;

    SELECT EXISTS (
      SELECT 1
      FROM public.user_exchange_connections AS connection
      WHERE connection.user_id = p_user_id
        AND connection.verified_uid = v_existing.trader_id
        AND CASE
          WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
                 IN ('binance', 'binance_futures', 'binance_spot') THEN 'binance'
          WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
                 IN ('bybit', 'bybit_spot') THEN 'bybit'
          WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
                 IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
          WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
                 IN ('bitget', 'bitget_futures', 'bitget_spot') THEN 'bitget'
          ELSE NULL
        END = v_connection_exchange
    ) INTO v_exact_connection;

    PERFORM 1
    FROM public.trader_authorizations AS auth_row
    WHERE auth_row.user_id = p_user_id
      AND auth_row.trader_id = v_existing.trader_id
      AND CASE
        WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
               IN ('binance', 'binance_futures', 'binance_spot') THEN 'binance'
        WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
               IN ('bybit', 'bybit_futures', 'bybit_spot') THEN 'bybit'
        WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
               IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
        WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
               IN ('bitget', 'bitget_futures', 'bitget_spot') THEN 'bitget'
        ELSE NULL
      END = v_connection_exchange
    ORDER BY auth_row.id
    FOR UPDATE;

    IF v_exact_connection THEN
      UPDATE public.user_exchange_connections AS connection
      SET is_active = false,
          updated_at = v_now
      WHERE connection.user_id = p_user_id
        AND connection.verified_uid = v_existing.trader_id
        AND CASE
          WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
                 IN ('binance', 'binance_futures', 'binance_spot') THEN 'binance'
          WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
                 IN ('bybit', 'bybit_spot') THEN 'bybit'
          WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
                 IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
          WHEN pg_catalog.lower(pg_catalog.btrim(connection.exchange))
                 IN ('bitget', 'bitget_futures', 'bitget_spot') THEN 'bitget'
          ELSE NULL
        END = v_connection_exchange;
    END IF;

    UPDATE public.trader_authorizations AS auth_row
    SET status = 'revoked',
        verification_error = 'Revoked when the verified trader identity was unlinked',
        updated_at = v_now
    WHERE auth_row.user_id = p_user_id
      AND auth_row.trader_id = v_existing.trader_id
      AND CASE
        WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
               IN ('binance', 'binance_futures', 'binance_spot') THEN 'binance'
        WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
               IN ('bybit', 'bybit_futures', 'bybit_spot') THEN 'bybit'
        WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
               IN ('okx', 'okx_futures', 'okx_spot') THEN 'okx'
        WHEN pg_catalog.lower(pg_catalog.btrim(auth_row.platform))
               IN ('bitget', 'bitget_futures', 'bitget_spot') THEN 'bitget'
        ELSE NULL
      END = v_connection_exchange;
  END IF;

  -- Keep the proof as terminal audit history while freeing the active identity
  -- key and preventing a pending/reviewing or verified activation replay from
  -- rebuilding public authority after the unlink commits.
  UPDATE public.trader_claims AS claim
  SET status = 'rejected',
      reject_reason = 'Unlinked by claimant',
      updated_at = v_now
  WHERE claim.user_id = p_user_id
    AND claim.trader_id = v_existing.trader_id
    AND claim.source = v_existing.source
    AND claim.status IN ('pending', 'reviewing', 'verified');

  DELETE FROM public.verified_traders AS verified
  WHERE verified.user_id = p_user_id
    AND verified.trader_id = v_existing.trader_id
    AND verified.source = v_existing.source;

  DELETE FROM public.user_linked_traders AS linked
  WHERE linked.id = p_link_id
    AND linked.user_id = p_user_id;

  SELECT pg_catalog.count(*)::integer
  INTO v_remaining_count
  FROM public.user_linked_traders AS linked
  WHERE linked.user_id = p_user_id;

  IF v_remaining_count = 0 THEN
    IF EXISTS (
      SELECT 1
      FROM public.verified_traders AS verified
      WHERE verified.user_id = p_user_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0002',
        MESSAGE = 'verified trader projection remains without a linked identity';
    END IF;

    UPDATE public.user_profiles AS profile
    SET is_verified_trader = false,
        verified_trader_id = NULL,
        verified_trader_source = NULL,
        linked_trader_count = 0,
        updated_at = v_now
    WHERE profile.id = p_user_id;
  ELSE
    SELECT linked.*
    INTO v_primary
    FROM public.user_linked_traders AS linked
    WHERE linked.user_id = p_user_id
      AND linked.is_primary IS TRUE
    ORDER BY linked.display_order ASC NULLS LAST,
             linked.created_at ASC NULLS LAST,
             linked.id ASC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      SELECT linked.*
      INTO STRICT v_primary
      FROM public.user_linked_traders AS linked
      WHERE linked.user_id = p_user_id
      ORDER BY linked.display_order ASC NULLS LAST,
               linked.created_at ASC NULLS LAST,
               linked.id ASC
      LIMIT 1
      FOR UPDATE;

      UPDATE public.user_linked_traders AS linked
      SET is_primary = true,
          updated_at = v_now
      WHERE linked.id = v_primary.id;
      v_promoted_link_id := v_primary.id;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.verified_traders AS verified
      WHERE verified.user_id = p_user_id
        AND verified.trader_id = v_primary.trader_id
        AND verified.source = v_primary.source
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0002',
        MESSAGE = 'primary verified trader projection is missing';
    END IF;

    UPDATE public.verified_traders AS verified
    SET is_primary = (
          verified.trader_id = v_primary.trader_id
          AND verified.source = v_primary.source
        ),
        updated_at = v_now
    WHERE verified.user_id = p_user_id;

    UPDATE public.user_profiles AS profile
    SET is_verified_trader = true,
        verified_trader_id = v_primary.trader_id,
        verified_trader_source = v_primary.source,
        linked_trader_count = v_remaining_count,
        updated_at = v_now
    WHERE profile.id = p_user_id;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'user profile not found';
  END IF;

  v_arena_trader_id := public.arena_set_trader_claimed(
    v_existing.source,
    v_existing.trader_id,
    p_user_id,
    false
  );
  IF v_arena_trader_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'Arena trader claim projection was not revoked';
  END IF;

  RETURN QUERY
  SELECT
    v_remaining_count,
    v_existing.trader_id,
    v_existing.source,
    v_promoted_link_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.unlink_linked_trader(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.unlink_linked_trader_v2(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.unlink_linked_trader_v2(uuid, uuid)
  TO service_role;

COMMENT ON FUNCTION public.unlink_linked_trader(uuid, uuid) IS
  'Service-only atomic verified identity revocation across claim history, linked/verified/profile/Arena projections, and exactly mapped credentials.';

-- Reassert the activation gate at cutoff so an out-of-order/manual phase-A
-- deployment cannot leave the historical permissive trigger body installed.
CREATE OR REPLACE FUNCTION public.guard_trader_claim_activation_expiry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_claim_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(relation.relowner)
  INTO STRICT v_claim_owner
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = 'public.trader_claims'::regclass;

  IF (
       (TG_OP = 'INSERT' AND NEW.submission_version = 2)
       OR (TG_OP = 'DELETE' AND OLD.submission_version = 2)
       OR (
         TG_OP = 'UPDATE'
         AND (
           OLD.submission_version = 2
           OR NEW.submission_version = 2
         )
       )
     )
     AND CURRENT_USER IS DISTINCT FROM v_claim_owner THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'V2 trader claims may be written only through canonical RPCs';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'verified' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0002',
        MESSAGE = 'trader claims must enter review before activation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'verified' THEN
    IF NEW.submission_version IS DISTINCT FROM 2
       OR NEW.verification_method IS DISTINCT FROM 'signature'
       OR pg_catalog.lower(pg_catalog.btrim(NEW.source))
            NOT IN ('hyperliquid', 'gmx')
       OR NOT COALESCE(
         pg_catalog.jsonb_typeof(NEW.verification_data) = 'object'
         AND NEW.verification_data ?& ARRAY[
           'proof_version',
           'challenge_id',
           'domain',
           'challenge_issued_at',
           'challenge_expires_at',
           'verified_at',
           'message_sha256',
           'signature_sha256'
         ]::text[]
         AND NEW.verification_data - ARRAY[
           'proof_version',
           'challenge_id',
           'domain',
           'challenge_issued_at',
           'challenge_expires_at',
           'verified_at',
           'message_sha256',
           'signature_sha256'
         ]::text[] = '{}'::jsonb
         AND NEW.verification_data->>'proof_version' = 'arena-wallet-claim@2'
         AND NEW.verification_data->>'domain' = 'www.arenafi.org'
         AND NEW.verification_data->>'challenge_id' ~ '^[0-9a-f]{64}$'
         AND NEW.verification_data->>'message_sha256' ~ '^[0-9a-f]{64}$'
         AND NEW.verification_data->>'signature_sha256' ~ '^[0-9a-f]{64}$',
         false
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0002',
        MESSAGE = 'trader claim proof is not eligible for V2 activation';
    END IF;

    IF OLD.status IS DISTINCT FROM 'verified'
       AND (
         OLD.status IN ('rejected', 'expired')
         OR (
           OLD.status IN ('pending', 'reviewing')
           AND OLD.created_at
                 < pg_catalog.statement_timestamp()
                     - pg_catalog.make_interval(days => 30)
         )
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0002',
        MESSAGE = 'trader claim is no longer reviewable';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- Every relation touched by this cutoff is preflight-owned by CURRENT_USER.
-- Normalize all callable, retired, and trigger-only functions before ACL
-- convergence so CREATE OR REPLACE cannot preserve a substituted owner across
-- replay. Closed legacy functions are included because an owner has implicit
-- execution and replacement authority even after ordinary grants are revoked.
ALTER FUNCTION public.submit_trader_claim(
  uuid, text, text, text, jsonb
) OWNER TO CURRENT_USER;
ALTER FUNCTION public.submit_trader_claim_v2(
  uuid, text, text, text, timestamptz, timestamptz, text, text
) OWNER TO CURRENT_USER;
ALTER FUNCTION public.reject_trader_claim_v2(uuid, uuid, text)
  OWNER TO CURRENT_USER;
ALTER FUNCTION public.cancel_trader_claim_v2(uuid, uuid)
  OWNER TO CURRENT_USER;
ALTER FUNCTION public.activate_trader_claim(uuid, uuid)
  OWNER TO CURRENT_USER;
ALTER FUNCTION public.activate_trader_claim_v2(uuid, uuid)
  OWNER TO CURRENT_USER;
ALTER FUNCTION public.set_primary_linked_trader(uuid, uuid)
  OWNER TO CURRENT_USER;
ALTER FUNCTION public.set_primary_linked_trader_v2(uuid, uuid)
  OWNER TO CURRENT_USER;
ALTER FUNCTION public.unlink_linked_trader(uuid, uuid)
  OWNER TO CURRENT_USER;
ALTER FUNCTION public.unlink_linked_trader_v2(uuid, uuid)
  OWNER TO CURRENT_USER;
ALTER FUNCTION public.arena_set_trader_claimed(
  text, text, uuid, boolean
) OWNER TO CURRENT_USER;
ALTER FUNCTION public.update_linked_trader_metadata_v1(
  uuid, uuid, boolean, text, boolean, integer
) OWNER TO CURRENT_USER;
ALTER FUNCTION public.guard_trader_claim_activation_expiry()
  OWNER TO CURRENT_USER;
ALTER FUNCTION public.guard_trader_authorization_v1_contract()
  OWNER TO CURRENT_USER;
ALTER FUNCTION public.serialize_exchange_connection_v1_mutation()
  OWNER TO CURRENT_USER;
ALTER FUNCTION public.guard_exchange_connection_authorization_v1_contract()
  OWNER TO CURRENT_USER;
ALTER FUNCTION public.guard_user_profile_trader_identity_v1()
  OWNER TO CURRENT_USER;
ALTER FUNCTION public.guard_arena_trader_claimed_meta_v1()
  OWNER TO CURRENT_USER;

DROP TRIGGER IF EXISTS trader_claim_activation_expiry_guard
  ON public.trader_claims;
CREATE TRIGGER trader_claim_activation_expiry_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.trader_claims
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_trader_claim_activation_expiry();

REVOKE ALL ON FUNCTION public.guard_trader_claim_activation_expiry()
  FROM PUBLIC, anon, authenticated, service_role;

-- CREATE OR REPLACE preserves old ACLs. Converge every reviewed claim/account
-- capability from the live catalog so a historical custom role cannot retain
-- EXECUTE through the cutoff.
DO $converge_phase_b_function_acl$
DECLARE
  v_function record;
  v_grantee oid;
  v_role_sql text;
BEGIN
  FOR v_function IN
    SELECT
      procedure_row.oid,
      procedure_row.proowner,
      pg_catalog.format(
        '%I.%I(%s)',
        namespace_row.nspname,
        procedure_row.proname,
        pg_catalog.pg_get_function_identity_arguments(procedure_row.oid)
      ) AS qualified_signature
    FROM pg_catalog.pg_proc AS procedure_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = procedure_row.pronamespace
    WHERE procedure_row.oid IN (
      'public.submit_trader_claim(uuid,text,text,text,jsonb)'::regprocedure,
      'public.submit_trader_claim_v2(uuid,text,text,text,timestamptz,timestamptz,text,text)'::regprocedure,
      'public.reject_trader_claim_v2(uuid,uuid,text)'::regprocedure,
      'public.cancel_trader_claim_v2(uuid,uuid)'::regprocedure,
      'public.activate_trader_claim(uuid,uuid)'::regprocedure,
      'public.activate_trader_claim_v2(uuid,uuid)'::regprocedure,
      'public.set_primary_linked_trader(uuid,uuid)'::regprocedure,
      'public.set_primary_linked_trader_v2(uuid,uuid)'::regprocedure,
      'public.unlink_linked_trader(uuid,uuid)'::regprocedure,
      'public.unlink_linked_trader_v2(uuid,uuid)'::regprocedure,
      'public.arena_set_trader_claimed(text,text,uuid,boolean)'::regprocedure,
      'public.update_linked_trader_metadata_v1(uuid,uuid,boolean,text,boolean,integer)'::regprocedure,
      'public.guard_trader_claim_activation_expiry()'::regprocedure,
      'public.guard_trader_authorization_v1_contract()'::regprocedure,
      'public.serialize_exchange_connection_v1_mutation()'::regprocedure,
      'public.guard_exchange_connection_authorization_v1_contract()'::regprocedure,
      'public.guard_user_profile_trader_identity_v1()'::regprocedure,
      'public.guard_arena_trader_claimed_meta_v1()'::regprocedure,
      'public.update_updated_at_column()'::regprocedure,
      'public.update_trader_authorizations_updated_at()'::regprocedure
    )
    ORDER BY procedure_row.oid
  LOOP
    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee
      FROM pg_catalog.pg_proc AS acl_procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          acl_procedure.proacl,
          pg_catalog.acldefault('f', acl_procedure.proowner)
        )
      ) AS acl_entry
      WHERE acl_procedure.oid = v_function.oid
        AND acl_entry.grantee <> v_function.proowner
    LOOP
      v_role_sql := CASE
        WHEN v_grantee = 0::oid THEN 'PUBLIC'
        ELSE pg_catalog.format(
          '%I',
          (SELECT role_row.rolname FROM pg_catalog.pg_roles AS role_row
           WHERE role_row.oid = v_grantee)
        )
      END;

      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s',
        v_function.qualified_signature,
        v_role_sql
      );
    END LOOP;
  END LOOP;
END
$converge_phase_b_function_acl$;

GRANT EXECUTE ON FUNCTION public.submit_trader_claim_v2(
  uuid, text, text, text, timestamptz, timestamptz, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.reject_trader_claim_v2(uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_trader_claim_v2(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.update_linked_trader_metadata_v1(
  uuid, uuid, boolean, text, boolean, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_primary_linked_trader_v2(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_trader_claim_v2(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.unlink_linked_trader_v2(uuid, uuid)
  TO service_role;

DO $postflight$
DECLARE
  v_privilege text;
  v_column name;
  v_role name;
  v_arena_claim_function regprocedure := pg_catalog.to_regprocedure(
    'public.arena_set_trader_claimed(text,text,uuid,boolean)'
  );
  v_shared_timestamp_function regprocedure := pg_catalog.to_regprocedure(
    'public.update_updated_at_column()'
  );
  v_authorization_timestamp_function regprocedure :=
    pg_catalog.to_regprocedure(
      'public.update_trader_authorizations_updated_at()'
    );
  v_safe_profile_update_columns constant name[] := ARRAY[
    'handle',
    'bio',
    'avatar_url',
    'cover_url',
    'market_pairs',
    'notify_follow',
    'notify_like',
    'notify_comment',
    'notify_mention',
    'notify_message',
    'notify_trader_events',
    'show_followers',
    'show_following',
    'dm_permission',
    'email_digest',
    'settings_version',
    'show_pro_badge',
    'last_seen_at',
    'is_online',
    'interests',
    'onboarding_completed',
    'search_history'
  ]::name[];
  v_safe_verified_update_columns constant name[] := ARRAY[
    'display_name',
    'bio',
    'avatar_url',
    'twitter_url',
    'telegram_url',
    'discord_url',
    'website_url',
    'can_receive_messages'
  ]::name[];
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure_row
    WHERE procedure_row.oid IN (
      'public.submit_trader_claim(uuid,text,text,text,jsonb)'::regprocedure,
      'public.submit_trader_claim_v2(uuid,text,text,text,timestamptz,timestamptz,text,text)'::regprocedure,
      'public.reject_trader_claim_v2(uuid,uuid,text)'::regprocedure,
      'public.cancel_trader_claim_v2(uuid,uuid)'::regprocedure,
      'public.activate_trader_claim(uuid,uuid)'::regprocedure,
      'public.activate_trader_claim_v2(uuid,uuid)'::regprocedure,
      'public.set_primary_linked_trader(uuid,uuid)'::regprocedure,
      'public.set_primary_linked_trader_v2(uuid,uuid)'::regprocedure,
      'public.unlink_linked_trader(uuid,uuid)'::regprocedure,
      'public.unlink_linked_trader_v2(uuid,uuid)'::regprocedure,
      'public.arena_set_trader_claimed(text,text,uuid,boolean)'::regprocedure,
      'public.update_linked_trader_metadata_v1(uuid,uuid,boolean,text,boolean,integer)'::regprocedure,
      'public.guard_trader_claim_activation_expiry()'::regprocedure,
      'public.guard_trader_authorization_v1_contract()'::regprocedure,
      'public.serialize_exchange_connection_v1_mutation()'::regprocedure,
      'public.guard_exchange_connection_authorization_v1_contract()'::regprocedure,
      'public.guard_user_profile_trader_identity_v1()'::regprocedure,
      'public.guard_arena_trader_claimed_meta_v1()'::regprocedure,
      v_shared_timestamp_function,
      v_authorization_timestamp_function
    )
      AND procedure_row.proowner IS DISTINCT FROM (
        SELECT relation.relowner
        FROM pg_catalog.pg_class AS relation
        WHERE relation.oid = 'public.trader_claims'::regclass
      )
  ) THEN
    RAISE EXCEPTION 'Phase-B trader-claim function ownership is not exact';
  END IF;

  IF v_shared_timestamp_function IS NULL
     OR v_authorization_timestamp_function IS NULL
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure_row
       WHERE procedure_row.oid IN (
         v_shared_timestamp_function,
         v_authorization_timestamp_function
       )
         AND NOT (
           procedure_row.prokind = 'f'
           AND procedure_row.prorettype = 'trigger'::regtype
           AND NOT procedure_row.prosecdef
           AND procedure_row.proconfig =
               ARRAY['search_path=pg_catalog, pg_temp']::text[]
           AND procedure_row.prosrc = E'\nBEGIN\n  NEW.updated_at = pg_catalog.now();\n  RETURN NEW;\nEND;\n'
         )
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'public.trader_claims'::regclass
         AND trigger_row.tgname = 'trigger_trader_claims_updated_at'
         AND trigger_row.tgfoid = v_shared_timestamp_function
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         AND trigger_row.tgtype = 19
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid =
             'public.user_exchange_connections'::regclass
         AND trigger_row.tgname =
             'trigger_user_exchange_connections_updated_at'
         AND trigger_row.tgfoid = v_shared_timestamp_function
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         AND trigger_row.tgtype = 19
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'public.trader_authorizations'::regclass
         AND trigger_row.tgname =
             'trigger_update_trader_authorizations_updated_at'
         AND trigger_row.tgfoid = v_authorization_timestamp_function
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         AND trigger_row.tgtype = 19
     ) THEN
    RAISE EXCEPTION 'Phase-B timestamp trigger boundary is not exact';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (
      'public.trader_claims'::regclass,
      'public.trader_authorizations'::regclass,
      'public.user_exchange_connections'::regclass
    )
      AND NOT trigger_row.tgisinternal
      AND NOT (
        (
          trigger_row.tgrelid = 'public.trader_claims'::regclass
          AND trigger_row.tgname IN (
            'trigger_trader_claims_updated_at',
            'trader_claim_activation_expiry_guard'
          )
        ) OR (
          trigger_row.tgrelid = 'public.trader_authorizations'::regclass
          AND trigger_row.tgname IN (
            'trigger_update_trader_authorizations_updated_at',
            'trader_authorization_v1_contract_guard'
          )
        ) OR (
          trigger_row.tgrelid =
              'public.user_exchange_connections'::regclass
          AND trigger_row.tgname IN (
            'trigger_user_exchange_connections_updated_at',
            'exchange_connection_v1_mutation_serializer',
            'exchange_connection_authorization_v1_contract_guard'
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Phase-B direct trigger inventory is not exact';
  END IF;

  IF EXISTS (
    WITH expected(signature, source_sha256, argument_names) AS (
      VALUES
        (
          'public.submit_trader_claim_v2(uuid,text,text,text,timestamptz,timestamptz,text,text)'::text,
          '2316424a0fdd0fb0ea26d7a1b31dd8686353c30f5dbfb6d311ca24f5d57c19c4'::text,
          ARRAY[
            'p_user_id',
            'p_trader_id',
            'p_source',
            'p_challenge_id',
            'p_challenge_issued_at',
            'p_verified_at',
            'p_message_digest',
            'p_signature_digest'
          ]::text[]
        ),
        (
          'public.reject_trader_claim_v2(uuid,uuid,text)'::text,
          '0dfc5f8a70957120c39a260a6124b19cceeabf4895a94cbc760e44624b5e6dbf'::text,
          ARRAY['p_claim_id', 'p_reviewer_id', 'p_reject_reason']::text[]
        ),
        (
          'public.cancel_trader_claim_v2(uuid,uuid)'::text,
          '6b1928167cf273cd7a873c109c2ee5446c36c9a53c304b6c99fd0d9e6bc28f69'::text,
          ARRAY['p_claim_id', 'p_user_id']::text[]
        )
    )
    SELECT 1
    FROM expected
    LEFT JOIN pg_catalog.pg_proc AS procedure_row
      ON procedure_row.oid = pg_catalog.to_regprocedure(expected.signature)
    WHERE procedure_row.oid IS NULL
       OR procedure_row.prokind IS DISTINCT FROM 'f'
       OR procedure_row.prolang IS DISTINCT FROM (
            SELECT language_row.oid
            FROM pg_catalog.pg_language AS language_row
            WHERE language_row.lanname = 'plpgsql'
          )
       OR procedure_row.prorettype IS DISTINCT FROM
            'public.trader_claims'::regtype
       OR procedure_row.proretset
       OR NOT procedure_row.prosecdef
       OR procedure_row.proleakproof
       OR procedure_row.provolatile IS DISTINCT FROM 'v'
       OR procedure_row.pronargdefaults IS DISTINCT FROM 0
       OR procedure_row.proargmodes IS NOT NULL
       OR procedure_row.proallargtypes IS NOT NULL
       OR procedure_row.proargnames IS DISTINCT FROM expected.argument_names
       OR procedure_row.proconfig IS DISTINCT FROM
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
       OR pg_catalog.encode(
            extensions.digest(procedure_row.prosrc, 'sha256'),
            'hex'
          ) IS DISTINCT FROM expected.source_sha256
  ) THEN
    RAISE EXCEPTION
      'Phase-B inherited service capability definitions are not canonical'
      USING DETAIL = (
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'signature', procedure_row.oid::regprocedure::text,
            'language', language_row.lanname,
            'returnType', procedure_row.prorettype::regtype::text,
            'returnSet', procedure_row.proretset,
            'securityDefiner', procedure_row.prosecdef,
            'leakproof', procedure_row.proleakproof,
            'volatility', procedure_row.provolatile,
            'argumentDefaults', procedure_row.pronargdefaults,
            'argumentNames', procedure_row.proargnames,
            'argumentModes', procedure_row.proargmodes,
            'allArgumentTypes', procedure_row.proallargtypes,
            'config', procedure_row.proconfig,
            'sourceSha256', pg_catalog.encode(
              extensions.digest(procedure_row.prosrc, 'sha256'),
              'hex'
            )
          )
          ORDER BY procedure_row.oid
        )::text
        FROM pg_catalog.pg_proc AS procedure_row
        JOIN pg_catalog.pg_language AS language_row
          ON language_row.oid = procedure_row.prolang
        WHERE procedure_row.oid IN (
          'public.submit_trader_claim_v2(uuid,text,text,text,timestamptz,timestamptz,text,text)'::regprocedure,
          'public.reject_trader_claim_v2(uuid,uuid,text)'::regprocedure,
          'public.cancel_trader_claim_v2(uuid,uuid)'::regprocedure
        )
      );
  END IF;

  IF pg_catalog.has_function_privilege(
       'service_role',
       'public.submit_trader_claim(uuid,text,text,text,jsonb)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'legacy submit_trader_claim remains executable';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.submit_trader_claim_v2(uuid,text,text,text,timestamptz,timestamptz,text,text)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.reject_trader_claim_v2(uuid,uuid,text)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.cancel_trader_claim_v2(uuid,uuid)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.activate_trader_claim_v2(uuid,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'service_role is missing a V2 trader-claim capability';
  END IF;

  IF pg_catalog.has_function_privilege(
       'service_role',
       'public.activate_trader_claim(uuid,uuid)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon',
       'public.activate_trader_claim_v2(uuid,uuid)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.activate_trader_claim_v2(uuid,uuid)',
       'EXECUTE'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure_row
       WHERE procedure_row.oid = pg_catalog.to_regprocedure(
               'public.activate_trader_claim_v2(uuid,uuid)'
             )
         AND procedure_row.prosecdef
         AND procedure_row.prorettype = 'jsonb'::regtype
         AND procedure_row.proowner = (
           SELECT relation.relowner
           FROM pg_catalog.pg_class AS relation
           WHERE relation.oid = 'public.user_profiles'::regclass
         )
         AND procedure_row.proconfig @> ARRAY[
           'search_path=pg_catalog, pg_temp'
         ]::text[]
         AND procedure_row.prosrc LIKE '%extensions.digest(v_expected_message%'
         AND procedure_row.prosrc LIKE '%INSERT INTO public.verified_traders%'
         AND procedure_row.prosrc LIKE '%INSERT INTO public.user_linked_traders%'
         AND procedure_row.prosrc LIKE '%UPDATE public.user_profiles%'
         AND procedure_row.prosrc LIKE '%public.arena_set_trader_claimed(%'
         AND procedure_row.prosrc NOT LIKE '%public.activate_trader_claim(%'
     ) THEN
    RAISE EXCEPTION 'V2 claim activation boundary is incorrect';
  END IF;

  IF pg_catalog.has_function_privilege(
       'service_role',
       'public.unlink_linked_trader(uuid,uuid)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon',
       'public.unlink_linked_trader_v2(uuid,uuid)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.unlink_linked_trader_v2(uuid,uuid)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.unlink_linked_trader_v2(uuid,uuid)',
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           procedure_row.proacl,
           pg_catalog.acldefault('f', procedure_row.proowner)
         )
       ) AS acl_entry
       WHERE procedure_row.oid = pg_catalog.to_regprocedure(
               'public.unlink_linked_trader_v2(uuid,uuid)'
             )
         AND acl_entry.grantee = 0::oid
         AND acl_entry.privilege_type = 'EXECUTE'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure_row
       WHERE procedure_row.oid = pg_catalog.to_regprocedure(
               'public.unlink_linked_trader_v2(uuid,uuid)'
             )
         AND procedure_row.prosecdef
         AND procedure_row.prorettype = 'record'::regtype
         AND procedure_row.proowner = (
           SELECT relation.relowner
           FROM pg_catalog.pg_class AS relation
           WHERE relation.oid = 'public.user_profiles'::regclass
         )
         AND procedure_row.proconfig @> ARRAY[
           'search_path=pg_catalog, pg_temp'
         ]::text[]
     ) THEN
    RAISE EXCEPTION 'atomic linked-trader revocation boundary is incorrect';
  END IF;

  IF pg_catalog.has_function_privilege(
       'service_role',
       'public.set_primary_linked_trader(uuid,uuid)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon',
       'public.set_primary_linked_trader_v2(uuid,uuid)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.set_primary_linked_trader_v2(uuid,uuid)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.set_primary_linked_trader_v2(uuid,uuid)',
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           procedure_row.proacl,
           pg_catalog.acldefault('f', procedure_row.proowner)
         )
       ) AS acl_entry
       WHERE procedure_row.oid = pg_catalog.to_regprocedure(
               'public.set_primary_linked_trader_v2(uuid,uuid)'
             )
         AND acl_entry.grantee = 0::oid
         AND acl_entry.privilege_type = 'EXECUTE'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure_row
       WHERE procedure_row.oid = pg_catalog.to_regprocedure(
               'public.set_primary_linked_trader_v2(uuid,uuid)'
             )
         AND procedure_row.prosecdef
         AND procedure_row.prorettype = 'public.user_linked_traders'::regtype
         AND procedure_row.proowner = (
           SELECT relation.relowner
           FROM pg_catalog.pg_class AS relation
           WHERE relation.oid = 'public.user_profiles'::regclass
         )
         AND procedure_row.proconfig @> ARRAY[
           'search_path=pg_catalog, pg_temp'
         ]::text[]
     ) THEN
    RAISE EXCEPTION 'atomic primary linked-trader boundary is incorrect';
  END IF;

  IF pg_catalog.has_function_privilege(
       'anon',
       'public.update_linked_trader_metadata_v1(uuid,uuid,boolean,text,boolean,integer)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.update_linked_trader_metadata_v1(uuid,uuid,boolean,text,boolean,integer)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.update_linked_trader_metadata_v1(uuid,uuid,boolean,text,boolean,integer)',
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           procedure_row.proacl,
           pg_catalog.acldefault('f', procedure_row.proowner)
         )
       ) AS acl_entry
       WHERE procedure_row.oid = pg_catalog.to_regprocedure(
               'public.update_linked_trader_metadata_v1(uuid,uuid,boolean,text,boolean,integer)'
             )
         AND acl_entry.grantee = 0::oid
         AND acl_entry.privilege_type = 'EXECUTE'
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure_row
       WHERE procedure_row.oid = pg_catalog.to_regprocedure(
               'public.update_linked_trader_metadata_v1(uuid,uuid,boolean,text,boolean,integer)'
             )
         AND procedure_row.prosecdef
         AND procedure_row.prorettype = 'public.user_linked_traders'::regtype
         AND procedure_row.proowner = (
           SELECT relation.relowner
           FROM pg_catalog.pg_class AS relation
           WHERE relation.oid = 'public.user_linked_traders'::regclass
         )
         AND procedure_row.proconfig @> ARRAY[
           'search_path=pg_catalog, pg_temp'
         ]::text[]
     ) THEN
    RAISE EXCEPTION 'linked-trader metadata RPC boundary is incorrect';
  END IF;

  IF v_arena_claim_function IS NULL
     OR pg_catalog.has_function_privilege(
       'anon', v_arena_claim_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_arena_claim_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role', v_arena_claim_function, 'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           procedure_row.proacl,
           pg_catalog.acldefault('f', procedure_row.proowner)
         )
       ) AS acl_entry
       WHERE procedure_row.oid = v_arena_claim_function
         AND acl_entry.grantee = 0::oid
         AND acl_entry.privilege_type = 'EXECUTE'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure_row
       WHERE procedure_row.oid = v_arena_claim_function
         AND procedure_row.prosecdef
         AND procedure_row.prorettype = 'int8'::regtype
         AND procedure_row.proowner = (
           SELECT relation.relowner
           FROM pg_catalog.pg_class AS relation
           WHERE relation.oid = 'arena.traders'::regclass
         )
         AND procedure_row.proconfig @> ARRAY[
           'search_path=pg_catalog, pg_temp'
         ]::text[]
     ) THEN
    RAISE EXCEPTION 'Arena claimed-owner projection boundary is incorrect';
  END IF;

  IF pg_catalog.has_function_privilege(
       'service_role',
       'public.guard_user_profile_trader_identity_v1()',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       'public.guard_arena_trader_claimed_meta_v1()',
       'EXECUTE'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure_row
       WHERE procedure_row.oid = pg_catalog.to_regprocedure(
               'public.guard_user_profile_trader_identity_v1()'
             )
         AND NOT procedure_row.prosecdef
         AND procedure_row.proconfig @> ARRAY[
           'search_path=pg_catalog, pg_temp'
         ]::text[]
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure_row
       WHERE procedure_row.oid = pg_catalog.to_regprocedure(
               'public.guard_arena_trader_claimed_meta_v1()'
             )
         AND NOT procedure_row.prosecdef
         AND procedure_row.proconfig @> ARRAY[
           'search_path=pg_catalog, pg_temp'
         ]::text[]
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'public.user_profiles'::regclass
         AND trigger_row.tgname = 'user_profile_trader_identity_v1_guard'
         AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
               'public.guard_user_profile_trader_identity_v1()'
             )
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         -- ROW + BEFORE + INSERT + DELETE + UPDATE.
         AND trigger_row.tgtype = 31
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'arena.traders'::regclass
         AND trigger_row.tgname = 'arena_trader_claimed_meta_v1_guard'
         AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
               'public.guard_arena_trader_claimed_meta_v1()'
             )
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         -- ROW + BEFORE + INSERT + DELETE + UPDATE.
         AND trigger_row.tgtype = 31
     ) THEN
    RAISE EXCEPTION 'profile or Arena claimed identity DML guard is incorrect';
  END IF;

  FOREACH v_privilege IN ARRAY ARRAY[
    'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ]::text[]
  LOOP
    IF pg_catalog.has_table_privilege(
      'service_role',
      'public.trader_claims',
      v_privilege
    ) THEN
      RAISE EXCEPTION 'service_role retains trader_claims %', v_privilege;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_table_privilege(
       'service_role',
       'public.trader_claims',
       'SELECT'
     ) THEN
    RAISE EXCEPTION 'service_role lost trader_claims read access';
  END IF;

  FOR v_column IN
    SELECT attribute.attname
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.trader_claims'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  LOOP
    IF pg_catalog.has_column_privilege(
         'service_role',
         'public.trader_claims',
         v_column,
         'INSERT'
       )
       OR pg_catalog.has_column_privilege(
         'service_role',
         'public.trader_claims',
         v_column,
         'UPDATE'
       ) THEN
      RAISE EXCEPTION 'service_role retains trader_claims column DML on %', v_column;
    END IF;
  END LOOP;

  FOREACH v_privilege IN ARRAY ARRAY[
    'INSERT', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ]::text[]
  LOOP
    IF pg_catalog.has_table_privilege(
      'service_role',
      'public.verified_traders',
      v_privilege
    ) THEN
      RAISE EXCEPTION 'service_role retains verified_traders %', v_privilege;
    END IF;
  END LOOP;

  FOR v_column IN
    SELECT attribute.attname
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.verified_traders'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  LOOP
    IF pg_catalog.has_column_privilege(
         'service_role',
         'public.verified_traders',
         v_column,
         'UPDATE'
       ) IS DISTINCT FROM (v_column = ANY(v_safe_verified_update_columns)) THEN
      RAISE EXCEPTION 'verified_traders UPDATE column boundary drifted: %', v_column;
    END IF;
  END LOOP;

  IF NOT (
       SELECT relation.relrowsecurity
       FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = 'public.user_linked_traders'::regclass
     ) OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_policy AS policy
       WHERE policy.polrelid = 'public.user_linked_traders'::regclass
     ) <> 2 OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy
       JOIN pg_catalog.pg_roles AS role_row
         ON policy.polroles = ARRAY[role_row.oid]::oid[]
       WHERE policy.polrelid = 'public.user_linked_traders'::regclass
         AND policy.polname = 'Authenticated users can view own linked traders'
         AND policy.polpermissive
         AND policy.polcmd = 'r'
         AND role_row.rolname = 'authenticated'
         AND policy.polwithcheck IS NULL
         AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
               LIKE '%auth.uid()%'
         AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
               LIKE '%user_id%'
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy
       JOIN pg_catalog.pg_roles AS role_row
         ON policy.polroles = ARRAY[role_row.oid]::oid[]
       WHERE policy.polrelid = 'public.user_linked_traders'::regclass
         AND policy.polname = 'Service role reads linked traders'
         AND policy.polpermissive
         AND policy.polcmd = 'r'
         AND role_row.rolname = 'service_role'
         AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
         AND policy.polwithcheck IS NULL
     ) THEN
    RAISE EXCEPTION 'linked-trader RLS policy boundary drifted';
  END IF;

  FOREACH v_privilege IN ARRAY ARRAY[
    'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ]::text[]
  LOOP
    IF pg_catalog.has_table_privilege(
         'authenticated',
         'public.user_linked_traders',
         v_privilege
       ) OR pg_catalog.has_table_privilege(
         'anon',
         'public.user_linked_traders',
         v_privilege
       ) THEN
      RAISE EXCEPTION 'browser role retains linked-trader %', v_privilege;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_table_privilege(
       'authenticated', 'public.user_linked_traders', 'SELECT'
     ) OR pg_catalog.has_table_privilege(
       'anon', 'public.user_linked_traders', 'SELECT'
     ) OR EXISTS (
       SELECT 1
       WHERE NOT pg_catalog.has_table_privilege(
         'service_role', 'public.user_linked_traders', 'SELECT'
       )
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(
         ARRAY[
           'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
         ]::text[]
       ) AS forbidden_privilege(privilege_name)
       WHERE pg_catalog.has_table_privilege(
         'service_role',
         'public.user_linked_traders',
         forbidden_privilege.privilege_name
       )
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           relation.relacl,
           pg_catalog.acldefault('r', relation.relowner)
         )
       ) AS acl_entry
       WHERE relation.oid = 'public.user_linked_traders'::regclass
         AND acl_entry.grantee = 0::oid
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
       WHERE attribute.attrelid = 'public.user_linked_traders'::regclass
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND acl_entry.grantee IN (
           0::oid,
           (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'anon'),
           (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'),
           (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role')
         )
     ) THEN
    RAISE EXCEPTION 'linked-trader table or column ACL boundary drifted';
  END IF;

  -- Effective privilege checks catch inheritance that direct ACL inventory
  -- cannot see. Browser roles receive no table mutation capability and only
  -- authenticated's established safe per-column UPDATE surface.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
  LOOP
    FOREACH v_privilege IN ARRAY ARRAY[
      'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(
           v_role, 'public.user_profiles', v_privilege
         ) THEN
        RAISE EXCEPTION
          'browser role % retains profile table %', v_role, v_privilege;
      END IF;
    END LOOP;

    IF pg_catalog.has_any_column_privilege(
         v_role, 'public.user_profiles', 'INSERT'
       ) OR pg_catalog.has_any_column_privilege(
         v_role, 'public.user_profiles', 'REFERENCES'
       ) THEN
      RAISE EXCEPTION
        'browser role % retains profile column INSERT or REFERENCES', v_role;
    END IF;
  END LOOP;

  FOR v_column IN
    SELECT attribute.attname
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.user_profiles'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    ORDER BY attribute.attnum
  LOOP
    IF pg_catalog.has_column_privilege(
         'anon', 'public.user_profiles', v_column, 'UPDATE'
       ) OR (
         NOT v_column = ANY(v_safe_profile_update_columns)
         AND pg_catalog.has_column_privilege(
           'authenticated', 'public.user_profiles', v_column, 'UPDATE'
         )
       ) THEN
      RAISE EXCEPTION
        'browser role retains unsafe profile column UPDATE: %', v_column;
    END IF;
  END LOOP;

  FOREACH v_privilege IN ARRAY ARRAY[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE'
  ]::text[]
  LOOP
    IF NOT pg_catalog.has_table_privilege(
         'service_role', 'public.user_profiles', v_privilege
       ) OR pg_catalog.has_table_privilege(
         'service_role',
         'public.user_profiles',
         v_privilege || ' WITH GRANT OPTION'
       ) THEN
      RAISE EXCEPTION
        'service_role profile % capability is missing or grantable', v_privilege;
    END IF;
  END LOOP;

  FOREACH v_privilege IN ARRAY ARRAY[
    'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ]::text[]
  LOOP
    IF pg_catalog.has_table_privilege(
         'service_role', 'public.user_profiles', v_privilege
       ) THEN
      RAISE EXCEPTION
        'service_role retains forbidden profile %', v_privilege;
    END IF;
  END LOOP;

  IF pg_catalog.has_any_column_privilege(
       'service_role', 'public.user_profiles', 'SELECT WITH GRANT OPTION'
     ) OR pg_catalog.has_any_column_privilege(
       'service_role', 'public.user_profiles', 'INSERT WITH GRANT OPTION'
     ) OR pg_catalog.has_any_column_privilege(
       'service_role', 'public.user_profiles', 'UPDATE WITH GRANT OPTION'
     ) OR pg_catalog.has_any_column_privilege(
       'service_role', 'public.user_profiles', 'REFERENCES'
    ) THEN
    RAISE EXCEPTION
      'service_role profile column capability is grantable or forbidden';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM public.trader_claims AS claim
       WHERE claim.status IN ('pending', 'reviewing')
         AND claim.submission_version IS DISTINCT FROM 2
     ) THEN
    RAISE EXCEPTION 'legacy reviewable trader claims survived the cutoff sweep';
  END IF;

  IF pg_catalog.has_function_privilege(
       'service_role',
       'public.guard_trader_claim_activation_expiry()',
       'EXECUTE'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'public.trader_claims'::regclass
         AND trigger_row.tgname = 'trader_claim_activation_expiry_guard'
         AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
               'public.guard_trader_claim_activation_expiry()'
             )
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         -- ROW + BEFORE + INSERT + DELETE + UPDATE.
         AND trigger_row.tgtype = 31
     ) THEN
    RAISE EXCEPTION 'V2-only claim activation guard is missing or exposed';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM public.trader_authorizations AS auth_row
       WHERE (
         pg_catalog.jsonb_typeof(auth_row.permissions) = 'array'
         AND EXISTS (
           SELECT 1
           FROM pg_catalog.jsonb_array_elements_text(
             auth_row.permissions
           ) AS permission(value)
           WHERE pg_catalog.lower(permission.value) = 'wallet_owner'
         )
       )
       OR (
         auth_row.status = 'active'
         AND (
           auth_row.read_only_verified_at IS NULL
           OR auth_row.last_verified_at IS NULL
           OR auth_row.last_verified_at
                IS DISTINCT FROM auth_row.read_only_verified_at
           OR auth_row.read_only_verified_at
                > pg_catalog.statement_timestamp() + pg_catalog.make_interval(mins => 5)
           OR pg_catalog.btrim(auth_row.encrypted_api_key) = ''
           OR pg_catalog.btrim(auth_row.encrypted_api_secret) = ''
           OR pg_catalog.jsonb_typeof(auth_row.permissions) <> 'array'
           OR pg_catalog.jsonb_array_length(auth_row.permissions) = 0
           OR (
             auth_row.platform IN (
               'okx', 'okx_futures', 'okx_spot',
               'bitget', 'bitget_futures', 'bitget_spot'
             )
             AND (
               auth_row.encrypted_passphrase IS NULL
               OR pg_catalog.btrim(auth_row.encrypted_passphrase) = ''
             )
           )
           OR NOT EXISTS (
             SELECT 1
             FROM public.user_exchange_connections AS connection
             WHERE connection.user_id = auth_row.user_id
               AND connection.exchange = CASE
                 WHEN auth_row.platform IN (
                   'binance', 'binance_futures', 'binance_spot'
                 ) THEN 'binance'
                 WHEN auth_row.platform IN ('bybit', 'bybit_spot') THEN 'bybit'
                 WHEN auth_row.platform IN ('okx', 'okx_futures', 'okx_spot')
                   THEN 'okx'
                 WHEN auth_row.platform IN (
                   'bitget', 'bitget_futures', 'bitget_spot'
                 ) THEN 'bitget'
                 ELSE NULL
               END
               AND connection.verified_uid = auth_row.trader_id
               AND connection.is_active IS TRUE
               AND connection.api_key_encrypted = auth_row.encrypted_api_key
               AND connection.api_secret_encrypted = auth_row.encrypted_api_secret
               AND connection.passphrase_encrypted
                     IS NOT DISTINCT FROM auth_row.encrypted_passphrase
               AND connection.scope_permissions
                     IS NOT DISTINCT FROM auth_row.permissions
               AND connection.last_verified_at
                     IS NOT DISTINCT FROM auth_row.read_only_verified_at
               AND connection.last_verified_at
                     IS NOT DISTINCT FROM auth_row.last_verified_at
           )
         )
       )
       OR auth_row.encrypted_api_key LIKE 'wallet:%'
       OR auth_row.encrypted_api_secret LIKE 'signature_verified:%'
     ) THEN
    RAISE EXCEPTION 'legacy or incomplete active trader authorization survived cutoff';
  END IF;

  IF pg_catalog.has_function_privilege(
       'service_role',
       'public.guard_trader_authorization_v1_contract()',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       'public.guard_exchange_connection_authorization_v1_contract()',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       'public.serialize_exchange_connection_v1_mutation()',
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure_row
       WHERE procedure_row.oid IN (
         pg_catalog.to_regprocedure(
           'public.guard_trader_authorization_v1_contract()'
         ),
         pg_catalog.to_regprocedure(
           'public.guard_exchange_connection_authorization_v1_contract()'
         )
       )
         AND (
           NOT procedure_row.prosecdef
           OR NOT procedure_row.proconfig @> ARRAY[
             'search_path=pg_catalog, pg_temp'
           ]::text[]
         )
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure_row
       WHERE procedure_row.oid = pg_catalog.to_regprocedure(
               'public.serialize_exchange_connection_v1_mutation()'
             )
         AND NOT procedure_row.prosecdef
         AND procedure_row.proconfig @> ARRAY[
           'search_path=pg_catalog, pg_temp'
         ]::text[]
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'public.trader_authorizations'::regclass
         AND trigger_row.tgname = 'trader_authorization_v1_contract_guard'
         AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
               'public.guard_trader_authorization_v1_contract()'
             )
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         -- ROW (1) + BEFORE (2) + INSERT (4) + UPDATE (16).
         AND trigger_row.tgtype = 23
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'public.user_exchange_connections'::regclass
         AND trigger_row.tgname = 'exchange_connection_v1_mutation_serializer'
         AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
               'public.serialize_exchange_connection_v1_mutation()'
             )
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         -- ROW + BEFORE + INSERT + DELETE + UPDATE.
         AND trigger_row.tgtype = 31
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'public.user_exchange_connections'::regclass
         AND trigger_row.tgname =
               'exchange_connection_authorization_v1_contract_guard'
         AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
               'public.guard_exchange_connection_authorization_v1_contract()'
             )
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         -- ROW (1) + INSERT (4) + DELETE (8) + UPDATE (16), AFTER (0).
         AND trigger_row.tgtype = 29
         AND trigger_row.tgconstraint <> 0
         AND trigger_row.tgdeferrable
         AND trigger_row.tginitdeferred
  ) THEN
    RAISE EXCEPTION 'continuous trader authorization V1 guard is missing or exposed';
  END IF;

  IF EXISTS (
    WITH allowed_table_acl(relation_oid, grantee_oid, privilege_type) AS (
      VALUES
        (
          'public.user_linked_traders'::regclass,
          pg_catalog.to_regrole('authenticated')::oid,
          'SELECT'::text
        ),
        (
          'public.user_linked_traders'::regclass,
          pg_catalog.to_regrole('service_role')::oid,
          'SELECT'::text
        ),
        (
          'public.trader_claims'::regclass,
          pg_catalog.to_regrole('authenticated')::oid,
          'SELECT'::text
        ),
        (
          'public.trader_claims'::regclass,
          pg_catalog.to_regrole('service_role')::oid,
          'SELECT'::text
        ),
        (
          'public.verified_traders'::regclass,
          pg_catalog.to_regrole('anon')::oid,
          'SELECT'::text
        ),
        (
          'public.verified_traders'::regclass,
          pg_catalog.to_regrole('authenticated')::oid,
          'SELECT'::text
        ),
        (
          'public.verified_traders'::regclass,
          pg_catalog.to_regrole('service_role')::oid,
          'SELECT'::text
        )
    )
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl_entry
    WHERE relation.oid IN (
      'public.user_linked_traders'::regclass,
      'public.trader_claims'::regclass,
      'public.verified_traders'::regclass
    )
      AND acl_entry.grantee <> relation.relowner
      AND NOT EXISTS (
        SELECT 1
        FROM allowed_table_acl AS allowed_acl
        WHERE allowed_acl.relation_oid = relation.oid
          AND allowed_acl.grantee_oid = acl_entry.grantee
          AND allowed_acl.privilege_type = acl_entry.privilege_type
          AND NOT acl_entry.is_grantable
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl_entry
    WHERE relation.oid IN (
      'public.user_linked_traders'::regclass,
      'public.trader_claims'::regclass,
      'public.verified_traders'::regclass
    )
      AND acl_entry.grantee <> relation.relowner
  ) <> 7 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = attribute.attrelid
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid IN (
      'public.user_linked_traders'::regclass,
      'public.trader_claims'::regclass,
      'public.verified_traders'::regclass
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> relation.relowner
      AND NOT (
        attribute.attrelid = 'public.verified_traders'::regclass
        AND attribute.attname = ANY(v_safe_verified_update_columns)
        AND acl_entry.grantee = pg_catalog.to_regrole('service_role')
        AND acl_entry.privilege_type = 'UPDATE'
        AND NOT acl_entry.is_grantable
      )
  ) THEN
    RAISE EXCEPTION 'identity relation direct ACL inventory is not exact';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl_entry
    WHERE relation.oid = 'public.user_profiles'::regclass
      AND acl_entry.grantee <> relation.relowner
      AND (
        acl_entry.privilege_type = ANY(ARRAY[
          'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
        ]::text[])
        OR acl_entry.grantee = pg_catalog.to_regrole('service_role')
      )
      AND NOT (
        acl_entry.grantee = pg_catalog.to_regrole('service_role')
        AND acl_entry.privilege_type = ANY(ARRAY[
          'SELECT', 'INSERT', 'UPDATE', 'DELETE'
        ]::text[])
        AND NOT acl_entry.is_grantable
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl_entry
    WHERE relation.oid = 'public.user_profiles'::regclass
      AND acl_entry.grantee = pg_catalog.to_regrole('service_role')
      AND acl_entry.privilege_type = ANY(ARRAY[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE'
      ]::text[])
      AND NOT acl_entry.is_grantable
  ) <> 4 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.user_profiles'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attname = ANY(v_safe_profile_update_columns)
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(attribute.attacl) AS acl_entry
        WHERE acl_entry.grantee = pg_catalog.to_regrole('authenticated')
          AND acl_entry.privilege_type = 'UPDATE'
          AND NOT acl_entry.is_grantable
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = attribute.attrelid
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = 'public.user_profiles'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> relation.relowner
      AND (
        acl_entry.privilege_type = ANY(ARRAY[
          'INSERT', 'UPDATE', 'REFERENCES'
        ]::text[])
        OR (
          acl_entry.grantee = pg_catalog.to_regrole('service_role')
          AND acl_entry.privilege_type = 'SELECT'
        )
      )
      AND NOT (
        acl_entry.grantee = pg_catalog.to_regrole('authenticated')
        AND attribute.attname = ANY(v_safe_profile_update_columns)
        AND acl_entry.privilege_type = 'UPDATE'
        AND NOT acl_entry.is_grantable
      )
  ) THEN
    RAISE EXCEPTION 'profile mutation direct ACL inventory is not exact';
  END IF;

  IF EXISTS (
    WITH expected(proname, signature, service_callable) AS (
      VALUES
        ('submit_trader_claim'::name, 'public.submit_trader_claim(uuid,text,text,text,jsonb)'::text, false),
        ('submit_trader_claim_v2'::name, 'public.submit_trader_claim_v2(uuid,text,text,text,timestamptz,timestamptz,text,text)'::text, true),
        ('reject_trader_claim_v2'::name, 'public.reject_trader_claim_v2(uuid,uuid,text)'::text, true),
        ('cancel_trader_claim_v2'::name, 'public.cancel_trader_claim_v2(uuid,uuid)'::text, true),
        ('activate_trader_claim'::name, 'public.activate_trader_claim(uuid,uuid)'::text, false),
        ('activate_trader_claim_v2'::name, 'public.activate_trader_claim_v2(uuid,uuid)'::text, true),
        ('set_primary_linked_trader'::name, 'public.set_primary_linked_trader(uuid,uuid)'::text, false),
        ('set_primary_linked_trader_v2'::name, 'public.set_primary_linked_trader_v2(uuid,uuid)'::text, true),
        ('unlink_linked_trader'::name, 'public.unlink_linked_trader(uuid,uuid)'::text, false),
        ('unlink_linked_trader_v2'::name, 'public.unlink_linked_trader_v2(uuid,uuid)'::text, true),
        ('arena_set_trader_claimed'::name, 'public.arena_set_trader_claimed(text,text,uuid,boolean)'::text, false),
        ('update_linked_trader_metadata_v1'::name, 'public.update_linked_trader_metadata_v1(uuid,uuid,boolean,text,boolean,integer)'::text, true),
        ('guard_trader_claim_activation_expiry'::name, 'public.guard_trader_claim_activation_expiry()'::text, false),
        ('guard_trader_authorization_v1_contract'::name, 'public.guard_trader_authorization_v1_contract()'::text, false),
        ('serialize_exchange_connection_v1_mutation'::name, 'public.serialize_exchange_connection_v1_mutation()'::text, false),
        ('guard_exchange_connection_authorization_v1_contract'::name, 'public.guard_exchange_connection_authorization_v1_contract()'::text, false),
        ('guard_user_profile_trader_identity_v1'::name, 'public.guard_user_profile_trader_identity_v1()'::text, false),
        ('guard_arena_trader_claimed_meta_v1'::name, 'public.guard_arena_trader_claimed_meta_v1()'::text, false),
        ('update_updated_at_column'::name, 'public.update_updated_at_column()'::text, false),
        ('update_trader_authorizations_updated_at'::name, 'public.update_trader_authorizations_updated_at()'::text, false)
    )
    SELECT 1
    FROM expected
    WHERE pg_catalog.to_regprocedure(expected.signature) IS NULL

    UNION ALL

    SELECT 1
    FROM pg_catalog.pg_proc AS procedure_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = procedure_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND procedure_row.proname IN (SELECT expected.proname FROM expected)
      AND NOT EXISTS (
        SELECT 1
        FROM expected
        WHERE expected.proname = procedure_row.proname
          AND procedure_row.oid IS NOT DISTINCT FROM
                pg_catalog.to_regprocedure(expected.signature)
      )

    UNION ALL

    SELECT 1
    FROM expected
    JOIN pg_catalog.pg_proc AS procedure_row
      ON procedure_row.oid = pg_catalog.to_regprocedure(expected.signature)
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure_row.proacl,
        pg_catalog.acldefault('f', procedure_row.proowner)
      )
    ) AS acl_entry
    WHERE acl_entry.grantee <> procedure_row.proowner
      AND NOT (
        expected.service_callable
        AND acl_entry.grantee = pg_catalog.to_regrole('service_role')
        AND acl_entry.privilege_type = 'EXECUTE'
        AND NOT acl_entry.is_grantable
      )
  ) THEN
    RAISE EXCEPTION
      'Phase-B trader-claim overload or direct function ACL inventory is not exact';
  END IF;
END
$postflight$;

COMMENT ON COLUMN public.trader_claims.submission_version IS
  'Typed writer discriminator: 1=legacy/default, 2=submit_trader_claim_v2 only.';
COMMENT ON INDEX public.trader_claims_v2_challenge_id_uidx IS
  'Durable replay backstop: one V2 claim row per server challenge id.';
COMMENT ON FUNCTION public.guard_trader_claim_activation_expiry() IS
  'Rejects legacy/non-V2, terminal, and stale claim activation at the final status boundary.';
COMMENT ON FUNCTION public.guard_trader_authorization_v1_contract() IS
  'Rejects authorization-first writes unless every credential and attestation field matches the exact active canonical account connection.';
COMMENT ON FUNCTION public.guard_exchange_connection_authorization_v1_contract() IS
  'Deferred reverse-edge invariant: a connection mutation cannot commit while an active authorization would lose its exact credential projection.';
COMMENT ON FUNCTION public.serialize_exchange_connection_v1_mutation() IS
  'Fail-fast account advisory serializer for direct connection DML; canonical RPCs acquire the same key before row locks.';
COMMENT ON FUNCTION public.arena_set_trader_claimed(text, text, uuid, boolean) IS
  'Definer-internal claimed projection: activation may create, revocation locks an existing row and requires the exact claimed owner; callers use activate/unlink RPCs.';
COMMENT ON FUNCTION public.guard_user_profile_trader_identity_v1() IS
  'Guards non-owner profile INSERT/UPDATE/DELETE so trader identity stays neutral or unchanged; canonical identity RPCs execute as the relation owner.';
COMMENT ON FUNCTION public.guard_arena_trader_claimed_meta_v1() IS
  'Reserves Arena claimed/claimed_at/claimed_by_user_id metadata and claimed-row deletion for owner-executed identity RPCs.';
COMMENT ON FUNCTION public.activate_trader_claim_v2(uuid, uuid) IS
  'Service-only Phase-B activation entrypoint; reconstructs the typed V2 wallet proof and atomically writes linked, verified, profile, Arena, and final claim projections without legacy delegation.';
COMMENT ON FUNCTION public.set_primary_linked_trader_v2(uuid, uuid) IS
  'Service-only Phase-B atomic primary selection across linked, verified, and profile identity projections.';
COMMENT ON FUNCTION public.unlink_linked_trader_v2(uuid, uuid) IS
  'Service-only Phase-B atomic linked-trader revocation across claim, identity, profile, Arena, connection, and authorization projections.';
COMMENT ON FUNCTION public.update_linked_trader_metadata_v1(
  uuid,
  uuid,
  boolean,
  text,
  boolean,
  integer
) IS
  'Service-only owner-locked metadata writer; updates only explicitly selected label/display_order fields.';

NOTIFY pgrst, 'reload schema';

COMMIT;
