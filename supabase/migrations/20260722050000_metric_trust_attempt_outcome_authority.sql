-- Migration: 20260722050000_metric_trust_attempt_outcome_authority.sql
-- Created: 2026-07-22T05:00:00Z
-- Description: Make the production acquisition ledger the database authority
--   for every new attempt-bound metric-trust run. The 042 terminal serializer
--   and trust publication use the same source/timeframe advisory fence, so a
--   direct v3 INSERT cannot race a newer terminal outcome. The additive
--   v2/v3 compatibility registry remains unchanged; v2 retirement requires a
--   separate, explicit cutover policy after the v3 worker is proven live.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Close the migration-time gap between reviewing existing rows and installing
-- the trust trigger/view. The already-installed 042 terminal serializer is
-- held stable while its exact contract is revalidated.
LOCK TABLE arena.leaderboard_acquisition_outcomes,
           arena.metric_trust_runs
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_start pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'
  );
  v_reject pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'arena.reject_direct_leaderboard_acquisition_mutation()'
  );
  v_serializer pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'arena.serialize_leaderboard_terminal_publication()'
  );
  v_postgres pg_catalog.oid := pg_catalog.to_regrole('postgres');
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL
     OR pg_catalog.to_regclass('arena.metric_trust_runs') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_capture_contracts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_attempts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_outcomes') IS NULL
     OR pg_catalog.to_regclass('arena.latest_terminal_leaderboard_acquisitions') IS NULL
     OR pg_catalog.to_regclass('arena.metric_rankable_observations') IS NULL THEN
    RAISE EXCEPTION 'metric-trust acquisition authority foundations are missing';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'metric-trust acquisition authority roles are missing';
  END IF;

  IF v_start IS NULL OR v_reject IS NULL OR v_serializer IS NULL THEN
    RAISE EXCEPTION 'leaderboard acquisition publication fence is missing';
  END IF;

  IF pg_catalog.to_regprocedure(
       'arena.lock_leaderboard_acquisition_source_window(integer,integer)'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.validate_metric_trust_attempt_outcome_authority()'
     ) IS NOT NULL
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger AS trigger_row
        WHERE NOT trigger_row.tgisinternal
          AND trigger_row.tgname IN (
            'metric_trust_runs_attempt_outcome_authority_before_insert'
          )
     ) THEN
    RAISE EXCEPTION 'metric-trust acquisition authority already exists';
  END IF;

  -- 042 is the only outcome serializer. Reuse it instead of installing a
  -- second BEFORE INSERT trigger whose name could run before the direct-write
  -- rejector and wait on attacker-controlled input.
  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid = v_serializer
          AND function_row.proowner = v_postgres
          AND function_row.prosecdef
          AND function_row.provolatile = 'v'
          AND function_row.prorettype = 'trigger'::pg_catalog.regtype
          AND function_row.proconfig @> ARRAY[
                'search_path=pg_catalog, pg_temp'
              ]::text[]
          AND pg_catalog.strpos(
                function_row.prosrc,
                'FROM arena.leaderboard_acquisition_attempts AS attempt'
              ) > 0
          AND pg_catalog.strpos(
                function_row.prosrc,
                'attempt.attempt_seq = NEW.attempt_seq'
              ) > 0
          AND pg_catalog.strpos(
                function_row.prosrc,
                '''arena.leaderboard-acquisition-source:'''
              ) > 0
          AND pg_catalog.strpos(
                function_row.prosrc,
                'v_source_id::text || '':'' || v_timeframe::text'
              ) > 0
          AND pg_catalog.strpos(
                function_row.prosrc,
                'pg_catalog.pg_advisory_xact_lock'
              ) > 0
     ) OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             function_row.proacl,
             pg_catalog.acldefault('f', function_row.proowner)
           )
         ) AS privilege_row
        WHERE function_row.oid = v_serializer
          AND privilege_row.privilege_type = 'EXECUTE'
          AND privilege_row.grantee <> function_row.proowner
     ) THEN
    RAISE EXCEPTION 'leaderboard terminal publication serializer drifted';
  END IF;

  IF (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid =
              'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
          AND trigger_row.tgname =
              'leaderboard_acquisition_outcomes_serialize_terminal_publication'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgenabled = 'O'
          AND trigger_row.tgtype = 7
          AND trigger_row.tgattr = ''::pg_catalog.int2vector
          AND trigger_row.tgqual IS NULL
          AND trigger_row.tgconstraint = 0
          AND NOT trigger_row.tgdeferrable
          AND NOT trigger_row.tginitdeferred
          AND trigger_row.tgnargs = 0
          AND pg_catalog.octet_length(trigger_row.tgargs) = 0
          AND trigger_row.tgfoid = v_serializer
     ) <> 1
     OR (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid =
              'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgenabled = 'O'
          AND trigger_row.tgtype = 7
          AND trigger_row.tgfoid = v_serializer
     ) <> 1
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger AS reject_trigger
         JOIN pg_catalog.pg_trigger AS serialize_trigger
           ON serialize_trigger.tgrelid = reject_trigger.tgrelid
        WHERE reject_trigger.tgrelid =
              'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
          AND reject_trigger.tgname =
              'leaderboard_acquisition_outcomes_reject_direct_row_mutation'
          AND reject_trigger.tgfoid = v_reject
          AND reject_trigger.tgenabled = 'O'
          AND reject_trigger.tgtype = 31
          AND serialize_trigger.tgname =
              'leaderboard_acquisition_outcomes_serialize_terminal_publication'
          AND serialize_trigger.tgfoid = v_serializer
          AND reject_trigger.tgname < serialize_trigger.tgname
     ) THEN
    RAISE EXCEPTION 'leaderboard terminal publication trigger contract drifted';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid =
              'arena.metric_trust_runs'::pg_catalog.regclass
          AND trigger_row.tgname = 'validate_metric_trust_run_before_insert'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgenabled = 'O'
     ) THEN
    RAISE EXCEPTION 'existing metric-trust validation trigger drifted';
  END IF;

  -- 040000 is deliberately a compatibility phase: Binance has one reviewed
  -- v2 row and one reviewed v3 row. Presence of v3 is not a retirement signal.
  IF (
       SELECT pg_catalog.count(*)
         FROM arena.leaderboard_capture_contracts AS capture
         JOIN arena.sources AS source
           ON source.id = capture.source_id
        WHERE source.slug = 'binance_futures'
          AND source.adapter_slug = 'binance'
          AND capture.adapter_slug = source.adapter_slug
          AND capture.capture_contract IN (
            'arena.ingest.leaderboard-acquisition-manifest@2',
            'arena.ingest.leaderboard-acquisition-manifest@3'
          )
          AND capture.attempt_binding_contract =
              'arena.ingest.leaderboard-acquisition-attempt-binding@1'
          AND capture.requires_runner_git_sha
     ) <> 2
     OR (
       SELECT pg_catalog.count(*)
         FROM arena.leaderboard_capture_contracts
        WHERE capture_contract =
              'arena.ingest.leaderboard-acquisition-manifest@3'
     ) <> 1 THEN
    RAISE EXCEPTION 'leaderboard acquisition v2/v3 compatibility registry drifted';
  END IF;

  -- This migration establishes the first database-side v3 publication fence.
  -- Only reviewed v2 rows may predate it. v3, NULL, and every unknown contract
  -- require explicit manual authority review instead of being silently hidden
  -- by the replacement rankable view.
  IF EXISTS (
    SELECT 1
      FROM arena.metric_trust_runs AS run
      JOIN arena.raw_objects AS manifest
        ON manifest.id = run.manifest_raw_object_id
     WHERE manifest.meta->>'data_contract' IS DISTINCT FROM
           'arena.ingest.leaderboard-acquisition-manifest@2'
  ) THEN
    RAISE EXCEPTION 'existing non-v2 metric-trust rows require manual authority review';
  END IF;
