#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof that record provenance keeps the upstream,
# capture, and publication clocks distinct without weakening existing record
# or Bitget bot copier contracts.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BASE_RPC_MIGRATION="$ROOT_DIR/supabase/migrations/20260611000309_arena_records_rpcs.sql"
RAW_FIELDS_MIGRATION="$ROOT_DIR/supabase/migrations/20260630195608_records_page_surface_raw_record_fields.sql"
BITGET_COPIER_MIGRATION="$ROOT_DIR/supabase/migrations/20260729014000_bitget_bot_copier_aggregate_authority.sql"
MIGRATION="$ROOT_DIR/supabase/migrations/20260803090000_record_provenance_clocks.sql"
QUARANTINE_MIGRATION="$ROOT_DIR/supabase/migrations/20260804042000_fail_closed_position_history_records_page.sql"
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
for migration in \
  "$BASE_RPC_MIGRATION" \
  "$RAW_FIELDS_MIGRATION" \
  "$BITGET_COPIER_MIGRATION" \
  "$MIGRATION" \
  "$QUARANTINE_MIGRATION"; do
  if [[ ! -f "$migration" ]]; then
    echo "Required migration not found: $migration" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/record-provenance-clocks-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((59000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    echo "[record-provenance] PostgreSQL log tail:" >&2
    tail -200 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

assert_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "[record-provenance] $label changed" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
}

expect_failure_contains() {
  local label="$1"
  local needle="$2"
  local sql="$3"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"
  if psql_cmd -v VERBOSITY=verbose -c "$sql" >"$failure_log" 2>&1; then
    echo "[record-provenance] Expected failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "[record-provenance] Unexpected failure for $label" >&2
    sed -n '1,160p' "$failure_log" >&2
    exit 1
  fi
}

function_metadata_fingerprint() {
  local function_signature="$1"
  psql_cmd -Atq -v function_signature="$function_signature" <<'SQL'
SELECT pg_catalog.encode(
  pg_catalog.sha256(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'oid', function_row.oid::text,
        'owner', function_row.proowner::text,
        'acl', COALESCE(function_row.proacl::text, ''),
        'language', function_row.prolang::text,
        'kind', function_row.prokind::text,
        'securityDefiner', function_row.prosecdef,
        'volatility', function_row.provolatile::text,
        'parallel', function_row.proparallel::text,
        'strict', function_row.proisstrict,
        'leakproof', function_row.proleakproof,
        'returnsSet', function_row.proretset,
        'argumentDefaults', function_row.pronargdefaults,
        'config', function_row.proconfig,
        'definition', pg_catalog.pg_get_functiondef(function_row.oid)
      )::text,
      'UTF8'
    )
  ),
  'hex'
)
FROM pg_catalog.pg_proc AS function_row
WHERE function_row.oid = :'function_signature'::pg_catalog.regprocedure;
SQL
}

rpc_output_fingerprint() {
  psql_cmd -Atq <<'SQL'
SELECT pg_catalog.encode(
  pg_catalog.sha256(
    pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'delayedPositions', public.arena_records_page(
          'delayed_positions', 'delayed-trader', 'positions', NULL, NULL, 50
        ),
        'missingDelayPositions', public.arena_records_page(
          'missing_delay', 'missing-trader', 'positions', NULL, NULL, 50
        ),
        'invalidDelayPositions', public.arena_records_page(
          'invalid_delay', 'invalid-trader', 'positions', NULL, NULL, 50
        ),
        'negativeDelayPositions', public.arena_records_page(
          'negative_delay', 'negative-trader', 'positions', NULL, NULL, 50
        ),
        'emptyPositions', public.arena_records_page(
          'empty_positions', 'empty-trader', 'positions', NULL, NULL, 50
        ),
        'positionHistory', public.arena_records_page(
          'event_records', 'events-trader', 'position_history', NULL, NULL, 50
        ),
        'orders', public.arena_records_page(
          'event_records', 'events-trader', 'orders', NULL, NULL, 50
        ),
        'transfers', public.arena_records_page(
          'event_records', 'events-trader', 'transfers', NULL, NULL, 50
        ),
        'trustedBot', public.arena_copier_aggregate(
          'bitget_bots_futures', 'bot-trusted'
        ),
        'top10Bot', public.arena_copier_aggregate(
          'bitget_bots_spot', 'bot-top10'
        ),
        'humanCopier', public.arena_copier_aggregate(
          'bitget_futures', 'human-copier'
        ),
        'noEvidenceBot', public.arena_copier_aggregate(
          'bitget_bots_futures', 'bot-no-evidence'
        )
      )::text,
      'UTF8'
    )
  ),
  'hex'
);
SQL
}

echo "[record-provenance] boot isolated PostgreSQL 17 cluster"
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

echo "[record-provenance] install minimal production-shaped schema and fixtures"
psql_cmd -q <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE hostile_role NOLOGIN NOBYPASSRLS;

CREATE SCHEMA arena AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, arena
  TO anon, authenticated, service_role, hostile_role;

