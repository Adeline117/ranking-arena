-- Field-level ranking trust substrate.
--
-- This migration deliberately does not replace arena.score_inputs yet. It
-- creates an append-only evidence path and a fail-closed shadow input set so
-- publishers canary real source evidence before the public ranking cutover.
-- Rows without registered, fresh, immutable evidence never enter the shadow.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_snapshots') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_entries') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL THEN
    RAISE EXCEPTION 'metric trust foundations are missing';
  END IF;

  IF pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'PostgREST roles are missing';
  END IF;

  IF (SELECT pg_catalog.count(*)
        FROM arena.sources
       WHERE slug = ANY (ARRAY['binance_futures', 'binance_web3_bsc'])) <> 2 THEN
    RAISE EXCEPTION 'initial metric trust source registry is incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'arena'
       AND table_name = 'raw_objects'
       AND column_name IN ('source_run_id', 'trust_artifact_role')
  ) THEN
    RAISE EXCEPTION 'arena.raw_objects metric trust columns already exist';
  END IF;
END
$preflight$;

-- Every ranked RAW artifact must be tied to the same acquisition run. Legacy
-- RAW rows remain NULL and are therefore ineligible until replayed.
ALTER TABLE arena.raw_objects
  ADD COLUMN source_run_id text,
  ADD COLUMN trust_artifact_role text;

ALTER TABLE arena.raw_objects
  ADD CONSTRAINT raw_objects_metric_trust_binding
  CHECK (
    (source_run_id IS NULL AND trust_artifact_role IS NULL)
    OR (
      source_run_id ~ '^[0-9a-f]{64}$'
      AND trust_artifact_role IN (
        'source_payload',
        'population_manifest',
        'normalization_components',
        'event_history',
        'price_history',
        'opening_inventory'
      )
    )
  );

CREATE INDEX idx_arena_raw_objects_source_run
  ON arena.raw_objects (source_id, source_run_id, timeframe)
  WHERE source_run_id IS NOT NULL;

CREATE TABLE arena.metric_source_contracts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id) ON DELETE RESTRICT,
  contract_version text NOT NULL CHECK (pg_catalog.btrim(contract_version) <> ''),
  metric text NOT NULL CHECK (metric IN ('roi', 'pnl', 'win_rate', 'mdd', 'sharpe')),
  field_path text NOT NULL CHECK (pg_catalog.btrim(field_path) <> ''),
  provenance text NOT NULL CHECK (
    provenance IN ('source_reported', 'source_normalized', 'arena_rebuilt', 'derived')
  ),
  methodology_version text NOT NULL CHECK (pg_catalog.btrim(methodology_version) <> ''),
  metric_set_id text NOT NULL CHECK (pg_catalog.btrim(metric_set_id) <> ''),
  timeframes smallint[] NOT NULL CHECK (
    pg_catalog.cardinality(timeframes) > 0
    AND timeframes <@ ARRAY[7, 30, 90]::smallint[]
    AND pg_catalog.array_position(timeframes, NULL) IS NULL
  ),
  value_unit text NOT NULL CHECK (value_unit IN ('percent', 'currency', 'ratio')),
  currencies text[] NOT NULL CHECK (
    pg_catalog.cardinality(currencies) > 0
    AND currencies <@ ARRAY['USDT', 'USDx', 'USDC', 'USD']::text[]
    AND pg_catalog.array_position(currencies, NULL) IS NULL
  ),
  required_raw_roles text[] NOT NULL CHECK (
    pg_catalog.cardinality(required_raw_roles) > 0
    AND required_raw_roles <@ ARRAY[
      'source_payload',
      'population_manifest',
      'normalization_components',
      'event_history',
      'price_history',
      'opening_inventory'
    ]::text[]
    AND pg_catalog.array_position(required_raw_roles, NULL) IS NULL
  ),
  source_payload_scope text NOT NULL CHECK (
    source_payload_scope IN ('population_snapshot', 'metric_payload', 'not_required')
  ),
  max_freshness interval NOT NULL CHECK (max_freshness > interval '0 seconds'),
  max_window_end_lag interval NOT NULL CHECK (max_window_end_lag >= interval '0 seconds'),
  allow_derived_population boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (
    source_id,
    contract_version,
    metric,
    field_path,
    provenance,
    methodology_version
  ),
  CHECK (
    (source_payload_scope = 'not_required')
    = NOT ('source_payload' = ANY (required_raw_roles))
  )
);

