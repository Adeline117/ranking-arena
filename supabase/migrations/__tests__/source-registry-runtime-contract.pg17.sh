#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729058000_source_registry_runtime_contract.sql"
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

TMP_ROOT="$(mktemp -d /tmp/source-registry-contract-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((56500 + ($$ % 8000)))}"
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

expect_sql_failure() {
  local label="$1"
  local expected="$2"
  local sql="$3"
  if psql_cmd -q -c "$sql" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if [[ "$(<"$ERROR_FILE")" != *"$expected"* ]]; then
    echo "$label failed for the wrong reason; expected: $expected" >&2
    cat "$ERROR_FILE" >&2
    exit 1
  fi
}

expect_migration_failure() {
  local label="$1"
  local expected="$2"
  if psql_cmd -q -f "$MIGRATION" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if [[ "$(<"$ERROR_FILE")" != *"$expected"* ]]; then
    echo "$label failed for the wrong reason; expected: $expected" >&2
    cat "$ERROR_FILE" >&2
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
CREATE SCHEMA arena;

CREATE TABLE arena.exchanges (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL
);

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  exchange_id smallint NOT NULL REFERENCES arena.exchanges(id) ON DELETE CASCADE,
  product_type text NOT NULL CHECK (product_type IN ('spot', 'futures', 'cfd', 'onchain')),
  trader_kind_scope text NOT NULL CHECK (trader_kind_scope IN ('human', 'bot', 'mixed')),
  adapter_slug text NOT NULL,
  timeframes_native integer[] NOT NULL,
  timeframes_derived integer[] NOT NULL,
  expected_count integer,
  deep_profile_topn integer NOT NULL DEFAULT 300,
  currency text NOT NULL CHECK (currency IN ('USDT', 'USDx', 'USDC', 'USD')),
  page_size integer,
  pagination_kind text CHECK (
    pagination_kind IS NULL
    OR pagination_kind IN ('numeric', 'next_prev', 'infinite_scroll', 'api_cursor')
  ),
  cadence_tier_a interval NOT NULL DEFAULT interval '5 hours',
  fetch_region text NOT NULL CHECK (fetch_region IN ('local', 'vps_sg', 'vps_jp')),
  rate_budget_ms integer NOT NULL DEFAULT 2500,
  serving_mode text NOT NULL CHECK (serving_mode IN ('legacy', 'shadow', 'serving')),
  status text NOT NULL CHECK (
    status IN ('active', 'inactive', 'blocked_pending_vps', 'dropped')
  ),
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO arena.exchanges (id, slug) VALUES
  (1, 'bitfinex'),
  (2, 'bitmart'),
  (3, 'hyperliquid'),
  (4, 'kucoin'),
  (5, 'okx'),
  (6, 'toobit');

INSERT INTO arena.sources (
  id,
  slug,
  exchange_id,
  product_type,
  trader_kind_scope,
  adapter_slug,
  timeframes_native,
  timeframes_derived,
  expected_count,
  deep_profile_topn,
  currency,
  page_size,
  pagination_kind,
  cadence_tier_a,
  fetch_region,
  rate_budget_ms,
  serving_mode,
  status,
  meta
) VALUES
  (
    1, 'bitfinex', 1, 'futures', 'human', 'bitfinex',
    ARRAY[7, 30, 90], ARRAY[]::integer[], NULL, 300, 'USDT', NULL,
    'api_cursor', interval '5 hours', 'local', 2500, 'legacy', 'active',
    '{"api_only":true}'
  ),
  (
    2, 'bitmart_futures', 2, 'futures', 'mixed', 'bitmart',
    ARRAY[90], ARRAY[]::integer[], 58, 300, 'USDT', NULL,
    'infinite_scroll', interval '5 hours', 'local', 2500, 'shadow', 'active',
    '{"weekly_arena_surface":true}'
  ),
  (
    3, 'hyperliquid', 3, 'onchain', 'human', 'hyperliquid',
    ARRAY[7, 30], ARRAY[90], 382000, 300, 'USDC', NULL,
    'api_cursor', interval '5 hours', 'local', 2500, 'serving', 'active',
    '{"api_only":true}'
  ),
  (
    4, 'kucoin_futures', 4, 'futures', 'mixed', 'kucoin',
    ARRAY[7, 30, 90], ARRAY[]::integer[], 120, 300, 'USDT', 12,
    'numeric', interval '5 hours', 'local', 2500, 'legacy', 'active',
    '{"tradepilot_badge_is_bot":true}'
  ),
  (
    5, 'okx_futures', 5, 'futures', 'human', 'okx',
    ARRAY[7, 30, 90], ARRAY[]::integer[], NULL, 300, 'USDT', NULL,
    NULL, interval '5 hours', 'vps_sg', 2500, 'shadow', 'active', '{}'
  ),
  (
    6, 'okx_spot', 5, 'spot', 'human', 'okx',
    ARRAY[7, 30, 90], ARRAY[]::integer[], NULL, 300, 'USDT', NULL,
    NULL, interval '5 hours', 'vps_sg', 2500, 'serving', 'active', '{}'
  ),
  (
    7, 'toobit_futures', 6, 'futures', 'human', 'toobit',
    ARRAY[7, 30, 90], ARRAY[]::integer[], NULL, 300, 'USDT', NULL,
    NULL, interval '5 hours', 'vps_sg', 2500, 'legacy', 'active', '{}'
  );

CREATE TABLE public.expected_serving_state AS
SELECT id, status, serving_mode
FROM arena.sources;
SQL

psql_cmd -q -f "$MIGRATION"

psql_cmd -q <<'SQL'
DO $assert$
DECLARE
  v_exact integer;
  v_state_drift integer;
  v_constraint integer;
BEGIN
  SELECT pg_catalog.count(*)::integer
  INTO v_exact
  FROM arena.sources AS source
  WHERE
    (
      source.slug = 'bitfinex'
      AND source.currency = 'USD'
      AND source.fetch_region = 'local'
      AND source.timeframes_native = ARRAY[7, 30]::integer[]
      AND source.timeframes_derived = ARRAY[]::integer[]
    )
    OR (
      source.slug = 'bitmart_futures'
      AND source.fetch_region = 'vps_sg'
      AND source.page_size = 20
      AND source.pagination_kind = 'numeric'
      AND source.timeframes_native = ARRAY[7, 30]::integer[]
      AND source.timeframes_derived = ARRAY[90]::integer[]
      AND source.meta->>'derived_board_sort' = 'roi'
      AND source.meta->>'derived_stats_max_age_hours' = '168'
    )
    OR (
      source.slug = 'hyperliquid'
      AND source.expected_count = 10000
      AND source.page_size = 5000
      AND source.rate_budget_ms = 1100
      AND source.cadence_tier_a = interval '6 hours'
      AND source.deep_profile_topn = 500
      AND source.timeframes_native = ARRAY[7, 30]::integer[]
      AND source.timeframes_derived = ARRAY[90]::integer[]
      AND source.meta->>'board_depth' = '10000'
      AND source.meta->>'derived_board_sort' = 'pnl'
    )
    OR (
      source.slug = 'kucoin_futures'
      AND source.timeframes_native = ARRAY[30]::integer[]
      AND source.timeframes_derived = ARRAY[7, 90]::integer[]
      AND source.meta->>'derived_board_sort' = 'roi'
    )
    OR (
      source.slug = 'okx_futures'
      AND source.fetch_region = 'vps_sg'
      AND source.page_size = 20
      AND source.pagination_kind = 'numeric'
      AND source.timeframes_native = ARRAY[90]::integer[]
      AND source.timeframes_derived = ARRAY[7, 30]::integer[]
      AND source.meta->>'inst_type' = 'SWAP'
      AND source.meta->>'derived_board_sort' = 'roi'
      AND source.meta->>'derived_stats_max_age_hours' = '168'
    )
    OR (
      source.slug = 'okx_spot'
      AND source.fetch_region = 'vps_sg'
      AND source.page_size = 20
      AND source.pagination_kind = 'numeric'
      AND source.timeframes_native = ARRAY[90]::integer[]
      AND source.timeframes_derived = ARRAY[7, 30]::integer[]
      AND source.meta->>'inst_type' = 'SPOT'
      AND source.meta->>'derived_board_sort' = 'roi'
      AND source.meta->>'derived_stats_max_age_hours' = '168'
    )
    OR (
      source.slug = 'toobit_futures'
      AND source.fetch_region = 'vps_sg'
      AND source.page_size = 6
      AND source.pagination_kind = 'numeric'
      AND source.timeframes_native = ARRAY[7, 30, 90]::integer[]
      AND source.timeframes_derived = ARRAY[]::integer[]
    );

  SELECT pg_catalog.count(*)::integer
  INTO v_state_drift
  FROM arena.sources AS source
  JOIN public.expected_serving_state AS expected USING (id)
  WHERE source.status IS DISTINCT FROM expected.status
     OR source.serving_mode IS DISTINCT FROM expected.serving_mode;

  SELECT pg_catalog.count(*)::integer
  INTO v_constraint
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'arena.sources'::pg_catalog.regclass
    AND constraint_row.conname = 'sources_active_adapter_runtime_contract'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated;

  IF v_exact <> 7 THEN
    RAISE EXCEPTION 'canonical source contract count drifted: %', v_exact;
  END IF;
  IF v_state_drift <> 0 THEN
    RAISE EXCEPTION 'successful migration changed source serving state';
  END IF;
  IF v_constraint <> 1 THEN
    RAISE EXCEPTION 'runtime contract constraint is missing or unvalidated';
  END IF;
END
$assert$;
SQL

CANONICAL_DIGEST="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.md5(
      pg_catalog.string_agg(
        pg_catalog.concat_ws(
          '|',
          slug,
          timeframes_native::text,
          timeframes_derived::text,
          expected_count::text,
          deep_profile_topn::text,
          currency,
          page_size::text,
          pagination_kind,
          cadence_tier_a::text,
          fetch_region,
          rate_budget_ms::text,
          serving_mode,
          status,
          meta::text
        ),
        E'\\n' ORDER BY id
      )
    )
    FROM arena.sources;
  "
)"
psql_cmd -q -f "$MIGRATION"
REPLAY_DIGEST="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.md5(
      pg_catalog.string_agg(
        pg_catalog.concat_ws(
          '|',
          slug,
          timeframes_native::text,
          timeframes_derived::text,
          expected_count::text,
          deep_profile_topn::text,
          currency,
          page_size::text,
          pagination_kind,
          cadence_tier_a::text,
          fetch_region,
          rate_budget_ms::text,
          serving_mode,
          status,
          meta::text
        ),
        E'\\n' ORDER BY id
      )
    )
    FROM arena.sources;
  "
)"
if [[ "$CANONICAL_DIGEST" != "$REPLAY_DIGEST" ]]; then
  echo "replayed migration changed the canonical source contract" >&2
  exit 1