CREATE TABLE arena.exchanges (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL
);

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  exchange_id smallint NOT NULL REFERENCES arena.exchanges(id),
  product_type text NOT NULL,
  trader_kind_scope text NOT NULL,
  adapter_slug text NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL,
  currency text NOT NULL,
  timeframes_native integer[] NOT NULL,
  timeframes_derived integer[] NOT NULL,
  page_size integer,
  pagination_kind text,
  copier_table_depth text NOT NULL
    CHECK (copier_table_depth IN ('full', 'top10', 'top3_preview', 'none')),
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL,
  trader_kind text NOT NULL,
  UNIQUE (source_id, exchange_trader_id)
);

CREATE TABLE arena.trader_stats (
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  timeframe smallint NOT NULL,
  as_of timestamptz NOT NULL,
  copier_pnl numeric,
  copier_count integer,
  extras jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (trader_id, timeframe)
);

CREATE TABLE arena.positions_current (
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  snapshot_at timestamptz NOT NULL,
  as_of timestamptz NOT NULL,
  symbol text NOT NULL,
  side text,
  leverage numeric,
  size numeric,
  entry_price numeric,
  mark_price numeric,
  unrealized_pnl numeric,
  currency text NOT NULL,
  raw jsonb,
  PRIMARY KEY (trader_id, symbol, side)
);

CREATE TABLE arena.position_history (
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  opened_at timestamptz,
  closed_at timestamptz,
  symbol text NOT NULL,
  side text,
  leverage numeric,
  size numeric,
  entry_price numeric,
  exit_price numeric,
  realized_pnl numeric,
  currency text NOT NULL,
  dedupe_hash text NOT NULL,
  raw jsonb,
  UNIQUE (closed_at, dedupe_hash)
);

CREATE TABLE arena.order_records (
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  ts timestamptz NOT NULL,
  kind text,
  symbol text,
  side text,
  price numeric,
  qty numeric,
  currency text NOT NULL,
  dedupe_hash text NOT NULL,
  raw jsonb,
  UNIQUE (ts, dedupe_hash)
);

CREATE TABLE arena.transfer_history (
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  ts timestamptz NOT NULL,
  direction text,
  asset text,
  amount numeric,
  currency text NOT NULL,
  dedupe_hash text NOT NULL,
  raw jsonb,
  UNIQUE (ts, dedupe_hash)
);

CREATE TABLE arena.copier_records (
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  ts timestamptz NOT NULL,
  copier_label text,
  copier_pnl numeric,
  copier_invested numeric,
  copy_duration_days integer,
  currency text NOT NULL,
  dedupe_hash text NOT NULL,
  raw jsonb,
  UNIQUE (ts, dedupe_hash)
);

ALTER TABLE arena.exchanges OWNER TO postgres;
ALTER TABLE arena.sources OWNER TO postgres;
ALTER TABLE arena.traders OWNER TO postgres;
ALTER TABLE arena.trader_stats OWNER TO postgres;
ALTER TABLE arena.positions_current OWNER TO postgres;
ALTER TABLE arena.position_history OWNER TO postgres;
ALTER TABLE arena.order_records OWNER TO postgres;
ALTER TABLE arena.transfer_history OWNER TO postgres;
ALTER TABLE arena.copier_records OWNER TO postgres;

REVOKE ALL ON ALL TABLES IN SCHEMA arena
  FROM PUBLIC, anon, authenticated, service_role, hostile_role;
GRANT SELECT ON ALL TABLES IN SCHEMA arena TO service_role;

INSERT INTO arena.exchanges (id, slug) VALUES
  (1, 'bitget'),
  (2, 'other');

INSERT INTO arena.sources (
  id, slug, exchange_id, product_type, trader_kind_scope, adapter_slug,
  status, serving_mode, currency, timeframes_native, timeframes_derived,
  page_size, pagination_kind, copier_table_depth, meta
) VALUES
  (
    11, 'bitget_bots_futures', 1, 'futures', 'bot', 'bitget_bots',
    'active', 'serving', 'USDT', ARRAY[30], ARRAY[]::integer[],
    20, 'numeric', 'full',
    '{"boards":["futures_grid","futures_martingale"]}'
  ),
  (
    12, 'bitget_bots_spot', 1, 'spot', 'bot', 'bitget_bots',
    'active', 'serving', 'USDT', ARRAY[30], ARRAY[]::integer[],
    20, 'numeric', 'full',
    '{"boards":["spot_grid","spot_martingale"]}'
  ),
  (
    21, 'bitget_futures', 1, 'futures', 'human', 'bitget',
    'active', 'serving', 'USDT', ARRAY[7,30,90], ARRAY[]::integer[],
    30, 'numeric', 'full', '{}'
  ),
  (
    31, 'delayed_positions', 2, 'futures', 'human', 'other',
    'active', 'serving', 'USDT', ARRAY[90], ARRAY[]::integer[],
    50, 'numeric', 'none', '{"positions_delay_hours":1}'
  ),
  (
    32, 'missing_delay', 2, 'futures', 'human', 'other',
    'active', 'serving', 'USDT', ARRAY[90], ARRAY[]::integer[],
    50, 'numeric', 'none', '{}'
  ),
  (
    33, 'invalid_delay', 2, 'futures', 'human', 'other',
    'active', 'serving', 'USDT', ARRAY[90], ARRAY[]::integer[],
    50, 'numeric', 'none', '{"positions_delay_hours":"1"}'
  ),
  (
    34, 'negative_delay', 2, 'futures', 'human', 'other',
    'active', 'serving', 'USDT', ARRAY[90], ARRAY[]::integer[],
    50, 'numeric', 'none', '{"positions_delay_hours":-1}'
  ),
  (
    35, 'empty_positions', 2, 'futures', 'human', 'other',
    'active', 'serving', 'USDT', ARRAY[90], ARRAY[]::integer[],
    50, 'numeric', 'none', '{"positions_delay_hours":1}'
  ),
  (
    36, 'event_records', 2, 'futures', 'human', 'other',
    'active', 'serving', 'USDT', ARRAY[90], ARRAY[]::integer[],
    50, 'numeric', 'none', '{}'
  );

