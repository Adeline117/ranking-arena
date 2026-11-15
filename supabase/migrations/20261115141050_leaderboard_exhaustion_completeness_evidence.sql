-- Migration: 20261115141050_leaderboard_exhaustion_completeness_evidence.sql
-- Created: 2026-11-15T22:10:50Z
-- Description: Second completeness mode for attempt-bound leaderboard
--   evidence: "exhausted" (lib/ingest/acquisition-exhaustion.ts).
--
-- Until now an acquisition could finish 'complete' only when the upstream
-- reported a population equal to the accepted rows. Many boards report no
-- total and signal their end by exhaustion (a continuation flag, a reported
-- page count, or a short final page), sometimes with a board version token.
-- This migration lets such a board be complete, and attempt-bound trusted,
-- only under a proof as strict as the total mode:
--
-- * arena.leaderboard_exhaustion_contracts: the reviewed per-source capture
--   contract (append-only). It declares the completeness mode, the row-array
--   and row-key paths, the exact end-signal path, the board-version check and
--   the tolerated cross-page duplicates. Empty here; each source is
--   registered by its own reviewed migration.
-- * arena.leaderboard_exhaustion_completeness_holds(...): the DB check of the
--   manifest's completeness block (carried in the manifest RAW meta,
--   meta.acquisition_attempt.completeness, immutable once an outcome binds it):
--   declaration = registered contract; one page entry per source page,
--   ordinals contiguous from one, well-formed request/response/row-key
--   hashes, row counts summing to the observed population; the end signal
--   says "more" on every page but the last and "end" on the last; duplicate
--   row keys = observed - distinct, within the allowance, distinct = accepted
--   rows, zero rejected rows; one version token on every page, or page one
--   re-read with identical row keys.
-- * arena.leaderboard_acquisition_outcomes: termination reason
--   'end_signal_reached'; the terminal-shape CHECK gains an exhausted
--   'complete' branch (no reported population, observed = accepted +
--   deduplicated), and a BEFORE INSERT trigger refuses any 'complete' outcome
--   without a consistent reported population unless the check above holds.
-- * public.rank_publication_trust_evidence (20261114193017) re-checks it:
--   a complete outcome binds a board only with a consistent reported
--   population or holding exhaustion evidence.
-- * arena.validate_metric_trust_attempt_outcome_authority (20260722050000)
--   accepts an exhausted outcome (reported population NULL, observed =
--   fetched + deduplicated) only when the same check holds.
--
-- PREDEPLOY, after 20261114193017. Inert until a source is registered: with
-- the registry empty no outcome can take the new branch, and every existing
-- outcome satisfies the rewritten constraints. The deployed worker never
-- produces 'end_signal_reached' or a completeness block.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
DECLARE
  v_terminal_def text;
  v_reason_defs text[];
  v_validator_src text;
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_attempts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_outcomes') IS NULL
     OR pg_catalog.to_regclass('arena.latest_terminal_leaderboard_acquisitions') IS NULL
     OR pg_catalog.to_regprocedure('public.rank_publication_trust_evidence(bigint[])') IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.validate_metric_trust_attempt_outcome_authority()'
     ) IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'arena.sources'::pg_catalog.regclass
          AND attribute.attname = 'page_size'
          AND NOT attribute.attisdropped
     ) THEN
    RAISE EXCEPTION 'exhaustion completeness requires the acquisition ledger, metric-trust authority (20260722050000) and attempt-bound publication evidence (20261114193017)';
  END IF;

  IF pg_catalog.to_regclass('arena.leaderboard_exhaustion_contracts') IS NOT NULL THEN
    RAISE EXCEPTION 'exhaustion completeness evidence already exists';
  END IF;

  -- The constraints and the validator are rewritten from their exact
  -- reviewed definitions; any drift stops the migration.
  SELECT pg_catalog.pg_get_constraintdef(constraint_row.oid, false)
    INTO STRICT v_terminal_def
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = 'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
     AND constraint_row.conname = 'leaderboard_acquisition_terminal_shape'
     AND constraint_row.contype = 'c';
  SELECT pg_catalog.array_agg(pg_catalog.pg_get_constraintdef(constraint_row.oid, false))
    INTO v_reason_defs
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = 'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
     AND constraint_row.conname = 'leaderboard_acquisition_outcomes_termination_reason_check'
     AND constraint_row.contype = 'c';
  SELECT function_row.prosrc
    INTO STRICT v_validator_src
    FROM pg_catalog.pg_proc AS function_row
   WHERE function_row.oid =
         'arena.validate_metric_trust_attempt_outcome_authority()'::pg_catalog.regprocedure;

  IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_terminal_def, 'UTF8')), 'hex')
       IS DISTINCT FROM 'ca906c1b1555528791a65d3872f9543e288ccc5555dd4b1be1dfabd1bd17eed7'
     OR pg_catalog.cardinality(v_reason_defs) IS DISTINCT FROM 1
     OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_reason_defs[1], 'UTF8')), 'hex')
       IS DISTINCT FROM '01700df4bde40a8135dc9cb5e183a20f7ed6a5ff08b488c289b0786cb42029f8'
     OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_validator_src, 'UTF8')), 'hex')
       IS DISTINCT FROM '63565ea00912b9ba4660aa23c4772f8d19100f1507246405631f378fe36880af' THEN
    RAISE EXCEPTION 'acquisition outcome constraints or metric-trust outcome authority drifted from 20260722030000/20260722050000';
  END IF;
