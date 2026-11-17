-- Migration: 20261116215328_profile_acquisition_evidence_ledger.sql
-- Description: Attempt-bound evidence for Tier-B profile captures, as strict
--   as the Tier-A board evidence (follow-up to PR #489).
--
-- #489 publishes a trader_stats value only when an attempt-bound board write
-- attested it (20261116205144). Required score inputs that a board does not
-- carry (binance_futures drawdown, blofin win rate, bybit_copytrade PnL, ...)
-- come only from Tier-B profile crawls, which had no attempt-bound evidence,
-- so #489 excludes those sources. This migration gives profile captures the
-- same shape of evidence:
--
-- * arena.profile_capture_contracts: per-source registered profile capture
--   contracts (append-only). A row pins the worker's contract document by its
--   sha256 and lists the timeframes it covers and the metrics it may attest.
--   The registry starts EMPTY: a source is declared by its own migration that
--   inserts the reviewed contract hash.
-- * arena.profile_acquisition_attempts / _outcomes: an append-only,
--   RPC-owned ledger. One attempt per (source, trader, timeframe) profile
--   fetch; the database owns attempt order and start time. One typed terminal
--   per attempt. A complete outcome must name the tier_b RAW of exactly that
--   source, trader and timeframe, written after the attempt began and bound to
--   it by attempt_id and capture contract in the RAW metadata, plus the capture
--   manifest (request projection and response sha256 per page, and the value
--   the contract field path supplied for each attested metric).
-- * arena.trader_stats.profile_evidence_attempt_seq / _metrics: a per-value
--   profile attestation beside #489's board pointer. The guard trigger
--   arena.trader_stats_profile_evidence (BEFORE INSERT OR UPDATE):
--   - a write that sets a new profile pointer must point at a COMPLETE outcome
--     of the same trader and timeframe (otherwise 22023), and attests only the
--     listed metrics the outcome attested whose stored value equals the
--     manifest value;
--   - any other write keeps the pointer but drops each attested metric whose
--     value it changed, and clears the pointer once none is left;
--   - a write without a pointer stores none.
--   The board pointer and its trigger (20261116205144) are untouched: the two
--   attestations merge per metric, and either one is stripped by a later
--   write that changes its value.
--
-- PREDEPLOY: inert for the deployed worker. No contract is registered, the
-- deployed worker never calls the RPCs and never sets the profile pointer, so
-- every trader_stats row keeps NULL. The worker release that records profile
-- attempts needs these objects. Columns are added without a default
-- (catalog-only); the CHECK is added NOT VALID and then validated.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL
     OR pg_catalog.to_regclass('arena.trader_stats') IS NULL
     OR pg_catalog.to_regprocedure('arena.trader_stats_score_input_value(jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'profile acquisition evidence requires 20261116205144 and the arena RAW layer';
  END IF;
  IF pg_catalog.to_regclass('arena.profile_capture_contracts') IS NOT NULL
     OR pg_catalog.to_regclass('arena.profile_acquisition_attempts') IS NOT NULL
     OR pg_catalog.to_regclass('arena.profile_acquisition_outcomes') IS NOT NULL
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = 'arena.trader_stats'::pg_catalog.regclass
         AND attribute.attname IN ('profile_evidence_attempt_seq', 'profile_evidence_metrics')
         AND NOT attribute.attisdropped
     ) THEN
    RAISE EXCEPTION 'profile acquisition evidence already exists';
  END IF;
END
$preflight$;

-- Score-input metrics a profile contract may attest (the #489 vocabulary).
CREATE FUNCTION arena.profile_attestable_metrics()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT ARRAY[
    'roi', 'pnl', 'win_rate', 'mdd', 'sharpe', 'copier_count',
    'total_positions', 'sortino', 'calmar', 'volatility'
  ]::text[]
$function$;

CREATE TABLE arena.profile_capture_contracts (
  source_id smallint NOT NULL REFERENCES arena.sources(id) ON DELETE RESTRICT,
  capture_contract text NOT NULL,
  contract_sha256 text NOT NULL,
  timeframes smallint[] NOT NULL,
  attestable_metrics text[] NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (source_id, capture_contract),
  CONSTRAINT profile_capture_contracts_name CHECK (
    capture_contract ~ '^[a-z0-9_]+-profile-capture@[1-9][0-9]*$'
  ),
  CONSTRAINT profile_capture_contracts_sha256 CHECK (contract_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT profile_capture_contracts_timeframes CHECK (
    pg_catalog.cardinality(timeframes) > 0
    AND timeframes <@ ARRAY[7, 30, 90]::smallint[]
  ),
  CONSTRAINT profile_capture_contracts_metrics CHECK (
    pg_catalog.cardinality(attestable_metrics) > 0
    AND attestable_metrics <@ arena.profile_attestable_metrics()
  )
);

COMMENT ON TABLE arena.profile_capture_contracts IS
  'Append-only registry of reviewed Tier-B profile capture contracts. contract_sha256 is the strict-canonical sha256 of the worker contract document.';

CREATE TABLE arena.profile_acquisition_attempts (
  attempt_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id uuid NOT NULL UNIQUE,
  source_id smallint NOT NULL,
  -- Soft reference, like arena.raw_objects.trader_id: evidence outlives
  -- trader churn. The start RPC proves the trader belongs to the source.
  trader_id bigint NOT NULL,
  timeframe smallint NOT NULL,
  capture_contract text NOT NULL,
  runner_git_sha text,
  recorded_started_at timestamptz NOT NULL,
  FOREIGN KEY (source_id, capture_contract)
    REFERENCES arena.profile_capture_contracts(source_id, capture_contract)
    ON DELETE RESTRICT,
  CONSTRAINT profile_acquisition_attempts_timeframe CHECK (timeframe IN (7, 30, 90)),
  CONSTRAINT profile_acquisition_attempts_git_sha CHECK (
    runner_git_sha IS NULL OR runner_git_sha ~ '^[0-9a-f]{40}$'
  )
);

CREATE INDEX idx_profile_acquisition_attempts_subject
  ON arena.profile_acquisition_attempts (source_id, trader_id, timeframe, attempt_seq DESC);

CREATE TABLE arena.profile_acquisition_outcomes (
  attempt_seq bigint PRIMARY KEY
    REFERENCES arena.profile_acquisition_attempts(attempt_seq) ON DELETE RESTRICT,
  terminal_state text NOT NULL,
  reason_code text,
  source_payload_raw_object_id bigint,
  source_payload_sha256 text,
  source_run_id text,
  manifest jsonb,
  request_projection_sha256s text[],
  response_sha256s text[],
  attested_metrics text[] NOT NULL,
  -- Database clock at finish; freshness is judged by the attempt's
  -- recorded_started_at (before the fetch, so never newer than the data).
  capture_completed_at timestamptz,
  recorded_completed_at timestamptz NOT NULL,
  CONSTRAINT profile_acquisition_outcomes_state CHECK (
    terminal_state IN (
      'complete', 'partial', 'upstream_failed', 'processing_failed',
      'quality_rejected', 'abandoned'
    )
  ),
  CONSTRAINT profile_acquisition_outcomes_reason CHECK (
    (terminal_state = 'complete') = (reason_code IS NULL)
    AND (reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]{0,63}$')
  ),
  CONSTRAINT profile_acquisition_outcomes_complete_evidence CHECK (
    terminal_state <> 'complete'
    OR (
      source_payload_raw_object_id > 0
      AND source_payload_sha256 ~ '^[0-9a-f]{64}$'
      AND source_run_id ~ '^[0-9a-f]{64}$'
      AND manifest IS NOT NULL
      AND pg_catalog.cardinality(request_projection_sha256s) > 0
      AND pg_catalog.cardinality(request_projection_sha256s)
        = pg_catalog.cardinality(response_sha256s)
      AND capture_completed_at IS NOT NULL
    )
  ),
  CONSTRAINT profile_acquisition_outcomes_incomplete_attests_nothing CHECK (
    terminal_state = 'complete'
    OR (
      pg_catalog.cardinality(attested_metrics) = 0
      AND source_run_id IS NULL
      AND manifest IS NULL
    )
  ),
  CONSTRAINT profile_acquisition_outcomes_metrics CHECK (
    attested_metrics <@ arena.profile_attestable_metrics()
  )
);

CREATE UNIQUE INDEX uidx_profile_acquisition_outcomes_run
  ON arena.profile_acquisition_outcomes (source_run_id)
  WHERE source_run_id IS NOT NULL;
CREATE UNIQUE INDEX uidx_profile_acquisition_outcomes_raw
  ON arena.profile_acquisition_outcomes (source_payload_raw_object_id)
  WHERE source_payload_raw_object_id IS NOT NULL;

COMMENT ON TABLE arena.profile_acquisition_outcomes IS
  'One append-only typed terminal per profile attempt. Only complete outcomes attest metrics; RAW id/hash are audit evidence without a RAW foreign key (RAW retention).';

CREATE FUNCTION arena.reject_direct_profile_acquisition_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_path text := pg_catalog.current_setting('arena.profile_acquisition_mutation_path', true);
BEGIN
  IF TG_OP = 'INSERT'
     AND (
       (TG_TABLE_NAME = 'profile_acquisition_attempts'
        AND v_path = 'start_profile_acquisition_attempt')
       OR
       (TG_TABLE_NAME = 'profile_acquisition_outcomes'
        AND v_path = 'finish_profile_acquisition_attempt')
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'profile acquisition ledger is append-only and RPC-owned (% %)',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = '42501';
END
$function$;

CREATE TRIGGER profile_acquisition_attempts_reject_direct_row_mutation
BEFORE INSERT OR UPDATE OR DELETE ON arena.profile_acquisition_attempts
FOR EACH ROW EXECUTE FUNCTION arena.reject_direct_profile_acquisition_mutation();

CREATE TRIGGER profile_acquisition_attempts_reject_truncate
BEFORE TRUNCATE ON arena.profile_acquisition_attempts
FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_direct_profile_acquisition_mutation();

CREATE TRIGGER profile_acquisition_outcomes_reject_direct_row_mutation
BEFORE INSERT OR UPDATE OR DELETE ON arena.profile_acquisition_outcomes
FOR EACH ROW EXECUTE FUNCTION arena.reject_direct_profile_acquisition_mutation();

CREATE TRIGGER profile_acquisition_outcomes_reject_truncate
BEFORE TRUNCATE ON arena.profile_acquisition_outcomes
FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_direct_profile_acquisition_mutation();

CREATE FUNCTION arena.reject_profile_capture_contract_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'profile capture contracts are append-only (% %)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '42501';
END
$function$;

CREATE TRIGGER profile_capture_contracts_reject_row_mutation
BEFORE UPDATE OR DELETE ON arena.profile_capture_contracts
FOR EACH ROW EXECUTE FUNCTION arena.reject_profile_capture_contract_mutation();

CREATE TRIGGER profile_capture_contracts_reject_truncate
BEFORE TRUNCATE ON arena.profile_capture_contracts
FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_profile_capture_contract_mutation();

CREATE FUNCTION arena.start_profile_acquisition_attempt(
  p_attempt_id uuid,
  p_source_id integer,
  p_trader_id bigint,
  p_timeframe integer,
  p_capture_contract text,
  p_contract_sha256 text,
  p_runner_git_sha text
)
RETURNS TABLE (attempt_seq bigint, recorded_started_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  -- profile-acquisition-start@1
  v_seq bigint;
  v_started timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_attempt_id IS NULL THEN
    RAISE EXCEPTION 'profile attempt id is required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM arena.profile_capture_contracts AS contract
    JOIN arena.sources AS source ON source.id = contract.source_id
    WHERE contract.source_id = p_source_id
      AND contract.capture_contract = p_capture_contract
      AND contract.contract_sha256 = p_contract_sha256
      AND p_timeframe = ANY (contract.timeframes)
      AND source.status = 'active'
  ) THEN
    RAISE EXCEPTION 'profile capture contract % (%) is not registered for source % timeframe %',
      p_capture_contract, p_contract_sha256, p_source_id, p_timeframe
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM arena.traders AS trader
    WHERE trader.id = p_trader_id AND trader.source_id = p_source_id
  ) THEN
    RAISE EXCEPTION 'trader % does not belong to source %', p_trader_id, p_source_id
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config(
    'arena.profile_acquisition_mutation_path', 'start_profile_acquisition_attempt', true
  );
  INSERT INTO arena.profile_acquisition_attempts AS attempt (
    attempt_id, source_id, trader_id, timeframe, capture_contract, runner_git_sha,
    recorded_started_at
  ) VALUES (
    p_attempt_id, p_source_id, p_trader_id, p_timeframe, p_capture_contract,
    p_runner_git_sha, v_started
  )
  RETURNING attempt.attempt_seq INTO v_seq;
  PERFORM pg_catalog.set_config('arena.profile_acquisition_mutation_path', '', true);

  attempt_seq := v_seq;
  recorded_started_at := v_started;
  RETURN NEXT;
END
$function$;

CREATE FUNCTION arena.finish_profile_acquisition_attempt(
  p_attempt_seq bigint,
  p_attempt_id uuid,
  p_terminal_state text,
  p_reason_code text,
  p_source_payload_raw_object_id bigint,
  p_source_run_id text,
  p_manifest jsonb
)
RETURNS TABLE (attempt_seq bigint, terminal_state text, recorded_completed_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  -- profile-acquisition-finish@1
  v_attempt arena.profile_acquisition_attempts%ROWTYPE;
  v_contract arena.profile_capture_contracts%ROWTYPE;
  v_raw arena.raw_objects%ROWTYPE;
  v_exchange_trader_id text;
  v_requests jsonb;
  v_metrics text[] := ARRAY[]::text[];
  v_request_hashes text[];
  v_response_hashes text[];
  v_completed timestamptz := pg_catalog.clock_timestamp();
BEGIN
  SELECT * INTO v_attempt
  FROM arena.profile_acquisition_attempts AS attempt
  WHERE attempt.attempt_seq = p_attempt_seq
  FOR SHARE;
  IF NOT FOUND OR v_attempt.attempt_id IS DISTINCT FROM p_attempt_id THEN
    RAISE EXCEPTION 'profile attempt % is not attempt %', p_attempt_seq, p_attempt_id
      USING ERRCODE = '22023';
  END IF;

  IF p_source_payload_raw_object_id IS NOT NULL THEN
    -- Any cited RAW is exactly this attempt's tier_b capture.
    SELECT * INTO v_raw FROM arena.raw_objects AS raw WHERE raw.id = p_source_payload_raw_object_id;
    IF NOT FOUND
       OR v_raw.source_id <> v_attempt.source_id
       OR v_raw.job_type <> 'tier_b'
       OR v_raw.trader_id IS DISTINCT FROM v_attempt.trader_id
       OR v_raw.timeframe IS DISTINCT FROM v_attempt.timeframe
       OR v_raw.fetched_at < v_attempt.recorded_started_at
       OR v_raw.content_hash !~ '^[0-9a-f]{64}$'
       OR v_raw.meta->'profile_capture'->>'attempt_id' IS DISTINCT FROM v_attempt.attempt_id::text
       OR v_raw.meta->'profile_capture'->>'capture_contract'
         IS DISTINCT FROM v_attempt.capture_contract THEN
      RAISE EXCEPTION 'RAW % is not the tier_b capture of profile attempt %',
        p_source_payload_raw_object_id, p_attempt_seq
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_terminal_state = 'complete' THEN
    SELECT * INTO STRICT v_contract
    FROM arena.profile_capture_contracts AS contract
    WHERE contract.source_id = v_attempt.source_id
      AND contract.capture_contract = v_attempt.capture_contract;
    SELECT trader.exchange_trader_id INTO v_exchange_trader_id
    FROM arena.traders AS trader WHERE trader.id = v_attempt.trader_id;

    v_requests := p_manifest->'requests';
    IF p_source_payload_raw_object_id IS NULL
       OR pg_catalog.jsonb_typeof(p_manifest) IS DISTINCT FROM 'object'
       OR p_manifest->>'contract' IS DISTINCT FROM 'profile-acquisition-manifest@1'
       OR p_manifest->>'attempt_id' IS DISTINCT FROM v_attempt.attempt_id::text
       OR p_manifest->>'capture_contract' IS DISTINCT FROM v_contract.capture_contract
       OR p_manifest->>'capture_contract_sha256' IS DISTINCT FROM v_contract.contract_sha256
       OR p_manifest->'timeframe' IS DISTINCT FROM pg_catalog.to_jsonb(v_attempt.timeframe::integer)
       OR p_manifest->>'exchange_trader_id' IS DISTINCT FROM v_exchange_trader_id
       OR pg_catalog.jsonb_typeof(v_requests) IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(v_requests) = 0
       OR pg_catalog.jsonb_typeof(p_manifest->'metrics') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'profile attempt % complete outcome is not bound to its attempt', p_attempt_seq
        USING ERRCODE = '22023';
    END IF;

    SELECT
      pg_catalog.array_agg(request.value->>'request_projection_sha256' ORDER BY request.ordinality),
      pg_catalog.array_agg(request.value->>'response_sha256' ORDER BY request.ordinality)
    INTO v_request_hashes, v_response_hashes
    FROM pg_catalog.jsonb_array_elements(v_requests) WITH ORDINALITY AS request(value, ordinality);
    IF EXISTS (
      SELECT 1 FROM pg_catalog.unnest(v_request_hashes || v_response_hashes) AS hash(value)
      WHERE hash.value IS NULL OR hash.value !~ '^[0-9a-f]{64}$'
    ) THEN
      RAISE EXCEPTION 'profile attempt % manifest request hashes are malformed', p_attempt_seq
        USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(pg_catalog.array_agg(metric.key ORDER BY metric.key), ARRAY[]::text[])
    INTO v_metrics
    FROM pg_catalog.jsonb_each(p_manifest->'metrics') AS metric(key, value);
    IF NOT (v_metrics <@ v_contract.attestable_metrics)
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_each(p_manifest->'metrics') AS metric(key, value)
         WHERE pg_catalog.jsonb_typeof(metric.value->'value') IS DISTINCT FROM 'number'
       ) THEN
      RAISE EXCEPTION 'profile attempt % attests metrics outside contract %',
        p_attempt_seq, v_contract.capture_contract
        USING ERRCODE = '22023';
    END IF;
  ELSIF p_terminal_state IN (
    'partial', 'upstream_failed', 'processing_failed', 'quality_rejected', 'abandoned'
  ) THEN
    IF p_source_run_id IS NOT NULL OR p_manifest IS NOT NULL THEN
      RAISE EXCEPTION 'an incomplete profile outcome carries no capture manifest'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    RAISE EXCEPTION 'unknown profile terminal state %', p_terminal_state USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config(
    'arena.profile_acquisition_mutation_path', 'finish_profile_acquisition_attempt', true
  );
  INSERT INTO arena.profile_acquisition_outcomes (
    attempt_seq, terminal_state, reason_code, source_payload_raw_object_id,
    source_payload_sha256, source_run_id, manifest, request_projection_sha256s,
    response_sha256s, attested_metrics, capture_completed_at, recorded_completed_at
  ) VALUES (
    p_attempt_seq, p_terminal_state, p_reason_code, p_source_payload_raw_object_id,
    CASE WHEN p_source_payload_raw_object_id IS NOT NULL THEN v_raw.content_hash END,
    p_source_run_id, p_manifest, v_request_hashes, v_response_hashes, v_metrics,
    CASE WHEN p_terminal_state = 'complete' THEN v_completed END, v_completed
  );
  PERFORM pg_catalog.set_config('arena.profile_acquisition_mutation_path', '', true);

  attempt_seq := p_attempt_seq;
  terminal_state := p_terminal_state;
  recorded_completed_at := v_completed;
  RETURN NEXT;
END
$function$;

ALTER TABLE arena.trader_stats
  ADD COLUMN profile_evidence_attempt_seq bigint,
  ADD COLUMN profile_evidence_metrics text[];

COMMENT ON COLUMN arena.trader_stats.profile_evidence_attempt_seq IS
  'Complete profile acquisition attempt (arena.profile_acquisition_outcomes) that attested profile_evidence_metrics.';
COMMENT ON COLUMN arena.trader_stats.profile_evidence_metrics IS
  'Score-input metrics whose stored values equal the values that profile capture attested.';

ALTER TABLE arena.trader_stats
  ADD CONSTRAINT trader_stats_profile_evidence_shape CHECK (
    (profile_evidence_attempt_seq IS NULL AND profile_evidence_metrics IS NULL)
    OR (
      profile_evidence_attempt_seq > 0
      AND pg_catalog.cardinality(profile_evidence_metrics) > 0
      AND profile_evidence_metrics <@ arena.profile_attestable_metrics()
    )
  ) NOT VALID;

ALTER TABLE arena.trader_stats
  VALIDATE CONSTRAINT trader_stats_profile_evidence_shape;

CREATE FUNCTION arena.trader_stats_profile_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  -- trader-stats-profile-evidence@1
  v_new jsonb;
  v_old jsonb;
  v_manifest jsonb;
  v_attested text[];
BEGIN
  IF NEW.profile_evidence_attempt_seq IS NULL THEN
    NEW.profile_evidence_metrics := NULL;
    RETURN NEW;
  END IF;

  v_new := pg_catalog.to_jsonb(NEW);
  IF TG_OP = 'UPDATE'
     AND NEW.profile_evidence_attempt_seq = OLD.profile_evidence_attempt_seq
     AND NEW.trader_id = OLD.trader_id
     AND NEW.timeframe = OLD.timeframe THEN
    -- Not a new attestation: keep only attested values this write left alone.
    v_old := pg_catalog.to_jsonb(OLD);
    NEW.profile_evidence_metrics := ARRAY(
      SELECT metric.name
      FROM pg_catalog.unnest(COALESCE(OLD.profile_evidence_metrics, ARRAY[]::text[]))
        AS metric(name)
      WHERE arena.trader_stats_score_input_value(v_new, metric.name) IS NOT NULL
        AND arena.trader_stats_score_input_value(v_new, metric.name)
          = arena.trader_stats_score_input_value(v_old, metric.name)
      ORDER BY metric.name
    );
  ELSE
    SELECT outcome.manifest, outcome.attested_metrics
    INTO v_manifest, v_attested
    FROM arena.profile_acquisition_outcomes AS outcome
    JOIN arena.profile_acquisition_attempts AS attempt
      ON attempt.attempt_seq = outcome.attempt_seq
    WHERE outcome.attempt_seq = NEW.profile_evidence_attempt_seq
      AND outcome.terminal_state = 'complete'
      AND attempt.trader_id = NEW.trader_id
      AND attempt.timeframe = NEW.timeframe;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'profile evidence attempt % is not a complete capture of trader % timeframe %',
        NEW.profile_evidence_attempt_seq, NEW.trader_id, NEW.timeframe
        USING ERRCODE = '22023';
    END IF;
    -- A new attestation covers only listed metrics the capture attested and
    -- whose stored value is exactly the captured value.
    NEW.profile_evidence_metrics := ARRAY(
      SELECT DISTINCT metric.name
      FROM pg_catalog.unnest(COALESCE(NEW.profile_evidence_metrics, ARRAY[]::text[]))
        AS metric(name)
      WHERE metric.name = ANY (v_attested)
        AND arena.trader_stats_score_input_value(v_new, metric.name) IS NOT NULL
        AND arena.trader_stats_score_input_value(v_new, metric.name)
          = v_manifest->'metrics'->metric.name->'value'
      ORDER BY metric.name
    );
  END IF;

  IF pg_catalog.cardinality(NEW.profile_evidence_metrics) = 0 THEN
    NEW.profile_evidence_attempt_seq := NULL;
    NEW.profile_evidence_metrics := NULL;
  END IF;
  RETURN NEW;
END
$function$;

-- No OR REPLACE for triggers; the preflight proves this runs once.
CREATE TRIGGER trader_stats_profile_evidence
  BEFORE INSERT OR UPDATE ON arena.trader_stats
  FOR EACH ROW EXECUTE FUNCTION arena.trader_stats_profile_evidence();

ALTER TABLE arena.profile_capture_contracts OWNER TO postgres;
ALTER TABLE arena.profile_acquisition_attempts OWNER TO postgres;
ALTER TABLE arena.profile_acquisition_outcomes OWNER TO postgres;
ALTER TABLE arena.profile_capture_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.profile_acquisition_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.profile_acquisition_outcomes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE
  arena.profile_capture_contracts,
  arena.profile_acquisition_attempts,
  arena.profile_acquisition_outcomes
  FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION arena.profile_attestable_metrics() OWNER TO postgres;
ALTER FUNCTION arena.reject_direct_profile_acquisition_mutation() OWNER TO postgres;
ALTER FUNCTION arena.reject_profile_capture_contract_mutation() OWNER TO postgres;
ALTER FUNCTION arena.start_profile_acquisition_attempt(uuid, integer, bigint, integer, text, text, text)
  OWNER TO postgres;
ALTER FUNCTION arena.finish_profile_acquisition_attempt(bigint, uuid, text, text, bigint, text, jsonb)
  OWNER TO postgres;
ALTER FUNCTION arena.trader_stats_profile_evidence() OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.profile_attestable_metrics()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.reject_direct_profile_acquisition_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.reject_profile_capture_contract_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.start_profile_acquisition_attempt(uuid, integer, bigint, integer, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.finish_profile_acquisition_attempt(bigint, uuid, text, text, bigint, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.trader_stats_profile_evidence()
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON SEQUENCE arena.profile_acquisition_attempts_attempt_seq_seq
  FROM PUBLIC, anon, authenticated, service_role;

-- The worker calls the two RPCs; nothing writes the ledger directly.
GRANT SELECT ON TABLE arena.profile_capture_contracts TO service_role;
GRANT SELECT ON TABLE arena.profile_acquisition_attempts TO service_role;
GRANT SELECT ON TABLE arena.profile_acquisition_outcomes TO service_role;
GRANT EXECUTE ON FUNCTION arena.start_profile_acquisition_attempt(uuid, integer, bigint, integer, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION arena.finish_profile_acquisition_attempt(bigint, uuid, text, text, bigint, text, jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
