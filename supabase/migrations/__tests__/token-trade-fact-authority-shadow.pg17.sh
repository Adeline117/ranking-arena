#!/usr/bin/env bash

# PostgreSQL 17 behavior proof for the private token-trade fact authority.
# It owns an isolated cluster and never reads or writes application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260730033000_token_trade_fact_authority_shadow.sql"
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

TMP_ROOT="$(mktemp -d /tmp/token-trade-authority-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((59000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -180 "$LOG_FILE" >&2 || true
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
CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE SCHEMA arena AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA arena TO anon, authenticated, service_role;

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  adapter_slug text NOT NULL,
  product_type text NOT NULL,
  currency text NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL
);

CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL
);

CREATE TABLE arena.raw_objects (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  job_type text NOT NULL,
  trader_id bigint,
  fetched_at timestamptz NOT NULL,
  content_hash text NOT NULL,
  quarantined boolean NOT NULL DEFAULT false,
  source_run_id text,
  trust_artifact_role text
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
  raw jsonb
);

GRANT SELECT ON arena.sources, arena.traders, arena.raw_objects,
  arena.position_history TO service_role;

INSERT INTO arena.sources (
  id, slug, adapter_slug, product_type, currency, status, serving_mode
) VALUES
  (1, 'binance_futures', 'binance', 'futures', 'USDT', 'active', 'serving'),
  (2, 'okx_futures', 'okx', 'futures', 'USDT', 'active', 'serving');
SQL

psql_db -q -f "$MIGRATION"

CONTRACT_ACL="$(psql_db -Atqc "
  SELECT
    pg_catalog.has_table_privilege(
      'service_role', 'arena.token_trade_source_contracts', 'SELECT'
    ) || '|' ||
    pg_catalog.has_table_privilege(
      'service_role', 'arena.token_trade_source_contracts', 'INSERT'
    ) || '|' ||
    pg_catalog.has_table_privilege(
      'anon', 'arena.token_trade_fact_authority_shadow', 'SELECT'
    ) || '|' ||
    relation.relowner::pg_catalog.regrole::text || '|' ||
    (relation.reloptions @> ARRAY[
      'security_invoker=true', 'security_barrier=true'
    ]::text[])
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid =
        'arena.token_trade_fact_authority_shadow'::pg_catalog.regclass;")"
assert_equal "private immutable contract/view boundary" "true|false|false|postgres|true" "$CONTRACT_ACL"

set +e
psql_db -q >"$ERROR_FILE" 2>&1 <<'SQL'
SET ROLE service_role;
UPDATE arena.token_trade_source_contracts
   SET active = false
 WHERE source_slug = 'binance_futures';
SQL
MUTATION_STATUS=$?
set -e
if ((MUTATION_STATUS == 0)); then
  echo "service_role unexpectedly mutated a migration-owned token contract" >&2
  exit 1
fi
rg -q 'permission denied for table token_trade_source_contracts' "$ERROR_FILE" || {
  echo "contract mutation failed for an unexpected reason" >&2
  sed -n '1,100p' "$ERROR_FILE" >&2
  exit 1
}

EVIDENCE_WRITE_ACL="$(psql_db -Atqc "
  SELECT
    pg_catalog.has_any_column_privilege(
      'service_role', 'arena.token_trade_fact_evidence', 'INSERT'
    ) || '|' ||
    pg_catalog.has_column_privilege(
      'service_role', 'arena.token_trade_fact_evidence', 'evidence_id', 'INSERT'
    ) || '|' ||
    pg_catalog.has_column_privilege(
      'service_role', 'arena.token_trade_fact_evidence', 'recorded_at', 'INSERT'
    ) || '|' ||
    pg_catalog.has_any_column_privilege(
      'service_role', 'arena.token_history_coverage_evidence', 'INSERT'
    ) || '|' ||
    pg_catalog.has_column_privilege(
      'service_role', 'arena.token_history_coverage_evidence',
      'coverage_evidence_id', 'INSERT'
    ) || '|' ||
    pg_catalog.has_column_privilege(
      'service_role', 'arena.token_history_coverage_evidence', 'recorded_at', 'INSERT'
    ) || '|' ||
    pg_catalog.has_any_column_privilege(
      'service_role', 'arena.token_trade_fx_evidence', 'INSERT'
    ) || '|' ||
    pg_catalog.has_column_privilege(
      'service_role', 'arena.token_trade_fx_evidence', 'fx_evidence_id', 'INSERT'
    ) || '|' ||
    pg_catalog.has_column_privilege(
      'service_role', 'arena.token_trade_fx_evidence', 'recorded_at', 'INSERT'
    );")"
assert_equal \
  "append ACL excludes generated identity and recorded_at columns" \
  "true|false|false|true|false|false|true|false|false" \
  "$EVIDENCE_WRITE_ACL"

assert_evidence_override_denied() {
  local relation="$1"
  local identity_column="$2"
  set +e
  psql_db -q >"$ERROR_FILE" 2>&1 -c "
    SET ROLE service_role;
    INSERT INTO $relation ($identity_column, recorded_at)
      OVERRIDING SYSTEM VALUE
    VALUES (900000, pg_catalog.clock_timestamp());"
  local mutation_status=$?
  set -e
  if ((mutation_status == 0)); then
    echo "service_role unexpectedly overrode $relation identity/time" >&2
    exit 1
  fi
  rg -q 'permission denied for table' "$ERROR_FILE" || {
    echo "$relation identity/time override failed for an unexpected reason" >&2
    sed -n '1,100p' "$ERROR_FILE" >&2
    exit 1
  }
}

assert_evidence_override_denied arena.token_trade_fact_evidence evidence_id
assert_evidence_override_denied \
  arena.token_history_coverage_evidence coverage_evidence_id
assert_evidence_override_denied arena.token_trade_fx_evidence fx_evidence_id

