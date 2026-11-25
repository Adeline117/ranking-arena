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
#   * the worker (lib/ingest/raw-retention.ts) no longer calls
#     arena.raw_retention_census: its cheap census statements run as
#     service_role under a 15s statement_timeout, a scan page that times out
#     (57014) or cannot take its lock (55P03) leaves the cursor and the pass
#     tallies untouched, and the read-only EXPLAIN statements handed to the
#     launch driver parse against this schema.
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
-- 20260721130000_raw_object_gc_outbox grants this to the worker role.
GRANT SELECT, DELETE ON TABLE arena.raw_object_gc_queue TO service_role;
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

# ── Worker statements (lib/ingest/raw-retention.ts) ─────────────────────────
# The worker no longer calls arena.raw_retention_census. Its census is planner
# statistics + relation size + the two small queue counts, run as the worker
# role under the 15s statement_timeout it sets. service_role has no privilege
# on arena.raw_objects here: pg_class and pg_total_relation_size need none.
psql_db -qc "ANALYZE arena.raw_objects"
assert_equal "worker estimate as service_role: reltuples matches, size is positive" "7|true" "$(psql_db -Atq <<'SQL'
SET ROLE service_role;
SET statement_timeout = '15s';
SELECT relation.reltuples::bigint || '|' || (pg_catalog.pg_total_relation_size(relation.oid) > 0)
  FROM pg_catalog.pg_class AS relation
 WHERE relation.oid = pg_catalog.to_regclass('arena.raw_objects');
SQL
)"
assert_equal "service_role cannot read arena.raw_objects directly in this stand-in" "f" \
  "$(psql_db -Atqc "SELECT has_table_privilege('service_role', 'arena.raw_objects', 'SELECT')")"
assert_equal "worker queue depths as service_role" "1|0|2|0" "$(psql_db -Atq <<'SQL'
SET ROLE service_role;
SET statement_timeout = '15s';
SELECT concat_ws('|',
  (SELECT pg_catalog.count(*) FROM arena.raw_object_gc_queue),
  (SELECT pg_catalog.count(*) FROM arena.raw_object_gc_queue WHERE attempts > 0),
  (SELECT pg_catalog.count(*) FROM arena.raw_orphan_gc_queue),
  (SELECT pg_catalog.count(*) FROM arena.raw_orphan_gc_queue WHERE attempts > 0));
SQL
)"

# A 15s statement_timeout satisfies the functions' bounded-timeout guard, and
# the worker role can page with the new 5,000 page size.
psql_db -qc "UPDATE arena.raw_retention_settings SET delete_enabled = false"
assert_equal "15s timeout + page 5000 accepted as service_role" "7|true" "$(psql_db -Atq <<'SQL'
SET ROLE service_role;
SET statement_timeout = '15s';
SELECT concat_ws('|', r->>'page_rows', r->>'pass_complete')
  FROM (SELECT arena.scan_raw_pointer_retention(5000, 30) AS r) AS scan;
SQL
)"
assert_equal "orphan page 5000 accepted as service_role" "11|true" "$(psql_db -Atq <<'SQL'
SET ROLE service_role;
SET statement_timeout = '15s';
SELECT concat_ws('|', r->>'page_objects', r->>'pass_complete')
  FROM (SELECT arena.scan_raw_storage_orphans(5000, 30, false) AS r) AS scan;
SQL
)"

# A page that times out or cannot take the settings row lock must leave the
# cursor and the running tallies exactly where they were. Start a pass (page
# of 4 of 7 rows), then hold the row lock from another session.
psql_db -Atqc "SELECT arena.scan_raw_pointer_retention(4, 30)" >/dev/null
progress_sql="SELECT concat_ws('|', pointer_scan_after, pointer_pass_rows, pointer_pass_expired_rows,
  pointer_pass_eligible_rows, pointer_pass_eligible_bytes, orphan_scan_after, orphan_pass_objects)
  FROM arena.raw_retention_settings"
