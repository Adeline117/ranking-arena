#!/usr/bin/env bash

# PostgreSQL 17 proof for old ranked-trader history, concurrent partition
# creation, timestamp bounds, RLS, and exact function ACL convergence.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260718133000_history_partition_range_guard.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/history-partition-guard-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((57000 + ($$ % 8000)))}"
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
CREATE ROLE postgres SUPERUSER NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE legacy_reader NOLOGIN;
CREATE SCHEMA arena;
GRANT USAGE ON SCHEMA arena TO anon, authenticated, service_role, legacy_reader;

CREATE TABLE arena.leaderboard_entries (scraped_at timestamptz NOT NULL)
  PARTITION BY RANGE (scraped_at);
CREATE TABLE arena.trader_series (ts timestamptz NOT NULL)
  PARTITION BY RANGE (ts);
CREATE TABLE arena.position_history (closed_at timestamptz NOT NULL)
  PARTITION BY RANGE (closed_at);
CREATE TABLE arena.order_records (ts timestamptz NOT NULL, payload text)
  PARTITION BY RANGE (ts);
CREATE TABLE arena.transfer_history (ts timestamptz NOT NULL)
  PARTITION BY RANGE (ts);
CREATE TABLE arena.copier_records (ts timestamptz NOT NULL)
  PARTITION BY RANGE (ts);

CREATE FUNCTION arena.ensure_month_partitions(
  parent_table text,
  months_ahead integer DEFAULT 2,
  months_back integer DEFAULT 0
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
AS $$ SELECT 0 $$;
GRANT EXECUTE ON FUNCTION arena.ensure_month_partitions(text, integer, integer)
  TO PUBLIC, legacy_reader;
SQL

if psql_cmd -q -c \
  "INSERT INTO arena.order_records VALUES (now() - interval '18 months', 'old')" \
  >"$TMP_ROOT/pre-migration.log" 2>&1; then
  echo "old history unexpectedly inserted without a partition" >&2
  exit 1
fi
if ! rg -q 'no partition of relation "order_records" found for row' \
  "$TMP_ROOT/pre-migration.log"; then
  echo "pre-migration failure did not reproduce the live partition error" >&2
  cat "$TMP_ROOT/pre-migration.log" >&2
  exit 1
fi

psql_cmd -q -f "$MIGRATION"

ACL_RESULT="$(
  psql_cmd -Atqc "
    SELECT
      has_function_privilege(
        'legacy_reader',
        'arena.ensure_month_partitions(text,integer,integer)',
        'EXECUTE'
      ) || '|' ||
      has_function_privilege(
        'authenticated',
        'arena.ensure_history_partitions(text,timestamp with time zone[])',
        'EXECUTE'
      ) || '|' ||
      has_function_privilege(
        'service_role',
        'arena.ensure_history_partitions(text,timestamp with time zone[])',
        'EXECUTE'
      );
  "
)"
if [[ "$ACL_RESULT" != "false|false|false" ]]; then
  echo "partition function ACL did not converge: $ACL_RESULT" >&2
  exit 1
fi

psql_cmd -q -c "
  SELECT arena.ensure_history_partitions(
    'order_records',
    ARRAY[now() - interval '18 months', now()]::timestamptz[]
  );
  INSERT INTO arena.order_records
  VALUES (now() - interval '18 months', 'ranked-trader-history');
"

TARGET_MONTH="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.to_char(now() - interval '20 months', 'YYYYMM');
  "
)"
(
  psql_cmd -Atqc "
    SELECT arena.ensure_history_partitions(
      'order_records',
      ARRAY[now() - interval '20 months']::timestamptz[]
    );
  " >"$TMP_ROOT/concurrent-a.out"
) &
PID_A=$!
(
  psql_cmd -Atqc "
    SELECT arena.ensure_history_partitions(
      'order_records',
      ARRAY[now() - interval '20 months']::timestamptz[]
    );
  " >"$TMP_ROOT/concurrent-b.out"
) &
PID_B=$!
wait "$PID_A"
wait "$PID_B"

PARTITION_RESULT="$(
  psql_cmd -Atqc "
    SELECT
      pg_catalog.count(*) || '|' ||
      pg_catalog.bool_and(child.relrowsecurity)
    FROM pg_catalog.pg_inherits AS inheritance
    JOIN pg_catalog.pg_class AS parent
      ON parent.oid = inheritance.inhparent
    JOIN pg_catalog.pg_namespace AS parent_schema
      ON parent_schema.oid = parent.relnamespace
    JOIN pg_catalog.pg_class AS child
      ON child.oid = inheritance.inhrelid
    WHERE parent_schema.nspname = 'arena'
      AND parent.relname = 'order_records'
      AND child.relname = 'order_records_y' ||
        pg_catalog.substr('$TARGET_MONTH', 1, 4) ||
        'm' ||
        pg_catalog.substr('$TARGET_MONTH', 5, 2);
  "
)"
if [[ "$PARTITION_RESULT" != "1|true" ]]; then
  echo "concurrent history partition did not converge with RLS: $PARTITION_RESULT" >&2
  exit 1
fi

for invalid_call in \
  "SELECT arena.ensure_history_partitions('unknown', ARRAY[now()]::timestamptz[])" \
  "SELECT arena.ensure_history_partitions('order_records', ARRAY[now() + interval '3 months']::timestamptz[])" \
  "SELECT arena.ensure_history_partitions('order_records', ARRAY[now() - interval '121 months']::timestamptz[])"
do
  if psql_cmd -q -c "$invalid_call" >"$TMP_ROOT/invalid.log" 2>&1; then
    echo "invalid history partition request unexpectedly succeeded: $invalid_call" >&2
    exit 1
  fi
done

echo "history partition range guard PostgreSQL 17 proof passed"
