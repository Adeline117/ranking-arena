#!/usr/bin/env bash

# PostgreSQL 17 behavior proof for the service-only atomic position-history
# publication writer.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SUBSTRATE="$ROOT_DIR/supabase/migrations/20260803100000_record_surface_publication_substrate.sql"
MIGRATION="$ROOT_DIR/supabase/migrations/20260803101000_verified_position_history_publication_writer.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi
for migration in "$SUBSTRATE" "$MIGRATION"; do
  if [[ ! -f "$migration" ]]; then
    echo "Migration not found: $migration" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/verified-position-history-writer-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((61000 + ($$ % 2000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    echo "[verified-history-writer] PostgreSQL log tail:" >&2
    tail -200 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

expect_failure_contains() {
  local label="$1"
  local needle="$2"
  local sql="$3"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"
  if psql_cmd -v VERBOSITY=verbose -c "$sql" >"$failure_log" 2>&1; then
    echo "[verified-history-writer] Expected failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "[verified-history-writer] Unexpected failure for $label" >&2
    sed -n '1,180p' "$failure_log" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" -D "$DATA_DIR" --auth=trust --username=postgres >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -k $SOCKET_DIR -p $PORT" -w start >/dev/null

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA arena AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA arena TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA arena
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA arena
  GRANT SELECT ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA arena
  GRANT USAGE, SELECT ON SEQUENCES TO service_role;

CREATE TABLE arena.sources (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  currency text NOT NULL
);
CREATE TABLE arena.traders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id) ON DELETE CASCADE,
  exchange_trader_id text NOT NULL,
  UNIQUE (source_id, exchange_trader_id)
);
CREATE TABLE arena.ingest_cursors (
  trader_id bigint NOT NULL REFERENCES arena.traders(id) ON DELETE CASCADE,
  kind text NOT NULL,
  cursor_value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trader_id, kind)
);
CREATE TABLE arena.raw_objects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  trader_id bigint,
  timeframe smallint,
  fetched_at timestamptz NOT NULL,
  storage_path text NOT NULL UNIQUE,
  bytes integer NOT NULL,
  content_hash text NOT NULL,
  quarantined boolean NOT NULL DEFAULT false,
  meta jsonb NOT NULL DEFAULT '{}',
  source_run_id text,
  trust_artifact_role text
);
CREATE TABLE arena.position_history (
  trader_id bigint NOT NULL REFERENCES arena.traders(id) ON DELETE CASCADE,
  opened_at timestamptz,
  closed_at timestamptz,
  symbol text NOT NULL,
  side text,
  leverage numeric,
  size numeric,
  entry_price numeric,
  exit_price numeric,
  realized_pnl numeric,
  currency text NOT NULL,
  dedupe_hash text NOT NULL,
  raw jsonb
) PARTITION BY RANGE (closed_at);
CREATE UNIQUE INDEX uq_arena_position_history_dedupe
  ON arena.position_history (closed_at, dedupe_hash);
CREATE TABLE arena.position_history_default
  PARTITION OF arena.position_history DEFAULT;
ALTER TABLE arena.position_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read position_history" ON arena.position_history
  FOR SELECT TO anon, authenticated USING (true);
SQL

psql_cmd -q -f "$SUBSTRATE"

