-- Migration: 20260722040000_leaderboard_acquisition_manifest_v3_compat.sql
-- Created: 2026-07-22T04:00:00Z
-- Description: Add the attempt-bound leaderboard acquisition manifest v3 as
--   an additive compatibility contract. Existing v2 workers, in-flight v2
--   attempts, and exact replays remain valid during the staged worker cutover.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
DECLARE
  v_capture_constraint text;
  v_attempt_constraint text;
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_capture_contracts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_attempts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_outcomes') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL THEN
    RAISE EXCEPTION 'leaderboard acquisition manifest v3 foundations are missing';
  END IF;

  IF pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL THEN
    RAISE EXCEPTION 'PostgREST API roles are missing';
  END IF;

  IF pg_catalog.to_regprocedure(
       'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)'
     ) IS NULL THEN
    RAISE EXCEPTION 'leaderboard acquisition RPC foundations are missing';
  END IF;

  SELECT pg_catalog.pg_get_constraintdef(constraint_row.oid)
    INTO v_capture_constraint
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid =
         'arena.leaderboard_capture_contracts'::pg_catalog.regclass
     AND constraint_row.conname =
         'leaderboard_capture_contracts_capture_contract_check'
     AND constraint_row.contype = 'c'
     AND constraint_row.convalidated;

  SELECT pg_catalog.pg_get_constraintdef(constraint_row.oid)
    INTO v_attempt_constraint
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid =
         'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass
     AND constraint_row.conname =
         'leaderboard_acquisition_attempts_capture_contract_check'
     AND constraint_row.contype = 'c'
     AND constraint_row.convalidated;

  IF v_capture_constraint IS NULL
     OR v_capture_constraint NOT LIKE
        '%arena.ingest.leaderboard-acquisition-manifest@2%'
     OR v_capture_constraint LIKE
        '%arena.ingest.leaderboard-acquisition-manifest@3%'
     OR v_attempt_constraint IS NULL
     OR v_attempt_constraint NOT LIKE
        '%arena.ingest.leaderboard-acquisition-manifest@2%'
     OR v_attempt_constraint NOT LIKE '%legacy_unverified%'
     OR v_attempt_constraint LIKE
        '%arena.ingest.leaderboard-acquisition-manifest@3%' THEN
    RAISE EXCEPTION 'leaderboard acquisition capture constraints drifted';
  END IF;

  IF (
       SELECT pg_catalog.count(*)
         FROM arena.leaderboard_capture_contracts AS capture
         JOIN arena.sources AS source
           ON source.id = capture.source_id
        WHERE source.slug = 'binance_futures'
          AND source.adapter_slug = 'binance'
          AND capture.adapter_slug = source.adapter_slug
          AND capture.capture_contract =
              'arena.ingest.leaderboard-acquisition-manifest@2'
          AND capture.attempt_binding_contract =
              'arena.ingest.leaderboard-acquisition-attempt-binding@1'
          AND capture.requires_runner_git_sha
     ) <> 1
     OR EXISTS (
       SELECT 1
         FROM arena.leaderboard_capture_contracts
        WHERE capture_contract =
              'arena.ingest.leaderboard-acquisition-manifest@3'
     ) THEN
    RAISE EXCEPTION 'leaderboard acquisition capture registry drifted';
  END IF;
END
$preflight$;

ALTER TABLE arena.leaderboard_capture_contracts
  DROP CONSTRAINT leaderboard_capture_contracts_capture_contract_check,
  ADD CONSTRAINT leaderboard_capture_contracts_capture_contract_check
  CHECK (
    capture_contract IN (
      'arena.ingest.leaderboard-acquisition-manifest@2',
      'arena.ingest.leaderboard-acquisition-manifest@3'
    )
  );

ALTER TABLE arena.leaderboard_acquisition_attempts
  DROP CONSTRAINT leaderboard_acquisition_attempts_capture_contract_check,
  ADD CONSTRAINT leaderboard_acquisition_attempts_capture_contract_check
  CHECK (
    capture_contract IN (
      'arena.ingest.leaderboard-acquisition-manifest@2',
      'arena.ingest.leaderboard-acquisition-manifest@3',
      'legacy_unverified'
    )
  );

DO $register_v3$
DECLARE
  v_inserted integer;
BEGIN
  INSERT INTO arena.leaderboard_capture_contracts (
    source_id,
    capture_contract,
    adapter_slug,
    attempt_binding_contract,
    requires_runner_git_sha
  )
  SELECT
    capture.source_id,
    'arena.ingest.leaderboard-acquisition-manifest@3',
    capture.adapter_slug,
    capture.attempt_binding_contract,
    capture.requires_runner_git_sha
  FROM arena.leaderboard_capture_contracts AS capture
  JOIN arena.sources AS source
    ON source.id = capture.source_id
  WHERE source.slug = 'binance_futures'
    AND source.adapter_slug = 'binance'
    AND capture.adapter_slug = source.adapter_slug
    AND capture.capture_contract =
        'arena.ingest.leaderboard-acquisition-manifest@2';

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> 1 THEN
    RAISE EXCEPTION 'expected one Binance leaderboard manifest v3 registration';
  END IF;