-- One immutable acquisition run joins the passed population snapshot to its
-- exact Tier-A payload and canonical manifest. source_run_id is the SHA-256
-- digest of that manifest, not a retry/cycle correlation token.
CREATE TABLE arena.metric_trust_runs (
  source_run_id text PRIMARY KEY CHECK (source_run_id ~ '^[0-9a-f]{64}$'),
  source_id smallint NOT NULL REFERENCES arena.sources(id) ON DELETE RESTRICT,
  timeframe smallint NOT NULL CHECK (timeframe IN (7, 30, 90)),
  snapshot_id bigint NOT NULL
    REFERENCES arena.leaderboard_snapshots(id) ON DELETE CASCADE,
  snapshot_scraped_at timestamptz NOT NULL,
  population_raw_object_id bigint NOT NULL
    REFERENCES arena.raw_objects(id) ON DELETE CASCADE,
  manifest_raw_object_id bigint NOT NULL
    REFERENCES arena.raw_objects(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  reported_population int CHECK (reported_population IS NULL OR reported_population >= 0),
  fetched_population int NOT NULL CHECK (fetched_population >= 0),
  caller_limited boolean NOT NULL,
  acquisition_state text NOT NULL CHECK (
    acquisition_state IN ('complete', 'partial', 'unknown')
  ),
  population_state text NOT NULL CHECK (
    population_state IN ('verified', 'partial', 'unknown')
  ),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (started_at <= completed_at),
  CHECK (population_raw_object_id <> manifest_raw_object_id),
  UNIQUE (snapshot_id)
);

CREATE TABLE arena.metric_trust_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contract_id bigint NOT NULL
    REFERENCES arena.metric_source_contracts(id) ON DELETE RESTRICT,
  trader_id bigint NOT NULL REFERENCES arena.traders(id) ON DELETE CASCADE,
  source_id smallint NOT NULL REFERENCES arena.sources(id) ON DELETE RESTRICT,
  snapshot_id bigint NOT NULL
    REFERENCES arena.leaderboard_snapshots(id) ON DELETE CASCADE,
  snapshot_scraped_at timestamptz NOT NULL,
  source_run_id text NOT NULL
    REFERENCES arena.metric_trust_runs(source_run_id) ON DELETE CASCADE,
  source_contract_version text NOT NULL
    CHECK (pg_catalog.btrim(source_contract_version) <> ''),
  timeframe smallint NOT NULL CHECK (timeframe IN (7, 30, 90)),
  metric text NOT NULL CHECK (metric IN ('roi', 'pnl', 'win_rate', 'mdd', 'sharpe')),
  field_path text NOT NULL CHECK (pg_catalog.btrim(field_path) <> ''),
  provenance text NOT NULL CHECK (
    provenance IN ('source_reported', 'source_normalized', 'arena_rebuilt', 'derived')
  ),
  methodology_version text NOT NULL CHECK (pg_catalog.btrim(methodology_version) <> ''),
  value numeric,
  value_unit text NOT NULL CHECK (value_unit IN ('percent', 'currency', 'ratio')),
  currency text NOT NULL CHECK (currency IN ('USDT', 'USDx', 'USDC', 'USD')),
  source_as_of timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  quality text NOT NULL CHECK (quality IN ('complete', 'partial', 'unknown', 'unsupported')),
  history_state text NOT NULL CHECK (
    history_state IN ('verified', 'source_owned', 'not_required', 'partial', 'unknown')
  ),
  price_state text NOT NULL CHECK (
    price_state IN ('verified', 'source_owned', 'not_required', 'partial', 'unknown')
  ),
  cost_basis_state text NOT NULL CHECK (
    cost_basis_state IN ('verified', 'source_owned', 'not_required', 'partial', 'unknown')
  ),
  population_state text NOT NULL CHECK (
    population_state IN ('verified', 'source_owned', 'not_required', 'partial', 'unknown')
  ),
  window_state text NOT NULL CHECK (
    window_state IN ('verified', 'source_owned', 'not_required', 'partial', 'unknown')
  ),
  unit_state text NOT NULL CHECK (
    unit_state IN ('verified', 'source_owned', 'not_required', 'partial', 'unknown')
  ),
  freshness_state text NOT NULL CHECK (
    freshness_state IN ('verified', 'source_owned', 'not_required', 'partial', 'unknown')
  ),
  blocking_reasons jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (pg_catalog.jsonb_typeof(blocking_reasons) = 'array'),
  evaluator_version text NOT NULL DEFAULT 'metric-trust@1'
    CHECK (evaluator_version = 'metric-trust@1'),
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (window_start < window_end),
  CHECK (source_as_of < valid_until),
  FOREIGN KEY (snapshot_scraped_at, snapshot_id, trader_id)
    REFERENCES arena.leaderboard_entries (scraped_at, snapshot_id, trader_id)
    ON DELETE CASCADE,
  UNIQUE (contract_id, trader_id, snapshot_id)
);

CREATE INDEX idx_arena_metric_trust_observations_lookup
  ON arena.metric_trust_observations
    (source_id, timeframe, metric, trader_id, source_as_of DESC);

CREATE INDEX idx_arena_metric_trust_observations_run
  ON arena.metric_trust_observations (source_id, source_run_id, snapshot_id);

CREATE TABLE arena.metric_trust_artifacts (
  observation_id bigint NOT NULL
    REFERENCES arena.metric_trust_observations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN (
    'source_payload',
    'population_manifest',
    'normalization_components',
    'event_history',
    'price_history',
    'opening_inventory'
  )),
  raw_object_id bigint NOT NULL REFERENCES arena.raw_objects(id) ON DELETE CASCADE,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (observation_id, role, raw_object_id),
  UNIQUE (observation_id, raw_object_id)
);

CREATE INDEX idx_arena_metric_trust_artifacts_raw
  ON arena.metric_trust_artifacts (raw_object_id);

CREATE FUNCTION arena.validate_metric_trust_run()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_snapshot_source_id smallint;
  v_snapshot_timeframe smallint;
  v_snapshot_scraped_at timestamptz;
  v_snapshot_actual_count int;
  v_snapshot_passed boolean;
  v_snapshot_raw_object_id bigint;
  v_population_source_id smallint;
  v_population_timeframe smallint;
  v_population_run_id text;
  v_population_role text;
  v_population_fetched_at timestamptz;
  v_population_hash text;
  v_population_quarantined boolean;
  v_population_meta jsonb;
  v_manifest_source_id smallint;
  v_manifest_timeframe smallint;
  v_manifest_run_id text;
  v_manifest_role text;
  v_manifest_fetched_at timestamptz;
  v_manifest_hash text;
  v_manifest_quarantined boolean;
  v_manifest_meta jsonb;
