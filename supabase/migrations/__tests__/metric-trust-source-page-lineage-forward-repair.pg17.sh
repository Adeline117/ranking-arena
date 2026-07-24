#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260722055000_metric_trust_source_page_lineage_forward_repair.sql"
QUARANTINED_MIGRATION="$ROOT_DIR/supabase/migrations/20260722054000_metric_trust_source_page_lineage.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

PREREQUISITES=(
  '20260721120000|metric_trust_shadow_gate|9406636f749318929b9b1b9e2032256a571ec4e8e0246b66dc31c8ed0176fe30|20260721120000_metric_trust_shadow_gate.sql'
  '20260721130000|raw_object_gc_outbox|700805755c7daee4b4a1df4a2f65a0d3ab593270f65e112dc1704479a3b91066|20260721130000_raw_object_gc_outbox.sql'
  '20260721150000|metric_trust_raw_artifact_identity|b4c96ec8123be5dac548962b03834ffd9a0b0e7b4797abe9349ad0bc7bfca48a|20260721150000_metric_trust_raw_artifact_identity.sql'
  '20260722030000|durable_leaderboard_acquisition_attempt_ledger|d60f5e1a3c04088b04f12a883ceae16aefd36b56ad97dd09dd0084c7a758d71e|20260722030000_durable_leaderboard_acquisition_attempt_ledger.sql'
  '20260722040000|leaderboard_acquisition_manifest_v3_compat|9e6dbed7647ca494c928eba573163b2be9fccfd0956df7ab7fbb9c81121a1f2b|20260722040000_leaderboard_acquisition_manifest_v3_compat.sql'
  '20260722042000|leaderboard_terminal_publication_fence|e5c4c67e6fc822ff38e36d80ffe5770f305de63c7497973ba9b956bca3520b47|20260722042000_leaderboard_terminal_publication_fence.sql'
  '20260722050000|metric_trust_attempt_outcome_authority|3648ac33324eb99e476eb15dc624b37d6d086ac6eef92c9b34dc8e30399dd92f|20260722050000_metric_trust_attempt_outcome_authority.sql'
  '20260722051000|leaderboard_score_input_manifest_contract|fdf578522865afc7b81d7f1fedd99e4bf6e007d0460d3ba678babf4414a4829c|20260722051000_leaderboard_score_input_manifest_contract.sql'
  '20260722052000|leaderboard_score_input_manifest_rank_eligible_pnl|34d1af48d66a4b3cedcee548e3438ba81fa9cc3fdca7a00f308d7f768f30150e|20260722052000_leaderboard_score_input_manifest_rank_eligible_pnl.sql'
  '20260722053000|binance_spot_metric_source_contract|1f4ce27a0a44cfc6f9c1d11c113dc2db7aa5eed170ef3b38b1469c0a1c758abc|20260722053000_binance_spot_metric_source_contract.sql'
)

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/metric-trust-lineage-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((61000 + ($$ % 4000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -160 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d "${TEST_DATABASE:-postgres}" "$@"
}

expect_failure() {
  local label="$1"
  local sql="$2"
  local expected="$3"
  if psql_cmd -q -c "$sql" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if [[ "$(<"$ERROR_FILE")" != *"$expected"* ]]; then
    echo "$label failed for the wrong reason; expected: $expected" >&2
    cat "$ERROR_FILE" >&2
    exit 1
  fi
}

insert_exact_ledger() {
  local version="$1"
  local name="$2"
  local hash="$3"
  local file="$4"
  local body
  body="$(
    dd if="$file" status=none
    printf '%s' '__ARENA_LEDGER_SENTINEL__'
  )"
  body="${body%__ARENA_LEDGER_SENTINEL__}"
  psql_cmd -q \
    -v version="$version" \
    -v name="$name" \
    -v hash="$hash" \
    -v body="$body" <<'SQL'
INSERT INTO supabase_migrations.schema_migrations (
  version, statements, name, created_by, idempotency_key
) VALUES (
  :'version', ARRAY[:'body'], :'name', 'codex',
  'codex:' || :'version' || ':' || :'hash'
);
SQL
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd -q -c 'CREATE DATABASE metric_lineage_base;'
export TEST_DATABASE=metric_lineage_base

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticator NOLOGIN;
CREATE ROLE leaked_default_role NOLOGIN;
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE SCHEMA arena;
CREATE SCHEMA extensions;
CREATE SCHEMA supabase_migrations;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

CREATE TABLE supabase_migrations.schema_migrations (
  version text PRIMARY KEY,
  statements text[] NOT NULL,
  name text NOT NULL,
  created_by text NOT NULL,
  idempotency_key text NOT NULL
);

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text NOT NULL,
  adapter_slug text NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL,
  currency text NOT NULL,
  fetch_region text NOT NULL
);

CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL
);

CREATE TABLE arena.raw_objects (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL,
  job_type text NOT NULL,
  trader_id bigint,
  timeframe integer NOT NULL,
  fetched_at timestamptz NOT NULL,
  storage_path text NOT NULL,
  content_hash text NOT NULL,
  quarantined boolean NOT NULL DEFAULT false,
  meta jsonb NOT NULL DEFAULT '{}',
  source_run_id text,
  trust_artifact_role text
);

CREATE UNIQUE INDEX uidx_raw_population_manifest_per_run
  ON arena.raw_objects (source_run_id)
  WHERE source_run_id IS NOT NULL
    AND trust_artifact_role = 'population_manifest';
CREATE UNIQUE INDEX uidx_raw_tier_a_population_per_run
  ON arena.raw_objects (source_run_id)
  WHERE source_run_id IS NOT NULL
    AND trust_artifact_role = 'source_payload'
    AND job_type = 'tier_a'
    AND trader_id IS NULL;

CREATE TABLE arena.raw_object_gc_queue (
  raw_object_id bigint NOT NULL UNIQUE,
  storage_path text PRIMARY KEY,
  content_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error text
);
ALTER TABLE arena.raw_object_gc_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE arena.raw_object_gc_queue
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, DELETE ON TABLE arena.raw_object_gc_queue TO service_role;
GRANT INSERT (raw_object_id, storage_path, content_hash)
  ON TABLE arena.raw_object_gc_queue TO service_role;
