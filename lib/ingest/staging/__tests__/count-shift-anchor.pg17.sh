#!/usr/bin/env bash

# PostgreSQL 17 proof that an adopted count level-shift anchors the baseline
# (lib/ingest/staging/count-check.ts), run on the real baseline statements.
#
# The observed binance_web3_bsc 30D sequence of 2026-11-26/27 (237 -> 341 ->
# 293) is replayed through getCountBaseline + evaluateCount, each snapshot
# written the way publish.ts writes it:
#   + 341 is adopted after three independent cycles and becomes the anchor;
#     the next two cycles (333, 334) pass against it
#   - the drop to ~293 is judged against the new level (-12%) and fails; once
#     three cycles agree it is a downward shift pending acknowledgement, never
#     an "upward" shift over the overturned 237
#   + with count_shift_ack.30 = 293 the drop is adopted and becomes the anchor
#   = BullMQ retries of one cycle still count once
# Isolated cluster on a private socket; never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
DRIVER="$ROOT_DIR/lib/ingest/staging/__tests__/count-shift-anchor.pg17-replay.mts"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/count-shift-anchor-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((53000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -40 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

DATABASE_URL="postgresql://postgres@localhost/postgres?host=$SOCKET_DIR&port=$PORT"

reset_fixture() {
  PGOPTIONS="-c client_min_messages=warning" "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres <<SQL
DROP SCHEMA IF EXISTS arena CASCADE;
CREATE SCHEMA arena;
CREATE TABLE arena.sources (id smallint PRIMARY KEY, meta jsonb NOT NULL DEFAULT '{}');
INSERT INTO arena.sources VALUES (1, '${1:-{\}}');
CREATE TABLE arena.leaderboard_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL,
  timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL,
  actual_count integer NOT NULL,
  baseline_used integer,
  count_check_passed boolean NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'
);
-- Seven earlier passing cycles at the level production reported as 237.
INSERT INTO arena.leaderboard_snapshots
  (source_id, timeframe, scraped_at, actual_count, baseline_used, count_check_passed, meta)
SELECT 1, 30, '2026-11-20 00:00+00'::timestamptz + n * interval '5 hours', 237, 237, true,
       jsonb_build_object('observation_cycle_id', 'old-' || n)
  FROM generate_series(1, 7) AS n;
SQL
}

replay() {
  (cd "$ROOT_DIR" && npx tsx "$DRIVER" "$DATABASE_URL" "$1")
}

assert_replay() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label: replay differs" >&2
    diff <(echo "$expected") <(echo "$actual") >&2 || true
    exit 1
  fi
  echo "ok: $label"
}

# Observed 11-26/27 (retries of one cycle share its id), then the board
# staying at ~293 for three more cycles.
SEQUENCE='[
  {"t":"11-26T17:11","cycle":"A","count":341},
  {"t":"11-26T17:16","cycle":"B","count":341},
  {"t":"11-26T21:58","cycle":"C","count":342},
  {"t":"11-27T02:58","cycle":"D","count":333},
  {"t":"11-27T07:58","cycle":"E","count":334},
  {"t":"11-27T12:58","cycle":"F","count":294},
  {"t":"11-27T13:11","cycle":"F","count":293},
  {"t":"11-27T13:14","cycle":"F","count":293},
  {"t":"next-1","cycle":"G","count":293},
  {"t":"next-2","cycle":"H","count":292},
  {"t":"next-3","cycle":"I","count":293}
]'

reset_fixture '{}'
assert_replay "an adopted shift anchors the baseline; the later drop waits for acknowledgement" \
"11-26T17:11 341 base 237 fail
11-26T17:16 341 base 237 fail
11-26T21:58 342 base 341 PASS shift adopted
11-27T02:58 333 base 341 PASS
11-27T07:58 334 base 341 PASS
11-27T12:58 294 base 334 fail
11-27T13:11 293 base 334 fail
11-27T13:14 293 base 334 fail
next-1 293 base 334 fail
next-2 292 base 334 fail down-shift 293 pending ack
next-3 293 base 334 fail down-shift 293 pending ack" \
  "$(replay "$SEQUENCE")"

reset_fixture '{"count_shift_ack": {"30": 293}}'
assert_replay "with the drop acknowledged it is adopted and becomes the anchor" \
"11-26T17:11 341 base 237 fail
11-26T17:16 341 base 237 fail
11-26T21:58 342 base 341 PASS shift adopted
11-27T02:58 333 base 341 PASS
11-27T07:58 334 base 341 PASS
11-27T12:58 294 base 334 fail
11-27T13:11 293 base 334 fail
11-27T13:14 293 base 334 fail
next-1 293 base 334 fail
next-2 292 base 293 PASS shift adopted
next-3 293 base 293 PASS" \
  "$(replay "$SEQUENCE")"

echo "count shift anchor PostgreSQL 17 proof passed"
