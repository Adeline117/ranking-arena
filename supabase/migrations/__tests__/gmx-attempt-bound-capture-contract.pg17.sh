#!/usr/bin/env bash
# PG17 proof for 20261118114212 (postdeploy registration of attempt-bound V3
# capture for gmx). The real metric-trust / attempt-ledger chain,
# 20261114193017, 20261114211033/211034, 20261115141050 and the previous
# public-source registration 20261115160917 run on stub base tables first.
#
#   + metric contract, exhaustion contract and V3 capture rows equal the code
#     registry (lib/metric-trust.ts `gmx`, GMX_LEADERBOARD_EXHAUSTION) and
#     page_size becomes the adapter limit (GMX_LEADERBOARD_PAGE_SIZE)
#   + the registered declaration holds for one short, re-read-stable page and
#     fails for a moved re-read or a full page
#   - a replay refuses and changes nothing
#   - adapter drift, a pre-v2 PnL contract, an unexpected page_size and a
#     currency the contract does not cover refuse with no rows
#   + an absent source is skipped

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
TARGET="$MIGRATIONS/20261118114212_gmx_attempt_bound_capture_contract.sql"
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

TMP_ROOT="$(mktemp -d /tmp/gmx-capture-contract-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((41000 + ($$ % 5000)))}"
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
  PGOPTIONS='-c client_min_messages=warning' \
    "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d "$db" "$@"
}

expect_failure() {
  local db="$1" label="$2" expected="$3"
  if psql_db "$db" -q -f "$TARGET" >"$ERROR_FILE" 2>&1; then
    echo "FAIL: $label unexpectedly succeeded" >&2
    exit 1
  fi
  if [[ "$(<"$ERROR_FILE")" != *"$expected"* ]]; then
    echo "FAIL: $label failed for the wrong reason; expected: $expected" >&2
    cat "$ERROR_FILE" >&2
    exit 1
  fi
  echo "ok: $label refused"
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

registry_rows() {
  psql_db "$1" -Atqc "
    SELECT (SELECT count(*) FROM arena.metric_source_contracts) || '/' ||
           (SELECT count(*) FROM arena.leaderboard_capture_contracts) || '/' ||
           (SELECT count(*) FROM arena.leaderboard_exhaustion_contracts)"
}

"$PG_BIN/initdb" -D "$DATA_DIR" --auth-local=trust --auth-host=trust \
  --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null

# Base tables as the 20260610/20260721 foundations shape them; the sources are
# the 20260610223356 seed rows (adapter, windows, currency, page_size).
psql_db postgres -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE SCHEMA arena;

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  adapter_slug text NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL,
  currency text NOT NULL CHECK (currency IN ('USDT', 'USDx', 'USDC', 'USD')),
  product_type text NOT NULL,
  fetch_region text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}',
  timeframes_native integer[] NOT NULL DEFAULT '{}',
  timeframes_derived integer[] NOT NULL DEFAULT '{}',
  page_size int
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
INSERT INTO arena.sources (
  id, slug, adapter_slug, status, serving_mode, currency, product_type,
  fetch_region, timeframes_native, page_size
) VALUES
  (1, 'binance_futures', 'binance', 'active', 'serving', 'USDT', 'futures', 'vps_sg', '{7,30,90}', 20),
  (2, 'binance_web3_bsc', 'binance_web3', 'active', 'serving', 'USDT', 'onchain', 'local', '{7,30,90}', 24),
  (3, 'bitget_futures', 'bitget', 'active', 'serving', 'USDT', 'futures', 'local', '{7,30,90}', 30),
  (4, 'bitget_spot', 'bitget', 'active', 'serving', 'USDT', 'spot', 'local', '{7,30,90}', 30),
  (5, 'bitget_cfd', 'bitget', 'active', 'serving', 'USDT', 'cfd', 'local', '{7,30,90}', 30),
  (6, 'kucoin_futures', 'kucoin', 'active', 'serving', 'USDT', 'futures', 'local', '{7,30,90}', 12),
  (7, 'okx_futures', 'okx', 'blocked_pending_vps', 'legacy', 'USDT', 'futures', 'vps_sg', '{7,30,90}', NULL),
  (8, 'okx_spot', 'okx', 'blocked_pending_vps', 'legacy', 'USDT', 'spot', 'vps_sg', '{7,30,90}', NULL),
  (9, 'toobit_futures', 'toobit', 'blocked_pending_vps', 'legacy', 'USDT', 'futures', 'vps_sg', '{7,30,90}', NULL),
  (10, 'xt_futures', 'xt', 'inactive', 'legacy', 'USDT', 'futures', 'local', '{7,30,90}', 10),
  (11, 'xt_spot', 'xt', 'inactive', 'legacy', 'USDT', 'spot', 'local', '{7,30,90}', 10),
  (12, 'lbank_futures', 'lbank', 'active', 'serving', 'USDT', 'futures', 'local', '{7,30}', 20),
  (13, 'gmx', 'gmx', 'active', 'serving', 'USDC', 'onchain', 'local', '{7,30,90}', 20);
