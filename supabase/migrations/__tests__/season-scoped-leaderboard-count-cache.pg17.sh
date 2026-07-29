#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for the season-scoped count-cache refresh.
# It owns an isolated cluster and never connects to application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729220908_season_scoped_leaderboard_count_cache.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi
if [[ ! -f "$MIGRATION" ]]; then
  echo "Required migration not found: $MIGRATION" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/season-count-cache-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
LOCK_READY="$TMP_ROOT/legacy-lock-ready"
LOCK_OUTPUT="$TMP_ROOT/legacy-lock-output"
SCOPED_OUTPUT="$TMP_ROOT/scoped-lock-output"
PORT="${PGPORT_OVERRIDE:-$((57500 + ($$ % 1500)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)); then
    [[ -f "$LOCK_OUTPUT" ]] && cat "$LOCK_OUTPUT" >&2 || true
    [[ -f "$SCOPED_OUTPUT" ]] && cat "$SCOPED_OUTPUT" >&2 || true
    [[ -f "$LOG_FILE" ]] && tail -160 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_db() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

cache_fingerprint() {
  local predicate="$1"
  psql_db -Atqc "
    SELECT pg_catalog.md5(
      COALESCE(
        pg_catalog.string_agg(
          pg_catalog.to_jsonb(cache_row)::text,
          E'\\n' ORDER BY cache_row.season_id, cache_row.source
        ),
        ''
      )
    )
    FROM public.leaderboard_count_cache AS cache_row
    WHERE $predicate;"
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
CREATE ROLE unexpected_default_grantee NOLOGIN;

CREATE TABLE public.leaderboard_ranks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  season_id text NOT NULL,
  source text NOT NULL,
  arena_score numeric,
  is_outlier boolean
);

CREATE TABLE public.leaderboard_count_cache (
  season_id text NOT NULL,
  source text NOT NULL DEFAULT '_all',
  total_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (season_id, source)
);

-- This is the deployed legacy serialization contract checked by the new
-- migration. The proof later holds that exact lock in a concurrent session.
CREATE FUNCTION public.refresh_leaderboard_count_cache()
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
SET statement_timeout = '10s'
AS $function$
BEGIN
  LOCK TABLE public.leaderboard_count_cache IN SHARE ROW EXCLUSIVE MODE;
  DELETE FROM public.leaderboard_count_cache;
  INSERT INTO public.leaderboard_count_cache (
    season_id, source, total_count, updated_at
  )
  SELECT season_id, '_all', pg_catalog.count(*)::integer, pg_catalog.now()
  FROM public.leaderboard_ranks
  WHERE arena_score > 10 AND (is_outlier IS NULL OR is_outlier = false)
  GROUP BY season_id;
END
$function$;

-- Prove the migration closes grants inherited through default privileges, not
-- merely the three named application roles.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  GRANT EXECUTE ON FUNCTIONS TO unexpected_default_grantee;

INSERT INTO public.leaderboard_ranks (
  season_id, source, arena_score, is_outlier
) VALUES
  ('7D', 'alpha', 50, false),
  ('7D', 'alpha', 5, false),
  ('7D', 'beta', 11, NULL),
  ('7D', 'beta', 0, false),
  ('7D', 'gamma', 100, true),
  ('30D', 'delta', 15, false),
  ('90D', 'epsilon', 0, false);

INSERT INTO public.leaderboard_count_cache (
  season_id, source, total_count, updated_at
) VALUES
  ('7D', '_all', 999, '2001-01-01T00:00:00Z'),
  ('7D', 'orphan', 888, '2001-01-01T00:00:01Z'),
  ('30D', '_all', 3030, '2002-02-02T02:02:02Z'),
  ('30D', 'delta', 3031, '2002-02-02T02:02:03Z'),
  ('90D', '_all', 9090, '2003-03-03T03:03:03Z'),
  ('90D', 'legacy_extra', 9091, '2003-03-03T03:03:04Z');
SQL

psql_db -q -f "$MIGRATION"

acl_state="$(psql_db -Atqc "
  SELECT pg_catalog.concat_ws(
    '|',
    pg_catalog.has_function_privilege(
      'service_role',
      'public.refresh_leaderboard_count_cache_for_seasons(text[])',
      'EXECUTE'
    ),
    pg_catalog.has_function_privilege(
      'anon',
      'public.refresh_leaderboard_count_cache_for_seasons(text[])',
      'EXECUTE'
    ),
    pg_catalog.has_function_privilege(
      'authenticated',
      'public.refresh_leaderboard_count_cache_for_seasons(text[])',
      'EXECUTE'
    ),
    pg_catalog.has_function_privilege(
      'unexpected_default_grantee',
      'public.refresh_leaderboard_count_cache_for_seasons(text[])',
      'EXECUTE'
    )
  );")"
assert_equal "scoped refresh ACL drifted" "t|f|f|f" "$acl_state"

non_target_before="$(cache_fingerprint "cache_row.season_id <> '7D'")"
if ! psql_db -q <<'SQL'
SET ROLE service_role;
SELECT public.refresh_leaderboard_count_cache_for_seasons(ARRAY['7D']::text[]);
RESET ROLE;
SQL
then
  echo "service_role could not execute the scoped refresh" >&2
  exit 1