progress_before="$(psql_db -Atqc "$progress_sql")"
assert_equal "pass in progress: cursor after id 4, 4 rows counted" "4|4|4|1|400||0" "$progress_before"
assert_equal "worker progress read as service_role" "4|4" "$(psql_db -Atq <<'SQL'
SET ROLE service_role;
SET statement_timeout = '15s';
SELECT concat_ws('|', pointer_scan_after, pointer_pass_rows)
  FROM arena.raw_retention_settings WHERE singleton;
SQL
)"

psql_db -q >/dev/null <<'SQL' &
BEGIN;
SELECT 1 FROM arena.raw_retention_settings WHERE singleton FOR UPDATE;
SELECT pg_sleep(8);
COMMIT;
SQL
blocker_pid=$!
for _ in $(seq 1 50); do
  [[ "$(psql_db -Atqc "SELECT count(*) FROM pg_stat_activity WHERE query = 'SELECT pg_sleep(8);'")" == "1" ]] && break
  sleep 0.1
done
sqlstate_of() { psql_db -v VERBOSITY=sqlstate -Atq 2>&1 <<<"$1" | grep -o 'ERROR:  [0-9A-Z]*' | head -1 || true; }
assert_equal "pointer page under a short statement_timeout is cancelled with 57014" "ERROR:  57014" \
  "$(sqlstate_of "SET statement_timeout = '300ms'; SELECT arena.scan_raw_pointer_retention(4, 30);")"
assert_equal "orphan page under a short statement_timeout is cancelled with 57014" "ERROR:  57014" \
  "$(sqlstate_of "SET statement_timeout = '300ms'; SELECT arena.scan_raw_storage_orphans(4, 30, false);")"
assert_equal "pointer page gives up on the row lock with 55P03 inside the 15s bound" "ERROR:  55P03" \
  "$(sqlstate_of "SET statement_timeout = '15s'; SELECT arena.scan_raw_pointer_retention(4, 30);")"
assert_equal "timed-out pages moved neither cursor nor tallies" "$progress_before" \
  "$(psql_db -Atqc "$progress_sql")"
wait "$blocker_pid"
assert_equal "the next run resumes from the kept cursor and finishes the pass" "3|true" "$(psql_db -Atqc "
  SELECT concat_ws('|', r->>'page_rows', r->>'pass_complete')
  FROM (SELECT arena.scan_raw_pointer_retention(4, 30) AS r) AS scan")"

# Read-only EXPLAIN statements (no ANALYZE) given to the launch driver in the
# PR. They must stay valid SQL against the migration's tables; with seq scans
# discouraged, the pointer page must be able to walk the primary key.
explain() { psql_db -Atq -c "SET enable_seqscan = off" -c "$1"; }
old_census_plan="$(explain "
EXPLAIN
SELECT pg_catalog.count(*) AS pointer_rows,
       COALESCE(pg_catalog.sum(raw.bytes::bigint), 0) AS pointer_bytes,
       pg_catalog.count(*) FILTER (WHERE raw.quarantined) AS quarantined_rows,
       pg_catalog.min(raw.fetched_at) AS oldest_fetched_at,
       pg_catalog.count(*) FILTER (
         WHERE NOT raw.quarantined AND raw.fetched_at < now() - interval '30 days'
       ) AS expired_rows,
       COALESCE(
         pg_catalog.sum(raw.bytes::bigint) FILTER (
           WHERE NOT raw.quarantined AND raw.fetched_at < now() - interval '30 days'
         ),
         0
       ) AS expired_bytes
  FROM arena.raw_objects AS raw;")"
[[ "$old_census_plan" == *"Seq Scan on raw_objects"* ]] \
  || { echo "old census EXPLAIN: expected a sequential scan even with seq scans discouraged" >&2; exit 1; }