END
$preflight$;

-- Keep this namespace byte-identical to start_leaderboard_acquisition_attempt.
-- Transaction-level scope holds the fence through the outcome/trust COMMIT.
CREATE FUNCTION arena.lock_leaderboard_acquisition_source_window(
  p_source_id integer,
  p_timeframe integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  IF p_source_id IS NULL
     OR p_source_id < 1
     OR p_source_id > 32767
     OR p_timeframe IS NULL
     OR p_timeframe NOT IN (7, 30, 90) THEN
    RAISE EXCEPTION 'invalid leaderboard acquisition source/window lock identity'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena.leaderboard-acquisition-source:'
      || p_source_id::text || ':' || p_timeframe::text,
      0
    )
  );
END
$function$;

ALTER FUNCTION arena.lock_leaderboard_acquisition_source_window(integer, integer)
  OWNER TO postgres;

CREATE FUNCTION arena.validate_metric_trust_attempt_outcome_authority()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_manifest_contract text;
  v_manifest_meta jsonb;
  v_manifest_content_hash text;
  v_manifest_storage_path text;
  v_manifest_quarantined boolean;
  v_population_content_hash text;
  v_population_storage_path text;
  v_population_quarantined boolean;
  v_source_slug text;
  v_source_adapter_slug text;
  v_source_status text;
  v_source_serving_mode text;
  v_source_currency text;
  v_source_fetch_region text;
  v_registered_adapter_slug text;
  v_registered_binding_contract text;
  v_requires_runner_git_sha boolean;
