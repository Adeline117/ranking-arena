-- Phase A (pre-deploy): add typed trader-claim V2 capabilities without yet
-- cutting off the currently deployed application. This phase is NOT the
-- security boundary by itself: the post-deploy cutoff migration must follow
-- immediately after the V2 application smoke test.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('public.trader_claim:v2-cutover', 0)
);

DO $preflight$
DECLARE
  v_claim_owner name;
  v_active_index_columns text[];
  v_active_index_predicate text;
  v_active_index_access_method name;
BEGIN
  IF pg_catalog.to_regclass('public.trader_claims') IS NULL THEN
    RAISE EXCEPTION 'public.trader_claims must exist before V2 claim RPCs';
  END IF;

  SELECT pg_catalog.pg_get_userbyid(relation.relowner)
  INTO STRICT v_claim_owner
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = 'public.trader_claims'::regclass;

  IF CURRENT_USER IS DISTINCT FROM v_claim_owner THEN
    RAISE EXCEPTION
      'Phase-A migration role must own trader_claims (expected %, got %)',
      v_claim_owner,
      CURRENT_USER;
  END IF;

  IF pg_catalog.to_regprocedure(
       'public.submit_trader_claim(uuid,text,text,text,jsonb)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.activate_trader_claim(uuid,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.arena_set_trader_claimed(text,text,uuid,boolean)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'legacy submit and atomic activation must exist before V2 claim RPCs';
  END IF;

  IF pg_catalog.to_regprocedure('extensions.digest(text,text)') IS NULL THEN
    RAISE EXCEPTION 'extensions.digest(text,text) is required for V2 claim RPCs';
  END IF;

  IF pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'Supabase API roles must exist before V2 claim RPCs';
  END IF;

  SELECT
    ARRAY(
      SELECT attribute.attname::text
      FROM pg_catalog.unnest(index_row.indkey::smallint[])
             WITH ORDINALITY AS key(attnum, position)
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = index_row.indrelid
       AND attribute.attnum = key.attnum
      ORDER BY key.position
    ),
    pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid),
    access_method.amname
  INTO
    v_active_index_columns,
    v_active_index_predicate,
    v_active_index_access_method
  FROM pg_catalog.pg_index AS index_row
  JOIN pg_catalog.pg_class AS index_relation
    ON index_relation.oid = index_row.indexrelid
  JOIN pg_catalog.pg_am AS access_method
    ON access_method.oid = index_relation.relam
  WHERE index_row.indexrelid = pg_catalog.to_regclass(
          'public.trader_claims_one_active_identity_uidx'
        )
    AND index_row.indisunique
    AND index_row.indisvalid
    AND index_row.indisready
    AND index_row.indimmediate
    AND NOT index_row.indisexclusion
    AND NOT index_row.indnullsnotdistinct
    AND index_row.indnkeyatts = 2
    AND index_row.indnatts = 2
    AND index_row.indexprs IS NULL
    AND index_row.indpred IS NOT NULL;

  IF v_active_index_columns IS DISTINCT FROM
       ARRAY['trader_id', 'source']::text[]
     OR v_active_index_predicate IS DISTINCT FROM
       '(status = ANY (ARRAY[''pending''::text, ''reviewing''::text, ''verified''::text]))'
     OR v_active_index_access_method IS DISTINCT FROM 'btree'::name THEN
    RAISE EXCEPTION
      'active trader-claim identity index has the wrong exact shape';
  END IF;
END
$preflight$;

-- A real typed discriminator keeps activation independent of caller-supplied
-- JSON. Historical and still-running legacy writers receive version 1 from
-- the default; only the new SECURITY DEFINER RPC writes version 2.
ALTER TABLE public.trader_claims
  ADD COLUMN IF NOT EXISTS submission_version smallint NOT NULL DEFAULT 1;

ALTER TABLE public.trader_claims
  DROP CONSTRAINT IF EXISTS trader_claims_submission_version_check;
ALTER TABLE public.trader_claims
  ADD CONSTRAINT trader_claims_submission_version_check
  CHECK (submission_version IN (1, 2)) NOT VALID;
ALTER TABLE public.trader_claims
  VALIDATE CONSTRAINT trader_claims_submission_version_check;

