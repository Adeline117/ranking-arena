#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260721130000_raw_object_gc_outbox.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/raw-object-gc-outbox-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((58000 + ($$ % 7000)))}"
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
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

expect_failure() {
  local label="$1"
  local sql="$2"
  if psql_cmd -q -c "$sql" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
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

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA arena;

GRANT USAGE ON SCHEMA arena TO service_role, anon, authenticated;

CREATE TABLE arena.raw_objects (
  id bigint PRIMARY KEY,
  fetched_at timestamptz NOT NULL,
  storage_path text NOT NULL UNIQUE,
  content_hash text NOT NULL,
  quarantined boolean NOT NULL DEFAULT false,
  source_run_id text,
  trust_artifact_role text
);

-- A small executable stand-in proves DB-first RAW deletion cascades ranking
-- evidence before the external Storage obligation is attempted.
CREATE TABLE arena.rank_evidence_probe (
  raw_object_id bigint PRIMARY KEY
    REFERENCES arena.raw_objects(id) ON DELETE CASCADE
);
SQL

psql_cmd -q -f "$MIGRATION"

# The runtime holds this session-level lock from queue selection through the
# external Storage acknowledgement. Prove a second maintenance session fails
# fast instead of processing and acknowledging the same outbox batch.
LOCK_READY="$TMP_ROOT/gc-lock-ready"
(
  psql_cmd -q <<SQL
SELECT pg_catalog.pg_advisory_lock(
  pg_catalog.hashtextextended('arena.raw_object_gc_queue', 0)
);
\! touch "$LOCK_READY"
SELECT pg_catalog.pg_sleep(1);
SELECT pg_catalog.pg_advisory_unlock(
  pg_catalog.hashtextextended('arena.raw_object_gc_queue', 0)
);
SQL
) &
LOCK_HOLDER_PID=$!

for _ in $(seq 1 100); do
  [[ -f "$LOCK_READY" ]] && break
  sleep 0.02
done
if [[ ! -f "$LOCK_READY" ]]; then
  echo "timed out waiting for the first RAW GC advisory lock holder" >&2
  exit 1
fi

CONTENDED_LOCK="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.pg_try_advisory_lock(
      pg_catalog.hashtextextended('arena.raw_object_gc_queue', 0)
    );
  "
)"
if [[ "$CONTENDED_LOCK" != "f" ]]; then
  echo "a second maintenance session acquired the active RAW GC lock" >&2
  exit 1
fi
wait "$LOCK_HOLDER_PID"

psql_cmd -q <<'SQL'
INSERT INTO arena.raw_objects (
  id, fetched_at, storage_path, content_hash, quarantined,
  source_run_id, trust_artifact_role
) VALUES
  (
    1, statement_timestamp() - interval '90 days',
    'binance/tier_a/oldest.json.gz', repeat('a', 64), false,
    repeat('1', 64), 'source_payload'
  ),
  (
    2, statement_timestamp() - interval '80 days',
    'binance/tier_a/second.json.gz', repeat('b', 32), false,
    NULL, NULL
  ),
  (
    3, statement_timestamp() - interval '70 days',
    'binance/tier_a/third.json.gz', repeat('c', 64), false,
    NULL, NULL
  ),
  (
    4, statement_timestamp() - interval '100 days',
    'binance/tier_a/quarantined.json.gz', repeat('d', 64), true,
    NULL, NULL
  ),
  (
    5, statement_timestamp() - interval '1 day',
    'binance/tier_a/recent.json.gz', repeat('e', 64), false,
    NULL, NULL
  );

INSERT INTO arena.rank_evidence_probe (raw_object_id) VALUES (1);
SQL

# This is the worker's atomic DB-first handoff: only rows actually inserted in
# the durable queue are deleted from RAW. Stable ordering makes the oldest two
# deterministic, and SKIP LOCKED permits multiple maintenance nodes.
DETACHED="$(
  psql_cmd -Atqc "
    WITH candidates AS MATERIALIZED (
      SELECT raw.id, raw.storage_path, raw.content_hash
        FROM arena.raw_objects AS raw
       WHERE NOT raw.quarantined
         AND raw.fetched_at < pg_catalog.statement_timestamp() - interval '30 days'
       ORDER BY raw.fetched_at, raw.id
       FOR UPDATE SKIP LOCKED
       LIMIT 2
    ), queued AS (
      INSERT INTO arena.raw_object_gc_queue (
        raw_object_id, storage_path, content_hash
      )
      SELECT id, storage_path, content_hash
        FROM candidates
      ON CONFLICT (storage_path) DO NOTHING
      RETURNING raw_object_id
    ), detached AS (
      DELETE FROM arena.raw_objects AS raw
      USING queued
      WHERE raw.id = queued.raw_object_id
      RETURNING raw.id
    )
    SELECT count(*) || '|' || string_agg(id::text, ',' ORDER BY id)
      FROM detached;
  "
)"
if [[ "$DETACHED" != "2|1,2" ]]; then
  echo "atomic RAW detach selected the wrong rows: $DETACHED" >&2
  exit 1
fi

AFTER_DETACH="$(
  psql_cmd -Atqc "
    SELECT
      (SELECT count(*) FROM arena.raw_object_gc_queue) || '|' ||
      (SELECT string_agg(id::text, ',' ORDER BY id) FROM arena.raw_objects) || '|' ||
      (SELECT count(*) FROM arena.rank_evidence_probe);
  "
)"
if [[ "$AFTER_DETACH" != "2|3,4,5|0" ]]; then
  echo "DB-first detach did not preserve its durable/cascade contract: $AFTER_DETACH" >&2
  exit 1