GRANT UPDATE (attempts, last_attempt_at, last_error)
  ON TABLE arena.raw_object_gc_queue TO service_role;

CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL,
  timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL,
  actual_count integer NOT NULL,
  count_check_passed boolean NOT NULL,
  is_derived boolean NOT NULL,
  raw_object_id bigint
);

CREATE TABLE arena.metric_source_contracts (
  id bigint PRIMARY KEY,
  active boolean NOT NULL,
  source_id smallint NOT NULL,
  contract_version text NOT NULL,
  metric text NOT NULL,
  field_path text NOT NULL,
  provenance text NOT NULL,
  methodology_version text NOT NULL,
  metric_set_id text NOT NULL,
  timeframes smallint[] NOT NULL,
  currencies text[] NOT NULL,
  value_unit text NOT NULL,
  allow_derived_population boolean NOT NULL,
  required_raw_roles text[] NOT NULL,
  source_payload_scope text NOT NULL,
  max_freshness interval NOT NULL,
  max_window_end_lag interval NOT NULL
);

CREATE TABLE arena.metric_trust_runs (
  source_run_id text PRIMARY KEY,
  source_id smallint NOT NULL,
  timeframe smallint NOT NULL,
  snapshot_id bigint NOT NULL,
  snapshot_scraped_at timestamptz NOT NULL,
  population_raw_object_id bigint NOT NULL,
  manifest_raw_object_id bigint NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  reported_population integer,
  fetched_population integer NOT NULL,
  caller_limited boolean NOT NULL,
  acquisition_state text NOT NULL,
  population_state text NOT NULL
);

CREATE TABLE arena.metric_trust_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contract_id bigint NOT NULL,
  trader_id bigint NOT NULL,
  source_id smallint NOT NULL,
  snapshot_id bigint NOT NULL,
  snapshot_scraped_at timestamptz NOT NULL,
  source_run_id text NOT NULL,
  source_contract_version text NOT NULL,
  timeframe smallint NOT NULL,
  metric text NOT NULL,
  field_path text NOT NULL,
  provenance text NOT NULL,
  methodology_version text NOT NULL,
  value numeric,
  value_unit text NOT NULL,
  currency text NOT NULL,
  source_as_of timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  quality text NOT NULL,
  history_state text NOT NULL,
  price_state text NOT NULL,
  cost_basis_state text NOT NULL,
  population_state text NOT NULL,
  window_state text NOT NULL,
  unit_state text NOT NULL,
  freshness_state text NOT NULL,
  blocking_reasons jsonb NOT NULL,
  evaluator_version text NOT NULL DEFAULT 'metric-trust@1',
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE TABLE arena.metric_trust_artifacts (
  observation_id bigint NOT NULL,
  role text NOT NULL,
  raw_object_id bigint NOT NULL,
  content_hash text NOT NULL
);

CREATE VIEW arena.metric_rankable_observations
WITH (security_invoker = true)
AS
SELECT observation.*, 'test-metric-set'::text AS metric_set_id
FROM arena.metric_trust_observations AS observation;
REVOKE ALL ON TABLE arena.metric_rankable_observations
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE arena.metric_rankable_observations TO service_role;

CREATE TABLE arena.leaderboard_capture_contracts (
  source_id smallint NOT NULL,
  capture_contract text NOT NULL,
  adapter_slug text NOT NULL,
  attempt_binding_contract text NOT NULL,
  requires_runner_git_sha boolean NOT NULL
);

CREATE TABLE arena.leaderboard_acquisition_attempts (
  attempt_seq bigint PRIMARY KEY,
  source_id smallint NOT NULL,
  timeframe smallint NOT NULL
);

CREATE TABLE arena.leaderboard_acquisition_outcomes (
  attempt_seq bigint PRIMARY KEY,
  source_slug text NOT NULL,
  adapter_slug text NOT NULL,
  source_status text NOT NULL,
  source_serving_mode text NOT NULL,
  source_currency text NOT NULL,
  source_fetch_region text NOT NULL,
  worker_region text,
  capture_contract text NOT NULL,
  attempt_binding_contract text NOT NULL,
  attempt_id uuid NOT NULL,
  observation_cycle_id text,
  runner_git_sha text,
  recorded_started_at timestamptz NOT NULL,
  terminal_state text NOT NULL,
  acquisition_state text NOT NULL,
  population_state text NOT NULL,
  capture_evidence_state text NOT NULL,
  termination_reason text,
  capture_started_at timestamptz,
  capture_completed_at timestamptz,
  source_run_id text,
  source_payload_raw_object_id bigint,
  source_payload_content_hash text,
  source_payload_storage_path text,
  manifest_raw_object_id bigint,
  manifest_content_hash text,
  manifest_storage_path text,
  diagnostic_raw_object_id bigint,
  diagnostic_content_hash text,
  diagnostic_storage_path text,
  reported_population integer,
  population_report_state text,
  source_page_count integer,
  observed_population integer,
  accepted_population integer,
  rejected_row_count integer,
  deduplicated_row_count integer,
  caller_limited boolean NOT NULL,
  safety_limited boolean NOT NULL,
  failure_stage text,
  reason_code text
);

CREATE VIEW arena.leaderboard_acquisition_attempt_states
WITH (security_invoker = true) AS
SELECT
  outcome.*,
  attempt.source_id,
  attempt.timeframe
FROM arena.leaderboard_acquisition_outcomes AS outcome
JOIN arena.leaderboard_acquisition_attempts AS attempt
  ON attempt.attempt_seq = outcome.attempt_seq;

CREATE VIEW arena.latest_terminal_leaderboard_acquisitions
WITH (security_invoker = true) AS
SELECT DISTINCT ON (state.source_id, state.timeframe) state.*
FROM arena.leaderboard_acquisition_attempt_states AS state
ORDER BY state.source_id, state.timeframe, state.attempt_seq DESC;

