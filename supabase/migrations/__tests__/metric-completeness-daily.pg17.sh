#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for the metric completeness evidence table:
# exact per-window identity, internally consistent counts, provenance, RLS,
# and service-role-only access.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260718140000_add_metric_completeness_daily.sql"
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

TMP_ROOT="$(mktemp -d /tmp/metric-completeness-daily-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
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
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA arena;

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL
);

INSERT INTO arena.sources (id, slug) VALUES (1, 'example');
SQL

psql_cmd -q -f "$MIGRATION"

psql_cmd -q <<'SQL'
INSERT INTO arena.metric_completeness_daily (
  taken_on,
  measured_at,
  source_id,
  timeframe,
  metric,
  board_snapshot_at,
  upstream_source_as_of,
  population_total,
  stats_total,
  fresh_stats_total,
  filled,
  fresh_filled,
  oldest_stats_as_of,
  newest_stats_as_of,
  stats_freshness_hours,
  contract_hash,
  measurement_state
) VALUES (
  DATE '2026-07-18',
  TIMESTAMPTZ '2026-07-18 19:00:00+00',
  1,
  7,
  'roi',
  TIMESTAMPTZ '2026-07-18 18:00:00+00',
  TIMESTAMPTZ '2026-07-18 17:55:00+00',
  100,
  90,
  80,
  85,
  75,
  TIMESTAMPTZ '2026-07-16 12:00:00+00',
  TIMESTAMPTZ '2026-07-18 18:30:00+00',
  48,
  repeat('a', 64),
  'measured'
);

INSERT INTO arena.metric_completeness_daily (
  taken_on,
  measured_at,
  source_id,
  timeframe,
  metric,
  population_total,
  stats_total,
  fresh_stats_total,
  filled,
  fresh_filled,
  stats_freshness_hours,
  contract_hash,
  measurement_state
) VALUES (
  DATE '2026-07-18',
  TIMESTAMPTZ '2026-07-18 19:00:00+00',
  1,
  30,
  'roi',
  0,
  0,
  0,
  0,
  0,
  48,
  repeat('b', 64),
  'missing_board_snapshot'
);
SQL

expect_failure \
  "filled greater than stats_total" \
  "INSERT INTO arena.metric_completeness_daily
     (taken_on, measured_at, source_id, timeframe, metric, board_snapshot_at,
      upstream_source_as_of, population_total, stats_total, fresh_stats_total,
      filled, fresh_filled, oldest_stats_as_of, newest_stats_as_of,
      stats_freshness_hours, contract_hash, measurement_state)
   VALUES
     (DATE '2026-07-19', TIMESTAMPTZ '2026-07-19 12:00:00+00', 1, 7, 'pnl',
      TIMESTAMPTZ '2026-07-19 11:00:00+00',
      TIMESTAMPTZ '2026-07-19 11:00:00+00',
      10, 5, 5, 6, 5, TIMESTAMPTZ '2026-07-19 10:00:00+00',
      TIMESTAMPTZ '2026-07-19 11:00:00+00', 48, repeat('c', 64), 'measured');"

expect_failure \
  "unsupported metric" \
  "INSERT INTO arena.metric_completeness_daily
     (taken_on, measured_at, source_id, timeframe, metric, population_total,
      stats_total, fresh_stats_total, filled, fresh_filled,
      stats_freshness_hours, contract_hash, measurement_state)
   VALUES
     (DATE '2026-07-19', TIMESTAMPTZ '2026-07-19 12:00:00+00', 1, 7,
      'invented', 0, 0, 0, 0, 0, 48, repeat('d', 64),
      'missing_board_snapshot');"

expect_failure \
  "non-SHA contract hash" \
  "INSERT INTO arena.metric_completeness_daily
     (taken_on, measured_at, source_id, timeframe, metric, population_total,
      stats_total, fresh_stats_total, filled, fresh_filled,
      stats_freshness_hours, contract_hash, measurement_state)
   VALUES
     (DATE '2026-07-19', TIMESTAMPTZ '2026-07-19 12:00:00+00', 1, 7,
      'pnl', 0, 0, 0, 0, 0, 48, 'not-a-sha',
      'missing_board_snapshot');"