BEGIN
  SELECT
    source_id,
    timeframe,
    scraped_at,
    actual_count,
    count_check_passed,
    raw_object_id
  INTO STRICT
    v_snapshot_source_id,
    v_snapshot_timeframe,
    v_snapshot_scraped_at,
    v_snapshot_actual_count,
    v_snapshot_passed,
    v_snapshot_raw_object_id
  FROM arena.leaderboard_snapshots
  WHERE id = NEW.snapshot_id;

  SELECT
    source_id,
    timeframe,
    source_run_id,
    trust_artifact_role,
    fetched_at,
    content_hash,
    quarantined,
    meta
  INTO STRICT
    v_population_source_id,
    v_population_timeframe,
    v_population_run_id,
    v_population_role,
    v_population_fetched_at,
    v_population_hash,
    v_population_quarantined,
    v_population_meta
  FROM arena.raw_objects
  WHERE id = NEW.population_raw_object_id;

  SELECT
    source_id,
    timeframe,
    source_run_id,
    trust_artifact_role,
    fetched_at,
    content_hash,
    quarantined,
    meta
  INTO STRICT
    v_manifest_source_id,
    v_manifest_timeframe,
    v_manifest_run_id,
    v_manifest_role,
    v_manifest_fetched_at,
    v_manifest_hash,
    v_manifest_quarantined,
    v_manifest_meta
  FROM arena.raw_objects
  WHERE id = NEW.manifest_raw_object_id;

  IF NEW.source_id IS DISTINCT FROM v_snapshot_source_id
     OR NEW.timeframe IS DISTINCT FROM v_snapshot_timeframe
     OR NEW.snapshot_scraped_at IS DISTINCT FROM v_snapshot_scraped_at
     OR NEW.population_raw_object_id IS DISTINCT FROM v_snapshot_raw_object_id
     OR v_population_source_id IS DISTINCT FROM NEW.source_id
     OR v_population_timeframe IS DISTINCT FROM NEW.timeframe
     OR v_population_run_id IS DISTINCT FROM NEW.source_run_id
     OR v_population_role IS DISTINCT FROM 'source_payload'
     OR v_manifest_source_id IS DISTINCT FROM NEW.source_id
     OR v_manifest_timeframe IS DISTINCT FROM NEW.timeframe
     OR v_manifest_run_id IS DISTINCT FROM NEW.source_run_id
     OR v_manifest_role IS DISTINCT FROM 'population_manifest'
     OR v_manifest_hash IS DISTINCT FROM NEW.source_run_id
     OR v_population_hash !~ '^[0-9a-f]{64}$'
     OR v_population_quarantined
     OR v_manifest_quarantined
     OR v_population_meta->'raw_integrity'->>'hash_algorithm' IS DISTINCT FROM 'sha256'
     OR v_population_meta->'raw_integrity'->>'hash_scope' IS DISTINCT FROM 'json_utf8'
     OR v_manifest_meta->'raw_integrity'->>'hash_algorithm' IS DISTINCT FROM 'sha256'
     OR v_manifest_meta->'raw_integrity'->>'hash_scope' IS DISTINCT FROM 'json_utf8' THEN
    RAISE EXCEPTION 'metric trust run is not bound to its snapshot and canonical RAW manifest';
  END IF;

  IF v_population_fetched_at < NEW.started_at - interval '5 minutes'
     OR v_population_fetched_at > NEW.completed_at + interval '5 minutes'
     OR v_manifest_fetched_at < NEW.started_at - interval '5 minutes'
     OR v_manifest_fetched_at > NEW.completed_at + interval '5 minutes'
     OR NEW.completed_at > NEW.snapshot_scraped_at + interval '5 minutes' THEN
    RAISE EXCEPTION 'metric trust run timestamps do not describe the bound acquisition';
  END IF;

  IF (
    NEW.acquisition_state = 'complete'
    OR NEW.population_state = 'verified'
  ) AND (
    NOT v_snapshot_passed
    OR NEW.caller_limited
    OR NEW.fetched_population IS DISTINCT FROM v_snapshot_actual_count
    OR (
      NEW.reported_population IS NOT NULL
      AND NEW.reported_population IS DISTINCT FROM NEW.fetched_population
    )
  ) THEN
    RAISE EXCEPTION 'complete metric trust run requires a full passed population';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER validate_metric_trust_run_before_insert
BEFORE INSERT ON arena.metric_trust_runs
FOR EACH ROW EXECUTE FUNCTION arena.validate_metric_trust_run();

CREATE FUNCTION arena.validate_metric_trust_observation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_contract arena.metric_source_contracts%ROWTYPE;
  v_trader_source_id smallint;
  v_snapshot_source_id smallint;
  v_snapshot_timeframe smallint;
  v_snapshot_scraped_at timestamptz;
  v_snapshot_passed boolean;
  v_snapshot_derived boolean;
  v_run_source_id smallint;
  v_run_timeframe smallint;
  v_run_snapshot_id bigint;
  v_run_snapshot_scraped_at timestamptz;
  v_run_completed_at timestamptz;
  v_run_acquisition_state text;
  v_run_population_state text;