BEGIN
  SELECT manifest.meta->>'data_contract'
    INTO STRICT v_manifest_contract
    FROM arena.raw_objects AS manifest
   WHERE manifest.id = NEW.manifest_raw_object_id;

  -- 040000 intentionally keeps existing v2 workers and in-flight v2 attempts
  -- valid. Retirement must be represented by a later explicit policy; it may
  -- not be inferred merely from the simultaneous v3 registry row.
  IF v_manifest_contract =
     'arena.ingest.leaderboard-acquisition-manifest@2' THEN
    RETURN NEW;
  END IF;

  IF v_manifest_contract IS DISTINCT FROM
     'arena.ingest.leaderboard-acquisition-manifest@3' THEN
    RAISE EXCEPTION 'metric-trust manifest contract is not registered for trusted publication'
     USING ERRCODE = '23514';
  END IF;

  -- v2 returned before this point and therefore keeps its original serving
  -- and concurrency semantics. For v3, serialize before reading
  -- latest_terminal. The 042 outcome serializer holds this same lock until
  -- COMMIT, closing the validate-to-insert race without a duplicate trigger.
  PERFORM arena.lock_leaderboard_acquisition_source_window(
    NEW.source_id,
    NEW.timeframe
  );

  -- A trigger query that waits for a concurrent outcome must take a fresh
  -- READ COMMITTED snapshot after the advisory fence is acquired. Reject
  -- transaction-wide snapshots rather than authorizing against stale state.
  IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM
     'read committed' THEN
    RAISE EXCEPTION 'attempt-bound metric-trust publication requires READ COMMITTED isolation'
      USING ERRCODE = '25001';
  END IF;

  SELECT
    manifest.meta,
    manifest.content_hash,
    manifest.storage_path,
    manifest.quarantined,
    population.content_hash,
    population.storage_path,
    population.quarantined
  INTO STRICT
    v_manifest_meta,
    v_manifest_content_hash,
    v_manifest_storage_path,
    v_manifest_quarantined,
    v_population_content_hash,
    v_population_storage_path,
    v_population_quarantined
  FROM arena.raw_objects AS manifest
  CROSS JOIN arena.raw_objects AS population
  WHERE manifest.id = NEW.manifest_raw_object_id
    AND population.id = NEW.population_raw_object_id;

  SELECT
    source.slug,
    source.adapter_slug,
    source.status,
    source.serving_mode,
    source.currency,
    source.fetch_region,
    capture.adapter_slug,
    capture.attempt_binding_contract,
    capture.requires_runner_git_sha
  INTO STRICT
    v_source_slug,
    v_source_adapter_slug,
    v_source_status,
    v_source_serving_mode,
    v_source_currency,
    v_source_fetch_region,
    v_registered_adapter_slug,
    v_registered_binding_contract,
    v_requires_runner_git_sha
  FROM arena.sources AS source
  JOIN arena.leaderboard_capture_contracts AS capture
    ON capture.source_id = source.id
   AND capture.capture_contract = v_manifest_contract
  WHERE source.id = NEW.source_id
  FOR SHARE OF source;

  IF v_registered_adapter_slug IS DISTINCT FROM v_source_adapter_slug
     OR v_registered_binding_contract IS DISTINCT FROM
        'arena.ingest.leaderboard-acquisition-attempt-binding@1'
     OR NOT v_requires_runner_git_sha
     OR v_manifest_quarantined
     OR v_population_quarantined
     OR v_manifest_content_hash IS DISTINCT FROM NEW.source_run_id THEN
    RAISE EXCEPTION 'attempt-bound metric-trust RAW or registry identity is invalid'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
    FROM arena.latest_terminal_leaderboard_acquisitions AS terminal
   WHERE terminal.source_id = NEW.source_id
     AND terminal.timeframe = NEW.timeframe
     AND terminal.source_slug = v_source_slug
     AND terminal.adapter_slug = v_source_adapter_slug
     AND terminal.source_status = 'active'
     AND terminal.source_status = v_source_status
     AND terminal.source_serving_mode = v_source_serving_mode
     AND terminal.source_currency = v_source_currency
     AND terminal.source_fetch_region = v_source_fetch_region
     AND terminal.worker_region IS NOT NULL
     AND terminal.worker_region = terminal.source_fetch_region
     AND terminal.worker_region = v_source_fetch_region
     AND terminal.capture_contract = v_manifest_contract
     AND terminal.attempt_binding_contract = v_registered_binding_contract
     AND terminal.attempt_id::text =
         v_manifest_meta->'acquisition_attempt'->>'attempt_id'
     AND terminal.attempt_seq::text =
         v_manifest_meta->'acquisition_attempt'->>'attempt_seq'
     AND terminal.observation_cycle_id IS NOT DISTINCT FROM
         v_manifest_meta->>'observation_cycle_id'
     AND terminal.runner_git_sha IS NOT NULL
     AND terminal.runner_git_sha IS NOT DISTINCT FROM
         v_manifest_meta->'acquisition_attempt'->>'runner_git_sha'
     AND terminal.recorded_started_at = NEW.started_at
     AND terminal.terminal_state = 'complete'
     AND terminal.acquisition_state = 'complete'
     AND terminal.acquisition_state = NEW.acquisition_state
     AND terminal.population_state = 'verified'
     AND terminal.population_state = NEW.population_state
     AND terminal.capture_evidence_state = 'verified'
     AND terminal.termination_reason IS NOT NULL
     AND terminal.capture_started_at = NEW.started_at
     AND terminal.capture_completed_at = NEW.completed_at
     AND terminal.source_run_id = NEW.source_run_id
     AND terminal.source_payload_raw_object_id = NEW.population_raw_object_id
     AND terminal.source_payload_content_hash = v_population_content_hash
     AND terminal.source_payload_storage_path = v_population_storage_path
     AND terminal.manifest_raw_object_id = NEW.manifest_raw_object_id
     AND terminal.manifest_content_hash = v_manifest_content_hash
     AND terminal.manifest_storage_path = v_manifest_storage_path
     AND terminal.diagnostic_raw_object_id IS NULL
     AND terminal.diagnostic_content_hash IS NULL
     AND terminal.diagnostic_storage_path IS NULL
     AND terminal.reported_population IS NOT DISTINCT FROM NEW.reported_population
     AND terminal.population_report_state = 'consistent'
     AND terminal.source_page_count IS NOT NULL
     AND terminal.source_page_count > 0
     AND terminal.observed_population = NEW.fetched_population
     AND terminal.accepted_population = NEW.fetched_population
     AND terminal.rejected_row_count = 0
     AND terminal.deduplicated_row_count = 0
     AND NOT terminal.caller_limited
     AND terminal.caller_limited = NEW.caller_limited
     AND NOT terminal.safety_limited
     AND terminal.failure_stage IS NULL
     AND terminal.reason_code IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'v3 metric-trust run is not authorized by the exact latest terminal outcome'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'attempt-bound metric-trust authority identity does not exist'
      USING ERRCODE = '23503';
  WHEN TOO_MANY_ROWS THEN
    RAISE EXCEPTION 'attempt-bound metric-trust authority identity is ambiguous'
      USING ERRCODE = '23514';