-- gmx after the 20260715232500 CUTOVER (GMX PnL contract v2).
UPDATE arena.sources SET meta = '{"pnl_basis_board": "gmx_period_realized_net", "roi_basis_board": "max_capital_usd", "pnl_includes_unrealized": false, "pnl_contract_version": 2, "window_semantics": "completed_utc_days"}'
 WHERE slug = 'gmx';
GRANT USAGE ON SCHEMA arena TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA arena TO service_role;
SQL

for migration in \
  20260721120000_metric_trust_shadow_gate.sql \
  20260721150000_metric_trust_raw_artifact_identity.sql \
  20260721180903_metric_rankable_score_inputs_shadow.sql \
  20260722030000_durable_leaderboard_acquisition_attempt_ledger.sql \
  20260722040000_leaderboard_acquisition_manifest_v3_compat.sql \
  20260722042000_leaderboard_terminal_publication_fence.sql \
  20260722050000_metric_trust_attempt_outcome_authority.sql; do
  psql_db postgres -q -f "$MIGRATIONS/$migration" >/dev/null
done

# 20261114193017 foundations (20261113110430 shapes), then the real predicate,
# the #477 registrations and the exhaustion registry.
psql_db postgres -q <<'SQL'
CREATE TABLE arena.leaderboard_rank_publications (
  id uuid PRIMARY KEY, season_id text NOT NULL, proofs jsonb NOT NULL
);
CREATE TABLE arena.leaderboard_rank_publication_source_evidence (
  score_cohort_id uuid, season_id text, source text, evidence_grade text,
  snapshot_ids bigint[], raw_object_ids bigint[], source_run_ids text[],
  manifest_raw_object_ids bigint[]
);
CREATE FUNCTION public.record_leaderboard_rank_publication_evidence(text, uuid, jsonb)
RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
SQL
for migration in \
  20261114193017_rank_publication_requires_attempt_bound_evidence.sql \
  20261114211033_public_source_board_metric_contracts.sql \
  20261114211034_public_source_attempt_bound_capture_contracts.sql \
  20261115141050_leaderboard_exhaustion_completeness_evidence.sql; do
  psql_db postgres -q -f "$MIGRATIONS/$migration" >/dev/null
done

psql_db postgres -q -f "$MIGRATIONS/20261115160917_public_source_exhaustion_and_total_capture_contracts.sql" >/dev/null

for db in main absent adapter_drift v1_contract page_drift currency_drift; do
  "$PG_BIN/createdb" -h "$SOCKET_DIR" -p "$PORT" -T postgres "$db"
done
BEFORE="$(registry_rows main)"

psql_db main -q -f "$TARGET"
echo "ok: migration applies"

# ── Rows equal the code registry ──