fi
non_target_after="$(cache_fingerprint "cache_row.season_id <> '7D'")"
assert_equal \
  "non-target cache rows changed during scoped refresh" \
  "$non_target_before" \
  "$non_target_after"

target_counts="$(psql_db -Atqc "
  SELECT pg_catalog.string_agg(
    cache_row.source || ':' || cache_row.total_count::text,
    ',' ORDER BY cache_row.source
  )
  FROM public.leaderboard_count_cache AS cache_row
  WHERE cache_row.season_id = '7D';")"
assert_equal \
  "scoped refresh did not rebuild the exact four count families" \
  "_all:2,_all_gt0:3,alpha:1,alpha_gt0:2,beta:1,beta_gt0:1" \
  "$target_counts"

target_timestamp_count="$(psql_db -Atqc "
  SELECT pg_catalog.count(DISTINCT cache_row.updated_at)
  FROM public.leaderboard_count_cache AS cache_row
  WHERE cache_row.season_id = '7D';")"
assert_equal "count families did not share one statement timestamp" "1" "$target_timestamp_count"

# Every malformed request must surface invalid_parameter_value (22023). Raising
# our own exception after a successful call makes accidental acceptance fatal.
psql_db -q <<'SQL'
DO $proof$
BEGIN
  BEGIN
    PERFORM public.refresh_leaderboard_count_cache_for_seasons(NULL::text[]);
    RAISE EXCEPTION 'invalid season input was accepted: NULL array';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM public.refresh_leaderboard_count_cache_for_seasons(ARRAY[]::text[]);
    RAISE EXCEPTION 'invalid season input was accepted: empty array';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM public.refresh_leaderboard_count_cache_for_seasons(
      ARRAY['7D', NULL]::text[]
    );
    RAISE EXCEPTION 'invalid season input was accepted: NULL element';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM public.refresh_leaderboard_count_cache_for_seasons(
      ARRAY['7d']::text[]
    );
    RAISE EXCEPTION 'invalid season input was accepted: non-canonical season';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    PERFORM public.refresh_leaderboard_count_cache_for_seasons(
      ARRAY['7D', '7D']::text[]
    );
    RAISE EXCEPTION 'invalid season input was accepted: duplicate season';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END
$proof$;
SQL

# A target with no qualifying rows is deleted cleanly, while a multi-season
# request rebuilds the other target and leaves the earlier 7D generation exact.
seven_day_before="$(cache_fingerprint "cache_row.season_id = '7D'")"
psql_db -q <<'SQL'
SET ROLE service_role;
SELECT public.refresh_leaderboard_count_cache_for_seasons(
  ARRAY['90D', '30D']::text[]
);
RESET ROLE;
SQL
seven_day_after="$(cache_fingerprint "cache_row.season_id = '7D'")"
assert_equal "multi-season refresh changed a non-target season" "$seven_day_before" "$seven_day_after"

multi_target_state="$(psql_db -Atqc "
  SELECT pg_catalog.concat_ws(
    '|',
    (
      SELECT pg_catalog.string_agg(
        cache_row.source || ':' || cache_row.total_count::text,
        ',' ORDER BY cache_row.source
      )
      FROM public.leaderboard_count_cache AS cache_row
      WHERE cache_row.season_id = '30D'
    ),
    (
      SELECT pg_catalog.count(*)
      FROM public.leaderboard_count_cache AS cache_row
      WHERE cache_row.season_id = '90D'
    )
  );")"
assert_equal \
  "multi-season scoped rebuild drifted" \
  "_all:1,_all_gt0:1,delta:1,delta_gt0:1|0" \
  "$multi_target_state"

# Hold the exact self-conflicting lock used by the legacy full refresh. The
# scoped call must time out rather than entering its delete/insert generation.
(
  psql_db -q <<SQL
BEGIN;
LOCK TABLE public.leaderboard_count_cache IN SHARE ROW EXCLUSIVE MODE;
\! touch "$LOCK_READY"
SELECT pg_catalog.pg_sleep(1.5);
COMMIT;
SQL
) >"$LOCK_OUTPUT" 2>&1 &
legacy_lock_pid=$!

for _ in {1..100}; do
  [[ -f "$LOCK_READY" ]] && break
  if ! kill -0 "$legacy_lock_pid" 2>/dev/null; then
    echo "legacy full-refresh lock proof session exited early" >&2
    wait "$legacy_lock_pid"
    exit 1
  fi
  sleep 0.02
done
if [[ ! -f "$LOCK_READY" ]]; then
  echo "legacy full-refresh lock proof did not become ready" >&2
  exit 1
fi

if psql_db -q >"$SCOPED_OUTPUT" 2>&1 <<'SQL'
SET lock_timeout = '150ms';
SET ROLE service_role;
SELECT public.refresh_leaderboard_count_cache_for_seasons(ARRAY['7D']::text[]);
SQL
then
  echo "scoped refresh did not serialize on the legacy full-refresh lock" >&2
  exit 1
fi
if ! rg -q "lock timeout|canceling statement due to lock timeout" "$SCOPED_OUTPUT"; then
  echo "scoped refresh failed for a reason other than the legacy lock" >&2
  cat "$SCOPED_OUTPUT" >&2
  exit 1
fi
wait "$legacy_lock_pid"

echo "season-scoped leaderboard count-cache PG17 proof passed"