END
$function$;

ALTER FUNCTION arena.validate_metric_trust_attempt_outcome_authority()
  OWNER TO postgres;

-- This name sorts before validate_metric_trust_run_before_insert, so the
-- acquisition fence and exact outcome authority are established before the
-- existing snapshot/RAW validation trigger runs.
CREATE TRIGGER metric_trust_runs_attempt_outcome_authority_before_insert
BEFORE INSERT ON arena.metric_trust_runs
FOR EACH ROW EXECUTE FUNCTION arena.validate_metric_trust_attempt_outcome_authority();

-- A successful v3 trust INSERT is not permanently rankable: a later terminal
-- attempt for the same source/window is authoritative even when it fails.
-- Keep the existing v2 branch byte-for-byte equivalent, but dynamically hide
-- v3 observations unless their attempt remains the exact latest terminal.
CREATE OR REPLACE VIEW arena.metric_rankable_observations
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
  -- BEGIN v3 latest-terminal serving fence. CASE guarantees the @2 arm never
  -- executes the ledger subplan, preserving its compatibility-path cost.
  AND CASE manifest_raw.meta->>'data_contract'
    WHEN 'arena.ingest.leaderboard-acquisition-manifest@2' THEN true
    WHEN 'arena.ingest.leaderboard-acquisition-manifest@3' THEN EXISTS (
        SELECT 1
          FROM arena.latest_terminal_leaderboard_acquisitions AS terminal
         WHERE terminal.source_id = acquisition.source_id
           AND terminal.timeframe = acquisition.timeframe
           AND terminal.source_slug = source.slug
           AND terminal.adapter_slug = source.adapter_slug
           AND terminal.source_status = 'active'
           AND terminal.source_status = source.status
           AND terminal.source_serving_mode = source.serving_mode
           AND terminal.source_currency = source.currency
           AND terminal.source_fetch_region = source.fetch_region
           AND terminal.worker_region IS NOT NULL
           AND terminal.worker_region = terminal.source_fetch_region
           AND terminal.worker_region = source.fetch_region
           AND terminal.capture_contract =
               manifest_raw.meta->>'data_contract'
           AND terminal.attempt_binding_contract =
               'arena.ingest.leaderboard-acquisition-attempt-binding@1'
           AND terminal.attempt_binding_contract =
               manifest_raw.meta->'acquisition_attempt'->>'binding_contract'
           AND terminal.attempt_id::text =
               manifest_raw.meta->'acquisition_attempt'->>'attempt_id'
           AND terminal.attempt_seq::text =
               manifest_raw.meta->'acquisition_attempt'->>'attempt_seq'
           AND terminal.observation_cycle_id IS NOT DISTINCT FROM
               manifest_raw.meta->>'observation_cycle_id'
           AND terminal.runner_git_sha IS NOT NULL
           AND terminal.runner_git_sha IS NOT DISTINCT FROM
               manifest_raw.meta->'acquisition_attempt'->>'runner_git_sha'
           AND terminal.recorded_started_at = acquisition.started_at
           AND terminal.terminal_state = 'complete'
           AND terminal.acquisition_state = 'complete'
           AND terminal.acquisition_state = acquisition.acquisition_state
           AND terminal.population_state = 'verified'
           AND terminal.population_state = acquisition.population_state
           AND terminal.capture_evidence_state = 'verified'
           AND terminal.termination_reason IS NOT NULL
           AND terminal.capture_started_at = acquisition.started_at
           AND terminal.capture_completed_at = acquisition.completed_at
           AND terminal.source_run_id = acquisition.source_run_id
           AND terminal.source_payload_raw_object_id =
               acquisition.population_raw_object_id
           AND terminal.source_payload_content_hash =
               population_raw.content_hash
           AND terminal.source_payload_storage_path =
               population_raw.storage_path
           AND terminal.manifest_raw_object_id =
               acquisition.manifest_raw_object_id
           AND terminal.manifest_content_hash = manifest_raw.content_hash
           AND terminal.manifest_storage_path = manifest_raw.storage_path
           AND terminal.diagnostic_raw_object_id IS NULL
           AND terminal.diagnostic_content_hash IS NULL
           AND terminal.diagnostic_storage_path IS NULL
           AND terminal.reported_population IS NOT DISTINCT FROM
               acquisition.reported_population
           AND terminal.population_report_state = 'consistent'
           AND terminal.source_page_count IS NOT NULL
           AND terminal.source_page_count > 0
           AND terminal.observed_population = acquisition.fetched_population
           AND terminal.accepted_population = acquisition.fetched_population
           AND terminal.rejected_row_count = 0
           AND terminal.deduplicated_row_count = 0
           AND NOT terminal.caller_limited
           AND terminal.caller_limited = acquisition.caller_limited
           AND NOT terminal.safety_limited
           AND terminal.failure_stage IS NULL
           AND terminal.reason_code IS NULL
      )
    ELSE false
  END
  -- END v3 latest-terminal serving fence.
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

