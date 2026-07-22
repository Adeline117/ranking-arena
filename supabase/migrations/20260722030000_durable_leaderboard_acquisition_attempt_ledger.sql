-- Migration: 20260722030000_durable_leaderboard_acquisition_attempt_ledger.sql
-- Created: 2026-07-22T03:00:00Z
-- Description: Add a durable, append-only attempt ledger before Tier-A makes
--   its first upstream request. A newer in-progress, partial, unknown, failed,
--   or abandoned acquisition remains newer than an older complete one. This is
--   a private shadow substrate: complete acquisition evidence alone does not
--   authorize public ranking without an exact snapshot, metric-trust run, and
--   rollout-policy binding.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL THEN
    RAISE EXCEPTION 'leaderboard acquisition ledger foundations are missing';
  END IF;

  IF pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL THEN
    RAISE EXCEPTION 'PostgREST API roles are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'arena'
       AND table_name = 'raw_objects'
       AND column_name = 'source_run_id'
  ) OR NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'arena'
       AND table_name = 'raw_objects'
       AND column_name = 'trust_artifact_role'
  ) THEN
    RAISE EXCEPTION 'metric-trust RAW identity columns are missing';
  END IF;

  IF pg_catalog.to_regclass('arena.leaderboard_acquisition_attempts') IS NOT NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_outcomes') IS NOT NULL
     OR pg_catalog.to_regclass('arena.leaderboard_capture_contracts') IS NOT NULL THEN
    RAISE EXCEPTION 'leaderboard acquisition ledger already exists';
  END IF;
END
$preflight$;

-- Capture capability is a database-pinned fact, not a caller assertion. New
-- adapters/contract versions are added by later migrations after their own
-- evidence-preserving capture review. Legacy remains available only as an
-- explicitly unverified path.
CREATE TABLE arena.leaderboard_capture_contracts (
  source_id smallint NOT NULL REFERENCES arena.sources(id) ON DELETE RESTRICT,
  capture_contract text NOT NULL CHECK (
    capture_contract = 'arena.ingest.leaderboard-acquisition-manifest@2'
  ),
  adapter_slug text NOT NULL CHECK (
    pg_catalog.btrim(adapter_slug) = adapter_slug
    AND pg_catalog.length(adapter_slug) BETWEEN 1 AND 128
  ),
  attempt_binding_contract text NOT NULL CHECK (
    attempt_binding_contract =
      'arena.ingest.leaderboard-acquisition-attempt-binding@1'
  ),
  requires_runner_git_sha boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (source_id, capture_contract)
);

INSERT INTO arena.leaderboard_capture_contracts (
  source_id,
  capture_contract,
  adapter_slug,
  attempt_binding_contract,
  requires_runner_git_sha
)
SELECT
  source.id,
  'arena.ingest.leaderboard-acquisition-manifest@2',
  source.adapter_slug,
  'arena.ingest.leaderboard-acquisition-attempt-binding@1',
  true
FROM arena.sources AS source
WHERE source.slug = 'binance_futures'
  AND source.adapter_slug = 'binance';

-- attempt_seq is the only latest-attempt fence. attempt_id is supplied by the
-- worker so an uncertain COMMIT can replay the exact begin call. One BullMQ
-- observation cycle may have several physical retries, so cycle ids are not
-- unique by design.
CREATE TABLE arena.leaderboard_acquisition_attempts (
  attempt_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id uuid NOT NULL UNIQUE,
  source_id smallint NOT NULL REFERENCES arena.sources(id) ON DELETE RESTRICT,
  source_slug text NOT NULL CHECK (
    pg_catalog.btrim(source_slug) = source_slug
    AND pg_catalog.length(source_slug) BETWEEN 1 AND 128
  ),
  adapter_slug text NOT NULL CHECK (
    pg_catalog.btrim(adapter_slug) = adapter_slug
    AND pg_catalog.length(adapter_slug) BETWEEN 1 AND 128
  ),
  timeframe smallint NOT NULL CHECK (timeframe IN (7, 30, 90)),
  observation_cycle_id text CHECK (
    observation_cycle_id IS NULL
    OR (
      pg_catalog.btrim(observation_cycle_id) = observation_cycle_id
      AND pg_catalog.length(observation_cycle_id) BETWEEN 1 AND 512
    )
  ),
  queue_job_id text CHECK (
    queue_job_id IS NULL
    OR (
      pg_catalog.btrim(queue_job_id) = queue_job_id
      AND pg_catalog.length(queue_job_id) BETWEEN 1 AND 512
    )
  ),
  queue_attempt integer NOT NULL CHECK (queue_attempt >= 0),
  capture_contract text NOT NULL CHECK (
    capture_contract IN (
      'arena.ingest.leaderboard-acquisition-manifest@2',
      'legacy_unverified'
    )
  ),
  attempt_binding_contract text NOT NULL CHECK (
    attempt_binding_contract =
      'arena.ingest.leaderboard-acquisition-attempt-binding@1'
  ),
  runner_git_sha text CHECK (
    runner_git_sha IS NULL
    OR (
      runner_git_sha ~ '^[0-9a-f]{40}$'
      AND runner_git_sha <> pg_catalog.repeat('0', 40)
    )
  ),
  worker_region text CHECK (
    worker_region IS NULL
    OR (
      worker_region ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      AND pg_catalog.btrim(worker_region) = worker_region
    )
  ),
  source_status text NOT NULL CHECK (
    source_status IN ('active', 'inactive', 'blocked_pending_vps', 'dropped')
  ),
  source_serving_mode text NOT NULL CHECK (
    source_serving_mode IN ('legacy', 'shadow', 'serving')
  ),
  source_currency text NOT NULL CHECK (
    source_currency IN ('USDT', 'USDx', 'USDC', 'USD')
  ),
  source_fetch_region text NOT NULL CHECK (
    pg_catalog.btrim(source_fetch_region) = source_fetch_region
    AND pg_catalog.length(source_fetch_region) BETWEEN 1 AND 128
  ),
  recorded_started_at timestamptz NOT NULL
);

