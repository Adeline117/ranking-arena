#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof that shadow and inactive sources cannot cross
# the public trader identity boundary, even when they are newer or exact-ID
# matches. This cluster never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BASE_MIGRATION="$ROOT_DIR/supabase/migrations/20260718182917_arena_resolver_fetch_region.sql"
HARDENING_MIGRATION="$ROOT_DIR/supabase/migrations/20260804050000_harden_serving_trader_resolver.sql"
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

TMP_ROOT="$(mktemp -d /tmp/harden-serving-resolver-pg17.XXXXXX)"
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

assert_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "$label changed: expected '$expected', got '$actual'" >&2
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
CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE outsider NOLOGIN NOBYPASSRLS;
CREATE SCHEMA arena;
GRANT USAGE ON SCHEMA public, arena TO anon, authenticated, service_role, outsider;

CREATE TABLE arena.sources (
  id bigint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  fetch_region text NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id bigint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL,
  nickname text,
  avatar_url_mirror text,
  avatar_url_origin text,
  last_seen_at timestamptz
);

INSERT INTO arena.sources (
  id, slug, fetch_region, status, serving_mode, meta
) VALUES
  (1, 'binance_futures', 'vps_sg', 'active', 'serving',
   '{"legacy_platform":"binance"}'::jsonb),
  (2, 'shadow_board', 'local', 'active', 'shadow',
   '{"legacy_platform":"shadow"}'::jsonb),
  (3, 'inactive_board', 'vps_jp', 'inactive', 'serving',
   '{"legacy_platform":"inactive"}'::jsonb);

INSERT INTO arena.traders (
  id, source_id, exchange_trader_id, nickname, last_seen_at
) VALUES
  (1, 1, 'serving-42', 'Shared Nickname', now() - interval '3 days'),
  (2, 2, 'shadow-42', 'Shared Nickname', now() - interval '1 day'),
  (3, 3, 'inactive-42', 'Shared Nickname', now());
SQL

psql_cmd -q -f "$BASE_MIGRATION"
psql_cmd -q -f "$HARDENING_MIGRATION"

RESOLVED="$(
  psql_cmd -Atqc "
    SET ROLE anon;
    SELECT
      (resolved->>'source') || '|' ||
      (resolved->>'fetchRegion') || '|' ||
      (resolved->>'exchangeTraderId')
    FROM (
      SELECT public.arena_resolve_trader(
        'Shared Nickname',
        NULL
      ) AS resolved
    ) AS result;
  "
)"
assert_equal 'newer non-serving nickname candidate leaked' \
  'binance_futures|vps_sg|serving-42' "$RESOLVED"

ALIAS_RESOLVED="$(
  psql_cmd -Atqc "
    SET ROLE authenticated;
    SELECT resolved->>'exchangeTraderId'
    FROM (
      SELECT public.arena_resolve_trader(
        'Shared Nickname',
        'binance'
      ) AS resolved
    ) AS result;
  "
)"
assert_equal 'legacy source alias stopped resolving' 'serving-42' "$ALIAS_RESOLVED"

SHADOW_EXACT="$(
  psql_cmd -Atqc "
    SET ROLE anon;
    SELECT COALESCE(
      public.arena_resolve_trader('shadow-42', 'shadow')::text,
      'NULL'
    );
  "
)"
assert_equal 'shadow exact ID crossed public resolver' 'NULL' "$SHADOW_EXACT"

INACTIVE_EXACT="$(
  psql_cmd -Atqc "
    SET ROLE anon;
    SELECT COALESCE(
      public.arena_resolve_trader('inactive-42', 'inactive')::text,
      'NULL'
    );
  "
)"
assert_equal 'inactive exact ID crossed public resolver' 'NULL' "$INACTIVE_EXACT"

psql_cmd -q -c \
  "UPDATE arena.sources SET serving_mode = 'shadow' WHERE id = 1"
DEMOTED="$(
  psql_cmd -Atqc "
    SET ROLE anon;
    SELECT COALESCE(
      public.arena_resolve_trader('serving-42', 'binance')::text,
      'NULL'
    );
  "
)"
assert_equal 'demoted source remained publicly resolvable' 'NULL' "$DEMOTED"

ACL_RESULT="$(
  psql_cmd -Atqc "
    SELECT
      pg_catalog.has_function_privilege(
        'anon',
        'public.arena_resolve_trader(text,text)',
        'EXECUTE'
      ) || '|' ||
      pg_catalog.has_function_privilege(
        'outsider',
        'public.arena_resolve_trader(text,text)',
        'EXECUTE'
      ) || '|' ||
      pg_catalog.has_table_privilege(
        'anon',
        'arena.sources',
        'SELECT'
      );
  "
)"
assert_equal 'resolver ACL boundary drifted' 'true|false|false' "$ACL_RESULT"

echo 'active-serving trader resolver PostgreSQL 17 proof passed'
