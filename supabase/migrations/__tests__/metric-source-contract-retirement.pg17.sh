#!/usr/bin/env bash
# PG17 proof for 20261116203816 (append-only metric source contract
# retirement, predeploy) and 20261116203817 (binance_web3_bsc v2 + retirement
# of v1, postdeploy). The real metric-trust shadow gate (20260721120000) runs
# on stub base tables first and seeds binance_web3_bsc v1; one v1 observation
# is recorded before either migration.
#
#   - the mechanism refuses a source that already holds two active versions
#   - the mechanism refuses a replay
#   + after 203817 the current set is v2 only and equals lib/metric-trust.ts
#     field by field, and the worker's own resolution SQL
#     (CURRENT_METRIC_CONTRACTS_SQL) returns exactly the v2 board fields
#   - the retired version is never resolved current: no v1 row is returned, a
#     new observation cannot cite v1, and v1 cannot gain a row
#   + a v2 observation on the data.data[] path is accepted
#   - retiring an unknown version, or naming an unknown successor, is refused
#   - a second active version without retirement is refused at commit
#   - a replay of 203817 refuses and changes nothing
#   + the pre-existing v1 observation and the v1 rows are unchanged
#   - retirement rows are append-only (UPDATE, DELETE, TRUNCATE refused)
#   - adapter or currency drift refuses 203817; an absent source is skipped

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
SHADOW_GATE="$MIGRATIONS/20260721120000_metric_trust_shadow_gate.sql"
MECHANISM="$MIGRATIONS/20261116203816_metric_source_contract_retirement.sql"
TARGET="$MIGRATIONS/20261116203817_binance_web3_bsc_metric_contract_v2.sql"
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

TMP_ROOT="$(mktemp -d /tmp/metric-contract-retirement-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((46000 + ($$ % 5000)))}"
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
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d "$db" "$@"
}

assert_equal() {
  if [[ "$2" != "$3" ]]; then
    echo "$1: expected '$2', got '$3'" >&2
    exit 1
  fi
  echo "ok: $1"
}

expect_failure() {
  local label="$1" db="$2" expected="$3" sql="$4"
  if psql_db "$db" -q -c "$sql" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if [[ "$(<"$ERROR_FILE")" != *"$expected"* ]]; then
    echo "$label failed for the wrong reason; expected: $expected" >&2
    cat "$ERROR_FILE" >&2
    exit 1
  fi
  echo "ok: $label refused"
}

expect_file_failure() {
  local label="$1" db="$2" expected="$3" file="$4"
  if psql_db "$db" -q -f "$file" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if [[ "$(<"$ERROR_FILE")" != *"$expected"* ]]; then
    echo "$label failed for the wrong reason; expected: $expected" >&2
    cat "$ERROR_FILE" >&2
    exit 1
  fi
  echo "ok: $label refused"
}

"$PG_BIN/initdb" -D "$DATA_DIR" --auth-local=trust --auth-host=trust \
  --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null

psql_db postgres -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA arena;
CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  adapter_slug text NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL,
  currency text NOT NULL,
  product_type text NOT NULL,
  fetch_region text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}',
  timeframes_native integer[] NOT NULL DEFAULT '{}',
  timeframes_derived integer[] NOT NULL DEFAULT '{}'
);
CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL,
  nickname text,
  avatar_url_mirror text,
  avatar_url_origin text,
  trader_kind text NOT NULL DEFAULT 'human'
);
CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL,
  actual_count int NOT NULL,
  count_check_passed boolean NOT NULL,
  is_derived boolean NOT NULL DEFAULT false,
  raw_object_id bigint
);
CREATE TABLE arena.leaderboard_entries (
  scraped_at timestamptz NOT NULL,
  snapshot_id bigint NOT NULL,
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  timeframe smallint NOT NULL,
  rank int NOT NULL,
  currency text NOT NULL,
  PRIMARY KEY (scraped_at, snapshot_id, trader_id)
);
CREATE TABLE arena.raw_objects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  job_type text NOT NULL,
  trader_id bigint,
  timeframe smallint,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  storage_path text NOT NULL UNIQUE,
  bytes int NOT NULL,
  content_hash text NOT NULL,
  quarantined boolean NOT NULL DEFAULT false,
  meta jsonb NOT NULL DEFAULT '{}'
);
-- binance_web3_bsc in its post-20261115160917 state (USD).
INSERT INTO arena.sources (
  id, slug, adapter_slug, status, serving_mode, currency, product_type, fetch_region,
  timeframes_native
) VALUES
  (1, 'binance_futures', 'binance', 'active', 'serving', 'USDT', 'futures', 'vps_sg', '{7,30,90}'),
  (2, 'binance_web3_bsc', 'binance_web3', 'active', 'serving', 'USD', 'onchain', 'local', '{7,30,90}');
