#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for the lane-bound V2 copier authority.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SUBSTRATE="$ROOT_DIR/supabase/migrations/20260804053000_copier_snapshot_publication_substrate.sql"
AUTHORITY="$ROOT_DIR/supabase/migrations/20260804054000_copier_snapshot_publication_authority.sql"
HARDENING="$ROOT_DIR/supabase/migrations/20260804054200_harden_copier_snapshot_receipt_provenance.sql"
LANE_AUTHORITY="$ROOT_DIR/supabase/migrations/20260804054300_copier_snapshot_lane_v2_authority.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo 'This integration proof requires PostgreSQL 17' >&2
  exit 1
fi
for migration in "$SUBSTRATE" "$AUTHORITY" "$HARDENING" "$LANE_AUTHORITY"; do
  if [[ ! -f "$migration" ]]; then
    echo "Required migration not found: $migration" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/copier-snapshot-lane-v2-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((62000 + ($$ % 2000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -220 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

psql_db() {
  local database="$1"
  shift
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d "$database" "$@"
}

assert_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "$label changed: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

expect_failure_contains() {
  local label="$1"
  local needle="$2"
  local sql="$3"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"
  if psql_cmd -v VERBOSITY=verbose -c "$sql" >"$failure_log" 2>&1; then
    echo "$label succeeded unexpectedly" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,180p' "$failure_log" >&2
    exit 1
  fi
}

clone_counter=0
expect_migration_failure_in_clone() {
  local label="$1"
  local needle="$2"
  local template_database="$3"
  local setup_sql="$4"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"
  clone_counter=$((clone_counter + 1))
  local database="lane_drift_${clone_counter}"

  # FILE_COPY checkpoints but emits far less WAL than the default WAL_LOG
  # strategy, keeping the many exact-drift probes bounded on small CI disks.
  psql_cmd -q -c \
    "CREATE DATABASE $database TEMPLATE $template_database STRATEGY FILE_COPY"
  psql_db "$database" -q -c "$setup_sql"
  if psql_db "$database" -q -f "$LANE_AUTHORITY" \
    >"$failure_log" 2>&1; then
    echo "$label succeeded unexpectedly" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,180p' "$failure_log" >&2
    exit 1
  fi
  psql_cmd -q -c "DROP DATABASE $database WITH (FORCE)"
}

wait_for_activity() {
  local label="$1"
  local sql="$2"
  local attempt
  local observed
  for attempt in $(seq 1 120); do
    observed="$(psql_cmd -Atqc "$sql")"
    if [[ "$observed" == 't' || "$observed" == 'true' ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "$label was not observed" >&2
  psql_cmd -x -c \
    "SELECT application_name,state,wait_event_type,wait_event,query FROM pg_catalog.pg_stat_activity WHERE datname=current_database()" \
    >&2 || true
  exit 1
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --username=postgres \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE outsider NOLOGIN NOBYPASSRLS;
CREATE SCHEMA arena AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, arena
  TO anon, authenticated, service_role, outsider;

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL,
  copier_table_depth text NOT NULL,
  currency text NOT NULL
);

CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE arena.raw_objects (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  job_type text NOT NULL,
  trader_id bigint,
  timeframe smallint,
  fetched_at timestamptz NOT NULL,
  storage_path text NOT NULL UNIQUE,
  bytes integer NOT NULL,
  content_hash text NOT NULL,
  quarantined boolean NOT NULL DEFAULT false,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_run_id text,
  trust_artifact_role text,
  CONSTRAINT raw_objects_metric_trust_binding CHECK (
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
  )
);

CREATE TABLE arena.copier_records (
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  ts timestamptz NOT NULL,
  copier_label text,
  copier_pnl numeric,
  copier_invested numeric,
  copy_duration_days integer,
  currency text NOT NULL,
  dedupe_hash text NOT NULL,
  raw jsonb
);

ALTER TABLE arena.raw_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.copier_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA arena
  FROM PUBLIC, anon, authenticated, service_role, outsider;

INSERT INTO arena.sources (
  id, slug, status, serving_mode, copier_table_depth, currency
) VALUES
  (1, 'gate_futures', 'active', 'serving', 'full', 'USDT'),
  (2, 'other_source', 'active', 'serving', 'full', 'USDT');

INSERT INTO arena.traders (
  id, source_id, exchange_trader_id, meta
) VALUES
  (101, 1, 'tier-b-valid', '{}'),
  (102, 1, 'tier-c-valid', '{}'),
  (103, 1, 'negative-cases', '{}'),
  (104, 1, 'legacy-v1', '{}'),
  (105, 1, 'concurrent', '{}'),
  (106, 1, 'claim-first', '{}'),
  (107, 1, 'publication-first', '{}'),
  (108, 1, 'audit-only', '{}'),
  (201, 2, 'wrong-subject', '{}');

CREATE FUNCTION public.arena_copier_aggregate(
  p_source text,
  p_trader text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  -- arena.copier-aggregate-containment@1
  SELECT NULL::jsonb;
$function$;
ALTER FUNCTION public.arena_copier_aggregate(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arena_copier_aggregate(text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.arena_copier_aggregate(text, text)
  TO anon, authenticated, service_role;
SQL

psql_cmd -q -f "$SUBSTRATE"
psql_cmd -q -f "$AUTHORITY"
psql_cmd -q -f "$HARDENING"

# Every catalog shape accepted by the migration is byte-exact. Exercise the
# old-state gate in isolated clones so each drift case leaves the main proof
# database untouched.
psql_cmd -q -c \
  'CREATE DATABASE lane_preflight_base TEMPLATE postgres STRATEGY FILE_COPY'
expect_migration_failure_in_clone \
  'raw-binding-preflight-drift' \
  'RAW metric-trust binding is not the exact old or lane-aware contract' \
  'lane_preflight_base' \
  "ALTER TABLE arena.raw_objects DROP CONSTRAINT raw_objects_metric_trust_binding; ALTER TABLE arena.raw_objects ADD CONSTRAINT raw_objects_metric_trust_binding CHECK (((source_run_id IS NULL AND trust_artifact_role IS NULL) OR (source_run_id ~ '^[0-9a-f]{64}$' AND trust_artifact_role IN ('source_payload','population_manifest','normalization_components','event_history','price_history','opening_inventory'))) AND true);"
expect_migration_failure_in_clone \
  'raw-target-without-v2-preflight-drift' \
  'RAW metric-trust binding is not the exact old or lane-aware contract' \
  'lane_preflight_base' \
  "ALTER TABLE arena.raw_objects DROP CONSTRAINT raw_objects_metric_trust_binding; ALTER TABLE arena.raw_objects ADD CONSTRAINT raw_objects_metric_trust_binding CHECK (((source_run_id IS NULL AND trust_artifact_role IS NULL) OR (source_run_id ~ '^[0-9a-f]{64}$' AND trust_artifact_role IN ('source_payload','population_manifest','normalization_components','event_history','price_history','opening_inventory','copier_audit','copier_snapshot'))) IS TRUE);"
expect_migration_failure_in_clone \
  'reader-v3-without-v2-preflight-drift' \
  'copier reader is not the 054000 bridge or exact lane-aware replay state' \
  'lane_preflight_base' \
  "CREATE OR REPLACE FUNCTION public.arena_copier_aggregate(p_source text,p_trader text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS '/* arena.copier-snapshot-receipt-reader@3 */ SELECT NULL::jsonb';"
expect_migration_failure_in_clone \
  'publication-constraint-preflight-drift' \
  'copier publication constraints are not the exact 054000 pre-state' \
  'lane_preflight_base' \
  "ALTER TABLE arena.copier_snapshot_publications DROP CONSTRAINT copier_snapshot_publications_evidence_contract_check; ALTER TABLE arena.copier_snapshot_publications ADD CONSTRAINT copier_snapshot_publications_evidence_contract_check CHECK (evidence_contract = 'arena.copier-snapshot-publication@1' AND true);"
expect_migration_failure_in_clone \
  'partial-column-preflight-drift' \
  'copier lane V2 authority is partially installed' \
  'lane_preflight_base' \
  'ALTER TABLE arena.copier_snapshot_publications ADD COLUMN acquisition_source_run_id text;'
expect_migration_failure_in_clone \
  'audit-contract-preflight-drift' \
  'copier audit RAW contract is partially installed' \
  'lane_preflight_base' \
  'ALTER TABLE arena.raw_objects ADD CONSTRAINT raw_objects_copier_audit_contract CHECK (true);'
expect_migration_failure_in_clone \
  'v1-job-type-anchor-preflight-drift' \
  'copier V1 compatibility authority lineage or ACL drifted' \
  'lane_preflight_base' \
  "UPDATE pg_catalog.pg_proc SET prosrc=pg_catalog.replace(prosrc,'v_raw.job_type IS DISTINCT FROM ''history:copiers''','v_raw.job_type IS DISTINCT FROM ''history:orders''') WHERE oid='public.publish_copier_snapshot_v1(jsonb)'::pg_catalog.regprocedure;"
expect_migration_failure_in_clone \
  'v1-event-history-anchor-preflight-drift' \
  'copier V1 compatibility authority lineage or ACL drifted' \
  'lane_preflight_base' \
  "UPDATE pg_catalog.pg_proc SET prosrc=pg_catalog.replace(prosrc,'v_raw.trust_artifact_role IS DISTINCT FROM ''event_history''','v_raw.trust_artifact_role IS DISTINCT FROM ''price_history''') WHERE oid='public.publish_copier_snapshot_v1(jsonb)'::pg_catalog.regprocedure;"
expect_migration_failure_in_clone \
  'v1-copier-history-kind-anchor-preflight-drift' \
  'copier V1 compatibility authority lineage or ACL drifted' \
  'lane_preflight_base' \
  "UPDATE pg_catalog.pg_proc SET prosrc=pg_catalog.replace(prosrc,'v_raw.meta->>''history_kind'' IS DISTINCT FROM ''copiers''','v_raw.meta->>''history_kind'' IS DISTINCT FROM ''orders''') WHERE oid='public.publish_copier_snapshot_v1(jsonb)'::pg_catalog.regprocedure;"
expect_migration_failure_in_clone \
  'legacy-copier-prohibition-preflight-drift' \
  'legacy copier event-history prohibition is partially installed' \
  'lane_preflight_base' \
  'ALTER TABLE arena.raw_objects ADD CONSTRAINT raw_objects_legacy_copier_event_history_forbidden CHECK (true);'
expect_migration_failure_in_clone \
  'legacy-copier-event-history-existing-preflight' \
  'requires zero legacy copier event-history RAW objects' \
  'lane_preflight_base' \
  "INSERT INTO arena.raw_objects (id,source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,content_hash,quarantined,meta,source_run_id,trust_artifact_role) VALUES (9001,1,'history:orders',104,NULL,'2026-08-04 11:59:00+00','gate_futures/history/copiers/preflight-kind.json.gz',1,repeat('4',64),false,jsonb_build_object('history_kind','copiers'),repeat('4',64),'event_history');"
expect_migration_failure_in_clone \
  'legacy-copier-job-only-existing-preflight' \
  'requires zero legacy copier event-history RAW objects' \
  'lane_preflight_base' \
  "INSERT INTO arena.raw_objects (id,source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,content_hash,quarantined,meta,source_run_id,trust_artifact_role) VALUES (9002,1,'history:copiers',104,NULL,'2026-08-04 11:59:00+00','gate_futures/history/copiers/preflight-job.json.gz',1,repeat('5',64),false,'{}'::jsonb,repeat('5',64),'event_history');"
expect_migration_failure_in_clone \
  'legacy-copier-surface-only-existing-preflight' \
  'requires zero legacy copier event-history RAW objects' \
  'lane_preflight_base' \
  "INSERT INTO arena.raw_objects (id,source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,content_hash,quarantined,meta,source_run_id,trust_artifact_role) VALUES (9003,1,'history:orders',104,NULL,'2026-08-04 11:59:00+00','gate_futures/history/copiers/preflight-surface.json.gz',1,repeat('6',64),false,jsonb_build_object('history_kind',NULL,'surface','copiers'),repeat('6',64),'event_history');"
expect_migration_failure_in_clone \
  'provenance-column-preflight-drift' \
  'copier lane V2 RAW or 054200 provenance shape drifted' \
  'lane_preflight_base' \
  'ALTER TABLE arena.copier_snapshot_rows ALTER COLUMN source_event_at SET NOT NULL;'
if [[ "${PRINT_COPIER_LANE_CONSTRAINTS:-0}" == '1' ]]; then
  psql_cmd -Atqc "
    SELECT 'v1-definition-sha256|' || encode(
      sha256(convert_to(
        pg_get_functiondef(
          'public.publish_copier_snapshot_v1(jsonb)'::regprocedure
        ),
        'UTF8'
      )),
      'hex'
    );
  "
  psql_cmd -Atqc "
    SELECT conname || E'\\n' || pg_get_constraintdef(oid, false)
    FROM pg_constraint
    WHERE conrelid='arena.copier_snapshot_publications'::regclass
      AND conname IN (
        'copier_snapshot_publications_evidence_contract_check',
        'copier_snapshot_publications_data_contract_check',
        'copier_snapshot_publications_publisher_contract_check',
        'copier_snapshot_publication_authority_version'
      )
    ORDER BY conname;
  "
  psql_cmd -Atqc "
    SELECT conname || E'\\n' || pg_get_constraintdef(oid, false)
    FROM pg_constraint
    WHERE conrelid='arena.raw_objects'::regclass
      AND conname IN (
        'raw_objects_metric_trust_binding',
        'raw_objects_copier_audit_contract',
        'raw_objects_legacy_copier_event_history_forbidden'
      )
    ORDER BY conname;
  "
fi
psql_cmd -q -f "$LANE_AUTHORITY"
psql_cmd -q -c \
  'CREATE DATABASE lane_replay_base TEMPLATE postgres STRATEGY FILE_COPY'
expect_migration_failure_in_clone \
  'lane-aware-constraint-replay-drift' \
  'copier publication constraints are not the exact lane-aware replay state' \
  'lane_replay_base' \
  "ALTER TABLE arena.copier_snapshot_publications DROP CONSTRAINT copier_snapshot_publications_publisher_contract_check; ALTER TABLE arena.copier_snapshot_publications ADD CONSTRAINT copier_snapshot_publications_publisher_contract_check CHECK (publisher_contract IN ('arena.ingest.copier-snapshot-publisher@1','arena.ingest.copier-snapshot-publisher@2') AND true);"
expect_migration_failure_in_clone \
  'audit-contract-replay-drift' \
  'copier audit RAW contract is not the exact lane-aware replay state' \
  'lane_replay_base' \
  "ALTER TABLE arena.raw_objects DROP CONSTRAINT raw_objects_copier_audit_contract; ALTER TABLE arena.raw_objects ADD CONSTRAINT raw_objects_copier_audit_contract CHECK (trust_artifact_role IS DISTINCT FROM 'copier_audit' OR meta->>'surface'='copiers_audit');"
expect_migration_failure_in_clone \
  'legacy-copier-prohibition-replay-drift' \
  'legacy copier event-history prohibition is not the exact replay state' \
  'lane_replay_base' \
  "ALTER TABLE arena.raw_objects DROP CONSTRAINT raw_objects_legacy_copier_event_history_forbidden; ALTER TABLE arena.raw_objects ADD CONSTRAINT raw_objects_legacy_copier_event_history_forbidden CHECK (trust_artifact_role IS DISTINCT FROM 'event_history' OR meta->>'history_kind' IS DISTINCT FROM 'copiers');"
expect_migration_failure_in_clone \
  'reader-v1-with-v2-replay-drift' \
  'copier reader is not the 054000 bridge or exact lane-aware replay state' \
  'lane_replay_base' \
  "CREATE OR REPLACE FUNCTION public.arena_copier_aggregate(p_source text,p_trader text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS '/* arena.copier-snapshot-receipt-reader@1 */ SELECT NULL::jsonb';"
if [[ "${PRINT_COPIER_LANE_CONSTRAINTS:-0}" == '1' ]]; then
  psql_cmd -Atqc "
    SELECT conname || E'\\n' || pg_get_constraintdef(oid, false)
    FROM pg_constraint
    WHERE conrelid='arena.copier_snapshot_publications'::regclass
      AND conname IN (
        'copier_snapshot_publications_evidence_contract_check',
        'copier_snapshot_publications_data_contract_check',
        'copier_snapshot_publications_publisher_contract_check',
        'copier_snapshot_publication_authority_version'
      )
    ORDER BY conname;
  "
  psql_cmd -Atqc "
    SELECT conname || E'\\n' || pg_get_constraintdef(oid, false)
    FROM pg_constraint
    WHERE conrelid='arena.raw_objects'::regclass
      AND conname IN (
        'raw_objects_metric_trust_binding',
        'raw_objects_copier_audit_contract',
        'raw_objects_legacy_copier_event_history_forbidden'
      )
    ORDER BY conname;
  "
fi

# Empty-state replay must be exact and retain the input-isolated V1 ABI/ACL.
EMPTY_STATE_BEFORE="$(psql_cmd -Atqc "
  SELECT
    pg_get_functiondef('public.publish_copier_snapshot_v2(jsonb)'::regprocedure) ||
    pg_get_functiondef('public.arena_copier_aggregate(text,text)'::regprocedure) ||
    (
      SELECT string_agg(
        conname || E'\\n' || pg_get_constraintdef(oid, false),
        E'\\n' ORDER BY conname
      )
      FROM pg_constraint
      WHERE conrelid='arena.raw_objects'::regclass
        AND conname IN (
          'raw_objects_metric_trust_binding',
          'raw_objects_copier_audit_contract',
          'raw_objects_legacy_copier_event_history_forbidden'
        )
    );
")"
psql_cmd -q -f "$LANE_AUTHORITY"
EMPTY_STATE_AFTER="$(psql_cmd -Atqc "
  SELECT
    pg_get_functiondef('public.publish_copier_snapshot_v2(jsonb)'::regprocedure) ||
    pg_get_functiondef('public.arena_copier_aggregate(text,text)'::regprocedure) ||
    (
      SELECT string_agg(
        conname || E'\\n' || pg_get_constraintdef(oid, false),
        E'\\n' ORDER BY conname
      )
      FROM pg_constraint
      WHERE conrelid='arena.raw_objects'::regclass
        AND conname IN (
          'raw_objects_metric_trust_binding',
          'raw_objects_copier_audit_contract',
          'raw_objects_legacy_copier_event_history_forbidden'
        )
    );
")"
assert_equal 'empty lane-authority replay drifted' "$EMPTY_STATE_BEFORE" "$EMPTY_STATE_AFTER"

ACL_STATE="$(psql_cmd -Atqc "
  SELECT
    has_function_privilege('service_role','public.publish_copier_snapshot_v1(jsonb)','EXECUTE')::text || '|' ||
    has_function_privilege('service_role','public.publish_copier_snapshot_v2(jsonb)','EXECUTE')::text || '|' ||
    has_function_privilege('anon','public.publish_copier_snapshot_v2(jsonb)','EXECUTE')::text || '|' ||
    has_function_privilege('authenticated','public.publish_copier_snapshot_v2(jsonb)','EXECUTE')::text || '|' ||
    has_function_privilege('anon','public.arena_copier_aggregate(text,text)','EXECUTE')::text || '|' ||
    has_function_privilege('authenticated','public.arena_copier_aggregate(text,text)','EXECUTE')::text || '|' ||
    has_function_privilege('service_role','public.arena_copier_aggregate(text,text)','EXECUTE')::text || '|' ||
    has_function_privilege('outsider','public.publish_copier_snapshot_v2(jsonb)','EXECUTE')::text || '|' ||
    has_function_privilege('outsider','public.arena_copier_aggregate(text,text)','EXECUTE')::text || '|' ||
    EXISTS (
      SELECT 1
      FROM unnest(ARRAY['anon','authenticated','service_role']::text[]) AS runtime_role(role_name)
      CROSS JOIN unnest(ARRAY['arena.copier_snapshot_publications','arena.copier_snapshot_rows']::text[]) AS private_relation(relation_name)
      WHERE has_table_privilege(runtime_role.role_name,private_relation.relation_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    )::text;
")"
assert_equal 'lane authority ACL state' \
  'true|true|false|false|true|true|true|false|false|false' \
  "$ACL_STATE"

psql_cmd -q <<'SQL'
CREATE FUNCTION public.copier_lane_meta(
  p_source_id integer,
  p_trader_id bigint,
  p_source_slug text,
  p_exchange_trader_id text,
  p_lane text,
  p_source_run_id text,
  p_acquisition_source_run_id text,
  p_observed_at timestamptz,
  p_bytes integer DEFAULT 321
)
RETURNS jsonb
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'surface', 'copiers',
    'publication_eligible', true,
    'publication_evidence_contract',
      'arena.ingest.copier-publication-lane-raw-evidence@1',
    'data_contract',
      'arena.ingest.copier-publication-lane-artifact@1',
    'publication_lane', p_lane,
    'source_run_id', p_source_run_id,
    'acquisition_contract',
      'arena.ingest.history-acquisition-artifact@1',
    'acquisition_source_run_id', p_acquisition_source_run_id,
    'source_id', p_source_id,
    'source_slug', p_source_slug,
    'trader_id', p_trader_id,
    'exchange_trader_id', p_exchange_trader_id,
    'history_kind', 'copiers',
    'attempt_started_at', pg_catalog.to_char(
      (p_observed_at - interval '1 minute') AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'starting_cursor', NULL,
    'capture_config', pg_catalog.jsonb_build_object(
      'caller_page_cap', NULL
    ),
    'observed_at', pg_catalog.to_char(
      p_observed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'page_count', 2,
    'terminal_evidence_state', 'verified',
    'scan_terminal_state', 'exhausted',
    'verifier_contract',
      'arena.ingest.history-terminal-verifier.fixture.copiers@1',
    'termination', pg_catalog.jsonb_build_object(
      'evidence_state', 'verified',
      'scan_terminal_state', 'exhausted',
      'verifier_contract',
        'arena.ingest.history-terminal-verifier.fixture.copiers@1',
      'terminal_cursor_value', NULL,
      'overlap_event_at', NULL,
      'blocker_reasons', '[]'::jsonb,
      'claim_observations', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'segment_id', 'primary',
          'page_ordinal', 2,
          'reason', 'empty_page'
        )
      )
    ),
    'raw_integrity', pg_catalog.jsonb_build_object(
      'version', 1,
      'content_type', 'application/json',
      'encoding', 'utf-8',
      'compression', 'gzip',
      'hash_algorithm', 'sha256',
      'hash_scope', 'json_utf8',
      'serialization_contract', 'arena.strict-canonical-json@1',
      'compressed_bytes', p_bytes,
      'uncompressed_bytes', 999
    )
  );
$function$;

CREATE FUNCTION public.copier_lane_request(
  p_source_id integer,
  p_trader_id bigint,
  p_raw_object_id bigint,
  p_lane text,
  p_source_run_id text,
  p_acquisition_source_run_id text,
  p_observed_at timestamptz
)
RETURNS jsonb
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'contract', 'arena.copier-snapshot-publication@2',
    'sourceId', p_source_id,
    'traderId', p_trader_id,
    'rawObjectId', p_raw_object_id,
    'sourceRunId', p_source_run_id,
    'acquisitionSourceRunId', p_acquisition_source_run_id,
    'lane', p_lane,
    'observedAt', pg_catalog.to_char(
      p_observed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'currency', 'USDT',
    'evidenceState', 'verified',
    'scanTerminalState', 'exhausted',
    'blockerReasons', '[]'::jsonb,
    'rows', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'ts', pg_catalog.to_char(
          (p_observed_at - interval '2 minutes') AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'copierLabel', 'private-one',
        'copierPnl', 10,
        'copierInvested', 100,
        'copyDurationDays', 1,
        'dedupeHash', 'row-one',
        'raw', '{"email":"one@example.invalid"}'::jsonb
      ),
      pg_catalog.jsonb_build_object(
        'ts', pg_catalog.to_char(
          (p_observed_at - interval '1 minute') AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'copierLabel', 'private-two',
        'copierPnl', 20,
        'copierInvested', 200,
        'copyDurationDays', 2,
        'dedupeHash', 'row-two',
        'raw', '{"email":"two@example.invalid"}'::jsonb
      )
    )
  );
$function$;

REVOKE ALL ON FUNCTION public.copier_lane_meta(
  integer,bigint,text,text,text,text,text,timestamptz,integer
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.copier_lane_request(
  integer,bigint,bigint,text,text,text,timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.copier_lane_request(
  integer,bigint,bigint,text,text,text,timestamptz
) TO service_role;

INSERT INTO arena.raw_objects (
  id, source_id, job_type, trader_id, timeframe, fetched_at,
  storage_path, bytes, content_hash, quarantined, meta,
  source_run_id, trust_artifact_role
) VALUES
  (
    1001, 1, 'history:copiers', 101, NULL,
    '2026-08-04 12:00:00+00',
    'gate_futures/copier_publication/tier_b/' || repeat('a', 64) ||
      '/copier_snapshot_' || repeat('a', 64) || '.json.gz',
    321, repeat('a', 64), false,
    public.copier_lane_meta(
      1, 101, 'gate_futures', 'tier-b-valid', 'tier_b',
      repeat('a', 64), repeat('1', 64),
      '2026-08-04 12:00:00+00'
    ),
    repeat('a', 64), 'copier_snapshot'
  ),
  (
    1002, 1, 'tier_c', 102, NULL,
    '2026-08-04 12:01:00+00',
    'gate_futures/copier_publication/tier_c/' || repeat('b', 64) ||
      '/copier_snapshot_' || repeat('b', 64) || '.json.gz',
    321, repeat('b', 64), false,
    public.copier_lane_meta(
      1, 102, 'gate_futures', 'tier-c-valid', 'tier_c',
      repeat('b', 64), repeat('1', 64),
      '2026-08-04 12:01:00+00'
    ),
    repeat('b', 64), 'copier_snapshot'
  ),
  (
    1003, 1, 'history:copiers', 103, NULL,
    '2026-08-04 12:02:00+00',
    'gate_futures/copier_publication/tier_b/' || repeat('c', 64) ||
      '/copier_snapshot_' || repeat('c', 64) || '.json.gz',
    321, repeat('c', 64), false,
    public.copier_lane_meta(
      1, 103, 'gate_futures', 'negative-cases', 'tier_b',
      repeat('c', 64), repeat('2', 64),
      '2026-08-04 12:02:00+00'
    ),
    repeat('c', 64), 'copier_snapshot'
  ),
  (
    1004, 1, 'history:orders', 104, NULL,
    '2026-08-04 12:03:00+00',
    'gate_futures/history/copiers/' || repeat('d', 64) || '.json.gz',
    321, repeat('d', 64), false,
    pg_catalog.jsonb_build_object(
      'data_contract', 'arena.ingest.history-acquisition-artifact@1',
      'history_evidence_contract',
        'arena.event-history-publication-evidence@1',
      'source_run_id', repeat('d', 64),
      'source_slug', 'gate_futures',
      'exchange_trader_id', 'legacy-v1',
      'observed_at', '2026-08-04T12:03:00.000Z',
      'history_kind', 'orders',
      'starting_cursor', NULL,
      'capture_config', pg_catalog.jsonb_build_object(
        'caller_page_cap', NULL
      ),
      'page_count', 2,
      'terminal_evidence_state', 'verified',
      'scan_terminal_state', 'exhausted',
      'verifier_contract',
        'arena.ingest.history-terminal-verifier.fixture.copiers@1',
      'termination', pg_catalog.jsonb_build_object(
        'evidence_state', 'verified',
        'scan_terminal_state', 'exhausted',
        'verifier_contract',
          'arena.ingest.history-terminal-verifier.fixture.copiers@1',
        'terminal_cursor_value', NULL,
        'overlap_event_at', NULL,
        'blocker_reasons', '[]'::jsonb,
        'claim_observations', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'segment_id', 'primary',
            'page_ordinal', 2,
            'reason', 'empty_page'
          )
        )
      )
    ),
    repeat('d', 64), 'event_history'
  ),
  (
    1005, 1, 'tier_c', 105, NULL,
    '2026-08-04 12:04:00+00',
    'gate_futures/copier_publication/tier_c/' || repeat('e', 64) ||
      '/copier_snapshot_' || repeat('e', 64) || '.json.gz',
    321, repeat('e', 64), false,
    public.copier_lane_meta(
      1, 105, 'gate_futures', 'concurrent', 'tier_c',
      repeat('e', 64), repeat('4', 64),
      '2026-08-04 12:04:00+00'
    ),
    repeat('e', 64), 'copier_snapshot'
  ),
  (
    1006, 1, 'history:copiers', 106, NULL,
    '2026-08-04 12:05:00+00',
    'gate_futures/copier_publication/tier_b/' || repeat('f', 64) ||
      '/copier_snapshot_' || repeat('f', 64) || '.json.gz',
    321, repeat('f', 64), false,
    public.copier_lane_meta(
      1, 106, 'gate_futures', 'claim-first', 'tier_b',
      repeat('f', 64), repeat('6', 64),
      '2026-08-04 12:05:00+00'
    ),
    repeat('f', 64), 'copier_snapshot'
  ),
  (
    1007, 1, 'tier_c', 107, NULL,
    '2026-08-04 12:06:00+00',
    'gate_futures/copier_publication/tier_c/' || repeat('9', 64) ||
      '/copier_snapshot_' || repeat('9', 64) || '.json.gz',
    321, repeat('9', 64), false,
    public.copier_lane_meta(
      1, 107, 'gate_futures', 'publication-first', 'tier_c',
      repeat('9', 64), repeat('7', 64),
      '2026-08-04 12:06:00+00'
    ),
    repeat('9', 64), 'copier_snapshot'
  ),
  (
    1008, 1, 'history:copiers', 108, NULL,
    '2026-08-04 12:07:00+00',
    'gate_futures/history_trust/copiers/' || repeat('8', 64) ||
      '/copier_audit_' || repeat('8', 64) || '.json.gz',
    321, repeat('8', 64), false,
    pg_catalog.jsonb_build_object(
      'surface', 'copiers_audit',
      'publication_eligible', false,
      'history_evidence_contract',
        'arena.ingest.copier-audit-raw-evidence@1',
      'data_contract', 'arena.ingest.history-acquisition-artifact@1',
      'source_run_id', repeat('8', 64),
      'source_slug', 'gate_futures',
      'exchange_trader_id', 'audit-only',
      'history_kind', 'copiers',
      'attempt_started_at', '2026-08-04T12:06:00.000Z',
      'starting_cursor', NULL,
      'capture_config', '{"caller_page_cap":null}'::jsonb,
      'observed_at', '2026-08-04T12:07:00.000Z',
      'page_count', 2,
      'termination', pg_catalog.jsonb_build_object(
        'evidence_state', 'verified',
        'scan_terminal_state', 'exhausted',
        'verifier_contract',
          'arena.ingest.history-terminal-verifier.fixture.copiers@1',
        'terminal_cursor_value', NULL,
        'overlap_event_at', NULL,
        'blocker_reasons', '[]'::jsonb,
        'claim_observations', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'segment_id', 'primary',
            'page_ordinal', 2,
            'reason', 'empty_page'
          )
        )
      )
    ),
    repeat('8', 64), 'copier_audit'
  );
SQL

AUDIT_RAW_STATE="$(psql_cmd -Atqc "
  SELECT
    trust_artifact_role || '|' ||
    (meta->>'surface') || '|' ||
    (meta->>'publication_eligible') || '|' ||
    (meta->>'history_evidence_contract') || '|' ||
    (meta->>'data_contract')
  FROM arena.raw_objects
  WHERE id=1008;
")"
assert_equal 'copier audit RAW frozen shape' \
  'copier_audit|copiers_audit|false|arena.ingest.copier-audit-raw-evidence@1|arena.ingest.history-acquisition-artifact@1' \
  "$AUDIT_RAW_STATE"

expect_failure_contains \
  'legacy-event-history-copier-kind-forbidden' \
  'raw_objects_legacy_copier_event_history_forbidden' \
  "INSERT INTO arena.raw_objects (id,source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,content_hash,quarantined,meta,source_run_id,trust_artifact_role) SELECT 1021,source_id,job_type,trader_id,timeframe,fetched_at,storage_path || '.copier-kind',bytes,repeat('3',64),quarantined,jsonb_set(meta,'{history_kind}','\"copiers\"'::jsonb),repeat('3',64),'event_history' FROM arena.raw_objects WHERE id=1004;"

expect_failure_contains \
  'legacy-event-history-copier-surface-forbidden' \
  'raw_objects_legacy_copier_event_history_forbidden' \
  "INSERT INTO arena.raw_objects (id,source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,content_hash,quarantined,meta,source_run_id,trust_artifact_role) SELECT 1022,source_id,job_type,trader_id,timeframe,fetched_at,storage_path || '.copier-surface',bytes,repeat('2',64),quarantined,meta || '{\"surface\":\"copiers\"}'::jsonb,repeat('2',64),'event_history' FROM arena.raw_objects WHERE id=1004;"

expect_failure_contains \
  'legacy-event-history-copier-job-forbidden-with-json-null-meta' \
  'raw_objects_legacy_copier_event_history_forbidden' \
  "INSERT INTO arena.raw_objects (id,source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,content_hash,quarantined,meta,source_run_id,trust_artifact_role) SELECT 1023,source_id,'history:copiers',trader_id,timeframe,fetched_at,storage_path || '.copier-job',bytes,repeat('1',64),quarantined,jsonb_build_object('history_kind',NULL,'surface',NULL),repeat('1',64),'event_history' FROM arena.raw_objects WHERE id=1004;"

expect_failure_contains \
  'copier-audit-role-without-source-run' \
  'raw_objects_metric_trust_binding' \
  "INSERT INTO arena.raw_objects (id,source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,content_hash,quarantined,meta,source_run_id,trust_artifact_role) SELECT 1020,source_id,job_type,trader_id,timeframe,fetched_at,storage_path || '.missing-run',bytes,repeat('b',64),quarantined,meta,NULL,'copier_audit' FROM arena.raw_objects WHERE id=1008;"

expect_failure_contains \
  'eligible-copier-audit-raw' \
  'raw_objects_copier_audit_contract' \
  "INSERT INTO arena.raw_objects (id,source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,content_hash,quarantined,meta,source_run_id,trust_artifact_role) SELECT 1009,source_id,job_type,trader_id,timeframe,fetched_at,storage_path || '.eligible',bytes,repeat('7',64),quarantined,jsonb_set(meta,'{publication_eligible}','true'::jsonb),repeat('7',64),'copier_audit' FROM arena.raw_objects WHERE id=1008;"

expect_failure_contains \
  'missing-copier-audit-meta' \
  'raw_objects_copier_audit_contract' \
  "INSERT INTO arena.raw_objects (id,source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,content_hash,quarantined,meta,source_run_id,trust_artifact_role) SELECT 1010,source_id,job_type,trader_id,timeframe,fetched_at,storage_path || '.missing',bytes,repeat('6',64),quarantined,meta - 'surface',repeat('6',64),'copier_audit' FROM arena.raw_objects WHERE id=1008;"

expect_failure_contains \
  'empty-copier-audit-meta' \
  'raw_objects_copier_audit_contract' \
  "INSERT INTO arena.raw_objects (id,source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,content_hash,quarantined,meta,source_run_id,trust_artifact_role) SELECT 1012,source_id,job_type,trader_id,timeframe,fetched_at,storage_path || '.empty',bytes,repeat('4',64),quarantined,'{}'::jsonb,repeat('4',64),'copier_audit' FROM arena.raw_objects WHERE id=1008;"

expect_failure_contains \
  'missing-copier-audit-publication-eligible' \
  'raw_objects_copier_audit_contract' \
  "INSERT INTO arena.raw_objects (id,source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,content_hash,quarantined,meta,source_run_id,trust_artifact_role) SELECT 1013,source_id,job_type,trader_id,timeframe,fetched_at,storage_path || '.missing-eligible',bytes,repeat('2',64),quarantined,meta - 'publication_eligible',repeat('2',64),'copier_audit' FROM arena.raw_objects WHERE id=1008;"

expect_failure_contains \
  'missing-copier-audit-evidence-contract' \
  'raw_objects_copier_audit_contract' \
  "INSERT INTO arena.raw_objects (id,source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,content_hash,quarantined,meta,source_run_id,trust_artifact_role) SELECT 1014,source_id,job_type,trader_id,timeframe,fetched_at,storage_path || '.missing-evidence',bytes,repeat('1',64),quarantined,meta - 'history_evidence_contract',repeat('1',64),'copier_audit' FROM arena.raw_objects WHERE id=1008;"

expect_failure_contains \
  'missing-copier-audit-data-contract' \
  'raw_objects_copier_audit_contract' \
  "INSERT INTO arena.raw_objects (id,source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,content_hash,quarantined,meta,source_run_id,trust_artifact_role) SELECT 1015,source_id,job_type,trader_id,timeframe,fetched_at,storage_path || '.missing-data',bytes,repeat('0',64),quarantined,meta - 'data_contract',repeat('0',64),'copier_audit' FROM arena.raw_objects WHERE id=1008;"

expect_failure_contains \
  'null-copier-audit-surface' \
  'raw_objects_copier_audit_contract' \
  "INSERT INTO arena.raw_objects (id,source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,content_hash,quarantined,meta,source_run_id,trust_artifact_role) SELECT 1016,source_id,job_type,trader_id,timeframe,fetched_at,storage_path || '.null-surface',bytes,repeat('f',64),quarantined,jsonb_set(meta,'{surface}','null'::jsonb),repeat('f',64),'copier_audit' FROM arena.raw_objects WHERE id=1008;"

expect_failure_contains \
  'null-copier-audit-publication-eligible' \
  'raw_objects_copier_audit_contract' \
  "INSERT INTO arena.raw_objects (id,source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,content_hash,quarantined,meta,source_run_id,trust_artifact_role) SELECT 1017,source_id,job_type,trader_id,timeframe,fetched_at,storage_path || '.null-eligible',bytes,repeat('e',64),quarantined,jsonb_set(meta,'{publication_eligible}','null'::jsonb),repeat('e',64),'copier_audit' FROM arena.raw_objects WHERE id=1008;"

expect_failure_contains \
  'null-copier-audit-evidence-contract' \
  'raw_objects_copier_audit_contract' \
  "INSERT INTO arena.raw_objects (id,source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,content_hash,quarantined,meta,source_run_id,trust_artifact_role) SELECT 1018,source_id,job_type,trader_id,timeframe,fetched_at,storage_path || '.null-evidence',bytes,repeat('d',64),quarantined,jsonb_set(meta,'{history_evidence_contract}','null'::jsonb),repeat('d',64),'copier_audit' FROM arena.raw_objects WHERE id=1008;"

expect_failure_contains \
  'null-copier-audit-data-contract' \
  'raw_objects_copier_audit_contract' \
  "INSERT INTO arena.raw_objects (id,source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,content_hash,quarantined,meta,source_run_id,trust_artifact_role) SELECT 1019,source_id,job_type,trader_id,timeframe,fetched_at,storage_path || '.null-data',bytes,repeat('c',64),quarantined,jsonb_set(meta,'{data_contract}','null'::jsonb),repeat('c',64),'copier_audit' FROM arena.raw_objects WHERE id=1008;"

expect_failure_contains \
  'wrong-copier-audit-contract' \
  'raw_objects_copier_audit_contract' \
  "INSERT INTO arena.raw_objects (id,source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,content_hash,quarantined,meta,source_run_id,trust_artifact_role) SELECT 1011,source_id,job_type,trader_id,timeframe,fetched_at,storage_path || '.contract',bytes,repeat('5',64),quarantined,jsonb_set(meta,'{history_evidence_contract}','\"arena.event-history-publication-evidence@1\"'::jsonb),repeat('5',64),'copier_audit' FROM arena.raw_objects WHERE id=1008;"

expect_failure_contains \
  'v1-cannot-consume-copier-audit' \
  'does not prove the exact verified acquisition' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1((public.copier_lane_request(1,108,1008,'tier_c',repeat('8',64),repeat('3',64),'2026-08-04 12:07:00+00') - 'acquisitionSourceRunId' - 'lane') || jsonb_build_object('contract','arena.copier-snapshot-publication@1'));"

expect_failure_contains \
  'v2-cannot-consume-copier-audit' \
  'RAW role is audit-only or otherwise not publication eligible' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,108,1008,'tier_b',repeat('8',64),repeat('3',64),'2026-08-04 12:07:00+00'));"

TIER_B_RECEIPT="$(psql_cmd -Atqc "
  SET ROLE service_role;
  SELECT public.publish_copier_snapshot_v2(
    public.copier_lane_request(
      1, 101, 1001, 'tier_b', repeat('a',64), repeat('1',64),
      '2026-08-04 12:00:00+00'
    )
  );
")"
TIER_B_RECEIPT_STATE="$(psql_cmd -Atqc "
  WITH receipt AS (SELECT '$TIER_B_RECEIPT'::jsonb AS value)
  SELECT
    (SELECT array_agg(key ORDER BY key) FROM receipt,
      LATERAL jsonb_object_keys(value) AS key) = ARRAY[
        'acquisitionSourceRunId','lane','observedAt','publishedAt',
        'receiptId','rowCount','sourceRunId'
      ]::text[]
    AND (SELECT value->>'lane' FROM receipt) = 'tier_b'
    AND (SELECT value->>'rowCount' FROM receipt) = '2'
    AND (SELECT value->>'receiptId' FROM receipt) = '1'
    AND (SELECT value->>'observedAt' FROM receipt) =
      '2026-08-04T12:00:00.000Z'
    AND (SELECT value->>'publishedAt' FROM receipt) ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'
    AND (SELECT value->>'sourceRunId' FROM receipt) = repeat('a',64)
    AND (SELECT value->>'acquisitionSourceRunId' FROM receipt) =
      repeat('1',64);
")"
assert_equal 'Tier-B receipt contract' 't' "$TIER_B_RECEIPT_STATE"

TIER_C_RECEIPT="$(psql_cmd -Atqc "
  SET ROLE service_role;
  SELECT public.publish_copier_snapshot_v2(
    public.copier_lane_request(
      1, 102, 1002, 'tier_c', repeat('b',64), repeat('1',64),
      '2026-08-04 12:01:00+00'
    )
  );
")"
assert_equal 'Tier-C receipt lane' 'tier_c|true' "$(psql_cmd -Atqc "
  SELECT
    ('$TIER_C_RECEIPT'::jsonb->>'lane') || '|' ||
    (('$TIER_C_RECEIPT'::jsonb->>'sourceRunId') <>
      ('$TIER_C_RECEIPT'::jsonb->>'acquisitionSourceRunId'))::text;
")"

REPLAY_RECEIPT="$(psql_cmd -Atqc "
  SET ROLE service_role;
  SELECT public.publish_copier_snapshot_v2(
    public.copier_lane_request(
      1, 101, 1001, 'tier_b', repeat('a',64), repeat('1',64),
      '2026-08-04 12:00:00+00'
    )
  );
")"
assert_equal 'exact V2 replay changed receipt' "$TIER_B_RECEIPT" "$REPLAY_RECEIPT"

RECEIPT_STATE="$(psql_cmd -Atqc "
  SELECT
    string_agg(lane,',' ORDER BY publication_id) || '|' ||
    string_agg(evidence_contract,',' ORDER BY publication_id) || '|' ||
    string_agg(publisher_contract,',' ORDER BY publication_id) || '|' ||
    string_agg(acquisition_source_run_id,',' ORDER BY publication_id) || '|' ||
    string_agg(raw_trust_artifact_role_at_publication,',' ORDER BY publication_id) || '|' ||
    count(*)::text || '|' ||
    (SELECT count(*) FROM arena.copier_snapshot_rows)::text || '|' ||
    (SELECT count(*) FROM arena.copier_snapshot_rows WHERE source_event_at IS NULL)::text
  FROM arena.copier_snapshot_publications;
")"
assert_equal 'lane-bound receipt state' \
  "tier_b,tier_c|arena.copier-snapshot-publication@2,arena.copier-snapshot-publication@2|arena.ingest.copier-snapshot-publisher@2,arena.ingest.copier-snapshot-publisher@2|$(printf '1%.0s' {1..64}),$(printf '1%.0s' {1..64})|copier_snapshot,copier_snapshot|2|4|4" \
  "$RECEIPT_STATE"

PUBLIC_STATE="$(psql_cmd -Atqc "
  SET ROLE anon;
  SELECT
    (public.arena_copier_aggregate('gate_futures','tier-b-valid')->>'receiptBound') || '|' ||
    (public.arena_copier_aggregate('gate_futures','tier-b-valid')->>'copierCount') || '|' ||
    (public.arena_copier_aggregate('gate_futures','tier-b-valid')->>'totalCopierPnl') || '|' ||
    (public.arena_copier_aggregate('gate_futures','tier-c-valid')->>'receiptBound');
")"
assert_equal 'public @2 aggregate state' 'true|2|30|true' "$PUBLIC_STATE"

expect_failure_contains \
  'null-v2-publication-authority-coordinate' \
  'copier_snapshot_publication_authority_version' \
  "BEGIN; ALTER TABLE arena.copier_snapshot_publications DISABLE TRIGGER USER; UPDATE arena.copier_snapshot_publications SET acquisition_source_run_id=NULL WHERE publication_id=1;"

expect_failure_contains \
  'wrong-request-lane' \
  'does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_c',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'conflicting-replay' \
  'replay conflicts with its immutable request' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(jsonb_set(public.copier_lane_request(1,101,1001,'tier_b',repeat('a',64),repeat('1',64),'2026-08-04 12:00:00+00'),'{rows,0,copierPnl}','99'::jsonb));"

expect_failure_contains \
  'future-observation' \
  'coordinates are outside their contract' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),statement_timestamp() + interval '1 day'));"

expect_failure_contains \
  'extra-request-key' \
  'request keys are not exact' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00') || '{\"untrusted\":true}'::jsonb);"

expect_failure_contains \
  'request-acquisition-wrapper-digest-collision' \
  'coordinates are outside their contract' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(jsonb_set(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'),'{acquisitionSourceRunId}',to_jsonb(repeat('c',64))));"

expect_failure_contains \
  'duplicate-row-dedupe-hash' \
  'dedupeHash values must be unique' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(jsonb_set(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'),'{rows,1,dedupeHash}','\"row-one\"'::jsonb));"

expect_failure_contains \
  'inactive-subject' \
  'subject is not active serving or its source contract drifted' \
  "BEGIN; UPDATE arena.sources SET status='inactive' WHERE id=1; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'shadow-subject' \
  'subject is not active serving or its source contract drifted' \
  "BEGIN; UPDATE arena.sources SET serving_mode='shadow' WHERE id=1; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'unsupported-depth-subject' \
  'subject is not active serving or its source contract drifted' \
  "BEGIN; UPDATE arena.sources SET copier_table_depth='none' WHERE id=1; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'currency-drifted-subject' \
  'subject is not active serving or its source contract drifted' \
  "BEGIN; UPDATE arena.sources SET currency='USD' WHERE id=1; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'cross-source-trader-subject' \
  'subject is not active serving or its source contract drifted' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(2,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'missing-raw-pointer' \
  'RAW pointer is missing' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,9999,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'wrong-job' \
  'does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest' \
  "BEGIN; UPDATE arena.raw_objects SET job_type='tier_c' WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'raw-timeframe-present' \
  'does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest' \
  "BEGIN; UPDATE arena.raw_objects SET timeframe=30 WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'quarantined-raw' \
  'does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest' \
  "BEGIN; UPDATE arena.raw_objects SET quarantined=true WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'null-quarantine-state' \
  'does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest' \
  "BEGIN; ALTER TABLE arena.raw_objects ALTER COLUMN quarantined DROP NOT NULL; UPDATE arena.raw_objects SET quarantined=NULL WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'wrong-raw-clock' \
  'does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest' \
  "BEGIN; UPDATE arena.raw_objects SET fetched_at=fetched_at - interval '1 second' WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'empty-raw-bytes' \
  'does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest' \
  "BEGIN; UPDATE arena.raw_objects SET bytes=0,meta=jsonb_set(meta,'{raw_integrity,compressed_bytes}','0'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'wrong-role' \
  'RAW role is audit-only or otherwise not publication eligible' \
  "BEGIN; UPDATE arena.raw_objects SET trust_artifact_role='price_history' WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'wrong-content-hash' \
  'does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest' \
  "BEGIN; UPDATE arena.raw_objects SET content_hash=repeat('d',64) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'wrong-raw-subject' \
  'does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest' \
  "BEGIN; UPDATE arena.raw_objects SET source_id=2,trader_id=201 WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'wrong-storage-path' \
  'does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest' \
  "BEGIN; UPDATE arena.raw_objects SET storage_path=storage_path || '.wrong' WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'wrong-meta-lane' \
  'does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{publication_lane}','\"tier_c\"') WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'extra-meta-key' \
  'RAW metadata keys are not exact' \
  "BEGIN; UPDATE arena.raw_objects SET meta=meta || '{\"untrusted\":true}'::jsonb WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'wrong-meta-subject' \
  'RAW subject coordinates do not match the exact subject' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{trader_id}','201'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'wrong-meta-surface' \
  'does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{surface}','\"positions\"'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'ineligible-meta' \
  'does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{publication_eligible}','false'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'wrong-meta-contract' \
  'does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{data_contract}','\"arena.ingest.history-acquisition-artifact@1\"'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'wrong-meta-source-run' \
  'does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{source_run_id}',to_jsonb(repeat('d',64))) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'wrong-meta-source-identity' \
  'does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{exchange_trader_id}','\"other-trader\"'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'wrong-history-kind' \
  'does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{history_kind}','\"orders\"'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'non-null-starting-cursor' \
  'does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{starting_cursor}','\"cursor\"'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'wrong-acquisition-digest' \
  'does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('3',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'truncated-evidence' \
  'does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{capture_config,caller_page_cap}','2'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'blocked-terminal-evidence' \
  'terminal proof is not verified exhausted and blocker-free' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{termination,blocker_reasons}','[\"caller_cap\"]'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'invalid-terminal-object' \
  'RAW terminal claim shape is invalid' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{termination}','null'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'missing-terminal-claims' \
  'RAW terminal claim shape is invalid' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{termination,claim_observations}','[]'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'extra-terminal-key' \
  'terminal proof is not verified exhausted and blocker-free' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{termination}',(meta->'termination') || '{\"untrusted\":true}'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'non-null-terminal-cursor' \
  'terminal proof is not verified exhausted and blocker-free' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{termination,terminal_cursor_value}','\"cursor\"'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'terminal-verifier-mismatch' \
  'terminal proof is not verified exhausted and blocker-free' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{termination,verifier_contract}','\"arena.ingest.history-terminal-verifier.other.copiers@1\"'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'null-top-level-terminal-verifier' \
  'does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{verifier_contract}','null'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'extra-terminal-observation-key' \
  'RAW terminal observation shape is invalid' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{termination,claim_observations,0}',(meta#>'{termination,claim_observations,0}') || '{\"untrusted\":true}'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'invalid-terminal-reason' \
  'RAW terminal observation shape is invalid' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{termination,claim_observations,0,reason}','\"cursor_overlap\"'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'terminal-page-outside-capture' \
  'terminal observation is outside captured pages' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{termination,claim_observations,0,page_ordinal}','3'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'invalid-page-count' \
  'has no bounded full-capture page evidence' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{page_count}','0'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'future-attempt-clock' \
  'attempt clock is outside the full-capture contract' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{attempt_started_at}','\"2026-08-04T12:03:00.000Z\"'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'raw-integrity-byte-drift' \
  'integrity byte counts are invalid' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{raw_integrity,compressed_bytes}','322'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'invalid-raw-integrity-object' \
  'RAW integrity metadata is invalid' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{raw_integrity}','null'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'extra-raw-integrity-key' \
  'RAW integrity contract is not exact' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{raw_integrity}',(meta->'raw_integrity') || '{\"untrusted\":true}'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'wrong-raw-integrity-codec' \
  'RAW integrity contract is not exact' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{raw_integrity,compression}','\"identity\"'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'zero-uncompressed-raw-bytes' \
  'integrity byte counts are invalid' \
  "BEGIN; UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{raw_integrity,uncompressed_bytes}','0'::jsonb) WHERE id=1003; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'claimed-subject' \
  'claimed trader copier lane V2 snapshots cannot be published' \
  "BEGIN; UPDATE arena.traders SET meta='{\"claimed\":true}'::jsonb WHERE id=103; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00'));"

expect_failure_contains \
  'v1-cannot-consume-v2-raw' \
  'does not prove the exact verified acquisition' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1((public.copier_lane_request(1,103,1003,'tier_b',repeat('c',64),repeat('2',64),'2026-08-04 12:02:00+00') - 'acquisitionSourceRunId' - 'lane') || jsonb_build_object('contract','arena.copier-snapshot-publication@1'));"

expect_failure_contains \
  'retained-v1-writer-is-input-isolated' \
  'does not prove the exact verified acquisition' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1((public.copier_lane_request(1,104,1004,'tier_c',repeat('d',64),repeat('5',64),'2026-08-04 12:03:00+00') - 'acquisitionSourceRunId' - 'lane') || jsonb_build_object('contract','arena.copier-snapshot-publication@1'));"

# A claim UPDATE that owns the trader row first must make V2 wait and then
# reject. This proves the shared subject lock closes the race, not merely the
# point-in-time claimed predicate.
(
  psql_cmd -q >"$TMP_ROOT/lane-claim-first-holder.out" 2>&1 <<'SQL'
SET application_name = 'lane-claim-first-holder';
BEGIN;
UPDATE arena.traders
SET meta = meta || '{"claimed":true}'::jsonb
WHERE id = 106;
SELECT pg_catalog.pg_advisory_lock(54, 303);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
) &
claim_first_holder_pid=$!

wait_for_activity \
  'lane claim-first holder' \
  "SELECT CASE WHEN pg_catalog.pg_try_advisory_lock(54,303) THEN NOT pg_catalog.pg_advisory_unlock(54,303) ELSE true END"

(
  if psql_cmd -v VERBOSITY=verbose -c \
    "SET application_name='lane-claim-first-publisher'; SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(public.copier_lane_request(1,106,1006,'tier_b',repeat('f',64),repeat('6',64),'2026-08-04 12:05:00+00'))" \
    >"$TMP_ROOT/lane-claim-first-publisher.out" 2>&1; then
    echo success >"$TMP_ROOT/lane-claim-first-publisher.status"
  else
    echo failure >"$TMP_ROOT/lane-claim-first-publisher.status"
  fi
) &
claim_first_publisher_pid=$!

wait_for_activity \
  'lane claim-first publication did not wait for the claim lock' \
  "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE pid<>pg_catalog.pg_backend_pid() AND locktype='transactionid' AND NOT granted)"

wait "$claim_first_holder_pid"
wait "$claim_first_publisher_pid"
assert_equal \
  'lane claim-first publication escaped claimed rejection' \
  'failure' \
  "$(<"$TMP_ROOT/lane-claim-first-publisher.status")"
if ! grep -Fq 'claimed trader copier lane V2 snapshots cannot be published' \
  "$TMP_ROOT/lane-claim-first-publisher.out"; then
  echo 'lane claim-first publication escaped claimed rejection' >&2
  sed -n '1,180p' "$TMP_ROOT/lane-claim-first-publisher.out" >&2
  exit 1
fi

# In the opposite direction, publication retains FOR SHARE until commit and a
# concurrent claim UPDATE must wait. Both final states then coexist in order.
(
  psql_cmd -q >"$TMP_ROOT/lane-publication-first-holder.out" 2>&1 <<'SQL'
SET application_name = 'lane-publication-first-holder';
BEGIN;
SET ROLE service_role;
SELECT public.publish_copier_snapshot_v2(
  public.copier_lane_request(
    1,107,1007,'tier_c',repeat('9',64),repeat('7',64),
    '2026-08-04 12:06:00+00'
  )
);
SELECT pg_catalog.pg_advisory_lock(54, 304);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
) &
publication_first_holder_pid=$!

wait_for_activity \
  'lane publication-first holder' \
  "SELECT CASE WHEN pg_catalog.pg_try_advisory_lock(54,304) THEN NOT pg_catalog.pg_advisory_unlock(54,304) ELSE true END"

(
  psql_cmd -q -c \
    "SET application_name='lane-publication-first-claim'; UPDATE arena.traders SET meta=meta || '{\"claimed\":true}'::jsonb WHERE id=107" \
    >"$TMP_ROOT/lane-publication-first-claim.out" 2>&1
) &
publication_first_claim_pid=$!

wait_for_activity \
  'lane publication-first claim did not wait for the publication lock' \
  "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE pid<>pg_catalog.pg_backend_pid() AND locktype='transactionid' AND NOT granted)"

wait "$publication_first_holder_pid"
wait "$publication_first_claim_pid"
assert_equal \
  'lane publication-first serialization lost receipt or claim state' \
  '1|true' \
  "$(psql_cmd -Atqc "
    SELECT
      pg_catalog.count(publication.*)::text || '|' ||
      (trader.meta->>'claimed')
    FROM arena.traders AS trader
    LEFT JOIN arena.copier_snapshot_publications AS publication
      ON publication.trader_id=trader.id
     AND publication.source_run_id=repeat('9',64)
    WHERE trader.id=107
    GROUP BY trader.meta
  ")"

# A legitimate RAW GC tombstone must preserve both public reads and exact V2
# replay from the frozen lane/digest coordinates in the immutable receipt.
psql_cmd -q -c 'DELETE FROM arena.raw_objects WHERE id=1001'
TOMBSTONE_STATE="$(psql_cmd -Atqc "
  SELECT
    (live_raw_object_id IS NULL)::text || '|' ||
    (public.arena_copier_aggregate(
      'gate_futures','tier-b-valid'
    )->>'receiptBound')
  FROM arena.copier_snapshot_publications
  WHERE source_run_id=repeat('a',64);
")"
assert_equal 'V2 RAW tombstone reader state' 'true|true' "$TOMBSTONE_STATE"
TOMBSTONE_REPLAY="$(psql_cmd -Atqc "
  SET ROLE service_role;
  SELECT public.publish_copier_snapshot_v2(
    public.copier_lane_request(
      1,101,1001,'tier_b',repeat('a',64),repeat('1',64),
      '2026-08-04 12:00:00+00'
    )
  );
")"
assert_equal 'V2 tombstone replay changed receipt' \
  "$TIER_B_RECEIPT" "$TOMBSTONE_REPLAY"
expect_failure_contains \
  'tombstone-conflicting-replay' \
  'replay conflicts with its immutable request' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v2(jsonb_set(public.copier_lane_request(1,101,1001,'tier_b',repeat('a',64),repeat('1',64),'2026-08-04 12:00:00+00'),'{rows,0,copierPnl}','99'::jsonb));"

# Independent sessions racing the same wrapper serialize on sourceRunId and
# converge on one receipt and one exact private row set.
(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT public.publish_copier_snapshot_v2(
      public.copier_lane_request(
        1,105,1005,'tier_c',repeat('e',64),repeat('4',64),
        '2026-08-04 12:04:00+00'
      )
    );
  " >"$TMP_ROOT/concurrent-one.out"
) &
CONCURRENT_ONE_PID=$!
(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT public.publish_copier_snapshot_v2(
      public.copier_lane_request(
        1,105,1005,'tier_c',repeat('e',64),repeat('4',64),
        '2026-08-04 12:04:00+00'
      )
    );
  " >"$TMP_ROOT/concurrent-two.out"
) &
CONCURRENT_TWO_PID=$!
wait "$CONCURRENT_ONE_PID"
wait "$CONCURRENT_TWO_PID"
CONCURRENT_ONE="$(tr -d '\n' <"$TMP_ROOT/concurrent-one.out")"
CONCURRENT_TWO="$(tr -d '\n' <"$TMP_ROOT/concurrent-two.out")"
assert_equal 'concurrent exact replay receipts diverged' \
  "$CONCURRENT_ONE" "$CONCURRENT_TWO"
CONCURRENT_STATE="$(psql_cmd -Atqc "
  WITH receipt AS (
    SELECT count(*) AS receipt_count, min(publication_id) AS publication_id
    FROM arena.copier_snapshot_publications
    WHERE source_run_id=repeat('e',64)
  )
  SELECT
    receipt.receipt_count::text || '|' ||
    (SELECT count(*) FROM arena.copier_snapshot_rows AS snapshot_row
      WHERE snapshot_row.publication_id = receipt.publication_id)::text
  FROM receipt;
")"
assert_equal 'concurrent V2 publication did not converge' \
  '1|2' "$CONCURRENT_STATE"

NONEMPTY_REPLAY_LOG="$TMP_ROOT/nonempty-lane-authority-replay.log"
if psql_cmd -q -f "$LANE_AUTHORITY" >"$NONEMPTY_REPLAY_LOG" 2>&1; then
  echo 'non-empty lane authority replay succeeded unexpectedly' >&2
  exit 1
fi
if ! grep -Fq \
  'copier lane V2 authority requires zero existing receipts and rows' \
  "$NONEMPTY_REPLAY_LOG"; then
  echo 'non-empty lane authority replay failed for an unexpected reason' >&2
  sed -n '1,180p' "$NONEMPTY_REPLAY_LOG" >&2
  exit 1
fi

echo 'copier snapshot lane V2 PostgreSQL 17 proof passed'