CREATE UNIQUE INDEX IF NOT EXISTS trader_claims_v2_challenge_id_uidx
  ON public.trader_claims ((verification_data->>'challenge_id'))
  WHERE submission_version = 2;

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

-- The status trigger is defense in depth for every direct/legacy write. Phase A
-- also revokes all approval entrypoints below; rows remain visible for audit
-- until Phase B installs the canonical V2 activator and expires legacy review.
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

  -- submission_version=2 is a database-owned provenance bit, not caller
  -- supplied evidence. During the phase-A compatibility window the shared
  -- service role may still use legacy V1 table DML, but it cannot manufacture
  -- or rewrite a V2 row. V2 writers execute as the table owner through the
  -- narrow SECURITY DEFINER RPCs above/below.
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
    -- Validate every verified write, including an idempotent replay of an
    -- already-verified claim. Otherwise the legacy activate RPC could rebuild
    -- projections from a historical V1 row and leave status unchanged.
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

DROP TRIGGER IF EXISTS trader_claim_activation_expiry_guard
  ON public.trader_claims;
CREATE TRIGGER trader_claim_activation_expiry_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.trader_claims
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_trader_claim_activation_expiry();

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

REVOKE ALL ON FUNCTION public.submit_trader_claim_v2(
  uuid, text, text, text, timestamptz, timestamptz, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reject_trader_claim_v2(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.cancel_trader_claim_v2(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_trader_claim_activation_expiry()
  FROM PUBLIC, anon, authenticated, service_role;
-- Phase A deliberately has no approval capability. The immutable legacy
-- activator can run as table owner and therefore must not be allowed to approve
-- a new V2 row before Phase B installs the canonical V2 atomic implementation.
REVOKE ALL ON FUNCTION public.activate_trader_claim(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.arena_set_trader_claimed(
  text, text, uuid, boolean
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.submit_trader_claim_v2(
  uuid, text, text, text, timestamptz, timestamptz, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.reject_trader_claim_v2(uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_trader_claim_v2(uuid, uuid)
  TO service_role;

DO $postflight$
DECLARE
  v_signature regprocedure;
  v_index_expression text;
  v_index_predicate text;
  v_active_index_columns text[];
  v_active_index_predicate text;
  v_active_index_access_method name;
BEGIN
  IF (
       SELECT
         attribute.attnotnull
         AND attribute.atttypid = 'smallint'::regtype
         AND pg_catalog.pg_get_expr(
               default_row.adbin,
               default_row.adrelid
             ) = '1'
       FROM pg_catalog.pg_attribute AS attribute
       LEFT JOIN pg_catalog.pg_attrdef AS default_row
         ON default_row.adrelid = attribute.attrelid
        AND default_row.adnum = attribute.attnum
       WHERE attribute.attrelid = 'public.trader_claims'::regclass
         AND attribute.attname = 'submission_version'
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
     ) IS DISTINCT FROM true
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = 'public.trader_claims'::regclass
         AND constraint_row.conname = 'trader_claims_submission_version_check'
         AND constraint_row.contype = 'c'
         AND constraint_row.convalidated
         AND pg_catalog.pg_get_constraintdef(constraint_row.oid)
               = 'CHECK ((submission_version = ANY (ARRAY[1, 2])))'
     ) THEN
    RAISE EXCEPTION 'typed V2 claim column/default/check boundary is incorrect';
  END IF;

  SELECT
    pg_catalog.pg_get_expr(index_row.indexprs, index_row.indrelid),
    pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid)
  INTO v_index_expression, v_index_predicate
  FROM pg_catalog.pg_index AS index_row
  WHERE index_row.indexrelid = pg_catalog.to_regclass(
          'public.trader_claims_v2_challenge_id_uidx'
        )
    AND index_row.indisunique
    AND index_row.indisvalid
    AND index_row.indisready
    AND index_row.indimmediate
    AND NOT index_row.indisexclusion
    AND NOT index_row.indnullsnotdistinct
    AND index_row.indnkeyatts = 1
    AND index_row.indnatts = 1
    AND index_row.indexprs IS NOT NULL
    AND index_row.indpred IS NOT NULL;

  IF v_index_expression IS DISTINCT FROM
       '(verification_data ->> ''challenge_id''::text)'
     OR v_index_predicate IS DISTINCT FROM '(submission_version = 2)' THEN
    RAISE EXCEPTION 'durable V2 challenge identity index is incorrect';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_index AS index_row
       WHERE index_row.indexrelid = pg_catalog.to_regclass(
               'public.trader_claims_v2_challenge_id_uidx'
             )
         AND index_row.indisunique
         AND index_row.indisvalid
         AND index_row.indisready
         AND index_row.indpred IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'durable V2 challenge identity index is missing';
  END IF;

  SELECT
    ARRAY(
      SELECT attribute.attname::text
      FROM pg_catalog.unnest(index_row.indkey::smallint[])
             WITH ORDINALITY AS key(attnum, position)
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = index_row.indrelid
       AND attribute.attnum = key.attnum
      ORDER BY key.position
    ),
    pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid),
    access_method.amname
  INTO
    v_active_index_columns,
    v_active_index_predicate,
    v_active_index_access_method
  FROM pg_catalog.pg_index AS index_row
  JOIN pg_catalog.pg_class AS index_relation
    ON index_relation.oid = index_row.indexrelid
  JOIN pg_catalog.pg_am AS access_method
    ON access_method.oid = index_relation.relam
  WHERE index_row.indexrelid = pg_catalog.to_regclass(
          'public.trader_claims_one_active_identity_uidx'
        )
    AND index_row.indisunique
    AND index_row.indisvalid
    AND index_row.indisready
    AND index_row.indimmediate
    AND NOT index_row.indisexclusion
    AND NOT index_row.indnullsnotdistinct
    AND index_row.indnkeyatts = 2
    AND index_row.indnatts = 2
    AND index_row.indexprs IS NULL
    AND index_row.indpred IS NOT NULL;

  IF v_active_index_columns IS DISTINCT FROM
       ARRAY['trader_id', 'source']::text[]
     OR v_active_index_predicate IS DISTINCT FROM
       '(status = ANY (ARRAY[''pending''::text, ''reviewing''::text, ''verified''::text]))'
     OR v_active_index_access_method IS DISTINCT FROM 'btree'::name THEN
    RAISE EXCEPTION
      'active trader-claim identity index drifted during Phase A';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.submit_trader_claim_v2(uuid,text,text,text,timestamptz,timestamptz,text,text)'::regprocedure,
    'public.reject_trader_claim_v2(uuid,uuid,text)'::regprocedure,
    'public.cancel_trader_claim_v2(uuid,uuid)'::regprocedure
  ]::regprocedure[]
  LOOP
    IF pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE')
       OR NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS procedure_row
         WHERE procedure_row.oid = v_signature
           AND procedure_row.prosecdef
           AND procedure_row.proowner = (
             SELECT relation.relowner
             FROM pg_catalog.pg_class AS relation
             WHERE relation.oid = 'public.trader_claims'::regclass
           )
           AND 'search_path=pg_catalog, pg_temp' = ANY(procedure_row.proconfig)
       ) THEN
      RAISE EXCEPTION 'V2 trader-claim RPC boundary is incorrect: %', v_signature;
    END IF;
  END LOOP;

  IF pg_catalog.has_function_privilege(
       'service_role',
       'public.guard_trader_claim_activation_expiry()',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       'public.activate_trader_claim(uuid,uuid)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       'public.arena_set_trader_claimed(text,text,uuid,boolean)',
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
         AND trigger_row.tgenabled <> 'D'
         -- ROW + BEFORE + INSERT + DELETE + UPDATE.
         AND trigger_row.tgtype = 31
     ) THEN
    RAISE EXCEPTION 'Phase-A V2 claim or activation capability boundary is incorrect';
  END IF;
END
$postflight$;

COMMENT ON FUNCTION public.submit_trader_claim_v2(
  uuid, text, text, text, timestamptz, timestamptz, text, text
) IS
  'Phase-A typed wallet-claim submit capability. Database fixes signature method, V1 source matrix, canonical identity, freshness, and audit JSON.';
COMMENT ON FUNCTION public.reject_trader_claim_v2(uuid, uuid, text) IS
  'Service-only atomic claim rejection capability used before direct table writes are cut off.';
COMMENT ON FUNCTION public.cancel_trader_claim_v2(uuid, uuid) IS
  'Service-only, audit-preserving claimant cancellation capability.';

NOTIFY pgrst, 'reload schema';

COMMIT;