END
$register_v3$;

-- Compatibility phase: both verified contracts may begin and finish. A later,
-- separately deployed migration may retire only fresh v2 begins after the v3
-- worker SHA has been verified live. v2 rows and exact replays remain durable.

CREATE OR REPLACE FUNCTION arena.start_leaderboard_acquisition_attempt(
  p_attempt_id uuid,
  p_source_id integer,
  p_timeframe integer,
  p_observation_cycle_id text,
  p_queue_job_id text,
  p_queue_attempt integer,
  p_capture_contract text,
  p_runner_git_sha text,
  p_worker_region text
)
RETURNS arena.leaderboard_acquisition_attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_existing arena.leaderboard_acquisition_attempts%ROWTYPE;
  v_source arena.sources%ROWTYPE;
  v_inserted arena.leaderboard_acquisition_attempts%ROWTYPE;
  v_registered_adapter_slug text;
  v_attempt_binding_contract text;
  v_requires_runner_git_sha boolean;
  v_prior_path text := pg_catalog.current_setting(
    'arena.leaderboard_acquisition_mutation_path',
    true
  );
BEGIN
  IF p_attempt_id IS NULL
     OR p_source_id IS NULL
     OR p_timeframe IS NULL
     OR p_queue_attempt IS NULL
     OR p_capture_contract IS NULL THEN
    RAISE EXCEPTION 'leaderboard acquisition begin arguments cannot be NULL'
      USING ERRCODE = '22023';
  END IF;

  IF p_timeframe NOT IN (7, 30, 90)
     OR p_source_id < 1
     OR p_source_id > 32767
     OR p_queue_attempt < 0
     OR p_capture_contract NOT IN (
       'arena.ingest.leaderboard-acquisition-manifest@2',
       'arena.ingest.leaderboard-acquisition-manifest@3',
       'legacy_unverified'
     )
     OR (
       p_observation_cycle_id IS NOT NULL
       AND (
         pg_catalog.btrim(p_observation_cycle_id) <> p_observation_cycle_id
         OR pg_catalog.length(p_observation_cycle_id) NOT BETWEEN 1 AND 512
       )
     )
     OR (
       p_queue_job_id IS NOT NULL
       AND (
         pg_catalog.btrim(p_queue_job_id) <> p_queue_job_id
         OR pg_catalog.length(p_queue_job_id) NOT BETWEEN 1 AND 512
       )
     )
     OR (
       p_runner_git_sha IS NOT NULL
       AND (
         p_runner_git_sha !~ '^[0-9a-f]{40}$'
         OR p_runner_git_sha = pg_catalog.repeat('0', 40)
       )
     )
     OR (
       p_worker_region IS NOT NULL
       AND (
         p_worker_region !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
         OR pg_catalog.btrim(p_worker_region) <> p_worker_region
       )
     ) THEN
    RAISE EXCEPTION 'invalid leaderboard acquisition begin arguments'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena.leaderboard-acquisition-attempt:' || p_attempt_id::text,
      0
    )
  );

  SELECT *
    INTO v_existing
    FROM arena.leaderboard_acquisition_attempts
   WHERE attempt_id = p_attempt_id;

  IF FOUND THEN
    IF v_existing.source_id IS DISTINCT FROM p_source_id
       OR v_existing.timeframe IS DISTINCT FROM p_timeframe
       OR v_existing.observation_cycle_id IS DISTINCT FROM p_observation_cycle_id
       OR v_existing.queue_job_id IS DISTINCT FROM p_queue_job_id
       OR v_existing.queue_attempt IS DISTINCT FROM p_queue_attempt
       OR v_existing.capture_contract IS DISTINCT FROM p_capture_contract
       OR v_existing.runner_git_sha IS DISTINCT FROM p_runner_git_sha
       OR v_existing.worker_region IS DISTINCT FROM p_worker_region THEN
      RAISE EXCEPTION 'leaderboard acquisition attempt id replay conflicts with prior begin'
        USING ERRCODE = '22023';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT *
    INTO STRICT v_source
    FROM arena.sources
   WHERE id = p_source_id;

  IF v_source.status <> 'active' THEN
    RAISE EXCEPTION 'leaderboard acquisition source % is not active', v_source.slug
      USING ERRCODE = '22023';
  END IF;

  IF NOT p_timeframe = ANY (
    COALESCE(v_source.timeframes_native, ARRAY[]::integer[])
  ) THEN
    RAISE EXCEPTION 'timeframe % is not native for source %', p_timeframe, v_source.slug
      USING ERRCODE = '22023';
  END IF;

  IF p_capture_contract = 'legacy_unverified' THEN
    v_attempt_binding_contract :=
      'arena.ingest.leaderboard-acquisition-attempt-binding@1';
  ELSE
    SELECT
      capture.adapter_slug,
      capture.attempt_binding_contract,
      capture.requires_runner_git_sha
    INTO
      v_registered_adapter_slug,
      v_attempt_binding_contract,
      v_requires_runner_git_sha
    FROM arena.leaderboard_capture_contracts AS capture
    WHERE capture.source_id = v_source.id
      AND capture.capture_contract = p_capture_contract;

    IF NOT FOUND
       OR v_registered_adapter_slug IS DISTINCT FROM v_source.adapter_slug THEN
      RAISE EXCEPTION 'capture contract % is not registered for source %',
        p_capture_contract,
        v_source.slug
        USING ERRCODE = '22023';
    END IF;

    IF v_requires_runner_git_sha AND p_runner_git_sha IS NULL THEN
      RAISE EXCEPTION 'verified capture contract requires a full runner git SHA'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Serialize begin order for one source/window before allocating attempt_seq.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena.leaderboard-acquisition-source:'
      || p_source_id::text || ':' || p_timeframe::text,
      0
    )
  );

  PERFORM pg_catalog.set_config(
    'arena.leaderboard_acquisition_mutation_path',
    'start_leaderboard_acquisition_attempt',
    true
  );
  BEGIN
    INSERT INTO arena.leaderboard_acquisition_attempts (
      attempt_id,
      source_id,
      source_slug,
      adapter_slug,
      timeframe,
      observation_cycle_id,
      queue_job_id,
      queue_attempt,
      capture_contract,
      attempt_binding_contract,
      runner_git_sha,
      worker_region,
      source_status,
      source_serving_mode,
      source_currency,
      source_fetch_region,
      recorded_started_at
    ) VALUES (
      p_attempt_id,
      v_source.id,
      v_source.slug,
      v_source.adapter_slug,
      p_timeframe,
      p_observation_cycle_id,
      p_queue_job_id,
      p_queue_attempt,
      p_capture_contract,
      v_attempt_binding_contract,
      p_runner_git_sha,
      p_worker_region,
      v_source.status,
      v_source.serving_mode,
      v_source.currency,
      v_source.fetch_region,
      pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp())
    )
    RETURNING * INTO STRICT v_inserted;
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config(
      'arena.leaderboard_acquisition_mutation_path',
      COALESCE(v_prior_path, ''),
      true
    );
    RAISE;
  END;
  PERFORM pg_catalog.set_config(
    'arena.leaderboard_acquisition_mutation_path',
    COALESCE(v_prior_path, ''),
    true
  );

  RETURN v_inserted;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'leaderboard acquisition source % does not exist', p_source_id
      USING ERRCODE = '22023';