INSERT INTO arena.traders (
  id, source_id, exchange_trader_id, trader_kind
) VALUES
  (101, 11, 'bot-trusted', 'bot'),
  (102, 12, 'bot-top10', 'bot'),
  (103, 11, 'bot-no-evidence', 'bot'),
  (201, 21, 'human-copier', 'human'),
  (301, 31, 'delayed-trader', 'human'),
  (302, 32, 'missing-trader', 'human'),
  (303, 33, 'invalid-trader', 'human'),
  (304, 34, 'negative-trader', 'human'),
  (305, 35, 'empty-trader', 'human'),
  (306, 36, 'events-trader', 'human');

INSERT INTO arena.trader_stats (
  trader_id, timeframe, as_of, copier_pnl, copier_count, extras
) VALUES
  (
    101, 0, '2026-08-03 12:00:00+00', 456, 123,
    pg_catalog.jsonb_build_object(
      '_arena_profile_publication_epoch_ms',
      EXTRACT(EPOCH FROM '2026-08-03 12:00:00+00'::timestamptz) * 1000
    )
  ),
  (
    102, 0, '2026-08-03 12:00:00+00', 333, 222,
    pg_catalog.jsonb_build_object(
      '_arena_profile_publication_epoch_ms',
      EXTRACT(EPOCH FROM '2026-08-03 12:00:00+00'::timestamptz) * 1000 + 1
    )
  ),
  (201, 30, '2026-08-03 11:00:00+00', 888, 55, '{}');

INSERT INTO arena.copier_records (
  trader_id, ts, copier_label, copier_pnl, currency, dedupe_hash, raw
)
SELECT 101, '2026-08-03 12:05:00+00', 'trusted-' || ord::text,
       value, 'USDT', 'trusted-' || ord::text, '{}'::jsonb
FROM pg_catalog.unnest(
  ARRAY[-2000,-500,10,20,30,40,50,1500,2500,15000]::numeric[]
) WITH ORDINALITY AS sample(value, ord);

INSERT INTO arena.copier_records (
  trader_id, ts, copier_label, copier_pnl, currency, dedupe_hash, raw
)
SELECT 102, '2026-08-03 12:06:00+00', 'top10-' || ord::text,
       value, 'USDT', 'top10-' || ord::text, '{}'::jsonb
FROM pg_catalog.unnest(
  ARRAY[1,2,3,4,5,6,7,8,9,10]::numeric[]
) WITH ORDINALITY AS sample(value, ord);

INSERT INTO arena.copier_records (
  trader_id, ts, copier_label, copier_pnl, currency, dedupe_hash, raw
) VALUES
  (201, '2026-08-03 11:05:00+00', 'human-1', 12, 'USDT', 'human-1', '{}'),
  (201, '2026-08-03 11:05:00+00', 'human-2', 24, 'USDT', 'human-2', '{}');

INSERT INTO arena.positions_current (
  trader_id, snapshot_at, as_of, symbol, side, leverage, size,
  entry_price, mark_price, unrealized_pnl, currency, raw
) VALUES
  (301, '2026-08-03 12:10:00+00', '2026-08-03 11:00:00+00',
   'BTCUSDT', 'long', 2, 1, 100, 110, 10, 'USDT', '{"margin":50}'),
  (301, '2026-08-03 12:20:00+00', '2026-08-03 12:00:00+00',
   'ETHUSDT', 'short', 3, 2, 50, 45, 8, 'USDT', '{"margin":30}'),
  (302, '2026-08-03 12:21:00+00', '2026-08-03 12:01:00+00',
   'SOLUSDT', 'long', 2, 3, 20, 21, 3, 'USDT', '{}'),
  (303, '2026-08-03 12:22:00+00', '2026-08-03 12:02:00+00',
   'XRPUSDT', 'long', 2, 4, 1, 1.1, 0.4, 'USDT', '{}'),
  (304, '2026-08-03 12:23:00+00', '2026-08-03 12:03:00+00',
   'ADAUSDT', 'short', 2, 5, 1, 0.9, 0.5, 'USDT', '{}');

INSERT INTO arena.position_history (
  trader_id, opened_at, closed_at, symbol, side, leverage, size,
  entry_price, exit_price, realized_pnl, currency, dedupe_hash, raw
) VALUES (
  306, '2026-08-01 09:00:00+00', '2026-08-01 10:00:00+00',
  'BTCUSDT', 'long', 2, 1, 100, 110, 10, 'USDT', 'history-1',
  '{"roi":10}'
);

INSERT INTO arena.order_records (
  trader_id, ts, kind, symbol, side, price, qty, currency, dedupe_hash, raw
) VALUES (
  306, '2026-08-01 11:00:00+00', 'close', 'BTCUSDT', 'sell',
  110, 1, 'USDT', 'order-1', '{"totalPnl":10}'
);

