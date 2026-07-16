-- Make trader-claim retries real without erasing the audit history.
--
-- A historical full-table UNIQUE(trader_id, source) made rejected claims and
-- pending/reviewing claims older than 30 days impossible to retry even though
-- the application treated them as non-blocking. Keep terminal attempts as
-- immutable history and constrain only the one active identity lifecycle.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
DECLARE
  v_invalid_statuses text;
BEGIN
  IF pg_catalog.to_regclass('public.trader_claims') IS NULL THEN
    RAISE EXCEPTION
      'public.trader_claims must exist before adding expirable submissions';
  END IF;

  IF pg_catalog.to_regprocedure(
       'public.activate_trader_claim(uuid,uuid)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'atomic trader-claim activation must exist before adding expirable submissions';
  END IF;

  IF pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION
      'Supabase API roles must exist before adding expirable submissions';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM (
         VALUES
           ('id', 'uuid'),
           ('user_id', 'uuid'),
           ('trader_id', 'text'),
           ('source', 'text'),
           ('verification_method', 'text'),
           ('verification_data', 'jsonb'),
           ('status', 'text'),
           ('created_at', 'timestamptz'),
           ('updated_at', 'timestamptz')
       ) AS required_column(column_name, type_name)
       WHERE NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
         JOIN pg_catalog.pg_type AS type_row
           ON type_row.oid = attribute.atttypid
         WHERE attribute.attrelid = 'public.trader_claims'::regclass
           AND attribute.attname = required_column.column_name
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND type_row.typname = required_column.type_name
       )
     ) THEN
    RAISE EXCEPTION
      'trader_claims submission columns or types are missing';
  END IF;

  SELECT pg_catalog.string_agg(invalid.status, ', ' ORDER BY invalid.status)
  INTO v_invalid_statuses
  FROM (
    SELECT DISTINCT claim.status
    FROM public.trader_claims AS claim
    WHERE claim.status NOT IN (
      'pending',
      'reviewing',
      'verified',
      'rejected',
      'expired'
    )
  ) AS invalid;

  IF v_invalid_statuses IS NOT NULL THEN
    RAISE EXCEPTION
      'unsupported trader_claims statuses must be reconciled first: %',
      v_invalid_statuses;
  END IF;

  -- First application must start from the historical full identity key.
  -- Replays start from the partial key installed by this migration.
  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = 'public.trader_claims'::regclass
         AND constraint_row.conname = 'trader_claims_trader_id_source_key'
         AND constraint_row.contype = 'u'
         AND pg_catalog.pg_get_constraintdef(constraint_row.oid)
               = 'UNIQUE (trader_id, source)'
     )
     AND NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_index AS index_row
       WHERE index_row.indexrelid = pg_catalog.to_regclass(
               'public.trader_claims_one_active_identity_uidx'
             )
         AND index_row.indisunique
         AND index_row.indisvalid
         AND index_row.indisready
         AND index_row.indpred IS NOT NULL
     ) THEN
    RAISE EXCEPTION
      'expected full or partial trader-claim identity key is missing';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM public.trader_claims AS claim
       WHERE claim.status IN ('pending', 'reviewing', 'verified')
       GROUP BY claim.trader_id, claim.source
       HAVING pg_catalog.count(*) > 1
     ) THEN
    RAISE EXCEPTION
      'duplicate active trader claims must be reconciled first';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM public.trader_claims AS claim
       WHERE claim.status IN ('pending', 'reviewing', 'verified')
         AND (
           claim.source <> pg_catalog.lower(pg_catalog.btrim(claim.source))
           OR claim.trader_id <> pg_catalog.btrim(claim.trader_id)
           OR (
             pg_catalog.lower(claim.source) IN (
               'hyperliquid',
               'gmx',
               'gains',
               'aevo',
               'dydx'
             )
             AND claim.trader_id <> pg_catalog.lower(claim.trader_id)
           )
         )
     ) THEN
    RAISE EXCEPTION
      'noncanonical active trader claims must be reconciled first';
  END IF;
END
$preflight$;

-- `created_at` defines the expiry boundary. Historical rows were created with
-- a default but the column was nullable; give an unknown row a conservative
-- fresh timestamp instead of silently expiring it, then make the clock usable
-- as a database invariant.
UPDATE public.trader_claims AS claim
SET created_at = COALESCE(claim.updated_at, pg_catalog.statement_timestamp())
WHERE claim.created_at IS NULL;

ALTER TABLE public.trader_claims
  ALTER COLUMN created_at SET NOT NULL;

