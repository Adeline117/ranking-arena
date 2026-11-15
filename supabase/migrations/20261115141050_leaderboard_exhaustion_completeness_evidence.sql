-- Migration: 20261115141050_leaderboard_exhaustion_completeness_evidence.sql
-- Created: 2026-11-15T22:10:50Z
-- Description: Second completeness mode for attempt-bound leaderboard
--   evidence: "exhausted" (lib/ingest/acquisition-exhaustion.ts).
--
-- A board's acquisition could be trusted only when the upstream reported a
-- population equal to the accepted rows. Many boards report no total and
-- signal their end by exhaustion (a continuation flag, a reported page count,
-- or a short final page), sometimes with a board version token. Their
-- acquisition outcome stays truthful and unchanged: terminal 'unknown',
-- acquisition 'complete', population 'unknown', reason 'population_unknown'
-- (no reported total). This migration adds a separate, append-only exhaustion
-- proof that publication accepts in place of the reported total, under a
-- check as strict as the total mode:
--
-- * arena.leaderboard_exhaustion_contracts: the reviewed per-source capture
--   contract. It declares the completeness mode, row-array and row-key paths,
--   the exact end-signal path, the board-version check and the tolerated
--   cross-page duplicates. Empty here; each source is registered by its own
--   reviewed migration.
-- * arena.leaderboard_exhaustion_completeness_holds(...): checks the manifest's
--   completeness block (manifest RAW meta.acquisition_attempt.completeness,
--   immutable once an outcome binds the RAW): declaration = registered
--   contract; one entry per source page, ordinals contiguous from one,
--   well-formed request/response/row-key hashes, row counts summing to the
--   observed population; the end signal says "more" on every page but the
--   last and "end" on the last; duplicate row keys = observed - distinct,
--   within the allowance, distinct = accepted rows, zero rejected rows; one
--   version token on every page, or page one re-read with identical row keys.
-- * arena.leaderboard_acquisition_exhaustion_evidence +
--   arena.record_leaderboard_exhaustion_evidence(attempt_id): the worker
--   records the proof for a finished outcome; the function refuses (23514)
--   unless the outcome is an exhausted shape and the check holds.
-- * public.rank_publication_trust_evidence (20261114193017): a board binds to
--   a 'complete' outcome, or to an exhausted outcome whose recorded proof
--   still holds.
-- * arena.validate_metric_trust_attempt_outcome_authority (20260722050000):
--   a verified metric-trust run may cite an exhausted outcome (reported
--   population NULL, observed = fetched + deduplicated) only under the same
--   proof; the reported-total branch is unchanged.
--
-- PREDEPLOY, after 20261114193017. Inert until a source registers a contract:
-- with the registry empty no proof can be recorded, so publication and
-- metric-trust authority accept exactly what they accepted before. No table,
-- column or constraint of the acquisition ledger changes.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
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

  IF pg_catalog.to_regclass('arena.leaderboard_exhaustion_contracts') IS NOT NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_exhaustion_evidence') IS NOT NULL THEN
    RAISE EXCEPTION 'exhaustion completeness evidence already exists';
  END IF;

  -- Both replaced functions must be their exact reviewed bodies.
  IF (
       SELECT pg_catalog.encode(
                pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')), 'hex')
         FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid =
              'arena.validate_metric_trust_attempt_outcome_authority()'::pg_catalog.regprocedure
     ) IS DISTINCT FROM '63565ea00912b9ba4660aa23c4772f8d19100f1507246405631f378fe36880af'
     OR (
       SELECT pg_catalog.encode(
                pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')), 'hex')
         FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid =
              'public.rank_publication_trust_evidence(bigint[])'::pg_catalog.regprocedure
     ) IS DISTINCT FROM 'a7975512ed092ec784a5a22bcd7bff6c7b52f1480d1fb6c1ec8d1a6e059d5c8c' THEN
    RAISE EXCEPTION 'metric-trust outcome authority (20260722050000) or publication trust predicate (20261114193017) drifted';
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
           (p_termination_reason = 'cursor_exhausted' AND (v_last->>'row_count')::integer > 0)
           OR (p_termination_reason = 'empty_page' AND (v_last->>'row_count')::integer = 0)
         ) THEN
        RETURN false;
      END IF;
    WHEN 'page_count' THEN
      IF p_termination_reason IS DISTINCT FROM 'reported_page_count_reached'
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

-- ── Recorded exhaustion proof per outcome (append-only) ──

CREATE TABLE arena.leaderboard_acquisition_exhaustion_evidence (
  attempt_seq bigint PRIMARY KEY
    REFERENCES arena.leaderboard_acquisition_outcomes(attempt_seq) ON DELETE RESTRICT,
  source_id smallint NOT NULL REFERENCES arena.sources(id) ON DELETE RESTRICT,
  timeframe smallint NOT NULL CHECK (timeframe IN (7, 30, 90)),
  source_run_id text NOT NULL CHECK (
    source_run_id ~ '^[0-9a-f]{64}$' AND source_run_id <> pg_catalog.repeat('0', 64)
  ),
  manifest_raw_object_id bigint NOT NULL CHECK (manifest_raw_object_id > 0),
  completeness_contract text NOT NULL CHECK (
    completeness_contract = 'arena.ingest.leaderboard-exhaustion-completeness@1'
  ),
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

COMMENT ON TABLE arena.leaderboard_acquisition_exhaustion_evidence IS
  'Exhausted-mode completeness proof for one acquisition outcome; written only by arena.record_leaderboard_exhaustion_evidence. Append-only.';

CREATE TRIGGER leaderboard_acquisition_exhaustion_evidence_append_only
  BEFORE UPDATE OR DELETE ON arena.leaderboard_acquisition_exhaustion_evidence
  FOR EACH ROW EXECUTE FUNCTION arena.reject_leaderboard_exhaustion_contract_mutation();
CREATE TRIGGER leaderboard_acquisition_exhaustion_evidence_no_truncate
  BEFORE TRUNCATE ON arena.leaderboard_acquisition_exhaustion_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_leaderboard_exhaustion_contract_mutation();

ALTER TABLE arena.leaderboard_acquisition_exhaustion_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.leaderboard_acquisition_exhaustion_evidence FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE arena.leaderboard_acquisition_exhaustion_evidence
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE arena.leaderboard_acquisition_exhaustion_evidence TO service_role;
CREATE POLICY leaderboard_acquisition_exhaustion_evidence_service_read
  ON arena.leaderboard_acquisition_exhaustion_evidence
  FOR SELECT TO service_role USING (true);

-- The exhausted outcome shape plus a holding proof (no recorded row needed:
-- the recorder and every reader share this one check).
CREATE FUNCTION arena.leaderboard_outcome_exhaustion_holds(p_attempt_seq bigint)
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
       AND outcome.terminal_state = 'unknown'
       AND outcome.acquisition_state = 'complete'
       AND outcome.population_state = 'unknown'
       AND outcome.capture_evidence_state = 'verified'
       AND outcome.population_report_state = 'unknown'
       AND outcome.reported_population IS NULL
       AND outcome.reason_code = 'population_unknown'
       AND outcome.termination_reason IN (
         'cursor_exhausted', 'reported_page_count_reached', 'short_page', 'empty_page'
       )
       AND outcome.source_run_id IS NOT NULL
       AND outcome.source_payload_raw_object_id IS NOT NULL
       AND outcome.diagnostic_raw_object_id IS NULL
       AND outcome.failure_stage IS NULL
       AND NOT outcome.caller_limited
       AND NOT outcome.safety_limited
       AND attempt.capture_contract = 'arena.ingest.leaderboard-acquisition-manifest@3'
       AND manifest.meta->>'data_contract' = 'arena.ingest.leaderboard-acquisition-manifest@3'
       AND manifest.trust_artifact_role = 'population_manifest'
       AND manifest.source_run_id = outcome.source_run_id
       AND manifest.content_hash = outcome.source_run_id
       AND NOT manifest.quarantined
  ), false)