pointer_page_plan="$(explain "
EXPLAIN
WITH page AS MATERIALIZED (
  SELECT raw.id, raw.bytes::bigint AS bytes,
         NOT raw.quarantined AND raw.fetched_at < now() - interval '30 days' AS expired
    FROM arena.raw_objects AS raw
   WHERE raw.id > 0            -- example cursor: arena.raw_retention_settings.pointer_scan_after
   ORDER BY raw.id
   LIMIT 5000
),
classified AS MATERIALIZED (
  SELECT page.id,
         page.bytes,
         EXISTS (
           SELECT 1 FROM arena.leaderboard_snapshots AS snapshot
            WHERE snapshot.raw_object_id = page.id
         ) AS snapshot_pinned,
         (
           EXISTS (
             SELECT 1 FROM arena.metric_trust_runs AS run
              WHERE run.population_raw_object_id = page.id
           )
           OR EXISTS (
             SELECT 1 FROM arena.metric_trust_runs AS run
              WHERE run.manifest_raw_object_id = page.id
           )
           OR EXISTS (
             SELECT 1 FROM arena.metric_trust_artifacts AS artifact
              WHERE artifact.raw_object_id = page.id
           )
         ) AS trust_pinned
    FROM page
   WHERE page.expired
)
SELECT (SELECT pg_catalog.count(*) FROM page),
       (SELECT pg_catalog.count(*) FROM classified),
       (SELECT pg_catalog.count(*) FROM classified WHERE snapshot_pinned),
       (SELECT pg_catalog.count(*) FROM classified WHERE trust_pinned),
       (SELECT pg_catalog.count(*) FROM classified WHERE NOT snapshot_pinned AND NOT trust_pinned),
       (SELECT COALESCE(pg_catalog.sum(classified.bytes), 0) FROM classified
         WHERE NOT snapshot_pinned AND NOT trust_pinned),
       (SELECT pg_catalog.max(page.id) FROM page);")"
[[ "$pointer_page_plan" == *"Index Scan using raw_objects_pkey on raw_objects"* ]] \
  || { echo "pointer page EXPLAIN: expected a primary-key walk" >&2; echo "$pointer_page_plan" >&2; exit 1; }

orphan_page_plan="$(explain "
EXPLAIN
WITH page AS MATERIALIZED (
  SELECT object_row.name,
         object_row.created_at,
         CASE WHEN object_row.metadata->>'size' ~ '^[0-9]{1,18}\$'
              THEN (object_row.metadata->>'size')::bigint END AS bytes
    FROM storage.objects AS object_row
   WHERE object_row.bucket_id = 'raw-snapshots'
     AND object_row.name > ''  -- example cursor: arena.raw_retention_settings.orphan_scan_after
   ORDER BY object_row.name
   LIMIT 5000
),
orphan AS MATERIALIZED (
  SELECT page.name, page.created_at, page.bytes
    FROM page
   WHERE page.created_at < now() - interval '30 days'
     AND NOT EXISTS (
       SELECT 1 FROM arena.raw_objects AS raw WHERE raw.storage_path = page.name
     )
     AND NOT EXISTS (
       SELECT 1 FROM arena.raw_object_gc_queue AS gc WHERE gc.storage_path = page.name
     )
)
SELECT (SELECT pg_catalog.count(*) FROM page),
       (SELECT COALESCE(pg_catalog.sum(page.bytes), 0) FROM page),
       (SELECT pg_catalog.count(*) FROM orphan),
       (SELECT COALESCE(pg_catalog.sum(orphan.bytes), 0) FROM orphan),
       (SELECT pg_catalog.max(page.name) FROM page);")"
[[ "$orphan_page_plan" == *"on objects"* ]] \
  || { echo "orphan page EXPLAIN: expected a plan over storage.objects" >&2; exit 1; }
assert_equal "EXPLAIN executed nothing: cursor still reset after the finished pass" "0|" "$(psql_db -Atqc "
  SELECT concat_ws('|', pointer_scan_after, orphan_scan_after) FROM arena.raw_retention_settings")"

echo "RAW retention backlog census PostgreSQL 17 proof passed"
