#!/usr/bin/env bash

# Executable PostgreSQL 17 proof that every visible positive ranking row blocks
# source shadowing, including rows whose ROI is NULL.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260718123000_shadow_sources_without_roi_basis.sql"
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

TMP_ROOT="$(mktemp -d /tmp/shadow-roi-basis-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((57000 + ($$ % 8000)))}"
ERROR_FILE="$TMP_ROOT/expected-error.log"
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
CREATE SCHEMA arena;

CREATE TABLE arena.sources (
  id bigint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY,
  source_id bigint NOT NULL,
  timeframe integer NOT NULL,
  scraped_at timestamptz NOT NULL,
  count_check_passed boolean NOT NULL
);

CREATE TABLE arena.leaderboard_entries (
  snapshot_id bigint NOT NULL,
  trader_id bigint NOT NULL,
  headline_roi numeric
);

CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id bigint NOT NULL,
  exchange_trader_id text NOT NULL
);

CREATE TABLE arena.trader_stats (
  trader_id bigint NOT NULL,
  timeframe integer NOT NULL,
  roi numeric
);

CREATE TABLE public.leaderboard_ranks (
  source text NOT NULL,
  season_id text NOT NULL,
  arena_score numeric NOT NULL,
  is_outlier boolean,
  roi numeric
);

INSERT INTO arena.sources (
  id, slug, status, serving_mode, meta
) VALUES
  (1, 'gtrade', 'active', 'serving', '{}'::jsonb),
  (2, 'bitfinex', 'active', 'serving', '{}'::jsonb);

INSERT INTO arena.traders (
  id, source_id, exchange_trader_id
) VALUES
  (1, 1, 'gtrade-1'),
  (2, 2, 'bitfinex-1');

INSERT INTO arena.trader_stats (
  trader_id, timeframe, roi
) VALUES
  (1, 90, NULL),
  (2, 90, NULL);

INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, scraped_at, count_check_passed
) VALUES
  (1, 1, 90, pg_catalog.now() - interval '1 hour', true),
  (2, 2, 90, pg_catalog.now() - interval '1 hour', true);

INSERT INTO arena.leaderboard_entries (
  snapshot_id, trader_id, headline_roi
) VALUES
  (1, 1, NULL),
  (2, 2, NULL);

-- This row is visible under the product's real ranking predicate even though
-- its ROI is NULL. It must block the downgrade.
INSERT INTO public.leaderboard_ranks (
  source, season_id, arena_score, is_outlier, roi
) VALUES
  ('gtrade', '90D', 10, false, NULL);
SQL

if psql_cmd -q -f "$MIGRATION" >"$ERROR_FILE" 2>&1; then
  echo "shadow migration ignored a visible positive NULL-ROI row" >&2
  exit 1
fi
if ! rg -q 'unexpectedly have 1 public ranking rows' "$ERROR_FILE"; then
  echo "shadow migration failed for an unexpected reason" >&2
  sed -n '1,120p' "$ERROR_FILE" >&2
  exit 1
fi

SERVING_COUNT="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.count(*)
    FROM arena.sources
    WHERE slug IN ('gtrade', 'bitfinex')
      AND serving_mode = 'serving';
  "
)"
if [[ "$SERVING_COUNT" != "2" ]]; then
  echo "failed preflight changed source visibility: $SERVING_COUNT/2 serving" >&2
  exit 1
fi

psql_cmd -q -c "DELETE FROM public.leaderboard_ranks;"
psql_cmd -q -f "$MIGRATION"

SHADOW_COUNT="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.count(*)
    FROM arena.sources
    WHERE slug IN ('gtrade', 'bitfinex')
      AND status = 'active'
      AND serving_mode = 'shadow'
      AND meta->>'rank_visibility_blocker' = 'missing_real_roi_basis';
  "
)"
if [[ "$SHADOW_COUNT" != "2" ]]; then
  echo "safe shadow cutover did not update both sources: $SHADOW_COUNT/2" >&2
  exit 1
fi

echo "shadow sources without ROI basis PostgreSQL 17 proof passed"