REVOKE ALL ON FUNCTION arena.lock_leaderboard_acquisition_source_window(integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.validate_metric_trust_attempt_outcome_authority()
  FROM PUBLIC, anon, authenticated, service_role;

-- Remove hostile ALTER DEFAULT PRIVILEGES grants for every named role. The
-- trigger does not need caller EXECUTE privilege, and the lock helper must not
-- be exposed as a source/window advisory-lock denial-of-service primitive.
DO $owner_only_acl$
DECLARE
  v_signature text;
  v_role record;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'arena.lock_leaderboard_acquisition_source_window(integer,integer)',
    'arena.validate_metric_trust_attempt_outcome_authority()'
  ]
  LOOP
    FOR v_role IN
      SELECT DISTINCT
             pg_catalog.pg_get_userbyid(privilege_row.grantee) AS role_name
        FROM pg_catalog.pg_proc AS function_row
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            function_row.proacl,
            pg_catalog.acldefault('f', function_row.proowner)
          )
        ) AS privilege_row
       WHERE function_row.oid = pg_catalog.to_regprocedure(v_signature)
         AND privilege_row.privilege_type = 'EXECUTE'
         AND privilege_row.grantee NOT IN (0, function_row.proowner)
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION %s FROM %I',
        v_signature,
        v_role.role_name
      );
    END LOOP;
  END LOOP;