END
$function$;

ALTER FUNCTION arena.start_leaderboard_acquisition_attempt(
  uuid, integer, integer, text, text, integer, text, text, text
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION arena.finish_leaderboard_acquisition_attempt(
  p_attempt_id uuid,
  p_terminal_state text,
  p_acquisition_state text,
  p_population_state text,
  p_capture_evidence_state text,
  p_termination_reason text,
  p_capture_started_at timestamptz,
  p_capture_completed_at timestamptz,
  p_source_run_id text,
  p_source_payload_raw_object_id bigint,
  p_manifest_raw_object_id bigint,
  p_diagnostic_raw_object_id bigint,
  p_reported_population integer,
  p_population_report_state text,
  p_source_page_count integer,
  p_reported_page_count integer,
  p_page_count_report_state text,
  p_observed_population integer,
  p_accepted_population integer,
  p_rejected_row_count integer,
  p_deduplicated_row_count integer,
  p_caller_limited boolean,
  p_safety_limited boolean,
  p_failure_stage text,
  p_reason_code text
)
RETURNS arena.leaderboard_acquisition_outcomes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_attempt arena.leaderboard_acquisition_attempts%ROWTYPE;
  v_existing arena.leaderboard_acquisition_outcomes%ROWTYPE;
  v_inserted arena.leaderboard_acquisition_outcomes%ROWTYPE;
  v_source_payload arena.raw_objects%ROWTYPE;
  v_manifest arena.raw_objects%ROWTYPE;
  v_diagnostic arena.raw_objects%ROWTYPE;
  v_source_payload_hash text;
  v_source_payload_path text;
  v_manifest_hash text;
  v_manifest_path text;
  v_diagnostic_hash text;
  v_diagnostic_path text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_prior_path text := pg_catalog.current_setting(
    'arena.leaderboard_acquisition_mutation_path',
    true
  );
BEGIN
  IF p_attempt_id IS NULL
     OR p_caller_limited IS NULL
     OR p_safety_limited IS NULL THEN
    RAISE EXCEPTION 'leaderboard acquisition finish identity cannot be NULL'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena.leaderboard-acquisition-attempt:' || p_attempt_id::text,
      0
    )
  );

  SELECT *
    INTO STRICT v_attempt
    FROM arena.leaderboard_acquisition_attempts
   WHERE attempt_id = p_attempt_id
   FOR UPDATE;

  SELECT *
    INTO v_existing
    FROM arena.leaderboard_acquisition_outcomes
   WHERE attempt_seq = v_attempt.attempt_seq;

  IF FOUND THEN
    IF v_existing.terminal_state IS DISTINCT FROM p_terminal_state
       OR v_existing.acquisition_state IS DISTINCT FROM p_acquisition_state
       OR v_existing.population_state IS DISTINCT FROM p_population_state
       OR v_existing.capture_evidence_state IS DISTINCT FROM p_capture_evidence_state
       OR v_existing.termination_reason IS DISTINCT FROM p_termination_reason
       OR v_existing.capture_started_at IS DISTINCT FROM p_capture_started_at
       OR v_existing.capture_completed_at IS DISTINCT FROM p_capture_completed_at
       OR v_existing.source_run_id IS DISTINCT FROM p_source_run_id
       OR v_existing.source_payload_raw_object_id
          IS DISTINCT FROM p_source_payload_raw_object_id
       OR v_existing.manifest_raw_object_id IS DISTINCT FROM p_manifest_raw_object_id
       OR v_existing.diagnostic_raw_object_id IS DISTINCT FROM p_diagnostic_raw_object_id
       OR v_existing.reported_population IS DISTINCT FROM p_reported_population
       OR v_existing.population_report_state IS DISTINCT FROM p_population_report_state
       OR v_existing.source_page_count IS DISTINCT FROM p_source_page_count
       OR v_existing.reported_page_count IS DISTINCT FROM p_reported_page_count
       OR v_existing.page_count_report_state IS DISTINCT FROM p_page_count_report_state
       OR v_existing.observed_population IS DISTINCT FROM p_observed_population
       OR v_existing.accepted_population IS DISTINCT FROM p_accepted_population
       OR v_existing.rejected_row_count IS DISTINCT FROM p_rejected_row_count
       OR v_existing.deduplicated_row_count
          IS DISTINCT FROM p_deduplicated_row_count
       OR v_existing.caller_limited IS DISTINCT FROM p_caller_limited
       OR v_existing.safety_limited IS DISTINCT FROM p_safety_limited
       OR v_existing.failure_stage IS DISTINCT FROM p_failure_stage
       OR v_existing.reason_code IS DISTINCT FROM p_reason_code THEN
      RAISE EXCEPTION 'leaderboard acquisition finish replay conflicts with terminal outcome'
        USING ERRCODE = '22023';
    END IF;
    RETURN v_existing;
  END IF;

  IF p_capture_started_at IS NOT NULL
     AND p_capture_started_at IS DISTINCT FROM v_attempt.recorded_started_at THEN
    RAISE EXCEPTION 'capture start must equal the database attempt start'
      USING ERRCODE = '22023';
  END IF;

  IF p_capture_completed_at IS NOT NULL AND (
       p_capture_started_at IS NULL
       OR p_capture_completed_at < p_capture_started_at
       OR p_capture_completed_at > v_now + interval '5 minutes'
     ) THEN
    RAISE EXCEPTION 'capture completion timestamp is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF (
       v_attempt.capture_contract = 'legacy_unverified'
       AND p_capture_evidence_state NOT IN ('legacy_unverified', 'unassessed')
     ) OR (
       v_attempt.capture_contract IN (
         'arena.ingest.leaderboard-acquisition-manifest@2',
         'arena.ingest.leaderboard-acquisition-manifest@3'
       )
       AND p_capture_evidence_state NOT IN ('verified', 'unavailable', 'unassessed')
     ) THEN
    RAISE EXCEPTION 'capture evidence state does not match the attempt contract'
      USING ERRCODE = '22023';
  END IF;

  -- Freeze every referenced RAW row across validation and outcome insertion.
  -- A concurrent updater then resumes only after the outcome exists, at which
  -- point the RAW protection trigger rejects the mutation. Deletion may resume
  -- after COMMIT because the outcome has already frozen id/hash/path identity.
  PERFORM raw_object.id
    FROM arena.raw_objects AS raw_object
   WHERE raw_object.id = ANY (ARRAY[
     p_source_payload_raw_object_id,
     p_manifest_raw_object_id,
     p_diagnostic_raw_object_id
   ]::bigint[])
   ORDER BY raw_object.id
   FOR UPDATE;

  IF p_source_payload_raw_object_id IS NOT NULL
     OR p_manifest_raw_object_id IS NOT NULL THEN
    IF v_attempt.capture_contract NOT IN (
         'arena.ingest.leaderboard-acquisition-manifest@2',
         'arena.ingest.leaderboard-acquisition-manifest@3'
       )
       OR p_source_payload_raw_object_id IS NULL
       OR p_manifest_raw_object_id IS NULL
       OR p_source_run_id IS NULL
       OR p_capture_completed_at IS NULL THEN
      RAISE EXCEPTION 'verified capture RAW evidence requires one complete bound pair'
        USING ERRCODE = '22023';
    END IF;

    SELECT *
      INTO STRICT v_source_payload
      FROM arena.raw_objects
     WHERE id = p_source_payload_raw_object_id;
    SELECT *
      INTO STRICT v_manifest
      FROM arena.raw_objects
     WHERE id = p_manifest_raw_object_id;

    IF v_source_payload.source_id IS DISTINCT FROM v_attempt.source_id
       OR v_source_payload.timeframe IS DISTINCT FROM v_attempt.timeframe
       OR v_source_payload.job_type IS DISTINCT FROM 'tier_a'
       OR v_source_payload.trader_id IS NOT NULL
       OR v_source_payload.source_run_id IS DISTINCT FROM p_source_run_id
       OR v_source_payload.trust_artifact_role IS DISTINCT FROM 'source_payload'
       OR v_source_payload.quarantined
       OR v_source_payload.content_hash !~ '^[0-9a-f]{64}$'
       OR v_source_payload.content_hash = pg_catalog.repeat('0', 64)
       OR v_source_payload.fetched_at IS DISTINCT FROM p_capture_completed_at
       OR v_source_payload.meta->>'source_run_id' IS DISTINCT FROM p_source_run_id
       OR v_source_payload.meta->>'surface' IS DISTINCT FROM 'tier_a_leaderboard'
       OR v_source_payload.meta->'acquisition_attempt'->>'binding_contract'
          IS DISTINCT FROM v_attempt.attempt_binding_contract
       OR v_source_payload.meta->'acquisition_attempt'->>'attempt_id'
          IS DISTINCT FROM v_attempt.attempt_id::text
       OR (v_source_payload.meta->'acquisition_attempt'->>'attempt_seq')::bigint
          IS DISTINCT FROM v_attempt.attempt_seq
       OR (v_source_payload.meta->'acquisition_attempt'->>'capture_started_at')::timestamptz
          IS DISTINCT FROM p_capture_started_at
       OR (v_source_payload.meta->'acquisition_attempt'->>'capture_completed_at')::timestamptz
          IS DISTINCT FROM p_capture_completed_at
       OR v_source_payload.meta->'acquisition_attempt'->>'runner_git_sha'
          IS DISTINCT FROM v_attempt.runner_git_sha
       OR v_source_payload.meta->'raw_integrity'->>'hash_algorithm'
          IS DISTINCT FROM 'sha256'
       OR v_source_payload.meta->'raw_integrity'->>'hash_scope'
          IS DISTINCT FROM 'json_utf8'
       OR v_source_payload.meta->'raw_integrity'->>'serialization_contract'
          IS DISTINCT FROM 'arena.strict-canonical-json@1'
       OR (
         v_attempt.observation_cycle_id IS NULL
         AND v_source_payload.meta ? 'observation_cycle_id'
       )
       OR (
         v_attempt.observation_cycle_id IS NOT NULL
         AND v_source_payload.meta->>'observation_cycle_id'
             IS DISTINCT FROM v_attempt.observation_cycle_id
       ) THEN
      RAISE EXCEPTION 'source payload RAW does not match the acquisition attempt'
        USING ERRCODE = '22023';
    END IF;

    IF v_manifest.source_id IS DISTINCT FROM v_attempt.source_id
       OR v_manifest.timeframe IS DISTINCT FROM v_attempt.timeframe
       OR v_manifest.job_type IS DISTINCT FROM 'tier_a_manifest'
       OR v_manifest.trader_id IS NOT NULL
       OR v_manifest.source_run_id IS DISTINCT FROM p_source_run_id
       OR v_manifest.trust_artifact_role IS DISTINCT FROM 'population_manifest'
       OR v_manifest.quarantined
       OR v_manifest.content_hash IS DISTINCT FROM p_source_run_id
       OR v_manifest.fetched_at IS DISTINCT FROM p_capture_completed_at
       OR v_manifest.meta->>'source_run_id' IS DISTINCT FROM p_source_run_id
       OR v_manifest.meta->>'surface' IS DISTINCT FROM 'tier_a_leaderboard'
       OR v_manifest.meta->>'data_contract' IS DISTINCT FROM v_attempt.capture_contract
       OR v_manifest.meta->'acquisition_attempt'->>'binding_contract'
          IS DISTINCT FROM v_attempt.attempt_binding_contract
       OR v_manifest.meta->'acquisition_attempt'->>'attempt_id'
          IS DISTINCT FROM v_attempt.attempt_id::text
       OR (v_manifest.meta->'acquisition_attempt'->>'attempt_seq')::bigint
          IS DISTINCT FROM v_attempt.attempt_seq
       OR (v_manifest.meta->'acquisition_attempt'->>'capture_started_at')::timestamptz
          IS DISTINCT FROM p_capture_started_at
       OR (v_manifest.meta->'acquisition_attempt'->>'capture_completed_at')::timestamptz
          IS DISTINCT FROM p_capture_completed_at
       OR v_manifest.meta->'acquisition_attempt'->>'runner_git_sha'
          IS DISTINCT FROM v_attempt.runner_git_sha
       OR v_manifest.meta->'acquisition_attempt'->>'capture_evidence_state'
          IS DISTINCT FROM p_capture_evidence_state
       OR v_manifest.meta->'acquisition_attempt'->>'termination_reason'
          IS DISTINCT FROM p_termination_reason
       OR (v_manifest.meta->'acquisition_attempt'->>'source_page_count')::integer
          IS DISTINCT FROM p_source_page_count
       OR v_manifest.meta->'acquisition_attempt'->>'population_report_state'
          IS DISTINCT FROM p_population_report_state
       OR (v_manifest.meta->'acquisition_attempt'->>'reported_population')::integer
          IS DISTINCT FROM p_reported_population
       OR v_manifest.meta->'acquisition_attempt'->>'page_count_report_state'
          IS DISTINCT FROM p_page_count_report_state
       OR (v_manifest.meta->'acquisition_attempt'->>'reported_page_count')::integer
          IS DISTINCT FROM p_reported_page_count
       OR (v_manifest.meta->'acquisition_attempt'->>'observed_population')::integer
          IS DISTINCT FROM p_observed_population
       OR (v_manifest.meta->'acquisition_attempt'->>'accepted_population')::integer
          IS DISTINCT FROM p_accepted_population
       OR (v_manifest.meta->'acquisition_attempt'->>'rejected_row_count')::integer
          IS DISTINCT FROM p_rejected_row_count
       OR (v_manifest.meta->'acquisition_attempt'->>'deduplicated_row_count')::integer
          IS DISTINCT FROM p_deduplicated_row_count
       OR (v_manifest.meta->'acquisition_attempt'->>'caller_limited')::boolean
          IS DISTINCT FROM p_caller_limited
       OR (v_manifest.meta->'acquisition_attempt'->>'safety_limited')::boolean
          IS DISTINCT FROM p_safety_limited
       OR v_manifest.meta->'acquisition_attempt'->>'acquisition_state'
          IS DISTINCT FROM p_acquisition_state
       OR v_manifest.meta->'acquisition_attempt'->>'population_state'
          IS DISTINCT FROM p_population_state
       OR v_manifest.meta->'raw_integrity'->>'hash_algorithm'
          IS DISTINCT FROM 'sha256'
       OR v_manifest.meta->'raw_integrity'->>'hash_scope'
          IS DISTINCT FROM 'json_utf8'
       OR v_manifest.meta->'raw_integrity'->>'serialization_contract'
          IS DISTINCT FROM 'arena.strict-canonical-json@1'
       OR (
         v_attempt.observation_cycle_id IS NULL
         AND v_manifest.meta ? 'observation_cycle_id'
       )
       OR (
         v_attempt.observation_cycle_id IS NOT NULL
         AND v_manifest.meta->>'observation_cycle_id'
             IS DISTINCT FROM v_attempt.observation_cycle_id
       ) THEN
      RAISE EXCEPTION 'population manifest RAW does not match the acquisition attempt'
        USING ERRCODE = '22023';
    END IF;

    v_source_payload_hash := v_source_payload.content_hash;
    v_source_payload_path := v_source_payload.storage_path;
    v_manifest_hash := v_manifest.content_hash;
    v_manifest_path := v_manifest.storage_path;
  ELSIF p_source_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'source run identity cannot exist without its RAW pair'
      USING ERRCODE = '22023';
  END IF;

  IF p_diagnostic_raw_object_id IS NOT NULL THEN
    SELECT *
      INTO STRICT v_diagnostic
      FROM arena.raw_objects
     WHERE id = p_diagnostic_raw_object_id;

    IF v_diagnostic.source_id IS DISTINCT FROM v_attempt.source_id
       OR v_diagnostic.timeframe IS DISTINCT FROM v_attempt.timeframe
       OR v_diagnostic.job_type NOT IN ('tier_a', 'tier_a_failure')
       OR v_diagnostic.trader_id IS NOT NULL
       OR v_diagnostic.source_run_id IS NOT NULL
       OR v_diagnostic.trust_artifact_role IS NOT NULL
       OR v_diagnostic.quarantined
       OR v_diagnostic.content_hash !~ '^[0-9a-f]{64}$'
       OR v_diagnostic.content_hash = pg_catalog.repeat('0', 64)
       OR v_diagnostic.fetched_at < v_attempt.recorded_started_at - interval '5 minutes'
       OR v_diagnostic.fetched_at > v_now + interval '5 minutes'
       OR v_diagnostic.meta->'raw_integrity'->>'hash_algorithm'
          IS DISTINCT FROM 'sha256'
       OR v_diagnostic.meta->'raw_integrity'->>'hash_scope'
          IS DISTINCT FROM 'json_utf8'
       OR v_diagnostic.meta->'acquisition_attempt'->>'binding_contract'
          IS DISTINCT FROM v_attempt.attempt_binding_contract
       OR v_diagnostic.meta->'acquisition_attempt'->>'attempt_id'
          IS DISTINCT FROM v_attempt.attempt_id::text
       OR (v_diagnostic.meta->'acquisition_attempt'->>'attempt_seq')::bigint
          IS DISTINCT FROM v_attempt.attempt_seq
       OR (
         v_attempt.observation_cycle_id IS NULL
         AND v_diagnostic.meta ? 'observation_cycle_id'
       )
       OR (
         v_attempt.observation_cycle_id IS NOT NULL
         AND v_diagnostic.meta->>'observation_cycle_id'
             IS DISTINCT FROM v_attempt.observation_cycle_id
       ) THEN
      RAISE EXCEPTION 'diagnostic RAW does not match the acquisition attempt'
        USING ERRCODE = '22023';
    END IF;

    IF p_terminal_state = 'unknown'
       AND v_attempt.capture_contract = 'legacy_unverified'
       AND v_diagnostic.job_type <> 'tier_a' THEN
      RAISE EXCEPTION 'legacy unknown outcome requires its Tier-A RAW payload'
        USING ERRCODE = '22023';
    END IF;

    v_diagnostic_hash := v_diagnostic.content_hash;
    v_diagnostic_path := v_diagnostic.storage_path;
  END IF;

  IF p_terminal_state IN ('complete', 'partial')
     AND v_attempt.capture_contract NOT IN (
       'arena.ingest.leaderboard-acquisition-manifest@2',
       'arena.ingest.leaderboard-acquisition-manifest@3'
     ) THEN
    RAISE EXCEPTION 'legacy acquisition cannot claim complete or partial evidence'
      USING ERRCODE = '22023';
  END IF;

  IF p_terminal_state = 'unknown'
     AND v_attempt.capture_contract = 'legacy_unverified'
     AND (
       p_source_run_id IS NOT NULL
       OR p_diagnostic_raw_object_id IS NULL
       OR p_reason_code IS DISTINCT FROM 'legacy_unverified'
     ) THEN
    RAISE EXCEPTION 'legacy acquisition must remain unknown with unverified RAW evidence'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config(
    'arena.leaderboard_acquisition_mutation_path',
    'finish_leaderboard_acquisition_attempt',
    true
  );
  BEGIN
    INSERT INTO arena.leaderboard_acquisition_outcomes (
      attempt_seq,
      terminal_state,
      acquisition_state,
      population_state,
      capture_evidence_state,
      termination_reason,
      capture_started_at,
      capture_completed_at,
      source_run_id,
      source_payload_raw_object_id,
      source_payload_content_hash,
      source_payload_storage_path,
      manifest_raw_object_id,
      manifest_content_hash,
      manifest_storage_path,
      diagnostic_raw_object_id,
      diagnostic_content_hash,
      diagnostic_storage_path,
      reported_population,
      population_report_state,
      source_page_count,
      reported_page_count,
      page_count_report_state,
      observed_population,
      accepted_population,
      rejected_row_count,
      deduplicated_row_count,
      caller_limited,
      safety_limited,
      failure_stage,
      reason_code,
      recorded_completed_at
    ) VALUES (
      v_attempt.attempt_seq,
      p_terminal_state,
      p_acquisition_state,
      p_population_state,
      p_capture_evidence_state,
      p_termination_reason,
      p_capture_started_at,
      p_capture_completed_at,
      p_source_run_id,
      p_source_payload_raw_object_id,
      v_source_payload_hash,
      v_source_payload_path,
      p_manifest_raw_object_id,
      v_manifest_hash,
      v_manifest_path,
      p_diagnostic_raw_object_id,
      v_diagnostic_hash,
      v_diagnostic_path,
      p_reported_population,
      p_population_report_state,
      p_source_page_count,
      p_reported_page_count,
      p_page_count_report_state,
      p_observed_population,
      p_accepted_population,
      p_rejected_row_count,
      p_deduplicated_row_count,
      p_caller_limited,
      p_safety_limited,
      p_failure_stage,
      p_reason_code,
      pg_catalog.clock_timestamp()
    )
    RETURNING * INTO STRICT v_inserted;
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config(
      'arena.leaderboard_acquisition_mutation_path',
      COALESCE(v_prior_path, ''),
      true
    );
    RAISE;
  END;
  PERFORM pg_catalog.set_config(
    'arena.leaderboard_acquisition_mutation_path',
    COALESCE(v_prior_path, ''),
    true
  );

  RETURN v_inserted;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'leaderboard acquisition attempt or RAW evidence does not exist'
      USING ERRCODE = '22023';