END
$preflight$;

-- ── Declaration shape (mirrors leaderboardExhaustionDeclarationSchema) ──

CREATE FUNCTION arena.leaderboard_exhaustion_path_valid(p_path jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(
    pg_catalog.jsonb_typeof(p_path) = 'array'
    AND pg_catalog.jsonb_array_length(p_path) BETWEEN 1 AND 8
    AND NOT EXISTS (
      SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_path) AS segment(value)
       WHERE pg_catalog.jsonb_typeof(segment.value) IS DISTINCT FROM 'string'
          OR pg_catalog.length(segment.value #>> '{}') NOT BETWEEN 1 AND 128
          OR pg_catalog.btrim(segment.value #>> '{}') IS DISTINCT FROM segment.value #>> '{}'
    ),
    false
  )
$function$;

CREATE FUNCTION arena.leaderboard_exhaustion_scalar_valid(p_value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(
    CASE pg_catalog.jsonb_typeof(p_value)
      WHEN 'string' THEN pg_catalog.length(p_value #>> '{}') <= 256
      WHEN 'number' THEN (p_value #>> '{}') ~ '^-?(0|[1-9][0-9]{0,15})$'
      WHEN 'boolean' THEN true
      WHEN 'null' THEN true
      ELSE false
    END,
    false
  )
$function$;

CREATE FUNCTION arena.leaderboard_exhaustion_sha256_valid(p_value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(
    pg_catalog.jsonb_typeof(p_value) = 'string'
    AND (p_value #>> '{}') ~ '^[0-9a-f]{64}$'
    AND (p_value #>> '{}') <> pg_catalog.repeat('0', 64),
    false
  )
$function$;

CREATE FUNCTION arena.leaderboard_exhaustion_count_valid(p_value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(
    pg_catalog.jsonb_typeof(p_value) = 'number'
    AND (p_value #>> '{}') ~ '^(0|[1-9][0-9]{0,8})$',
    false
  )
$function$;

CREATE FUNCTION arena.leaderboard_exhaustion_keys(p_object jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT CASE
    WHEN pg_catalog.jsonb_typeof(p_object) = 'object' THEN (
      SELECT COALESCE(pg_catalog.array_agg(key ORDER BY key), '{}')
        FROM pg_catalog.jsonb_object_keys(p_object) AS key
    )
  END
$function$;

CREATE FUNCTION arena.leaderboard_exhaustion_declaration_valid(p_declaration jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(
    arena.leaderboard_exhaustion_keys(p_declaration) = ARRAY[
      'board_version', 'completeness_mode', 'end_signal', 'list_path',
      'max_duplicate_rows', 'row_key_path'
    ]
    AND p_declaration->>'completeness_mode' = 'exhausted'
    AND pg_catalog.jsonb_typeof(p_declaration->'completeness_mode') = 'string'
    AND arena.leaderboard_exhaustion_path_valid(p_declaration->'list_path')
    AND arena.leaderboard_exhaustion_path_valid(p_declaration->'row_key_path')
    AND arena.leaderboard_exhaustion_count_valid(p_declaration->'max_duplicate_rows')
    AND CASE p_declaration->'end_signal'->>'kind'
      WHEN 'flag' THEN
        arena.leaderboard_exhaustion_keys(p_declaration->'end_signal') =
          ARRAY['end_values', 'kind', 'path']
        AND arena.leaderboard_exhaustion_path_valid(p_declaration->'end_signal'->'path')
        AND pg_catalog.jsonb_typeof(p_declaration->'end_signal'->'end_values') = 'array'
        AND pg_catalog.jsonb_array_length(p_declaration->'end_signal'->'end_values')
            BETWEEN 1 AND 8
        AND NOT EXISTS (
          SELECT 1
            FROM pg_catalog.jsonb_array_elements(
              p_declaration->'end_signal'->'end_values'
            ) AS end_value(value)
           WHERE NOT arena.leaderboard_exhaustion_scalar_valid(end_value.value)
        )
      WHEN 'page_count' THEN
        arena.leaderboard_exhaustion_keys(p_declaration->'end_signal') = ARRAY['kind', 'path']
        AND arena.leaderboard_exhaustion_path_valid(p_declaration->'end_signal'->'path')
      WHEN 'short_page' THEN
        arena.leaderboard_exhaustion_keys(p_declaration->'end_signal') = ARRAY['kind']
      ELSE false
    END
    AND CASE p_declaration->'board_version'->>'kind'
      WHEN 'token' THEN
        arena.leaderboard_exhaustion_keys(p_declaration->'board_version') = ARRAY['kind', 'path']
        AND arena.leaderboard_exhaustion_path_valid(p_declaration->'board_version'->'path')
      WHEN 'first_page_reread' THEN
        arena.leaderboard_exhaustion_keys(p_declaration->'board_version') = ARRAY['kind']
      ELSE false
    END,
    false
  )
$function$;

-- ── Per-source capture contract (append-only) ──

CREATE TABLE arena.leaderboard_exhaustion_contracts (
  source_id smallint PRIMARY KEY REFERENCES arena.sources(id) ON DELETE RESTRICT,
  completeness_contract text NOT NULL CHECK (
    completeness_contract = 'arena.ingest.leaderboard-exhaustion-completeness@1'
  ),
  declaration jsonb NOT NULL CHECK (
    arena.leaderboard_exhaustion_declaration_valid(declaration)
  ),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

COMMENT ON TABLE arena.leaderboard_exhaustion_contracts IS
  'Reviewed exhausted-completeness capture contract per source (lib/ingest/acquisition-exhaustion.ts). Append-only; one reviewed migration per source.';

CREATE FUNCTION arena.reject_leaderboard_exhaustion_contract_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'leaderboard exhaustion contracts are append-only'
    USING ERRCODE = '42501';
END
$function$;

CREATE TRIGGER leaderboard_exhaustion_contracts_append_only
  BEFORE UPDATE OR DELETE ON arena.leaderboard_exhaustion_contracts
  FOR EACH ROW EXECUTE FUNCTION arena.reject_leaderboard_exhaustion_contract_mutation();
CREATE TRIGGER leaderboard_exhaustion_contracts_no_truncate
  BEFORE TRUNCATE ON arena.leaderboard_exhaustion_contracts
  FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_leaderboard_exhaustion_contract_mutation();

ALTER TABLE arena.leaderboard_exhaustion_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.leaderboard_exhaustion_contracts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE arena.leaderboard_exhaustion_contracts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE arena.leaderboard_exhaustion_contracts TO service_role;
CREATE POLICY leaderboard_exhaustion_contracts_service_read
  ON arena.leaderboard_exhaustion_contracts
  FOR SELECT TO service_role USING (true);

-- ── The completeness check (mirrors exhaustionCompletenessHolds) ──

CREATE FUNCTION arena.leaderboard_exhaustion_completeness_holds(
  p_source_id smallint,
  p_completeness jsonb,
  p_termination_reason text,
  p_source_page_count integer,
  p_population_report_state text,
  p_observed_population integer,
  p_accepted_population integer,
  p_rejected_row_count integer,
  p_deduplicated_row_count integer
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_declaration jsonb;
  v_page_size integer;
  v_pages jsonb;
  v_page_count integer;
  v_last jsonb;
  v_rows jsonb;
  v_board_version jsonb;
  v_reread jsonb;
  v_end_values jsonb;
BEGIN
  IF arena.leaderboard_exhaustion_keys(p_completeness) IS DISTINCT FROM ARRAY[
       'board_version', 'data_contract', 'declaration', 'pages', 'row_keys'
     ]
     OR p_completeness->>'data_contract' IS DISTINCT FROM
        'arena.ingest.leaderboard-exhaustion-completeness@1' THEN
    RETURN false;
  END IF;

  SELECT contract.declaration, source_row.page_size
    INTO v_declaration, v_page_size
    FROM arena.leaderboard_exhaustion_contracts AS contract
    JOIN arena.sources AS source_row ON source_row.id = contract.source_id
   WHERE contract.source_id = p_source_id;
  IF NOT FOUND OR p_completeness->'declaration' IS DISTINCT FROM v_declaration THEN
    RETURN false;
  END IF;

  -- Outcome facts: no reported total, nothing rejected, a non-empty board.
  IF p_population_report_state IS DISTINCT FROM 'unknown'
     OR p_rejected_row_count IS DISTINCT FROM 0
     OR p_accepted_population IS NULL
     OR p_accepted_population < 1
     OR p_observed_population IS NULL
     OR p_deduplicated_row_count IS NULL THEN
    RETURN false;
  END IF;

  -- One entry per source page, contiguous from one.
  v_pages := p_completeness->'pages';
  IF pg_catalog.jsonb_typeof(v_pages) IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  v_page_count := pg_catalog.jsonb_array_length(v_pages);
  IF v_page_count < 1 OR v_page_count IS DISTINCT FROM p_source_page_count THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_pages) WITH ORDINALITY AS page(value, ordinal)
     WHERE arena.leaderboard_exhaustion_keys(page.value) IS DISTINCT FROM ARRAY[
             'end_signal_value', 'ordinal', 'request_sha256', 'response_sha256',
             'row_count', 'row_keys_sha256', 'version_token_sha256'
           ]
        OR pg_catalog.jsonb_typeof(page.value->'ordinal') IS DISTINCT FROM 'number'
        OR page.value->>'ordinal' IS DISTINCT FROM page.ordinal::text
        OR NOT arena.leaderboard_exhaustion_sha256_valid(page.value->'request_sha256')
        OR NOT arena.leaderboard_exhaustion_sha256_valid(page.value->'response_sha256')
        OR NOT arena.leaderboard_exhaustion_sha256_valid(page.value->'row_keys_sha256')
        OR NOT arena.leaderboard_exhaustion_count_valid(page.value->'row_count')
        OR NOT arena.leaderboard_exhaustion_scalar_valid(page.value->'end_signal_value')
  ) THEN
    RETURN false;
  END IF;
  IF (
    SELECT pg_catalog.sum((page.value->>'row_count')::bigint)
      FROM pg_catalog.jsonb_array_elements(v_pages) AS page(value)
  ) IS DISTINCT FROM p_observed_population::numeric THEN
    RETURN false;
  END IF;
  v_last := v_pages->(v_page_count - 1);

  -- Cross-page row identity.
  v_rows := p_completeness->'row_keys';
  IF arena.leaderboard_exhaustion_keys(v_rows) IS DISTINCT FROM
       ARRAY['distinct', 'duplicate', 'observed']
     OR NOT arena.leaderboard_exhaustion_count_valid(v_rows->'observed')
     OR NOT arena.leaderboard_exhaustion_count_valid(v_rows->'distinct')
     OR NOT arena.leaderboard_exhaustion_count_valid(v_rows->'duplicate')
     OR (v_rows->>'observed')::integer IS DISTINCT FROM p_observed_population
     OR (v_rows->>'distinct')::integer IS DISTINCT FROM p_accepted_population
     OR (v_rows->>'duplicate')::integer IS DISTINCT FROM
        (v_rows->>'observed')::integer - (v_rows->>'distinct')::integer
     OR (v_rows->>'duplicate')::integer IS DISTINCT FROM p_deduplicated_row_count
     OR (v_rows->>'duplicate')::integer > (v_declaration->>'max_duplicate_rows')::integer THEN
    RETURN false;
  END IF;

  -- The declared end signal: "more" on every page but the last, "end" on the last.
  CASE v_declaration->'end_signal'->>'kind'
    WHEN 'flag' THEN
      v_end_values := v_declaration->'end_signal'->'end_values';
      IF NOT (v_end_values @> pg_catalog.jsonb_build_array(v_last->'end_signal_value'))
         OR EXISTS (
           SELECT 1
             FROM pg_catalog.jsonb_array_elements(v_pages) WITH ORDINALITY AS page(value, ordinal)
            WHERE page.ordinal < v_page_count
              AND v_end_values @> pg_catalog.jsonb_build_array(page.value->'end_signal_value')
         )
         OR NOT (
           (p_termination_reason = 'end_signal_reached' AND (v_last->>'row_count')::integer > 0)
           OR (p_termination_reason = 'empty_page' AND (v_last->>'row_count')::integer = 0)
         ) THEN
        RETURN false;
      END IF;
    WHEN 'page_count' THEN
      IF p_termination_reason IS DISTINCT FROM 'end_signal_reached'
         OR (v_last->>'row_count')::integer < 1
         OR EXISTS (
           SELECT 1
             FROM pg_catalog.jsonb_array_elements(v_pages) AS page(value)
            WHERE page.value->'end_signal_value' IS DISTINCT FROM pg_catalog.to_jsonb(v_page_count)
         ) THEN
        RETURN false;
      END IF;
    WHEN 'short_page' THEN
      IF v_page_size IS NULL
         OR EXISTS (
           SELECT 1
             FROM pg_catalog.jsonb_array_elements(v_pages) WITH ORDINALITY AS page(value, ordinal)
            WHERE page.value->'end_signal_value' IS DISTINCT FROM 'null'::jsonb
               OR (
                 page.ordinal < v_page_count
                 AND (page.value->>'row_count')::integer IS DISTINCT FROM v_page_size
               )
         )
         OR NOT (
           (
             p_termination_reason = 'short_page'
             AND (v_last->>'row_count')::integer BETWEEN 1 AND v_page_size - 1
           )
           OR (p_termination_reason = 'empty_page' AND (v_last->>'row_count')::integer = 0)
         ) THEN
        RETURN false;
      END IF;
    ELSE
      RETURN false;
  END CASE;

  -- Board stability.
  v_board_version := p_completeness->'board_version';
  CASE v_declaration->'board_version'->>'kind'
    WHEN 'token' THEN
      IF v_board_version IS DISTINCT FROM '{"kind": "token"}'::jsonb
         OR EXISTS (
           SELECT 1
             FROM pg_catalog.jsonb_array_elements(v_pages) AS page(value)
            WHERE NOT arena.leaderboard_exhaustion_sha256_valid(page.value->'version_token_sha256')
         )
         OR (
           SELECT pg_catalog.count(DISTINCT page.value->>'version_token_sha256')
             FROM pg_catalog.jsonb_array_elements(v_pages) AS page(value)
         ) IS DISTINCT FROM 1 THEN
        RETURN false;
      END IF;
    WHEN 'first_page_reread' THEN
      v_reread := v_board_version->'reread';
      IF arena.leaderboard_exhaustion_keys(v_board_version) IS DISTINCT FROM ARRAY['kind', 'reread']
         OR v_board_version->>'kind' IS DISTINCT FROM 'first_page_reread'
         OR arena.leaderboard_exhaustion_keys(v_reread) IS DISTINCT FROM ARRAY[
              'http_status', 'request_sha256', 'response_sha256', 'row_keys_sha256'
            ]
         OR NOT arena.leaderboard_exhaustion_sha256_valid(v_reread->'request_sha256')
         OR NOT arena.leaderboard_exhaustion_sha256_valid(v_reread->'response_sha256')
         OR NOT arena.leaderboard_exhaustion_sha256_valid(v_reread->'row_keys_sha256')
         OR NOT arena.leaderboard_exhaustion_count_valid(v_reread->'http_status')
         OR (v_reread->>'http_status')::integer NOT BETWEEN 200 AND 299
         OR v_reread->'row_keys_sha256' IS DISTINCT FROM v_pages->0->'row_keys_sha256'
         OR EXISTS (
           SELECT 1
             FROM pg_catalog.jsonb_array_elements(v_pages) AS page(value)
            WHERE page.value->'version_token_sha256' IS DISTINCT FROM 'null'::jsonb
         ) THEN
        RETURN false;
      END IF;
    ELSE
      RETURN false;
  END CASE;

  RETURN true;
END
$function$;

-- One outcome: complete, no reported population, V3 manifest RAW whose
-- completeness block holds against the registered contract.
CREATE FUNCTION arena.leaderboard_outcome_exhaustion_bound(p_attempt_seq bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE((
    SELECT arena.leaderboard_exhaustion_completeness_holds(
             attempt.source_id,
             manifest.meta->'acquisition_attempt'->'completeness',
             outcome.termination_reason,
             outcome.source_page_count,
             outcome.population_report_state,
             outcome.observed_population,
             outcome.accepted_population,
             outcome.rejected_row_count,
             outcome.deduplicated_row_count
           )
      FROM arena.leaderboard_acquisition_outcomes AS outcome
      JOIN arena.leaderboard_acquisition_attempts AS attempt
        ON attempt.attempt_seq = outcome.attempt_seq
      JOIN arena.raw_objects AS manifest
        ON manifest.id = outcome.manifest_raw_object_id
     WHERE outcome.attempt_seq = p_attempt_seq
       AND outcome.terminal_state = 'complete'
       AND outcome.population_report_state = 'unknown'
       AND outcome.reported_population IS NULL
       AND attempt.capture_contract = 'arena.ingest.leaderboard-acquisition-manifest@3'
       AND manifest.meta->>'data_contract' = 'arena.ingest.leaderboard-acquisition-manifest@3'
       AND manifest.trust_artifact_role = 'population_manifest'
       AND manifest.source_run_id = outcome.source_run_id
       AND manifest.content_hash = outcome.source_run_id
       AND NOT manifest.quarantined
  ), false)
$function$;

-- ── Outcome ledger: new termination reason and the exhausted complete branch ──

DO $outcome_constraints$
DECLARE
  v_terminal_def text;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(constraint_row.oid, false)
    INTO STRICT v_terminal_def
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = 'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
     AND constraint_row.conname = 'leaderboard_acquisition_terminal_shape';
  IF pg_catalog.left(v_terminal_def, 6) IS DISTINCT FROM 'CHECK ' THEN
    RAISE EXCEPTION 'unexpected terminal shape definition';
  END IF;

  EXECUTE pg_catalog.format(
    $sql$
    ALTER TABLE arena.leaderboard_acquisition_outcomes
      DROP CONSTRAINT leaderboard_acquisition_outcomes_termination_reason_check,
      DROP CONSTRAINT leaderboard_acquisition_terminal_shape,
      ADD CONSTRAINT leaderboard_acquisition_outcomes_termination_reason_check CHECK (
        termination_reason IS NULL
        OR termination_reason IN (
          'reported_population_reached',
          'reported_page_count_reached',
          'short_page',
          'empty_page',
          'cursor_exhausted',
          'single_snapshot',
          'end_signal_reached',
          'degenerate_page',
          'caller_limit',
          'safety_limit',
          'upstream_error',
          'unknown'
        )
      ),
      ADD CONSTRAINT leaderboard_acquisition_terminal_shape CHECK (
        %s
        OR (
          terminal_state = 'complete'
          AND acquisition_state = 'complete'
          AND population_state = 'verified'
          AND capture_evidence_state = 'verified'
          AND termination_reason IN ('end_signal_reached', 'short_page', 'empty_page')
          AND capture_started_at IS NOT NULL
          AND source_run_id IS NOT NULL
          AND source_payload_raw_object_id IS NOT NULL
          AND manifest_raw_object_id IS NOT NULL
          AND diagnostic_raw_object_id IS NULL
          AND source_page_count IS NOT NULL
          AND source_page_count > 0
          AND population_report_state = 'unknown'
          AND reported_population IS NULL
          AND page_count_report_state IN ('consistent', 'unknown')
          AND (
            page_count_report_state <> 'consistent'
            OR termination_reason = 'empty_page'
               AND source_page_count IN (reported_page_count, reported_page_count + 1)
            OR termination_reason <> 'empty_page'
               AND source_page_count = reported_page_count
          )
          AND observed_population IS NOT NULL
          AND accepted_population IS NOT NULL
          AND rejected_row_count IS NOT NULL
          AND deduplicated_row_count IS NOT NULL
          AND accepted_population > 0
          AND rejected_row_count = 0
          AND observed_population = accepted_population + deduplicated_row_count
          AND NOT caller_limited
          AND NOT safety_limited
          AND failure_stage IS NULL
          AND reason_code IS NULL
        )
      )
    $sql$,
    pg_catalog.substr(v_terminal_def, 7)
  );
END
$outcome_constraints$;

-- The shape alone cannot read the manifest: a complete outcome without a
-- consistent reported population must carry holding exhaustion evidence.
-- Sorts after ..._reject_direct_row_mutation, so unauthorized inserts are
-- refused before this reads any NEW-selected RAW row.
CREATE FUNCTION arena.require_leaderboard_exhaustion_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_source_id smallint;
  v_capture_contract text;
  v_manifest_meta jsonb;
  v_manifest_contract_ok boolean;
BEGIN
  IF NEW.terminal_state IS DISTINCT FROM 'complete'
     OR NEW.population_report_state = 'consistent' THEN
    RETURN NEW;
  END IF;

  SELECT attempt.source_id, attempt.capture_contract
    INTO v_source_id, v_capture_contract
    FROM arena.leaderboard_acquisition_attempts AS attempt
   WHERE attempt.attempt_seq = NEW.attempt_seq;
  SELECT manifest.meta,
         manifest.trust_artifact_role = 'population_manifest'
         AND manifest.source_run_id = NEW.source_run_id
         AND manifest.content_hash = NEW.source_run_id
         AND NOT manifest.quarantined
    INTO v_manifest_meta, v_manifest_contract_ok
    FROM arena.raw_objects AS manifest
   WHERE manifest.id = NEW.manifest_raw_object_id;

  IF v_capture_contract IS DISTINCT FROM 'arena.ingest.leaderboard-acquisition-manifest@3'
     OR v_manifest_meta->>'data_contract' IS DISTINCT FROM
        'arena.ingest.leaderboard-acquisition-manifest@3'
     OR v_manifest_contract_ok IS NOT TRUE
     OR NOT arena.leaderboard_exhaustion_completeness_holds(
       v_source_id,
       v_manifest_meta->'acquisition_attempt'->'completeness',
       NEW.termination_reason,
       NEW.source_page_count,
       NEW.population_report_state,
       NEW.observed_population,
       NEW.accepted_population,
       NEW.rejected_row_count,
       NEW.deduplicated_row_count
     ) THEN
    RAISE EXCEPTION 'a complete acquisition without a reported population requires holding exhaustion evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER leaderboard_acquisition_outcomes_require_exhaustion_evidence
  BEFORE INSERT ON arena.leaderboard_acquisition_outcomes
  FOR EACH ROW EXECUTE FUNCTION arena.require_leaderboard_exhaustion_evidence();

-- ── Publication predicate (20261114193017) re-checks the completeness mode ──

CREATE OR REPLACE FUNCTION public.rank_publication_trust_evidence(p_snapshot_ids bigint[])
RETURNS TABLE (
  snapshot_id bigint,
  trust_bound boolean,
  raw_object_id bigint,
  source_run_id text,
  manifest_raw_object_id bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT requested.id,
         bound.source_run_id IS NOT NULL,
         snapshot.raw_object_id,
         bound.source_run_id,
         bound.manifest_raw_object_id
  FROM (SELECT DISTINCT pg_catalog.unnest(p_snapshot_ids) AS id) AS requested
  LEFT JOIN arena.leaderboard_snapshots AS snapshot
    ON snapshot.id = requested.id
   AND snapshot.count_check_passed
  LEFT JOIN LATERAL (
    SELECT outcome.source_run_id, outcome.manifest_raw_object_id
    FROM arena.leaderboard_acquisition_outcomes AS outcome
    JOIN arena.leaderboard_acquisition_attempts AS attempt
      ON attempt.attempt_seq = outcome.attempt_seq
    WHERE attempt.source_id = snapshot.source_id
      AND attempt.timeframe = snapshot.timeframe
      AND attempt.capture_contract IN (
        'arena.ingest.leaderboard-acquisition-manifest@3',
        'arena.ingest.leaderboard-acquisition-manifest@4'
      )
      AND outcome.terminal_state = 'complete'
      AND outcome.source_run_id IS NOT NULL
      AND outcome.manifest_raw_object_id IS NOT NULL
      AND outcome.source_payload_raw_object_id = snapshot.raw_object_id
      -- Completeness mode: a consistent reported total, or exhaustion
      -- evidence that still holds against the registered contract.
      AND (
        outcome.population_report_state = 'consistent'
        OR arena.leaderboard_outcome_exhaustion_bound(outcome.attempt_seq)
      )
    ORDER BY outcome.attempt_seq DESC
    LIMIT 1
  ) AS bound ON true
  ORDER BY requested.id
$function$;

-- ── Metric-trust run authority (20260722050000) accepts exhausted outcomes ──

DO $metric_trust_authority$
DECLARE
  v_definition text;
  v_report_from constant text :=
    E'     AND terminal.population_report_state = ''consistent''\n';
  v_report_to constant text :=
    E'     AND terminal.population_report_state IN (''consistent'', ''unknown'')\n';
  v_counts_from constant text :=
    E'     AND terminal.observed_population = NEW.fetched_population\n'
    || E'     AND terminal.accepted_population = NEW.fetched_population\n'
    || E'     AND terminal.rejected_row_count = 0\n'
    || E'     AND terminal.deduplicated_row_count = 0\n';
  v_counts_to constant text :=
    E'     AND terminal.accepted_population = NEW.fetched_population\n'
    || E'     AND terminal.rejected_row_count = 0\n'
    || E'     AND (\n'
    || E'       (\n'
    || E'         terminal.population_report_state = ''consistent''\n'
    || E'         AND terminal.observed_population = NEW.fetched_population\n'
    || E'         AND terminal.deduplicated_row_count = 0\n'
    || E'       )\n'
    || E'       OR (\n'
    || E'         terminal.population_report_state = ''unknown''\n'
    || E'         AND NEW.reported_population IS NULL\n'
    || E'         AND terminal.observed_population =\n'
    || E'             NEW.fetched_population + terminal.deduplicated_row_count\n'
    || E'         AND arena.leaderboard_outcome_exhaustion_bound(terminal.attempt_seq)\n'
    || E'       )\n'
    || E'     )\n';
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(
    'arena.validate_metric_trust_attempt_outcome_authority()'::pg_catalog.regprocedure
  );
  IF (pg_catalog.length(v_definition) - pg_catalog.length(pg_catalog.replace(v_definition, v_report_from, '')))
       / pg_catalog.length(v_report_from) IS DISTINCT FROM 1
     OR (pg_catalog.length(v_definition) - pg_catalog.length(pg_catalog.replace(v_definition, v_counts_from, '')))
       / pg_catalog.length(v_counts_from) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'metric-trust outcome authority does not contain the reviewed population predicates exactly once';
  END IF;
  EXECUTE pg_catalog.replace(
    pg_catalog.replace(v_definition, v_report_from, v_report_to),
    v_counts_from,
    v_counts_to
  );
END
$metric_trust_authority$;

-- ── Ownership and grants: internal helpers have no API surface ──

ALTER FUNCTION arena.leaderboard_exhaustion_path_valid(jsonb) OWNER TO postgres;
ALTER FUNCTION arena.leaderboard_exhaustion_scalar_valid(jsonb) OWNER TO postgres;
ALTER FUNCTION arena.leaderboard_exhaustion_sha256_valid(jsonb) OWNER TO postgres;
ALTER FUNCTION arena.leaderboard_exhaustion_count_valid(jsonb) OWNER TO postgres;
ALTER FUNCTION arena.leaderboard_exhaustion_keys(jsonb) OWNER TO postgres;
ALTER FUNCTION arena.leaderboard_exhaustion_declaration_valid(jsonb) OWNER TO postgres;
ALTER FUNCTION arena.reject_leaderboard_exhaustion_contract_mutation() OWNER TO postgres;
ALTER FUNCTION arena.leaderboard_exhaustion_completeness_holds(
  smallint, jsonb, text, integer, text, integer, integer, integer, integer
) OWNER TO postgres;
ALTER FUNCTION arena.leaderboard_outcome_exhaustion_bound(bigint) OWNER TO postgres;
ALTER FUNCTION arena.require_leaderboard_exhaustion_evidence() OWNER TO postgres;
ALTER TABLE arena.leaderboard_exhaustion_contracts OWNER TO postgres;

REVOKE ALL ON FUNCTION arena.leaderboard_exhaustion_path_valid(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.leaderboard_exhaustion_scalar_valid(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.leaderboard_exhaustion_sha256_valid(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.leaderboard_exhaustion_count_valid(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.leaderboard_exhaustion_keys(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.leaderboard_exhaustion_declaration_valid(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.reject_leaderboard_exhaustion_contract_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.leaderboard_exhaustion_completeness_holds(
  smallint, jsonb, text, integer, text, integer, integer, integer, integer
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.leaderboard_outcome_exhaustion_bound(bigint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.require_leaderboard_exhaustion_evidence()
  FROM PUBLIC, anon, authenticated, service_role;

-- CREATE OR REPLACE keeps the predicate's 20261114193017 ACL; restate it.
ALTER FUNCTION public.rank_publication_trust_evidence(bigint[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.rank_publication_trust_evidence(bigint[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rank_publication_trust_evidence(bigint[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