GRANT USAGE ON SCHEMA arena TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA arena TO service_role;
SQL

psql_db postgres -q -f "$SHADOW_GATE" >/dev/null

# One v1 observation recorded before any retirement exists.
psql_db postgres -q <<'SQL'
INSERT INTO arena.traders (id, source_id, exchange_trader_id) VALUES
  (20, 2, '0xaaa'), (21, 2, '0xbbb');
INSERT INTO arena.raw_objects (
  source_id, job_type, timeframe, storage_path, bytes, content_hash,
  meta, source_run_id, trust_artifact_role, fetched_at
) VALUES
  (2, 'tier_a', 30, 'bsc/run-1/page.json.gz', 10, repeat('a', 64),
   '{"raw_integrity":{"hash_algorithm":"sha256","hash_scope":"json_utf8"}}',
   repeat('b', 64), 'source_payload', statement_timestamp() - interval '3 minutes'),
  (2, 'tier_a_manifest', 30, 'bsc/run-1/manifest.json.gz', 10, repeat('b', 64),
   '{"raw_integrity":{"hash_algorithm":"sha256","hash_scope":"json_utf8"}}',
   repeat('b', 64), 'population_manifest', statement_timestamp() - interval '1 minute');
INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, scraped_at, actual_count, count_check_passed, raw_object_id
)
SELECT 200, 2, 30, statement_timestamp(), 2, true, id
  FROM arena.raw_objects WHERE job_type = 'tier_a';
INSERT INTO arena.leaderboard_entries (scraped_at, snapshot_id, trader_id, timeframe, rank, currency)
SELECT snapshot.scraped_at, snapshot.id, trader.id, 30, trader.id::int - 19, 'USD'
  FROM arena.leaderboard_snapshots AS snapshot CROSS JOIN arena.traders AS trader
 WHERE snapshot.id = 200;
INSERT INTO arena.metric_trust_runs (
  source_run_id, source_id, timeframe, snapshot_id, snapshot_scraped_at,
  population_raw_object_id, manifest_raw_object_id, started_at, completed_at,
  reported_population, fetched_population, caller_limited, acquisition_state, population_state
)
SELECT repeat('b', 64), 2, 30, snapshot.id, snapshot.scraped_at, population.id, manifest.id,
       statement_timestamp() - interval '4 minutes', statement_timestamp() - interval '1 minute',
       NULL, 2, false, 'complete', 'verified'
  FROM arena.leaderboard_snapshots AS snapshot
  JOIN arena.raw_objects AS population ON population.id = snapshot.raw_object_id
  JOIN arena.raw_objects AS manifest ON manifest.job_type = 'tier_a_manifest'
 WHERE snapshot.id = 200;

SQL

# observe <trader> <contract_version> <field_path>: insert one roi observation.
observe_sql() {
  cat <<SQL
INSERT INTO arena.metric_trust_observations (
  contract_id, trader_id, source_id, snapshot_id, snapshot_scraped_at,
  source_run_id, source_contract_version, timeframe, metric, field_path,
  provenance, methodology_version, value, value_unit, currency,
  source_as_of, valid_until, window_start, window_end, quality,
  history_state, price_state, cost_basis_state, population_state,
  window_state, unit_state, freshness_state, blocking_reasons
)
SELECT contract.id, $1, 2, snapshot.id, snapshot.scraped_at,
       repeat('b', 64), contract.contract_version, 30, contract.metric, contract.field_path,
       contract.provenance, contract.methodology_version, 12.5, contract.value_unit, 'USD',
       statement_timestamp() - interval '2 minutes', statement_timestamp() + interval '1 hour',
       statement_timestamp() - interval '30 days 2 minutes', statement_timestamp() - interval '2 minutes',
       'unknown', 'source_owned', 'source_owned', 'source_owned', 'verified',
       'unknown', 'verified', 'verified', '[{"code":"native_window_boundary_unverified","state":"unknown"}]'::jsonb
  FROM arena.metric_source_contracts AS contract
  CROSS JOIN arena.leaderboard_snapshots AS snapshot
 WHERE snapshot.id = 200
   AND contract.source_id = 2
   AND contract.contract_version = '$2'
   AND contract.field_path = '$3';
SQL
}