INSERT INTO arena.transfer_history (
  trader_id, ts, direction, asset, amount, currency, dedupe_hash, raw
) VALUES (
  306, '2026-08-01 12:00:00+00', 'in', 'USDT', 100,
  'USDT', 'transfer-1', '{}'
);
SQL

echo "[record-provenance] install exact pre-migration RPC lineage"
psql_cmd -q -f "$BASE_RPC_MIGRATION"
psql_cmd -q -f "$RAW_FIELDS_MIGRATION"
psql_cmd -q <<'SQL'
ALTER FUNCTION public.arena_records_page(text, text, text, integer, text, integer)
  OWNER TO postgres;
ALTER FUNCTION public.arena_copier_aggregate(text, text)
  OWNER TO postgres;
ALTER FUNCTION arena.jnum(text) OWNER TO postgres;
ALTER FUNCTION arena.jmargin_mode(jsonb) OWNER TO postgres;
SQL
psql_cmd -q -f "$BITGET_COPIER_MIGRATION"

echo "[record-provenance] prove legacy read-time asOf behavior before cutover"
psql_cmd -q <<'SQL'
DO $legacy_now_behavior$
DECLARE
  v_payload jsonb;
BEGIN
  v_payload := public.arena_records_page(
    'event_records', 'events-trader', 'position_history', NULL, NULL, 50
  );

  IF pg_catalog.jsonb_array_length(v_payload->'rows') IS DISTINCT FROM 1
     OR NOT v_payload ? 'asOf'
     OR v_payload ? 'sourceAsOf'
     OR v_payload ? 'observedAt'
     OR v_payload ? 'publishedAt'
     OR (v_payload->>'asOf')::timestamptz IS DISTINCT FROM
          pg_catalog.transaction_timestamp() THEN
    RAISE EXCEPTION 'legacy history did not reproduce read-time asOf: %', v_payload;
  END IF;

  v_payload := public.arena_records_page(
    'empty_positions', 'empty-trader', 'positions', NULL, NULL, 50
  );
  IF pg_catalog.jsonb_array_length(v_payload->'rows') IS DISTINCT FROM 0
     OR NOT v_payload ? 'asOf'
     OR (v_payload->>'asOf')::timestamptz IS DISTINCT FROM
          pg_catalog.transaction_timestamp() THEN
    RAISE EXCEPTION 'legacy empty positions did not synthesize now(): %', v_payload;
  END IF;
END
$legacy_now_behavior$;
SQL

TRUSTED_BEFORE="$(psql_cmd -Atqc "SELECT (public.arena_copier_aggregate('bitget_bots_futures','bot-trusted') - 'asOf')::text")"
TOP10_BEFORE="$(psql_cmd -Atqc "SELECT (public.arena_copier_aggregate('bitget_bots_spot','bot-top10') - 'asOf')::text")"
HUMAN_BEFORE="$(psql_cmd -Atqc "SELECT (public.arena_copier_aggregate('bitget_futures','human-copier') - 'asOf')::text")"
NO_EVIDENCE_BEFORE="$(psql_cmd -Atqc "SELECT public.arena_copier_aggregate('bitget_bots_futures','bot-no-evidence')::text")"
assert_equal "pre-migration no-evidence SQL NULL" "" "$NO_EVIDENCE_BEFORE"

echo "[record-provenance] apply provenance-clock migration"
psql_cmd -q -f "$MIGRATION"

echo "[record-provenance] prove clock semantics and record payloads"
psql_cmd -q <<'SQL'
DO $record_clock_contract$
DECLARE
  v_payload jsonb;
  v_kind text;
