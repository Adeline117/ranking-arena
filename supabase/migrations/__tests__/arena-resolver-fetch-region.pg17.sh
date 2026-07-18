#!/usr/bin/env bash

# PostgreSQL 17 proof that the public resolver returns fetch_region from the
# exact source row selected for the trader, without granting table reads.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260718182917_arena_resolver_fetch_region.sql"
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

TMP_ROOT="$(mktemp -d /tmp/arena-resolver-region-pg17.XXXXXX)"
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
CREATE ROLE outsider NOLOGIN;
CREATE SCHEMA arena;

CREATE TABLE arena.sources (
  id bigint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  fetch_region text NOT NULL,
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
  id, slug, fetch_region, serving_mode, meta
) VALUES
  (1, 'local_board', 'local', 'serving', '{"legacy_platform":"local"}'),
  (2, 'binance_futures', 'vps_sg', 'serving', '{"legacy_platform":"binance"}');

INSERT INTO arena.traders (
  id, source_id, exchange_trader_id, nickname, last_seen_at
) VALUES
  (1, 1, 'local-42', 'Same Nickname', now() - interval '1 day'),
  (2, 2, 'sg-42', 'Same Nickname', now());
SQL

psql_cmd -q -f "$MIGRATION"

RESULT="$(
  psql_cmd -Atqc "
    SET ROLE anon;
    SELECT
      (resolved->>'source') || '|' ||
      (resolved->>'fetchRegion') || '|' ||
      (resolved->>'exchangeTraderId')
    FROM (
      SELECT public.arena_resolve_trader(
        'Same Nickname',
        'binance'
      ) AS resolved
    ) AS result;
  "
)"
if [[ "$RESULT" != "binance_futures|vps_sg|sg-42" ]]; then
  echo "resolver did not bind fetchRegion to the selected source: $RESULT" >&2
  exit 1
fi

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
if [[ "$ACL_RESULT" != "true|false|false" ]]; then
  echo "resolver ACL boundary did not converge: $ACL_RESULT" >&2
  exit 1
fi

echo "arena resolver fetch-region PostgreSQL 17 proof passed"
