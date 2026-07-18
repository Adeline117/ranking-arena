#!/usr/bin/env bash

# Executable PostgreSQL 17 proof that freshness membership is registry-driven,
# canonicalizes aliases, and excludes the historical JSON "null" sentinel.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260718134000_freshness_expected_sources.sql"
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

TMP_ROOT="$(mktemp -d /tmp/freshness-expected-sources-pg17.XXXXXX)"
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

CREATE TABLE arena.exchanges (
  id bigint PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE arena.sources (
  slug text PRIMARY KEY,
  exchange_id bigint NOT NULL REFERENCES arena.exchanges(id),
  status text NOT NULL,
  serving_mode text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  timeframes_native integer[] NOT NULL,
  timeframes_derived integer[] NOT NULL
);

INSERT INTO arena.exchanges (id, name) VALUES (1, 'Example');
INSERT INTO arena.sources (
  slug, exchange_id, status, serving_mode, meta,
  timeframes_native, timeframes_derived
) VALUES
  ('canonical', 1, 'active', 'serving',
   '{"legacy_platform":"  shared  "}', '{7,30}', '{30,90}'),
  ('empty-alias', 1, 'active', 'serving',
   '{"legacy_platform":"  "}', '{7}', '{}'),
  ('sentinel', 1, 'active', 'serving',
   '{"legacy_platform":"null"}', '{7,30,90}', '{}'),
  ('inactive', 1, 'inactive', 'serving',
   '{}', '{7}', '{}'),
  ('shadow', 1, 'active', 'shadow',
   '{}', '{7}', '{}');
SQL

psql_cmd -q -f "$MIGRATION"

RESULT="$(
  psql_cmd -Atqc "
    SELECT
      pg_catalog.count(*) || '|' ||
      pg_catalog.count(*) FILTER (WHERE filter_source = 'shared') || '|' ||
      pg_catalog.count(*) FILTER (WHERE filter_source = 'empty-alias') || '|' ||
      pg_catalog.count(*) FILTER (WHERE registry_slug = 'sentinel') || '|' ||
      pg_catalog.count(*) FILTER (WHERE registry_slug IN ('inactive', 'shadow'))
    FROM public.arena_freshness_expected_sources();
  "
)"

if [[ "$RESULT" != "4|3|1|0|0" ]]; then
  echo "freshness expected-source membership drifted: $RESULT" >&2
  exit 1
fi

PRIVILEGES="$(
  psql_cmd -Atqc "
    SELECT
      has_function_privilege('service_role',
        'public.arena_freshness_expected_sources()', 'EXECUTE') || '|' ||
      has_function_privilege('anon',
        'public.arena_freshness_expected_sources()', 'EXECUTE') || '|' ||
      has_function_privilege('authenticated',
        'public.arena_freshness_expected_sources()', 'EXECUTE');
  "
)"

if [[ "$PRIVILEGES" != "true|false|false" ]]; then
  echo "freshness expected-source privileges drifted: $PRIVILEGES" >&2
  exit 1
fi

echo "freshness expected sources PostgreSQL 17 proof passed"