BEGIN
  SET LOCAL ROLE anon;
  v_payload := public.arena_records_page(
    'delayed_positions', 'delayed-trader', 'positions', NULL, NULL, 50
  );
  RESET ROLE;
  IF pg_catalog.jsonb_array_length(v_payload->'rows') IS DISTINCT FROM 2
     OR (v_payload->>'sourceAsOf')::timestamptz IS DISTINCT FROM
          '2026-08-03 12:00:00+00'::timestamptz
     OR v_payload->'observedAt' IS DISTINCT FROM 'null'::jsonb
     OR (v_payload->>'publishedAt')::timestamptz IS DISTINCT FROM
          '2026-08-03 12:20:00+00'::timestamptz
     OR (v_payload->>'asOf')::timestamptz IS DISTINCT FROM
          '2026-08-03 12:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'explicit-delay position clocks drifted: %', v_payload;
  END IF;

  FOREACH v_kind IN ARRAY ARRAY[
    'missing_delay', 'invalid_delay', 'negative_delay'
  ]::text[] LOOP
    v_payload := public.arena_records_page(
      v_kind,
      CASE v_kind
        WHEN 'missing_delay' THEN 'missing-trader'
        WHEN 'invalid_delay' THEN 'invalid-trader'
        ELSE 'negative-trader'
      END,
      'positions', NULL, NULL, 50
    );
    IF pg_catalog.jsonb_array_length(v_payload->'rows') IS DISTINCT FROM 1
       OR v_payload->'sourceAsOf' IS DISTINCT FROM 'null'::jsonb
       OR v_payload->'observedAt' IS DISTINCT FROM 'null'::jsonb
       OR (v_payload->>'publishedAt')::timestamptz IS DISTINCT FROM
            (CASE v_kind
              WHEN 'missing_delay' THEN '2026-08-03 12:21:00+00'::timestamptz
              WHEN 'invalid_delay' THEN '2026-08-03 12:22:00+00'::timestamptz
              ELSE '2026-08-03 12:23:00+00'::timestamptz
            END)
       OR v_payload->'asOf' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'untrusted delay exposed source freshness for %: %', v_kind, v_payload;
    END IF;
  END LOOP;

  v_payload := public.arena_records_page(
    'empty_positions', 'empty-trader', 'positions', NULL, NULL, 50
  );
  IF pg_catalog.jsonb_array_length(v_payload->'rows') IS DISTINCT FROM 0
     OR v_payload->'sourceAsOf' IS DISTINCT FROM 'null'::jsonb
     OR v_payload->'observedAt' IS DISTINCT FROM 'null'::jsonb
     OR v_payload->'publishedAt' IS DISTINCT FROM 'null'::jsonb
     OR v_payload->'asOf' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'empty positions synthesized provenance: %', v_payload;
  END IF;

  FOREACH v_kind IN ARRAY ARRAY[
    'position_history', 'orders', 'transfers'
  ]::text[] LOOP
    v_payload := public.arena_records_page(
      'event_records', 'events-trader', v_kind, NULL, NULL, 50
    );
    IF pg_catalog.jsonb_array_length(v_payload->'rows') IS DISTINCT FROM 1
       OR v_payload->'sourceAsOf' IS DISTINCT FROM 'null'::jsonb
       OR v_payload->'observedAt' IS DISTINCT FROM 'null'::jsonb
       OR v_payload->'publishedAt' IS DISTINCT FROM 'null'::jsonb
       OR v_payload->'asOf' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'event surface fabricated provenance for %: %', v_kind, v_payload;
    END IF;
  END LOOP;
END
$record_clock_contract$;
SQL

echo "[record-provenance] prove copier metrics and Bitget bot authority unchanged"
TRUSTED_AFTER="$(psql_cmd -Atqc "SELECT (public.arena_copier_aggregate('bitget_bots_futures','bot-trusted') - 'asOf' - 'sourceAsOf' - 'observedAt' - 'publishedAt')::text")"
TOP10_AFTER="$(psql_cmd -Atqc "SELECT (public.arena_copier_aggregate('bitget_bots_spot','bot-top10') - 'asOf' - 'sourceAsOf' - 'observedAt' - 'publishedAt')::text")"
HUMAN_AFTER="$(psql_cmd -Atqc "SELECT (public.arena_copier_aggregate('bitget_futures','human-copier') - 'asOf' - 'sourceAsOf' - 'observedAt' - 'publishedAt')::text")"
NO_EVIDENCE_AFTER="$(psql_cmd -Atqc "SELECT public.arena_copier_aggregate('bitget_bots_futures','bot-no-evidence')::text")"
assert_equal "trusted Bitget bot totals/distribution" "$TRUSTED_BEFORE" "$TRUSTED_AFTER"
assert_equal "untrusted Bitget bot Top-10 distribution" "$TOP10_BEFORE" "$TOP10_AFTER"
assert_equal "non-bot copier aggregate" "$HUMAN_BEFORE" "$HUMAN_AFTER"
assert_equal "post-migration no-evidence SQL NULL" "" "$NO_EVIDENCE_AFTER"

psql_cmd -q <<'SQL'
DO $copier_clock_contract$
DECLARE
  v_payload jsonb;
  v_subject text;
BEGIN
  FOREACH v_subject IN ARRAY ARRAY[
    'bitget_bots_futures|bot-trusted',
    'bitget_bots_spot|bot-top10',
    'bitget_futures|human-copier'
  ]::text[] LOOP
    v_payload := public.arena_copier_aggregate(
      pg_catalog.split_part(v_subject, '|', 1),
      pg_catalog.split_part(v_subject, '|', 2)
    );
    IF v_payload->'sourceAsOf' IS DISTINCT FROM 'null'::jsonb
       OR v_payload->'observedAt' IS DISTINCT FROM 'null'::jsonb
       OR v_payload->'publishedAt' IS DISTINCT FROM 'null'::jsonb
       OR v_payload->'asOf' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'copier aggregate fabricated clocks for %: %', v_subject, v_payload;
    END IF;
  END LOOP;

  v_payload := public.arena_copier_aggregate(
    'bitget_bots_futures', 'bot-trusted'
  );
  IF (v_payload->>'copierCount')::integer IS DISTINCT FROM 123
     OR (v_payload->>'totalCopierPnl')::numeric IS DISTINCT FROM 456
     OR v_payload->>'depth' IS DISTINCT FROM 'top10'
     OR pg_catalog.jsonb_array_length(v_payload->'pnlDistribution') IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'trusted Bitget bot totals regressed: %', v_payload;
  END IF;

  v_payload := public.arena_copier_aggregate(
    'bitget_bots_spot', 'bot-top10'
  );
  IF v_payload->'copierCount' IS DISTINCT FROM 'null'::jsonb
     OR v_payload->'totalCopierPnl' IS DISTINCT FROM 'null'::jsonb
     OR v_payload->>'depth' IS DISTINCT FROM 'top10'
     OR pg_catalog.jsonb_array_length(v_payload->'pnlDistribution') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Top-10-only Bitget bot semantics regressed: %', v_payload;
  END IF;