psql_db -q <<'SQL'
CREATE FUNCTION public.add_token_fact_proof(
  p_key integer,
  p_source_id integer,
  p_trader_id integer,
  p_token text,
  p_lifecycle_state text DEFAULT 'closed',
  p_pnl_trust_state text DEFAULT 'source_owned',
  p_price_trust_state text DEFAULT 'source_owned',
  p_cost_basis_trust_state text DEFAULT 'source_owned',
  p_fx_trust_state text DEFAULT 'verified',
  p_authority_method_version text DEFAULT NULL,
  p_pnl_provenance text DEFAULT 'source_reported',
  p_caller_limited boolean DEFAULT false,
  p_page_limited boolean DEFAULT false,
  p_retention_limited boolean DEFAULT false,
  p_incomplete_bounds boolean DEFAULT false,
  p_unknown_evaluator boolean DEFAULT false,
  p_source_age interval DEFAULT interval '1 hour',
  p_raw_digest_mismatch boolean DEFAULT false,
  p_raw_quarantined boolean DEFAULT false,
  p_raw_age interval DEFAULT interval '1 hour',
  p_window_end_lag interval DEFAULT interval '0 seconds',
  p_cross_run_coverage boolean DEFAULT false,
  p_scan_terminal_state text DEFAULT 'exhausted',
  p_closed_at timestamptz DEFAULT NULL,
  p_position_dedupe_hash text DEFAULT NULL,
  p_source_row_identity text DEFAULT NULL,
  p_insert_legacy_projection boolean DEFAULT true,
  p_omit_fx_artifact boolean DEFAULT false,
  p_source_lifecycle_marker text DEFAULT NULL,
  p_source_symbol text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_contract arena.token_trade_source_contracts%ROWTYPE;
  v_asset arena.token_assets%ROWTYPE;
  v_run_id text := pg_catalog.lpad(pg_catalog.to_hex(p_key), 64, 'a');
  v_coverage_run_id text;
  v_coverage_raw_object_id bigint;
  v_fx_run_id text := pg_catalog.lpad(pg_catalog.to_hex(p_key + 50000), 64, 'c');
  v_fx_raw_object_id bigint := p_key + 50000;
  v_fx_evidence_id bigint;
  v_content_hash text;
  v_closed_at timestamptz := COALESCE(
    p_closed_at,
    pg_catalog.statement_timestamp() - interval '2 days'
  );
  v_opened_at timestamptz;
  v_source_asset_locator text;
  v_source_symbol text;
  v_source_lifecycle_marker text;
  v_window_end timestamptz :=
    pg_catalog.statement_timestamp() - p_source_age - p_window_end_lag;
  v_source_as_of timestamptz := pg_catalog.statement_timestamp() - p_source_age;
  v_position_dedupe_hash text := COALESCE(
    p_position_dedupe_hash,
    'position-' || p_key::text
  );
  v_source_row_identity text := COALESCE(
    p_source_row_identity,
    'source-row-' || p_key::text
  );
BEGIN
  SELECT contract.*
    INTO STRICT v_contract
    FROM arena.token_trade_source_contracts AS contract
   WHERE contract.source_id = p_source_id;

  v_source_asset_locator := CASE v_contract.source_slug
    WHEN 'binance_futures' THEN p_token || 'USDT'
    WHEN 'okx_futures' THEN p_token || '-USDT-SWAP'
  END;
  IF v_contract.lifecycle_marker_rule = 'positive_epoch_ms' THEN
    v_closed_at := TIMESTAMPTZ 'epoch' +
      (pg_catalog.floor(EXTRACT(EPOCH FROM v_closed_at) * 1000)::bigint *
        interval '1 millisecond');
  END IF;
  v_source_symbol := COALESCE(p_source_symbol, v_source_asset_locator);
  v_source_lifecycle_marker := COALESCE(
    p_source_lifecycle_marker,
    CASE v_contract.lifecycle_marker_rule
      WHEN 'exact_literal' THEN v_contract.closed_lifecycle_marker_literal
      WHEN 'positive_epoch_ms' THEN
        pg_catalog.floor(EXTRACT(EPOCH FROM v_closed_at) * 1000)::bigint::text
    END
  );

  SELECT asset.*
    INTO STRICT v_asset
    FROM arena.token_trade_contract_assets AS mapping
    JOIN arena.token_assets AS asset
      ON asset.asset_id = mapping.asset_id
   WHERE mapping.contract_id = v_contract.contract_id
     AND mapping.source_asset_locator = v_source_asset_locator
     AND mapping.source_base_asset = p_token;

  v_content_hash := CASE
    WHEN p_raw_digest_mismatch THEN pg_catalog.repeat('f', 64)
    ELSE v_run_id
  END;
  v_opened_at := v_closed_at - interval '1 hour';
  v_coverage_run_id := CASE
    WHEN p_cross_run_coverage
      THEN pg_catalog.lpad(pg_catalog.to_hex(p_key + 20000), 64, 'b')
    ELSE v_run_id
  END;
  v_coverage_raw_object_id := CASE
    WHEN p_cross_run_coverage THEN p_key + 20000
    ELSE p_key
  END;

  INSERT INTO arena.traders (id, source_id, exchange_trader_id)
  VALUES (p_trader_id, p_source_id, 'proof-' || p_key::text);

  INSERT INTO arena.raw_objects (
    id, source_id, job_type, trader_id, fetched_at, content_hash, quarantined,
    source_run_id, trust_artifact_role
  ) VALUES (
    p_key,
    p_source_id,
    'history:position_history',
    p_trader_id,
    pg_catalog.statement_timestamp() - p_raw_age,
    v_content_hash,
    p_raw_quarantined,
    v_run_id,
    'event_history'
  );

  IF p_cross_run_coverage THEN
    INSERT INTO arena.raw_objects (
      id, source_id, job_type, trader_id, fetched_at, content_hash, quarantined,
      source_run_id, trust_artifact_role
    ) VALUES (
      v_coverage_raw_object_id,
      p_source_id,
      'history:position_history',
      p_trader_id,
      pg_catalog.statement_timestamp() - p_raw_age,
      v_coverage_run_id,
      false,
      v_coverage_run_id,
      'event_history'
    );
  END IF;

  IF p_fx_trust_state <> 'unknown' AND NOT p_omit_fx_artifact THEN
    SELECT fx.fx_evidence_id
      INTO v_fx_evidence_id
      FROM arena.token_trade_fx_evidence AS fx
     WHERE fx.contract_id = v_contract.contract_id
       AND fx.base_currency = 'USDT'
       AND fx.quote_currency = 'USD'
       AND fx.price_as_of = v_closed_at
     ORDER BY fx.fx_evidence_id DESC
     LIMIT 1;

    IF v_fx_evidence_id IS NULL THEN
      INSERT INTO arena.raw_objects (
      id, source_id, job_type, trader_id, fetched_at, content_hash, quarantined,
      source_run_id, trust_artifact_role
      ) VALUES (
        v_fx_raw_object_id,
        p_source_id,
        'price_history:USDT-USD',
        NULL,
        pg_catalog.statement_timestamp() - interval '1 hour',
        v_fx_run_id,
        false,
        v_fx_run_id,
        'price_history'
      );

      INSERT INTO arena.token_trade_fx_evidence (
        contract_id,
        source_id,
        source_run_id,
        source_raw_object_id,
        base_currency,
        quote_currency,
        fx_rate_to_usd,
        price_as_of,
        fx_provenance,
        fx_trust_state,
        fx_method_version,
        recorded_at,
        declared_blocker_reasons
      ) VALUES (
        v_contract.contract_id,
        p_source_id,
        v_fx_run_id,
        v_fx_raw_object_id,
        'USDT',
        'USD',
        1,
        v_closed_at,
        'arena_fx_snapshot',
        'verified',
        v_contract.fx_method_version,
        pg_catalog.statement_timestamp() - interval '30 minutes',
        ARRAY[]::text[]
      )
      RETURNING fx_evidence_id INTO v_fx_evidence_id;
    END IF;
  END IF;

  IF p_insert_legacy_projection THEN
    INSERT INTO arena.position_history (
      trader_id, opened_at, closed_at, symbol, side, entry_price, exit_price,
      realized_pnl, currency, dedupe_hash, raw
    ) VALUES (
      p_trader_id,
      v_opened_at,
      v_closed_at,
      v_source_symbol,
      'long',
      100,
      110,
      10,
      'USDT',
      v_position_dedupe_hash,
      '{"ignored":"never trusted"}'::jsonb
    );
  END IF;

  INSERT INTO arena.token_trade_fact_evidence (
    contract_id,
    source_id,
    trader_id,
    source_run_id,
    source_raw_object_id,
    source_row_identity,
    closed_at,
    position_dedupe_hash,
    source_symbol,
    source_asset_locator,
    asset_id,
    asset_namespace,
    asset_chain_id,
    asset_protocol_slug,
    token_address,
    normalized_token,
    token_normalization_state,
    token_normalization_method_version,
    opened_at,
    entry_price,
    exit_price,
    realized_pnl_source,
    reported_currency,
    fx_evidence_id,
    fx_rate_to_usd,
    lifecycle_state,
    source_lifecycle_marker,
    pnl_provenance,
    pnl_trust_state,
    price_provenance,
    price_trust_state,
    cost_basis_provenance,
    cost_basis_trust_state,
    fx_provenance,
    fx_trust_state,
    authority_method_version,
    recorded_at,
    declared_blocker_reasons
  ) VALUES (
    v_contract.contract_id,
    p_source_id,
    p_trader_id,
    v_run_id,
    p_key,
    v_source_row_identity,
    v_closed_at,
    v_position_dedupe_hash,
    v_source_symbol,
    v_source_asset_locator,
    v_asset.asset_id,
    v_asset.asset_namespace,
    v_asset.chain_id,
    v_asset.protocol_slug,
    v_asset.token_address,
    p_token,
    'normalized',
    v_contract.token_normalization_method_version,
    v_opened_at,
    100,
    110,
    10,
    'USDT',
    v_fx_evidence_id,
    CASE WHEN p_fx_trust_state = 'unknown' THEN NULL ELSE 1 END,
    p_lifecycle_state,
    v_source_lifecycle_marker,
    p_pnl_provenance,
    p_pnl_trust_state,
    'source_reported',
    p_price_trust_state,
    'source_reported',
    p_cost_basis_trust_state,
    'arena_fx_snapshot',
    p_fx_trust_state,
    COALESCE(p_authority_method_version, v_contract.fact_authority_method_version),
    pg_catalog.statement_timestamp() - interval '30 minutes',
    ARRAY[]::text[]
  );

  INSERT INTO arena.token_history_coverage_evidence (
    contract_id,
    source_id,
    trader_id,
    source_run_id,
    source_raw_object_id,
    asset_id,
    normalized_token,
    window_days,
    window_start_at,
    window_end_at,
    covered_from_at,
    covered_through_at,
    source_as_of,
    evaluator_state,
    scan_terminal_state,
    terminal_cursor_value,
    overlap_closed_at,
    caller_limited,
    page_limited,
    retention_limited,
    observed_closed_row_count,
    coverage_evaluator_method_version,
    recorded_at,
    declared_blocker_reasons
  )
  SELECT
    v_contract.contract_id,
    p_source_id,
    p_trader_id,
    v_coverage_run_id,
    v_coverage_raw_object_id,
    v_asset.asset_id,
    p_token,
    window_row.window_days,
    v_window_end - (window_row.window_days::integer * interval '1 day'),
    v_window_end,
    CASE WHEN p_incomplete_bounds THEN
      v_window_end - (window_row.window_days::integer * interval '1 day') +
        interval '1 day'
      ELSE v_window_end - (window_row.window_days::integer * interval '1 day')
    END,
    v_window_end,
    v_source_as_of,
    CASE WHEN p_unknown_evaluator THEN 'unknown' ELSE 'evaluated' END,
    p_scan_terminal_state,
    CASE WHEN p_scan_terminal_state = 'cursor_overlap' THEN 'cursor-proof'
      ELSE NULL END,
    CASE WHEN p_scan_terminal_state = 'cursor_overlap' THEN
      v_window_end - (window_row.window_days::integer * interval '1 day')
      ELSE NULL END,
    p_caller_limited,
    p_page_limited,
    p_retention_limited,
    1,
    v_contract.coverage_evaluator_method_version,
    pg_catalog.statement_timestamp() - interval '15 minutes',
    ARRAY[]::text[]
  FROM (VALUES (7::smallint), (30::smallint), (90::smallint)) AS window_row(window_days);
END
$function$;

CREATE FUNCTION public.append_token_fact_version(
  p_trader_id bigint,
  p_lifecycle_state text,
  p_closed_at timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $function$
  INSERT INTO arena.token_trade_fact_evidence (
    contract_id, source_id, trader_id, source_run_id, source_raw_object_id,
    source_row_identity, closed_at, position_dedupe_hash, source_symbol,
    source_asset_locator, asset_id, asset_namespace, asset_chain_id,
    asset_protocol_slug, token_address, normalized_token,
    token_normalization_state, token_normalization_method_version, opened_at,
    entry_price, exit_price, realized_pnl_source, reported_currency,
    fx_evidence_id, fx_rate_to_usd, lifecycle_state, source_lifecycle_marker,
    pnl_provenance,
    pnl_trust_state, price_provenance, price_trust_state,
    cost_basis_provenance, cost_basis_trust_state, fx_provenance,
    fx_trust_state, authority_method_version, recorded_at,
    declared_blocker_reasons
  )
  SELECT
    current.contract_id,
    current.source_id,
    current.trader_id,
    current.source_run_id,
    current.source_raw_object_id,
    current.source_row_identity,
    COALESCE(p_closed_at, current.closed_at),
    current.position_dedupe_hash,
    current.source_symbol,
    current.source_asset_locator,
    current.asset_id,
    current.asset_namespace,
    current.asset_chain_id,
    current.asset_protocol_slug,
    current.token_address,
    current.normalized_token,
    current.token_normalization_state,
    current.token_normalization_method_version,
    CASE WHEN p_closed_at IS NULL THEN current.opened_at
      ELSE p_closed_at - interval '1 hour' END,
    current.entry_price,
    current.exit_price,
    current.realized_pnl_source,
    current.reported_currency,
    current.fx_evidence_id,
    current.fx_rate_to_usd,
    p_lifecycle_state,
    CASE
      WHEN p_closed_at IS NULL THEN current.source_lifecycle_marker
      WHEN current.source_id = 2 THEN
        pg_catalog.floor(EXTRACT(EPOCH FROM p_closed_at) * 1000)::bigint::text
      ELSE current.source_lifecycle_marker
    END,
    current.pnl_provenance,
    current.pnl_trust_state,
    current.price_provenance,
    current.price_trust_state,
    current.cost_basis_provenance,
    current.cost_basis_trust_state,
    current.fx_provenance,
    current.fx_trust_state,
    current.authority_method_version,
    pg_catalog.clock_timestamp(),
    ARRAY[]::text[]
  FROM arena.token_trade_fact_evidence AS current
  WHERE current.trader_id = p_trader_id
  ORDER BY current.recorded_at DESC, current.evidence_id DESC
  LIMIT 1;
$function$;

-- The two reviewed active+serving source contracts can produce shadow facts.
SELECT public.add_token_fact_proof(1001, 1, 101, 'BTC');
SELECT public.add_token_fact_proof(1002, 2, 102, 'ETH');

-- Each failure mode gets its own trader/token so latest-coverage selection is
-- deterministic and the blocker is independently observable.
SELECT public.add_token_fact_proof(
  1003, 1, 103, 'SOL', p_lifecycle_state => 'partial'
);
SELECT public.add_token_fact_proof(
  1004, 1, 104, 'BNB', p_price_trust_state => 'unknown'
);
SELECT public.add_token_fact_proof(
  1005, 1, 105, 'XRP', p_cost_basis_trust_state => 'unknown'
);
SELECT public.add_token_fact_proof(
  1006, 1, 106, 'ADA', p_fx_trust_state => 'unknown'
);
SELECT public.add_token_fact_proof(
  1007, 1, 107, 'DOGE', p_caller_limited => true
);
SELECT public.add_token_fact_proof(
  1008, 1, 108, 'AVAX', p_page_limited => true
);
SELECT public.add_token_fact_proof(
  1009, 2, 109, 'LINK', p_incomplete_bounds => true
);
SELECT public.add_token_fact_proof(
  1010, 2, 110, 'DOT', p_unknown_evaluator => true
);
SELECT public.add_token_fact_proof(
  1011, 2, 111, 'LTC', p_source_age => interval '30 hours'
);
SELECT public.add_token_fact_proof(
  1012, 2, 112, 'UNI', p_retention_limited => true
);
SELECT public.add_token_fact_proof(
  1013,
  2,
  113,
  'ATOM',
  p_pnl_trust_state => 'verified',
  p_authority_method_version => 'forged.writer-contract@9',
  p_pnl_provenance => 'arena_rebuilt'
);
SELECT public.add_token_fact_proof(
  1014, 2, 114, 'NEAR', p_raw_digest_mismatch => true
);
SELECT public.add_token_fact_proof(
  1015, 1, 115, 'BTC', p_scan_terminal_state => 'unknown'
);
SELECT public.add_token_fact_proof(
  1016, 1, 116, 'BTC', p_raw_quarantined => true
);
SELECT public.add_token_fact_proof(
  1017, 2, 117, 'ETH', p_raw_age => interval '30 hours'
);
SELECT public.add_token_fact_proof(
  1018, 2, 118, 'ETH', p_window_end_lag => interval '30 hours'
);
SELECT public.add_token_fact_proof(
  1019, 2, 119, 'ETH', p_cross_run_coverage => true
);
SELECT public.add_token_fact_proof(
  1020, 1, 120, 'BTC', p_omit_fx_artifact => true
);
SELECT public.add_token_fact_proof(
  1026, 1, 126, 'BTC', p_source_lifecycle_marker => 'Partially Closed'
);
SELECT public.add_token_fact_proof(
  1027, 2, 127, 'ETH', p_source_lifecycle_marker => '1700000000000'
);
SELECT public.add_token_fact_proof(
  1028, 1, 128, 'BTC', p_source_symbol => 'ETHUSDT'
);

-- A legacy row has no typed fact or coverage evidence at all.
INSERT INTO arena.traders (id, source_id, exchange_trader_id)
VALUES (199, 1, 'legacy-unattested');
INSERT INTO arena.position_history (
  trader_id, opened_at, closed_at, symbol, side, entry_price, exit_price,
  realized_pnl, currency, dedupe_hash, raw
) VALUES (
  199,
  pg_catalog.statement_timestamp() - interval '3 days',
  pg_catalog.statement_timestamp() - interval '2 days',
  'MATICUSDT',
  'long',
  1,
  2,
  1,
  'USDT',
  'legacy-position',
  '{"claimedTrusted":true}'::jsonb
);
SQL

ELIGIBLE="$(psql_db -Atqc "
  SET ROLE service_role;
  SELECT pg_catalog.string_agg(
    source_slug || ':' || token || ':' || authority_state,
    ',' ORDER BY source_slug
  )
  FROM arena.token_trade_fact_authority_shadow
  WHERE window_days = 90 AND rank_eligible;")"
assert_equal \
  "reviewed active+serving Binance/OKX facts" \
  "binance_futures:BTC:complete,okx_futures:ETH:complete" \
  "$ELIGIBLE"

THREE_WINDOWS="$(psql_db -Atqc "
  SET ROLE service_role;
  SELECT pg_catalog.string_agg(window_days::text, ',' ORDER BY window_days)
  FROM arena.token_trade_fact_authority_shadow
  WHERE source_trader_id = 'proof-1001' AND rank_eligible;")"
assert_equal "independent recent 7/30/90 windows" "7,30,90" "$THREE_WINDOWS"

BLOCKERS="$(psql_db -Atqc "
  SET ROLE service_role;
  SELECT pg_catalog.string_agg(
    source_trader_id || ':' || expected.blocker || ':' ||
      (pg_catalog.array_position(authority.blocker_reasons, expected.blocker)
       IS NOT NULL)::text,
    ',' ORDER BY source_trader_id
  )
  FROM arena.token_trade_fact_authority_shadow AS authority
  JOIN (VALUES
    ('proof-1003', 'lifecycle_partial'),
    ('proof-1004', 'price_unknown'),
    ('proof-1005', 'cost_basis_unknown'),
    ('proof-1006', 'fx_unknown'),
    ('proof-1007', 'history_caller_limited'),
    ('proof-1008', 'history_page_limited'),
    ('proof-1009', 'history_bounds_incomplete'),
    ('proof-1010', 'history_unknown'),
    ('proof-1011', 'coverage_stale'),
    ('proof-1012', 'history_retention_limited'),
    ('proof-1013', 'fact_method_or_provenance_mismatch'),
    ('proof-1014', 'fact_raw_lineage_mismatch'),
    ('proof-1015', 'history_scan_incomplete'),
    ('proof-1016', 'fact_raw_quarantined'),
    ('proof-1017', 'coverage_raw_capture_time_mismatch'),
    ('proof-1018', 'window_end_source_as_of_mismatch'),
    ('proof-1019', 'coverage_fact_run_mismatch'),
    ('proof-1020', 'fx_evidence_missing'),
    ('proof-1026', 'source_lifecycle_marker_mismatch'),
    ('proof-1027', 'source_lifecycle_marker_mismatch'),
    ('proof-1028', 'source_instrument_mapping_mismatch')
  ) AS expected(trader_id, blocker)
    ON expected.trader_id = authority.source_trader_id
  WHERE authority.window_days = 90;")"
assert_equal \
  "typed fail-closed blocker matrix" \
  "proof-1003:lifecycle_partial:true,proof-1004:price_unknown:true,proof-1005:cost_basis_unknown:true,proof-1006:fx_unknown:true,proof-1007:history_caller_limited:true,proof-1008:history_page_limited:true,proof-1009:history_bounds_incomplete:true,proof-1010:history_unknown:true,proof-1011:coverage_stale:true,proof-1012:history_retention_limited:true,proof-1013:fact_method_or_provenance_mismatch:true,proof-1014:fact_raw_lineage_mismatch:true,proof-1015:history_scan_incomplete:true,proof-1016:fact_raw_quarantined:true,proof-1017:coverage_raw_capture_time_mismatch:true,proof-1018:window_end_source_as_of_mismatch:true,proof-1019:coverage_fact_run_mismatch:true,proof-1020:fx_evidence_missing:true,proof-1026:source_lifecycle_marker_mismatch:true,proof-1027:source_lifecycle_marker_mismatch:true,proof-1028:source_instrument_mapping_mismatch:true" \
  "$BLOCKERS"

BAD_ELIGIBLE_COUNT="$(psql_db -Atqc "
  SET ROLE service_role;
  SELECT pg_catalog.count(*)
  FROM arena.token_trade_fact_authority_shadow
  WHERE window_days = 90
    AND source_trader_id IN (
      'proof-1003', 'proof-1004', 'proof-1005', 'proof-1006',
      'proof-1007', 'proof-1008', 'proof-1009', 'proof-1010',
      'proof-1011', 'proof-1012', 'proof-1013', 'proof-1014',
      'proof-1015', 'proof-1016', 'proof-1017', 'proof-1018',
      'proof-1019', 'proof-1020', 'proof-1026', 'proof-1027', 'proof-1028'
    )
    AND rank_eligible;")"
assert_equal "all partial/unknown/forged rows excluded" "0" "$BAD_ELIGIBLE_COUNT"

LEGACY="$(psql_db -Atqc "
  SET ROLE service_role;
  SELECT authority_state || '|' || history_completeness_state || '|' ||
    token_normalization_state || '|' || rank_eligible || '|' ||
    (pg_catalog.array_position(blocker_reasons, 'legacy_position_unattested')
      IS NOT NULL)
  FROM arena.token_trade_fact_authority_shadow
  WHERE source_trader_id = 'legacy-unattested' AND window_days = 90;")"
assert_equal "legacy row defaults" "unknown|unknown|unknown|false|true" "$LEGACY"

ASSET_IDENTITY="$(psql_db -Atqc "
  SELECT canonical_ticker || '|' || pg_catalog.count(DISTINCT asset_id) || '|' ||
    pg_catalog.count(DISTINCT chain_id) || '|' ||
    pg_catalog.count(DISTINCT token_address)
  FROM arena.token_assets
  WHERE canonical_ticker = 'USDC'
  GROUP BY canonical_ticker;")"
assert_equal "same ticker on different chains remains distinct" "USDC|2|2|2" "$ASSET_IDENTITY"

INSTRUMENT_MAPPING="$(psql_db -Atqc "
  SELECT pg_catalog.string_agg(
    contract.source_slug || ':' || mapping.source_asset_locator,
    ',' ORDER BY contract.source_slug
  )
  FROM arena.token_trade_contract_assets AS mapping
  JOIN arena.token_trade_source_contracts AS contract
    ON contract.contract_id = mapping.contract_id
  WHERE mapping.source_base_asset = 'BTC';")"
assert_equal \
  "contract-owned exact CEX instrument locators" \
  "binance_futures:BTCUSDT,okx_futures:BTC-USDT-SWAP" \
  "$INSTRUMENT_MAPPING"

psql_db -q <<'SQL'
DO $hard_type_guards$
BEGIN
  BEGIN
    UPDATE arena.token_trade_fact_evidence
       SET entry_price = 'NaN'::numeric
     WHERE trader_id = 101;
    RAISE EXCEPTION 'numeric NaN unexpectedly passed fact constraints';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE arena.token_trade_fact_evidence
       SET realized_pnl_source = 'Infinity'::numeric
     WHERE trader_id = 101;
    RAISE EXCEPTION 'numeric Infinity unexpectedly passed fact constraints';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE arena.token_trade_fx_evidence
       SET fx_rate_to_usd = 'Infinity'::numeric
     WHERE source_id = 1;
    RAISE EXCEPTION 'numeric Infinity unexpectedly passed FX constraints';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO arena.token_assets (
      asset_id, asset_namespace, canonical_ticker, chain_id, token_address
    ) VALUES ('invalid:null-chain', 'evm', 'BAD', NULL, '0x1');
    RAISE EXCEPTION 'NULL on-chain identity unexpectedly passed asset constraints';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE arena.token_trade_fact_evidence
       SET asset_namespace = 'evm',
           asset_chain_id = NULL,
           token_address = '0x1'
     WHERE trader_id = 101;
    RAISE EXCEPTION 'NULL fact chain identity unexpectedly passed constraints';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE arena.token_history_coverage_evidence
       SET covered_through_at = source_as_of + interval '1 second'
     WHERE trader_id = 101 AND window_days = 90;
    RAISE EXCEPTION 'coverage beyond source_as_of unexpectedly passed constraints';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$hard_type_guards$;
SQL

psql_db -q <<'SQL'
SELECT public.add_token_fact_proof(
  1021,
  1,
  121,
  'BTC',
  p_closed_at => TIMESTAMPTZ '2026-07-28 00:00:00+00',
  p_position_dedupe_hash => 'shared-global-dedupe',
  p_source_row_identity => 'binance-row-collision-a'
);
SELECT public.add_token_fact_proof(
  1022,
  1,
  122,
  'BTC',
  p_closed_at => TIMESTAMPTZ '2026-07-28 00:00:00+00',
  p_position_dedupe_hash => 'shared-global-dedupe',
  p_source_row_identity => 'binance-row-collision-b',
  p_insert_legacy_projection => false
);
SQL

COLLISION_FACTS="$(psql_db -Atqc "
  SET ROLE service_role;
  SELECT pg_catalog.count(*) || '|' ||
    pg_catalog.count(DISTINCT trader_id) || '|' ||
    pg_catalog.count(DISTINCT source_row_identity) || '|' ||
    pg_catalog.count(*) FILTER (WHERE legacy_projection_state = 'missing')
  FROM arena.token_trade_fact_authority_shadow
  WHERE window_days = 90
    AND position_dedupe_hash = 'shared-global-dedupe'
    AND rank_eligible;")"
assert_equal \
  "authority identity survives global legacy collision" \
  "2|2|2|1" \
  "$COLLISION_FACTS"

psql_db -q <<'SQL'
SELECT public.add_token_fact_proof(
  1023,
  2,
  123,
  'ETH',
  p_lifecycle_state => 'partial',
  p_source_row_identity => 'okx-partial-final-row'
);
SELECT public.append_token_fact_version(123, 'closed');
SQL

FINAL_PROMOTED="$(psql_db -Atqc "
  SET ROLE service_role;
  SELECT rank_eligible || '|' || authority_state || '|' || lifecycle_state
  FROM arena.token_trade_fact_authority_shadow
  WHERE source_trader_id = 'proof-1023' AND window_days = 90;")"
assert_equal "newer final version promotes partial identity" "true|complete|closed" "$FINAL_PROMOTED"

psql_db -q -c "SELECT public.append_token_fact_version(123, 'partial');"
PARTIAL_SUPPRESSES="$(psql_db -Atqc "
  SET ROLE service_role;
  SELECT rank_eligible || '|' || authority_state || '|' || lifecycle_state || '|' ||
    (pg_catalog.array_position(blocker_reasons, 'lifecycle_partial') IS NOT NULL)
  FROM arena.token_trade_fact_authority_shadow
  WHERE source_trader_id = 'proof-1023' AND window_days = 90;")"
assert_equal \
  "newer partial version suppresses older final version" \
  "false|partial|partial|true" \
  "$PARTIAL_SUPPRESSES"

psql_db -q <<'SQL'
SELECT public.add_token_fact_proof(
  1024,
  2,
  124,
  'ETH',
  p_source_row_identity => 'okx-out-of-window-row'
);
SELECT public.append_token_fact_version(
  124,
  'closed',
  pg_catalog.statement_timestamp() - interval '100 days'
);
SQL

OUT_OF_WINDOW_RESURRECTION="$(psql_db -Atqc "
  SET ROLE service_role;
  SELECT pg_catalog.count(*) FILTER (WHERE rank_eligible) || '|' ||
    pg_catalog.count(*) FILTER (WHERE authority_state = 'unknown')
  FROM arena.token_trade_fact_authority_shadow
  WHERE source_trader_id = 'proof-1024' AND window_days = 90;")"
assert_equal \
  "newer out-of-window version cannot resurrect old complete fact" \
  "0|1" \
  "$OUT_OF_WINDOW_RESURRECTION"

psql_db -q -c "UPDATE arena.sources SET serving_mode = 'shadow' WHERE id = 1;"
SHADOW_ELIGIBLE="$(psql_db -Atqc "
  SET ROLE service_role;
  SELECT pg_catalog.count(*)
  FROM arena.token_trade_fact_authority_shadow
  WHERE source_id = 1 AND window_days = 90 AND rank_eligible;")"
assert_equal "shadow source exclusion" "0" "$SHADOW_ELIGIBLE"
psql_db -q -c "UPDATE arena.sources SET serving_mode = 'serving' WHERE id = 1;"

psql_db -q -c "UPDATE arena.sources SET status = 'inactive' WHERE id = 2;"
INACTIVE_ELIGIBLE="$(psql_db -Atqc "
  SET ROLE service_role;
  SELECT pg_catalog.count(*)
  FROM arena.token_trade_fact_authority_shadow
  WHERE source_id = 2 AND window_days = 90 AND rank_eligible;")"
assert_equal "inactive source exclusion" "0" "$INACTIVE_ELIGIBLE"
psql_db -q -c "UPDATE arena.sources SET status = 'active' WHERE id = 2;"

# A later identity row remains authoritative even when its caller-controlled
# recorded_at is backdated; unknown must suppress the older trusted fact.
psql_db -q <<'SQL'
INSERT INTO arena.token_trade_fact_evidence (
  contract_id, source_id, trader_id, source_run_id, source_raw_object_id,
  source_row_identity, closed_at, position_dedupe_hash, source_symbol,
  source_asset_locator, asset_id, asset_namespace, asset_chain_id,
  asset_protocol_slug, token_address, normalized_token, token_normalization_state,
  token_normalization_method_version, opened_at, entry_price, exit_price,
  realized_pnl_source, reported_currency, fx_evidence_id, fx_rate_to_usd,
  lifecycle_state, source_lifecycle_marker,
  pnl_provenance, pnl_trust_state, price_provenance, price_trust_state,
  cost_basis_provenance, cost_basis_trust_state, fx_provenance,
  fx_trust_state, authority_method_version, recorded_at,
  declared_blocker_reasons
)
SELECT
  contract_id, source_id, trader_id, source_run_id, source_raw_object_id,
  source_row_identity, closed_at, position_dedupe_hash, source_symbol,
  source_asset_locator, asset_id, asset_namespace, asset_chain_id,
  asset_protocol_slug, token_address, NULL, 'unknown',
  token_normalization_method_version, opened_at, entry_price,
  exit_price, realized_pnl_source, reported_currency, fx_evidence_id, fx_rate_to_usd,
  lifecycle_state, source_lifecycle_marker, pnl_provenance, pnl_trust_state,
  price_provenance,
  price_trust_state, cost_basis_provenance, cost_basis_trust_state,
  fx_provenance, fx_trust_state, authority_method_version,
  pg_catalog.statement_timestamp() - interval '2 hours', ARRAY[]::text[]
FROM arena.token_trade_fact_evidence
WHERE trader_id = 101
ORDER BY evidence_id DESC
LIMIT 1;
SQL

RESURRECTED="$(psql_db -Atqc "
  SET ROLE service_role;
  SELECT rank_eligible || '|' || authority_state || '|' ||
    (pg_catalog.array_position(blocker_reasons, 'token_normalization_unknown')
      IS NOT NULL)
  FROM arena.token_trade_fact_authority_shadow
  WHERE source_trader_id = 'proof-1001' AND window_days = 90;")"
assert_equal \
  "backdated newer unknown fact suppresses older trusted fact" \
  "false|partial|true" \
  "$RESURRECTED"

psql_db -q <<'SQL'
INSERT INTO arena.token_history_coverage_evidence (
  contract_id, source_id, trader_id, source_run_id, source_raw_object_id,
  asset_id, normalized_token, window_days, window_start_at, window_end_at,
  covered_from_at, covered_through_at, source_as_of, evaluator_state,
  scan_terminal_state, terminal_cursor_value, overlap_closed_at,
  caller_limited, page_limited, retention_limited, observed_closed_row_count,
  coverage_evaluator_method_version, recorded_at, declared_blocker_reasons
)
SELECT
  contract_id, source_id, trader_id, source_run_id, source_raw_object_id,
  asset_id, normalized_token, window_days,
  pg_catalog.statement_timestamp() - interval '3 hours' -
    (window_days::integer * interval '1 day'),
  pg_catalog.statement_timestamp() - interval '3 hours',
  pg_catalog.statement_timestamp() - interval '3 hours' -
    (window_days::integer * interval '1 day'),
  pg_catalog.statement_timestamp() - interval '3 hours',
  pg_catalog.statement_timestamp() - interval '3 hours',
  'unknown', 'unknown', NULL, NULL, false, false, false,
  observed_closed_row_count, coverage_evaluator_method_version,
  pg_catalog.statement_timestamp() - interval '2 hours', ARRAY[]::text[]
FROM arena.token_history_coverage_evidence
WHERE trader_id = 102 AND window_days = 90
ORDER BY coverage_evidence_id DESC
LIMIT 1;
SQL

BACKDATED_COVERAGE="$(psql_db -Atqc "
  SET ROLE service_role;
  SELECT rank_eligible || '|' || authority_state || '|' ||
    (pg_catalog.array_position(blocker_reasons, 'history_unknown') IS NOT NULL)
  FROM arena.token_trade_fact_authority_shadow
  WHERE source_trader_id = 'proof-1002' AND window_days = 90;")"
assert_equal \
  "backdated newer unknown coverage suppresses older complete coverage" \
  "false|partial|true" \
  "$BACKDATED_COVERAGE"

psql_db -q <<'SQL'
SELECT public.add_token_fact_proof(1029, 1, 129, 'BTC');

INSERT INTO arena.raw_objects (
  id, source_id, job_type, trader_id, fetched_at, content_hash, quarantined,
  source_run_id, trust_artifact_role
) VALUES (
  61029, 1, 'price_history:USDT-USD', NULL,
  pg_catalog.statement_timestamp() - interval '30 minutes',
  pg_catalog.repeat('e', 64), false, pg_catalog.repeat('e', 64), 'price_history'
);

INSERT INTO arena.token_trade_fx_evidence (
  contract_id, source_id, source_run_id, source_raw_object_id, base_currency,
  quote_currency, fx_rate_to_usd, price_as_of, fx_provenance, fx_trust_state,
  fx_method_version, recorded_at, declared_blocker_reasons
)
SELECT
  fx.contract_id, fx.source_id, pg_catalog.repeat('e', 64), 61029,
  fx.base_currency, fx.quote_currency, NULL, fx.price_as_of,
  fx.fx_provenance, 'unknown', fx.fx_method_version,
  pg_catalog.statement_timestamp(), ARRAY['price_correction_under_review']::text[]
FROM arena.token_trade_fx_evidence AS fx
JOIN arena.token_trade_fact_evidence AS fact
  ON fact.fx_evidence_id = fx.fx_evidence_id
WHERE fact.trader_id = 129
ORDER BY fact.evidence_id DESC
LIMIT 1;
SQL

FX_CORRECTION="$(psql_db -Atqc "
  SET ROLE service_role;
  SELECT rank_eligible || '|' || authority_state || '|' ||
    (pg_catalog.array_position(blocker_reasons, 'fx_evidence_superseded') IS NOT NULL)
  FROM arena.token_trade_fact_authority_shadow
  WHERE source_trader_id = 'proof-1029' AND window_days = 90;")"
assert_equal \
  "newer unknown FX correction withdraws old verified FX" \
  "false|partial|true" \
  "$FX_CORRECTION"

psql_db -q -c "DELETE FROM arena.raw_objects WHERE id = 61029;"
FX_CORRECTION_TOMBSTONE="$(psql_db -Atqc "
  SET ROLE service_role;
  SELECT authority.rank_eligible || '|' ||
    (pg_catalog.array_position(
      authority.blocker_reasons, 'fx_evidence_superseded'
    ) IS NOT NULL) || '|' ||
    (latest_fx.source_raw_object_id IS NULL)
  FROM arena.token_trade_fact_authority_shadow AS authority
  CROSS JOIN LATERAL (
    SELECT fx.source_raw_object_id
    FROM arena.token_trade_fx_evidence AS fx
    WHERE fx.contract_id = 'binance-futures-position-history@1'
      AND fx.fx_trust_state = 'unknown'
    ORDER BY fx.fx_evidence_id DESC
    LIMIT 1
  ) AS latest_fx
  WHERE authority.source_trader_id = 'proof-1029'
    AND authority.window_days = 90;")"
assert_equal \
  "FX RAW GC preserves correction tombstone and cannot revive verified FX" \
  "false|true|true" \
  "$FX_CORRECTION_TOMBSTONE"

# RAW garbage collection must preserve the latest identity tombstones. Removing
# the bound digest nulls lineage and remains fail-closed instead of deleting the
# latest evidence and allowing an older complete version to reappear.
psql_db -q -c "SELECT public.add_token_fact_proof(1025, 1, 125, 'BTC');"
BEFORE_RAW_GC="$(psql_db -Atqc "
  SET ROLE service_role;
  SELECT pg_catalog.count(*)
  FROM arena.token_trade_fact_authority_shadow
  WHERE source_trader_id = 'proof-1025'
    AND window_days = 90
    AND rank_eligible;")"
assert_equal "precondition: RAW-bound authority is eligible" "1" "$BEFORE_RAW_GC"

psql_db -q -c "DELETE FROM arena.raw_objects WHERE id = 1025;"
AFTER_RAW_GC="$(psql_db -Atqc "
  SET ROLE service_role;
  SELECT
    (SELECT pg_catalog.count(*)
       FROM arena.token_trade_fact_evidence
      WHERE trader_id = 125) || '|' ||
    (SELECT pg_catalog.count(*)
       FROM arena.token_history_coverage_evidence
      WHERE trader_id = 125) || '|' ||
    authority_state || '|' || history_completeness_state || '|' ||
    rank_eligible || '|' ||
    (pg_catalog.array_position(blocker_reasons, 'fact_raw_lineage_mismatch')
      IS NOT NULL) || '|' ||
    (pg_catalog.array_position(blocker_reasons, 'coverage_raw_lineage_mismatch')
      IS NOT NULL)
  FROM arena.token_trade_fact_authority_shadow
  WHERE source_trader_id = 'proof-1025' AND window_days = 90;")"
assert_equal \
  "RAW retention preserves latest fail-closed evidence tombstones" \
  "1|3|partial|complete|false|true|true" \
  "$AFTER_RAW_GC"

echo "token trade fact authority shadow PostgreSQL 17 proof passed"