fi

# Any failure in the enqueue+delete transaction restores both sides. There is
# never a committed RAW deletion without its durable Storage obligation.
psql_cmd -q -c "
  INSERT INTO arena.raw_objects (
    id, fetched_at, storage_path, content_hash, quarantined
  ) VALUES (
    6, statement_timestamp() - interval '60 days',
    'binance/tier_a/rollback.json.gz', repeat('f', 64), false
  );
"
expect_failure \
  "failed handoff transaction" \
  "BEGIN;
   WITH queued AS (
     INSERT INTO arena.raw_object_gc_queue (
       raw_object_id, storage_path, content_hash
     )
     SELECT id, storage_path, content_hash
       FROM arena.raw_objects
      WHERE id = 6
     RETURNING raw_object_id
   )
   DELETE FROM arena.raw_objects AS raw
   USING queued
   WHERE raw.id = queued.raw_object_id;
   SELECT 1 / 0;
   COMMIT;"

ROLLED_BACK="$(
  psql_cmd -Atqc "
    SELECT
      (SELECT count(*) FROM arena.raw_objects WHERE id = 6) || '|' ||
      (SELECT count(*) FROM arena.raw_object_gc_queue WHERE raw_object_id = 6);
  "
)"
if [[ "$ROLLED_BACK" != "1|0" ]]; then
  echo "failed handoff did not roll back atomically: $ROLLED_BACK" >&2
  exit 1
fi

# A failed Storage call retains the obligation and increments durable failure
# metadata exactly once. A successful retry is acknowledged by DELETE.
psql_cmd -q -c "
  UPDATE arena.raw_object_gc_queue
     SET attempts = attempts + 1,
         last_attempt_at = pg_catalog.statement_timestamp(),
         last_error = 'Storage timeout'
   WHERE raw_object_id = 1;
"

FAILED_STATE="$(
  psql_cmd -Atqc "
    SELECT attempts || '|' || (last_attempt_at IS NOT NULL)::text || '|' || last_error
      FROM arena.raw_object_gc_queue
     WHERE raw_object_id = 1;
  "
)"
if [[ "$FAILED_STATE" != "1|true|Storage timeout" ]]; then
  echo "Storage failure metadata was not durable: $FAILED_STATE" >&2
  exit 1
fi

expect_failure \
  "skipped failure attempt" \
  "UPDATE arena.raw_object_gc_queue
      SET attempts = attempts + 2,
          last_attempt_at = statement_timestamp(),
          last_error = 'bad increment'
    WHERE raw_object_id = 1;"

expect_failure \
  "mutable queued path" \
  "UPDATE arena.raw_object_gc_queue
      SET storage_path = 'forged/path.json.gz',
          attempts = attempts + 1,
          last_attempt_at = statement_timestamp(),
          last_error = 'forged'
    WHERE raw_object_id = 1;"

expect_failure \
  "malformed initial attempt" \
  "INSERT INTO arena.raw_object_gc_queue (
     raw_object_id, storage_path, content_hash, attempts
   ) VALUES (
     90, 'bad/attempt.json.gz', repeat('9', 64), 1
   );"

# BYPASSRLS does not imply broad table mutation: service_role receives only the
# worker's enqueue/failure/ack columns. Public roles cannot observe the queue.
SERVICE_READ="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT count(*) FROM arena.raw_object_gc_queue;
    RESET ROLE;
  "
)"
if [[ "$SERVICE_READ" != "2" ]]; then
  echo "service_role could not read private GC work: $SERVICE_READ" >&2
  exit 1
fi

psql_cmd -q -c "
  SET ROLE service_role;
  UPDATE arena.raw_object_gc_queue
     SET attempts = attempts + 1,
         last_attempt_at = pg_catalog.statement_timestamp(),
         last_error = 'Storage unavailable'
   WHERE raw_object_id = 2;
  RESET ROLE;
"

expect_failure \
  "service role mutating queue identity" \
  "SET ROLE service_role;
   UPDATE arena.raw_object_gc_queue
      SET content_hash = repeat('0', 64)
    WHERE raw_object_id = 2;"

expect_failure \
  "anonymous queue read" \
  "SET ROLE anon; SELECT count(*) FROM arena.raw_object_gc_queue;"

INDEX_AND_FK="$(
  psql_cmd -Atqc "
    SELECT
      (SELECT count(*)
         FROM pg_catalog.pg_indexes
        WHERE schemaname = 'arena'
          AND tablename = 'raw_object_gc_queue'
          AND indexname = 'idx_arena_raw_object_gc_queue_retry'
          AND indexdef LIKE '%COALESCE(last_attempt_at, enqueued_at)%'
          AND indexdef LIKE '%enqueued_at, storage_path%') || '|' ||
      (SELECT count(*)
         FROM pg_catalog.pg_constraint
        WHERE conrelid = 'arena.raw_object_gc_queue'::regclass
          AND contype = 'f');
  "
)"
if [[ "$INDEX_AND_FK" != "1|0" ]]; then
  echo "stable retry index or detached no-FK contract drifted: $INDEX_AND_FK" >&2
  exit 1
fi

psql_cmd -q -c "
  SET ROLE service_role;
  DELETE FROM arena.raw_object_gc_queue WHERE raw_object_id IN (1, 2);
  RESET ROLE;
"

if [[ "$(psql_cmd -Atqc 'SELECT count(*) FROM arena.raw_object_gc_queue;')" != "0" ]]; then
  echo "successful Storage acknowledgement did not clear GC work" >&2
  exit 1
fi

echo "RAW object GC outbox PostgreSQL 17 proof passed"