END
$copier_clock_contract$;
SQL

echo "[record-provenance] prove route block and callable/table ACL"
expect_failure_contains \
  "copiers-route-block" \
  "copier records are aggregate-only; use arena_copier_aggregate" \
  "SET ROLE anon; SELECT public.arena_records_page('bitget_futures','human-copier','copiers',NULL,NULL,50)"
expect_failure_contains \
  "anon-direct-position-read" \
  "permission denied for table positions_current" \
  "SET ROLE anon; SELECT * FROM arena.positions_current"
expect_failure_contains \
  "authenticated-direct-copier-read" \
  "permission denied for table copier_records" \
  "SET ROLE authenticated; SELECT * FROM arena.copier_records"

psql_cmd -q <<'SQL'
DO $callable_acl_contract$
DECLARE
  v_signature text;
  v_function oid;
  v_row pg_catalog.pg_proc%ROWTYPE;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.arena_records_page(text,text,text,integer,text,integer)',
    'public.arena_copier_aggregate(text,text)'
  ]::text[] LOOP
    v_function := pg_catalog.to_regprocedure(v_signature);
    IF v_function IS NULL THEN
      RAISE EXCEPTION 'missing callable: %', v_signature;
    END IF;
    SELECT * INTO STRICT v_row
    FROM pg_catalog.pg_proc
    WHERE oid = v_function;

    IF v_row.proowner <> 'postgres'::pg_catalog.regrole
       OR NOT v_row.prosecdef
       OR v_row.provolatile <> 's'
       OR v_row.proconfig IS DISTINCT FROM
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
       OR NOT pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege('hostile_role', v_function, 'EXECUTE')
       OR EXISTS (
         SELECT
           actual.grantor,
           actual.grantee,
           actual.privilege_type,
           actual.is_grantable
         FROM pg_catalog.aclexplode(
           COALESCE(v_row.proacl, pg_catalog.acldefault('f', v_row.proowner))
         ) AS actual
         EXCEPT
         SELECT
           expected.grantor,
           expected.grantee,
           expected.privilege_type,
           expected.is_grantable
         FROM (
           VALUES
             (v_row.proowner, v_row.proowner, 'EXECUTE'::text, false),
             (v_row.proowner, 'anon'::regrole::oid, 'EXECUTE'::text, false),
             (v_row.proowner, 'authenticated'::regrole::oid, 'EXECUTE'::text, false),
             (v_row.proowner, 'service_role'::regrole::oid, 'EXECUTE'::text, false)
         ) AS expected(grantor, grantee, privilege_type, is_grantable)
       )
       OR EXISTS (
         SELECT
           expected.grantor,
           expected.grantee,
           expected.privilege_type,
           expected.is_grantable
         FROM (
           VALUES
             (v_row.proowner, v_row.proowner, 'EXECUTE'::text, false),
             (v_row.proowner, 'anon'::regrole::oid, 'EXECUTE'::text, false),
             (v_row.proowner, 'authenticated'::regrole::oid, 'EXECUTE'::text, false),
             (v_row.proowner, 'service_role'::regrole::oid, 'EXECUTE'::text, false)
         ) AS expected(grantor, grantee, privilege_type, is_grantable)
         EXCEPT
         SELECT
           actual.grantor,
           actual.grantee,
           actual.privilege_type,
           actual.is_grantable
         FROM pg_catalog.aclexplode(
           COALESCE(v_row.proacl, pg_catalog.acldefault('f', v_row.proowner))
         ) AS actual
       ) THEN
      RAISE EXCEPTION 'callable ACL/metadata drifted for %', v_signature;
    END IF;
  END LOOP;
END
$callable_acl_contract$;
SQL

RECORDS_METADATA_BEFORE_REPLAY="$(function_metadata_fingerprint 'public.arena_records_page(text,text,text,integer,text,integer)')"
COPIER_METADATA_BEFORE_REPLAY="$(function_metadata_fingerprint 'public.arena_copier_aggregate(text,text)')"
OUTPUT_FINGERPRINT_BEFORE_REPLAY="$(rpc_output_fingerprint)"

echo "[record-provenance] replay migration and prove stable identity/output"
psql_cmd -q -f "$MIGRATION"

RECORDS_METADATA_AFTER_REPLAY="$(function_metadata_fingerprint 'public.arena_records_page(text,text,text,integer,text,integer)')"
COPIER_METADATA_AFTER_REPLAY="$(function_metadata_fingerprint 'public.arena_copier_aggregate(text,text)')"
OUTPUT_FINGERPRINT_AFTER_REPLAY="$(rpc_output_fingerprint)"

assert_equal "records callable replay metadata" "$RECORDS_METADATA_BEFORE_REPLAY" "$RECORDS_METADATA_AFTER_REPLAY"
assert_equal "copier callable replay metadata" "$COPIER_METADATA_BEFORE_REPLAY" "$COPIER_METADATA_AFTER_REPLAY"
assert_equal "RPC output replay fingerprint" "$OUTPUT_FINGERPRINT_BEFORE_REPLAY" "$OUTPUT_FINGERPRINT_AFTER_REPLAY"

