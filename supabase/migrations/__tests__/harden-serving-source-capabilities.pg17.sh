#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof that a stale materialized capability row cannot
# keep a demoted source public. This cluster never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260804051000_harden_serving_source_capabilities.sql"
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

TMP_ROOT="$(mktemp -d /tmp/harden-serving-capabilities-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((59000 + ($$ % 6000)))}"
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
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
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
  --username=postgres \
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
  status text NOT NULL,
  serving_mode text NOT NULL
);

CREATE TABLE arena.capability_fixture (
  slug text PRIMARY KEY,
  cap jsonb NOT NULL
);

INSERT INTO arena.sources (id, slug, status, serving_mode) VALUES
  (1, 'live', 'active', 'serving'),
  (2, 'shadow', 'active', 'shadow'),
  (3, 'inactive', 'inactive', 'serving'),
  (4, 'missing_mv', 'active', 'serving');

INSERT INTO arena.capability_fixture (slug, cap) VALUES
  ('live', '{"servingMode":"shadow","metrics":["roi"]}'::jsonb),
  ('shadow', '{"servingMode":"serving","metrics":["pnl"]}'::jsonb),
  ('inactive', '{"servingMode":"serving","metrics":["mdd"]}'::jsonb);

CREATE MATERIALIZED VIEW arena.mv_source_capabilities AS
SELECT slug, cap
FROM arena.capability_fixture;

CREATE FUNCTION public.arena_source_capabilities()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = arena, public
AS $function$
  SELECT COALESCE(jsonb_object_agg(slug, cap), '{}'::jsonb)
  FROM arena.mv_source_capabilities;
$function$;
SQL

psql_cmd -q -f "$MIGRATION"

INITIAL="$(
  psql_cmd -Atqc "
    SET ROLE anon;
    SELECT
      (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_object_keys(
          public.arena_source_capabilities()
        )
      ) || '|' ||
      (public.arena_source_capabilities()->'live'->>'servingMode') || '|' ||
      (public.arena_source_capabilities() ? 'shadow') || '|' ||
      (public.arena_source_capabilities() ? 'inactive') || '|' ||
      (public.arena_source_capabilities() ? 'missing_mv');
  "
)"
assert_equal 'initial live lifecycle filter failed' \
  '1|serving|false|false|false' "$INITIAL"

psql_cmd -q <<'SQL'
UPDATE arena.sources SET serving_mode = 'shadow' WHERE slug = 'live';
UPDATE arena.sources SET serving_mode = 'serving' WHERE slug = 'shadow';
SQL

AFTER_FLIP="$(
  psql_cmd -Atqc "
    SET ROLE authenticated;
    SELECT
      (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_object_keys(
          public.arena_source_capabilities()
        )
      ) || '|' ||
      (public.arena_source_capabilities() ? 'live') || '|' ||
      (public.arena_source_capabilities()->'shadow'->>'servingMode');
  "
)"
assert_equal 'lifecycle flip waited for materialized refresh' \
  '1|false|serving' "$AFTER_FLIP"

ACL_RESULT="$(
  psql_cmd -Atqc "
    SELECT
      pg_catalog.has_function_privilege(
        'anon',
        'public.arena_source_capabilities()',
        'EXECUTE'
      ) || '|' ||
      pg_catalog.has_function_privilege(
        'outsider',
        'public.arena_source_capabilities()',
        'EXECUTE'
      ) || '|' ||
      pg_catalog.has_table_privilege(
        'anon',
        'arena.mv_source_capabilities',
        'SELECT'
      );
  "
)"
assert_equal 'capability ACL boundary drifted' 'true|false|false' "$ACL_RESULT"

echo 'active-serving source capabilities PostgreSQL 17 proof passed'