CREATE INDEX idx_leaderboard_acquisition_attempts_latest
  ON arena.leaderboard_acquisition_attempts (
    source_id,
    timeframe,
    attempt_seq DESC
  );

CREATE INDEX idx_leaderboard_acquisition_attempts_cycle
  ON arena.leaderboard_acquisition_attempts (
    observation_cycle_id,
    attempt_seq
  )
  WHERE observation_cycle_id IS NOT NULL;

-- RAW ids are deliberately soft pointers. The finish function verifies the
-- live rows and copies immutable content identities into this outcome before
-- insertion; normal RAW retention may later remove arena.raw_objects rows.
CREATE TABLE arena.leaderboard_acquisition_outcomes (
  attempt_seq bigint PRIMARY KEY
    REFERENCES arena.leaderboard_acquisition_attempts(attempt_seq) ON DELETE RESTRICT,
  terminal_state text NOT NULL CHECK (
    terminal_state IN ('complete', 'partial', 'unknown', 'processing_failed', 'abandoned')
  ),
  acquisition_state text NOT NULL CHECK (
    acquisition_state IN ('complete', 'partial', 'unknown')
  ),
  population_state text NOT NULL CHECK (
    population_state IN ('verified', 'partial', 'unknown')
  ),
  capture_evidence_state text NOT NULL CHECK (
    capture_evidence_state IN (
      'verified',
      'unavailable',
      'legacy_unverified',
      'unassessed'
    )
  ),
  termination_reason text CHECK (
    termination_reason IS NULL
    OR termination_reason IN (
      'reported_population_reached',
      'reported_page_count_reached',
      'short_page',
      'empty_page',
      'cursor_exhausted',
      'single_snapshot',
      'degenerate_page',
      'caller_limit',
      'safety_limit',
      'upstream_error',
      'unknown'
    )
  ),
  capture_started_at timestamptz,
  capture_completed_at timestamptz,
  source_run_id text CHECK (
    source_run_id IS NULL
    OR (
      source_run_id ~ '^[0-9a-f]{64}$'
      AND source_run_id <> pg_catalog.repeat('0', 64)
    )
  ),
  source_payload_raw_object_id bigint CHECK (
    source_payload_raw_object_id IS NULL OR source_payload_raw_object_id > 0
  ),
  source_payload_content_hash text CHECK (
    source_payload_content_hash IS NULL
    OR (
      source_payload_content_hash ~ '^[0-9a-f]{64}$'
      AND source_payload_content_hash <> pg_catalog.repeat('0', 64)
    )
  ),
  source_payload_storage_path text CHECK (
    source_payload_storage_path IS NULL
    OR pg_catalog.length(source_payload_storage_path) BETWEEN 1 AND 2048
  ),
  manifest_raw_object_id bigint CHECK (
    manifest_raw_object_id IS NULL OR manifest_raw_object_id > 0
  ),
  manifest_content_hash text CHECK (
    manifest_content_hash IS NULL
    OR (
      manifest_content_hash ~ '^[0-9a-f]{64}$'
      AND manifest_content_hash <> pg_catalog.repeat('0', 64)
    )
  ),
  manifest_storage_path text CHECK (
    manifest_storage_path IS NULL
    OR pg_catalog.length(manifest_storage_path) BETWEEN 1 AND 2048
  ),
  diagnostic_raw_object_id bigint CHECK (
    diagnostic_raw_object_id IS NULL OR diagnostic_raw_object_id > 0
  ),
  diagnostic_content_hash text CHECK (
    diagnostic_content_hash IS NULL
    OR (
      diagnostic_content_hash ~ '^[0-9a-f]{64}$'
      AND diagnostic_content_hash <> pg_catalog.repeat('0', 64)
    )
  ),
  diagnostic_storage_path text CHECK (
    diagnostic_storage_path IS NULL
    OR pg_catalog.length(diagnostic_storage_path) BETWEEN 1 AND 2048
  ),
  reported_population integer CHECK (
    reported_population IS NULL OR reported_population >= 0
  ),
  population_report_state text CHECK (
    population_report_state IS NULL
    OR population_report_state IN ('consistent', 'conflicting', 'unknown')
  ),
  source_page_count integer CHECK (
    source_page_count IS NULL OR source_page_count >= 0
  ),
  reported_page_count integer CHECK (
    reported_page_count IS NULL OR reported_page_count >= 0
  ),
  page_count_report_state text CHECK (
    page_count_report_state IS NULL
    OR page_count_report_state IN ('consistent', 'conflicting', 'unknown')
  ),
  observed_population integer CHECK (
    observed_population IS NULL OR observed_population >= 0
  ),
  accepted_population integer CHECK (
    accepted_population IS NULL OR accepted_population >= 0
  ),
  rejected_row_count integer CHECK (
    rejected_row_count IS NULL OR rejected_row_count >= 0
  ),
  deduplicated_row_count integer CHECK (
    deduplicated_row_count IS NULL OR deduplicated_row_count >= 0
  ),
  caller_limited boolean NOT NULL,
  safety_limited boolean NOT NULL,
  failure_stage text CHECK (
    failure_stage IS NULL
    OR failure_stage IN (
      'session_open',
      'request_build',
      'upstream_fetch',
      'parse_validate_manifest',
      'raw_persistence',
      'attempt_finalize',
      'lease_lost',
      'worker_shutdown',
      'stale_timeout'
    )
  ),
  reason_code text CHECK (
    reason_code IS NULL
    OR reason_code IN (
      'upstream_blocked',
      'upstream_http_error',
      'upstream_unavailable',
      'pagination_partial',
      'pagination_unknown',
      'population_partial',
      'population_unknown',
      'legacy_unverified',
      'parse_failed',
      'validation_failed',
      'manifest_failed',
      'raw_persistence_failed',
      'attempt_finalize_failed',
      'lease_lost',
      'worker_crash',
      'stale_timeout',
      'unknown_failure'
    )
  ),
  recorded_completed_at timestamptz NOT NULL,
  CONSTRAINT leaderboard_acquisition_capture_clock_shape CHECK (
    (capture_started_at IS NULL AND capture_completed_at IS NULL)
    OR (
      capture_started_at IS NOT NULL
      AND capture_completed_at IS NOT NULL
      AND capture_started_at <= capture_completed_at
    )
  ),
  CONSTRAINT leaderboard_acquisition_source_payload_snapshot_shape CHECK (
    (source_payload_raw_object_id IS NULL)
    = (source_payload_content_hash IS NULL)
    AND (source_payload_raw_object_id IS NULL)
    = (source_payload_storage_path IS NULL)
  ),
  CONSTRAINT leaderboard_acquisition_manifest_snapshot_shape CHECK (
    (manifest_raw_object_id IS NULL) = (manifest_content_hash IS NULL)
    AND (manifest_raw_object_id IS NULL) = (manifest_storage_path IS NULL)
  ),
  CONSTRAINT leaderboard_acquisition_diagnostic_snapshot_shape CHECK (
    (diagnostic_raw_object_id IS NULL) = (diagnostic_content_hash IS NULL)
    AND (diagnostic_raw_object_id IS NULL) = (diagnostic_storage_path IS NULL)
  ),
  CONSTRAINT leaderboard_acquisition_raw_pair_shape CHECK (
    (source_payload_raw_object_id IS NULL) = (manifest_raw_object_id IS NULL)
    AND (
      source_payload_raw_object_id IS NULL
      OR source_payload_raw_object_id <> manifest_raw_object_id
    )
    AND (
      diagnostic_raw_object_id IS NULL
      OR (
        diagnostic_raw_object_id IS DISTINCT FROM source_payload_raw_object_id
        AND diagnostic_raw_object_id IS DISTINCT FROM manifest_raw_object_id
      )
    )
  ),
  CONSTRAINT leaderboard_acquisition_population_count_shape CHECK (
    (
      observed_population IS NULL
      AND deduplicated_row_count IS NULL
    )
    OR (
      observed_population IS NOT NULL
      AND accepted_population IS NOT NULL
      AND rejected_row_count IS NOT NULL
      AND deduplicated_row_count IS NOT NULL
      AND observed_population::bigint
          = accepted_population::bigint
            + rejected_row_count::bigint
            + deduplicated_row_count::bigint
    )
  ),
  CONSTRAINT leaderboard_acquisition_population_report_shape CHECK ((
    (
      population_report_state IS NULL
      AND reported_population IS NULL
    )
    OR (
      population_report_state = 'consistent'
      AND reported_population IS NOT NULL
    )
    OR (
      population_report_state IN ('conflicting', 'unknown')
      AND reported_population IS NULL
    )
  ) IS TRUE),
  CONSTRAINT leaderboard_acquisition_page_report_shape CHECK ((
    (
      page_count_report_state IS NULL
      AND reported_page_count IS NULL
    )
    OR (
      page_count_report_state = 'consistent'
      AND reported_page_count IS NOT NULL
    )
    OR (
      page_count_report_state IN ('conflicting', 'unknown')
      AND reported_page_count IS NULL
    )
  ) IS TRUE),
  CONSTRAINT leaderboard_acquisition_limit_shape CHECK (
    (
      termination_reason IS NULL
      AND NOT caller_limited
      AND NOT safety_limited
    )
    OR (
      termination_reason IS NOT NULL
      AND caller_limited = (termination_reason = 'caller_limit')
      AND safety_limited = (termination_reason = 'safety_limit')
    )
  ),
  CONSTRAINT leaderboard_acquisition_terminal_shape CHECK ((
    (
      terminal_state = 'complete'
      AND acquisition_state = 'complete'
      AND population_state = 'verified'
      AND capture_evidence_state = 'verified'
      AND termination_reason IN (
        'reported_population_reached',
        'reported_page_count_reached',
        'short_page',
        'empty_page',
        'cursor_exhausted',
        'single_snapshot'
      )
      AND capture_started_at IS NOT NULL
      AND source_run_id IS NOT NULL
      AND source_payload_raw_object_id IS NOT NULL
      AND diagnostic_raw_object_id IS NULL
      AND source_page_count IS NOT NULL
      AND source_page_count > 0
      AND population_report_state = 'consistent'
      AND reported_population IS NOT NULL
      AND page_count_report_state IN ('consistent', 'unknown')
      AND (
        termination_reason <> 'reported_page_count_reached'
        OR page_count_report_state = 'consistent'
      )
      AND (
        page_count_report_state <> 'consistent'
        OR termination_reason = 'empty_page'
           AND source_page_count IN (
             reported_page_count,
             reported_page_count + 1
           )
        OR termination_reason <> 'empty_page'
           AND source_page_count = reported_page_count
      )
      AND (termination_reason <> 'single_snapshot' OR source_page_count = 1)
      AND observed_population IS NOT NULL
      AND accepted_population IS NOT NULL
      AND rejected_row_count IS NOT NULL
      AND deduplicated_row_count IS NOT NULL
      AND observed_population = reported_population
      AND accepted_population = reported_population
      AND rejected_row_count = 0
      AND deduplicated_row_count = 0
      AND NOT caller_limited
      AND NOT safety_limited
      AND failure_stage IS NULL
      AND reason_code IS NULL
    )
    OR (
      terminal_state = 'partial'
      AND capture_evidence_state = 'verified'
      AND capture_started_at IS NOT NULL
      AND source_run_id IS NOT NULL
      AND source_payload_raw_object_id IS NOT NULL
      AND diagnostic_raw_object_id IS NULL
      AND source_page_count IS NOT NULL
      AND source_page_count > 0
      AND population_report_state IS NOT NULL
      AND page_count_report_state IS NOT NULL
      AND observed_population IS NOT NULL
      AND accepted_population IS NOT NULL
      AND rejected_row_count IS NOT NULL
      AND deduplicated_row_count IS NOT NULL
      AND (
        (
          acquisition_state = 'partial'
          AND population_state = 'partial'
          AND termination_reason IN ('caller_limit', 'safety_limit')
        )
        OR (
          acquisition_state = 'partial'
          AND population_state = 'unknown'
          AND termination_reason = 'degenerate_page'
        )
        OR (
          acquisition_state = 'complete'
          AND population_state = 'partial'
          AND population_report_state = 'consistent'
          AND page_count_report_state IN ('consistent', 'unknown')
          AND observed_population >= reported_population
          AND NOT (
            accepted_population = reported_population
            AND rejected_row_count = 0
            AND deduplicated_row_count = 0
          )
          AND (
            termination_reason <> 'reported_page_count_reached'
            OR page_count_report_state = 'consistent'
          )
          AND (
            page_count_report_state <> 'consistent'
            OR termination_reason = 'empty_page'
               AND source_page_count IN (
                 reported_page_count,
                 reported_page_count + 1
               )
            OR termination_reason <> 'empty_page'
               AND source_page_count = reported_page_count
          )
          AND (termination_reason <> 'single_snapshot' OR source_page_count = 1)
          AND termination_reason IN (
            'reported_population_reached',
            'reported_page_count_reached',
            'short_page',
            'empty_page',
            'cursor_exhausted',
            'single_snapshot'
          )
        )
      )
      AND reason_code IS NOT NULL
    )
    OR (
      terminal_state = 'unknown'
      AND capture_started_at IS NOT NULL
      AND accepted_population IS NOT NULL
      AND reason_code IS NOT NULL
      AND (
        (
          source_run_id IS NOT NULL
          AND source_payload_raw_object_id IS NOT NULL
          AND diagnostic_raw_object_id IS NULL
          AND source_page_count IS NOT NULL
          AND population_report_state IS NOT NULL
          AND page_count_report_state IS NOT NULL
          AND observed_population IS NOT NULL
          AND rejected_row_count IS NOT NULL
          AND deduplicated_row_count IS NOT NULL
          AND (
            (
              capture_evidence_state = 'unavailable'
              AND termination_reason = 'unknown'
              AND acquisition_state = 'unknown'
              AND population_state = 'unknown'
              AND source_page_count = 0
              AND population_report_state = 'unknown'
              AND page_count_report_state = 'unknown'
              AND observed_population = 0
              AND accepted_population = 0
              AND rejected_row_count = 0
              AND deduplicated_row_count = 0
            )
            OR (
              capture_evidence_state = 'verified'
              AND termination_reason IN (
                'reported_population_reached',
                'reported_page_count_reached',
                'short_page',
                'empty_page',
                'cursor_exhausted',
                'single_snapshot',
                'upstream_error',
                'unknown'
              )
              AND acquisition_state = 'unknown'
              AND population_state = 'unknown'
              AND source_page_count > 0
            )
            OR (
              capture_evidence_state = 'verified'
              AND termination_reason IN (
                'reported_population_reached',
                'reported_page_count_reached',
                'short_page',
                'empty_page',
                'cursor_exhausted',
                'single_snapshot'
              )
              AND acquisition_state = 'complete'
              AND population_state = 'unknown'
              AND population_report_state = 'unknown'
              AND page_count_report_state IN ('consistent', 'unknown')
              AND termination_reason <> 'reported_population_reached'
              AND (
                termination_reason <> 'reported_page_count_reached'
                OR page_count_report_state = 'consistent'
              )
              AND (
                page_count_report_state <> 'consistent'
                OR termination_reason = 'empty_page'
                   AND source_page_count IN (
                     reported_page_count,
                     reported_page_count + 1
                   )
                OR termination_reason <> 'empty_page'
                   AND source_page_count = reported_page_count
              )
              AND (termination_reason <> 'single_snapshot' OR source_page_count = 1)
              AND source_page_count > 0
            )
          )
        )
        OR (
          source_run_id IS NULL
          AND source_payload_raw_object_id IS NULL
          AND diagnostic_raw_object_id IS NOT NULL
          AND capture_evidence_state = 'legacy_unverified'
          AND termination_reason IS NULL
          AND acquisition_state = 'unknown'
          AND population_state = 'unknown'
          AND source_page_count IS NULL
          AND population_report_state IS NULL
          AND page_count_report_state IS NULL
          AND observed_population IS NULL
          AND accepted_population IS NOT NULL
          AND rejected_row_count IS NOT NULL
          AND deduplicated_row_count IS NULL
          AND NOT caller_limited
          AND NOT safety_limited
          AND reason_code = 'legacy_unverified'
        )
      )
    )
    OR (
      terminal_state = 'processing_failed'
      AND acquisition_state = 'unknown'
      AND population_state = 'unknown'
      AND capture_evidence_state = 'unassessed'
      AND termination_reason IS NULL
      AND source_run_id IS NULL
      AND source_payload_raw_object_id IS NULL
      AND source_page_count IS NULL
      AND population_report_state IS NULL
      AND page_count_report_state IS NULL
      AND observed_population IS NULL
      AND accepted_population IS NULL
      AND rejected_row_count IS NULL
      AND deduplicated_row_count IS NULL
      AND NOT caller_limited
      AND NOT safety_limited
      AND failure_stage IS NOT NULL
      AND reason_code IS NOT NULL
    )
    OR (
      terminal_state = 'abandoned'
      AND acquisition_state = 'unknown'
      AND population_state = 'unknown'
      AND capture_evidence_state = 'unassessed'
      AND termination_reason IS NULL
      AND source_run_id IS NULL
      AND source_payload_raw_object_id IS NULL
      AND source_page_count IS NULL
      AND population_report_state IS NULL
      AND page_count_report_state IS NULL
      AND observed_population IS NULL
      AND accepted_population IS NULL
      AND rejected_row_count IS NULL
      AND deduplicated_row_count IS NULL
      AND NOT caller_limited
      AND NOT safety_limited
      AND failure_stage IS NOT NULL
      AND reason_code IS NOT NULL
      AND failure_stage IN ('lease_lost', 'worker_shutdown', 'stale_timeout')
      AND reason_code IN ('lease_lost', 'worker_crash', 'stale_timeout')
    )
  ) IS TRUE)
);