END
$function$;

ALTER FUNCTION arena.finish_leaderboard_acquisition_attempt(
  uuid, text, text, text, text, text, timestamptz, timestamptz, text,
  bigint, bigint, bigint, integer, text, integer, integer, text,
  integer, integer, integer, integer, boolean, boolean, text, text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION arena.start_leaderboard_acquisition_attempt(
  uuid, integer, integer, text, text, integer, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.finish_leaderboard_acquisition_attempt(
  uuid, text, text, text, text, text, timestamptz, timestamptz, text,
  bigint, bigint, bigint, integer, text, integer, integer, text,
  integer, integer, integer, integer, boolean, boolean, text, text
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION arena.start_leaderboard_acquisition_attempt(
  uuid, integer, integer, text, text, integer, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION arena.finish_leaderboard_acquisition_attempt(
  uuid, text, text, text, text, text, timestamptz, timestamptz, text,
  bigint, bigint, bigint, integer, text, integer, integer, text,
  integer, integer, integer, integer, boolean, boolean, text, text
) TO service_role;

DO $postflight$
DECLARE
  v_start pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'
  );
  v_finish pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)'
  );
  v_capture_constraint text;
  v_attempt_constraint text;
  v_unique_outcome_identities bigint;
BEGIN
  IF v_start IS NULL OR v_finish IS NULL THEN
    RAISE EXCEPTION 'leaderboard acquisition compatibility RPCs are missing';
  END IF;

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
     ) <> 2 THEN
    RAISE EXCEPTION 'leaderboard acquisition v2/v3 registry is incomplete';
  END IF;

  SELECT pg_catalog.pg_get_constraintdef(constraint_row.oid)
    INTO v_capture_constraint
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid =
         'arena.leaderboard_capture_contracts'::pg_catalog.regclass
     AND constraint_row.conname =
         'leaderboard_capture_contracts_capture_contract_check'
     AND constraint_row.contype = 'c'
     AND constraint_row.convalidated;

  SELECT pg_catalog.pg_get_constraintdef(constraint_row.oid)
    INTO v_attempt_constraint
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid =
         'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass
     AND constraint_row.conname =
         'leaderboard_acquisition_attempts_capture_contract_check'
     AND constraint_row.contype = 'c'
     AND constraint_row.convalidated;

  IF v_capture_constraint IS NULL
     OR v_capture_constraint NOT LIKE
        '%arena.ingest.leaderboard-acquisition-manifest@2%'
     OR v_capture_constraint NOT LIKE
        '%arena.ingest.leaderboard-acquisition-manifest@3%'
     OR v_attempt_constraint IS NULL
     OR v_attempt_constraint NOT LIKE
        '%arena.ingest.leaderboard-acquisition-manifest@2%'
     OR v_attempt_constraint NOT LIKE
        '%arena.ingest.leaderboard-acquisition-manifest@3%'
     OR v_attempt_constraint NOT LIKE '%legacy_unverified%' THEN
    RAISE EXCEPTION 'leaderboard acquisition compatibility constraints are incomplete';
  END IF;

  SELECT pg_catalog.count(*)
    INTO v_unique_outcome_identities
    FROM pg_catalog.pg_indexes AS index_row
   WHERE index_row.schemaname = 'arena'
     AND index_row.indexname = ANY (ARRAY[
       'uidx_leaderboard_acquisition_outcomes_source_run',
       'uidx_leaderboard_acquisition_outcomes_source_payload',
       'uidx_leaderboard_acquisition_outcomes_manifest',
       'uidx_leaderboard_acquisition_outcomes_diagnostic'
     ])
     AND index_row.indexdef LIKE 'CREATE UNIQUE INDEX%';

  IF v_unique_outcome_identities <> 4 THEN
    RAISE EXCEPTION 'leaderboard acquisition evidence ownership indexes drifted';
  END IF;

  IF NOT pg_catalog.has_function_privilege('service_role', v_start, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_finish, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_start, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_finish, 'EXECUTE') THEN
    RAISE EXCEPTION 'leaderboard acquisition compatibility RPC privileges are unsafe';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;