$function$;

-- Bound = proof recorded for the outcome and still holding.
CREATE FUNCTION arena.leaderboard_outcome_exhaustion_bound(p_attempt_seq bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT EXISTS (
           SELECT 1
             FROM arena.leaderboard_acquisition_exhaustion_evidence AS evidence
            WHERE evidence.attempt_seq = p_attempt_seq
         )
         AND arena.leaderboard_outcome_exhaustion_holds(p_attempt_seq)
$function$;

CREATE FUNCTION arena.record_leaderboard_exhaustion_evidence(p_attempt_id uuid)
RETURNS arena.leaderboard_acquisition_exhaustion_evidence
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_attempt arena.leaderboard_acquisition_attempts%ROWTYPE;
  v_outcome arena.leaderboard_acquisition_outcomes%ROWTYPE;
  v_row arena.leaderboard_acquisition_exhaustion_evidence%ROWTYPE;
BEGIN
  SELECT * INTO v_attempt
    FROM arena.leaderboard_acquisition_attempts
   WHERE attempt_id = p_attempt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'leaderboard acquisition attempt does not exist'
      USING ERRCODE = '23503';
  END IF;
  PERFORM arena.lock_leaderboard_acquisition_source_window(
    v_attempt.source_id, v_attempt.timeframe
  );

  SELECT * INTO v_row
    FROM arena.leaderboard_acquisition_exhaustion_evidence
   WHERE attempt_seq = v_attempt.attempt_seq;
  IF FOUND THEN
    RETURN v_row;
  END IF;

  SELECT * INTO v_outcome
    FROM arena.leaderboard_acquisition_outcomes
   WHERE attempt_seq = v_attempt.attempt_seq;
  IF NOT FOUND OR NOT arena.leaderboard_outcome_exhaustion_holds(v_attempt.attempt_seq) THEN
    RAISE EXCEPTION 'acquisition % has no holding exhaustion evidence', p_attempt_id
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO arena.leaderboard_acquisition_exhaustion_evidence (
    attempt_seq, source_id, timeframe, source_run_id, manifest_raw_object_id,
    completeness_contract
  ) VALUES (
    v_attempt.attempt_seq, v_attempt.source_id, v_attempt.timeframe,
    v_outcome.source_run_id, v_outcome.manifest_raw_object_id,
    'arena.ingest.leaderboard-exhaustion-completeness@1'
  )
  RETURNING * INTO STRICT v_row;
  RETURN v_row;
END
$function$;

-- ── Publication predicate (20261114193017): either completeness mode ──

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
      AND outcome.source_run_id IS NOT NULL
      AND outcome.manifest_raw_object_id IS NOT NULL
      AND outcome.source_payload_raw_object_id = snapshot.raw_object_id
      -- Completeness mode: a complete outcome (reported total equal to the
      -- accepted rows), or an exhausted outcome whose recorded proof holds.
      AND (
        outcome.terminal_state = 'complete'
        OR arena.leaderboard_outcome_exhaustion_bound(outcome.attempt_seq)
      )
    ORDER BY outcome.attempt_seq DESC
    LIMIT 1
  ) AS bound ON true
  ORDER BY requested.id