BEGIN
  SELECT *
    INTO STRICT v_contract
    FROM arena.metric_source_contracts
   WHERE id = NEW.contract_id;

  SELECT source_id
    INTO STRICT v_trader_source_id
    FROM arena.traders
   WHERE id = NEW.trader_id;

  SELECT source_id, timeframe, scraped_at, count_check_passed, is_derived
    INTO STRICT
      v_snapshot_source_id,
      v_snapshot_timeframe,
      v_snapshot_scraped_at,
      v_snapshot_passed,
      v_snapshot_derived
    FROM arena.leaderboard_snapshots
   WHERE id = NEW.snapshot_id;

  SELECT
    source_id,
    timeframe,
    snapshot_id,
    snapshot_scraped_at,
    completed_at,
    acquisition_state,
    population_state
  INTO STRICT
    v_run_source_id,
    v_run_timeframe,
    v_run_snapshot_id,
    v_run_snapshot_scraped_at,
    v_run_completed_at,
    v_run_acquisition_state,
    v_run_population_state
  FROM arena.metric_trust_runs
  WHERE source_run_id = NEW.source_run_id;

  IF NEW.source_id IS DISTINCT FROM v_contract.source_id
     OR NEW.source_id IS DISTINCT FROM v_trader_source_id
     OR NEW.source_id IS DISTINCT FROM v_snapshot_source_id
     OR NEW.source_id IS DISTINCT FROM v_run_source_id
     OR NEW.timeframe IS DISTINCT FROM v_snapshot_timeframe
     OR NEW.timeframe IS DISTINCT FROM v_run_timeframe
     OR NEW.snapshot_scraped_at IS DISTINCT FROM v_snapshot_scraped_at
     OR NEW.snapshot_id IS DISTINCT FROM v_run_snapshot_id
     OR NEW.snapshot_scraped_at IS DISTINCT FROM v_run_snapshot_scraped_at
     OR NEW.source_contract_version IS DISTINCT FROM v_contract.contract_version
     OR NEW.metric IS DISTINCT FROM v_contract.metric
     OR NEW.field_path IS DISTINCT FROM v_contract.field_path
     OR NEW.provenance IS DISTINCT FROM v_contract.provenance
     OR NEW.methodology_version IS DISTINCT FROM v_contract.methodology_version
     OR NEW.value_unit IS DISTINCT FROM v_contract.value_unit
     OR NOT (NEW.timeframe = ANY (v_contract.timeframes))
     OR NOT (NEW.currency = ANY (v_contract.currencies)) THEN
    RAISE EXCEPTION 'metric trust observation does not match its registered contract';
  END IF;

  IF NEW.source_as_of > v_run_completed_at + interval '5 minutes'
     OR v_run_completed_at - NEW.source_as_of > v_contract.max_freshness THEN
    RAISE EXCEPTION 'metric trust observation is not contemporaneous with its source run';
  END IF;

  IF NEW.quality = 'complete' AND (
    NOT v_snapshot_passed
    OR v_run_acquisition_state <> 'complete'
    OR v_run_population_state <> 'verified'
    OR NEW.population_state <> 'verified'
    OR NEW.window_state <> 'verified'
    OR NEW.unit_state <> 'verified'
    OR NEW.freshness_state <> 'verified'
    OR NEW.blocking_reasons <> '[]'::jsonb
  ) THEN
    RAISE EXCEPTION 'complete metric observation requires a complete verified run';
  END IF;

  IF NEW.population_state = 'verified'
     AND v_run_population_state <> 'verified' THEN
    RAISE EXCEPTION 'metric observation cannot overstate run population evidence';
  END IF;

  IF v_snapshot_derived
     AND NOT v_contract.allow_derived_population
     AND (
       NEW.quality = 'complete'
       OR NEW.population_state = 'verified'
     ) THEN
    RAISE EXCEPTION 'derived population cannot be represented as complete by this contract';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER validate_metric_trust_observation_before_insert
BEFORE INSERT ON arena.metric_trust_observations
FOR EACH ROW EXECUTE FUNCTION arena.validate_metric_trust_observation();

CREATE FUNCTION arena.validate_metric_trust_artifact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_contract_id bigint;
  v_source_id smallint;
  v_timeframe smallint;
  v_source_run_id text;
  v_source_as_of timestamptz;
  v_recorded_at timestamptz;
  v_source_payload_scope text;
  v_max_freshness interval;
  v_population_raw_object_id bigint;
  v_manifest_raw_object_id bigint;
  v_raw_source_id smallint;
  v_raw_timeframe smallint;
  v_raw_source_run_id text;
  v_raw_role text;
  v_raw_fetched_at timestamptz;
  v_raw_hash text;
  v_raw_quarantined boolean;
  v_raw_meta jsonb;
BEGIN
  SELECT
    contract_id,
    source_id,
    timeframe,
    source_run_id,
    source_as_of,
    recorded_at
    INTO STRICT
      v_contract_id,
      v_source_id,
      v_timeframe,
      v_source_run_id,
      v_source_as_of,
      v_recorded_at
    FROM arena.metric_trust_observations
   WHERE id = NEW.observation_id;

  SELECT source_payload_scope, max_freshness
    INTO STRICT v_source_payload_scope, v_max_freshness
    FROM arena.metric_source_contracts
   WHERE id = v_contract_id;

  SELECT population_raw_object_id, manifest_raw_object_id
    INTO STRICT v_population_raw_object_id, v_manifest_raw_object_id
    FROM arena.metric_trust_runs
   WHERE source_run_id = v_source_run_id;

  SELECT
    source_id,
    timeframe,
    source_run_id,
    trust_artifact_role,
    fetched_at,
    content_hash,
    quarantined,
    meta
    INTO STRICT
      v_raw_source_id,
      v_raw_timeframe,
      v_raw_source_run_id,
      v_raw_role,
      v_raw_fetched_at,
      v_raw_hash,
      v_raw_quarantined,
      v_raw_meta
    FROM arena.raw_objects
   WHERE id = NEW.raw_object_id;

  IF v_raw_source_id IS DISTINCT FROM v_source_id
     OR v_raw_timeframe IS DISTINCT FROM v_timeframe
     OR v_raw_source_run_id IS DISTINCT FROM v_source_run_id
     OR v_raw_role IS DISTINCT FROM NEW.role
     OR v_raw_hash IS DISTINCT FROM NEW.content_hash
     OR v_raw_quarantined
     OR v_raw_fetched_at < v_source_as_of - interval '5 minutes'
     OR v_raw_fetched_at > v_source_as_of + v_max_freshness
     OR v_raw_fetched_at > v_recorded_at + interval '5 minutes'
     OR v_raw_meta->'raw_integrity'->>'hash_algorithm' IS DISTINCT FROM 'sha256'
     OR v_raw_meta->'raw_integrity'->>'hash_scope' IS DISTINCT FROM 'json_utf8' THEN
    RAISE EXCEPTION 'metric trust artifact is not immutable evidence from the bound run';
  END IF;

  IF NEW.role = 'population_manifest' AND (
    NEW.raw_object_id IS DISTINCT FROM v_manifest_raw_object_id
    OR NEW.content_hash IS DISTINCT FROM v_source_run_id
  ) THEN
    RAISE EXCEPTION 'population manifest artifact does not identify the canonical source run';
  END IF;

  IF NEW.role = 'source_payload'
     AND v_source_payload_scope = 'population_snapshot'
     AND NEW.raw_object_id IS DISTINCT FROM v_population_raw_object_id THEN
    RAISE EXCEPTION 'metric source payload is not the population snapshot payload';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER validate_metric_trust_artifact_before_insert
BEFORE INSERT ON arena.metric_trust_artifacts
FOR EACH ROW EXECUTE FUNCTION arena.validate_metric_trust_artifact();

