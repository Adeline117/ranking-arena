#!/usr/bin/env bash
# PG17 proof for 20261114211033 (board metric contracts, predeploy) and
# 20261114211034 (attempt-bound V3 capture registration, postdeploy):
#   - capture registration refuses before the metric contracts exist
#   - metric contract rows equal the lib/metric-trust.ts registry exactly
#   - both migrations are append-only (a replay refuses, no partial rows)
#   - absent sources are skipped; adapter drift and an uncovered native
#     window refuse the whole migration

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
METRICS="$ROOT_DIR/supabase/migrations/20261114211033_public_source_board_metric_contracts.sql"
CAPTURE="$ROOT_DIR/supabase/migrations/20261114211034_public_source_attempt_bound_capture_contracts.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql createdb; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/public-source-capture-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((52000 + ($$ % 5000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -80 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_db() {
  local db="$1"
  shift
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d "$db" "$@"
}

expect_failure() {
  local db="$1" file="$2" label="$3" expected="$4"
  if psql_db "$db" -q -f "$file" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if [[ "$(<"$ERROR_FILE")" != *"$expected"* ]]; then
    echo "$label failed for the wrong reason; expected: $expected" >&2
    cat "$ERROR_FILE" >&2
    exit 1
  fi
}

assert_equal() {
  if [[ "$2" != "$3" ]]; then
    echo "FAIL: $1" >&2
    echo "  expected: $2" >&2
    echo "  actual:   $3" >&2
    exit 1
  fi
  echo "ok: $1"
}

"$PG_BIN/initdb" -D "$DATA_DIR" -U postgres --auth=trust >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" -w \
  -o "-k $SOCKET_DIR -p $PORT -c listen_addresses=''" start >/dev/null

# Registry tables as installed by 20260721120000 (metric contracts) and
# 20260722030000/040000/20260729012000 (capture contracts, V2-V4 check).
psql_db postgres -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA arena;

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  adapter_slug text NOT NULL,
  timeframes_native integer[] NOT NULL,
  currency text NOT NULL CHECK (currency IN ('USDT', 'USDx', 'USDC', 'USD'))
);

CREATE TABLE arena.metric_source_contracts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id) ON DELETE RESTRICT,
  contract_version text NOT NULL CHECK (pg_catalog.btrim(contract_version) <> ''),
  metric text NOT NULL CHECK (metric IN ('roi', 'pnl', 'win_rate', 'mdd', 'sharpe')),
  field_path text NOT NULL CHECK (pg_catalog.btrim(field_path) <> ''),
  provenance text NOT NULL CHECK (
    provenance IN ('source_reported', 'source_normalized', 'arena_rebuilt', 'derived')
  ),
  methodology_version text NOT NULL CHECK (pg_catalog.btrim(methodology_version) <> ''),
  metric_set_id text NOT NULL CHECK (pg_catalog.btrim(metric_set_id) <> ''),
  timeframes smallint[] NOT NULL CHECK (
    pg_catalog.cardinality(timeframes) > 0
    AND timeframes <@ ARRAY[7, 30, 90]::smallint[]
    AND pg_catalog.array_position(timeframes, NULL) IS NULL
  ),
  value_unit text NOT NULL CHECK (value_unit IN ('percent', 'currency', 'ratio')),
  currencies text[] NOT NULL CHECK (
    pg_catalog.cardinality(currencies) > 0
    AND currencies <@ ARRAY['USDT', 'USDx', 'USDC', 'USD']::text[]
  ),
  required_raw_roles text[] NOT NULL,
  source_payload_scope text NOT NULL CHECK (
    source_payload_scope IN ('population_snapshot', 'metric_payload', 'not_required')
  ),
  max_freshness interval NOT NULL CHECK (max_freshness > interval '0 seconds'),
  max_window_end_lag interval NOT NULL CHECK (max_window_end_lag >= interval '0 seconds'),
  allow_derived_population boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (source_id, contract_version, metric, field_path, provenance, methodology_version),
  CHECK (
    (source_payload_scope = 'not_required')
    = NOT ('source_payload' = ANY (required_raw_roles))
  )
);

CREATE TABLE arena.leaderboard_capture_contracts (
  source_id smallint NOT NULL REFERENCES arena.sources(id) ON DELETE RESTRICT,
  capture_contract text NOT NULL,
  adapter_slug text NOT NULL,
  attempt_binding_contract text NOT NULL CHECK (
    attempt_binding_contract = 'arena.ingest.leaderboard-acquisition-attempt-binding@1'
  ),
  requires_runner_git_sha boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (source_id, capture_contract),
  CONSTRAINT leaderboard_capture_contracts_capture_contract_check CHECK (
    capture_contract IN (
      'arena.ingest.leaderboard-acquisition-manifest@2',
      'arena.ingest.leaderboard-acquisition-manifest@3',
      'arena.ingest.leaderboard-acquisition-manifest@4'
    )
  )
);