EXPECTED_JSON="$(cd "$ROOT_DIR" && npx --no-install tsx -e '
import { getRegisteredMetricSourceContract } from "./lib/metric-trust"
import { GMX_LEADERBOARD_EXHAUSTION, GMX_LEADERBOARD_PAGE_SIZE } from "./lib/ingest/adapters/gmx"
const contract = getRegisteredMetricSourceContract("gmx")!
const metrics = contract.fields.map((f) => ({
  source: "gmx", version: contract.version, metric: f.metric, field_path: f.fieldPath,
  provenance: f.provenance, methodology_version: f.methodologyVersion, metric_set_id: f.metricSetId,
  timeframes: f.windowKeys.map((w) => Number(w.slice(0, -1))).sort((a, b) => a - b),
  value_unit: f.valueUnit, currencies: [...f.currencies].sort(),
  required_raw_roles: [...f.requiredRawRoles].sort(), scope: f.sourcePayloadScope,
  freshness_ms: f.maxFreshnessMs, lag_ms: f.maxWindowEndLagMs }))
console.log(JSON.stringify({
  metrics,
  exhaustion: [{ source: "gmx", declaration: GMX_LEADERBOARD_EXHAUSTION }],
  page_size: GMX_LEADERBOARD_PAGE_SIZE,
}))
')"

assert_equal "gmx metric contract rows equal the lib/metric-trust.ts registry" "t" "$(
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
  WHERE contract.active AND NOT contract.allow_derived_population AND source_row.slug = 'gmx'
),
expected AS (SELECT pg_catalog.jsonb_array_elements((:'expected'::jsonb)->'metrics') AS item)
SELECT (SELECT count(*) FROM actual) = (SELECT count(*) FROM expected)
   AND NOT EXISTS (SELECT item FROM expected EXCEPT SELECT item FROM actual)
SQL
)"

assert_equal "gmx exhaustion contract row equals GMX_LEADERBOARD_EXHAUSTION" "t" "$(
  psql_db main -Atq -v expected="$EXPECTED_JSON" <<'SQL'
SELECT contract.declaration = ((:'expected'::jsonb)->'exhaustion'->0->'declaration')
  FROM arena.leaderboard_exhaustion_contracts AS contract
  JOIN arena.sources AS source_row ON source_row.id = contract.source_id
 WHERE source_row.slug = 'gmx'
   AND contract.completeness_contract = 'arena.ingest.leaderboard-exhaustion-completeness@1'
SQL
)"

assert_equal "gmx V3 capture registered next to the earlier sources" \
  "binance_futures,binance_web3_bsc,bitget_cfd,bitget_spot,gmx,kucoin_futures,lbank_futures,okx_futures,okx_spot,toobit_futures,xt_futures" \
  "$(psql_db main -Atqc "
    SELECT string_agg(source_row.slug, ',' ORDER BY source_row.slug)
      FROM arena.leaderboard_capture_contracts AS capture
      JOIN arena.sources AS source_row ON source_row.id = capture.source_id
     WHERE capture.capture_contract = 'arena.ingest.leaderboard-acquisition-manifest@3'
       AND capture.adapter_slug = source_row.adapter_slug
       AND capture.attempt_binding_contract = 'arena.ingest.leaderboard-acquisition-attempt-binding@1'
       AND capture.requires_runner_git_sha")"

assert_equal "gmx page_size equals the adapter limit, nothing else changed" \
  "gmx:{7,30,90}:USDC:$(node -e "console.log(JSON.parse(process.argv[1]).page_size)" "$EXPECTED_JSON"):active:serving" \
  "$(psql_db main -Atqc "
    SELECT slug || ':' || timeframes_native::text || ':' || currency || ':' ||
           page_size::text || ':' || status || ':' || serving_mode
      FROM arena.sources WHERE slug = 'gmx'")"

# ── The registered declaration holds for one complete short page ──