CREATE FUNCTION arena.protect_metric_trust_raw_object()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM arena.metric_trust_artifacts
     WHERE raw_object_id = OLD.id
  ) OR EXISTS (
    SELECT 1
      FROM arena.metric_trust_runs
     WHERE population_raw_object_id = OLD.id
        OR manifest_raw_object_id = OLD.id
  ) THEN
    IF TG_OP = 'UPDATE' AND (
       NEW.id IS DISTINCT FROM OLD.id
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.job_type IS DISTINCT FROM OLD.job_type
       OR NEW.trader_id IS DISTINCT FROM OLD.trader_id
       OR NEW.timeframe IS DISTINCT FROM OLD.timeframe
       OR NEW.fetched_at IS DISTINCT FROM OLD.fetched_at
       OR NEW.source_run_id IS DISTINCT FROM OLD.source_run_id
       OR NEW.trust_artifact_role IS DISTINCT FROM OLD.trust_artifact_role
       OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
       OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
       OR NEW.bytes IS DISTINCT FROM OLD.bytes
       OR NEW.meta IS DISTINCT FROM OLD.meta
       OR (
         NEW.quarantined IS DISTINCT FROM OLD.quarantined
         AND NOT (NOT OLD.quarantined AND NEW.quarantined)
       )
    ) THEN
      RAISE EXCEPTION 'rank evidence RAW object % cannot be mutated', OLD.id;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER protect_metric_trust_raw_object_before_write
BEFORE UPDATE OR DELETE ON arena.raw_objects
FOR EACH ROW EXECUTE FUNCTION arena.protect_metric_trust_raw_object();

-- ACLs are not an integrity boundary for the direct PostgreSQL owner used by
-- ingestion. These triggers make trust rows immutable even on that path while
-- still allowing FK cascades when a parent snapshot/RAW object is retained or
-- cleaned up.
CREATE FUNCTION arena.reject_direct_metric_trust_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'TRUNCATE' OR pg_catalog.pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'metric trust records are append-only; insert a new run instead';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER metric_source_contracts_reject_direct_mutation
BEFORE UPDATE OR DELETE ON arena.metric_source_contracts
FOR EACH ROW EXECUTE FUNCTION arena.reject_direct_metric_trust_mutation();
CREATE TRIGGER metric_source_contracts_reject_truncate
BEFORE TRUNCATE ON arena.metric_source_contracts
FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_direct_metric_trust_mutation();

CREATE TRIGGER metric_trust_runs_reject_direct_mutation
BEFORE UPDATE OR DELETE ON arena.metric_trust_runs
FOR EACH ROW EXECUTE FUNCTION arena.reject_direct_metric_trust_mutation();
CREATE TRIGGER metric_trust_runs_reject_truncate
BEFORE TRUNCATE ON arena.metric_trust_runs
FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_direct_metric_trust_mutation();

CREATE TRIGGER metric_trust_observations_reject_direct_mutation
BEFORE UPDATE OR DELETE ON arena.metric_trust_observations
FOR EACH ROW EXECUTE FUNCTION arena.reject_direct_metric_trust_mutation();
CREATE TRIGGER metric_trust_observations_reject_truncate
BEFORE TRUNCATE ON arena.metric_trust_observations
FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_direct_metric_trust_mutation();

CREATE TRIGGER metric_trust_artifacts_reject_direct_mutation
BEFORE UPDATE OR DELETE ON arena.metric_trust_artifacts
FOR EACH ROW EXECUTE FUNCTION arena.reject_direct_metric_trust_mutation();
CREATE TRIGGER metric_trust_artifacts_reject_truncate
BEFORE TRUNCATE ON arena.metric_trust_artifacts
FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_direct_metric_trust_mutation();

-- Keep the database registry in parity with lib/metric-trust.ts. Binance
-- Wallet values are upstream USD. They intentionally cannot enter the USDT
-- Arena method until an explicit, timestamped conversion contract exists.
INSERT INTO arena.metric_source_contracts (
  source_id,
  contract_version,
  metric,
  field_path,
  provenance,
  methodology_version,
  metric_set_id,
  timeframes,
  value_unit,
  currencies,
  required_raw_roles,
  source_payload_scope,
  max_freshness,
  max_window_end_lag
)
SELECT
  source.id,
  contract.contract_version,
  contract.metric,
  contract.field_path,
  contract.provenance,
  contract.methodology_version,
  contract.metric_set_id,
  contract.timeframes,
  contract.value_unit,
  contract.currencies,
  contract.required_raw_roles,
  contract.source_payload_scope,
  contract.max_freshness,
  contract.max_window_end_lag
FROM arena.sources AS source
CROSS JOIN (
  VALUES
    (
      '1'::text,
      'roi'::text,
      'data.list[].roi'::text,
      'source_reported'::text,
      'binance-board-roi@1'::text,
      'binance-board-roi-pnl@1'::text,
      ARRAY[7, 30, 90]::smallint[],
      'percent'::text,
      ARRAY['USDT']::text[],
      ARRAY['source_payload', 'population_manifest']::text[],
      'population_snapshot'::text,
      interval '6 hours',
      interval '5 minutes'
    ),
    (
      '1',
      'pnl',
      'data.list[].pnl',
      'source_reported',
      'binance-board-pnl@1',
      'binance-board-roi-pnl@1',
      ARRAY[7, 30, 90]::smallint[],
      'currency',
      ARRAY['USDT']::text[],
      ARRAY['source_payload', 'population_manifest']::text[],
      'population_snapshot',
      interval '6 hours',
      interval '5 minutes'
    ),
    (
      '1'::text,
      'roi'::text,
      'performance.roi'::text,
      'source_reported'::text,
      'binance-performance-roi@1'::text,
      'binance-profile-roi-pnl@1'::text,
      ARRAY[7, 30, 90]::smallint[],
      'percent'::text,
      ARRAY['USDT']::text[],
      ARRAY['source_payload', 'population_manifest']::text[],
      'metric_payload'::text,
      interval '6 hours',
      interval '5 minutes'
    ),
    (
      '1',
      'pnl',
      'performance.pnl',
      'source_reported',
      'binance-performance-pnl@1',
      'binance-profile-roi-pnl@1',
      ARRAY[7, 30, 90]::smallint[],
      'currency',
      ARRAY['USDT']::text[],
      ARRAY['source_payload', 'population_manifest']::text[],
      'metric_payload',
      interval '6 hours',
      interval '5 minutes'
    )
) AS contract(
  contract_version,
  metric,
  field_path,
  provenance,
  methodology_version,
  metric_set_id,
  timeframes,
  value_unit,
  currencies,
  required_raw_roles,
  source_payload_scope,
  max_freshness,
  max_window_end_lag
)
WHERE source.slug = 'binance_futures';

