#!/usr/bin/env bash

# PostgreSQL 17 proof that acquisition finish and trusted publication share one
# source/window transaction lock. This exercises real concurrent sessions; a
# static function-body assertion is not sufficient for the publication race.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LEDGER_MIGRATION="$ROOT_DIR/supabase/migrations/20260722030000_durable_leaderboard_acquisition_attempt_ledger.sql"
COMPAT_MIGRATION="$ROOT_DIR/supabase/migrations/20260722040000_leaderboard_acquisition_manifest_v3_compat.sql"
FENCE_MIGRATION="$ROOT_DIR/supabase/migrations/20260722042000_leaderboard_terminal_publication_fence.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/leaderboard-terminal-publication-fence-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((59000 + ($$ % 5000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  local child
  for child in $(jobs -pr); do
    kill "$child" >/dev/null 2>&1 || true
  done
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -180 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

lock_is_held() {
  [[ "$(psql_cmd -qAt -c \
    "SELECT NOT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended('arena.leaderboard-acquisition-source:1:30', 0))")" == 't' ]]
}

wait_for_lock_holder() {
  local attempt
  for attempt in $(seq 1 100); do
    if lock_is_held; then
      return 0
    fi
    sleep 0.05
  done
  echo "publisher never acquired the source/window advisory lock" >&2
  return 1
}

