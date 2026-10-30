#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261013094743: the dead v2 partition cron job is
# unscheduled (and absence of pg_cron is tolerated), and leaderboard_entries /
# trader_series get monthly partitions through at least 2027-03, idempotently.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CONVERGENCE="$ROOT_DIR/supabase/migrations/20260718135000_partition_child_rls_convergence.sql"
MIGRATION="$ROOT_DIR/supabase/migrations/20261013094743_retire_v2_partition_cron_extend_arena_partitions.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/retire-v2-partition-cron-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((58000 + ($$ % 7000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -80 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_db() {
  local db="$1"
  shift
  "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d "$db" "$@"
}

"$PG_BIN/initdb" -D "$DATA_DIR" --auth-local=trust --auth-host=trust \
  --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null

# Canonical partition function, extracted verbatim from its latest migration.
FUNCTION_SQL="$TMP_ROOT/ensure_month_partitions.sql"
awk '/^CREATE OR REPLACE FUNCTION arena.ensure_month_partitions\(/{p=1} p{print} p&&/^\$function\$;$/{exit}' \
  "$CONVERGENCE" >"$FUNCTION_SQL"

psql_db postgres <<'SQL'
CREATE ROLE postgres SUPERUSER NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role BYPASSRLS NOLOGIN;
CREATE DATABASE with_cron;
CREATE DATABASE without_cron;
SQL

for db in with_cron without_cron; do
  psql_db "$db" <<'SQL'
SET ROLE postgres;
CREATE SCHEMA arena;
CREATE TABLE arena.leaderboard_entries (scraped_at timestamptz NOT NULL)
  PARTITION BY RANGE (scraped_at);
CREATE TABLE arena.trader_series (ts timestamptz NOT NULL)
  PARTITION BY RANGE (ts);
SQL
  psql_db "$db" -f "$FUNCTION_SQL"
done

# Minimal pg_cron stand-in: a job table and unschedule(jobid).
psql_db with_cron <<'SQL'
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text, command text);
CREATE FUNCTION cron.unschedule(job_id bigint) RETURNS boolean
LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobid = job_id RETURNING true $$;
INSERT INTO cron.job (jobname, command) VALUES
  ('auto-create-v2-partitions', 'SELECT ensure_future_partitions(3)'),
  ('unrelated-job', 'SELECT 1');
SQL

for db in with_cron without_cron; do
  # Applying twice proves idempotency.
  psql_db "$db" -f "$MIGRATION"
  psql_db "$db" -f "$MIGRATION"
done

assert_eq() {
  if [[ "$1" != "$2" ]]; then
    echo "assertion failed: $3 (expected '$2', got '$1')" >&2
    exit 1
  fi
}

assert_eq "$(psql_db with_cron -At -c "SELECT string_agg(jobname, ',' ORDER BY jobname) FROM cron.job")" \
  "unrelated-job" "dead v2 cron job unscheduled, others untouched"

for db in with_cron without_cron; do
  for table in leaderboard_entries trader_series; do
    assert_eq "$(psql_db "$db" -At -c "SELECT to_regclass('arena.${table}_y2027m03') IS NOT NULL")" \
      "t" "$db: arena.${table}_y2027m03 exists"
    assert_eq "$(psql_db "$db" -At -c "
      SELECT count(*) = count(DISTINCT child.relname)
      FROM pg_inherits i JOIN pg_class child ON child.oid = i.inhrelid
      WHERE i.inhparent = 'arena.${table}'::regclass")" \
      "t" "$db: no duplicate ${table} partitions"
  done
done

echo "retire-v2-partition-cron-extend-arena-partitions pg17: OK"