psql_db postgres -q -c "$(observe_sql 20 1 'board.data.data[].realizedPnlPercent')"

evidence_digest() {
  psql_db "$1" -Atqc "
    SELECT pg_catalog.md5(pg_catalog.string_agg(row_text, '|' ORDER BY row_text))
      FROM (
        SELECT observation::text AS row_text FROM arena.metric_trust_observations AS observation
         WHERE observation.id = (SELECT min(id) FROM arena.metric_trust_observations)
        UNION ALL
        SELECT contract::text FROM arena.metric_source_contracts AS contract
         WHERE contract.contract_version = '1'
      ) AS evidence"
}

current_versions() {
  psql_db "$1" -Atqc "
    SELECT source_row.slug || ':' || pg_catalog.string_agg(DISTINCT contract.contract_version, ',')
      FROM arena.metric_source_contracts AS contract
      JOIN arena.sources AS source_row ON source_row.id = contract.source_id
     WHERE contract.active
       AND NOT EXISTS (
         SELECT 1 FROM arena.metric_source_contract_retirements AS retirement
          WHERE retirement.source_id = contract.source_id
            AND retirement.contract_version = contract.contract_version)
     GROUP BY source_row.slug ORDER BY source_row.slug" | paste -sd '|' -
}

for db in two_active main adapter_drift currency_drift absent; do
  "$PG_BIN/createdb" -h "$SOCKET_DIR" -p "$PORT" -T postgres "$db"
done
EVIDENCE_BEFORE="$(evidence_digest postgres)"

# ── Mechanism (20261116203816) ──

psql_db two_active -q <<'SQL'
INSERT INTO arena.metric_source_contracts (
  source_id, contract_version, metric, field_path, provenance, methodology_version,
  metric_set_id, timeframes, value_unit, currencies, required_raw_roles,
  source_payload_scope, max_freshness, max_window_end_lag
) VALUES (1, '2', 'roi', 'data.list[].roi', 'source_reported', 'binance-board-roi@1',
  'binance-board-roi-pnl@1', '{7,30,90}', 'percent', '{USDT}',
  '{source_payload,population_manifest}', 'population_snapshot', '6 hours', '5 minutes');
SQL
expect_file_failure "mechanism over a source with two active versions" two_active \
  "source 1 already holds more than one active metric contract version" "$MECHANISM"
assert_equal "refused mechanism leaves no retirement table" "" \
  "$(psql_db two_active -Atqc "SELECT pg_catalog.to_regclass('arena.metric_source_contract_retirements')")"

for db in main adapter_drift currency_drift absent; do
  psql_db "$db" -q -f "$MECHANISM" >/dev/null
done
echo "ok: mechanism applies"
expect_file_failure "mechanism replay" main "metric source contract retirement already exists" "$MECHANISM"
assert_equal "mechanism alone is inert: current set equals the active set" \
  "binance_futures:1|binance_web3_bsc:1" "$(current_versions main)"
assert_equal "retirement table is private: service_role reads only" "t|f|f|f" "$(psql_db main -Atqc "
  SELECT pg_catalog.has_table_privilege('service_role', 'arena.metric_source_contract_retirements', 'SELECT'),
         pg_catalog.has_table_privilege('service_role', 'arena.metric_source_contract_retirements', 'INSERT'),
         pg_catalog.has_table_privilege('anon', 'arena.metric_source_contract_retirements', 'SELECT'),
         pg_catalog.has_table_privilege('authenticated', 'arena.metric_source_contract_retirements', 'SELECT')" | paste -sd '|' -)"

# A new version without retiring the old one is refused at commit.
expect_failure "second active version without retirement" main "code/database contract drift" "
  INSERT INTO arena.metric_source_contracts (
    source_id, contract_version, metric, field_path, provenance, methodology_version,
    metric_set_id, timeframes, value_unit, currencies, required_raw_roles,
    source_payload_scope, max_freshness, max_window_end_lag
  ) VALUES (1, '2', 'roi', 'data.list[].roi', 'source_reported', 'binance-board-roi@1',
    'binance-board-roi-pnl@1', '{7,30,90}', 'percent', '{USDT}',
    '{source_payload,population_manifest}', 'population_snapshot', '6 hours', '5 minutes')"