INSERT INTO arena.metric_source_contracts (
  source_id,
  contract_version,
  metric,
  field_path,
  provenance,
  methodology_version,
  metric_set_id,
  timeframes,
  value_unit,
  currencies,
  required_raw_roles,
  source_payload_scope,
  max_freshness,
  max_window_end_lag
)
SELECT
  source.id,
  contract.contract_version,
  contract.metric,
  contract.field_path,
  contract.provenance,
  contract.methodology_version,
  contract.metric_set_id,
  contract.timeframes,
  contract.value_unit,
  contract.currencies,
  contract.required_raw_roles,
  contract.source_payload_scope,
  contract.max_freshness,
  contract.max_window_end_lag
FROM arena.sources AS source
CROSS JOIN (
  VALUES
    (
      '1'::text,
      'roi'::text,
      'board.data.data[].realizedPnlPercent'::text,
      'source_reported'::text,
      'binance-web3-board-realized-pnl-percent@1'::text,
      'binance-web3-board-realized-pnl@1'::text,
      ARRAY[7, 30, 90]::smallint[],
      'percent'::text,
      ARRAY['USD']::text[],
      ARRAY['source_payload', 'population_manifest']::text[],
      'population_snapshot'::text,
      interval '2 hours',
      interval '5 minutes'
    ),
    (
      '1',
      'pnl',
      'board.data.data[].realizedPnl',
      'source_reported',
      'binance-web3-board-realized-pnl@1',
      'binance-web3-board-realized-pnl@1',
      ARRAY[7, 30, 90]::smallint[],
      'currency',
      ARRAY['USD']::text[],
      ARRAY['source_payload', 'population_manifest']::text[],
      'population_snapshot',
      interval '2 hours',
      interval '5 minutes'
    ),
    (
      '1',
      'roi',
      'rebuild.roi',
      'arena_rebuilt',
      'wallet-event-ledger-average-cost@1',
      'wallet-event-ledger-average-cost@1',
      ARRAY[7, 30, 90]::smallint[],
      'percent',
      ARRAY['USD']::text[],
      ARRAY[
        'event_history',
        'price_history',
        'opening_inventory',
        'population_manifest'
      ]::text[],
      'not_required',
      interval '2 hours',
      interval '5 minutes'
    )
) AS contract(
  contract_version,
  metric,
  field_path,
  provenance,
  methodology_version,
  metric_set_id,
  timeframes,
  value_unit,
  currencies,
  required_raw_roles,
  source_payload_scope,
  max_freshness,
  max_window_end_lag
)
WHERE source.slug = 'binance_web3_bsc';

-- Canonical shadow: a row is rankable only when its static contract, board
-- population, time bounds, evidence states, and every immutable RAW role pass.
CREATE VIEW arena.metric_rankable_observations
WITH (security_invoker = true)
AS
SELECT observation.*, contract.metric_set_id
FROM arena.metric_trust_observations AS observation
JOIN arena.metric_source_contracts AS contract
  ON contract.id = observation.contract_id
JOIN arena.metric_trust_runs AS acquisition
  ON acquisition.source_run_id = observation.source_run_id
JOIN arena.sources AS source
  ON source.id = observation.source_id
JOIN arena.traders AS trader
  ON trader.id = observation.trader_id
JOIN arena.leaderboard_snapshots AS snapshot
  ON snapshot.id = observation.snapshot_id
JOIN arena.raw_objects AS population_raw
  ON population_raw.id = acquisition.population_raw_object_id
JOIN arena.raw_objects AS manifest_raw
  ON manifest_raw.id = acquisition.manifest_raw_object_id
