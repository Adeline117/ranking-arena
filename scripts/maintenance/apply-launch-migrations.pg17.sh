#!/usr/bin/env bash

# Real PostgreSQL 17 transaction/locking harness for the dormant ordered
# single-predeploy candidate. This sources the production emitter, but replaces
# only its repository paths and database adapter inside this disposable cluster.
# It does not expose or exercise a production-approval bypass.

set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="$REPO_ROOT/scripts/maintenance/apply-launch-migrations.sh"
FIXTURE_DIR="$REPO_ROOT/scripts/maintenance/__fixtures__"
PG17_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
INITDB="$PG17_BIN/initdb"
PG_CTL="$PG17_BIN/pg_ctl"
PSQL="$PG17_BIN/psql"
PREFIX='20990101000000_runner_prefix.sql'
TARGET='20990101000001_runner_target.sql'
PREFIX_VERSION="${PREFIX%%_*}"
TARGET_VERSION="${TARGET%%_*}"
MUTATOR_VERSION='20990101000002'
LOCK_KEY='arena:production-schema-migration'

for executable in "$INITDB" "$PG_CTL" "$PSQL"; do
  if [[ ! -x "$executable" ]]; then
    echo "PostgreSQL 17 executable is missing: $executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/arena-runner-pg17.XXXXXX")"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
SERVER_LOG="$TMP_ROOT/postgres.log"
PORT=$((40000 + ($$ % 20000)))
mkdir -p "$SOCKET_DIR"

cleanup() {
  local status=$?
  local pid
  trap - EXIT INT TERM
  for pid in ${BACKGROUND_PIDS:-}; do
    kill -TERM "$pid" >/dev/null 2>&1 || true
  done
  if [[ -d "$DATA_DIR" ]]; then
    "$PG_CTL" -D "$DATA_DIR" -m immediate stop >/dev/null 2>&1 || true
  fi
  if ((status != 0)) && [[ -f "$SERVER_LOG" ]]; then
    echo '--- PostgreSQL 17 server log tail ---' >&2
    tail -80 "$SERVER_LOG" >&2
  fi
  rm -rf "$TMP_ROOT"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  echo "PG17 HARNESS FAIL: $*" >&2
  exit 1
}

assert_equal() {
  local expected="$1"
  local actual="$2"
  local context="$3"
  if [[ "$actual" != "$expected" ]]; then
    fail "$context (expected '$expected', got '$actual')"
  fi
}

assert_file_contains() {
  local file="$1"
  local needle="$2"
  local context="$3"
  if ! grep -F -q -- "$needle" "$file"; then
    echo "--- $context output ---" >&2
    sed -n '1,160p' "$file" >&2
    fail "$context did not contain: $needle"
  fi
}

"$INITDB" -D "$DATA_DIR" -U postgres --auth=trust --no-locale \
  --encoding=UTF8 >/dev/null
"$PG_CTL" -D "$DATA_DIR" -l "$SERVER_LOG" \
  -o "-F -k $SOCKET_DIR -p $PORT -c listen_addresses=''" \
  -w start >/dev/null

psql_base() {
  "$PSQL" -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres \
    -X -q -v ON_ERROR_STOP=1 "$@"
}

psql_query() {
  psql_base -Atc "$1"
}

psql_file() {
  psql_base -f "$1"
}

psql_base <<'SQL'
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (
  version text PRIMARY KEY,
  statements text[] NOT NULL,
  name text NOT NULL,
  created_by text NOT NULL,
  idempotency_key text NOT NULL
);
CREATE SCHEMA runner_harness;
CREATE TABLE runner_harness.effects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scenario text NOT NULL
);
SQL

# shellcheck source=apply-launch-migrations.sh
source "$RUNNER"

# Harness-only dependencies. Production entry points and governance checks are
# never called or weakened here; only the SQL emitter and target-order checker
# run against disposable fixture migrations.
ROOT="$REPO_ROOT"
MIGRATIONS_DIR="$FIXTURE_DIR"
PREDEPLOY_MIGRATIONS=("$PREFIX" "$TARGET")
POSTDEPLOY_MIGRATIONS=()
RECOVERY_PREREQUISITE_MIGRATIONS=()
CONCURRENT_RECOVERY_MIGRATIONS=()
RECOVERY_MIGRATIONS=()
SUPERSEDED_MIGRATIONS=()
ORDERED_PREDEPLOY_PREREQUISITES=("$PREFIX")

psql_with_database() {
  psql_base "$@"
}

require_release_provenance() {
  : # The target-order unit below uses fixtures that intentionally are not git migrations.
}

emit_ordered_sql() {
  local terminal="$1"
  local destination="$2"
  ORDERED_PREDEPLOY_PREREQUISITES=("$PREFIX")
  emit_ordered_predeploy_transaction "$terminal" "$TARGET" >"$destination"
}

