#!/usr/bin/env bash

# Executable PostgreSQL 17 proof that freshness backfill ignores retired
# physical sources sharing a public alias. It owns an isolated cluster.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260718120000_leaderboard_source_freshness.sql"
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

TMP_ROOT="$(mktemp -d /tmp/leaderboard-freshness-pg17.XXXXXX)"
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
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA arena;

CREATE TABLE public.leaderboard_ranks (
  source text NOT NULL,
  season_id text NOT NULL,
  arena_score numeric NOT NULL,
  is_outlier boolean
);

CREATE TABLE arena.sources (
  id bigint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  currency text NOT NULL
);

CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY,
  source_id bigint NOT NULL,
  timeframe integer NOT NULL,
  scraped_at timestamptz NOT NULL,
  count_check_passed boolean NOT NULL
);

INSERT INTO arena.sources (
  id, slug, status, serving_mode, meta, currency
) VALUES
  (1, 'active-board', 'active', 'serving',
   '{"legacy_platform":"shared"}', 'USDT'),
  (2, 'retired-board', 'inactive', 'shadow',
   '{"legacy_platform":"shared"}', 'USDT'),
  (3, 'empty-alias-board', 'active', 'serving',
   '{"legacy_platform":""}', 'USDC');

INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, scraped_at, count_check_passed
) VALUES
  (1, 1, 90, pg_catalog.now() - interval '1 hour', true),
  (2, 2, 90, pg_catalog.now() - interval '100 days', true),
  (3, 3, 90, pg_catalog.now() - interval '2 hours', true);

INSERT INTO public.leaderboard_ranks (
  source, season_id, arena_score, is_outlier
) VALUES
  ('shared', '90D', 10, false),
  ('empty-alias-board', '90D', 9, false);
SQL

psql_cmd -q -f "$MIGRATION"

RESULT="$(
  psql_cmd -Atqc "
    SELECT
      pg_catalog.count(*) || '|' ||
      pg_catalog.bool_and(
        source_as_of > pg_catalog.now() - interval '3 hours'
      ) || '|' ||
      pg_catalog.bool_or(source = 'empty-alias-board')
    FROM public.leaderboard_source_freshness
    WHERE season_id = '90D';
  "
)"

if [[ "$RESULT" != "2|true|true" ]]; then
  echo "freshness backfill admitted a retired alias or lost an empty alias: $RESULT" >&2
  exit 1
fi

echo "leaderboard source freshness PostgreSQL 17 proof passed"
