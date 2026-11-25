-- Migration: 20261123020207_metric_trust_artifact_raw_integrity_per_statement.sql
-- Description: check a RAW object's integrity metadata once per statement
--   instead of once per artifact row.
--
-- Why: arena.validate_metric_trust_artifact() is a BEFORE INSERT ... FOR EACH
--   ROW trigger. For every artifact row it read the referenced RAW object's
--   whole meta document only to test two fields (meta.raw_integrity
--   hash_algorithm / hash_scope). That document carries the capture's per-page
--   record and grows with the page count: 434 kB stored (731 kB as text) for a
--   2,042-page bybit_mt5 window, 93 kB for binance_futures. bybit_mt5 writes
--   32,659 traders x 2 metrics x 2 roles = ~130,600 artifact rows per window,
--   each decompressing that document. Measured locally at the same size the
--   trigger costs 0.62 ms per row (~80 s for one window) against 0.13 ms at
--   the binance size; bybit_mt5 windows still end in "Query read timeout"
--   after 20261122152622.
--
-- What changes:
--   * The row trigger keeps its name, timing and every other check (run,
--     role, hash, quarantine, freshness window, manifest identity, population
--     payload) and no longer selects meta.
--   * A new AFTER INSERT ... FOR EACH STATEMENT trigger with a transition
--     table tests meta.raw_integrity once for each distinct RAW object the
--     statement references, and raises the same exception.
--   A row that fails either trigger still cannot be written.
--
-- POSTDEPLOY; no worker release depends on it. It touches no table
-- 20261111192134 guards.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure('arena.validate_metric_trust_artifact()') IS NULL
     OR (
       SELECT pg_catalog.encode(
                pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')), 'hex')
         FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid =
              'arena.validate_metric_trust_artifact()'::pg_catalog.regprocedure
     ) IS DISTINCT FROM '4e24bed31dd5f37595b52ea9ef37f5388c18ce8518ad0d8b1939be6b91c8ad6e' THEN
    RAISE EXCEPTION 'artifact trigger function is not the 20260721120000 definition';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
     WHERE trigger_row.tgrelid = 'arena.metric_trust_artifacts'::pg_catalog.regclass
       AND trigger_row.tgname = 'validate_metric_trust_artifact_before_insert'
       AND trigger_row.tgtype = 7
       AND trigger_row.tgenabled = 'O'
       AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'the per-row artifact trigger is missing or disabled';
  END IF;
END
$preflight$;

-- Created before the row trigger stops reading meta, in the same transaction.
CREATE FUNCTION arena.validate_metric_trust_artifact_raw_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM (
        SELECT DISTINCT artifact.raw_object_id
          FROM inserted_artifacts AS artifact
      ) AS referenced
      LEFT JOIN arena.raw_objects AS raw
        ON raw.id = referenced.raw_object_id
     WHERE raw.id IS NULL
        OR raw.meta->'raw_integrity'->>'hash_algorithm' IS DISTINCT FROM 'sha256'
        OR raw.meta->'raw_integrity'->>'hash_scope' IS DISTINCT FROM 'json_utf8'
  ) THEN
    RAISE EXCEPTION 'metric trust artifact is not immutable evidence from the bound run';
  END IF;
  RETURN NULL;
END
$function$;

ALTER FUNCTION arena.validate_metric_trust_artifact_raw_integrity() OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.validate_metric_trust_artifact_raw_integrity()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION arena.validate_metric_trust_artifact_raw_integrity() TO service_role;

CREATE TRIGGER validate_metric_trust_artifact_raw_integrity_after_statement
AFTER INSERT ON arena.metric_trust_artifacts
REFERENCING NEW TABLE AS inserted_artifacts
FOR EACH STATEMENT
EXECUTE FUNCTION arena.validate_metric_trust_artifact_raw_integrity();

CREATE OR REPLACE FUNCTION arena.validate_metric_trust_artifact()
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
BEGIN
  -- The RAW object's integrity metadata (meta.raw_integrity) is checked once per
  -- RAW object per statement by
  -- arena.validate_metric_trust_artifact_raw_integrity(); this row trigger no
  -- longer reads meta.
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
    quarantined
    INTO STRICT
      v_raw_source_id,
      v_raw_timeframe,
      v_raw_source_run_id,
      v_raw_role,
      v_raw_fetched_at,
      v_raw_hash,
      v_raw_quarantined
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
     OR v_raw_fetched_at > v_recorded_at + interval '5 minutes' THEN
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

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
     WHERE trigger_row.tgrelid = 'arena.metric_trust_artifacts'::pg_catalog.regclass
       AND trigger_row.tgname = 'validate_metric_trust_artifact_raw_integrity_after_statement'
       AND trigger_row.tgenabled = 'O'
       AND trigger_row.tgtype = 4
       AND trigger_row.tgnewtable = 'inserted_artifacts'
       AND trigger_row.tgfoid =
           'arena.validate_metric_trust_artifact_raw_integrity()'::pg_catalog.regprocedure
  ) THEN
    RAISE EXCEPTION 'the per-statement artifact integrity trigger did not land';
  END IF;
  IF pg_catalog.has_function_privilege('anon', 'arena.validate_metric_trust_artifact_raw_integrity()', 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'arena.validate_metric_trust_artifact_raw_integrity()', 'EXECUTE') THEN
    RAISE EXCEPTION 'the per-statement artifact integrity function is executable by a public role';
  END IF;
END
$postflight$;

COMMIT;