CREATE FUNCTION arena.reject_registry_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'registry rows are append-only'; END $$;
CREATE TRIGGER reject_metric_mutation BEFORE UPDATE OR DELETE ON arena.metric_source_contracts
  FOR EACH ROW EXECUTE FUNCTION arena.reject_registry_mutation();
CREATE TRIGGER reject_capture_mutation BEFORE UPDATE OR DELETE ON arena.leaderboard_capture_contracts
  FOR EACH ROW EXECUTE FUNCTION arena.reject_registry_mutation();

-- Production-like inventory: bybit_mt5 is absent; binance_futures already
-- carries V3 and binance_spot its 20260722053000 contracts.
INSERT INTO arena.sources VALUES
  (1, 'binance_futures', 'binance', '{7,30,90}', 'USDT'),
  (2, 'binance_spot', 'binance', '{7,30,90}', 'USDT'),
  (3, 'bitunix_futures', 'bitunix', '{7,30,90}', 'USDT'),
  (4, 'blofin_futures', 'blofin', '{7,30,90}', 'USDT'),
  (5, 'blofin_spot', 'blofin', '{7,30,90}', 'USDT'),
  (6, 'btcc_futures', 'btcc', '{30}', 'USDT'),
  (7, 'bybit_copytrade', 'bybit_copytrade', '{7,30,90}', 'USDT'),
  (8, 'coinex_futures', 'coinex', '{7,30,90}', 'USDT'),
  (9, 'gate_cfd', 'gate', '{7,30,90}', 'USDx'),
  (10, 'gate_futures', 'gate', '{7,30,90}', 'USDT'),
  (11, 'htx_futures', 'htx', '{90}', 'USDT'),
  (12, 'htx_spot', 'htx', '{90}', 'USDT'),
  (13, 'kucoin_futures', 'kucoin', '{30}', 'USDT'),
  (14, 'lbank_futures', 'lbank', '{7,30}', 'USDT'),
  (15, 'okx_web3_solana', 'okx_web3', '{7,30,90}', 'USDC'),
  (16, 'bitget_futures', 'bitget', '{7,30,90}', 'USDT');

INSERT INTO arena.leaderboard_capture_contracts VALUES
  (1, 'arena.ingest.leaderboard-acquisition-manifest@3', 'binance',
   'arena.ingest.leaderboard-acquisition-attempt-binding@1', true, pg_catalog.now());

INSERT INTO arena.metric_source_contracts (
  source_id, contract_version, metric, field_path, provenance, methodology_version,
  metric_set_id, timeframes, value_unit, currencies, required_raw_roles,
  source_payload_scope, max_freshness, max_window_end_lag
) VALUES
  (2, '1', 'roi', 'data.list[].roi', 'source_reported', 'binance-board-roi@1',
   'binance-board-roi-pnl@1', '{7,30,90}', 'percent', '{USDT}',
   '{source_payload,population_manifest}', 'population_snapshot', '6 hours', '5 minutes'),
  (2, '1', 'pnl', 'data.list[].pnl', 'source_reported', 'binance-board-pnl@1',
   'binance-board-roi-pnl@1', '{7,30,90}', 'currency', '{USDT}',
   '{source_payload,population_manifest}', 'population_snapshot', '6 hours', '5 minutes');
SQL
for db in main adapter_drift window_gap; do
  "$PG_BIN/createdb" -h "$SOCKET_DIR" -p "$PORT" -U postgres -T postgres "$db"
done

expect_failure main "$CAPTURE" "capture before metric contracts" \
  "attempt-bound capture needs a population metric contract for: bitunix_futures:7d"
assert_equal "refused capture registration leaves no rows" "1" \
  "$(psql_db main -Atqc 'SELECT count(*) FROM arena.leaderboard_capture_contracts')"

psql_db main -q -f "$METRICS"

EXPECTED_JSON="$(cd "$ROOT_DIR" && npx --no-install tsx -e '
import { getRegisteredMetricSourceContract } from "./lib/metric-trust"
const slugs = ["bitunix_futures","blofin_futures","blofin_spot","btcc_futures","bybit_copytrade",
  "coinex_futures","gate_cfd","gate_futures","htx_futures","htx_spot","kucoin_futures",
  "lbank_futures","okx_web3_solana"]