expect_failure \
  "inconsistent missing snapshot state" \
  "INSERT INTO arena.metric_completeness_daily
     (taken_on, measured_at, source_id, timeframe, metric, board_snapshot_at,
      upstream_source_as_of, population_total, stats_total, fresh_stats_total,
      filled, fresh_filled, oldest_stats_as_of, newest_stats_as_of,
      stats_freshness_hours, contract_hash, measurement_state)
   VALUES
     (DATE '2026-07-19', TIMESTAMPTZ '2026-07-19 12:00:00+00', 1, 7, 'pnl',
      TIMESTAMPTZ '2026-07-19 11:00:00+00',
      TIMESTAMPTZ '2026-07-19 11:00:00+00',
      10, 5, 5, 5, 5, TIMESTAMPTZ '2026-07-19 10:00:00+00',
      TIMESTAMPTZ '2026-07-19 11:00:00+00', 48, repeat('e', 64),
      'missing_board_snapshot');"

expect_failure \
  "measured state without evidence" \
  "INSERT INTO arena.metric_completeness_daily
     (taken_on, measured_at, source_id, timeframe, metric, population_total,
      stats_total, fresh_stats_total, filled, fresh_filled,
      stats_freshness_hours, contract_hash, measurement_state)
   VALUES
     (DATE '2026-07-19', TIMESTAMPTZ '2026-07-19 12:00:00+00', 1, 7,
      'pnl', 0, 0, 0, 0, 0, 48, repeat('f', 64), 'measured');"

expect_failure \
  "missing watermark state with a watermark" \
  "INSERT INTO arena.metric_completeness_daily
     (taken_on, measured_at, source_id, timeframe, metric, board_snapshot_at,
      upstream_source_as_of, population_total, stats_total, fresh_stats_total,
      filled, fresh_filled, oldest_stats_as_of, newest_stats_as_of,
      stats_freshness_hours, contract_hash, measurement_state)
   VALUES
     (DATE '2026-07-19', TIMESTAMPTZ '2026-07-19 12:00:00+00', 1, 7, 'pnl',
      TIMESTAMPTZ '2026-07-19 11:00:00+00',
      TIMESTAMPTZ '2026-07-19 11:00:00+00',
      10, 5, 5, 5, 5, TIMESTAMPTZ '2026-07-19 10:00:00+00',
      TIMESTAMPTZ '2026-07-19 11:00:00+00', 48, repeat('1', 64),
      'missing_upstream_watermark');"

expect_failure \
  "stale watermark state with no watermark" \
  "INSERT INTO arena.metric_completeness_daily
     (taken_on, measured_at, source_id, timeframe, metric, board_snapshot_at,
      population_total, stats_total, fresh_stats_total, filled, fresh_filled,
      oldest_stats_as_of, newest_stats_as_of, stats_freshness_hours,
      contract_hash, measurement_state)
   VALUES
     (DATE '2026-07-19', TIMESTAMPTZ '2026-07-19 12:00:00+00', 1, 7, 'pnl',
      TIMESTAMPTZ '2026-07-19 11:00:00+00',
      10, 5, 5, 5, 5, TIMESTAMPTZ '2026-07-19 10:00:00+00',
      TIMESTAMPTZ '2026-07-19 11:00:00+00', 48, repeat('2', 64),
      'stale_upstream_watermark');"

expect_failure \
  "future upstream watermark" \
  "INSERT INTO arena.metric_completeness_daily
     (taken_on, measured_at, source_id, timeframe, metric, board_snapshot_at,
      upstream_source_as_of, population_total, stats_total, fresh_stats_total,
      filled, fresh_filled, oldest_stats_as_of, newest_stats_as_of,
      stats_freshness_hours, contract_hash, measurement_state)
   VALUES
     (DATE '2026-07-19', TIMESTAMPTZ '2026-07-19 12:00:00+00', 1, 7, 'pnl',
      TIMESTAMPTZ '2026-07-19 11:00:00+00',
      TIMESTAMPTZ '2026-07-19 12:06:00+00',
      10, 5, 5, 5, 5, TIMESTAMPTZ '2026-07-19 10:00:00+00',
      TIMESTAMPTZ '2026-07-19 11:00:00+00', 48, repeat('3', 64),
      'measured');"

