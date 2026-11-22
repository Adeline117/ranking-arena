#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261121201553: public.arena_visible_sources() lists
# the registry sources with published ranks in the serving cohort, with no dependency
# on public.leaderboard_count_cache.
#
#   - before: with an empty count cache the 20260716071500 definition returns
#     nothing although the public view serves ranks (the production incident)
#   + after: it returns exactly the sources with sealed published ranks in the
#     serving cohort, with the sealed counts
#   - a source sealed with zero rows, a proof of an older cohort, a season that
#     is not being served, a non-serving / retired registry row and an unknown
#     season return nothing
#   = two registry boards sharing one public alias both appear with the alias
#     count; signature, owner and grants are unchanged; anon can execute
# The migration is applied by a non-superuser owner. Isolated cluster on a
# private socket; never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
OLD_MIGRATION="$MIGRATIONS/20260716071500_visible_leaderboard_sources.sql"
NEW_MIGRATION="$MIGRATIONS/20261121201553_visible_sources_from_served_ranks.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/visible-sources-pg17.XXXXXX)"
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

psql_as() {
  local role="$1"
  shift
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U "$role" -d postgres "$@"
}

assert_equal() {
  if [[ "$2" != "$3" ]]; then
    echo "$1: expected '$2', got '$3'" >&2
    exit 1
  fi
  echo "ok: $1"
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U bootstrap --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

psql_as bootstrap -q <<'SQL'
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE;
CREATE ROLE anon LOGIN NOSUPERUSER;
CREATE ROLE authenticated NOSUPERUSER;
CREATE ROLE service_role NOSUPERUSER;
GRANT CREATE ON DATABASE postgres TO postgres;
ALTER SCHEMA public OWNER TO postgres;
SQL

psql_as postgres -q <<'SQL'
CREATE SCHEMA arena;
CREATE TABLE arena.exchanges (id int PRIMARY KEY, slug text NOT NULL, name text NOT NULL);
CREATE TABLE arena.sources (
  id int PRIMARY KEY, slug text NOT NULL, exchange_id int NOT NULL REFERENCES arena.exchanges,
  product_type text NOT NULL, status text NOT NULL, serving_mode text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE public.leaderboard_count_cache (
  season_id text, source text, total_count integer, updated_at timestamptz
);
CREATE TABLE public.leaderboard_source_freshness (
  season_id text NOT NULL, source text NOT NULL, source_as_of timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL, score_cohort_id uuid, published_rank_count integer,
  PRIMARY KEY (season_id, source)
);
CREATE TABLE arena.public_ranked_leaderboard_serving_heads (
  season_id text PRIMARY KEY, score_cohort_id uuid NOT NULL
);
-- Stand-in for the public view's serving gate: the seasons listed here.
CREATE TABLE arena.served_seasons (season_id text PRIMARY KEY);
CREATE FUNCTION arena.public_ranked_leaderboard_serving_seasons(p_observed_at timestamptz)
RETURNS TABLE (season_id text) LANGUAGE sql STABLE AS
  $$ SELECT served.season_id FROM arena.served_seasons AS served $$;

INSERT INTO arena.exchanges VALUES (1, 'bybit', 'Bybit'), (2, 'gate', 'Gate'), (3, 'okx', 'OKX');
INSERT INTO arena.sources VALUES
  (1, 'bybit_copytrade', 1, 'futures', 'active', 'serving', '{"legacy_platform": "bybit"}'),
  (2, 'gate_futures', 2, 'futures', 'active', 'serving', '{"legacy_platform": "gateio"}'),
  (3, 'gate_futures_b', 2, 'futures', 'active', 'serving', '{"legacy_platform": "gateio"}'),
  (4, 'okx_futures', 3, 'futures', 'active', 'serving', '{}'),
  (5, 'okx_spot', 3, 'spot', 'active', 'shadow', '{}'),
  (6, 'okx_old', 3, 'spot', 'retired', 'serving', '{}');
INSERT INTO arena.served_seasons VALUES ('90D'), ('7D');
INSERT INTO arena.public_ranked_leaderboard_serving_heads VALUES
  ('90D', '99999999-9999-4999-8999-999999999999'), ('7D', '77777777-7777-4777-8777-777777777777'), ('30D', '99999999-9999-4999-8999-999999999999');
INSERT INTO public.leaderboard_source_freshness VALUES
  ('90D', 'bybit', '2026-11-22 03:00+00', '2026-11-22 04:10+00', '99999999-9999-4999-8999-999999999999', 998),
  ('90D', 'gateio', '2026-11-22 03:00+00', '2026-11-22 04:10+00', '99999999-9999-4999-8999-999999999999', 44),
  -- sealed with zero rows
  ('90D', 'okx_futures', '2026-11-22 03:00+00', '2026-11-22 04:10+00', '99999999-9999-4999-8999-999999999999', 0),
  -- registry row is shadow / retired
  ('90D', 'okx_spot', '2026-11-22 03:00+00', '2026-11-22 04:10+00', '99999999-9999-4999-8999-999999999999', 3),
  ('90D', 'okx_old', '2026-11-22 03:00+00', '2026-11-22 04:10+00', '99999999-9999-4999-8999-999999999999', 3),
  ('7D', 'bybit', '2026-11-22 03:00+00', '2026-11-22 04:01+00', '77777777-7777-4777-8777-777777777777', 5),
  -- a proof left behind by an older cohort is not what is served
  ('7D', 'gateio', '2026-11-19 03:00+00', '2026-11-19 04:01+00', '11111111-1111-4111-8111-111111111111', 40),
  -- 30D has a head but is not being served
  ('30D', 'bybit', '2026-11-22 03:00+00', '2026-11-22 04:05+00', '99999999-9999-4999-8999-999999999999', 9);
SQL

psql_as postgres -q -f "$OLD_MIGRATION" >/dev/null
assert_equal "before: an empty count cache hides every served source" "0" \
  "$(psql_as anon -Atqc "SELECT count(*) FROM public.arena_visible_sources('90D')")"

BEFORE_SHAPE="$(psql_as postgres -Atqc "
  SELECT pg_get_function_result(p.oid) || '|' || pg_get_function_arguments(p.oid) || '|' ||
         pg_get_userbyid(p.proowner) || '|' || p.prosecdef || '|' || p.provolatile::text || '|' ||
         coalesce(array_to_string(p.proacl, ','), '')
    FROM pg_proc p WHERE p.oid = 'public.arena_visible_sources(text)'::regprocedure")"

psql_as postgres -q -f "$NEW_MIGRATION" >/dev/null

assert_equal "signature, owner, security and grants are unchanged" "$BEFORE_SHAPE" \
  "$(psql_as postgres -Atqc "
  SELECT pg_get_function_result(p.oid) || '|' || pg_get_function_arguments(p.oid) || '|' ||
         pg_get_userbyid(p.proowner) || '|' || p.prosecdef || '|' || p.provolatile::text || '|' ||
         coalesce(array_to_string(p.proacl, ','), '')
    FROM pg_proc p WHERE p.oid = 'public.arena_visible_sources(text)'::regprocedure")"

assert_equal "after: exactly the served serving sources, with served counts (anon)" \
  "bybit_copytrade:bybit:998:2026-11-22 04:10:00+00,gate_futures:gateio:44:2026-11-22 04:10:00+00,gate_futures_b:gateio:44:2026-11-22 04:10:00+00" \
  "$(psql_as anon -Atqc "SET timezone = 'UTC';
     SELECT string_agg(registry_slug || ':' || filter_source || ':' || trader_count || ':' ||
                       cache_updated_at, ',' ORDER BY registry_slug)
       FROM public.arena_visible_sources('90D')" | tail -1)"
assert_equal "the default season is 90D" "3" \
  "$(psql_as anon -Atqc "SELECT count(*) FROM public.arena_visible_sources()")"
assert_equal "each season counts its own ranks" "bybit_copytrade:5" \
  "$(psql_as anon -Atqc "SELECT string_agg(registry_slug || ':' || trader_count, ',')
       FROM public.arena_visible_sources('7D')")"
assert_equal "a season that is not being served lists nothing" "0" \
  "$(psql_as anon -Atqc "SELECT count(*) FROM public.arena_visible_sources('30D')")"
assert_equal "an unknown season lists nothing" "0" \
  "$(psql_as anon -Atqc "SELECT count(*) FROM public.arena_visible_sources('ALL')")"

# The count cache is no longer read: filling it changes nothing.
psql_as postgres -q -c "INSERT INTO public.leaderboard_count_cache VALUES
  ('90D', '_all_gt0', 1, now()), ('90D', 'okx_futures_gt0', 1, now())"
assert_equal "count-cache rows no longer make a source visible" "3" \
  "$(psql_as anon -Atqc "SELECT count(*) FROM public.arena_visible_sources('90D')")"

echo "visible sources from served ranks PostgreSQL 17 proof passed"