WHERE contract.active
  AND contract.source_id = observation.source_id
  AND contract.contract_version = observation.source_contract_version
  AND contract.metric = observation.metric
  AND contract.field_path = observation.field_path
  AND contract.provenance = observation.provenance
  AND contract.methodology_version = observation.methodology_version
  AND source.status = 'active'
  AND source.serving_mode = 'serving'
  AND source.currency = observation.currency
  AND observation.timeframe = ANY (contract.timeframes)
  AND observation.currency = ANY (contract.currencies)
  AND observation.value_unit = contract.value_unit
  AND trader.source_id = observation.source_id
  AND snapshot.source_id = observation.source_id
  AND snapshot.timeframe = observation.timeframe
  AND snapshot.scraped_at = observation.snapshot_scraped_at
  AND snapshot.count_check_passed
  AND (NOT snapshot.is_derived OR contract.allow_derived_population)
  AND acquisition.source_id = observation.source_id
  AND acquisition.timeframe = observation.timeframe
  AND acquisition.snapshot_id = observation.snapshot_id
  AND acquisition.snapshot_scraped_at = observation.snapshot_scraped_at
  AND acquisition.population_raw_object_id = snapshot.raw_object_id
  AND acquisition.acquisition_state = 'complete'
  AND acquisition.population_state = 'verified'
  AND NOT acquisition.caller_limited
  AND acquisition.fetched_population = snapshot.actual_count
  AND (
    acquisition.reported_population IS NULL
    OR acquisition.reported_population = acquisition.fetched_population
  )
  AND population_raw.source_id = observation.source_id
  AND population_raw.timeframe = observation.timeframe
  AND population_raw.source_run_id = observation.source_run_id
  AND population_raw.trust_artifact_role = 'source_payload'
  AND NOT population_raw.quarantined
  AND population_raw.content_hash ~ '^[0-9a-f]{64}$'
  AND population_raw.meta->'raw_integrity'->>'hash_algorithm' = 'sha256'
  AND population_raw.meta->'raw_integrity'->>'hash_scope' = 'json_utf8'
  AND manifest_raw.source_id = observation.source_id
  AND manifest_raw.timeframe = observation.timeframe
  AND manifest_raw.source_run_id = observation.source_run_id
  AND manifest_raw.trust_artifact_role = 'population_manifest'
  AND manifest_raw.content_hash = observation.source_run_id
  AND NOT manifest_raw.quarantined
  AND manifest_raw.meta->'raw_integrity'->>'hash_algorithm' = 'sha256'
  AND manifest_raw.meta->'raw_integrity'->>'hash_scope' = 'json_utf8'
  AND population_raw.fetched_at >= acquisition.started_at - interval '5 minutes'
  AND population_raw.fetched_at <= acquisition.completed_at + interval '5 minutes'
  AND manifest_raw.fetched_at >= acquisition.started_at - interval '5 minutes'
  AND manifest_raw.fetched_at <= acquisition.completed_at + interval '5 minutes'
  AND observation.value IS NOT NULL
  AND observation.value NOT IN (
    'NaN'::numeric,
    'Infinity'::numeric,
    '-Infinity'::numeric
  )
  AND observation.quality = 'complete'
  AND observation.population_state = 'verified'
  AND observation.window_state = 'verified'
  AND observation.unit_state = 'verified'
  AND observation.freshness_state = 'verified'
  AND (
    (
      observation.provenance IN ('source_reported', 'source_normalized')
      AND observation.history_state IN ('verified', 'source_owned')
      AND observation.price_state IN ('verified', 'source_owned')
      AND observation.cost_basis_state IN ('verified', 'source_owned')
    )
    OR
    (
      observation.provenance IN ('arena_rebuilt', 'derived')
      AND observation.history_state = 'verified'
      AND observation.price_state = 'verified'
      AND observation.cost_basis_state = 'verified'
    )
  )
  AND observation.blocking_reasons = '[]'::jsonb
  AND observation.source_as_of <= acquisition.completed_at + interval '5 minutes'
  AND acquisition.completed_at - observation.source_as_of <= contract.max_freshness
  AND observation.source_as_of <= pg_catalog.now() + interval '5 minutes'
  AND observation.valid_until > pg_catalog.now()
  AND observation.valid_until - observation.source_as_of <= contract.max_freshness
  AND observation.window_end <= observation.source_as_of + interval '5 minutes'
  AND observation.source_as_of - observation.window_end <= contract.max_window_end_lag
  AND pg_catalog.abs(
    EXTRACT(
      EPOCH FROM (
        (observation.window_end - observation.window_start)
        - pg_catalog.make_interval(days => observation.timeframe)
      )
    )
  ) <= 300
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(contract.required_raw_roles) AS required(role)
    WHERE NOT EXISTS (
      SELECT 1
      FROM arena.metric_trust_artifacts AS artifact
      JOIN arena.raw_objects AS raw
        ON raw.id = artifact.raw_object_id
      WHERE artifact.observation_id = observation.id
        AND artifact.role = required.role
        AND artifact.content_hash = raw.content_hash
        AND raw.content_hash ~ '^[0-9a-f]{64}$'
        AND raw.source_id = observation.source_id
        AND raw.timeframe = observation.timeframe
        AND raw.source_run_id = observation.source_run_id
        AND raw.trust_artifact_role = artifact.role
        AND NOT raw.quarantined
        AND raw.fetched_at >= observation.source_as_of - interval '5 minutes'
        AND raw.fetched_at <= observation.source_as_of + contract.max_freshness
        AND raw.fetched_at <= observation.recorded_at + interval '5 minutes'
        AND raw.meta->'raw_integrity'->>'hash_algorithm' = 'sha256'
        AND raw.meta->'raw_integrity'->>'hash_scope' = 'json_utf8'
        AND (
          artifact.role <> 'population_manifest'
          OR (
            raw.id = acquisition.manifest_raw_object_id
            AND raw.content_hash = observation.source_run_id
          )
        )
        AND (
          artifact.role <> 'source_payload'
          OR contract.source_payload_scope <> 'population_snapshot'
          OR raw.id = acquisition.population_raw_object_id
        )
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM arena.metric_trust_artifacts AS artifact
    JOIN arena.raw_objects AS raw
      ON raw.id = artifact.raw_object_id
    WHERE artifact.observation_id = observation.id
      AND (
        artifact.content_hash IS DISTINCT FROM raw.content_hash
        OR raw.source_id IS DISTINCT FROM observation.source_id
        OR raw.timeframe IS DISTINCT FROM observation.timeframe
        OR raw.source_run_id IS DISTINCT FROM observation.source_run_id
        OR raw.trust_artifact_role IS DISTINCT FROM artifact.role
        OR raw.quarantined
        OR raw.fetched_at < observation.source_as_of - interval '5 minutes'
        OR raw.fetched_at > observation.source_as_of + contract.max_freshness
        OR raw.fetched_at > observation.recorded_at + interval '5 minutes'
        OR (
          artifact.role = 'population_manifest'
          AND (
            raw.id IS DISTINCT FROM acquisition.manifest_raw_object_id
            OR raw.content_hash IS DISTINCT FROM observation.source_run_id
          )
        )
        OR (
          artifact.role = 'source_payload'
          AND contract.source_payload_scope = 'population_snapshot'
          AND raw.id IS DISTINCT FROM acquisition.population_raw_object_id
        )
      )
  );