fi

expect_sql_failure \
  'nullable page size' \
  'sources_active_adapter_runtime_contract' \
  "UPDATE arena.sources SET page_size = NULL WHERE slug = 'bitmart_futures';"
expect_sql_failure \
  'removed derived freshness evidence' \
  'sources_active_adapter_runtime_contract' \
  "UPDATE arena.sources SET meta = meta - 'derived_stats_max_age_hours' WHERE slug = 'bitmart_futures';"
expect_sql_failure \
  'removed OKX product identity' \
  'sources_active_adapter_runtime_contract' \
  "UPDATE arena.sources SET meta = meta - 'inst_type' WHERE slug = 'okx_spot';"
expect_sql_failure \
  'nullable Hyperliquid capacity' \
  'sources_active_adapter_runtime_contract' \
  "UPDATE arena.sources SET expected_count = NULL WHERE slug = 'hyperliquid';"

psql_cmd -q -c "
  UPDATE arena.sources
  SET status = 'inactive',
      page_size = NULL,
      meta = meta - 'derived_stats_max_age_hours'
  WHERE slug = 'bitmart_futures';
"
expect_sql_failure \
  'reactivating drifted inactive source' \
  'sources_active_adapter_runtime_contract' \
  "UPDATE arena.sources SET status = 'active' WHERE slug = 'bitmart_futures';"