CREATE UNIQUE INDEX uidx_leaderboard_acquisition_outcomes_source_run
  ON arena.leaderboard_acquisition_outcomes (source_run_id)
  WHERE source_run_id IS NOT NULL;

CREATE UNIQUE INDEX uidx_leaderboard_acquisition_outcomes_source_payload
  ON arena.leaderboard_acquisition_outcomes (source_payload_raw_object_id)
  WHERE source_payload_raw_object_id IS NOT NULL;

CREATE UNIQUE INDEX uidx_leaderboard_acquisition_outcomes_manifest
  ON arena.leaderboard_acquisition_outcomes (manifest_raw_object_id)
  WHERE manifest_raw_object_id IS NOT NULL;

CREATE UNIQUE INDEX uidx_leaderboard_acquisition_outcomes_diagnostic
  ON arena.leaderboard_acquisition_outcomes (diagnostic_raw_object_id)
  WHERE diagnostic_raw_object_id IS NOT NULL;

CREATE FUNCTION arena.reject_direct_leaderboard_acquisition_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_path text := pg_catalog.current_setting(
    'arena.leaderboard_acquisition_mutation_path',
    true
  );
BEGIN
  IF TG_OP = 'INSERT'
     AND (
       (TG_TABLE_NAME = 'leaderboard_acquisition_attempts'
        AND v_path = 'start_leaderboard_acquisition_attempt')
       OR
       (TG_TABLE_NAME = 'leaderboard_acquisition_outcomes'
        AND v_path = 'finish_leaderboard_acquisition_attempt')
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'leaderboard acquisition ledger is append-only and RPC-owned (% %)',
    TG_OP,
    TG_TABLE_NAME
    USING ERRCODE = '42501';
END
$function$;

CREATE TRIGGER leaderboard_acquisition_attempts_reject_direct_row_mutation
BEFORE INSERT OR UPDATE OR DELETE ON arena.leaderboard_acquisition_attempts
FOR EACH ROW EXECUTE FUNCTION arena.reject_direct_leaderboard_acquisition_mutation();

CREATE TRIGGER leaderboard_acquisition_attempts_reject_truncate
BEFORE TRUNCATE ON arena.leaderboard_acquisition_attempts
FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_direct_leaderboard_acquisition_mutation();

CREATE TRIGGER leaderboard_acquisition_outcomes_reject_direct_row_mutation
BEFORE INSERT OR UPDATE OR DELETE ON arena.leaderboard_acquisition_outcomes
FOR EACH ROW EXECUTE FUNCTION arena.reject_direct_leaderboard_acquisition_mutation();

CREATE TRIGGER leaderboard_acquisition_outcomes_reject_truncate
BEFORE TRUNCATE ON arena.leaderboard_acquisition_outcomes
FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_direct_leaderboard_acquisition_mutation();

CREATE FUNCTION arena.reject_leaderboard_capture_contract_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION
    'leaderboard capture contracts are append-only (% %)',
    TG_OP,
    TG_TABLE_NAME
    USING ERRCODE = '42501';
END
$function$;

CREATE TRIGGER leaderboard_capture_contracts_reject_row_mutation
BEFORE UPDATE OR DELETE ON arena.leaderboard_capture_contracts
FOR EACH ROW EXECUTE FUNCTION arena.reject_leaderboard_capture_contract_mutation();

CREATE TRIGGER leaderboard_capture_contracts_reject_truncate
BEFORE TRUNCATE ON arena.leaderboard_capture_contracts
FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_leaderboard_capture_contract_mutation();

-- Once finish has copied the immutable pointer identity, evidence metadata may
-- not change underneath the ledger. Deletion remains allowed for the normal
-- RAW retention flow because outcome rows intentionally carry no RAW FK.
CREATE FUNCTION arena.protect_leaderboard_acquisition_raw_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM arena.leaderboard_acquisition_outcomes AS outcome
     WHERE outcome.source_payload_raw_object_id = OLD.id
        OR outcome.manifest_raw_object_id = OLD.id
        OR outcome.diagnostic_raw_object_id = OLD.id
  ) AND TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.job_type IS DISTINCT FROM OLD.job_type
    OR NEW.trader_id IS DISTINCT FROM OLD.trader_id
    OR NEW.timeframe IS DISTINCT FROM OLD.timeframe
    OR NEW.fetched_at IS DISTINCT FROM OLD.fetched_at
    OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
    OR NEW.bytes IS DISTINCT FROM OLD.bytes
    OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
    OR NEW.source_run_id IS DISTINCT FROM OLD.source_run_id
    OR NEW.trust_artifact_role IS DISTINCT FROM OLD.trust_artifact_role
    OR NEW.meta IS DISTINCT FROM OLD.meta
    OR (
      NEW.quarantined IS DISTINCT FROM OLD.quarantined
      AND NOT (NOT OLD.quarantined AND NEW.quarantined)
    )
  ) THEN
    RAISE EXCEPTION 'leaderboard acquisition RAW evidence % cannot be mutated', OLD.id
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER protect_leaderboard_acquisition_raw_evidence_before_write
BEFORE UPDATE OR DELETE ON arena.raw_objects
FOR EACH ROW EXECUTE FUNCTION arena.protect_leaderboard_acquisition_raw_evidence();