assert_equal "refused second version left no row" "0" \
  "$(psql_db main -Atqc "SELECT count(*) FROM arena.metric_source_contracts WHERE contract_version <> '1'")"

expect_failure "retiring an unknown version" main "metric source contract version 9 of source 2 is not registered" "
  INSERT INTO arena.metric_source_contract_retirements (source_id, contract_version, superseded_by_version, reason)
  VALUES (2, '9', '1', 'unknown')"
expect_failure "retiring with an unknown successor" main "superseding metric source contract version 2 of source 2 is not current" "
  INSERT INTO arena.metric_source_contract_retirements (source_id, contract_version, superseded_by_version, reason)
  VALUES (2, '1', '2', 'successor missing')"
expect_failure "retiring a version in favour of itself" main "metric_source_contract_retirements_check" "
  INSERT INTO arena.metric_source_contract_retirements (source_id, contract_version, superseded_by_version, reason)
  VALUES (2, '1', '1', 'self')"

# ── binance_web3_bsc v2 (20261116203817) ──

psql_db main -q -f "$TARGET"
echo "ok: v2 migration applies"
assert_equal "current set: binance_web3_bsc v2 only" \
  "binance_futures:1|binance_web3_bsc:2" "$(current_versions main)"

EXPECTED_JSON="$(cd "$ROOT_DIR" && npx --no-install tsx -e '
import { getRegisteredMetricSourceContract } from "./lib/metric-trust"
const metrics = ["binance_futures", "binance_web3_bsc"].flatMap((slug) => {
  const contract = getRegisteredMetricSourceContract(slug)!
  return contract.fields.map((f) => ({
    source: slug, version: contract.version, metric: f.metric, field_path: f.fieldPath,
    provenance: f.provenance, methodology_version: f.methodologyVersion, metric_set_id: f.metricSetId,
    timeframes: f.windowKeys.map((w) => Number(w.slice(0, -1))).sort((a, b) => a - b),
    value_unit: f.valueUnit, currencies: [...f.currencies].sort(),
    required_raw_roles: [...f.requiredRawRoles].sort(), scope: f.sourcePayloadScope,
    freshness_ms: f.maxFreshnessMs, lag_ms: f.maxWindowEndLagMs }))
})
console.log(JSON.stringify(metrics))
')"

assert_equal "current contract rows equal the lib/metric-trust.ts registry" "t" "$(
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
  WHERE contract.active AND NOT contract.allow_derived_population
    AND NOT EXISTS (
      SELECT 1 FROM arena.metric_source_contract_retirements AS retirement
       WHERE retirement.source_id = contract.source_id
         AND retirement.contract_version = contract.contract_version)
),
expected AS (SELECT pg_catalog.jsonb_array_elements(:'expected'::jsonb) AS item)
SELECT (SELECT count(*) FROM actual) = (SELECT count(*) FROM expected)
   AND NOT EXISTS (SELECT item FROM expected EXCEPT SELECT item FROM actual)
SQL
)"

# The worker's resolution SQL, verbatim, against PG17.
RESOLUTION_SQL="$(cd "$ROOT_DIR" && npx --no-install tsx -e '
import { CURRENT_METRIC_CONTRACTS_SQL } from "./lib/ingest/serving/metric-trust-publish"
console.log(CURRENT_METRIC_CONTRACTS_SQL)
')"
resolve_contracts() {
  psql_db "$1" -Atq <<SQL | paste -sd '|' -
PREPARE current_contracts(smallint, smallint, text) AS
$RESOLUTION_SQL;
EXECUTE current_contracts($2, $3, '$4');
SQL
}
for timeframe in 7 30 90; do
  RESOLVED="$(resolve_contracts main 2 "$timeframe" USD)"
  if [[ "$(cut -d'|' -f2-4 <<<"$RESOLVED")" != "2|pnl|data.data[].realizedPnl" ]] ||
     [[ "$RESOLVED" != *"|2|roi|data.data[].realizedPnlPercent|"* ]] ||
     [[ "$RESOLVED" == *"board.data.data"* ]] ||
     [[ "$(grep -o 'population_snapshot' <<<"$RESOLVED" | wc -l | tr -d ' ')" != "2" ]]; then
    echo "worker resolution for binance_web3_bsc ${timeframe}D is not exactly the v2 board fields: $RESOLVED" >&2
    exit 1
  fi
