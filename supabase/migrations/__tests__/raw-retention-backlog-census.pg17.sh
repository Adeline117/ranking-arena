#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261118134316_raw_retention_backlog_census:
#   * the census counts expired / pinned / eligible pointer rows and deletes
#     nothing;
#   * the orphan walk is count-only by default, covers the whole bucket across
#     pages and keeps a completed-pass tally;
#   * enqueue is refused while the switch is off; with it on only old,
#     pointer-less, not-already-queued objects are queued;
#   * referenced RAW (snapshot / trust pinned, or any pointer row) never
#     becomes an orphan GC obligation; a path that regains a pointer is
#     retired at claim time instead of being handed to Storage removal.
# Isolated cluster on a private socket with minimal stand-ins for the
# Supabase storage schema and the arena RAW/evidence tables.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20261118134316_raw_retention_backlog_census.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  [[ -x "$PG_BIN/$executable" ]] || { echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2; exit 1; }
done
[[ "$("$PG_BIN/psql" --version)" == psql\ \(PostgreSQL\)\ 17.* ]] || { echo "requires PostgreSQL 17" >&2; exit 1; }

TMP_ROOT="$(mktemp -d /tmp/raw-retention-census-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
PORT="${PGPORT_OVERRIDE:-$((50000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"
cleanup() {
  local code=$?
  [[ -s "$DATA_DIR/postmaster.pid" ]] && "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$TMP_ROOT"
  exit "$code"
}
trap cleanup EXIT