wait_for_advisory_waiters() {
  local expected="$1"
  local attempt
  local observed
  for attempt in $(seq 1 100); do
    observed="$(psql_cmd -qAt -c "
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_stat_activity
      WHERE application_name LIKE 'terminal-finish-waiter-%'
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
    ")"
    if [[ "$observed" -eq "$expected" ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "finish did not wait on the publisher advisory lock (wanted $expected, saw ${observed:-0})" >&2
  psql_cmd -q -x -c "
    SELECT application_name, state, wait_event_type, wait_event, query
    FROM pg_catalog.pg_stat_activity
    WHERE application_name LIKE 'terminal-finish%'
  " >&2 || true
  for output in "$TMP_ROOT"/finish-*.out; do
    [[ -e "$output" ]] && cat "$output" >&2
  done
  return 1
}

wait_for_named_advisory_waiter() {
  local application_name="$1"
  local failure_message="$2"
  local attempt
  for attempt in $(seq 1 100); do
    if [[ "$(psql_cmd -qAt -c "
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_stat_activity
      WHERE application_name = '$application_name'
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
    ")" == '1' ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "$failure_message" >&2
  return 1
}

wait_for_file() {
  local file="$1"
  local failure_message="$2"
  local attempt
  for attempt in $(seq 1 100); do
    [[ -f "$file" ]] && return 0
    sleep 0.05
  done
  echo "$failure_message" >&2
  return 1
}

start_attempt() {
  local attempt_id="$1"
  local queue_attempt="$2"
  psql_cmd -qAt -c "
    SELECT attempt_seq
    FROM arena.start_leaderboard_acquisition_attempt(
      '$attempt_id',
      1,
      30,
      'terminal-fence-cycle',
      'terminal-fence-job',
      $queue_attempt,
      'arena.ingest.leaderboard-acquisition-manifest@3',
      repeat('1', 40),
      'vps_sg'
    )
  "
}

finish_attempt() {
  local attempt_id="$1"
  local application_name="$2"
  local output_file="$3"
  PGAPPNAME="$application_name" psql_cmd -qAt -c "
    SELECT terminal_state
    FROM arena.finish_leaderboard_acquisition_attempt(
      '$attempt_id',
      'processing_failed',
      'unknown',
      'unknown',
      'unassessed',
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      false,
      false,
      'upstream_fetch',
      'unknown_failure'
    )
  " >"$output_file" 2>&1
}

finish_attempt_until_release() {
  local attempt_id="$1"
  local application_name="$2"
  local ready_file="$3"
  local release_file="$4"
  local output_file="$5"
  PGAPPNAME="$application_name" psql_cmd -qAt >"$output_file" 2>&1 <<SQL
BEGIN;
SELECT terminal_state
FROM arena.finish_leaderboard_acquisition_attempt(
  '$attempt_id',
  'processing_failed',
  'unknown',
  'unknown',
  'unassessed',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  false,
  false,
  'upstream_fetch',
  'unknown_failure'
);
\! touch '$ready_file'
\! while [ ! -f '$release_file' ]; do sleep 0.05; done
COMMIT;
SQL
}

hold_publication_lock_until() {
  local release_file="$1"
  local output_file="$2"
  PGAPPNAME='trusted-publication-lock-holder' psql_cmd -qAt >"$output_file" 2>&1 <<SQL
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'arena.leaderboard-acquisition-source:1:30',
    0
  )
);
\! while [ ! -f '$release_file' ]; do sleep 0.05; done
COMMIT;
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

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE leaked_default_role NOLOGIN;
CREATE SCHEMA arena;
GRANT USAGE ON SCHEMA arena TO anon, authenticated, service_role;

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  adapter_slug text NOT NULL,
  timeframes_native integer[] NOT NULL DEFAULT '{}',
  status text NOT NULL,
  serving_mode text NOT NULL,
  currency text NOT NULL,
  fetch_region text NOT NULL
);

CREATE TABLE arena.raw_objects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  job_type text NOT NULL,
  trader_id bigint,
  timeframe smallint,
  fetched_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  storage_path text NOT NULL UNIQUE,
  bytes integer NOT NULL,
  content_hash text NOT NULL,
  quarantined boolean NOT NULL DEFAULT false,
  meta jsonb NOT NULL DEFAULT '{}',
  source_run_id text,
  trust_artifact_role text
);

INSERT INTO arena.sources (
  id,
  slug,
  adapter_slug,
  timeframes_native,
  status,
  serving_mode,
  currency,
  fetch_region
) VALUES (
  1,
  'binance_futures',
  'binance',
  '{30}',
  'active',
  'serving',
  'USDT',
  'vps_sg'
);
SQL

psql_cmd -q -f "$LEDGER_MIGRATION"
psql_cmd -q -f "$COMPAT_MIGRATION"

# Prove the new function removes arbitrary inherited default EXECUTE, not just
# the known API-role grants.
psql_cmd -q -c 'ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO leaked_default_role'
psql_cmd -q -f "$FENCE_MIGRATION"

psql_cmd -q <<'SQL'
DO $catalog_contract$
DECLARE
  v_serializer regprocedure := pg_catalog.to_regprocedure(
    'arena.serialize_leaderboard_terminal_publication()'
  );
  v_trigger_names text[];
BEGIN
  SELECT pg_catalog.array_agg(trigger_row.tgname ORDER BY trigger_row.tgname)
    INTO STRICT v_trigger_names
    FROM pg_catalog.pg_trigger AS trigger_row
   WHERE trigger_row.tgrelid =
         'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
     AND NOT trigger_row.tgisinternal
     AND (trigger_row.tgtype & 7) = 7;

  IF v_trigger_names IS DISTINCT FROM ARRAY[
       'leaderboard_acquisition_outcomes_reject_direct_row_mutation',
       'leaderboard_acquisition_outcomes_serialize_terminal_publication'
     ]::text[]
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid = v_serializer
          AND function_row.proowner = pg_catalog.to_regrole('postgres')
          AND function_row.prosecdef
          AND function_row.proconfig @> ARRAY[
                'search_path=pg_catalog, pg_temp'
              ]::text[]
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       v_serializer,
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'leaked_default_role',
       v_serializer,
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'terminal publication fence catalog contract drifted';
  END IF;
END
$catalog_contract$;
SQL

# 1. A publisher that already owns the key orders before finish. Unauthorized
# direct INSERT still reaches the alphabetically earlier reject trigger without
# waiting on attacker-selected NEW values.
start_attempt '00000000-0000-0000-0000-000000000101' 0 >/dev/null
hold_publication_lock_until \
  "$TMP_ROOT/release-publisher-first" \
  "$TMP_ROOT/publisher-first.out" &
publisher_pid=$!
wait_for_lock_holder

if psql_cmd -q -c "
  SET statement_timeout = '750ms';
  INSERT INTO arena.leaderboard_acquisition_outcomes (attempt_seq)
  SELECT attempt_seq
  FROM arena.leaderboard_acquisition_attempts
  WHERE attempt_id = '00000000-0000-0000-0000-000000000101'
" >"$ERROR_FILE" 2>&1; then
  echo 'unauthorized direct outcome insert unexpectedly succeeded' >&2
  exit 1
fi
if [[ "$(<"$ERROR_FILE")" != *'append-only and RPC-owned'* ]]; then
  echo 'direct outcome insert did not reach the reject-direct trigger first' >&2
  cat "$ERROR_FILE" >&2
  exit 1
fi

finish_attempt \
  '00000000-0000-0000-0000-000000000101' \
  'terminal-finish-waiter-101' \
  "$TMP_ROOT/finish-101.out" &
finish_pid=$!
wait_for_advisory_waiters 1

if [[ "$(psql_cmd -qAt -c "
  SELECT pg_catalog.count(*)
  FROM arena.leaderboard_acquisition_outcomes AS outcome
  JOIN arena.leaderboard_acquisition_attempts AS attempt
    ON attempt.attempt_seq = outcome.attempt_seq
  WHERE attempt.attempt_id = '00000000-0000-0000-0000-000000000101'
")" != '0' ]]; then
  echo 'waiting finish became visible before the publisher committed' >&2
  exit 1
fi

touch "$TMP_ROOT/release-publisher-first"
wait "$publisher_pid"
if ! wait "$finish_pid"; then
  echo 'finish failed after the publisher released its advisory lock' >&2
  cat "$TMP_ROOT/finish-101.out" >&2
  exit 1
fi
if [[ "$(<"$TMP_ROOT/finish-101.out")" != 'processing_failed' ]]; then
  echo 'waiting finish returned the wrong terminal state' >&2
  cat "$TMP_ROOT/finish-101.out" >&2
  exit 1
fi

# 2. If finish owns the key first, publisher waits until that transaction
# commits, then must observe the new terminal before making a decision.
start_attempt '00000000-0000-0000-0000-000000000102' 1 >/dev/null
finish_attempt_until_release \
  '00000000-0000-0000-0000-000000000102' \
  'terminal-finish-commits-first' \
  "$TMP_ROOT/finish-102-ready" \
  "$TMP_ROOT/release-finish-102" \
  "$TMP_ROOT/finish-102.out" &
finish_first_pid=$!
wait_for_file \
  "$TMP_ROOT/finish-102-ready" \
  'finish-first transaction never inserted its terminal'

PGAPPNAME='trusted-publication-after-finish' psql_cmd -qAt \
  >"$TMP_ROOT/publisher-after-finish.out" <<'SQL' &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'arena.leaderboard-acquisition-source:1:30',
    0
  )
);
SELECT attempt_id::text || '|' || terminal_state
FROM arena.latest_terminal_leaderboard_acquisitions
WHERE source_id = 1 AND timeframe = 30;
COMMIT;
SQL
publisher_after_finish_pid=$!