END
$owner_only_acl$;

COMMENT ON FUNCTION arena.lock_leaderboard_acquisition_source_window(integer, integer) IS
  'Private trust-trigger helper. It takes the same source/timeframe transaction fence as acquisition begin and the 042 terminal serializer.';
COMMENT ON FUNCTION arena.validate_metric_trust_attempt_outcome_authority() IS
  'Fail-closed v3 metric-trust INSERT gate backed by the exact latest durable acquisition terminal and RAW identities.';
COMMENT ON VIEW arena.metric_rankable_observations IS
  'Contract-valid observations. v2 semantics remain compatible; v3 stays visible only while its attempt is the exact latest terminal success.';

DO $postflight$
DECLARE
  v_lock pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'arena.lock_leaderboard_acquisition_source_window(integer,integer)'
  );
  v_trust_trigger pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'arena.validate_metric_trust_attempt_outcome_authority()'
  );
  v_serializer pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'arena.serialize_leaderboard_terminal_publication()'
  );
  v_reject pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'arena.reject_direct_leaderboard_acquisition_mutation()'
  );
  v_postgres pg_catalog.oid := pg_catalog.to_regrole('postgres');
  v_start_definition text;
  v_rankable_definition text;
BEGIN
  IF v_lock IS NULL
     OR v_trust_trigger IS NULL
     OR v_serializer IS NULL
     OR v_reject IS NULL THEN
    RAISE EXCEPTION 'metric-trust acquisition authority functions are missing';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(
           'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'::pg_catalog.regprocedure
         )
    INTO STRICT v_start_definition;

  IF v_start_definition NOT LIKE
     '%arena.leaderboard-acquisition-source:%p_source_id::text%p_timeframe::text%' THEN
    RAISE EXCEPTION 'start RPC source/window advisory namespace drifted';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS procedure_row
        WHERE procedure_row.oid = v_lock
          AND procedure_row.prosecdef
          AND procedure_row.proowner = v_postgres
          AND procedure_row.provolatile = 'v'
          AND procedure_row.prorettype = 'void'::pg_catalog.regtype
          AND procedure_row.proconfig @> ARRAY[
                'search_path=pg_catalog, pg_temp',
                'lock_timeout=5s'
              ]::text[]
          AND pg_catalog.strpos(
                procedure_row.prosrc,
                '''arena.leaderboard-acquisition-source:'''
              ) > 0
          AND pg_catalog.strpos(
                procedure_row.prosrc,
                'p_source_id::text || '':'' || p_timeframe::text'
              ) > 0
          AND pg_catalog.strpos(
                procedure_row.prosrc,
                'pg_catalog.pg_advisory_xact_lock'
              ) > 0
     ) OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS procedure_row
        WHERE procedure_row.oid = v_trust_trigger
          AND procedure_row.prosecdef
          AND procedure_row.proowner = v_postgres
          AND procedure_row.provolatile = 'v'
          AND procedure_row.prorettype = 'trigger'::pg_catalog.regtype
          AND procedure_row.proconfig @> ARRAY[
                'search_path=pg_catalog, pg_temp',
                'lock_timeout=5s'
              ]::text[]
          AND pg_catalog.strpos(
                procedure_row.prosrc,
                'arena.latest_terminal_leaderboard_acquisitions AS terminal'
              ) > 0
          AND pg_catalog.strpos(
                procedure_row.prosrc,
                'PERFORM arena.lock_leaderboard_acquisition_source_window'
              ) > 0
     ) THEN
    RAISE EXCEPTION 'metric-trust acquisition authority function contract drifted';
  END IF;

  -- 042 remains the sole terminal serializer and must still derive its lock
  -- identity from the immutable attempt before 050 can trust that fence.
  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS procedure_row
        WHERE procedure_row.oid = v_serializer
          AND procedure_row.prosecdef
          AND procedure_row.proowner = v_postgres
          AND procedure_row.provolatile = 'v'
          AND procedure_row.prorettype = 'trigger'::pg_catalog.regtype
          AND procedure_row.proconfig @> ARRAY[
                'search_path=pg_catalog, pg_temp'
              ]::text[]
          AND pg_catalog.strpos(
                procedure_row.prosrc,
                'FROM arena.leaderboard_acquisition_attempts AS attempt'
              ) > 0
          AND pg_catalog.strpos(
                procedure_row.prosrc,
                'attempt.attempt_seq = NEW.attempt_seq'
              ) > 0
          AND pg_catalog.strpos(
                procedure_row.prosrc,
                '''arena.leaderboard-acquisition-source:'''
              ) > 0
          AND pg_catalog.strpos(
                procedure_row.prosrc,
                'v_source_id::text || '':'' || v_timeframe::text'
              ) > 0
          AND pg_catalog.strpos(
                procedure_row.prosrc,
                'pg_catalog.pg_advisory_xact_lock'
              ) > 0
     ) THEN
    RAISE EXCEPTION 'leaderboard terminal publication serializer drifted';
  END IF;

  IF (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid =
              'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
          AND trigger_row.tgname =
              'leaderboard_acquisition_outcomes_serialize_terminal_publication'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgenabled = 'O'
          AND trigger_row.tgtype = 7
          AND trigger_row.tgattr = ''::pg_catalog.int2vector
          AND trigger_row.tgqual IS NULL
          AND trigger_row.tgconstraint = 0
          AND NOT trigger_row.tgdeferrable
          AND NOT trigger_row.tginitdeferred
          AND trigger_row.tgnargs = 0
          AND pg_catalog.octet_length(trigger_row.tgargs) = 0
          AND trigger_row.tgfoid = v_serializer
     ) <> 1 THEN
    RAISE EXCEPTION 'leaderboard terminal publication trigger contract drifted';
  END IF;

  IF (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid =
              'arena.metric_trust_runs'::pg_catalog.regclass
          AND trigger_row.tgname =
              'metric_trust_runs_attempt_outcome_authority_before_insert'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgenabled = 'O'
          AND trigger_row.tgtype = 7
          AND trigger_row.tgattr = ''::pg_catalog.int2vector
          AND trigger_row.tgqual IS NULL
          AND trigger_row.tgconstraint = 0
          AND NOT trigger_row.tgdeferrable
          AND NOT trigger_row.tginitdeferred
          AND trigger_row.tgnargs = 0
          AND pg_catalog.octet_length(trigger_row.tgargs) = 0
          AND trigger_row.tgfoid = v_trust_trigger
     ) <> 1 THEN
    RAISE EXCEPTION 'metric-trust acquisition authority trigger is missing';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger AS reject_trigger
         JOIN pg_catalog.pg_trigger AS serialize_trigger
           ON serialize_trigger.tgrelid = reject_trigger.tgrelid
        WHERE reject_trigger.tgrelid =
              'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
          AND reject_trigger.tgname =
              'leaderboard_acquisition_outcomes_reject_direct_row_mutation'
          AND reject_trigger.tgfoid = v_reject
          AND reject_trigger.tgenabled = 'O'
          AND reject_trigger.tgtype = 31
          AND serialize_trigger.tgname =
              'leaderboard_acquisition_outcomes_serialize_terminal_publication'
          AND serialize_trigger.tgfoid = v_serializer
          AND reject_trigger.tgname < serialize_trigger.tgname
     ) THEN
    RAISE EXCEPTION 'leaderboard outcome triggers are not ordered fail-closed';
  END IF;

  IF EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             function_row.proacl,
             pg_catalog.acldefault('f', function_row.proowner)
           )
         ) AS privilege_row
        WHERE function_row.oid IN (v_lock::pg_catalog.oid,
                                   v_trust_trigger::pg_catalog.oid,
                                   v_serializer::pg_catalog.oid)
          AND privilege_row.privilege_type = 'EXECUTE'
          AND privilege_row.grantee <> function_row.proowner
     ) THEN
    RAISE EXCEPTION 'private publication-fence functions leaked EXECUTE';
  END IF;

  SELECT pg_catalog.pg_get_viewdef(
           'arena.metric_rankable_observations'::pg_catalog.regclass,
           true
         )
    INTO STRICT v_rankable_definition;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_class AS relation
        WHERE relation.oid =
              'arena.metric_rankable_observations'::pg_catalog.regclass
          AND relation.relkind = 'v'
          AND 'security_invoker=true' = ANY (relation.reloptions)
     )
     OR v_rankable_definition NOT LIKE
        '%latest_terminal_leaderboard_acquisitions%'
     OR v_rankable_definition NOT LIKE
        '%arena.ingest.leaderboard-acquisition-manifest@2%'
     OR v_rankable_definition NOT LIKE
        '%arena.ingest.leaderboard-acquisition-manifest@3%' THEN
    RAISE EXCEPTION 'metric rankable latest-terminal fence drifted';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
       'service_role',
       'arena.metric_rankable_observations',
       'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'anon',
       'arena.metric_rankable_observations',
       'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated',
       'arena.metric_rankable_observations',
       'SELECT'
     ) THEN
    RAISE EXCEPTION 'metric rankable view privileges drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