export PGOPTIONS='-c client_min_messages=warning -c statement_timeout=60s'
psql_db() { "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"; }
assert_equal() { [[ "$2" == "$3" ]] || { echo "$1: expected '$2', got '$3'" >&2; exit 1; }; }
assert_fails() {
  local label="$1"; shift
  if psql_db -qc "$*" >/dev/null 2>&1; then echo "$label: expected failure" >&2; exit 1; fi
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$TMP_ROOT/postgres.log" -w start >/dev/null

psql_db -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA arena;
CREATE SCHEMA storage;
GRANT USAGE ON SCHEMA arena TO service_role;
CREATE TABLE storage.objects (
  bucket_id text NOT NULL, name text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL, metadata jsonb,
  PRIMARY KEY (bucket_id, name)
);
CREATE TABLE arena.raw_objects (
  id bigint PRIMARY KEY, storage_path text NOT NULL UNIQUE, bytes int NOT NULL,
  quarantined boolean NOT NULL DEFAULT false, fetched_at timestamptz NOT NULL
);
CREATE TABLE arena.raw_object_gc_queue (
  raw_object_id bigint NOT NULL UNIQUE, storage_path text PRIMARY KEY,
  content_hash text NOT NULL, attempts integer NOT NULL DEFAULT 0
);
CREATE TABLE arena.leaderboard_snapshots (id bigint PRIMARY KEY, raw_object_id bigint);
CREATE TABLE arena.metric_trust_runs (
  source_run_id text PRIMARY KEY, population_raw_object_id bigint, manifest_raw_object_id bigint
);
CREATE TABLE arena.metric_trust_artifacts (observation_id bigint, raw_object_id bigint);

-- Pointer rows (all 40 days old unless noted):
--   1 snapshot-pinned, 2 trust run, 3 trust artifact, 4 eligible,
--   5 young (5 days), 6 quarantined, 7 eligible but already GC-queued.
INSERT INTO arena.raw_objects VALUES
  (1, 'a/1.json.gz', 100, false, now() - interval '40 days'),
  (2, 'a/2.json.gz', 200, false, now() - interval '40 days'),
  (3, 'a/3.json.gz', 300, false, now() - interval '40 days'),
  (4, 'a/4.json.gz', 400, false, now() - interval '40 days'),
  (5, 'a/5.json.gz', 500, false, now() - interval '5 days'),
  (6, 'a/6.json.gz', 600, true, now() - interval '40 days');
INSERT INTO arena.leaderboard_snapshots VALUES (10, 1);
INSERT INTO arena.metric_trust_runs VALUES ('run', 2, 2);
INSERT INTO arena.metric_trust_artifacts VALUES (1, 3);
INSERT INTO arena.raw_object_gc_queue VALUES (7, 'a/7.json.gz', 'h');

-- Bucket: every pointer path, the queued path, three old orphans (o1..o3),
-- one young orphan, and an object in another bucket.
INSERT INTO storage.objects
SELECT 'raw-snapshots', storage_path, fetched_at, jsonb_build_object('size', bytes)
FROM arena.raw_objects;
INSERT INTO storage.objects VALUES
  ('raw-snapshots', 'a/7.json.gz', now() - interval '40 days', '{"size": 700}'),
  ('raw-snapshots', 'b/o1.json.gz', now() - interval '90 days', '{"size": 1000}'),
  ('raw-snapshots', 'b/o2.json.gz', now() - interval '60 days', '{"size": 2000}'),
  ('raw-snapshots', 'b/o3.json.gz', now() - interval '31 days', '{"size": 3000}'),
  ('raw-snapshots', 'b/young.json.gz', now() - interval '2 days', '{"size": 4000}'),
  ('other-bucket', 'b/o9.json.gz', now() - interval '90 days', '{"size": 9000}');
SQL

psql_db -q -f "$MIGRATION" >/dev/null
psql_db -q -f "$MIGRATION" >/dev/null # idempotent replay

assert_equal "switch starts off" "f" "$(psql_db -Atqc "SELECT delete_enabled FROM arena.raw_retention_settings")"

assert_equal "census: single-table aggregates only" "6|4|1000|0" "$(psql_db -Atqc "
  SELECT concat_ws('|', c->>'pointer_rows', c->>'expired_rows', c->>'expired_bytes',
                   c->>'orphan_queue_rows')
  FROM (SELECT arena.raw_retention_census(30) AS c) AS census")"
assert_fails "census refuses an unbounded statement_timeout" \
  "SET statement_timeout = 0; SELECT arena.raw_retention_census(30)"
assert_fails "pointer scan refuses an unbounded statement_timeout" \
  "SET statement_timeout = 0; SELECT arena.scan_raw_pointer_retention(10, 30)"
assert_fails "orphan scan refuses an unbounded statement_timeout" \
  "SET statement_timeout = 0; SELECT arena.scan_raw_storage_orphans(10, 30, false)"

# Pointer classification in id pages of 4: ids 1..6 -> pages of 4 and 2.
assert_equal "pointer page 1: 4 rows, 4 expired, 1 snapshot pin, 2 trust pins, 1 eligible" \
  "4|4|1|2|1|400|false" "$(psql_db -Atqc "
  SELECT concat_ws('|', r->>'page_rows', r->>'page_expired_rows', r->>'page_snapshot_pinned_rows',
                   r->>'page_trust_pinned_rows', r->>'page_eligible_rows', r->>'page_eligible_bytes',
                   r->>'pass_complete')
  FROM (SELECT arena.scan_raw_pointer_retention(4, 30) AS r) AS scan")"
assert_equal "pointer page 2 completes the pass (young and quarantined rows are not expired)" \
  "2|0|true" "$(psql_db -Atqc "
  SELECT concat_ws('|', r->>'page_rows', r->>'page_expired_rows', r->>'pass_complete')
  FROM (SELECT arena.scan_raw_pointer_retention(4, 30) AS r) AS scan")"
assert_equal "completed pointer pass tally, cursor reset" "6|4|1|2|1|400|0" "$(psql_db -Atqc "
  SELECT concat_ws('|', p->>'rows', p->>'expired_rows', p->>'snapshot_pinned_rows',
                   p->>'trust_pinned_rows', p->>'eligible_rows', p->>'eligible_bytes',
                   pointer_scan_after)
  FROM (SELECT last_completed_pointer_pass AS p, pointer_scan_after FROM arena.raw_retention_settings) AS s")"
assert_fails "census rejects a window under 30 days" "SELECT arena.raw_retention_census(7)"

# Count-only walk in pages of 4: 11 bucket objects -> pages of 4, 4, 3.
assert_equal "page 1 (count-only)" "4|0|false" "$(psql_db -Atqc "
  SELECT concat_ws('|', r->>'page_objects', r->>'enqueued', r->>'pass_complete')
  FROM (SELECT arena.scan_raw_storage_orphans(4, 30, false) AS r) AS scan")"
psql_db -Atqc "SELECT arena.scan_raw_storage_orphans(4, 30, false)" >/dev/null
assert_equal "last page completes the pass" "3|true" "$(psql_db -Atqc "
  SELECT concat_ws('|', r->>'page_objects', r->>'pass_complete')
  FROM (SELECT arena.scan_raw_storage_orphans(4, 30, false) AS r) AS scan")"
assert_equal "completed pass: 11 objects, 3 old orphans (6000 bytes), cursor reset" \
  "11|3|6000|" "$(psql_db -Atqc "
  SELECT concat_ws('|', last_completed_orphan_pass->>'objects', last_completed_orphan_pass->>'orphans',
                   last_completed_orphan_pass->>'orphan_bytes', orphan_scan_after)
  FROM arena.raw_retention_settings")"
assert_equal "count-only mode queued nothing and deleted no pointer" "0|6|1" "$(psql_db -Atqc "
  SELECT (SELECT count(*) FROM arena.raw_orphan_gc_queue) || '|' ||
         (SELECT count(*) FROM arena.raw_objects) || '|' ||
         (SELECT count(*) FROM arena.raw_object_gc_queue)")"

assert_fails "enqueue refused while the switch is off" \
  "SELECT arena.scan_raw_storage_orphans(100, 30, true)"
assert_fails "claim refused while the switch is off" \
  "SELECT * FROM arena.claim_raw_orphan_gc_batch(10)"
assert_fails "page size is bounded" "SELECT arena.scan_raw_storage_orphans(0, 30, false)"
assert_fails "window is bounded" "SELECT arena.scan_raw_storage_orphans(10, 29, false)"

psql_db -qc "UPDATE arena.raw_retention_settings SET delete_enabled = true"
psql_db -Atqc "SELECT arena.scan_raw_storage_orphans(100, 30, true)" >/dev/null
assert_equal "only old pointer-less, unqueued objects are queued" \
  "b/o1.json.gz,b/o2.json.gz,b/o3.json.gz" "$(psql_db -Atqc "
  SELECT string_agg(storage_path, ',' ORDER BY storage_path) FROM arena.raw_orphan_gc_queue")"
psql_db -Atqc "SELECT arena.scan_raw_storage_orphans(100, 30, true)" >/dev/null
assert_equal "a second pass queues nothing new" "3" "$(psql_db -Atqc "SELECT count(*) FROM arena.raw_orphan_gc_queue")"

# o2 regains a pointer before the drain: it must not be handed to Storage.
psql_db -qc "INSERT INTO arena.raw_objects VALUES (8, 'b/o2.json.gz', 2000, false, now())"
assert_equal "claim returns only still-orphaned paths" "b/o1.json.gz,b/o3.json.gz" "$(psql_db -Atqc "
  SELECT string_agg(storage_path, ',' ORDER BY storage_path) FROM arena.claim_raw_orphan_gc_batch(10)")"
assert_equal "the re-pointed path left the queue" "2" "$(psql_db -Atqc "SELECT count(*) FROM arena.raw_orphan_gc_queue")"

assert_equal "service_role: execute yes, switch/enqueue writes no" "true|true|true|true|false|false" "$(psql_db -Atqc "
  SELECT has_function_privilege('service_role', 'arena.raw_retention_census(integer)', 'EXECUTE')
    || '|' || has_function_privilege('service_role', 'arena.scan_raw_pointer_retention(integer,integer)', 'EXECUTE')
    || '|' || has_function_privilege('service_role', 'arena.scan_raw_storage_orphans(integer,integer,boolean)', 'EXECUTE')
    || '|' || has_function_privilege('service_role', 'arena.claim_raw_orphan_gc_batch(integer)', 'EXECUTE')
    || '|' || has_table_privilege('service_role', 'arena.raw_retention_settings', 'UPDATE')
    || '|' || has_table_privilege('service_role', 'arena.raw_orphan_gc_queue', 'INSERT')")"
assert_equal "anon cannot run any of it" "false|false|false" "$(psql_db -Atqc "
  SELECT has_function_privilege('anon', 'arena.raw_retention_census(integer)', 'EXECUTE')
    || '|' || has_function_privilege('anon', 'arena.scan_raw_storage_orphans(integer,integer,boolean)', 'EXECUTE')
    || '|' || has_function_privilege('anon', 'arena.claim_raw_orphan_gc_batch(integer)', 'EXECUTE')")"
assert_equal "storage.objects rows were never touched" "12" "$(psql_db -Atqc "SELECT count(*) FROM storage.objects")"

echo "RAW retention backlog census PostgreSQL 17 proof passed"