ensure_exact_prefix() {
  psql_query \
    "DELETE FROM supabase_migrations.schema_migrations WHERE version IN ('$PREFIX_VERSION', '$TARGET_VERSION');" \
    >/dev/null
  {
    printf '%s\n' 'BEGIN;'
    emit_ledger_insert "$PREFIX"
    printf '%s\n' 'COMMIT;'
  } | psql_base
}

reset_case() {
  psql_query \
    "TRUNCATE runner_harness.effects; DELETE FROM supabase_migrations.schema_migrations WHERE version IN ('$MUTATOR_VERSION', '$TARGET_VERSION');" \
    >/dev/null
  ensure_exact_prefix
}

wait_for_query() {
  local expected="$1"
  local query="$2"
  local context="$3"
  local actual=''
  local attempt
  for attempt in {1..100}; do
    actual="$(psql_query "$query")"
    if [[ "$actual" == "$expected" ]]; then
      return
    fi
    sleep 0.05
  done
  fail "$context (last result '$actual')"
}

try_and_release_global_lock() {
  psql_query \
    "WITH acquired AS (
       SELECT pg_catalog.pg_try_advisory_lock(
         pg_catalog.hashtextextended('$LOCK_KEY', 0)
       ) AS ok
     )
     SELECT ok || '|' || CASE
       WHEN ok THEN pg_catalog.pg_advisory_unlock(
         pg_catalog.hashtextextended('$LOCK_KEY', 0)
       )
       ELSE false
     END
     FROM acquired;"
}

echo 'PG17: dry-run rolls back migration body and ledger atomically'
reset_case
DRY_SQL="$TMP_ROOT/dry-run.sql"
emit_ordered_sql ROLLBACK "$DRY_SQL"
assert_file_contains "$DRY_SQL" \
  'BEGIN ISOLATION LEVEL REPEATABLE READ;' \
  'repeatable-read transaction starts only after the session lock'
PGAPPNAME='runner-dry-run' \
  PGOPTIONS='-c arena.runner_scenario=dry-run' \
  psql_file "$DRY_SQL" >"$TMP_ROOT/dry-run.log" 2>&1
assert_equal '0|0' \
  "$(psql_query "SELECT (SELECT count(*) FROM runner_harness.effects) || '|' || (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '$TARGET_VERSION');")" \
  'dry-run rollback state'
assert_equal 'true|true' "$(try_and_release_global_lock)" \
  'dry-run conditional unlock and subsequent lock availability'

echo 'PG17: same-target concurrent apply commits once and fails the fixed target once'
reset_case
APPLY_SQL="$TMP_ROOT/apply.sql"
emit_ordered_sql COMMIT "$APPLY_SQL"
(
  export PGAPPNAME='runner-concurrent-first'
  export PGOPTIONS='-c arena.runner_scenario=concurrent-first -c arena.runner_sleep_seconds=2'
  psql_file "$APPLY_SQL"
) >"$TMP_ROOT/concurrent-first.log" 2>&1 &
FIRST_PID=$!
BACKGROUND_PIDS="$FIRST_PID"
wait_for_query '1' \
  "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'runner-concurrent-first' AND wait_event = 'PgSleep';" \
  'first concurrent apply did not reach the migration body'
(
  export PGAPPNAME='runner-concurrent-second'
  export PGOPTIONS='-c arena.runner_scenario=concurrent-second'
  psql_file "$APPLY_SQL"
) >"$TMP_ROOT/concurrent-second.log" 2>&1 &
SECOND_PID=$!
BACKGROUND_PIDS="$FIRST_PID $SECOND_PID"
wait_for_query '1' \
  "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'runner-concurrent-second' AND wait_event = 'advisory';" \
  'second same-target apply did not wait on the pre-BEGIN advisory lock'
set +e
wait "$FIRST_PID"
FIRST_STATUS=$?
wait "$SECOND_PID"
SECOND_STATUS=$?
set -e
BACKGROUND_PIDS=''
assert_equal '0' "$FIRST_STATUS" 'first concurrent apply exit status'
if [[ "$SECOND_STATUS" -eq 0 ]]; then
  fail 'second same-target apply unexpectedly committed'
fi
assert_file_contains "$TMP_ROOT/concurrent-second.log" \
  "migration ledger version already exists: $TARGET_VERSION" \
  'second same-target apply'
assert_equal '1|1|0' \
  "$(psql_query "SELECT (SELECT count(*) FROM runner_harness.effects) || '|' || (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '$TARGET_VERSION') || '|' || (SELECT count(*) FROM runner_harness.effects WHERE scenario = 'concurrent-second');")" \
  'same-target commit cardinality'
assert_equal 'exact' "$(ledger_state "$TARGET")" \
  'same-target winner exact ledger attestation'