echo "[record-provenance] install pre-cutover wrapper and snapshot unaffected surfaces"
psql_cmd -q <<'SQL'
CREATE FUNCTION public.legacy_history_records_wrapper(p_cursor text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $wrapper$
  SELECT public.arena_records_page(
    'event_records', 'events-trader', 'position_history', NULL, p_cursor, 50
  );
$wrapper$;
ALTER FUNCTION public.legacy_history_records_wrapper(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.legacy_history_records_wrapper(text)
  FROM PUBLIC, anon, authenticated, service_role, hostile_role;
GRANT EXECUTE ON FUNCTION public.legacy_history_records_wrapper(text) TO anon;

DO $legacy_wrapper_pre_cutover$
DECLARE
  v_payload jsonb;
BEGIN
  SET LOCAL ROLE anon;
  v_payload := public.legacy_history_records_wrapper(NULL);
  RESET ROLE;
  IF pg_catalog.jsonb_array_length(v_payload->'rows') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'legacy wrapper did not expose pre-cutover history: %', v_payload;
  END IF;
END
$legacy_wrapper_pre_cutover$;
SQL

NON_HISTORY_BEFORE_QUARANTINE="$(psql_cmd -Atq <<'SQL'
SELECT pg_catalog.jsonb_build_object(
  'positions', public.arena_records_page(
    'delayed_positions', 'delayed-trader', 'positions', NULL, NULL, 50
  ),
  'orders', public.arena_records_page(
    'event_records', 'events-trader', 'orders', NULL, NULL, 50
  ),
  'transfers', public.arena_records_page(
    'event_records', 'events-trader', 'transfers', NULL, NULL, 50
  )
)::text;
SQL
)"
HISTORY_TABLE_BEFORE_QUARANTINE="$(psql_cmd -Atq <<'SQL'
SELECT pg_catalog.encode(
  pg_catalog.sha256(
    pg_catalog.convert_to(
      COALESCE(
        pg_catalog.jsonb_agg(pg_catalog.to_jsonb(history_row) ORDER BY history_row.dedupe_hash),
        '[]'::jsonb
      )::text,
      'UTF8'
    )
  ),
  'hex'
)
FROM arena.position_history AS history_row;
SQL
)"
RECORDS_OID_BEFORE_QUARANTINE="$(psql_cmd -Atqc "SELECT 'public.arena_records_page(text,text,text,integer,text,integer)'::regprocedure::oid")"
COPIER_METADATA_BEFORE_QUARANTINE="$(function_metadata_fingerprint 'public.arena_copier_aggregate(text,text)')"
COPIER_OUTPUT_BEFORE_QUARANTINE="$(psql_cmd -Atqc "SELECT public.arena_copier_aggregate('bitget_bots_futures','bot-trusted')::text")"

