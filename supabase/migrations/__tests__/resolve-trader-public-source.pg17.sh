#!/usr/bin/env bash

# PostgreSQL 17 contract proof for 20261122204058: the trader resolver returns
# the source's public name, and that name is unambiguous in the registry.
#
#   = every field the resolver returned before is returned unchanged
#   + for every active + serving source, resolving a trader by the slug and by
#     the public name returns the same account, and publicSource is the name
#     the public leaderboard uses (legacy_platform when set, else the slug)
#   - a shadow or retired source is still not resolved
#   - a second active serving source with the same public name is refused,
#     on insert and when a shadow source is promoted
#   - a source whose public name is another source's slug (or whose slug is
#     another's public name) is refused
#   = names that collide only with inactive or shadow sources are allowed
#   - a replay is refused
# Isolated cluster on a private socket; never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
OLD_MIGRATION="$MIGRATIONS/20260804050000_harden_serving_trader_resolver.sql"
NEW_MIGRATION="$MIGRATIONS/20261122204058_resolve_trader_public_source.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/resolve-public-source-pg17.XXXXXX)"
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

psql_db() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

assert_equal() {
  if [[ "$2" != "$3" ]]; then
    echo "$1: expected '$2', got '$3'" >&2
    exit 1
  fi
  echo "ok: $1"
}

# expect_refused <label> <sqlstate> <sql>
expect_refused() {
  local output
  if output="$(psql_db -q -v VERBOSITY=verbose -c "$3" 2>&1)"; then
    echo "$1: the statement was accepted" >&2
    exit 1
  fi
  if ! grep -q "$2" <<<"$output"; then
    echo "$1: expected SQLSTATE $2, got: $output" >&2
    exit 1
  fi
  echo "ok: $1"
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

OLD_FUNCTION="$TMP_ROOT/old-resolver.sql"
awk '/^CREATE OR REPLACE FUNCTION public.arena_resolve_trader\(/ { on = 1 }
     on { print }
     on && /^\$function\$;/ { exit }' "$OLD_MIGRATION" >"$OLD_FUNCTION"
grep -q "legacy_platform" "$OLD_FUNCTION"

psql_db -q >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA arena;
CREATE TABLE arena.sources (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, slug text UNIQUE NOT NULL,
  status text NOT NULL, serving_mode text NOT NULL, fetch_region text NOT NULL DEFAULT 'local',
  meta jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE arena.traders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources (id), exchange_trader_id text NOT NULL,
  nickname text, avatar_url_mirror text, avatar_url_origin text, last_seen_at timestamptz
);
INSERT INTO arena.sources (slug, status, serving_mode, meta) VALUES
  ('bybit_copytrade', 'active', 'serving', '{"legacy_platform": "bybit"}'),
  ('blofin_futures', 'active', 'serving', '{"legacy_platform": "blofin"}'),
  ('htx_spot', 'active', 'serving', '{}'),
  ('gate_cfd', 'active', 'serving', '{"legacy_platform": ""}'),
  ('okx_shadow', 'active', 'shadow', '{"legacy_platform": "okx"}'),
  ('mexc_old', 'retired', 'serving', '{"legacy_platform": "mexc"}');
INSERT INTO arena.traders (source_id, exchange_trader_id, nickname, avatar_url_mirror, last_seen_at)
SELECT id, 'uid-' || slug, 'Nick ' || slug, 'https://cdn.test/' || slug, pg_catalog.now()
  FROM arena.sources;
SQL
psql_db -q -f "$OLD_FUNCTION"

legacy_fields() {
  psql_db -Atq -c "SELECT string_agg(
      coalesce((public.arena_resolve_trader('uid-' || slug, by.name) - 'publicSource')::text, 'null'),
      ' | ' ORDER BY slug, by.name NULLS FIRST)
    FROM arena.sources
    CROSS JOIN LATERAL (VALUES (NULL::text), (slug), (meta->>'legacy_platform')) AS by(name)"
}
BEFORE="$(legacy_fields)"

psql_db -q -f "$NEW_MIGRATION" >/dev/null

assert_equal "every field returned before is unchanged" "$BEFORE" "$(legacy_fields)"

assert_equal "slug and public name resolve the same account with the public leaderboard's source" \
  "blofin_futures:blofin:true bybit_copytrade:bybit:true gate_cfd:gate_cfd:true htx_spot:htx_spot:true" \
  "$(psql_db -Atq -c "
    SELECT string_agg(slug || ':' || (by_slug->>'publicSource') || ':' ||
             (by_slug = by_public AND by_slug->>'source' = slug
              AND by_slug->>'exchangeTraderId' = 'uid-' || slug)::text, ' ' ORDER BY slug)
      FROM (
        SELECT slug,
               public.arena_resolve_trader('uid-' || slug, slug) AS by_slug,
               public.arena_resolve_trader('uid-' || slug,
                 COALESCE(NULLIF(meta->>'legacy_platform', ''), slug)) AS by_public
          FROM arena.sources WHERE status = 'active' AND serving_mode = 'serving'
      ) AS resolved")"

assert_equal "a shadow or retired source is not resolved" "t" \
  "$(psql_db -Atq -c "SELECT public.arena_resolve_trader('uid-okx_shadow', 'okx') IS NULL
                         AND public.arena_resolve_trader('uid-mexc_old', 'mexc_old') IS NULL")"

expect_refused "a second serving source with the same public name is refused" "23505" \
  "INSERT INTO arena.sources (slug, status, serving_mode, meta)
   VALUES ('bybit_second', 'active', 'serving', '{\"legacy_platform\": \"bybit\"}')"
expect_refused "a public name equal to another source's slug is refused" "23505" \
  "INSERT INTO arena.sources (slug, status, serving_mode, meta)
   VALUES ('htx_alias', 'active', 'serving', '{\"legacy_platform\": \"htx_spot\"}')"
expect_refused "a slug equal to another source's public name is refused" "23505" \
  "INSERT INTO arena.sources (slug, status, serving_mode) VALUES ('blofin', 'active', 'serving')"
expect_refused "changing an alias onto another source's slug is refused" "23505" \
  "UPDATE arena.sources SET meta = '{\"legacy_platform\": \"gate_cfd\"}' WHERE slug = 'htx_spot'"

psql_db -q -c "INSERT INTO arena.sources (slug, status, serving_mode, meta) VALUES
  ('bybit_shadow', 'active', 'shadow', '{\"legacy_platform\": \"bybit\"}'),
  ('okx_live', 'active', 'serving', '{\"legacy_platform\": \"okx\"}'),
  ('mexc', 'active', 'serving', '{}')"
echo "ok: names shared only with shadow or retired sources are allowed"
expect_refused "promoting a shadow source onto a taken public name is refused" "23505" \
  "UPDATE arena.sources SET serving_mode = 'serving' WHERE slug = 'bybit_shadow'"

assert_equal "application roles cannot execute the registry trigger function" "f" \
  "$(psql_db -Atq -c "SELECT has_function_privilege('anon', 'arena.reject_ambiguous_serving_source_name()', 'EXECUTE')
                          OR has_function_privilege('service_role', 'arena.reject_ambiguous_serving_source_name()', 'EXECUTE')")"

if psql_db -q -f "$NEW_MIGRATION" >/dev/null 2>"$TMP_ROOT/replay.err"; then
  echo "replaying the migration was not refused" >&2
  exit 1
fi
grep -q "is not the 20260804050000 definition" "$TMP_ROOT/replay.err"
echo "ok: a replay is refused"

echo "resolve trader public source PostgreSQL 17 proof passed"