-- Extend the lifecycle before writing the new terminal status.
ALTER TABLE public.trader_claims
  DROP CONSTRAINT IF EXISTS trader_claims_status_check;
ALTER TABLE public.trader_claims
  ADD CONSTRAINT trader_claims_status_check
  CHECK (
    status IN ('pending', 'reviewing', 'verified', 'rejected', 'expired')
  ) NOT VALID;
ALTER TABLE public.trader_claims
  VALIDATE CONSTRAINT trader_claims_status_check;

-- Preserve every proof/reviewer/id. Only the lifecycle fields change.
UPDATE public.trader_claims AS claim
SET status = 'expired',
    updated_at = pg_catalog.statement_timestamp()
WHERE claim.status IN ('pending', 'reviewing')
  AND claim.created_at
        < pg_catalog.statement_timestamp() - pg_catalog.make_interval(days => 30);

-- Build the replacement while the historical full key still protects the
-- table, then remove that over-broad constraint. Rejected and expired attempts
-- remain queryable history; one pending/reviewing/verified row owns identity.
CREATE UNIQUE INDEX IF NOT EXISTS trader_claims_one_active_identity_uidx
  ON public.trader_claims (trader_id, source)
  WHERE status IN ('pending', 'reviewing', 'verified');

ALTER TABLE public.trader_claims
  DROP CONSTRAINT IF EXISTS trader_claims_trader_id_source_key;

CREATE OR REPLACE FUNCTION public.submit_trader_claim(
  p_user_id uuid,
  p_trader_id text,
  p_source text,
  p_verification_method text,
  p_verification_data jsonb
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
  v_verification_data jsonb := COALESCE(p_verification_data, '{}'::jsonb);
  v_claim public.trader_claims%ROWTYPE;
BEGIN
  IF p_user_id IS NULL
     OR v_trader_id IS NULL
     OR v_trader_id = ''
     OR pg_catalog.length(v_trader_id) > 512
     OR v_source IS NULL
     OR v_source = ''
     OR pg_catalog.length(v_source) > 100 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'valid claim user, trader id, and source are required';
  END IF;

  IF p_verification_method IS NULL
     OR p_verification_method NOT IN ('api_key', 'signature') THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'unsupported trader claim verification method';
  END IF;

  IF p_verification_method = 'signature' THEN
    IF v_source IN ('jupiter_perps', 'drift') THEN
      -- Solana Base58 public keys are case-sensitive and must remain exact.
      NULL;
    ELSIF v_source IN ('hyperliquid', 'gmx', 'gains', 'aevo', 'dydx') THEN
      -- EVM identity keys use one database representation regardless of
      -- checksum case. This is the final write-boundary canonicalization.
      v_trader_id := pg_catalog.lower(v_trader_id);
    ELSE
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'unsupported wallet trader claim source';
    END IF;
  END IF;

  IF pg_catalog.jsonb_typeof(v_verification_data) <> 'object' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'trader claim verification data must be an object';
  END IF;

  -- Lock a stale active attempt before retiring it. Do not take the activation
  -- advisory lock first: activate_trader_claim locks this row before taking
  -- that namespace, and reversing the order here would introduce a deadlock.
  -- The partial unique index serializes identities that have no stale row.
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
    status,
    created_at,
    updated_at
  ) VALUES (
    p_user_id,
    v_trader_id,
    v_source,
    p_verification_method,
    v_verification_data,
    'reviewing',
    v_now,
    v_now
  )
  RETURNING * INTO STRICT v_claim;

  RETURN v_claim;
END;
$function$;

-- Activation currently commits its claim status last. This trigger is the
-- database backstop: even a stale admin tab can run the earlier projection
-- statements, but the terminal status write raises and rolls the whole RPC
-- transaction back before it can return a commit acknowledgement.
CREATE OR REPLACE FUNCTION public.guard_trader_claim_activation_expiry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.status = 'verified'
     AND OLD.status IS DISTINCT FROM 'verified'
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

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trader_claim_activation_expiry_guard
  ON public.trader_claims;
CREATE TRIGGER trader_claim_activation_expiry_guard
  BEFORE UPDATE OF status ON public.trader_claims
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_trader_claim_activation_expiry();

