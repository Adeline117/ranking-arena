#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for cohort-bound public platform statistics,
# exact source authority, eligibility filters, ACLs, and migration replay.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729065500_public_platform_stats_authority.sql"
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

TMP_ROOT="$(mktemp -d /tmp/public-platform-stats-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
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

expect_rejected() {
  local label="$1"
  local statement="$2"
  if psql_cmd -q -c "$statement" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
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
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;

CREATE TABLE public.leaderboard_ranks (
  season_id text NOT NULL,
  source text NOT NULL,
  rank_publication_id uuid,
  arena_score numeric,
  roi numeric,
  win_rate numeric,
  is_outlier boolean
);

REVOKE ALL ON TABLE public.leaderboard_ranks
  FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT ON TABLE public.leaderboard_ranks TO service_role;
SQL

# CREATE OR REPLACE plus explicit REVOKE/GRANT must be replay-safe.
psql_cmd -q -f "$MIGRATION"
FIRST_DEFINITION="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.md5(
      pg_catalog.pg_get_functiondef(
        'public.get_public_platform_stats(text,uuid,text[])'::pg_catalog.regprocedure
      )
      || COALESCE(procedure.proacl::text, '')
    )
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid =
      'public.get_public_platform_stats(text,uuid,text[])'::pg_catalog.regprocedure;
  "
)"
psql_cmd -q -f "$MIGRATION"
REPLAY_DEFINITION="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.md5(
      pg_catalog.pg_get_functiondef(
        'public.get_public_platform_stats(text,uuid,text[])'::pg_catalog.regprocedure
      )
      || COALESCE(procedure.proacl::text, '')
    )
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid =
      'public.get_public_platform_stats(text,uuid,text[])'::pg_catalog.regprocedure;
  "
)"
if [[ -z "$FIRST_DEFINITION" || "$FIRST_DEFINITION" != "$REPLAY_DEFINITION" ]]; then
  echo "migration replay changed the function definition or ACL" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
INSERT INTO public.leaderboard_ranks (
  season_id,
  source,
  rank_publication_id,
  arena_score,
  roi,
  win_rate,
  is_outlier
) VALUES
  ('90D', 'bybit',       '11111111-1111-4111-8111-111111111111', 60, 10, 40, false),
  ('90D', 'bybit',       '11111111-1111-4111-8111-111111111111', 80, 30, 60, NULL),
  ('90D', 'hyperliquid', '11111111-1111-4111-8111-111111111111', 90, 50, 70, false),
  ('90D', 'mexc',        '11111111-1111-4111-8111-111111111111', 99, 99, 99, false),
  ('90D', 'bybit',       '22222222-2222-4222-8222-222222222222', 100, 100, 100, false),
  ('90D', 'bybit',       '11111111-1111-4111-8111-111111111111', 95, 95, 95, true),
  ('90D', 'bybit',       '11111111-1111-4111-8111-111111111111', 0, 500, 100, false),
  ('30D', 'bybit',       '11111111-1111-4111-8111-111111111111', 100, 100, 100, false);
SQL

ALL_ALLOWED="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.string_agg(
      platform || ':' || trader_count::text || ':' || avg_score::text || ':'
        || avg_roi::text || ':' || median_score::text || ':'
        || COALESCE(avg_win_rate::text, 'null'),
      ',' ORDER BY platform
    )
    FROM public.get_public_platform_stats(
      '90D',
      '11111111-1111-4111-8111-111111111111',
      ARRAY['bybit', 'hyperliquid']
    );
  "
)"
if [[ "$ALL_ALLOWED" != "bybit:2:70.00:20.00:70.00:50.00,hyperliquid:1:90.00:50.00:90.00:70.00" ]]; then
  echo "cohort/source/eligibility-bound aggregate drifted: $ALL_ALLOWED" >&2
  exit 1
fi

BYBIT_ONLY="$(
  psql_cmd -Atqc "
    SELECT platform || ':' || trader_count::text || ':' || avg_score::text
    FROM public.get_public_platform_stats(
      '90D',
      '11111111-1111-4111-8111-111111111111',
      ARRAY['bybit']
    );
  "
)"
if [[ "$BYBIT_ONLY" != "bybit:2:70.00" ]]; then
  echo "single-source aggregation included an old cohort, outer source, or outlier: $BYBIT_ONLY" >&2
  exit 1
fi

expect_rejected "empty allowed source scope" "
  SELECT * FROM public.get_public_platform_stats(
    '90D',
    '11111111-1111-4111-8111-111111111111',
    ARRAY[]::text[]
  );
"
expect_rejected "duplicate allowed source scope" "
  SELECT * FROM public.get_public_platform_stats(
    '90D',
    '11111111-1111-4111-8111-111111111111',
    ARRAY['bybit', 'bybit']
  );
"
expect_rejected "malformed allowed source scope" "
  SELECT * FROM public.get_public_platform_stats(
    '90D',
    '11111111-1111-4111-8111-111111111111',
    ARRAY['BYBIT']
  );
"
expect_rejected "missing cohort" "
  SELECT * FROM public.get_public_platform_stats(
    '90D',
    NULL,
    ARRAY['bybit']
  );
"

psql_cmd -q <<'SQL'
DO $acl$
BEGIN
  IF pg_catalog.has_function_privilege(
    'anon',
    'public.get_public_platform_stats(text,uuid,text[])',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'anon retained platform stats execution';
  END IF;
  IF pg_catalog.has_function_privilege(
    'authenticated',
    'public.get_public_platform_stats(text,uuid,text[])',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated retained platform stats execution';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.get_public_platform_stats(text,uuid,text[])',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'service_role lacks platform stats execution';
  END IF;
END
$acl$;
SQL

expect_rejected "anon execution" "
  SET ROLE anon;
  SELECT * FROM public.get_public_platform_stats(
    '90D',
    '11111111-1111-4111-8111-111111111111',
    ARRAY['bybit']
  );
"
expect_rejected "authenticated execution" "
  SET ROLE authenticated;
  SELECT * FROM public.get_public_platform_stats(
    '90D',
    '11111111-1111-4111-8111-111111111111',
    ARRAY['bybit']
  );
"

SERVICE_RESULT="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT platform || ':' || trader_count::text
    FROM public.get_public_platform_stats(
      '90D',
      '11111111-1111-4111-8111-111111111111',
      ARRAY['hyperliquid']
    );
  "
)"
if [[ "$SERVICE_RESULT" != "hyperliquid:1" ]]; then
  echo "service_role could not execute the exact authority RPC: $SERVICE_RESULT" >&2
  exit 1
fi

echo "public platform statistics PostgreSQL 17 proof passed"