assert_equal 'true|true' "$(try_and_release_global_lock)" \
  'concurrent failure disconnect lock release'

echo 'PG17: requested target is rejected before SQL when it is not first missing'
psql_query \
  "TRUNCATE runner_harness.effects; DELETE FROM supabase_migrations.schema_migrations WHERE version IN ('$PREFIX_VERSION', '$TARGET_VERSION');" \
  >/dev/null
set +e
(prepare_ordered_predeploy_target "$TARGET") \
  >"$TMP_ROOT/not-next.out" 2>"$TMP_ROOT/not-next.err"
NOT_NEXT_STATUS=$?
set -e
if [[ "$NOT_NEXT_STATUS" -eq 0 ]]; then
  fail 'target-not-next preflight unexpectedly passed'
fi
assert_file_contains "$TMP_ROOT/not-next.err" \
  "requested $TARGET, first missing $PREFIX" \
  'target-not-next preflight'
assert_equal '0|0' \
  "$(psql_query "SELECT (SELECT count(*) FROM runner_harness.effects) || '|' || (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '$TARGET_VERSION');")" \
  'target-not-next mutation state'

echo 'PG17: ledger/table mutation waits behind the global serialized apply'
reset_case
emit_ordered_sql COMMIT "$APPLY_SQL"
(
  export PGAPPNAME='runner-serialization-apply'
  export PGOPTIONS='-c arena.runner_scenario=serialization -c arena.runner_sleep_seconds=2'
  psql_file "$APPLY_SQL"
) >"$TMP_ROOT/serialization-apply.log" 2>&1 &
APPLY_PID=$!
BACKGROUND_PIDS="$APPLY_PID"
wait_for_query '1' \
  "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'runner-serialization-apply' AND wait_event = 'PgSleep';" \
  'serialized apply did not reach its body'
(
  export PGAPPNAME='runner-ledger-mutator'
  psql_query \
    "SET statement_timeout = '5s'; INSERT INTO supabase_migrations.schema_migrations (version, statements, name, created_by, idempotency_key) VALUES ('$MUTATOR_VERSION', ARRAY['mutation'], 'mutation', 'harness', 'harness:$MUTATOR_VERSION');"
) >"$TMP_ROOT/ledger-mutator.log" 2>&1 &
MUTATOR_PID=$!
(
  export PGAPPNAME='runner-table-mutator'
  psql_query \
    "SET statement_timeout = '5s'; INSERT INTO runner_harness.effects (scenario) VALUES ('table-mutator');"
) >"$TMP_ROOT/table-mutator.log" 2>&1 &
TABLE_MUTATOR_PID=$!
BACKGROUND_PIDS="$APPLY_PID $MUTATOR_PID $TABLE_MUTATOR_PID"
wait_for_query '1' \
  "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'runner-ledger-mutator' AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0;" \
  'ledger mutator was not blocked by the runner table lock'
wait_for_query '1' \
  "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'runner-table-mutator' AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0;" \
  'target-table mutator was not blocked by the migration table lock'
set +e
wait "$APPLY_PID"
APPLY_STATUS=$?
wait "$MUTATOR_PID"
MUTATOR_STATUS=$?
wait "$TABLE_MUTATOR_PID"
TABLE_MUTATOR_STATUS=$?
set -e
BACKGROUND_PIDS=''
assert_equal '0' "$APPLY_STATUS" 'serialized apply exit status'
assert_equal '0' "$MUTATOR_STATUS" 'serialized ledger mutator exit status'
assert_equal '0' "$TABLE_MUTATOR_STATUS" 'serialized target-table mutator exit status'
assert_equal '1|1|1|1' \
  "$(psql_query "SELECT (SELECT count(*) FROM runner_harness.effects WHERE scenario = 'serialization') || '|' || (SELECT count(*) FROM runner_harness.effects WHERE scenario = 'table-mutator') || '|' || (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '$TARGET_VERSION') || '|' || (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '$MUTATOR_VERSION');")" \
  'serialized ledger/table mutation state'

echo 'PG17: session advisory lock wait is bounded and disconnect releases it'
reset_case
emit_ordered_sql COMMIT "$APPLY_SQL"
(
  export PGAPPNAME='runner-global-lock-holder'
  psql_query \
    "SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended('$LOCK_KEY', 0)); SELECT pg_catalog.pg_sleep(30);"
) >"$TMP_ROOT/lock-holder.log" 2>&1 &
HOLDER_PID=$!
BACKGROUND_PIDS="$HOLDER_PID"
wait_for_query '1' \
  "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'runner-global-lock-holder' AND wait_event = 'PgSleep';" \
  'global lock holder did not acquire the advisory lock'
