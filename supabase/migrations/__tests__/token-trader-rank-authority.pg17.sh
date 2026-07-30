#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for deterministic token-PnL rank pagination.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729225000_token_trader_rank_authority.sql"
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

TMP_ROOT="$(mktemp -d /tmp/token-trader-rank-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((57000 + ($$ % 5000)))}"
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
CREATE ROLE outsider NOLOGIN;

CREATE TABLE public.mv_token_trader_daily_90d (
  trade_date date NOT NULL,
  token text NOT NULL,
  source text NOT NULL,
  source_trader_id text NOT NULL,
  token_pnl numeric NOT NULL,
  trade_count bigint NOT NULL,
  win_count bigint NOT NULL,
  pnl_pct_sum numeric,
  pnl_pct_count bigint NOT NULL
);

CREATE FUNCTION public.get_token_trader_rankings(
  token_symbol text,
  lookback_days integer DEFAULT 90,
  max_traders integer DEFAULT 50,
  row_offset integer DEFAULT 0
)
RETURNS TABLE(
  source text,
  source_trader_id text,
  token_pnl numeric,
  token_trade_count bigint,
  token_win_rate numeric,
  token_avg_pnl_pct numeric,
  total_count bigint
)
LANGUAGE sql
AS 'SELECT NULL::text, NULL::text, NULL::numeric, NULL::bigint, NULL::numeric, NULL::numeric, 0::bigint WHERE false';

GRANT EXECUTE ON FUNCTION public.get_token_trader_rankings(
  text, integer, integer, integer
) TO PUBLIC, anon, authenticated, outsider;

INSERT INTO public.mv_token_trader_daily_90d (
  trade_date,
  token,
  source,
  source_trader_id,
  token_pnl,
  trade_count,
  win_count,
  pnl_pct_sum,
  pnl_pct_count
) VALUES
  (CURRENT_DATE, 'BTC', 'z-source', 'trader-z', 100, 2, 1, 5, 2),
  (CURRENT_DATE, 'BTC', 'a-source', 'trader-b', 100, 4, 3, 8, 4),
  (CURRENT_DATE, 'BTC', 'a-source', 'trader-a', 100, 1, 1, 3, 1),
  (CURRENT_DATE, 'BTC', 'c-source', 'trader-c', 50, 5, 2, NULL, 0),
  (CURRENT_DATE, 'ETH', 'a-source', 'eth-trader', 999, 1, 1, 9, 1),
  (CURRENT_DATE - 30, 'BTC', 'old-source', 'old-trader', 999, 1, 1, 9, 1);
SQL

psql_db -q -f "$MIGRATION"

PAGE_ONE="$(psql_db -Atqc "
  SELECT pg_catalog.string_agg(
    token_rank || ':' || source || ':' || source_trader_id || ':' || token_pnl || ':' || total_count,
    ',' ORDER BY token_rank
  )
  FROM public.get_token_trader_rankings('btc', 7, 2, 0);")"
assert_equal \
  "first deterministic page" \
  "1:a-source:trader-a:100.00:4,2:a-source:trader-b:100.00:4" \
  "$PAGE_ONE"

PAGE_TWO="$(psql_db -Atqc "
  SELECT pg_catalog.string_agg(
    token_rank || ':' || source || ':' || source_trader_id || ':' || token_pnl || ':' || total_count,
    ',' ORDER BY token_rank
  )
  FROM public.get_token_trader_rankings('BTC', 7, 2, 2);")"
assert_equal \
  "second deterministic page" \
  "3:z-source:trader-z:100.00:4,4:c-source:trader-c:50.00:4" \
  "$PAGE_TWO"

ACL="$(psql_db -Atqc "
  SELECT
    pg_catalog.has_function_privilege('service_role', function_row.oid, 'EXECUTE') || '|' ||
    pg_catalog.has_function_privilege('anon', function_row.oid, 'EXECUTE') || '|' ||
    pg_catalog.has_function_privilege('authenticated', function_row.oid, 'EXECUTE') || '|' ||
    pg_catalog.has_function_privilege('outsider', function_row.oid, 'EXECUTE') || '|' ||
    (function_row.proconfig = ARRAY['search_path=pg_catalog, pg_temp'])
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = 'public.get_token_trader_rankings(text,integer,integer,integer)'::pg_catalog.regprocedure;")"
assert_equal "private RPC ACL and search_path" "true|false|false|false|true" "$ACL"

RESULT_CONTRACT="$(psql_db -Atqc "
  SELECT pg_catalog.pg_get_function_result(function_row.oid)
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = 'public.get_token_trader_rankings(text,integer,integer,integer)'::pg_catalog.regprocedure;")"
assert_equal \
  "token rank return contract" \
  "TABLE(source text, source_trader_id text, token_rank bigint, token_pnl numeric, token_trade_count bigint, token_win_rate numeric, token_avg_pnl_pct numeric, total_count bigint)" \
  "$RESULT_CONTRACT"

# Replaying the migration must preserve both behavior and the private ACL.
psql_db -q -f "$MIGRATION"
REPLAY_COUNT="$(psql_db -Atqc "
  SELECT pg_catalog.count(*)
  FROM public.get_token_trader_rankings('BTC', 7, 200, 0);")"
assert_equal "idempotent replay" "4" "$REPLAY_COUNT"

echo "token trader rank authority PostgreSQL 17 proof passed"
