-- Migration: 20261122152622_metric_trust_observation_lineage_per_statement.sql
-- Description: validate an observation batch's source-page lineage once per
--   acquisition run instead of once per row.
--
-- Why: arena.validate_metric_trust_source_page_lineage() is a BEFORE INSERT
--   ... FOR EACH ROW trigger. For every observation it re-read the run's two
--   RAW objects, looped over the run's whole parserSourcePageOrdinals array,
--   re-resolved the run's terminal outcome and, for an exhaustion run,
--   re-verified the exhaustion proof (arena.leaderboard_outcome_exhaustion_bound,
--   63.5 ms for a 433-page run in production). All of that is a property of
--   the run, not of the row. binance_futures writes ~12,900 observations per
--   window: ~820 s for the proof alone against the worker's 300 s query
--   timeout. Every capture passed its drift proof for 20 hours (12 of 12) and
--   every publication rolled back with "Query read timeout", so the source has
--   never had a passed snapshot. bybit_mt5 (2,039 pages, ~32,000 rows) would
--   be worse.
--
-- What changes:
--   * The row trigger keeps its name, function, timing and the two row-local
--     rules: a NULL ordinal is downgraded to unknown, a non-positive one is
--     refused.
--   * A new AFTER INSERT ... FOR EACH STATEMENT trigger with a transition
--     table validates each run that appears in the statement exactly once,
--     with the same statements, in the same order and with the same errors
--     as before (RAW artifacts, canonical page metadata, strictly increasing
--     in-range ordinals, the exact @3 terminal incl. the exhaustion branch,
--     page-count agreement), then refuses the statement if any inserted row's
--     ordinal is not a member of its run's parser ordinals.
--   A row that fails either trigger still cannot be written: the statement
--   aborts and nothing of it is kept. No caller-visible cache is involved.
--
-- POSTDEPLOY, after 20261118112703 (whose trigger function it replaces). No
-- worker release depends on it. It touches no table 20261111192134 guards.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure('arena.validate_metric_trust_source_page_lineage()') IS NULL
     OR (
       SELECT pg_catalog.encode(
                pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')), 'hex')
         FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid =
              'arena.validate_metric_trust_source_page_lineage()'::pg_catalog.regprocedure
     ) IS DISTINCT FROM 'c0736106cef19e7db4040c692ff89a5432a9edf393901719c3698788a91baaa9' THEN
    RAISE EXCEPTION 'lineage trigger function is not the 20261118112703 definition';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
     WHERE trigger_row.tgrelid = 'arena.metric_trust_observations'::pg_catalog.regclass
       AND trigger_row.tgname = 'metric_trust_observations_source_page_lineage_before_insert'
       AND trigger_row.tgtype = 7
       AND trigger_row.tgenabled = 'O'
       AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'the per-row lineage trigger is missing or disabled';
  END IF;
END
$preflight$;

-- Created before the row trigger is slimmed so no statement can run between
-- the two with neither check in force (both happen in this transaction and
-- CREATE TRIGGER holds SHARE ROW EXCLUSIVE on the table until COMMIT).
CREATE FUNCTION arena.validate_metric_trust_source_page_lineage_statement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_run record;
  v_page_count_text text;
  v_parser_page_count_text text;
  v_parser_source_page_ordinals jsonb;
  v_manifest_contract text;
  v_page_count integer;
  v_parser_page_count integer;
  v_terminal_page_count integer;
  v_previous_ordinal integer;
  v_actual_ordinal integer;
  v_ordinals integer[];
  v_item record;
BEGIN
  -- One pass per acquisition run present in this statement (normally one).
  FOR v_run IN
    SELECT DISTINCT
           observation.source_run_id,
           observation.source_id,
           observation.timeframe,
           observation.snapshot_id
      FROM inserted_observations AS observation
     WHERE observation.source_page_ordinal IS NOT NULL
     ORDER BY 1, 2, 3, 4
  LOOP
    v_previous_ordinal := 0;
    v_ordinals := ARRAY[]::integer[];

    SELECT
      population.meta->>'pageCount',
      population.meta->>'parserPageCount',
      population.meta->'parserSourcePageOrdinals',
      manifest.meta->>'data_contract'
    INTO STRICT
      v_page_count_text,
      v_parser_page_count_text,
      v_parser_source_page_ordinals,
      v_manifest_contract
    FROM arena.metric_trust_runs AS acquisition
    JOIN arena.raw_objects AS population
      ON population.id = acquisition.population_raw_object_id
    JOIN arena.raw_objects AS manifest
      ON manifest.id = acquisition.manifest_raw_object_id
    WHERE acquisition.source_run_id = v_run.source_run_id
      AND acquisition.source_id = v_run.source_id
      AND acquisition.timeframe = v_run.timeframe
      AND acquisition.snapshot_id = v_run.snapshot_id
      AND population.source_id = v_run.source_id
      AND population.timeframe = v_run.timeframe
      AND population.source_run_id = v_run.source_run_id
      AND population.trust_artifact_role = 'source_payload'
      AND NOT population.quarantined
      AND manifest.source_id = v_run.source_id
      AND manifest.timeframe = v_run.timeframe
      AND manifest.source_run_id = v_run.source_run_id
      AND manifest.trust_artifact_role = 'population_manifest'
      AND manifest.content_hash = v_run.source_run_id
      AND NOT manifest.quarantined;

    IF v_page_count_text IS NULL
       OR v_page_count_text !~ '^[1-9][0-9]*$'
       OR pg_catalog.length(v_page_count_text) > 10 THEN
      RAISE EXCEPTION 'source payload parser-page metadata is not canonical'
        USING ERRCODE = '23514';
    END IF;
    IF v_page_count_text::numeric > 2147483647::numeric THEN
      RAISE EXCEPTION 'source payload parser-page metadata is not canonical'
        USING ERRCODE = '23514';
    END IF;
    IF v_parser_page_count_text IS NULL
       OR v_parser_page_count_text !~ '^[1-9][0-9]*$'
       OR pg_catalog.length(v_parser_page_count_text) > 10 THEN
      RAISE EXCEPTION 'source payload parser-page metadata is not canonical'
        USING ERRCODE = '23514';
    END IF;
    IF v_parser_page_count_text::numeric > 2147483647::numeric
       OR pg_catalog.jsonb_typeof(v_parser_source_page_ordinals) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'source payload parser-page metadata is not canonical'
        USING ERRCODE = '23514';
    END IF;

    v_page_count := v_page_count_text::integer;
    v_parser_page_count := v_parser_page_count_text::integer;
    IF v_parser_page_count > v_page_count
       OR pg_catalog.jsonb_array_length(v_parser_source_page_ordinals) <>
          v_parser_page_count THEN
      RAISE EXCEPTION 'source payload parser-page count is inconsistent'
        USING ERRCODE = '23514';
    END IF;

    FOR v_item IN
      SELECT item.value, item.ordinality
        FROM pg_catalog.jsonb_array_elements(
               v_parser_source_page_ordinals
             ) WITH ORDINALITY AS item(value, ordinality)
       ORDER BY item.ordinality
    LOOP
      IF pg_catalog.jsonb_typeof(v_item.value) IS DISTINCT FROM 'number'
         OR v_item.value #>> '{}' !~ '^[1-9][0-9]*$'
         OR pg_catalog.length(v_item.value #>> '{}') > 10 THEN
        RAISE EXCEPTION 'source payload parser-page ordinals are not canonical integers'
          USING ERRCODE = '23514';
      END IF;
      IF (v_item.value #>> '{}')::numeric > 2147483647::numeric THEN
        RAISE EXCEPTION 'source payload parser-page ordinals are not canonical integers'
          USING ERRCODE = '23514';
      END IF;

      v_actual_ordinal := (v_item.value #>> '{}')::integer;
      IF v_actual_ordinal <= v_previous_ordinal
         OR v_actual_ordinal > v_page_count THEN
        RAISE EXCEPTION 'source payload parser-page ordinals are not strictly increasing in range'
          USING ERRCODE = '23514';
      END IF;
      v_previous_ordinal := v_actual_ordinal;
      v_ordinals := v_ordinals || v_actual_ordinal;
    END LOOP;

    IF EXISTS (
      SELECT 1
        FROM inserted_observations AS observation
       WHERE observation.source_run_id = v_run.source_run_id
         AND observation.source_id = v_run.source_id
         AND observation.timeframe = v_run.timeframe
         AND observation.snapshot_id = v_run.snapshot_id
         AND observation.source_page_ordinal IS NOT NULL
         AND NOT (observation.source_page_ordinal = ANY (v_ordinals))
    ) THEN
      RAISE EXCEPTION 'source-page ordinal is not a parser input member'
        USING ERRCODE = '23514';
    END IF;

    IF v_manifest_contract =
       'arena.ingest.leaderboard-acquisition-manifest@3' THEN
      SELECT terminal.source_page_count
        INTO STRICT v_terminal_page_count
        FROM arena.metric_trust_runs AS acquisition
        JOIN arena.latest_terminal_leaderboard_acquisitions AS terminal
          ON terminal.source_id = acquisition.source_id
         AND terminal.timeframe = acquisition.timeframe
         AND terminal.source_run_id = acquisition.source_run_id
         AND terminal.source_payload_raw_object_id =
             acquisition.population_raw_object_id
         AND terminal.manifest_raw_object_id = acquisition.manifest_raw_object_id
       WHERE acquisition.source_run_id = v_run.source_run_id
         AND acquisition.source_id = v_run.source_id
         AND acquisition.timeframe = v_run.timeframe
         AND acquisition.snapshot_id = v_run.snapshot_id
         AND terminal.capture_contract =
             'arena.ingest.leaderboard-acquisition-manifest@3'
         AND terminal.acquisition_state = 'complete'
         AND terminal.capture_evidence_state = 'verified'
         AND terminal.source_page_count IS NOT NULL
         AND terminal.source_page_count > 0
         AND NOT terminal.caller_limited
         AND NOT terminal.safety_limited
         AND terminal.failure_stage IS NULL
         AND (
           (
             terminal.terminal_state = 'complete'
             AND terminal.population_state = 'verified'
             AND terminal.reason_code IS NULL
           )
           -- Exhaustion completeness (20261115141050), same branch as
           -- validate_metric_trust_attempt_outcome_authority.
           OR (
             terminal.terminal_state = 'unknown'
             AND terminal.population_state = 'unknown'
             AND acquisition.population_state = 'verified'
             AND terminal.population_report_state = 'unknown'
             AND terminal.reported_population IS NULL
             AND acquisition.reported_population IS NULL
             AND terminal.reason_code = 'population_unknown'
             AND arena.leaderboard_outcome_exhaustion_bound(terminal.attempt_seq)
           )
         );

      IF v_page_count <> v_terminal_page_count
         OR v_parser_page_count > v_terminal_page_count THEN
        RAISE EXCEPTION 'parser-page evidence disagrees with the exact v3 terminal page count'
          USING ERRCODE = '23514';
      END IF;
    ELSIF v_manifest_contract IS DISTINCT FROM
          'arena.ingest.leaderboard-acquisition-manifest@2' THEN
      RAISE EXCEPTION 'source-page ordinal uses an unsupported manifest contract'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NULL;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'source-page ordinal has no exact immutable parser evidence'
      USING ERRCODE = '23503';
  WHEN TOO_MANY_ROWS THEN
    RAISE EXCEPTION 'source-page ordinal parser evidence is ambiguous'
      USING ERRCODE = '23514';
END
$function$;

ALTER FUNCTION arena.validate_metric_trust_source_page_lineage_statement() OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.validate_metric_trust_source_page_lineage_statement()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER metric_trust_observations_source_page_lineage_after_statement
AFTER INSERT ON arena.metric_trust_observations
REFERENCING NEW TABLE AS inserted_observations
FOR EACH STATEMENT
EXECUTE FUNCTION arena.validate_metric_trust_source_page_lineage_statement();

CREATE OR REPLACE FUNCTION arena.validate_metric_trust_source_page_lineage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.source_page_ordinal IS NULL THEN
    -- Preserve rollout compatibility with a pre-lineage writer. The old row
    -- may commit, but it is atomically downgraded and can never be rankable.
    NEW.freshness_state := 'unknown';
    NEW.quality := 'unknown';
    NEW.blocking_reasons := CASE
      WHEN pg_catalog.jsonb_typeof(NEW.blocking_reasons) = 'array'
      THEN NEW.blocking_reasons
      ELSE '[]'::jsonb
    END;
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.jsonb_array_elements(NEW.blocking_reasons) AS reason(value)
       WHERE reason.value->>'code' = 'source_page_lineage_missing'
    ) THEN
      NEW.blocking_reasons := NEW.blocking_reasons || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'code', 'source_page_lineage_missing',
          'state', 'unknown'
        )
      );
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.source_page_ordinal <= 0 THEN
    RAISE EXCEPTION 'source-page ordinal must be positive'
      USING ERRCODE = '23514';
  END IF;

  -- Membership in the run's parser page ordinals and the run's own lineage
  -- are validated once per statement by
  -- arena.validate_metric_trust_source_page_lineage_statement().
  RETURN NEW;
END
$function$;

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
     WHERE trigger_row.tgrelid = 'arena.metric_trust_observations'::pg_catalog.regclass
       AND trigger_row.tgname = 'metric_trust_observations_source_page_lineage_after_statement'
       AND trigger_row.tgenabled = 'O'
       AND trigger_row.tgnewtable = 'inserted_observations'
       AND trigger_row.tgfoid =
           'arena.validate_metric_trust_source_page_lineage_statement()'::pg_catalog.regprocedure
  ) THEN
    RAISE EXCEPTION 'the per-statement lineage trigger did not land';
  END IF;
  IF pg_catalog.has_function_privilege('anon', 'arena.validate_metric_trust_source_page_lineage_statement()', 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'arena.validate_metric_trust_source_page_lineage_statement()', 'EXECUTE')
     OR pg_catalog.has_function_privilege('service_role', 'arena.validate_metric_trust_source_page_lineage_statement()', 'EXECUTE') THEN
    RAISE EXCEPTION 'the per-statement lineage function is executable by an application role';
  END IF;
END
$postflight$;

COMMIT;