$function$;

-- ── Metric-trust run authority (20260722050000): either completeness mode ──

CREATE OR REPLACE FUNCTION arena.validate_metric_trust_attempt_outcome_authority()
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
     AND terminal.acquisition_state = 'complete'
     AND terminal.acquisition_state = NEW.acquisition_state
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
     AND terminal.source_page_count IS NOT NULL
     AND terminal.source_page_count > 0
     AND terminal.accepted_population = NEW.fetched_population
     AND terminal.rejected_row_count = 0
     AND NOT terminal.caller_limited
     AND terminal.caller_limited = NEW.caller_limited
     AND NOT terminal.safety_limited
     AND terminal.failure_stage IS NULL
     -- Completeness mode (20261115141050): a reported total equal to the
     -- accepted rows, or exhaustion evidence recorded for this outcome.
     AND (
       (
         terminal.terminal_state = 'complete'
         AND terminal.population_state = 'verified'
         AND NEW.population_state = 'verified'
         AND terminal.reported_population IS NOT DISTINCT FROM NEW.reported_population
         AND terminal.population_report_state = 'consistent'
         AND terminal.observed_population = NEW.fetched_population
         AND terminal.deduplicated_row_count = 0
         AND terminal.reason_code IS NULL
       )
       OR (
         terminal.terminal_state = 'unknown'
         AND terminal.population_state = 'unknown'
         AND NEW.population_state = 'verified'
         AND terminal.population_report_state = 'unknown'
         AND terminal.reported_population IS NULL
         AND NEW.reported_population IS NULL
         AND terminal.observed_population =
             NEW.fetched_population + terminal.deduplicated_row_count
         AND terminal.reason_code = 'population_unknown'
         AND arena.leaderboard_outcome_exhaustion_bound(terminal.attempt_seq)
       )
     );

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

-- ── Ownership and grants ──

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
ALTER FUNCTION arena.leaderboard_outcome_exhaustion_holds(bigint) OWNER TO postgres;
ALTER FUNCTION arena.leaderboard_outcome_exhaustion_bound(bigint) OWNER TO postgres;
ALTER FUNCTION arena.record_leaderboard_exhaustion_evidence(uuid) OWNER TO postgres;
ALTER FUNCTION arena.validate_metric_trust_attempt_outcome_authority() OWNER TO postgres;
ALTER FUNCTION public.rank_publication_trust_evidence(bigint[]) OWNER TO postgres;
ALTER TABLE arena.leaderboard_exhaustion_contracts OWNER TO postgres;
ALTER TABLE arena.leaderboard_acquisition_exhaustion_evidence OWNER TO postgres;

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
REVOKE ALL ON FUNCTION arena.leaderboard_outcome_exhaustion_holds(bigint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.leaderboard_outcome_exhaustion_bound(bigint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.record_leaderboard_exhaustion_evidence(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION arena.record_leaderboard_exhaustion_evidence(uuid) TO service_role;
REVOKE ALL ON FUNCTION arena.validate_metric_trust_attempt_outcome_authority()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.rank_publication_trust_evidence(bigint[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rank_publication_trust_evidence(bigint[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
