#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for rank-authoritative `_gt0` count generations.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729224000_rank_eligible_leaderboard_count_cache.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  [[ -x "$PG_BIN/$executable" ]] || {
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  }
done
[[ "$($PG_BIN/psql --version)" == psql\ \(PostgreSQL\)\ 17.* ]] || {
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
}

TMP_ROOT="$(mktemp -d /tmp/rank-count-cache-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((60000 + ($$ % 3000)))}"
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

psql_db() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

assert_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "$label: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

psql_db -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE rogue_default_grantee NOLOGIN;
CREATE ROLE rogue_delegate NOLOGIN;
ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO rogue_default_grantee;

CREATE TABLE public.leaderboard_ranks (
  id bigint PRIMARY KEY,
  season_id text NOT NULL,
  source text NOT NULL,
  arena_score numeric,
  is_outlier boolean,
  rank integer
);

CREATE TABLE public.leaderboard_count_cache (
  season_id text NOT NULL,
  source text NOT NULL,
  total_count integer NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (season_id, source)
);

CREATE TABLE public.fixture_rerank_calls (
  season_id text PRIMARY KEY
);

CREATE FUNCTION public.rerank_public_eligible_leaderboard(p_season_id text)
RETURNS integer
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO public.fixture_rerank_calls (season_id) VALUES (p_season_id);
  RETURN 0;
END
$function$;

CREATE FUNCTION public.rerank_leaderboard(text)
RETURNS integer LANGUAGE sql AS 'SELECT -1';

GRANT EXECUTE ON FUNCTION public.rerank_leaderboard(text)
  TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rerank_leaderboard(text)
  TO rogue_default_grantee WITH GRANT OPTION;
SET ROLE rogue_default_grantee;
GRANT EXECUTE ON FUNCTION public.rerank_leaderboard(text)
  TO rogue_delegate;
RESET ROLE;

CREATE FUNCTION public.refresh_leaderboard_count_cache()
RETURNS void LANGUAGE plpgsql AS 'BEGIN NULL; END';

CREATE FUNCTION public.refresh_leaderboard_count_cache_for_seasons(text[])
RETURNS void LANGUAGE plpgsql AS 'BEGIN NULL; END';

GRANT EXECUTE ON FUNCTION public.refresh_leaderboard_count_cache()
  TO rogue_default_grantee WITH GRANT OPTION;
GRANT EXECUTE ON FUNCTION public.refresh_leaderboard_count_cache_for_seasons(text[])
  TO rogue_default_grantee WITH GRANT OPTION;
SET ROLE rogue_default_grantee;
GRANT EXECUTE ON FUNCTION public.refresh_leaderboard_count_cache()
  TO rogue_delegate;
GRANT EXECUTE ON FUNCTION public.refresh_leaderboard_count_cache_for_seasons(text[])
  TO rogue_delegate;
RESET ROLE;

INSERT INTO public.leaderboard_ranks (
  id, season_id, source, arena_score, is_outlier, rank
) VALUES
  (1, '7D', 'alpha', 90, false, 1),
  (2, '7D', 'alpha', 80, false, NULL),
  (3, '7D', 'beta', 5, false, 2),
  (4, '7D', 'gamma', 20, false, NULL),
  (5, '7D', 'alpha', 50, true, 3),
  (6, '30D', 'alpha', 70, false, 1);

INSERT INTO public.leaderboard_count_cache (
  season_id, source, total_count, updated_at
) VALUES
  ('7D', '_all_gt0', 999, '2026-01-01T00:00:00Z'),
  ('365D', '_all_gt0', 44, '2026-01-01T00:00:00Z');
SQL

psql_db -q -f "$MIGRATION"

RERANKED="$(psql_db -Atqc "
  SELECT pg_catalog.string_agg(season_id, ',' ORDER BY season_id)
  FROM public.fixture_rerank_calls;")"
assert_equal "all-season rerank precedes count repair" "30D,7D,90D" "$RERANKED"