const rows = slugs.flatMap((slug) => {
  const contract = getRegisteredMetricSourceContract(slug)!
  return contract.fields.map((f) => ({
    source: slug, version: contract.version, metric: f.metric, field_path: f.fieldPath,
    provenance: f.provenance, methodology_version: f.methodologyVersion, metric_set_id: f.metricSetId,
    timeframes: f.windowKeys.map((w) => Number(w.slice(0, -1))).sort((a, b) => a - b),
    value_unit: f.valueUnit, currencies: [...f.currencies].sort(),
    required_raw_roles: [...f.requiredRawRoles].sort(), scope: f.sourcePayloadScope,
    freshness_ms: f.maxFreshnessMs, lag_ms: f.maxWindowEndLagMs }))
})
console.log(JSON.stringify(rows))
')"
assert_equal "metric contract rows equal the lib/metric-trust.ts registry" "t" "$(
  psql_db main -Atq -v expected="$EXPECTED_JSON" <<'SQL'
WITH actual AS (
  SELECT pg_catalog.jsonb_build_object(
    'source', source_row.slug, 'version', contract.contract_version, 'metric', contract.metric,
    'field_path', contract.field_path, 'provenance', contract.provenance,
    'methodology_version', contract.methodology_version, 'metric_set_id', contract.metric_set_id,
    'timeframes', (SELECT pg_catalog.jsonb_agg(t ORDER BY t) FROM pg_catalog.unnest(contract.timeframes) AS t),
    'value_unit', contract.value_unit,
    'currencies', (SELECT pg_catalog.jsonb_agg(c ORDER BY c) FROM pg_catalog.unnest(contract.currencies) AS c),
    'required_raw_roles', (SELECT pg_catalog.jsonb_agg(r ORDER BY r) FROM pg_catalog.unnest(contract.required_raw_roles) AS r),
    'scope', contract.source_payload_scope,
    'freshness_ms', (EXTRACT(EPOCH FROM contract.max_freshness) * 1000)::bigint,
    'lag_ms', (EXTRACT(EPOCH FROM contract.max_window_end_lag) * 1000)::bigint
  ) AS item
  FROM arena.metric_source_contracts AS contract
  JOIN arena.sources AS source_row ON source_row.id = contract.source_id
  WHERE source_row.slug <> 'binance_spot' AND NOT contract.allow_derived_population AND contract.active
),
expected AS (SELECT pg_catalog.jsonb_array_elements(:'expected'::jsonb) AS item)
SELECT (SELECT count(*) FROM actual) = (SELECT count(*) FROM expected)
   AND NOT EXISTS (SELECT item FROM expected EXCEPT SELECT item FROM actual)
SQL
)"
expect_failure main "$METRICS" "metric contract replay" "board metric source contracts already registered for:"

psql_db main -q -f "$CAPTURE"
assert_equal "V3 registered for every present listed source, nothing else" \
  "binance_futures,binance_spot,bitunix_futures,blofin_futures,blofin_spot,btcc_futures,bybit_copytrade,coinex_futures,gate_cfd,gate_futures,htx_futures,htx_spot,kucoin_futures,lbank_futures,okx_web3_solana" \
  "$(psql_db main -Atqc "
    SELECT string_agg(source_row.slug, ',' ORDER BY source_row.slug)
      FROM arena.leaderboard_capture_contracts AS capture
      JOIN arena.sources AS source_row ON source_row.id = capture.source_id
     WHERE capture.capture_contract = 'arena.ingest.leaderboard-acquisition-manifest@3'
       AND capture.adapter_slug = source_row.adapter_slug
       AND capture.requires_runner_git_sha")"
expect_failure main "$CAPTURE" "capture replay" "attempt-bound V3 capture already registered for:"

psql_db adapter_drift -q -c "UPDATE arena.sources SET adapter_slug = 'gate_v2' WHERE slug = 'gate_cfd'"
expect_failure adapter_drift "$METRICS" "adapter drift" \
  "board metric source contract adapter/currency drift: gate_cfd"
assert_equal "refused metric registration leaves no rows" "2" \
  "$(psql_db adapter_drift -Atqc 'SELECT count(*) FROM arena.metric_source_contracts')"

psql_db window_gap -q -c "UPDATE arena.sources SET timeframes_native = '{7,30,90}' WHERE slug = 'kucoin_futures'"
psql_db window_gap -q -f "$METRICS"
expect_failure window_gap "$CAPTURE" "native window without a contract" \
  "attempt-bound capture needs a population metric contract for: kucoin_futures:7d, kucoin_futures:90d"

echo "public source attempt-bound capture PG17 proof passed"