expect_failure \
  "fresh count with only stale stats timestamps" \
  "INSERT INTO arena.metric_completeness_daily
     (taken_on, measured_at, source_id, timeframe, metric, board_snapshot_at,
      upstream_source_as_of, population_total, stats_total, fresh_stats_total,
      filled, fresh_filled, oldest_stats_as_of, newest_stats_as_of,
      stats_freshness_hours, contract_hash, measurement_state)
   VALUES
     (DATE '2026-07-19', TIMESTAMPTZ '2026-07-19 12:00:00+00', 1, 7, 'pnl',
      TIMESTAMPTZ '2026-07-19 11:00:00+00',
      TIMESTAMPTZ '2026-07-19 11:00:00+00',
      10, 5, 5, 5, 5, TIMESTAMPTZ '2026-07-16 10:00:00+00',
      TIMESTAMPTZ '2026-07-16 11:00:00+00', 48, repeat('5', 64),
      'measured');"

expect_failure \
  "zero fresh count with a fresh stats timestamp" \
  "INSERT INTO arena.metric_completeness_daily
     (taken_on, measured_at, source_id, timeframe, metric, board_snapshot_at,
      upstream_source_as_of, population_total, stats_total, fresh_stats_total,
      filled, fresh_filled, oldest_stats_as_of, newest_stats_as_of,
      stats_freshness_hours, contract_hash, measurement_state)
   VALUES
     (DATE '2026-07-19', TIMESTAMPTZ '2026-07-19 12:00:00+00', 1, 7, 'pnl',
      TIMESTAMPTZ '2026-07-19 11:00:00+00',
      TIMESTAMPTZ '2026-07-19 11:00:00+00',
      10, 5, 0, 0, 0, TIMESTAMPTZ '2026-07-19 10:00:00+00',
      TIMESTAMPTZ '2026-07-19 11:00:00+00', 48, repeat('6', 64),
      'no_fresh_stats');"

expect_failure \
  "taken_on does not match measured UTC day" \
  "INSERT INTO arena.metric_completeness_daily
     (taken_on, measured_at, source_id, timeframe, metric, population_total,
      stats_total, fresh_stats_total, filled, fresh_filled,
      stats_freshness_hours, contract_hash, measurement_state)
   VALUES
     (DATE '2026-07-20', TIMESTAMPTZ '2026-07-19 23:59:00+00', 1, 7,
      'pnl', 0, 0, 0, 0, 0, 48, repeat('4', 64),
      'missing_board_snapshot');"

IDENTITY="$(
  psql_cmd -Atqc "
    SELECT
      count(*) || '|' ||
      count(DISTINCT (source_id, timeframe, metric)) || '|' ||
      bool_and(stats_total <= population_total) || '|' ||
      bool_and(filled <= stats_total)
    FROM arena.metric_completeness_daily;
  "
)"
if [[ "$IDENTITY" != "2|2|true|true" ]]; then
  echo "metric completeness identity/count contract drifted: $IDENTITY" >&2
  exit 1
fi

PRIVILEGES="$(
  psql_cmd -Atqc "
    SELECT
      relrowsecurity || '|' ||
      has_table_privilege('service_role',
        'arena.metric_completeness_daily', 'SELECT,INSERT,UPDATE,DELETE') || '|' ||
      has_table_privilege('anon',
        'arena.metric_completeness_daily', 'SELECT') || '|' ||
      has_table_privilege('authenticated',
        'arena.metric_completeness_daily', 'SELECT')
    FROM pg_class
    WHERE oid = 'arena.metric_completeness_daily'::regclass;
  "
)"
if [[ "$PRIVILEGES" != "true|true|false|false" ]]; then
  echo "metric completeness RLS/privileges drifted: $PRIVILEGES" >&2
  exit 1
fi

echo "metric completeness daily PostgreSQL 17 proof passed"