COUNTS="$(psql_db -Atqc "
  SELECT pg_catalog.string_agg(
    cache.season_id || ':' || cache.source || ':' || cache.total_count,
    ',' ORDER BY cache.season_id, cache.source
  )
  FROM public.leaderboard_count_cache AS cache;")"
assert_equal \
  "rank-authoritative count generations" \
  "30D:_all:1,30D:_all_gt0:1,30D:alpha:1,30D:alpha_gt0:1,365D:_all_gt0:44,7D:_all:3,7D:_all_gt0:2,7D:alpha:2,7D:alpha_gt0:1,7D:beta_gt0:1,7D:gamma:1" \
  "$COUNTS"

psql_db -q <<'SQL'
DO $invalid$
BEGIN
  BEGIN
    PERFORM public.refresh_public_rank_count_cache_for_seasons(ARRAY['7D', '7D']::text[]);
    RAISE EXCEPTION 'duplicate season unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM public.refresh_public_rank_count_cache_for_seasons(ARRAY['365D']::text[]);
    RAISE EXCEPTION 'invalid season unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END
$invalid$;
SQL

ACL="$(psql_db -Atqc "
  SELECT pg_catalog.count(*)
  FROM pg_catalog.pg_proc AS function_row
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(
      function_row.proacl,
      pg_catalog.acldefault('f', function_row.proowner)
    )
  ) AS privilege
  WHERE function_row.oid = ANY (
    ARRAY[
      'public.refresh_public_rank_count_cache_for_seasons(text[])'::pg_catalog.regprocedure::oid,
      'public.refresh_leaderboard_count_cache_for_seasons(text[])'::pg_catalog.regprocedure::oid,
      'public.refresh_leaderboard_count_cache()'::pg_catalog.regprocedure::oid,
      'public.rerank_leaderboard(text)'::pg_catalog.regprocedure::oid
    ]
  )
    AND privilege.privilege_type = 'EXECUTE'
    AND privilege.grantee <> ALL (
      ARRAY[
        function_row.proowner,
        'service_role'::pg_catalog.regrole::oid
      ]
    );")"
assert_equal "no rogue count-cache execute grants" "0" "$ACL"

LEGACY_CUTOVER="$(psql_db -Atqc "
  SELECT
    (function_row.prosrc LIKE '%RETURN public.rerank_public_eligible_leaderboard(p_season_id)%') || '|' ||
    pg_catalog.has_function_privilege('service_role', function_row.oid, 'EXECUTE') || '|' ||
    pg_catalog.has_function_privilege('anon', function_row.oid, 'EXECUTE') || '|' ||
    pg_catalog.has_function_privilege('authenticated', function_row.oid, 'EXECUTE') || '|' ||
    pg_catalog.has_function_privilege('rogue_default_grantee', function_row.oid, 'EXECUTE') || '|' ||
    pg_catalog.has_function_privilege('rogue_delegate', function_row.oid, 'EXECUTE')
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = 'public.rerank_leaderboard(text)'::pg_catalog.regprocedure;")"
assert_equal "legacy rerank cut over and hardened with counts" "true|true|false|false|false|false" "$LEGACY_CUTOVER"

psql_db -q -c "
  UPDATE public.leaderboard_ranks
  SET rank = NULL
  WHERE id = 1;"
psql_db -q -c "
  SELECT public.refresh_leaderboard_count_cache_for_seasons(ARRAY['7D']::text[]);"

SCOPED="$(psql_db -Atqc "
  SELECT
    (SELECT total_count FROM public.leaderboard_count_cache
      WHERE season_id = '7D' AND source = '_all_gt0') || '|' ||
    (SELECT total_count FROM public.leaderboard_count_cache
      WHERE season_id = '30D' AND source = '_all_gt0');")"
assert_equal "legacy scoped wrapper uses rank authority" "1|1" "$SCOPED"

echo "rank-authoritative leaderboard count cache PostgreSQL 17 proof passed"