REVOKE ALL ON FUNCTION public.submit_trader_claim(
  uuid,
  text,
  text,
  text,
  jsonb
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_trader_claim(
  uuid,
  text,
  text,
  text,
  jsonb
) TO service_role;

-- Trigger functions need no direct EXECUTE grant. Keep the implementation out
-- of every PostgREST role, including service_role.
REVOKE ALL ON FUNCTION public.guard_trader_claim_activation_expiry()
  FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  v_index_columns text[];
  v_index_predicate text;
BEGIN
  IF (
       SELECT attribute.attnotnull
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = 'public.trader_claims'::regclass
         AND attribute.attname = 'created_at'
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
     ) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'trader_claims.created_at is still nullable';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = 'public.trader_claims'::regclass
         AND constraint_row.conname = 'trader_claims_status_check'
         AND constraint_row.contype = 'c'
         AND constraint_row.convalidated
         AND pg_catalog.pg_get_constraintdef(constraint_row.oid)
               LIKE '%expired%'
     ) THEN
    RAISE EXCEPTION 'expanded trader-claim status check is missing';
  END IF;

  SELECT
    ARRAY(
      SELECT attribute.attname::text
      FROM pg_catalog.unnest(index_row.indkey::smallint[])
             WITH ORDINALITY AS key(attnum, position)
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = index_row.indrelid
       AND attribute.attnum = key.attnum
      WHERE key.position <= index_row.indnkeyatts
      ORDER BY key.position
    ),
    pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid)
  INTO v_index_columns, v_index_predicate
  FROM pg_catalog.pg_index AS index_row
  WHERE index_row.indexrelid = pg_catalog.to_regclass(
          'public.trader_claims_one_active_identity_uidx'
        )
    AND index_row.indisunique
    AND index_row.indisvalid
    AND index_row.indisready;

  IF v_index_columns IS DISTINCT FROM ARRAY['trader_id', 'source']::text[]
     OR v_index_predicate IS DISTINCT FROM
          '(status = ANY (ARRAY[''pending''::text, ''reviewing''::text, ''verified''::text]))' THEN
    RAISE EXCEPTION
      'active trader-claim identity index has the wrong columns or predicate';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM pg_catalog.pg_index AS index_row
       WHERE index_row.indrelid = 'public.trader_claims'::regclass
         AND index_row.indisunique
         AND index_row.indpred IS NULL
         AND ARRAY(
               SELECT attribute.attname::text
               FROM pg_catalog.unnest(index_row.indkey::smallint[])
                      WITH ORDINALITY AS key(attnum, position)
               JOIN pg_catalog.pg_attribute AS attribute
                 ON attribute.attrelid = index_row.indrelid
                AND attribute.attnum = key.attnum
               WHERE key.position <= index_row.indnkeyatts
               ORDER BY key.position
             ) = ARRAY['trader_id', 'source']::text[]
     ) THEN
    RAISE EXCEPTION 'full-table trader-claim identity uniqueness still exists';
  END IF;

  IF pg_catalog.has_function_privilege(
       'anon',
       'public.submit_trader_claim(uuid,text,text,text,jsonb)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.submit_trader_claim(uuid,text,text,text,jsonb)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.submit_trader_claim(uuid,text,text,text,jsonb)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'submit_trader_claim execute boundary is incorrect';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure_row
       WHERE procedure_row.oid = pg_catalog.to_regprocedure(
               'public.submit_trader_claim(uuid,text,text,text,jsonb)'
             )
         AND procedure_row.prosecdef
         AND 'search_path=pg_catalog, pg_temp' = ANY(procedure_row.proconfig)
     ) THEN
    RAISE EXCEPTION 'submit_trader_claim security-definer boundary is incorrect';
  END IF;

  IF pg_catalog.has_function_privilege(
       'anon',
       'public.guard_trader_claim_activation_expiry()',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.guard_trader_claim_activation_expiry()',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       'public.guard_trader_claim_activation_expiry()',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'claim-expiry trigger function is directly executable';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'public.trader_claims'::regclass
         AND trigger_row.tgname = 'trader_claim_activation_expiry_guard'
         AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
               'public.guard_trader_claim_activation_expiry()'
             )
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled <> 'D'
     ) THEN
    RAISE EXCEPTION 'claim activation expiry guard is missing or disabled';
  END IF;
END
$postflight$;

COMMENT ON INDEX public.trader_claims_one_active_identity_uidx IS
  'One pending, reviewing, or verified claim may own a trader identity; rejected and expired attempts remain audit history.';
COMMENT ON FUNCTION public.submit_trader_claim(uuid, text, text, text, jsonb) IS
  'Service-only atomic stale-claim expiry and creation of a distinct reviewing attempt.';
COMMENT ON FUNCTION public.guard_trader_claim_activation_expiry() IS
  'Rejects terminal or 30-day-stale claim activation so the enclosing transaction rolls back.';

NOTIFY pgrst, 'reload schema';

COMMIT;