CREATE FUNCTION arena.start_leaderboard_acquisition_attempt(
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

CREATE FUNCTION arena.finish_leaderboard_acquisition_attempt(
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
       v_attempt.capture_contract
         = 'arena.ingest.leaderboard-acquisition-manifest@2'
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
    IF v_attempt.capture_contract
       <> 'arena.ingest.leaderboard-acquisition-manifest@2'
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
     AND v_attempt.capture_contract
         <> 'arena.ingest.leaderboard-acquisition-manifest@2' THEN
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

CREATE VIEW arena.leaderboard_acquisition_attempt_states
WITH (security_invoker = true)
AS
SELECT
  attempt.attempt_seq,
  attempt.attempt_id,
  attempt.source_id,
  attempt.source_slug,
  attempt.adapter_slug,
  attempt.timeframe,
  attempt.observation_cycle_id,
  attempt.queue_job_id,
  attempt.queue_attempt,
  attempt.capture_contract,
  attempt.attempt_binding_contract,
  attempt.runner_git_sha,
  attempt.worker_region,
  attempt.source_status,
  attempt.source_serving_mode,
  attempt.source_currency,
  attempt.source_fetch_region,
  attempt.recorded_started_at,
  COALESCE(outcome.terminal_state, 'in_progress') AS terminal_state,
  CASE
    WHEN outcome.attempt_seq IS NULL THEN 'started'
    WHEN outcome.terminal_state = 'complete' THEN 'succeeded'
    WHEN outcome.terminal_state = 'partial' THEN 'partial'
    WHEN outcome.terminal_state = 'unknown' THEN 'unknown'
    ELSE 'failed'
  END AS attempt_status,
  CASE
    WHEN outcome.terminal_state = 'complete' THEN 'complete'
    WHEN outcome.terminal_state = 'partial' THEN 'partial'
    ELSE 'unknown'
  END AS data_state,
  outcome.acquisition_state,
  outcome.population_state,
  outcome.capture_evidence_state,
  outcome.termination_reason,
  outcome.capture_started_at,
  outcome.capture_completed_at,
  outcome.source_run_id,
  outcome.source_payload_raw_object_id,
  outcome.source_payload_content_hash,
  outcome.source_payload_storage_path,
  outcome.manifest_raw_object_id,
  outcome.manifest_content_hash,
  outcome.manifest_storage_path,
  outcome.diagnostic_raw_object_id,
  outcome.diagnostic_content_hash,
  outcome.diagnostic_storage_path,
  outcome.reported_population,
  outcome.population_report_state,
  outcome.source_page_count,
  outcome.reported_page_count,
  outcome.page_count_report_state,
  outcome.observed_population,
  outcome.accepted_population,
  outcome.rejected_row_count,
  outcome.deduplicated_row_count,
  outcome.caller_limited,
  outcome.safety_limited,
  outcome.failure_stage,
  outcome.reason_code,
  outcome.recorded_completed_at,
  outcome.terminal_state = 'complete' AS acquisition_evidence_complete
FROM arena.leaderboard_acquisition_attempts AS attempt
LEFT JOIN arena.leaderboard_acquisition_outcomes AS outcome
  ON outcome.attempt_seq = attempt.attempt_seq;

CREATE VIEW arena.latest_leaderboard_acquisition_attempts
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (state.source_id, state.timeframe)
  state.*
FROM arena.leaderboard_acquisition_attempt_states AS state
ORDER BY state.source_id, state.timeframe, state.attempt_seq DESC;

-- Serving candidates consume the latest terminal evidence, not a mere start.
-- A crawl in progress does not invalidate still-fresh prior evidence. Once the
-- newer attempt reaches any terminal state, attempt_seq makes that verdict
-- authoritative over every earlier success regardless of finish order.
CREATE VIEW arena.latest_terminal_leaderboard_acquisitions
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (state.source_id, state.timeframe)
  state.*
FROM arena.leaderboard_acquisition_attempt_states AS state
WHERE state.recorded_completed_at IS NOT NULL
ORDER BY state.source_id, state.timeframe, state.attempt_seq DESC;

COMMENT ON TABLE arena.leaderboard_acquisition_attempts IS
  'Append-only Tier-A begin ledger. attempt_seq, not clocks or completion order, fences the latest source/window attempt.';
COMMENT ON COLUMN arena.leaderboard_acquisition_attempts.attempt_id IS
  'Caller UUID used only for exact begin/finish replay after an uncertain commit.';
COMMENT ON COLUMN arena.leaderboard_acquisition_attempts.observation_cycle_id IS
  'Non-unique scheduler-cycle correlation; physical BullMQ retries remain separate attempts.';
COMMENT ON TABLE arena.leaderboard_acquisition_outcomes IS
  'One append-only acquisition terminal per attempt. RAW id/hash/path are audit evidence; there is intentionally no RAW foreign key.';
COMMENT ON VIEW arena.leaderboard_acquisition_attempt_states IS
  'Private shadow state. complete means acquisition evidence is complete, not that any public rank is authorized.';
COMMENT ON VIEW arena.latest_leaderboard_acquisition_attempts IS
  'Private run-state view ordered only by DB attempt_seq; includes the newest in-progress physical attempt.';
COMMENT ON VIEW arena.latest_terminal_leaderboard_acquisitions IS
  'Private evidence fence: the greatest terminal attempt_seq wins. A started crawl does not invalidate prior fresh evidence; any newer terminal verdict does.';

ALTER TABLE arena.leaderboard_acquisition_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.leaderboard_acquisition_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE arena.leaderboard_acquisition_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.leaderboard_acquisition_outcomes FORCE ROW LEVEL SECURITY;
ALTER TABLE arena.leaderboard_capture_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.leaderboard_capture_contracts FORCE ROW LEVEL SECURITY;

CREATE POLICY leaderboard_acquisition_attempts_service_read
  ON arena.leaderboard_acquisition_attempts
  FOR SELECT TO service_role
  USING (true);

CREATE POLICY leaderboard_acquisition_outcomes_service_read
  ON arena.leaderboard_acquisition_outcomes
  FOR SELECT TO service_role
  USING (true);

CREATE POLICY leaderboard_capture_contracts_service_read
  ON arena.leaderboard_capture_contracts
  FOR SELECT TO service_role
  USING (true);

REVOKE ALL ON TABLE arena.leaderboard_capture_contracts
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE arena.leaderboard_acquisition_attempts
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE arena.leaderboard_acquisition_outcomes
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE arena.leaderboard_acquisition_attempt_states
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE arena.latest_leaderboard_acquisition_attempts
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE arena.latest_terminal_leaderboard_acquisitions
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE arena.leaderboard_acquisition_attempts_attempt_seq_seq
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.start_leaderboard_acquisition_attempt(
  uuid, integer, integer, text, text, integer, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.finish_leaderboard_acquisition_attempt(
  uuid, text, text, text, text, text, timestamptz, timestamptz, text,
  bigint, bigint, bigint, integer, text, integer, integer, text,
  integer, integer, integer, integer, boolean, boolean, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.reject_direct_leaderboard_acquisition_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.reject_leaderboard_capture_contract_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.protect_leaderboard_acquisition_raw_evidence()
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE arena.leaderboard_capture_contracts TO service_role;
GRANT SELECT ON TABLE arena.leaderboard_acquisition_attempts TO service_role;
GRANT SELECT ON TABLE arena.leaderboard_acquisition_outcomes TO service_role;
GRANT SELECT ON TABLE arena.leaderboard_acquisition_attempt_states TO service_role;
GRANT SELECT ON TABLE arena.latest_leaderboard_acquisition_attempts TO service_role;
GRANT SELECT ON TABLE arena.latest_terminal_leaderboard_acquisitions TO service_role;
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
  v_start regprocedure := pg_catalog.to_regprocedure(
    'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'
  );
  v_finish regprocedure := pg_catalog.to_regprocedure(
    'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)'
  );
BEGIN
  IF v_start IS NULL OR v_finish IS NULL THEN
    RAISE EXCEPTION 'leaderboard acquisition RPCs are missing';
  END IF;

  IF (SELECT pg_catalog.count(*)
        FROM arena.leaderboard_capture_contracts) <> 1 THEN
    RAISE EXCEPTION 'expected one initial reviewed leaderboard capture contract';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
       'service_role',
       'arena.leaderboard_acquisition_attempts',
       'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'service_role',
       'arena.leaderboard_acquisition_attempts',
       'INSERT,UPDATE,DELETE,TRUNCATE'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role',
       'arena.leaderboard_acquisition_outcomes',
       'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role',
       'arena.leaderboard_capture_contracts',
       'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'service_role',
       'arena.leaderboard_capture_contracts',
       'INSERT,UPDATE,DELETE,TRUNCATE'
     )
     OR pg_catalog.has_table_privilege(
       'service_role',
       'arena.leaderboard_acquisition_outcomes',
       'INSERT,UPDATE,DELETE,TRUNCATE'
     ) THEN
    RAISE EXCEPTION 'leaderboard acquisition table privileges are unsafe';
  END IF;

  IF pg_catalog.has_table_privilege(
       'anon',
       'arena.leaderboard_acquisition_attempts',
       'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'anon',
       'arena.leaderboard_capture_contracts',
       'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated',
       'arena.leaderboard_acquisition_outcomes',
       'SELECT'
     )
     OR pg_catalog.has_function_privilege('anon', v_start, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_finish, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_start, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_finish, 'EXECUTE') THEN
    RAISE EXCEPTION 'leaderboard acquisition RPC privileges are unsafe';
  END IF;

  IF pg_catalog.has_sequence_privilege(
       'service_role',
       'arena.leaderboard_acquisition_attempts_attempt_seq_seq',
       'USAGE'
     )
     OR pg_catalog.has_sequence_privilege(
       'service_role',
       'arena.leaderboard_acquisition_attempts_attempt_seq_seq',
       'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role',
       'arena.latest_terminal_leaderboard_acquisitions',
       'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'anon',
       'arena.latest_terminal_leaderboard_acquisitions',
       'SELECT'
     ) THEN
    RAISE EXCEPTION 'leaderboard acquisition read/sequence privileges are unsafe';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