CREATE TABLE arena.leaderboard_score_input_manifests (
  manifest_id uuid PRIMARY KEY,
  manifest jsonb NOT NULL
);
ALTER TABLE arena.leaderboard_score_input_manifests
  ADD CONSTRAINT leaderboard_score_input_manifest_rank_eligible_pnl
  CHECK (
    (
      pg_catalog.jsonb_typeof(manifest->'inputs') = 'array'
      AND pg_catalog.jsonb_array_length(manifest->'inputs') =
          pg_catalog.jsonb_array_length(
            pg_catalog.jsonb_path_query_array(
              manifest->'inputs',
              '$[*] ? (@.pnl.type() == "number")'::pg_catalog.jsonpath
            )
          )
    ) IS TRUE
  );

CREATE FUNCTION arena.encode_leaderboard_score_input_manifest_v1(
  p_period text, p_source_bundle_digest text, p_score_rows_sha256 text,
  p_physical_boards_sha256 text, p_source_evidence jsonb,
  p_enrichment_contract text, p_enrichment_evidence jsonb,
  p_eligibility_contract text, p_eligibility_evidence jsonb,
  p_inputs jsonb, p_valid_until timestamptz
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_numeric_pnl jsonb;
BEGIN
  v_numeric_pnl := pg_catalog.jsonb_path_query_array(
    p_inputs,
    '$[*] ? (@.pnl.type() == "number")'::pg_catalog.jsonpath
  );
  PERFORM pg_catalog.jsonb_build_object('pnl', 0);
  RETURN pg_catalog.jsonb_build_object('inputs', v_numeric_pnl);
END
$function$;
CREATE FUNCTION arena.seal_leaderboard_score_input_manifest_v1(
  p_period text, p_source_bundle_digest text, p_score_rows_sha256 text,
  p_physical_boards_sha256 text, p_source_evidence jsonb,
  p_enrichment_contract text, p_enrichment_evidence jsonb,
  p_eligibility_contract text, p_eligibility_evidence jsonb,
  p_inputs jsonb, p_valid_until timestamptz
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_manifest jsonb;
BEGIN
  v_manifest := arena.encode_leaderboard_score_input_manifest_v1(
    p_period, p_source_bundle_digest, p_score_rows_sha256,
    p_physical_boards_sha256, p_source_evidence, p_enrichment_contract,
    p_enrichment_evidence, p_eligibility_contract, p_eligibility_evidence,
    p_inputs, p_valid_until
  );
  INSERT INTO arena.leaderboard_score_input_manifests (manifest_id, manifest)
  VALUES (extensions.gen_random_uuid(), v_manifest);
  RETURN v_manifest;
END
$function$;
CREATE FUNCTION arena.verify_leaderboard_score_input_manifest_v1(p_manifest_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  PERFORM arena.encode_leaderboard_score_input_manifest_v1(
    '', '', '', '', '{}'::jsonb, '', '{}'::jsonb, '', '{}'::jsonb,
    stored.manifest->'inputs', pg_catalog.statement_timestamp()
  )
  FROM arena.leaderboard_score_input_manifests AS stored
  WHERE stored.manifest_id = p_manifest_id;
  RETURN '{}'::jsonb;
END
$function$;
ALTER FUNCTION arena.encode_leaderboard_score_input_manifest_v1(
  text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb, timestamptz
) OWNER TO postgres;
ALTER FUNCTION arena.seal_leaderboard_score_input_manifest_v1(
  text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb, timestamptz
) OWNER TO postgres;
ALTER FUNCTION arena.verify_leaderboard_score_input_manifest_v1(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.encode_leaderboard_score_input_manifest_v1(
  text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.seal_leaderboard_score_input_manifest_v1(
  text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.verify_leaderboard_score_input_manifest_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION arena.start_leaderboard_acquisition_attempt(
  uuid, integer, integer, text, text, integer, text, text, text
)
RETURNS void LANGUAGE sql AS 'SELECT';
CREATE FUNCTION arena.finish_leaderboard_acquisition_attempt(
  uuid, text, text, text, text, text, timestamptz, timestamptz, text,
  bigint, bigint, bigint, integer, text, integer, integer, text,
  integer, integer, integer, integer, boolean, boolean, text, text
)
RETURNS void LANGUAGE sql AS 'SELECT';

CREATE FUNCTION arena.serialize_leaderboard_terminal_publication()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  v_source_id integer;
  v_timeframe integer;
BEGIN
  SELECT attempt.source_id, attempt.timeframe
    INTO STRICT v_source_id, v_timeframe
    FROM arena.leaderboard_acquisition_attempts AS attempt
   WHERE attempt.attempt_seq = NEW.attempt_seq;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena.leaderboard-acquisition-source:' ||
      v_source_id::text || ':' || v_timeframe::text,
      0
    )
  );
  RETURN NEW;
END
$function$;
ALTER FUNCTION arena.serialize_leaderboard_terminal_publication() OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.serialize_leaderboard_terminal_publication() FROM PUBLIC;
CREATE TRIGGER leaderboard_acquisition_outcomes_serialize_terminal_publication
BEFORE INSERT ON arena.leaderboard_acquisition_outcomes
FOR EACH ROW EXECUTE FUNCTION arena.serialize_leaderboard_terminal_publication();

CREATE FUNCTION arena.lock_leaderboard_acquisition_source_window(integer, integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s' AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena.leaderboard-acquisition-source:' || $1::text || ':' || $2::text,
      0
    )
  );
END
$function$;
ALTER FUNCTION arena.lock_leaderboard_acquisition_source_window(integer, integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.lock_leaderboard_acquisition_source_window(integer, integer)
  FROM PUBLIC;

CREATE FUNCTION arena.validate_metric_trust_attempt_outcome_authority()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s' AS $function$
BEGIN
  PERFORM arena.lock_leaderboard_acquisition_source_window(
    NEW.source_id,
    NEW.timeframe
  );
  PERFORM 1
    FROM arena.latest_terminal_leaderboard_acquisitions AS terminal
   WHERE terminal.source_id = NEW.source_id
     AND terminal.timeframe = NEW.timeframe;
  RETURN NEW;
END
$function$;
ALTER FUNCTION arena.validate_metric_trust_attempt_outcome_authority() OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.validate_metric_trust_attempt_outcome_authority() FROM PUBLIC;
CREATE TRIGGER metric_trust_runs_attempt_outcome_authority_before_insert
BEFORE INSERT ON arena.metric_trust_runs
FOR EACH ROW EXECUTE FUNCTION arena.validate_metric_trust_attempt_outcome_authority();

INSERT INTO arena.sources VALUES
  (1, 'binance_futures', 'binance', 'active', 'serving', 'USDT', 'vps_sg');
INSERT INTO arena.traders VALUES (10, 1);
INSERT INTO arena.leaderboard_capture_contracts VALUES (
  1,
  'arena.ingest.leaderboard-acquisition-manifest@3',
  'binance',
  'arena.ingest.leaderboard-acquisition-attempt-binding@1',
  true
);

INSERT INTO arena.raw_objects VALUES
  (
    1, 1, 'tier_a', NULL, 30, statement_timestamp(), 'run-v2/source.json',
    repeat('a', 64), false,
    '{"pageCount":4,"parserPageCount":2,"parserSourcePageOrdinals":[1,3],"raw_integrity":{"hash_algorithm":"sha256","hash_scope":"json_utf8"}}',
    repeat('b', 64), 'source_payload'
  ),
  (
    2, 1, 'tier_a_manifest', NULL, 30, statement_timestamp(), 'run-v2/manifest.json',
    repeat('b', 64), false,
    '{"data_contract":"arena.ingest.leaderboard-acquisition-manifest@2","raw_integrity":{"hash_algorithm":"sha256","hash_scope":"json_utf8"}}',
    repeat('b', 64), 'population_manifest'
  ),
  (
    3, 1, 'tier_a', NULL, 30, statement_timestamp(), 'run-v3/source.json',
    repeat('d', 64), false,
    '{"pageCount":4,"parserPageCount":2,"parserSourcePageOrdinals":[1,3],"raw_integrity":{"hash_algorithm":"sha256","hash_scope":"json_utf8"}}',
    repeat('c', 64), 'source_payload'
  ),
  (
    4, 1, 'tier_a_manifest', NULL, 30, statement_timestamp(), 'run-v3/manifest.json',
    repeat('c', 64), false,
    '{"data_contract":"arena.ingest.leaderboard-acquisition-manifest@3","observation_cycle_id":"cycle-v3","acquisition_attempt":{"binding_contract":"arena.ingest.leaderboard-acquisition-attempt-binding@1","attempt_id":"00000000-0000-0000-0000-000000000001","attempt_seq":"1","runner_git_sha":"0123456789abcdef0123456789abcdef01234567"},"raw_integrity":{"hash_algorithm":"sha256","hash_scope":"json_utf8"}}',
    repeat('c', 64), 'population_manifest'
  );

INSERT INTO arena.leaderboard_snapshots VALUES
  (100, 1, 30, statement_timestamp(), 1, true, false, 1),
  (101, 1, 30, statement_timestamp(), 1, true, false, 3);
INSERT INTO arena.metric_source_contracts VALUES (
  1, true, 1, '1', 'roi', 'data.list[].roi', 'source_reported',
  'native', 'test-set', '{30}', '{USDT}', 'percent', false,
  '{}', 'population_snapshot', interval '6 hours', interval '5 minutes'
);
INSERT INTO arena.metric_trust_runs VALUES
  (
    repeat('b', 64), 1, 30, 100,
    (SELECT scraped_at FROM arena.leaderboard_snapshots WHERE id = 100),
    1, 2, statement_timestamp() - interval '2 minutes',
    statement_timestamp() - interval '1 minute', 1, 1, false,
    'complete', 'verified'
  ),
  (
    repeat('c', 64), 1, 30, 101,
    (SELECT scraped_at FROM arena.leaderboard_snapshots WHERE id = 101),
    3, 4, statement_timestamp() - interval '2 minutes',
    statement_timestamp() - interval '1 minute', 1, 1, false,
    'complete', 'verified'
  );

INSERT INTO arena.leaderboard_acquisition_attempts VALUES (1, 1, 30);
INSERT INTO arena.leaderboard_acquisition_outcomes (
  attempt_seq, source_slug, adapter_slug, source_status,
  source_serving_mode, source_currency, source_fetch_region, worker_region,
  capture_contract, attempt_binding_contract, attempt_id,
  observation_cycle_id, runner_git_sha, recorded_started_at, terminal_state,
  acquisition_state, population_state, capture_evidence_state,
  termination_reason, capture_started_at, capture_completed_at, source_run_id,
  source_payload_raw_object_id, source_payload_content_hash,
  source_payload_storage_path, manifest_raw_object_id, manifest_content_hash,
  manifest_storage_path, diagnostic_raw_object_id, diagnostic_content_hash,
  diagnostic_storage_path, reported_population, population_report_state,
  source_page_count, observed_population, accepted_population,
  rejected_row_count, deduplicated_row_count, caller_limited, safety_limited,
  failure_stage, reason_code
)
SELECT
  1, 'binance_futures', 'binance', 'active', 'serving', 'USDT', 'vps_sg',
  'vps_sg', 'arena.ingest.leaderboard-acquisition-manifest@3',
  'arena.ingest.leaderboard-acquisition-attempt-binding@1',
  '00000000-0000-0000-0000-000000000001'::uuid, 'cycle-v3',
  '0123456789abcdef0123456789abcdef01234567', acquisition.started_at,
  'complete', 'complete', 'verified', 'verified', 'exhausted',
  acquisition.started_at, acquisition.completed_at, acquisition.source_run_id,
  3, repeat('d', 64), 'run-v3/source.json', 4, repeat('c', 64),
  'run-v3/manifest.json', NULL, NULL, NULL, 1, 'consistent', 3, 1, 1,
  0, 0, false, false, NULL, NULL
FROM arena.metric_trust_runs AS acquisition
WHERE acquisition.source_run_id = repeat('c', 64);

GRANT USAGE ON SCHEMA arena TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA arena TO service_role;
ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO leaked_default_role;
ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO authenticator;
SQL

for prerequisite in "${PREREQUISITES[@]}"; do
  IFS='|' read -r version name hash filename <<<"$prerequisite"
  actual_hash="$(shasum -a 256 "$ROOT_DIR/supabase/migrations/$filename" | awk '{print $1}')"
  if [[ "$actual_hash" != "$hash" ]]; then
    echo "immutable prerequisite hash drifted: $filename ($actual_hash)" >&2
    exit 1
  fi
  insert_exact_ledger "$version" "$name" "$hash" "$ROOT_DIR/supabase/migrations/$filename"
done

RELEASE_SHA256="$(shasum -a 256 "$MIGRATION" | awk '{print $1}')"
QUARANTINED_SHA256="$(shasum -a 256 "$QUARANTINED_MIGRATION" | awk '{print $1}')"
if [[ "$QUARANTINED_SHA256" != '93c512791e8bb7beb00742c7b65c6d79ecdf79ea49e26a3d67c3b3c438ae42cf' ]]; then
  echo "quarantined 054 bytes drifted: $QUARANTINED_SHA256" >&2
  exit 1
fi

unset TEST_DATABASE
psql_cmd -q <<'SQL'
CREATE DATABASE lineage_absent TEMPLATE metric_lineage_base;
CREATE DATABASE lineage_exact_054 TEMPLATE metric_lineage_base;
CREATE DATABASE lineage_partial TEMPLATE metric_lineage_base;
SQL

# A split ledger/object state must fail before any forward-repair object lands.
export TEST_DATABASE=lineage_partial
psql_cmd -q -c 'ALTER TABLE arena.metric_trust_observations ADD COLUMN source_page_ordinal integer;'
if psql_cmd -q -f "$MIGRATION" >"$ERROR_FILE" 2>&1; then
  echo 'partial 054 object state unexpectedly succeeded' >&2
  exit 1
fi
if [[ "$(<"$ERROR_FILE")" != *'metric-trust 054 ledger/object state is neither wholly absent nor exact'* ]]; then
  echo 'partial 054 object state failed for the wrong reason' >&2
  cat "$ERROR_FILE" >&2
  exit 1
fi

# State A: 054 ledger and objects are wholly absent. Preserve one preexisting
# verified row so @2 readiness proves it counts untrusted NULL lineage.
export TEST_DATABASE=lineage_absent
psql_cmd -q <<'SQL'
INSERT INTO arena.metric_trust_observations (
  contract_id, trader_id, source_id, snapshot_id, snapshot_scraped_at,
  source_run_id, source_contract_version, timeframe, metric, field_path,
  provenance, methodology_version, value, value_unit, currency,
  source_as_of, valid_until, window_start, window_end, quality,
  history_state, price_state, cost_basis_state, population_state,
  window_state, unit_state, freshness_state, blocking_reasons
)
SELECT
  1, 10, 1, 100, snapshot.scraped_at, repeat('b', 64), '1', 30,
  'roi', 'data.list[].roi', 'source_reported', 'native', 10, 'percent',
  'USDT', acquisition.completed_at, statement_timestamp() + interval '1 hour',
  acquisition.completed_at - interval '30 days', acquisition.completed_at,
  'complete', 'source_owned', 'source_owned', 'source_owned', 'verified',
  'verified', 'verified', 'verified', '[]'
FROM arena.leaderboard_snapshots AS snapshot
JOIN arena.metric_trust_runs AS acquisition ON acquisition.snapshot_id = snapshot.id
WHERE snapshot.id = 100;
SQL
psql_cmd -q -f "$MIGRATION"
insert_exact_ledger \
  '20260722055000' \
  'metric_trust_source_page_lineage_forward_repair' \
  "$RELEASE_SHA256" \
  "$MIGRATION"

ABSENT_LEGACY="$(psql_cmd -Atqc "
  SELECT
    (result->>'contract') || '|' || (result->>'ready') || '|' ||
    (result->>'legacy_complete_verified_count') || '|' ||
    pg_catalog.jsonb_array_length(result->'missing') || '|' ||
    (result->>'source_page_lineage_column') || '|' ||
    (result->>'release_migration_sha256')
  FROM (SELECT public.arena_metric_trust_release_readiness() AS result) AS readiness;
")"
if [[ "$ABSENT_LEGACY" != "arena.metric-trust-release-readiness@2|false|1|0|true|$RELEASE_SHA256" ]]; then
  echo "absent-state legacy lineage did not fail closed: $ABSENT_LEGACY" >&2
  psql_cmd -Atqc 'SELECT public.arena_metric_trust_release_readiness();' >&2
  exit 1
fi

# A NULL ordinal from an old writer must commit only after an atomic downgrade.
psql_cmd -q <<'SQL'
INSERT INTO arena.metric_trust_observations (
  contract_id, trader_id, source_id, snapshot_id, snapshot_scraped_at,
  source_run_id, source_contract_version, timeframe, metric, field_path,
  provenance, methodology_version, value, value_unit, currency,
  source_as_of, valid_until, window_start, window_end, quality,
  history_state, price_state, cost_basis_state, population_state,
  window_state, unit_state, freshness_state, blocking_reasons
)
SELECT
  1, 10, 1, 100, snapshot.scraped_at, repeat('b', 64), '1', 30,
  'roi', 'data.list[].roi', 'source_reported', 'native', 11, 'percent',
  'USDT', acquisition.completed_at, statement_timestamp() + interval '1 hour',
  acquisition.completed_at - interval '30 days', acquisition.completed_at,
  'complete', 'source_owned', 'source_owned', 'source_owned', 'verified',
  'verified', 'verified', 'verified', '{"unexpected":"shape"}'
FROM arena.leaderboard_snapshots AS snapshot
JOIN arena.metric_trust_runs AS acquisition ON acquisition.snapshot_id = snapshot.id
WHERE snapshot.id = 100;
SQL
DOWNGRADED="$(psql_cmd -Atqc "
  SELECT quality || '|' || freshness_state || '|' ||
         COALESCE(blocking_reasons->0->>'code', '')
  FROM arena.metric_trust_observations
  WHERE value = 11;
")"
if [[ "$DOWNGRADED" != 'unknown|unknown|source_page_lineage_missing' ]]; then
  echo "old-writer NULL lineage was not downgraded safely: $DOWNGRADED" >&2
  exit 1
fi

# Non-contiguous parser membership: 3 succeeds while in-range non-member 2
# fails. This also proves canonical order/member validation in the trigger.
psql_cmd -q <<'SQL'
INSERT INTO arena.metric_trust_observations (
  contract_id, trader_id, source_id, snapshot_id, snapshot_scraped_at,
  source_run_id, source_contract_version, timeframe, metric, field_path,
  provenance, methodology_version, value, value_unit, currency,
  source_as_of, valid_until, window_start, window_end, quality,
  history_state, price_state, cost_basis_state, population_state,
  window_state, unit_state, freshness_state, blocking_reasons,
  source_page_ordinal
)
SELECT
  1, 10, 1, 100, snapshot.scraped_at, repeat('b', 64), '1', 30,
  'roi', 'data.list[].roi', 'source_reported', 'native', 12, 'percent',
  'USDT', acquisition.completed_at, statement_timestamp() + interval '1 hour',
  acquisition.completed_at - interval '30 days', acquisition.completed_at,
  'unknown', 'source_owned', 'source_owned', 'source_owned', 'verified',
  'unknown', 'verified', 'verified', '[{"code":"window","state":"unknown"}]', 3
FROM arena.leaderboard_snapshots AS snapshot
JOIN arena.metric_trust_runs AS acquisition ON acquisition.snapshot_id = snapshot.id
WHERE snapshot.id = 100;
SQL
expect_failure \
  'in-range non-member source-page ordinal' \
  "INSERT INTO arena.metric_trust_observations (
     contract_id, trader_id, source_id, snapshot_id, snapshot_scraped_at,
     source_run_id, source_contract_version, timeframe, metric, field_path,
     provenance, methodology_version, value, value_unit, currency,
     source_as_of, valid_until, window_start, window_end, quality,
     history_state, price_state, cost_basis_state, population_state,
     window_state, unit_state, freshness_state, blocking_reasons,
     source_page_ordinal)
   SELECT 1, 10, 1, 100, snapshot.scraped_at, repeat('b', 64), '1', 30,
     'roi', 'data.list[].roi', 'source_reported', 'native', 13, 'percent',
     'USDT', acquisition.completed_at, statement_timestamp() + interval '1 hour',
     acquisition.completed_at - interval '30 days', acquisition.completed_at,
     'unknown', 'source_owned', 'source_owned', 'source_owned', 'verified',
     'unknown', 'verified', 'verified', '[{\"code\":\"window\",\"state\":\"unknown\"}]', 2
   FROM arena.leaderboard_snapshots AS snapshot
   JOIN arena.metric_trust_runs AS acquisition ON acquisition.snapshot_id = snapshot.id
   WHERE snapshot.id = 100;" \
  'source-page ordinal is not a parser input member'

# Explicit quarantine clears the append-only legacy row without rewriting it.
psql_cmd -q -c 'UPDATE arena.raw_objects SET quarantined = true WHERE id = 1;'
ABSENT_READY="$(psql_cmd -Atqc "
  SELECT (result->>'ready') || '|' || (result->>'legacy_complete_verified_count') || '|' ||
         pg_catalog.jsonb_array_length(result->'missing')
  FROM (SELECT public.arena_metric_trust_release_readiness() AS result) AS readiness;
")"
if [[ "$ABSENT_READY" != 'true|0|0' ]]; then
  echo "absent-state quarantine did not clear @2 readiness: $ABSENT_READY" >&2
  exit 1
fi

# Make the v3 terminal exact, publish one rankable observation, then corrupt
# both scalar and array metadata. The view must return zero rather than throw,
# while readiness counts the still-complete observation and fails closed.
psql_cmd -q -c 'UPDATE arena.leaderboard_acquisition_outcomes SET source_page_count = 4 WHERE attempt_seq = 1;'
psql_cmd -q <<'SQL'
INSERT INTO arena.metric_trust_observations (
  contract_id, trader_id, source_id, snapshot_id, snapshot_scraped_at,
  source_run_id, source_contract_version, timeframe, metric, field_path,
  provenance, methodology_version, value, value_unit, currency,
  source_as_of, valid_until, window_start, window_end, quality,
  history_state, price_state, cost_basis_state, population_state,
  window_state, unit_state, freshness_state, blocking_reasons,
  source_page_ordinal
)
SELECT
  1, 10, 1, 101, snapshot.scraped_at, repeat('c', 64), '1', 30,
  'roi', 'data.list[].roi', 'source_reported', 'native', 21, 'percent',
  'USDT', acquisition.completed_at, statement_timestamp() + interval '1 hour',
  acquisition.completed_at - interval '30 days', acquisition.completed_at,
  'complete', 'source_owned', 'source_owned', 'source_owned', 'verified',
  'verified', 'verified', 'verified', '[]', 3
FROM arena.leaderboard_snapshots AS snapshot
JOIN arena.metric_trust_runs AS acquisition ON acquisition.snapshot_id = snapshot.id
WHERE snapshot.id = 101;
SQL
if [[ "$(psql_cmd -Atqc 'SELECT count(*) FROM arena.metric_rankable_observations WHERE value = 21;')" != '1' ]]; then
  echo 'exact v3 source-page lineage was not rankable' >&2
  exit 1
fi
psql_cmd -q <<'SQL'
INSERT INTO arena.leaderboard_acquisition_attempts VALUES (2, 1, 30);
INSERT INTO arena.leaderboard_acquisition_outcomes
SELECT newer.*
FROM arena.leaderboard_acquisition_outcomes AS prior
CROSS JOIN LATERAL pg_catalog.jsonb_populate_record(
  NULL::arena.leaderboard_acquisition_outcomes,
  pg_catalog.to_jsonb(prior) || pg_catalog.jsonb_build_object(
    'attempt_seq', 2,
    'attempt_id', '00000000-0000-0000-0000-000000000002',
    'observation_cycle_id', 'cycle-v3-newer',
    'source_run_id', repeat('e', 64)
  )
) AS newer
WHERE prior.attempt_seq = 1;
UPDATE arena.sources SET fetch_region = 'vps_us' WHERE id = 1;
SQL
HISTORICAL_TRUST="$(psql_cmd -Atqc "
  SELECT
    (SELECT count(*) FROM arena.metric_rankable_observations WHERE value = 21) || '|' ||
    (result->>'ready') || '|' || (result->>'legacy_complete_verified_count')
  FROM (SELECT public.arena_metric_trust_release_readiness() AS result) AS readiness;
")"
if [[ "$HISTORICAL_TRUST" != '0|true|0' ]]; then
  echo "newer terminal invalidated trusted historical lineage: $HISTORICAL_TRUST" >&2
  exit 1
fi
psql_cmd -q -c "
  UPDATE arena.raw_objects
     SET meta = meta ||
       '{\"pageCount\":\"broken\",\"parserPageCount\":\"2147483648\",\"parserSourcePageOrdinals\":{\"bad\":true}}'::jsonb
   WHERE id = 3;
"
MALFORMED="$(psql_cmd -Atqc "
  SELECT
    (SELECT count(*) FROM arena.metric_rankable_observations WHERE value = 21) || '|' ||
    (result->>'ready') || '|' || (result->>'legacy_complete_verified_count')
  FROM (SELECT public.arena_metric_trust_release_readiness() AS result) AS readiness;
")"
if [[ "$MALFORMED" != '0|false|1' ]]; then
  echo "malformed parser metadata did not fail closed without throwing: $MALFORMED" >&2
  exit 1
fi
psql_cmd -q -c 'UPDATE arena.raw_objects SET quarantined = true WHERE id = 3;'
if [[ "$(psql_cmd -Atqc "
  SELECT (result->>'ready') || '|' || (result->>'legacy_complete_verified_count')
  FROM (SELECT public.arena_metric_trust_release_readiness() AS result) AS readiness;
")" != 'true|0' ]]; then
  echo 'malformed raw quarantine did not restore readiness' >&2
  exit 1
fi

psql_cmd -q -c 'REVOKE USAGE ON SCHEMA arena FROM service_role;'
if [[ "$(psql_cmd -Atqc "
  SELECT (result->>'ready') || '|' || (result->'missing' ? 'metric_trust_acl_contract')
  FROM (SELECT public.arena_metric_trust_release_readiness() AS result) AS readiness;
")" != 'false|true' ]]; then
  echo 'arena schema USAGE revocation did not fail readiness closed' >&2
  exit 1
fi
psql_cmd -q -c 'GRANT USAGE ON SCHEMA arena TO service_role;'
psql_cmd -q -c 'REVOKE SELECT ON arena.raw_objects FROM service_role;'
if [[ "$(psql_cmd -Atqc "
  SELECT (result->>'ready') || '|' || (result->'missing' ? 'metric_trust_acl_contract')
  FROM (SELECT public.arena_metric_trust_release_readiness() AS result) AS readiness;
")" != 'false|true' ]]; then
  echo 'raw_objects SELECT revocation did not fail readiness closed' >&2
  exit 1
fi
psql_cmd -q -c 'GRANT SELECT ON arena.raw_objects TO service_role;'
psql_cmd -q -c 'ALTER ROLE service_role NOBYPASSRLS;'
if [[ "$(psql_cmd -Atqc "
  SELECT (result->>'ready') || '|' || (result->'missing' ? 'metric_trust_acl_contract')
  FROM (SELECT public.arena_metric_trust_release_readiness() AS result) AS readiness;
")" != 'false|true' ]]; then
  echo 'service_role NOBYPASSRLS did not fail readiness closed' >&2
  exit 1
fi
psql_cmd -q -c 'ALTER ROLE service_role BYPASSRLS;'
if [[ "$(psql_cmd -Atqc "
  SELECT (result->>'ready')
  FROM (SELECT public.arena_metric_trust_release_readiness() AS result) AS readiness;
")" != 'true' ]]; then
  echo 'restored security-invoker dependency ACLs did not restore readiness' >&2
  exit 1
fi
psql_cmd -q -c 'SET ROLE service_role; SELECT count(*) FROM arena.metric_rankable_observations; RESET ROLE;'
psql_cmd -q <<'SQL'
ALTER TABLE arena.leaderboard_score_input_manifests
  DROP CONSTRAINT leaderboard_score_input_manifest_rank_eligible_pnl;
ALTER TABLE arena.leaderboard_score_input_manifests
  ADD CONSTRAINT leaderboard_score_input_manifest_rank_eligible_pnl
  CHECK (
    (
      pg_catalog.jsonb_typeof(manifest->'inputs') = 'array'
      AND pg_catalog.jsonb_array_length(manifest->'inputs') =
          pg_catalog.jsonb_array_length(
            pg_catalog.jsonb_path_query_array(
              manifest->'inputs', '$[*] ? (@.notPnl.type() == "number")'::jsonpath
            )
          )
    ) IS TRUE
  );
SQL
if [[ "$(psql_cmd -Atqc "
  SELECT (result->>'ready') || '|' || (result->'missing' ? 'metric_trust_object_contract')
  FROM (SELECT public.arena_metric_trust_release_readiness() AS result) AS readiness;
")" != 'false|true' ]]; then
  echo 'wrong PnL JSONPath did not fail object attestation closed' >&2
  exit 1
fi
psql_cmd -q <<'SQL'
ALTER TABLE arena.leaderboard_score_input_manifests
  DROP CONSTRAINT leaderboard_score_input_manifest_rank_eligible_pnl;
ALTER TABLE arena.leaderboard_score_input_manifests
  ADD CONSTRAINT leaderboard_score_input_manifest_rank_eligible_pnl
  CHECK (
    (
      pg_catalog.jsonb_typeof(manifest->'inputs') = 'array'
      AND pg_catalog.jsonb_array_length(manifest->'inputs') =
          pg_catalog.jsonb_array_length(
            pg_catalog.jsonb_path_query_array(
              manifest->'inputs', '$[*] ? (@.pnl.type() == "number")'::jsonpath
            )
          )
    ) IS TRUE
  );
SQL
if [[ "$(psql_cmd -Atqc "
  SELECT (result->>'ready')
  FROM (SELECT public.arena_metric_trust_release_readiness() AS result) AS readiness;
")" != 'true' ]]; then
  echo 'restored PnL constraint did not restore object attestation' >&2
  exit 1
fi

# State B: exact 054 bytes and its complete object contract. A weak-054 row can
# carry a non-NULL parser member while disagreeing with the v3 terminal count;
# 055 must hide and count it until its raw evidence is quarantined.
export TEST_DATABASE=lineage_exact_054
psql_cmd -q -f "$QUARANTINED_MIGRATION"
insert_exact_ledger \
  '20260722054000' \
  'metric_trust_source_page_lineage' \
  "$QUARANTINED_SHA256" \
  "$QUARANTINED_MIGRATION"
psql_cmd -q <<'SQL'
INSERT INTO arena.metric_trust_observations (
  contract_id, trader_id, source_id, snapshot_id, snapshot_scraped_at,
  source_run_id, source_contract_version, timeframe, metric, field_path,
  provenance, methodology_version, value, value_unit, currency,
  source_as_of, valid_until, window_start, window_end, quality,
  history_state, price_state, cost_basis_state, population_state,
  window_state, unit_state, freshness_state, blocking_reasons,
  source_page_ordinal
)
SELECT
  1, 10, 1, 101, snapshot.scraped_at, repeat('c', 64), '1', 30,
  'roi', 'data.list[].roi', 'source_reported', 'native', 31, 'percent',
  'USDT', acquisition.completed_at, statement_timestamp() + interval '1 hour',
  acquisition.completed_at - interval '30 days', acquisition.completed_at,
  'complete', 'source_owned', 'source_owned', 'source_owned', 'verified',
  'verified', 'verified', 'verified', '[]', 3
FROM arena.leaderboard_snapshots AS snapshot
JOIN arena.metric_trust_runs AS acquisition ON acquisition.snapshot_id = snapshot.id
WHERE snapshot.id = 101;
SQL
psql_cmd -q -f "$MIGRATION"
insert_exact_ledger \
  '20260722055000' \
  'metric_trust_source_page_lineage_forward_repair' \
  "$RELEASE_SHA256" \
  "$MIGRATION"
EXACT_DRIFT="$(psql_cmd -Atqc "
  SELECT
    (SELECT count(*) FROM arena.metric_rankable_observations WHERE value = 31) || '|' ||
    (result->>'ready') || '|' || (result->>'legacy_complete_verified_count') || '|' ||
    pg_catalog.jsonb_array_length(result->'missing')
  FROM (SELECT public.arena_metric_trust_release_readiness() AS result) AS readiness;
")"
if [[ "$EXACT_DRIFT" != '0|false|1|0' ]]; then
  echo "exact-054 v3 terminal drift did not fail closed: $EXACT_DRIFT" >&2
  exit 1
fi
psql_cmd -q -c 'UPDATE arena.raw_objects SET quarantined = true WHERE id = 3;'
if [[ "$(psql_cmd -Atqc "
  SELECT (result->>'ready') || '|' || (result->>'legacy_complete_verified_count')
  FROM (SELECT public.arena_metric_trust_release_readiness() AS result) AS readiness;
")" != 'true|0' ]]; then
  echo 'exact-054 drift quarantine did not restore readiness' >&2
  exit 1
fi

# Finish on state A for output-shape and hostile-default ACL checks.
export TEST_DATABASE=lineage_absent
VIEW_SHAPE="$(psql_cmd -Atqc "
  SELECT pg_catalog.string_agg(attribute.attname, ',' ORDER BY attribute.attnum)
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'arena.metric_rankable_observations'::pg_catalog.regclass
    AND attribute.attnum > 0 AND NOT attribute.attisdropped;
")"
if [[ "$VIEW_SHAPE" == *'source_page_ordinal'* ]] || [[ "$VIEW_SHAPE" != *',metric_set_id' ]]; then
  echo "rankable view output shape changed: $VIEW_SHAPE" >&2
  exit 1
fi

ACL="$(psql_cmd -Atqc "
  SELECT
    pg_catalog.has_function_privilege(
      'service_role', 'public.arena_metric_trust_release_readiness()', 'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'anon', 'public.arena_metric_trust_release_readiness()', 'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'authenticated', 'public.arena_metric_trust_release_readiness()', 'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'authenticator', 'public.arena_metric_trust_release_readiness()', 'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'leaked_default_role', 'public.arena_metric_trust_release_readiness()', 'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'service_role', 'arena.validate_metric_trust_source_page_lineage()', 'EXECUTE'
    );
")"
if [[ "$ACL" != 'true|false|false|false|false|false' ]]; then
  echo "metric-trust lineage ACL drifted: $ACL" >&2
  exit 1
fi
expect_failure \
  'anonymous release-readiness execution' \
  'SET ROLE anon; SELECT public.arena_metric_trust_release_readiness();' \
  'permission denied for function arena_metric_trust_release_readiness'

echo 'metric-trust source-page lineage 055 PostgreSQL 17 proof passed'