echo "[record-provenance] prove rogue overload blocks the quarantine preflight"
psql_cmd -q <<'SQL'
CREATE FUNCTION public.arena_records_page(p_source text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS 'SELECT NULL::jsonb';
SQL
QUARANTINE_FAILURE_LOG="$TMP_ROOT/quarantine-rogue-overload.log"
if psql_cmd -v VERBOSITY=verbose -f "$QUARANTINE_MIGRATION" \
  >"$QUARANTINE_FAILURE_LOG" 2>&1; then
  echo "[record-provenance] Expected rogue-overload preflight failure" >&2
  exit 1
fi
if ! grep -Fq "arena_records_page overload set drifted" "$QUARANTINE_FAILURE_LOG"; then
  echo "[record-provenance] Unexpected rogue-overload failure" >&2
  sed -n '1,160p' "$QUARANTINE_FAILURE_LOG" >&2
  exit 1
fi
psql_cmd -q -c "DROP FUNCTION public.arena_records_page(text)"

echo "[record-provenance] apply position-history records-page quarantine"
psql_cmd -q -f "$QUARANTINE_MIGRATION"

echo "[record-provenance] prove direct-role, cursor and wrapper fail-closed behavior"
psql_cmd -q <<'SQL'
DO $position_history_quarantine_contract$
DECLARE
  v_payload jsonb;
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY[
    'anon', 'authenticated', 'service_role', 'postgres'
  ]::text[] LOOP
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', v_role);
    v_payload := public.arena_records_page(
      'event_records', 'events-trader', 'position_history', NULL, NULL, 50
    );
    EXECUTE 'RESET ROLE';

    IF pg_catalog.jsonb_array_length(v_payload->'rows') IS DISTINCT FROM 0
       OR v_payload->'nextCursor' IS DISTINCT FROM 'null'::jsonb
       OR v_payload->'asOf' IS DISTINCT FROM 'null'::jsonb
       OR v_payload->'sourceAsOf' IS DISTINCT FROM 'null'::jsonb
       OR v_payload->'observedAt' IS DISTINCT FROM 'null'::jsonb
       OR v_payload->'publishedAt' IS DISTINCT FROM 'null'::jsonb
       OR v_payload->>'currency' IS DISTINCT FROM 'USDT'
       OR v_payload->'completeness' IS DISTINCT FROM
            '{"state":"unknown","reason":"history_evidence_not_bound"}'::jsonb THEN
      RAISE EXCEPTION
        'position-history RPC quarantine drifted for role %: %',
        v_role,
        v_payload;
    END IF;
  END LOOP;

  SET LOCAL ROLE anon;
  v_payload := public.arena_records_page(
    'event_records', 'events-trader', 'position_history', NULL,
    'not-a-timestamp|not-a-hash', 50
  );
  RESET ROLE;
  IF pg_catalog.jsonb_array_length(v_payload->'rows') IS DISTINCT FROM 0
     OR v_payload->'completeness' IS DISTINCT FROM
          '{"state":"unknown","reason":"history_evidence_not_bound"}'::jsonb THEN
    RAISE EXCEPTION 'malformed history cursor escaped quarantine: %', v_payload;
  END IF;

  IF public.arena_records_page(
       'event_records', 'missing-trader', 'position_history', NULL, NULL, 50
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'unknown trader no longer returns SQL NULL';
  END IF;

  SET LOCAL ROLE anon;
  v_payload := public.legacy_history_records_wrapper(NULL);
  RESET ROLE;
  IF pg_catalog.jsonb_array_length(v_payload->'rows') IS DISTINCT FROM 0
     OR v_payload->'completeness' IS DISTINCT FROM
          '{"state":"unknown","reason":"history_evidence_not_bound"}'::jsonb THEN
    RAISE EXCEPTION 'legacy wrapper bypassed quarantined callable: %', v_payload;
  END IF;

  IF pg_catalog.has_function_privilege(
       'hostile_role',
       'public.arena_records_page(text,text,text,integer,text,integer)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'public',
       'public.arena_records_page(text,text,text,integer,text,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'quarantined callable escaped the exact runtime ACL';
  END IF;

  IF pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         'public.arena_records_page(text,text,text,integer,text,integer)'::regprocedure
       ),
       'arena.position_history'
     ) <> 0 THEN
    RAISE EXCEPTION 'quarantined callable retained the legacy history relation';
  END IF;
END
$position_history_quarantine_contract$;
SQL

NON_HISTORY_AFTER_QUARANTINE="$(psql_cmd -Atq <<'SQL'
SELECT pg_catalog.jsonb_build_object(
  'positions', public.arena_records_page(
    'delayed_positions', 'delayed-trader', 'positions', NULL, NULL, 50
  ),
  'orders', public.arena_records_page(
    'event_records', 'events-trader', 'orders', NULL, NULL, 50
  ),
  'transfers', public.arena_records_page(
    'event_records', 'events-trader', 'transfers', NULL, NULL, 50
  )
)::text;
SQL
)"
HISTORY_TABLE_AFTER_QUARANTINE="$(psql_cmd -Atq <<'SQL'
SELECT pg_catalog.encode(
  pg_catalog.sha256(
    pg_catalog.convert_to(
      COALESCE(
        pg_catalog.jsonb_agg(pg_catalog.to_jsonb(history_row) ORDER BY history_row.dedupe_hash),
        '[]'::jsonb
      )::text,
      'UTF8'
    )
  ),
  'hex'
)
FROM arena.position_history AS history_row;
SQL
)"
RECORDS_OID_AFTER_QUARANTINE="$(psql_cmd -Atqc "SELECT 'public.arena_records_page(text,text,text,integer,text,integer)'::regprocedure::oid")"
COPIER_METADATA_AFTER_QUARANTINE="$(function_metadata_fingerprint 'public.arena_copier_aggregate(text,text)')"
COPIER_OUTPUT_AFTER_QUARANTINE="$(psql_cmd -Atqc "SELECT public.arena_copier_aggregate('bitget_bots_futures','bot-trusted')::text")"

assert_equal "non-history RPC output changed during quarantine" "$NON_HISTORY_BEFORE_QUARANTINE" "$NON_HISTORY_AFTER_QUARANTINE"
assert_equal "position-history table changed during quarantine" "$HISTORY_TABLE_BEFORE_QUARANTINE" "$HISTORY_TABLE_AFTER_QUARANTINE"
assert_equal "records callable OID changed during quarantine" "$RECORDS_OID_BEFORE_QUARANTINE" "$RECORDS_OID_AFTER_QUARANTINE"
assert_equal "copier callable metadata changed during quarantine" "$COPIER_METADATA_BEFORE_QUARANTINE" "$COPIER_METADATA_AFTER_QUARANTINE"
assert_equal "copier output changed during quarantine" "$COPIER_OUTPUT_BEFORE_QUARANTINE" "$COPIER_OUTPUT_AFTER_QUARANTINE"

QUARANTINE_METADATA_BEFORE_REPLAY="$(function_metadata_fingerprint 'public.arena_records_page(text,text,text,integer,text,integer)')"
QUARANTINE_OUTPUT_BEFORE_REPLAY="$(rpc_output_fingerprint)"
psql_cmd -q -f "$QUARANTINE_MIGRATION"
QUARANTINE_METADATA_AFTER_REPLAY="$(function_metadata_fingerprint 'public.arena_records_page(text,text,text,integer,text,integer)')"
QUARANTINE_OUTPUT_AFTER_REPLAY="$(rpc_output_fingerprint)"

assert_equal "position-history records-page quarantine replay drifted" "$QUARANTINE_METADATA_BEFORE_REPLAY" "$QUARANTINE_METADATA_AFTER_REPLAY"
assert_equal "position-history records-page output replay drifted" "$QUARANTINE_OUTPUT_BEFORE_REPLAY" "$QUARANTINE_OUTPUT_AFTER_REPLAY"

echo "position-history records-page PostgreSQL 17 proof passed"
echo "record provenance clocks PostgreSQL 17 proof passed"