psql_cmd -q -c "
  UPDATE arena.sources
  SET page_size = 20,
      meta = meta || '{\"derived_stats_max_age_hours\":168}'::jsonb,
      status = 'active'
  WHERE slug = 'bitmart_futures';
"

expect_sql_failure \
  'rogue active adapter identity' \
  'sources_active_adapter_runtime_contract' \
  "INSERT INTO arena.sources (
     id, slug, exchange_id, product_type, trader_kind_scope, adapter_slug,
     timeframes_native, timeframes_derived, currency, fetch_region,
     serving_mode, status, meta
   ) VALUES (
     8, 'rogue_bitmart', 2, 'futures', 'mixed', 'bitmart',
     ARRAY[7,30], ARRAY[90], 'USDT', 'vps_sg',
     'legacy', 'active',
     '{\"derived_board_sort\":\"roi\",\"derived_stats_max_age_hours\":168}'::jsonb
   );"

psql_cmd -q -c "
  UPDATE arena.sources
  SET status = 'inactive',
      adapter_slug = 'kucoin_drift'
  WHERE slug = 'kucoin_futures';
"
expect_migration_failure \
  'reviewed source identity drifted' \
  'reviewed source identity drifted; refusing broad registry repair'
psql_cmd -q -c "
  UPDATE arena.sources
  SET adapter_slug = 'kucoin',
      status = 'active'
  WHERE slug = 'kucoin_futures';
"

echo "source registry runtime contract PostgreSQL 17 proof passed"