wait_for_named_advisory_waiter \
  'trusted-publication-after-finish' \
  'publisher did not wait behind the uncommitted terminal'
touch "$TMP_ROOT/release-finish-102"
if ! wait "$finish_first_pid"; then
  echo 'finish-first transaction failed to commit' >&2
  cat "$TMP_ROOT/finish-102.out" >&2
  exit 1
fi
if ! wait "$publisher_after_finish_pid"; then
  echo 'publisher failed after the finish-first transaction committed' >&2
  cat "$TMP_ROOT/publisher-after-finish.out" >&2
  exit 1
fi

if [[ "$(tr -d '\n' <"$TMP_ROOT/publisher-after-finish.out")" != \
      '00000000-0000-0000-0000-000000000102|processing_failed' ]]; then
  echo 'publisher did not observe the already-committed terminal' >&2
  cat "$TMP_ROOT/publisher-after-finish.out" >&2
  exit 1
fi

# 3. Several distinct in-progress attempts may all reach finish while the
# publisher owns the shared key. They wait on one advisory lock, then drain
# without lock inversion or a 40P01 deadlock.
attempt_ids=(
  '00000000-0000-0000-0000-000000000103'
  '00000000-0000-0000-0000-000000000104'
  '00000000-0000-0000-0000-000000000105'
)
queue_attempt=2
for attempt_id in "${attempt_ids[@]}"; do
  start_attempt "$attempt_id" "$queue_attempt" >/dev/null
  queue_attempt=$((queue_attempt + 1))
done

hold_publication_lock_until \
  "$TMP_ROOT/release-publisher-fanout" \
  "$TMP_ROOT/publisher-fanout.out" &
fanout_publisher_pid=$!
wait_for_lock_holder

finish_pids=()
index=0
for attempt_id in "${attempt_ids[@]}"; do
  finish_attempt \
    "$attempt_id" \
    "terminal-finish-waiter-fanout-$index" \
    "$TMP_ROOT/finish-fanout-$index.out" &
  finish_pids+=("$!")
  index=$((index + 1))
done

wait_for_advisory_waiters 3
touch "$TMP_ROOT/release-publisher-fanout"
wait "$fanout_publisher_pid"

finish_failed=0
for finish_pid in "${finish_pids[@]}"; do
  if ! wait "$finish_pid"; then
    finish_failed=1
  fi
done

if ((finish_failed != 0)); then
  echo 'concurrent in-progress finishes deadlocked or failed' >&2
  for output in "$TMP_ROOT"/finish-fanout-*.out; do
    cat "$output" >&2
  done
  exit 1
fi

if [[ "$(psql_cmd -qAt -c "
  SELECT pg_catalog.count(*)
  FROM arena.leaderboard_acquisition_outcomes AS outcome
  JOIN arena.leaderboard_acquisition_attempts AS attempt
    ON attempt.attempt_seq = outcome.attempt_seq
  WHERE attempt.attempt_id = ANY (ARRAY[
    '00000000-0000-0000-0000-000000000103'::uuid,
    '00000000-0000-0000-0000-000000000104'::uuid,
    '00000000-0000-0000-0000-000000000105'::uuid
  ])
")" != '3' ]]; then
  echo 'concurrent in-progress finishes did not all commit' >&2
  exit 1
fi

if rg -n 'deadlock detected|40P01' "$LOG_FILE" >/dev/null 2>&1; then
  echo 'concurrent in-progress finishes deadlocked or failed' >&2
  rg -n 'deadlock detected|40P01' "$LOG_FILE" >&2
  exit 1
fi

echo 'leaderboard terminal publication fence PostgreSQL 17 proof passed'