gmx_holds() {
  local reread_keys="$1" row_count="$2" termination="$3"
  psql_db main -Atq -v reread_keys="$reread_keys" -v row_count="$row_count" \
    -v termination="$termination" <<'SQL'
WITH contract AS (
  SELECT contract.source_id, contract.declaration
    FROM arena.leaderboard_exhaustion_contracts AS contract
    JOIN arena.sources AS source_row ON source_row.id = contract.source_id
   WHERE source_row.slug = 'gmx'
)
SELECT arena.leaderboard_exhaustion_completeness_holds(
  contract.source_id,
  pg_catalog.jsonb_build_object(
    'data_contract', 'arena.ingest.leaderboard-exhaustion-completeness@1',
    'declaration', contract.declaration,
    'pages', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('ordinal', 1, 'request_sha256', pg_catalog.repeat('a', 64),
        'response_sha256', pg_catalog.repeat('b', 64), 'row_count', (:'row_count')::integer,
        'row_keys_sha256', pg_catalog.repeat('c', 64),
        'version_token_sha256', NULL, 'end_signal_value', NULL)
    ),
    'row_keys', pg_catalog.jsonb_build_object(
      'observed', (:'row_count')::integer, 'distinct', (:'row_count')::integer, 'duplicate', 0),
    'board_version', pg_catalog.jsonb_build_object(
      'kind', 'first_page_reread',
      'reread', pg_catalog.jsonb_build_object(
        'request_sha256', pg_catalog.repeat('a', 64),
        'response_sha256', pg_catalog.repeat('b', 64),
        'http_status', 200,
        'row_keys_sha256', :'reread_keys'))
  ),
  :'termination', 1, 'unknown', (:'row_count')::integer, (:'row_count')::integer, 0, 0
)
FROM contract
SQL
}
C64="$(printf 'c%.0s' {1..64})"
assert_equal "registered gmx declaration holds for one short, re-read-stable page" "t" \
  "$(gmx_holds "$C64" 2516 short_page)"
assert_equal "registered gmx declaration fails when the re-read moved" "f" \
  "$(gmx_holds "$(printf 'd%.0s' {1..64})" 2516 short_page)"
assert_equal "registered gmx declaration fails for a full page (population may continue)" "f" \
  "$(gmx_holds "$C64" 50000 short_page)"

# ── Replay and drift refuse the whole migration ──

AFTER="$(registry_rows main)"
expect_failure main "replay" "board metric source contracts already registered for: gmx"
assert_equal "refused replay changes nothing" "$AFTER" "$(registry_rows main)"

psql_db adapter_drift -q -c "UPDATE arena.sources SET adapter_slug = 'gmx_v1' WHERE slug = 'gmx'"
expect_failure adapter_drift "adapter drift" "gmx capture adapter drift: gmx"
assert_equal "refused adapter drift leaves no rows" "$BEFORE" "$(registry_rows adapter_drift)"

psql_db v1_contract -q -c "UPDATE arena.sources SET meta = meta - 'pnl_basis_board' WHERE slug = 'gmx'"
expect_failure v1_contract "pre-v2 pnl contract" "gmx capture requires the v2 realized-net source contract"
assert_equal "refused pre-v2 contract leaves no rows" "$BEFORE" "$(registry_rows v1_contract)"

psql_db page_drift -q -c "UPDATE arena.sources SET page_size = 60 WHERE slug = 'gmx'"
expect_failure page_drift "unexpected page_size" "gmx capture page_size drift: gmx"
assert_equal "refused page drift leaves no rows" "$BEFORE" "$(registry_rows page_drift)"
assert_equal "refused page drift leaves the source configuration" "60" \
  "$(psql_db page_drift -Atqc "SELECT page_size FROM arena.sources WHERE slug = 'gmx'")"

psql_db currency_drift -q -c "UPDATE arena.sources SET currency = 'USDT' WHERE slug = 'gmx'"
expect_failure currency_drift "currency the contract does not cover" \
  "board metric source contract currency drift: gmx"
assert_equal "refused currency drift leaves no rows" "$BEFORE" "$(registry_rows currency_drift)"

# ── An absent source is skipped ──

psql_db absent -q -c "DELETE FROM arena.sources WHERE slug = 'gmx'"
psql_db absent -q -f "$TARGET"
assert_equal "absent gmx skipped without rows" "$BEFORE" "$(registry_rows absent)"

echo "gmx attempt-bound capture contract PG17 proof passed"