psql_cmd -q <<'SQL'
CREATE SCHEMA fixture;
CREATE FUNCTION fixture.canonical_timestamp(p_value timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT to_char(
    p_value AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
$function$;

CREATE FUNCTION fixture.history_meta(
  p_source_run_id text,
  p_observed_at timestamptz,
  p_starting_cursor timestamptz,
  p_scan_terminal_state text,
  p_overlap_event_at timestamptz DEFAULT NULL,
  p_caller_page_cap integer DEFAULT NULL,
  p_evidence_state text DEFAULT 'verified'
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT jsonb_build_object(
    'surface', 'position_history',
    'data_contract', 'arena.ingest.history-acquisition-artifact@1',
    'history_evidence_contract', 'arena.position-history-publication-evidence@1',
    'source_run_id', p_source_run_id,
    'source_slug', 'binance_futures',
    'exchange_trader_id', 'portfolio-' ||
      CASE WHEN right(p_source_run_id, 1) IN ('b', 'c') THEN '2'
           WHEN right(p_source_run_id, 1) = 'f' THEN '3'
           ELSE '1' END,
    'history_kind', 'position_history',
    'attempt_started_at', fixture.canonical_timestamp(
      p_observed_at - interval '1 minute'
    ),
    'starting_cursor', CASE WHEN p_starting_cursor IS NULL THEN NULL
                            ELSE fixture.canonical_timestamp(p_starting_cursor) END,
    'capture_config', jsonb_build_object('caller_page_cap', p_caller_page_cap),
    'observed_at', fixture.canonical_timestamp(p_observed_at),
    'page_count', 1,
    'terminal_evidence_state', p_evidence_state,
    'scan_terminal_state', p_scan_terminal_state,
    'verifier_contract',
      'arena.ingest.history-terminal-verifier.test.position_history@1',
    'termination', jsonb_build_object(
      'evidence_state', p_evidence_state,
      'claim_observations', jsonb_build_array(jsonb_build_object(
        'segment_id', 'default',
        'reason', CASE WHEN p_scan_terminal_state = 'cursor_overlap'
                       THEN 'cursor_overlap' ELSE 'reported_end' END,
        'page_ordinal', 1
      )),
      'verifier_contract',
        'arena.ingest.history-terminal-verifier.test.position_history@1',
      'scan_terminal_state', p_scan_terminal_state,
      'terminal_cursor_value', CASE WHEN p_scan_terminal_state = 'cursor_overlap'
                                    THEN fixture.canonical_timestamp(p_starting_cursor)
                                    ELSE NULL END,
      'overlap_event_at', CASE WHEN p_overlap_event_at IS NULL THEN NULL
                               ELSE fixture.canonical_timestamp(p_overlap_event_at) END,
      'blocker_reasons', CASE WHEN p_evidence_state = 'verified'
                              THEN '[]'::jsonb ELSE '["caller_limit"]'::jsonb END
    ),
    'raw_integrity', jsonb_build_object(
      'version', 1,
      'content_type', 'application/json',
      'encoding', 'utf-8',
      'compression', 'gzip',
      'hash_algorithm', 'sha256',
      'hash_scope', 'json_utf8',
      'serialization_contract', 'arena.strict-canonical-json@1',
      'compressed_bytes', 100,
      'uncompressed_bytes', 1000
    )
  );
$function$;

CREATE FUNCTION fixture.round_raw_fetched_at_to_milliseconds()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.fetched_at := date_trunc('milliseconds', NEW.fetched_at);
  RETURN NEW;
END
$function$;

CREATE TRIGGER fixture_round_raw_fetched_at
BEFORE INSERT OR UPDATE OF fetched_at ON arena.raw_objects
FOR EACH ROW EXECUTE FUNCTION fixture.round_raw_fetched_at_to_milliseconds();

INSERT INTO arena.sources (slug, currency) VALUES ('binance_futures', 'USDT');
INSERT INTO arena.traders (source_id, exchange_trader_id) VALUES
  (1, 'portfolio-1'),
  (1, 'portfolio-2'),
  (1, 'portfolio-3');
SQL

psql_cmd -q -f "$MIGRATION"

echo "[verified-history-writer] prove callable metadata and ACL"
psql_cmd -q <<'SQL'
DO $callables$
DECLARE
  v_checkpoint oid := 'arena.get_position_history_publication_checkpoint(smallint,bigint)'::regprocedure;
  v_chain_guard oid := 'arena.position_history_publication_chain_healthy(bigint,smallint,bigint)'::regprocedure;
  v_writer oid := 'arena.publish_verified_position_history(bigint,bigint,timestamptz,jsonb,text,text)'::regprocedure;
BEGIN
  IF NOT pg_catalog.has_function_privilege('service_role', v_checkpoint, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_writer, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_checkpoint, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_writer, 'EXECUTE')
     OR pg_catalog.has_function_privilege('service_role', v_chain_guard, 'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc
       WHERE oid IN (v_checkpoint, v_writer)
         AND (
           proowner <> 'postgres'::regrole
           OR NOT prosecdef
           OR prorettype <> 'jsonb'::regtype
           OR NOT proconfig @> ARRAY['search_path=pg_catalog, pg_temp']::text[]
         )
     ) THEN
    RAISE EXCEPTION 'writer callable contract failed';
  END IF;
END
$callables$;

CREATE TABLE arena.position_history_future_guard
  PARTITION OF arena.position_history
  FOR VALUES FROM ('2098-01-01T00:00:00Z') TO ('2098-02-01T00:00:00Z');

DO $truncate_acl$
BEGIN
  IF pg_catalog.has_table_privilege(
       'service_role', 'arena.position_history', 'TRUNCATE'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.position_history_default', 'TRUNCATE'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.position_history_future_guard', 'TRUNCATE'
     ) THEN
    RAISE EXCEPTION 'position-history truncate ACL is not fail-closed';
  END IF;
END
$truncate_acl$;
SQL

expect_failure_contains \
  "anon-checkpoint" \
  "permission denied for function get_position_history_publication_checkpoint" \
  "SET ROLE anon; SELECT arena.get_position_history_publication_checkpoint(1::smallint,1::bigint)"
expect_failure_contains \
  "authenticated-writer" \
  "permission denied for function publish_verified_position_history" \
  "SET ROLE authenticated; SELECT arena.publish_verified_position_history(1,NULL,NULL,'[]'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')"
expect_failure_contains \
  "service-child-truncate" \
  "permission denied for table position_history_default" \
  "SET ROLE service_role; TRUNCATE arena.position_history_default"
expect_failure_contains \
  "service-future-child-truncate" \
  "permission denied for table position_history_future_guard" \
  "SET ROLE service_role; TRUNCATE arena.position_history_future_guard"

CHECKPOINT_EMPTY="$(psql_cmd -Atq -c "SET ROLE service_role; SELECT arena.get_position_history_publication_checkpoint(1::smallint,1::bigint)")"
if [[ "$CHECKPOINT_EMPTY" != *'"publicationId": null'* || "$CHECKPOINT_EMPTY" != *'"cursor": null'* ]]; then
  echo "[verified-history-writer] empty checkpoint inferred legacy state: $CHECKPOINT_EMPTY" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
INSERT INTO arena.raw_objects (
  source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,
  content_hash,quarantined,meta,source_run_id,trust_artifact_role
)
SELECT 1,'history:position_history',1,NULL,statement_timestamp()-interval '5 minutes',
       'strict-shape.json.gz',100,repeat('8',64),false,
       fixture.history_meta(
         repeat('8',64),statement_timestamp()-interval '5 minutes',NULL,'exhausted'
       ),repeat('8',64),'event_history';
UPDATE arena.raw_objects
SET meta = meta || '{"unknown_meta":true}'::jsonb
WHERE source_run_id = repeat('8',64);
SQL
expect_failure_contains \
  "unknown-raw-meta-key" \
  "RAW evidence binding is invalid" \
  "SET ROLE service_role; SELECT arena.publish_verified_position_history(1,NULL,NULL,'[]'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')"

psql_cmd -q -c "UPDATE arena.raw_objects SET meta=fixture.history_meta(source_run_id,fetched_at,NULL,'exhausted') WHERE source_run_id=repeat('8',64)"
psql_cmd -q -c "UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{raw_integrity,unknown_key}','true'::jsonb) WHERE source_run_id=repeat('8',64)"
expect_failure_contains \
  "unknown-raw-integrity-key" \
  "RAW evidence binding is invalid" \
  "SET ROLE service_role; SELECT arena.publish_verified_position_history(1,NULL,NULL,'[]'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')"

psql_cmd -q -c "UPDATE arena.raw_objects SET meta=fixture.history_meta(source_run_id,fetched_at,NULL,'exhausted') WHERE source_run_id=repeat('8',64)"
psql_cmd -q -c "UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{raw_integrity,version}','\"1\"'::jsonb) WHERE source_run_id=repeat('8',64)"
expect_failure_contains \
  "string-raw-integrity-version" \
  "RAW evidence binding is invalid" \
  "SET ROLE service_role; SELECT arena.publish_verified_position_history(1,NULL,NULL,'[]'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')"

psql_cmd -q -c "UPDATE arena.raw_objects SET meta=fixture.history_meta(source_run_id,fetched_at,NULL,'exhausted') WHERE source_run_id=repeat('8',64)"
psql_cmd -q -c "UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{observed_at}',to_jsonb(replace(meta->>'observed_at','T',' '))) WHERE source_run_id=repeat('8',64)"
expect_failure_contains \
  "noncanonical-raw-timestamp" \
  "RAW evidence binding is invalid" \
  "SET ROLE service_role; SELECT arena.publish_verified_position_history(1,NULL,NULL,'[]'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')"

psql_cmd -q -c "UPDATE arena.raw_objects SET meta=fixture.history_meta(source_run_id,fetched_at,NULL,'exhausted') WHERE source_run_id=repeat('8',64)"
psql_cmd -q -c "UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{termination,unknown_key}','true'::jsonb) WHERE source_run_id=repeat('8',64)"
expect_failure_contains \
  "unknown-termination-key" \
  "terminal evidence is invalid" \
  "SET ROLE service_role; SELECT arena.publish_verified_position_history(1,NULL,NULL,'[]'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')"

psql_cmd -q -c "UPDATE arena.raw_objects SET meta=fixture.history_meta(source_run_id,fetched_at,NULL,'exhausted') WHERE source_run_id=repeat('8',64)"
psql_cmd -q -c "UPDATE arena.raw_objects SET meta=jsonb_set(meta,'{termination,claim_observations,0,unknown_key}','true'::jsonb) WHERE source_run_id=repeat('8',64)"
expect_failure_contains \
  "unknown-claim-key" \
  "terminal evidence is invalid" \
  "SET ROLE service_role; SELECT arena.publish_verified_position_history(1,NULL,NULL,'[]'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')"
psql_cmd -q -c "DELETE FROM arena.raw_objects WHERE source_run_id=repeat('8',64)"
psql_cmd -q -c "ALTER SEQUENCE arena.raw_objects_id_seq RESTART WITH 1"

psql_cmd -q <<'SQL'
INSERT INTO arena.ingest_cursors (trader_id, kind, cursor_value)
VALUES (2, 'position_history', '2099-01-01T00:00:00.000Z');

INSERT INTO arena.raw_objects (
  source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,
  content_hash,quarantined,meta,source_run_id,trust_artifact_role
)
SELECT 1,'history:position_history',1,NULL,statement_timestamp()-interval '4 minutes',
       'run-a.json.gz',100,repeat('a',64),false,
       fixture.history_meta(
         repeat('a',64),statement_timestamp()-interval '4 minutes',NULL,'exhausted'
       ),repeat('a',64),'event_history';

INSERT INTO arena.raw_objects (
  source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,
  content_hash,quarantined,meta,source_run_id,trust_artifact_role
)
SELECT 1,'history:position_history',2,NULL,statement_timestamp()-interval '3 minutes',
       'run-b.json.gz',100,repeat('b',64),false,
       fixture.history_meta(
         repeat('b',64),statement_timestamp()-interval '3 minutes',NULL,'exhausted'
       ),repeat('b',64),'event_history';
SQL

GENESIS_ROWS='[{"opened_at":"2026-08-03T10:00:00.000Z","closed_at":"2026-08-03T11:00:00.000Z","symbol":"BTCUSDT","side":"long","leverage":2,"size":1,"entry_price":100,"exit_price":110,"realized_pnl":10,"dedupe_hash":"position-1","raw":{"id":"position-1"}}]'
NONCANONICAL_ROWS='[{"opened_at":"2026-08-03T10:00:00+00:00","closed_at":"2026-08-03T11:00:00+00:00","symbol":"BTCUSDT","side":"long","leverage":2,"size":1,"entry_price":100,"exit_price":110,"realized_pnl":10,"dedupe_hash":"position-1","raw":{"id":"position-1"}}]'
expect_failure_contains \
  "noncanonical-typed-timestamp" \
  "parsed rows are invalid" \
  "SET ROLE service_role; SELECT arena.publish_verified_position_history(1,NULL,'2026-08-03T11:00:00Z','$NONCANONICAL_ROWS'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')"
RAWLESS_ROWS='[{"opened_at":"2026-08-03T10:00:00.000Z","closed_at":"2026-08-03T11:00:00.000Z","symbol":"BTCUSDT","side":"long","leverage":2,"size":1,"entry_price":100,"exit_price":110,"realized_pnl":10,"dedupe_hash":"position-1","raw":null}]'
expect_failure_contains \
  "missing-typed-raw-object" \
  "row envelope is invalid" \
  "SET ROLE service_role; SELECT arena.publish_verified_position_history(1,NULL,'2026-08-03T11:00:00Z','$RAWLESS_ROWS'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')"

GENESIS_RESULT="$(psql_cmd -Atq -c "SET ROLE service_role; SELECT arena.publish_verified_position_history(1,NULL,'2026-08-03T11:00:00Z','$GENESIS_ROWS'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')")"
if [[ "$GENESIS_RESULT" != *'"replayed": false'* || "$GENESIS_RESULT" != *'"rowsWritten": 1'* ]]; then
  echo "[verified-history-writer] genesis result invalid: $GENESIS_RESULT" >&2
  exit 1
fi

ZERO_RESULT="$(psql_cmd -Atq -c "SET ROLE service_role; SELECT arena.publish_verified_position_history(2,NULL,NULL,'[]'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')")"
if [[ "$ZERO_RESULT" != *'"parsedRowCount": 0'* || "$ZERO_RESULT" != *'"cursor": null'* ]]; then
  echo "[verified-history-writer] zero-row result invalid: $ZERO_RESULT" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DO $genesis_state$
DECLARE
  v_first bigint;
  v_zero bigint;
BEGIN
  SELECT publication_id INTO STRICT v_first
  FROM arena.record_surface_publications WHERE source_run_id = repeat('a',64);
  SELECT publication_id INTO STRICT v_zero
  FROM arena.record_surface_publications WHERE source_run_id = repeat('b',64);
  IF (SELECT verified_publication_id FROM arena.position_history
      WHERE dedupe_hash = 'position-1') IS DISTINCT FROM v_first
     OR (SELECT cursor_value FROM arena.ingest_cursors
         WHERE trader_id=1 AND kind='position_history')::timestamptz
          IS DISTINCT FROM '2026-08-03T11:00:00Z'::timestamptz
     OR EXISTS (
       SELECT 1 FROM arena.ingest_cursors
       WHERE trader_id=2 AND kind='position_history'
     )
     OR (SELECT parsed_row_count FROM arena.record_surface_publications
         WHERE publication_id=v_zero) <> 0 THEN
    RAISE EXCEPTION 'genesis or zero-row atomic state failed';
  END IF;
END
$genesis_state$;
SQL

REPLAY_RESULT="$(psql_cmd -Atq -c "SET ROLE service_role; SELECT arena.publish_verified_position_history(1,NULL,'2026-08-03T11:00:00Z','$GENESIS_ROWS'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')")"
if [[ "$REPLAY_RESULT" != *'"replayed": true'* || "$REPLAY_RESULT" != *'"rowsWritten": 0'* ]]; then
  echo "[verified-history-writer] exact replay invalid: $REPLAY_RESULT" >&2
  exit 1
fi

MISMATCH_ROWS="${GENESIS_ROWS/\"realized_pnl\":10/\"realized_pnl\":11}"
expect_failure_contains \
  "conflicting-replay" \
  "replay conflicts with its frozen receipt" \
  "SET ROLE service_role; SELECT arena.publish_verified_position_history(1,NULL,'2026-08-03T11:00:00Z','$MISMATCH_ROWS'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')"

psql_cmd -q <<'SQL'
INSERT INTO arena.raw_objects (
  source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,
  content_hash,quarantined,meta,source_run_id,trust_artifact_role
)
SELECT 1,'history:position_history',1,NULL,statement_timestamp()-interval '2 minutes',
       'run-d.json.gz',100,repeat('d',64),false,
       fixture.history_meta(
         repeat('d',64),statement_timestamp()-interval '2 minutes',
         '2026-08-03T11:00:00Z','cursor_overlap','2026-08-03T11:00:00Z'
       ),repeat('d',64),'event_history';
SQL

HEAD_ONE="$(psql_cmd -Atq -c "SELECT publication_id FROM arena.record_surface_publications WHERE source_run_id=repeat('a',64)")"
OVERLAP_ROWS='[{"opened_at":"2026-08-03T10:00:00.000Z","closed_at":"2026-08-03T11:00:00.000Z","symbol":"BTCUSDT","side":"long","leverage":2,"size":1,"entry_price":100,"exit_price":110,"realized_pnl":10,"dedupe_hash":"position-1","raw":{"id":"position-1"}},{"opened_at":"2026-08-03T11:30:00.000Z","closed_at":"2026-08-03T12:00:00.000Z","symbol":"ETHUSDT","side":"short","leverage":3,"size":2,"entry_price":200,"exit_price":190,"realized_pnl":20,"dedupe_hash":"position-2","raw":{"id":"position-2"}}]'
OVERLAP_RESULT="$(psql_cmd -Atq -c "SET ROLE service_role; SELECT arena.publish_verified_position_history(3,$HEAD_ONE,'2026-08-03T12:00:00Z','$OVERLAP_ROWS'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')")"
if [[ "$OVERLAP_RESULT" != *'"rowsWritten": 2'* || "$OVERLAP_RESULT" != *'"replayed": false'* ]]; then
  echo "[verified-history-writer] overlap result invalid: $OVERLAP_RESULT" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DO $overlap_state$
DECLARE
  v_head bigint;
BEGIN
  SELECT publication_id INTO STRICT v_head
  FROM arena.record_surface_publications WHERE source_run_id=repeat('d',64);
  IF (SELECT count(*) FROM arena.position_history
      WHERE verified_publication_id=v_head) <> 2
     OR (SELECT cursor_value FROM arena.ingest_cursors
         WHERE trader_id=1 AND kind='position_history')::timestamptz
          IS DISTINCT FROM '2026-08-03T12:00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'overlap row binding or cursor failed';
  END IF;
END
$overlap_state$;
SQL

OLD_REPLAY_RESULT="$(psql_cmd -Atq -c "SET ROLE service_role; SELECT arena.publish_verified_position_history(1,NULL,'2026-08-03T11:00:00Z','$GENESIS_ROWS'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')")"
if [[ "$OLD_REPLAY_RESULT" != *'"replayed": true'* || "$OLD_REPLAY_RESULT" != *'"rowsWritten": 0'* ]]; then
  echo "[verified-history-writer] old non-head replay invalid: $OLD_REPLAY_RESULT" >&2
  exit 1
fi

HEAD_CURRENT="$(psql_cmd -Atq -c "SELECT publication_id FROM arena.record_surface_publications WHERE source_run_id=repeat('d',64)")"
expect_failure_contains \
  "verified-row-content-update" \
  "verified position-history row content is immutable" \
  "UPDATE arena.position_history SET realized_pnl=999 WHERE dedupe_hash='position-1'"
expect_failure_contains \
  "verified-row-delete" \
  "verified position-history rows are immutable" \
  "DELETE FROM arena.position_history WHERE dedupe_hash='position-1'"
expect_failure_contains \
  "direct-verified-row-insert" \
  "verified position-history binding is writer-owned" \
  "SET ROLE service_role; INSERT INTO arena.position_history (trader_id,closed_at,symbol,currency,dedupe_hash,verified_publication_id) VALUES (1,'2026-08-03T13:00:00Z','XRPUSDT','USDT','direct-forgery',$HEAD_CURRENT)"
expect_failure_contains \
  "spoofed-writer-guc" \
  "verified position-history binding is writer-owned" \
  "SET ROLE service_role; SELECT set_config('arena.verified_position_history_publication_id','$HEAD_CURRENT',true); INSERT INTO arena.position_history (trader_id,closed_at,symbol,currency,dedupe_hash,verified_publication_id) VALUES (1,'2026-08-03T13:01:00Z','XRPUSDT','USDT','spoofed-forgery',$HEAD_CURRENT)"
expect_failure_contains \
  "verified-row-truncate" \
  "verified position-history rows cannot be truncated" \
  "TRUNCATE arena.position_history"
expect_failure_contains \
  "verified-child-row-truncate" \
  "permission denied for table position_history_default" \
  "SET ROLE service_role; TRUNCATE arena.position_history_default"

psql_cmd -q <<'SQL'
-- A complete capture cannot silently bless a conflicting legacy typed row.
INSERT INTO arena.position_history (
  trader_id,opened_at,closed_at,symbol,side,leverage,size,entry_price,
  exit_price,realized_pnl,currency,dedupe_hash,raw
) VALUES (
  3,'2026-08-03T08:00:00Z','2026-08-03T09:00:00Z','SOLUSDT','long',2,1,
  10,11,999,'USDT','position-conflict','{}'
);
INSERT INTO arena.raw_objects (
  source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,
  content_hash,quarantined,meta,source_run_id,trust_artifact_role
)
SELECT 1,'history:position_history',3,NULL,statement_timestamp()-interval '1 minute',
       'run-f.json.gz',100,repeat('f',64),false,
       fixture.history_meta(
         repeat('f',64),statement_timestamp()-interval '1 minute',NULL,'exhausted'
       ),repeat('f',64),'event_history';
SQL

CONFLICT_ROWS='[{"opened_at":"2026-08-03T08:00:00.000Z","closed_at":"2026-08-03T09:00:00.000Z","symbol":"SOLUSDT","side":"long","leverage":2,"size":1,"entry_price":10,"exit_price":11,"realized_pnl":1,"dedupe_hash":"position-conflict","raw":{}}]'
expect_failure_contains \
  "typed-row-conflict" \
  "rows conflict with existing typed data" \
  "SET ROLE service_role; SELECT arena.publish_verified_position_history(4,NULL,'2026-08-03T09:00:00Z','$CONFLICT_ROWS'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')"

psql_cmd -q <<'SQL'
DO $conflict_rollback$
BEGIN
  IF EXISTS (
       SELECT 1 FROM arena.record_surface_publications
       WHERE source_run_id=repeat('f',64)
     )
     OR (SELECT verified_publication_id FROM arena.position_history
         WHERE dedupe_hash='position-conflict') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM arena.ingest_cursors
       WHERE trader_id=3 AND kind='position_history'
     ) THEN
    RAISE EXCEPTION 'typed conflict left partial publication state';
  END IF;
END
$conflict_rollback$;

-- Tier-C/caller-limited evidence is RAW-only and cannot call the writer.
UPDATE arena.raw_objects
SET meta = fixture.history_meta(
      repeat('f',64),fetched_at,NULL,'partial',NULL,2,'caller_limited'
    )
WHERE source_run_id=repeat('f',64);
SQL
expect_failure_contains \
  "partial-evidence" \
  "RAW evidence binding is invalid" \
  "SET ROLE service_role; SELECT arena.publish_verified_position_history(4,NULL,NULL,'[]'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')"

psql_cmd -q <<SQL
INSERT INTO arena.raw_objects (
  source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,
  content_hash,quarantined,meta,source_run_id,trust_artifact_role
)
SELECT 1,'history:position_history',1,NULL,statement_timestamp()-interval '30 seconds',
       'run-e.json.gz',100,repeat('e',64),false,
       fixture.history_meta(
         repeat('e',64),statement_timestamp()-interval '30 seconds',
         '2026-08-03T12:00:00Z','cursor_overlap','2026-08-03T12:00:00Z'
       ),repeat('e',64),'event_history';
SQL

STALE_ROWS='[{"opened_at":"2026-08-03T11:30:00.000Z","closed_at":"2026-08-03T12:00:00.000Z","symbol":"ETHUSDT","side":"short","leverage":3,"size":2,"entry_price":200,"exit_price":190,"realized_pnl":20,"dedupe_hash":"position-2","raw":{"id":"position-2"}}]'
expect_failure_contains \
  "stale-predecessor" \
  "not based on the current head" \
  "SET ROLE service_role; SELECT arena.publish_verified_position_history(5,$HEAD_ONE,'2026-08-03T12:00:00Z','$STALE_ROWS'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')"

psql_cmd -q <<'SQL'
UPDATE arena.raw_objects
SET fetched_at = (
      SELECT observed_at
      FROM arena.record_surface_publications
      WHERE source_run_id = repeat('d',64)
    ),
    meta = fixture.history_meta(
      repeat('e',64),
      (
        SELECT observed_at
        FROM arena.record_surface_publications
        WHERE source_run_id = repeat('d',64)
      ),
      '2026-08-03T12:00:00Z',
      'cursor_overlap',
      '2026-08-03T12:00:00Z'
    )
WHERE source_run_id = repeat('e',64);
SQL
expect_failure_contains \
  "equal-observed-at" \
  "publication is stale" \
  "SET ROLE service_role; SELECT arena.publish_verified_position_history(5,$HEAD_CURRENT,'2026-08-03T12:00:00Z','$STALE_ROWS'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')"

psql_cmd -q <<'SQL'
INSERT INTO arena.raw_objects (
  source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,
  content_hash,quarantined,meta,source_run_id,trust_artifact_role
)
SELECT 1,'history:position_history',2,NULL,statement_timestamp()-interval '10 seconds',
       'run-c.json.gz',100,repeat('c',64),false,
       fixture.history_meta(
         repeat('c',64),statement_timestamp()-interval '10 seconds',NULL,'exhausted'
       ),repeat('c',64),'event_history';
SQL

ZERO_HEAD="$(psql_cmd -Atq -c "SELECT publication_id FROM arena.record_surface_publications WHERE source_run_id=repeat('b',64)")"
ZERO_SUCCESSOR_RAW="$(psql_cmd -Atq -c "SELECT id FROM arena.raw_objects WHERE source_run_id=repeat('c',64)")"
FRESH_ROWS='[{"opened_at":"2026-08-03T09:30:00.000Z","closed_at":"2026-08-03T10:30:00.000Z","symbol":"BNBUSDT","side":"long","leverage":2,"size":1,"entry_price":50,"exit_price":55,"realized_pnl":5,"dedupe_hash":"position-fresh-after-zero","raw":{"id":"position-fresh-after-zero"}}]'
FRESH_RESULT="$(psql_cmd -Atq -c "SET ROLE service_role; SELECT arena.publish_verified_position_history($ZERO_SUCCESSOR_RAW,$ZERO_HEAD,'2026-08-03T10:30:00Z','$FRESH_ROWS'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')")"
if [[ "$FRESH_RESULT" != *'"rowsWritten": 1'* || "$FRESH_RESULT" != *'"replayed": false'* ]]; then
  echo "[verified-history-writer] cursorless-head exhaustive successor invalid: $FRESH_RESULT" >&2
  exit 1
fi

ZERO_SUCCESSOR_HEAD="$(psql_cmd -Atq -c "SELECT publication_id FROM arena.record_surface_publications WHERE source_run_id=repeat('c',64)")"
psql_cmd -q <<'SQL'
DO $zero_successor_state$
DECLARE
  v_head bigint;
BEGIN
  SELECT publication_id INTO STRICT v_head
  FROM arena.record_surface_publications
  WHERE source_run_id = repeat('c',64);
  IF (SELECT previous_publication_id FROM arena.record_surface_publications
      WHERE publication_id = v_head) IS DISTINCT FROM (
        SELECT publication_id FROM arena.record_surface_publications
        WHERE source_run_id = repeat('b',64)
      )
     OR (SELECT verified_publication_id FROM arena.position_history
         WHERE dedupe_hash = 'position-fresh-after-zero') IS DISTINCT FROM v_head
     OR (SELECT cursor_value FROM arena.ingest_cursors
         WHERE trader_id=2 AND kind='position_history')::timestamptz
          IS DISTINCT FROM '2026-08-03T10:30:00Z'::timestamptz THEN
    RAISE EXCEPTION 'cursorless-head exhaustive successor state failed';
  END IF;
END
$zero_successor_state$;

INSERT INTO arena.raw_objects (
  source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,
  content_hash,quarantined,meta,source_run_id,trust_artifact_role
)
SELECT 1,'history:position_history',2,NULL,statement_timestamp(),
       'run-ancestor-blocked.json.gz',100,repeat('7',63)||'c',false,
       fixture.history_meta(
         repeat('7',63)||'c',statement_timestamp(),
         '2026-08-03T10:30:00Z','cursor_overlap','2026-08-03T10:30:00Z'
       ),repeat('7',63)||'c','event_history';

UPDATE arena.raw_objects
SET quarantined = true
WHERE source_run_id = repeat('b',64);
SQL

ANCESTOR_BLOCKED_RAW="$(psql_cmd -Atq -c "SELECT id FROM arena.raw_objects WHERE source_run_id=repeat('7',63)||'c'")"
expect_failure_contains \
  "quarantined-ancestor-checkpoint" \
  "evidence is unavailable or quarantined" \
  "SET ROLE service_role; SELECT arena.get_position_history_publication_checkpoint(1::smallint,2::bigint)"
expect_failure_contains \
  "quarantined-ancestor-replay" \
  "evidence is unavailable or quarantined" \
  "SET ROLE service_role; SELECT arena.publish_verified_position_history($ZERO_SUCCESSOR_RAW,$ZERO_HEAD,'2026-08-03T10:30:00Z','$FRESH_ROWS'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')"
expect_failure_contains \
  "quarantined-ancestor-successor" \
  "evidence is unavailable or quarantined" \
  "SET ROLE service_role; SELECT arena.publish_verified_position_history($ANCESTOR_BLOCKED_RAW,$ZERO_SUCCESSOR_HEAD,'2026-08-03T10:30:00Z','$FRESH_ROWS'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')"

psql_cmd -q -c "UPDATE arena.raw_objects SET quarantined=true WHERE source_run_id=repeat('d',64)"
expect_failure_contains \
  "quarantined-head-checkpoint" \
  "evidence is unavailable or quarantined" \
  "SET ROLE service_role; SELECT arena.get_position_history_publication_checkpoint(1::smallint,1::bigint)"
expect_failure_contains \
  "quarantined-head-successor" \
  "evidence is unavailable or quarantined" \
  "SET ROLE service_role; SELECT arena.publish_verified_position_history(5,$HEAD_CURRENT,'2026-08-03T12:00:00Z','$STALE_ROWS'::jsonb,'tier_b','arena.ingest.position-history-publisher.worker@1')"

FINGERPRINT_BEFORE="$(psql_cmd -Atq -c "SELECT (SELECT count(*) FROM arena.record_surface_publications) || '|' || (SELECT count(*) FROM arena.position_history) || '|' || (SELECT count(*) FROM arena.ingest_cursors)")"
expect_failure_contains \
  "fail-closed-replay" \
  "verified position-history writer is already or partially installed" \
  "\\i $MIGRATION"
FINGERPRINT_AFTER="$(psql_cmd -Atq -c "SELECT (SELECT count(*) FROM arena.record_surface_publications) || '|' || (SELECT count(*) FROM arena.position_history) || '|' || (SELECT count(*) FROM arena.ingest_cursors)")"
if [[ "$FINGERPRINT_BEFORE" != "$FINGERPRINT_AFTER" ]]; then
  echo "[verified-history-writer] fail-closed replay changed durable state" >&2
  exit 1
fi

echo "verified position-history publication writer PostgreSQL 17 proof passed"