done
echo "ok: worker resolution SQL returns only the v2 board fields for 7D/30D/90D"
assert_equal "worker resolution for binance_futures is unchanged" "2" \
  "$(resolve_contracts main 1 30 USDT | tr '|' '\n' | grep -c '^data\.list\[\]\.')"

expect_failure "new observation citing retired v1" main "cites retired metric source contract" \
  "$(observe_sql 21 1 'board.data.data[].realizedPnlPercent')"
expect_failure "new row for retired v1" main "metric source contract version 1 of source 2 is retired" "
  INSERT INTO arena.metric_source_contracts (
    source_id, contract_version, metric, field_path, provenance, methodology_version,
    metric_set_id, timeframes, value_unit, currencies, required_raw_roles,
    source_payload_scope, max_freshness, max_window_end_lag
  ) VALUES (2, '1', 'win_rate', 'board.data.data[].winRate', 'source_reported', 'w@1',
    'w@1', '{7,30,90}', 'ratio', '{USD}', '{source_payload,population_manifest}',
    'population_snapshot', '2 hours', '5 minutes')"
expect_failure "retiring v1 twice" main "metric_source_contract_retirements_pkey" "
  INSERT INTO arena.metric_source_contract_retirements (source_id, contract_version, superseded_by_version, reason)
  VALUES (2, '1', '2', 'again')"

psql_db main -q -c "$(observe_sql 21 2 'data.data[].realizedPnlPercent')"
assert_equal "a v2 observation on the verbatim data.data[] path is accepted" "2|data.data[].realizedPnlPercent" \
  "$(psql_db main -Atqc "SELECT source_contract_version || '|' || field_path FROM arena.metric_trust_observations WHERE trader_id = 21")"

for statement in \
  "UPDATE arena.metric_source_contract_retirements SET reason = 'edited'" \
  "DELETE FROM arena.metric_source_contract_retirements" \
  "TRUNCATE arena.metric_source_contract_retirements"; do
  expect_failure "retirement mutation: ${statement%% *}" main "append-only" "$statement"
done

BEFORE_REPLAY="$(psql_db main -Atqc "SELECT (SELECT count(*) FROM arena.metric_source_contracts) || ':' || (SELECT count(*) FROM arena.metric_source_contract_retirements)")"
expect_file_failure "v2 replay" main "binance_web3_bsc current metric contract versions are {2}, expected {1}" "$TARGET"
assert_equal "refused replay changes nothing" "$BEFORE_REPLAY" \
  "$(psql_db main -Atqc "SELECT (SELECT count(*) FROM arena.metric_source_contracts) || ':' || (SELECT count(*) FROM arena.metric_source_contract_retirements)")"
assert_equal "pre-existing v1 observation and v1 rows are unchanged" "$EVIDENCE_BEFORE" "$(evidence_digest main)"
assert_equal "pre-existing observation still binds its v1 contract" "1|board.data.data[].realizedPnlPercent" "$(psql_db main -Atqc "
  SELECT contract.contract_version || '|' || contract.field_path
    FROM arena.metric_trust_observations AS observation
    JOIN arena.metric_source_contracts AS contract ON contract.id = observation.contract_id
   WHERE observation.trader_id = 20")"

# ── Refusals and skip ──

psql_db adapter_drift -q -c "UPDATE arena.sources SET adapter_slug = 'binance' WHERE id = 2"
expect_file_failure "v2 with adapter drift" adapter_drift "must use the binance_web3 adapter in USD" "$TARGET"
psql_db currency_drift -q -c "UPDATE arena.sources SET currency = 'USDT' WHERE id = 2"
expect_file_failure "v2 before the USD correction" currency_drift "must use the binance_web3 adapter in USD" "$TARGET"
for db in adapter_drift currency_drift; do
  assert_equal "refused v2 left $db unchanged" "binance_futures:1|binance_web3_bsc:1" "$(current_versions "$db")"
done

psql_db absent -q -c "UPDATE arena.sources SET slug = 'binance_web3_bsc_renamed' WHERE id = 2"
psql_db absent -q -f "$TARGET" >/dev/null 2>&1
assert_equal "absent binance_web3_bsc is skipped" "binance_futures:1|binance_web3_bsc_renamed:1" "$(current_versions absent)"

echo "metric source contract retirement PostgreSQL 17 proof passed"