-- Direct provider values win over normalized/rebuilt fallbacks. ROI and PnL
-- are selected as a coherent registered metric set before pair preference is
-- applied, so board ROI can never be combined with profile PnL.
CREATE VIEW arena.metric_rankable_input_sets_shadow
WITH (security_invoker = true)
AS
WITH paired AS (
  SELECT
    roi.source_id,
    roi.trader_id,
    roi.snapshot_id,
    roi.source_run_id,
    roi.source_contract_version,
    roi.metric_set_id,
    roi.timeframe,
    roi.currency,
    roi.value AS roi,
    pnl.value AS pnl,
    LEAST(roi.source_as_of, pnl.source_as_of) AS source_as_of,
    roi.id AS roi_observation_id,
    pnl.id AS pnl_observation_id,
    GREATEST(
      CASE roi.provenance
        WHEN 'source_reported' THEN 1
        WHEN 'source_normalized' THEN 2
        WHEN 'arena_rebuilt' THEN 3
        ELSE 4
      END,
      CASE pnl.provenance
        WHEN 'source_reported' THEN 1
        WHEN 'source_normalized' THEN 2
        WHEN 'arena_rebuilt' THEN 3
        ELSE 4
      END
    ) AS pair_preference,
    CASE roi.provenance
      WHEN 'source_reported' THEN 1
      WHEN 'source_normalized' THEN 2
      WHEN 'arena_rebuilt' THEN 3
      ELSE 4
    END
    + CASE pnl.provenance
      WHEN 'source_reported' THEN 1
      WHEN 'source_normalized' THEN 2
      WHEN 'arena_rebuilt' THEN 3
      ELSE 4
    END AS pair_preference_sum
  FROM arena.metric_rankable_observations AS roi
  JOIN arena.metric_rankable_observations AS pnl
    ON pnl.trader_id = roi.trader_id
   AND pnl.snapshot_id = roi.snapshot_id
   AND pnl.source_id = roi.source_id
   AND pnl.source_run_id = roi.source_run_id
   AND pnl.source_contract_version = roi.source_contract_version
   AND pnl.metric_set_id = roi.metric_set_id
   AND pnl.timeframe = roi.timeframe
   AND pnl.currency = roi.currency
   AND pnl.window_start = roi.window_start
   AND pnl.window_end = roi.window_end
   AND pg_catalog.abs(
     EXTRACT(EPOCH FROM (pnl.source_as_of - roi.source_as_of))
   ) <= 300
  WHERE roi.metric = 'roi'
    AND pnl.metric = 'pnl'
), ranked_pairs AS (
  SELECT
    paired.*,
    pg_catalog.row_number() OVER (
      PARTITION BY paired.trader_id, paired.snapshot_id, paired.timeframe
      ORDER BY
        paired.pair_preference,
        paired.pair_preference_sum,
        paired.source_as_of DESC,
        paired.roi_observation_id DESC,
        paired.pnl_observation_id DESC
    ) AS pair_rank
  FROM paired
)
SELECT
  ranked_pairs.source_id,
  ranked_pairs.trader_id,
  ranked_pairs.snapshot_id,
  ranked_pairs.source_run_id,
  ranked_pairs.source_contract_version,
  ranked_pairs.metric_set_id,
  ranked_pairs.timeframe,
  ranked_pairs.currency,
  ranked_pairs.roi,
  ranked_pairs.pnl,
  ranked_pairs.source_as_of,
  ranked_pairs.roi_observation_id,
  ranked_pairs.pnl_observation_id,
  true AS rank_eligible
FROM ranked_pairs
WHERE ranked_pairs.pair_rank = 1;

ALTER TABLE arena.metric_source_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.metric_trust_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.metric_trust_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.metric_trust_artifacts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON arena.metric_source_contracts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON arena.metric_trust_runs FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON arena.metric_trust_observations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON arena.metric_trust_artifacts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON arena.metric_rankable_observations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON arena.metric_rankable_input_sets_shadow FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION arena.validate_metric_trust_run()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION arena.validate_metric_trust_observation()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION arena.validate_metric_trust_artifact()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION arena.protect_metric_trust_raw_object()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION arena.reject_direct_metric_trust_mutation()
  FROM PUBLIC, anon, authenticated;

GRANT SELECT ON arena.metric_source_contracts TO service_role;
GRANT SELECT, INSERT ON arena.metric_trust_runs TO service_role;
GRANT SELECT, INSERT ON arena.metric_trust_observations TO service_role;
GRANT SELECT, INSERT ON arena.metric_trust_artifacts TO service_role;
GRANT SELECT ON arena.metric_rankable_observations TO service_role;
GRANT SELECT ON arena.metric_rankable_input_sets_shadow TO service_role;
GRANT EXECUTE ON FUNCTION arena.validate_metric_trust_run() TO service_role;
GRANT EXECUTE ON FUNCTION arena.validate_metric_trust_observation() TO service_role;
GRANT EXECUTE ON FUNCTION arena.validate_metric_trust_artifact() TO service_role;
GRANT EXECUTE ON FUNCTION arena.protect_metric_trust_raw_object() TO service_role;
GRANT EXECUTE ON FUNCTION arena.reject_direct_metric_trust_mutation() TO service_role;
GRANT USAGE, SELECT ON SEQUENCE arena.metric_trust_observations_id_seq TO service_role;

DO $postflight$
DECLARE
  v_contracts bigint;
BEGIN
  SELECT pg_catalog.count(*)
    INTO v_contracts
    FROM arena.metric_source_contracts;

  IF v_contracts <> 7 THEN
    RAISE EXCEPTION 'expected 7 initial metric source contracts, found %', v_contracts;
  END IF;

  IF NOT pg_catalog.has_table_privilege(
    'service_role', 'arena.metric_source_contracts', 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'service_role', 'arena.metric_source_contracts', 'INSERT,UPDATE,DELETE'
  ) THEN
    RAISE EXCEPTION 'metric source contract registry is not service-role read-only';
  END IF;

  IF pg_catalog.has_table_privilege(
    'anon', 'arena.metric_trust_observations', 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'authenticated', 'arena.metric_trust_observations', 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'anon', 'arena.metric_trust_runs', 'SELECT'
  ) THEN
    RAISE EXCEPTION 'metric trust internals leaked to public roles';
  END IF;
END
$postflight$;

COMMENT ON VIEW arena.metric_rankable_input_sets_shadow IS
  'Fail-closed ROI+PnL shadow sets. Not wired to public score_inputs until source canaries pass.';

NOTIFY pgrst, 'reload schema';

COMMIT;
