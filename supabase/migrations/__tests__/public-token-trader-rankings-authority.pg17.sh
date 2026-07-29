#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for exact public-source token ranking scope,
# filtered totals, deterministic pagination, parameter rejection, and ACLs.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729064000_public_token_trader_rankings_authority.sql"
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

TMP_ROOT="$(mktemp -d /tmp/public-token-rankings-pg17.XXXXXX)"
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

expect_rejected() {
  local label="$1"
  local statement="$2"
  if psql_cmd -q -c "$statement" >/dev/null 2>&1; then
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
CREATE ROLE service_role NOLOGIN;

CREATE TABLE public.token_trader_daily_fixture (
  trade_date date NOT NULL,
  token character varying NOT NULL,
  source character varying NOT NULL,
  source_trader_id character varying NOT NULL,
  trade_count bigint NOT NULL,
  win_count bigint NOT NULL,
  token_pnl numeric NOT NULL,
  pnl_pct_sum numeric,
  pnl_pct_count bigint NOT NULL
);

CREATE MATERIALIZED VIEW public.mv_token_trader_daily_90d AS
SELECT
  trade_date,
  token,
  source,
  source_trader_id,
  trade_count,
  win_count,
  token_pnl,
  pnl_pct_sum,
  pnl_pct_count
FROM public.token_trader_daily_fixture;

GRANT SELECT ON public.mv_token_trader_daily_90d TO service_role;
SQL

psql_cmd -q -f "$MIGRATION"

psql_cmd -q <<'SQL'
INSERT INTO public.token_trader_daily_fixture (
  trade_date,
  token,
  source,
  source_trader_id,
  trade_count,
  win_count,
  token_pnl,
  pnl_pct_sum,
  pnl_pct_count
) VALUES
  (CURRENT_DATE, 'BTC', 'binance_futures', 'binance-best', 2, 2, 100, 20, 2),
  (CURRENT_DATE, 'BTC', 'binance_futures', 'binance-tie', 1, 1, 50, 5, 1),
  (CURRENT_DATE, 'BTC', 'bybit', 'bybit-tie', 1, 0, 50, -5, 1),
  (CURRENT_DATE, 'BTC', 'okx_web3_solana', 'quarantined', 1, 1, 1000, 100, 1),
  (CURRENT_DATE, 'BTC', 'binance', 'legacy-alias', 1, 1, 900, 90, 1),
  (CURRENT_DATE - 8, 'BTC', 'bybit', 'outside-7d', 1, 1, 800, 80, 1),
  (CURRENT_DATE, 'ETH', 'bybit', 'other-token', 1, 1, 700, 70, 1);

REFRESH MATERIALIZED VIEW public.mv_token_trader_daily_90d;
SQL

FIRST_PAGE="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.string_agg(
      source || ':' || source_trader_id || ':' || token_pnl || ':' || total_count,
      ',' ORDER BY ordinal
    )
    FROM (
      SELECT *, pg_catalog.row_number() OVER () AS ordinal
      FROM public.get_public_token_trader_rankings(
        'BTC',
        7,
        2,
        0,
        ARRAY['binance_futures', 'bybit']
      )
    ) AS page;
  "
)"
if [[ "$FIRST_PAGE" != "binance_futures:binance-best:100.00:3,binance_futures:binance-tie:50.00:3" ]]; then
  echo "first page escaped source scope, miscounted, or ordered ties incorrectly: $FIRST_PAGE" >&2
  exit 1
fi

SECOND_PAGE="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.string_agg(
      source || ':' || source_trader_id || ':' || token_pnl || ':' || total_count,
      ',' ORDER BY ordinal
    )
    FROM (
      SELECT *, pg_catalog.row_number() OVER () AS ordinal
      FROM public.get_public_token_trader_rankings(
        'BTC',
        7,
        2,
        1,
        ARRAY['binance_futures', 'bybit']
      )
    ) AS page;
  "
)"
if [[ "$SECOND_PAGE" != "binance_futures:binance-tie:50.00:3,bybit:bybit-tie:50.00:3" ]]; then
  echo "offset page is not deterministic across equal PnL rows: $SECOND_PAGE" >&2
  exit 1
fi

BYBIT_ONLY="$(
  psql_cmd -Atqc "
    SELECT source || ':' || source_trader_id || ':' || total_count
    FROM public.get_public_token_trader_rankings(
      'BTC',
      7,
      200,
      0,
      ARRAY['bybit']
    );
  "
)"
if [[ "$BYBIT_ONLY" != "bybit:bybit-tie:1" ]]; then
  echo "total_count was computed before allowed_sources filtering: $BYBIT_ONLY" >&2
  exit 1
fi

expect_rejected "empty allowed_sources" "
  SELECT * FROM public.get_public_token_trader_rankings(
    'BTC', 7, 50, 0, ARRAY[]::text[]
  );
"
expect_rejected "duplicate allowed_sources" "
  SELECT * FROM public.get_public_token_trader_rankings(
    'BTC', 7, 50, 0, ARRAY['bybit', 'bybit']
  );
"
expect_rejected "malformed allowed_sources" "
  SELECT * FROM public.get_public_token_trader_rankings(
    'BTC', 7, 50, 0, ARRAY['BYBIT']
  );
"
expect_rejected "oversized allowed_sources" "
  SELECT * FROM public.get_public_token_trader_rankings(
    'BTC',
    7,
    50,
    0,
    ARRAY(
      SELECT 'source_' || value::text
      FROM pg_catalog.generate_series(1, 257) AS value
    )
  );
"
expect_rejected "non-canonical token" "
  SELECT * FROM public.get_public_token_trader_rankings(
    'btc', 7, 50, 0, ARRAY['bybit']
  );
"
expect_rejected "numeric-only token" "
  SELECT * FROM public.get_public_token_trader_rankings(
    '1000', 7, 50, 0, ARRAY['bybit']
  );
"
expect_rejected "unbounded lookback" "
  SELECT * FROM public.get_public_token_trader_rankings(
    'BTC', 91, 50, 0, ARRAY['bybit']
  );
"
expect_rejected "unbounded page size" "
  SELECT * FROM public.get_public_token_trader_rankings(
    'BTC', 7, 201, 0, ARRAY['bybit']
  );
"
expect_rejected "negative offset" "
  SELECT * FROM public.get_public_token_trader_rankings(
    'BTC', 7, 50, -1, ARRAY['bybit']
  );
"

expect_rejected "anon execution" "
  SET ROLE anon;
  SELECT * FROM public.get_public_token_trader_rankings(
    'BTC', 7, 50, 0, ARRAY['bybit']
  );
"
expect_rejected "authenticated execution" "
  SET ROLE authenticated;
  SELECT * FROM public.get_public_token_trader_rankings(
    'BTC', 7, 50, 0, ARRAY['bybit']
  );
"

SERVICE_RESULT="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT source || ':' || source_trader_id
    FROM public.get_public_token_trader_rankings(
      'BTC', 7, 50, 0, ARRAY['bybit']
    );
  "
)"
if [[ "$SERVICE_RESULT" != "bybit:bybit-tie" ]]; then
  echo "service_role could not execute the exact allowlist RPC: $SERVICE_RESULT" >&2
  exit 1
fi

echo "public token trader ranking PostgreSQL 17 proof passed"
