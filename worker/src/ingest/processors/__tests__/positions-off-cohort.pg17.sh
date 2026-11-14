#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for PRUNE_OFF_COHORT_POSITIONS_SQL
# (worker/src/ingest/processors/maintenance.ts). Owns an isolated temporary
# cluster and never connects to a developer or remote DB.
#
# Proves:
#   1. open positions of a trader that left the Tier-D cohort (rank > topN, or
#      claimed) are deleted once older than the grace window;
#   2. cohort members, and off-cohort rows still inside the grace window, stay;
#   3. a source without a fresh PASSED native board is never touched (a stalled
#      Tier A must not empty a source's positions; derived boards do not count);
#   4. the batch bound caps the rows deleted per run.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
SQL_MODULE="$ROOT_DIR/worker/src/ingest/processors/maintenance.ts"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  [[ -x "$PG_BIN/$executable" ]] || { echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2; exit 1; }
done

TMP_ROOT="$(mktemp -d /tmp/positions-off-cohort-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55487
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if (( exit_code != 0 )) && [[ -f "$LOG_FILE" ]]; then
    tail -120 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

"$PG_BIN/initdb" -D "$DATA_DIR" --auth-local=trust --auth-host=trust \
  --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null

PRUNE_SQL="$(node -e '
const s = require("fs").readFileSync(process.argv[1], "utf8")
const m = s.match(/PRUNE_OFF_COHORT_POSITIONS_SQL = `([\s\S]*?)`/)
if (!m) { console.error("PRUNE_OFF_COHORT_POSITIONS_SQL not found"); process.exit(1) }
process.stdout.write(m[1])
' "$SQL_MODULE")"

seed() {
  psql_cmd <<'SQL'
SET client_min_messages = warning;
DROP SCHEMA IF EXISTS arena CASCADE;
CREATE SCHEMA arena;
CREATE TABLE arena.sources (id smallint PRIMARY KEY, positions_topn int NOT NULL);
CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  meta jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL,
  timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL,
  count_check_passed boolean NOT NULL,
  is_derived boolean NOT NULL DEFAULT false
);
CREATE TABLE arena.leaderboard_entries (
  snapshot_id bigint NOT NULL,
  trader_id bigint NOT NULL,
  rank int NOT NULL
);
CREATE TABLE arena.positions_current (
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  snapshot_at timestamptz NOT NULL,
  symbol text NOT NULL,
  side text,
  PRIMARY KEY (trader_id, symbol, side)
);

INSERT INTO arena.sources VALUES (1, 2), (2, 2), (3, 2);
-- source 1: fresh passed board. 11 rank 1 (cohort), 12 rank 3 (off),
-- 13 rank 2 but claimed (off), 14 off-cohort but refreshed recently.
-- source 2: only a stale board (> 72h). source 3: only a fresh DERIVED board.
INSERT INTO arena.traders VALUES
  (11, 1, '{}'), (12, 1, '{}'), (13, 1, '{"claimed": "true"}'), (14, 1, '{}'),
  (21, 2, '{}'), (31, 3, '{}');
INSERT INTO arena.leaderboard_snapshots VALUES
  (100, 1, 30, now() - interval '1 hour', true, false),
  (101, 1, 30, now() - interval '2 hours', false, false),
  (200, 2, 30, now() - interval '80 hours', true, false),
  (300, 3, 30, now() - interval '1 hour', true, true);
INSERT INTO arena.leaderboard_entries VALUES
  (100, 11, 1), (100, 13, 2), (100, 12, 3),
  (101, 12, 1),            -- failed snapshot: does not put 12 back in the cohort
  (200, 21, 9), (300, 31, 9);
INSERT INTO arena.positions_current VALUES
  (11, now() - interval '30 hours', 'BTC', 'long'),
  (12, now() - interval '30 hours', 'BTC', 'long'),
  (12, now() - interval '30 hours', 'ETH', 'short'),
  (13, now() - interval '30 hours', 'BTC', 'long'),
  (14, now() - interval '2 hours', 'BTC', 'long'),
  (21, now() - interval '30 hours', 'BTC', 'long'),
  (31, now() - interval '30 hours', 'BTC', 'long');
SQL
}

run_prune() {
  psql_cmd <<SQL
PREPARE prune(int, int, int) AS $PRUNE_SQL;
EXECUTE prune(259200, 86400, $1);
SQL
}

remaining() {
  psql_cmd -c "SELECT string_agg(trader_id || ':' || symbol, ',' ORDER BY trader_id, symbol) FROM arena.positions_current"
}

expect_eq() {
  if [[ "$1" != "$2" ]]; then
    echo "FAIL: $3 — expected [$2], got [$1]" >&2
    exit 1
  fi
  echo "ok - $3"
}

seed
run_prune 5000
expect_eq "$(remaining)" "11:BTC,14:BTC,21:BTC,31:BTC" \
  "off-cohort (rank > topN, claimed) rows past grace deleted; cohort, in-grace and no-fresh-board sources kept"

seed
run_prune 1
expect_eq "$(psql_cmd -c 'SELECT count(*) FROM arena.positions_current')" "6" \
  "batch bound caps rows deleted per run"