SECONDS=0
set +e
PGAPPNAME='runner-lock-timeout' psql_file "$APPLY_SQL" \
  >"$TMP_ROOT/lock-timeout.log" 2>&1
LOCK_TIMEOUT_STATUS=$?
LOCK_TIMEOUT_SECONDS=$SECONDS
set -e
if [[ "$LOCK_TIMEOUT_STATUS" -eq 0 ]]; then
  fail 'runner unexpectedly waited without a lock timeout'
fi
if ((LOCK_TIMEOUT_SECONDS < 9 || LOCK_TIMEOUT_SECONDS > 14)); then
  fail "global lock timeout was not bounded near 10 seconds ($LOCK_TIMEOUT_SECONDS seconds)"
fi
assert_file_contains "$TMP_ROOT/lock-timeout.log" \
  'canceling statement due to lock timeout' \
  'bounded advisory lock wait'
HOLDER_BACKEND_PID="$(psql_query "SELECT pid FROM pg_stat_activity WHERE application_name = 'runner-global-lock-holder';")"
[[ "$HOLDER_BACKEND_PID" =~ ^[0-9]+$ ]] || \
  fail 'could not identify the global lock holder backend'
psql_query "SELECT pg_terminate_backend($HOLDER_BACKEND_PID);" >/dev/null
set +e
wait "$HOLDER_PID"
set -e
BACKGROUND_PIDS=''
wait_for_query 'true|true' \
  "WITH acquired AS (SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended('$LOCK_KEY', 0)) AS ok) SELECT ok || '|' || CASE WHEN ok THEN pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended('$LOCK_KEY', 0)) ELSE false END FROM acquired;" \
  'disconnect did not release the session advisory lock'
assert_equal '0|0' \
  "$(psql_query "SELECT (SELECT count(*) FROM runner_harness.effects) || '|' || (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '$TARGET_VERSION');")" \
  'lock-timeout mutation state'

echo 'PG17: terminating a runner connection rolls back its body and releases its session lock'
reset_case
emit_ordered_sql COMMIT "$APPLY_SQL"
(
  export PGAPPNAME='runner-disconnect'
  export PGOPTIONS='-c arena.runner_scenario=disconnect -c arena.runner_sleep_seconds=30'
  psql_file "$APPLY_SQL"
) >"$TMP_ROOT/disconnect.log" 2>&1 &
DISCONNECT_PID=$!
BACKGROUND_PIDS="$DISCONNECT_PID"
wait_for_query '1' \
  "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'runner-disconnect' AND wait_event = 'PgSleep';" \
  'disconnect runner did not reach its transactional body'
DISCONNECT_BACKEND_PID="$(psql_query "SELECT pid FROM pg_stat_activity WHERE application_name = 'runner-disconnect';")"
[[ "$DISCONNECT_BACKEND_PID" =~ ^[0-9]+$ ]] || \
  fail 'could not identify the runner backend selected for disconnect'
psql_query "SELECT pg_terminate_backend($DISCONNECT_BACKEND_PID);" >/dev/null
set +e
wait "$DISCONNECT_PID"
DISCONNECT_STATUS=$?
set -e
BACKGROUND_PIDS=''
if [[ "$DISCONNECT_STATUS" -eq 0 ]]; then
  fail 'terminated runner connection unexpectedly committed'
fi
assert_equal '0|0' \
  "$(psql_query "SELECT (SELECT count(*) FROM runner_harness.effects) || '|' || (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '$TARGET_VERSION');")" \
  'terminated runner rollback state'
assert_equal 'true|true' "$(try_and_release_global_lock)" \
  'terminated runner disconnect lock release'

echo 'PG17: a mid-body error rolls back both effects and ledger, then releases on disconnect'
reset_case
emit_ordered_sql COMMIT "$APPLY_SQL"
set +e
PGAPPNAME='runner-mid-body-failure' \
  PGOPTIONS='-c arena.runner_scenario=mid-body-failure -c arena.runner_fail=on' \
  psql_file "$APPLY_SQL" >"$TMP_ROOT/mid-body.log" 2>&1
MID_BODY_STATUS=$?
set -e
if [[ "$MID_BODY_STATUS" -eq 0 ]]; then
  fail 'mid-body fixture unexpectedly committed'
fi
assert_file_contains "$TMP_ROOT/mid-body.log" \
  'runner fixture mid-body failure' \
  'mid-body rollback'
assert_equal '0|0' \
  "$(psql_query "SELECT (SELECT count(*) FROM runner_harness.effects) || '|' || (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '$TARGET_VERSION');")" \
  'mid-body rollback state'
assert_equal 'true|true' "$(try_and_release_global_lock)" \
  'mid-body failure disconnect lock release'

echo 'PG17 HARNESS PASS: rollback, ordering, serialization, timeout, and disconnect invariants hold'
