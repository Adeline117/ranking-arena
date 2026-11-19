#!/usr/bin/env bash
# PG17 proof for 20261115160917 (postdeploy registration of the public sources
# whose adapters gained attempt-bound capture after 20261114211034). The real
# metric-trust / attempt-ledger chain, 20261114193017, 20261114211033/211034
# and 20261115141050 run on stub base tables first.
#
#   + metric contract, exhaustion contract and V3 capture rows equal the code
#     registry (lib/metric-trust.ts, OKX_/BINANCE_WEB3_LEADERBOARD_EXHAUSTION)
#     field by field; bitget_futures gets its contract but no capture
#   + the seeded source configuration is corrected (kucoin {30}, okx {90},
#     binance_web3_bsc USD, toobit/xt page_size 1000)
#   + a registered exhaustion declaration holds for a complete okx board and
#     fails for a board whose version token changed
#   - a replay refuses and changes nothing
#   - adapter drift, an uncovered native window and a currency the contract
#     does not cover refuse the whole migration and leave no rows
#   + an absent source is skipped
#
# It then proves 20261116204359 (forward replacement of 20261115170535) (postdeploy activation of okx_futures,
# okx_spot, toobit_futures and xt_futures as local, publicly ranked sources)
# on the post-160917 state; see the section at the end.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
TARGET="$MIGRATIONS/20261115160917_public_source_exhaustion_and_total_capture_contracts.sql"
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

TMP_ROOT="$(mktemp -d /tmp/public-source-exhaustion-pg17.XXXXXX)"
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
  (12, 'lbank_futures', 'lbank', 'active', 'serving', 'USDT', 'futures', 'local', '{7,30}', 20);
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

for db in main absent adapter_drift window_gap currency_drift; do
  "$PG_BIN/createdb" -h "$SOCKET_DIR" -p "$PORT" -T postgres "$db"
done
BEFORE="$(registry_rows main)"

psql_db main -q -f "$TARGET"
echo "ok: migration applies"

# ── Rows equal the code registry ──

# binance_web3_bsc is absent on purpose: at this point it still holds its
# 20260721120000 v1, which the registry has superseded with v2. Its parity is
# proven after 20261116203817 by metric-source-contract-retirement.pg17.sh.
METRIC_SOURCES='["bitget_cfd","bitget_futures","bitget_spot","kucoin_futures","okx_futures","okx_spot","toobit_futures","xt_futures"]'
EXPECTED_JSON="$(cd "$ROOT_DIR" && METRIC_SOURCES="$METRIC_SOURCES" npx --no-install tsx -e '
import { getRegisteredMetricSourceContract } from "./lib/metric-trust"
import { OKX_LEADERBOARD_EXHAUSTION } from "./lib/ingest/adapters/okx"
import { BINANCE_WEB3_LEADERBOARD_EXHAUSTION } from "./lib/ingest/adapters/binance-web3"
const slugs: string[] = JSON.parse(process.env.METRIC_SOURCES!)
const metrics = slugs.flatMap((slug) => {
  const contract = getRegisteredMetricSourceContract(slug)!
  return contract.fields.map((f) => ({
    source: slug, version: contract.version, metric: f.metric, field_path: f.fieldPath,
    provenance: f.provenance, methodology_version: f.methodologyVersion, metric_set_id: f.metricSetId,
    timeframes: f.windowKeys.map((w) => Number(w.slice(0, -1))).sort((a, b) => a - b),
    value_unit: f.valueUnit, currencies: [...f.currencies].sort(),
    required_raw_roles: [...f.requiredRawRoles].sort(), scope: f.sourcePayloadScope,
    freshness_ms: f.maxFreshnessMs, lag_ms: f.maxWindowEndLagMs }))
})
const exhaustion = [
  { source: "binance_web3_bsc", declaration: BINANCE_WEB3_LEADERBOARD_EXHAUSTION },
  { source: "okx_futures", declaration: OKX_LEADERBOARD_EXHAUSTION },
  { source: "okx_spot", declaration: OKX_LEADERBOARD_EXHAUSTION },
]
console.log(JSON.stringify({ metrics, exhaustion }))
')"

assert_equal "metric contract rows equal the lib/metric-trust.ts registry" "t" "$(
  psql_db main -Atq -v expected="$EXPECTED_JSON" -v sources="$METRIC_SOURCES" <<'SQL'
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
    AND source_row.slug IN (SELECT pg_catalog.jsonb_array_elements_text(:'sources'::jsonb))
),
expected AS (SELECT pg_catalog.jsonb_array_elements((:'expected'::jsonb)->'metrics') AS item)
SELECT (SELECT count(*) FROM actual) = (SELECT count(*) FROM expected)
   AND NOT EXISTS (SELECT item FROM expected EXCEPT SELECT item FROM actual)
SQL
)"

assert_equal "exhaustion contract rows equal the adapter declarations" "t" "$(
  psql_db main -Atq -v expected="$EXPECTED_JSON" <<'SQL'
WITH actual AS (
  SELECT pg_catalog.jsonb_build_object(
    'source', source_row.slug, 'declaration', contract.declaration
  ) AS item
  FROM arena.leaderboard_exhaustion_contracts AS contract
  JOIN arena.sources AS source_row ON source_row.id = contract.source_id
  WHERE contract.completeness_contract = 'arena.ingest.leaderboard-exhaustion-completeness@1'
),
expected AS (SELECT pg_catalog.jsonb_array_elements((:'expected'::jsonb)->'exhaustion') AS item)
SELECT (SELECT count(*) FROM actual) = (SELECT count(*) FROM expected)
   AND NOT EXISTS (SELECT item FROM expected EXCEPT SELECT item FROM actual)
SQL
)"

assert_equal "V3 capture: #477 sources plus the newly covered ones, not bitget_futures/xt_spot" \
  "binance_futures,binance_web3_bsc,bitget_cfd,bitget_spot,kucoin_futures,lbank_futures,okx_futures,okx_spot,toobit_futures,xt_futures" \
  "$(psql_db main -Atqc "
    SELECT string_agg(source_row.slug, ',' ORDER BY source_row.slug)
      FROM arena.leaderboard_capture_contracts AS capture
      JOIN arena.sources AS source_row ON source_row.id = capture.source_id
     WHERE capture.capture_contract = 'arena.ingest.leaderboard-acquisition-manifest@3'
       AND capture.adapter_slug = source_row.adapter_slug
       AND capture.attempt_binding_contract = 'arena.ingest.leaderboard-acquisition-attempt-binding@1'
       AND capture.requires_runner_git_sha")"

assert_equal "seeded source configuration corrected" \
  "binance_web3_bsc:{7,30,90}:USD:24|kucoin_futures:{30}:USDT:12|okx_futures:{90}:USDT:|okx_spot:{90}:USDT:|toobit_futures:{7,30,90}:USDT:1000|xt_futures:{7,30,90}:USDT:1000|xt_spot:{7,30,90}:USDT:10" \
  "$(psql_db main -Atqc "
    SELECT string_agg(slug || ':' || timeframes_native::text || ':' || currency || ':' ||
                      COALESCE(page_size::text, ''), '|' ORDER BY slug)
      FROM arena.sources
     WHERE slug IN ('binance_web3_bsc', 'kucoin_futures', 'okx_futures', 'okx_spot',
                    'toobit_futures', 'xt_futures', 'xt_spot')")"

# ── A registered declaration holds for a complete board, not a moved one ──

okx_holds() {
  local second_token="$1"
  psql_db main -Atq -v token2="$second_token" <<'SQL'
WITH contract AS (
  SELECT contract.source_id, contract.declaration
    FROM arena.leaderboard_exhaustion_contracts AS contract
    JOIN arena.sources AS source_row ON source_row.id = contract.source_id
   WHERE source_row.slug = 'okx_futures'
)
SELECT arena.leaderboard_exhaustion_completeness_holds(
  contract.source_id,
  pg_catalog.jsonb_build_object(
    'data_contract', 'arena.ingest.leaderboard-exhaustion-completeness@1',
    'declaration', contract.declaration,
    'pages', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('ordinal', 1, 'request_sha256', pg_catalog.repeat('a', 64),
        'response_sha256', pg_catalog.repeat('b', 64), 'row_count', 20,
        'row_keys_sha256', pg_catalog.repeat('c', 64),
        'version_token_sha256', pg_catalog.repeat('d', 64), 'end_signal_value', 2),
      pg_catalog.jsonb_build_object('ordinal', 2, 'request_sha256', pg_catalog.repeat('e', 64),
        'response_sha256', pg_catalog.repeat('f', 64), 'row_count', 8,
        'row_keys_sha256', pg_catalog.repeat('1', 64),
        'version_token_sha256', :'token2', 'end_signal_value', 2)
    ),
    'row_keys', pg_catalog.jsonb_build_object('observed', 28, 'distinct', 28, 'duplicate', 0),
    'board_version', pg_catalog.jsonb_build_object('kind', 'token')
  ),
  'reported_page_count_reached', 2, 'unknown', 28, 28, 0, 0
)
FROM contract
SQL
}
assert_equal "registered okx declaration holds for a complete pinned board" "t" \
  "$(okx_holds "$(printf 'd%.0s' {1..64})")"
assert_equal "registered okx declaration fails when the version token changes" "f" \
  "$(okx_holds "$(printf '2%.0s' {1..64})")"

# ── Replay and drift refuse the whole migration ──

AFTER="$(registry_rows main)"
expect_failure main "replay" "board metric source contracts already registered for:"
assert_equal "refused replay changes nothing" "$AFTER" "$(registry_rows main)"

psql_db adapter_drift -q -c "UPDATE arena.sources SET adapter_slug = 'okx_v2' WHERE slug = 'okx_spot'"
expect_failure adapter_drift "adapter drift" "public source capture adapter drift: okx_spot"
assert_equal "refused adapter drift leaves no rows" "$BEFORE" "$(registry_rows adapter_drift)"

psql_db window_gap -q -c "UPDATE arena.sources SET timeframes_native = '{7,30}' WHERE slug = 'kucoin_futures'"
expect_failure window_gap "native window without a contract" \
  "attempt-bound capture needs a population metric contract for: kucoin_futures:7d"
assert_equal "refused window gap leaves no rows" "$BEFORE" "$(registry_rows window_gap)"
assert_equal "refused window gap leaves the source configuration" "{7,30}" \
  "$(psql_db window_gap -Atqc "SELECT timeframes_native FROM arena.sources WHERE slug = 'kucoin_futures'")"

psql_db currency_drift -q -c "UPDATE arena.sources SET currency = 'USDC' WHERE slug = 'binance_web3_bsc'"
expect_failure currency_drift "currency the contract does not cover" \
  "attempt-bound capture needs a population metric contract for: binance_web3_bsc:7d"
psql_db currency_drift -q -c "UPDATE arena.sources SET currency = 'USDC' WHERE slug = 'bitget_spot'"
expect_failure currency_drift "board contract currency drift" \
  "board metric source contract currency drift: bitget_spot"
assert_equal "refused currency drift leaves no rows" "$BEFORE" "$(registry_rows currency_drift)"

# ── Absent sources are skipped ──

psql_db absent -q -c "DELETE FROM arena.sources WHERE slug IN ('toobit_futures', 'okx_spot')"
psql_db absent -q -f "$TARGET"
assert_equal "absent sources skipped, the rest registered" \
  "binance_web3_bsc,okx_futures|binance_web3_bsc,bitget_cfd,bitget_spot,kucoin_futures,okx_futures,xt_futures" \
  "$(psql_db absent -Atqc "
    SELECT (SELECT string_agg(s.slug, ',' ORDER BY s.slug)
              FROM arena.leaderboard_exhaustion_contracts AS c
              JOIN arena.sources AS s ON s.id = c.source_id) || '|' ||
           (SELECT string_agg(s.slug, ',' ORDER BY s.slug)
              FROM arena.leaderboard_capture_contracts AS c
              JOIN arena.sources AS s ON s.id = c.source_id
             WHERE s.slug NOT IN ('binance_futures', 'lbank_futures'))")"

echo "public source exhaustion and total capture PG17 proof passed"

# ── 20261116204359 (replaces 20261115170535): okx/toobit/xt as local, publicly ranked sources ──
#
#   + on the post-160917 state the four flip to active/serving/local, nothing
#     else changes, and they join arena_freshness_expected_sources (real
#     20260718134000) with exactly their native windows
#   - a replay refuses and changes nothing
#   - a drifted status / serving_mode / region / window / adapter, a missing
#     row, or a missing 160917 capture registration refuses with no write

ACTIVATION="$MIGRATIONS/20261116204359_move_public_sources_to_local_region_prod_state.sql"

expect_activation_failure() {
  local db="$1" label="$2" expected="$3"
  if psql_db "$db" -q -f "$ACTIVATION" >"$ERROR_FILE" 2>&1; then
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

sources_state() {
  psql_db "$1" -Atqc "
    SELECT string_agg(slug || ':' || status || ':' || serving_mode || ':' || fetch_region ||
                      ':' || timeframes_native::text || ':' || COALESCE(page_size::text, ''),
                      '|' ORDER BY slug)
      FROM arena.sources"
}

four_state() {
  psql_db "$1" -Atqc "
    SELECT string_agg(slug || ':' || status || ':' || serving_mode || ':' || fetch_region,
                      '|' ORDER BY slug)
      FROM arena.sources
     WHERE slug IN ('okx_futures', 'okx_spot', 'toobit_futures', 'xt_futures')"
}

# Post-160917 state for the success, replay and drift cases.
for db in act_main act_status act_serving act_region act_window act_adapter; do
  "$PG_BIN/createdb" -h "$SOCKET_DIR" -p "$PORT" -T main "$db"
done
# Pre-160917 state with 160917's source corrections applied by hand, so only
# the missing capture/exhaustion registration (or a missing row) differs.
for db in act_no_capture act_missing_row; do
  "$PG_BIN/createdb" -h "$SOCKET_DIR" -p "$PORT" -T postgres "$db"
  psql_db "$db" -q -c "
    UPDATE arena.sources SET timeframes_native = '{90}' WHERE slug IN ('okx_futures', 'okx_spot');
    UPDATE arena.sources SET page_size = 1000 WHERE slug IN ('toobit_futures', 'xt_futures');"
done

assert_equal "seed pre-state of the four (after 160917)" \
  "okx_futures:blocked_pending_vps:legacy:vps_sg|okx_spot:blocked_pending_vps:legacy:vps_sg|toobit_futures:blocked_pending_vps:legacy:vps_sg|xt_futures:inactive:legacy:local" \
  "$(four_state act_main)"

# The real expected-source authority, on a minimal exchanges dimension.
psql_db act_main -q <<'SQL'
CREATE TABLE arena.exchanges (id smallint PRIMARY KEY, name text NOT NULL);
INSERT INTO arena.exchanges VALUES (1, 'Exchange');
ALTER TABLE arena.sources ADD COLUMN exchange_id smallint NOT NULL DEFAULT 1
  REFERENCES arena.exchanges(id);
SQL
psql_db act_main -q -f "$MIGRATIONS/20260718134000_freshness_expected_sources.sql" >/dev/null

expected_four() {
  psql_db act_main -Atqc "
    SELECT COALESCE(string_agg(registry_slug || ':' || season_id, ',' ORDER BY registry_slug, season_id), '')
      FROM public.arena_freshness_expected_sources()
     WHERE registry_slug IN ('okx_futures', 'okx_spot', 'toobit_futures', 'xt_futures')"
}
assert_equal "before activation none of the four is an expected source" "" "$(expected_four)"

OTHERS_BEFORE="$(psql_db act_main -Atqc "
  SELECT string_agg(s::text, '|' ORDER BY s.id) FROM arena.sources AS s
   WHERE slug NOT IN ('okx_futures', 'okx_spot', 'toobit_futures', 'xt_futures')")"
REGISTRY_BEFORE="$(registry_rows act_main)"

psql_db act_main -q -f "$ACTIVATION"
echo "ok: activation applies on the post-160917 seed state"

assert_equal "the four are active/serving/local" \
  "okx_futures:active:serving:local|okx_spot:active:serving:local|toobit_futures:active:serving:local|xt_futures:active:serving:local" \
  "$(four_state act_main)"
assert_equal "no other source row changed" "$OTHERS_BEFORE" "$(psql_db act_main -Atqc "
  SELECT string_agg(s::text, '|' ORDER BY s.id) FROM arena.sources AS s
   WHERE slug NOT IN ('okx_futures', 'okx_spot', 'toobit_futures', 'xt_futures')")"
assert_equal "activation writes no contract rows" "$REGISTRY_BEFORE" "$(registry_rows act_main)"
assert_equal "the four join the expected set with their native windows only" \
  "okx_futures:90D,okx_spot:90D,toobit_futures:30D,toobit_futures:7D,toobit_futures:90D,xt_futures:30D,xt_futures:7D,xt_futures:90D" \
  "$(expected_four)"

ACTIVATED="$(sources_state act_main)"
# xt_futures at the target equals its production pre-state, so only the three
# rows that moved region are reported.
expect_activation_failure act_main "activation replay" \
  "local public source activation pre-state drift: okx_futures, okx_spot, toobit_futures"
assert_equal "refused activation replay changes nothing" "$ACTIVATED" "$(sources_state act_main)"

drift_case() {
  local db="$1" label="$2" sql="$3" expected="$4"
  psql_db "$db" -q -c "$sql"
  local before
  before="$(sources_state "$db")"
  expect_activation_failure "$db" "$label" "$expected"
  assert_equal "refused $label leaves every source row as it was" "$before" "$(sources_state "$db")"
}

drift_case act_status "status drift" \
  "UPDATE arena.sources SET status = 'inactive' WHERE slug = 'okx_spot'" \
  "local public source activation pre-state drift: okx_spot"
drift_case act_serving "serving_mode drift" \
  "UPDATE arena.sources SET serving_mode = 'shadow' WHERE slug = 'xt_futures'" \
  "local public source activation pre-state drift: xt_futures"
drift_case act_region "region drift" \
  "UPDATE arena.sources SET fetch_region = 'vps_jp' WHERE slug = 'toobit_futures'" \
  "local public source activation pre-state drift: toobit_futures"
drift_case act_window "native window drift" \
  "UPDATE arena.sources SET timeframes_native = '{7,30,90}' WHERE slug = 'okx_futures'" \
  "local public source activation pre-state drift: okx_futures"
drift_case act_adapter "adapter drift" \
  "UPDATE arena.sources SET adapter_slug = 'xt_v2' WHERE slug = 'xt_futures'" \
  "local public source activation pre-state drift: xt_futures"
drift_case act_missing_row "missing source row" \
  "DELETE FROM arena.sources WHERE slug = 'okx_spot'" \
  "local public source activation pre-state drift: okx_spot"

NO_CAPTURE_BEFORE="$(sources_state act_no_capture)"
expect_activation_failure act_no_capture "activation before 160917 registers capture" \
  "requires the 20261115160917 V3 capture contract for: okx_futures, okx_spot, toobit_futures, xt_futures"
assert_equal "refused pre-160917 activation leaves every source row as it was" \
  "$NO_CAPTURE_BEFORE" "$(sources_state act_no_capture)"

# Production pre-state (read 2026-11-17): already active/serving, okx and
# toobit on vps_sg, okx deriving 7/30 with page_size 20.
"$PG_BIN/createdb" -h "$SOCKET_DIR" -p "$PORT" -T main act_prod
psql_db act_prod -q -c "
  UPDATE arena.sources SET status = 'active', serving_mode = 'serving'
   WHERE slug IN ('okx_futures', 'okx_spot', 'toobit_futures', 'xt_futures');
  UPDATE arena.sources SET timeframes_derived = '{7,30}', page_size = 20
   WHERE slug IN ('okx_futures', 'okx_spot');"
PROD_OTHERS_BEFORE="$(psql_db act_prod -Atqc "
  SELECT string_agg(s::text, '|' ORDER BY s.id) FROM arena.sources AS s
   WHERE slug NOT IN ('okx_futures', 'okx_spot', 'toobit_futures')")"
psql_db act_prod -q -f "$ACTIVATION"
echo "ok: activation applies on the production pre-state"
assert_equal "production pre-state converges to active/serving/local" \
  "okx_futures:active:serving:local|okx_spot:active:serving:local|toobit_futures:active:serving:local|xt_futures:active:serving:local" \
  "$(four_state act_prod)"
assert_equal "on the production pre-state only the region of okx and toobit changes" \
  "$PROD_OTHERS_BEFORE" "$(psql_db act_prod -Atqc "
  SELECT string_agg(s::text, '|' ORDER BY s.id) FROM arena.sources AS s
   WHERE slug NOT IN ('okx_futures', 'okx_spot', 'toobit_futures')")"
assert_equal "okx keeps its derived windows and page size" "{7,30}:20|{7,30}:20" \
  "$(psql_db act_prod -Atqc "SELECT string_agg(timeframes_derived::text || ':' || page_size, '|' ORDER BY slug) FROM arena.sources WHERE slug IN ('okx_futures','okx_spot')")"

echo "local public source activation PG17 proof passed"

# ── 20261118134500: binance_futures as a live board ──
#
#   - before 20261118114230 the declaration is not valid: refused, no write
#   + after it the source is registered, and the row equals the adapter's own
#     declaration (BINANCE_FUTURES_LEADERBOARD_EXHAUSTION)
#   - a replay or a re-adaptered source refuses with no write

LIVE_PROOF="$MIGRATIONS/20261118114230_leaderboard_exhaustion_reported_total_drift.sql"
LIVE_REGISTRATION="$MIGRATIONS/20261118134500_register_binance_live_board_exhaustion_contracts.sql"
expect_live_failure() {
  local db="$1" label="$2" expected="$3"
  local before
  before="$(psql_db "$db" -Atqc "SELECT count(*) FROM arena.leaderboard_exhaustion_contracts")"
  if psql_db "$db" -q -f "$LIVE_REGISTRATION" >"$ERROR_FILE" 2>&1; then
    echo "FAIL: $label unexpectedly succeeded" >&2
    exit 1
  fi
  if [[ "$(<"$ERROR_FILE")" != *"$expected"* ]]; then
    echo "FAIL: $label failed for the wrong reason; expected: $expected" >&2
    cat "$ERROR_FILE" >&2
    exit 1
  fi
  assert_equal "$label writes nothing" "$before" \
    "$(psql_db "$db" -Atqc "SELECT count(*) FROM arena.leaderboard_exhaustion_contracts")"
}

"$PG_BIN/createdb" -h "$SOCKET_DIR" -p "$PORT" -T main live_main
expect_live_failure live_main "live registration before the drift proof" \
  "requires the reported_total_drift proof (20261118114230)"
psql_db live_main -q -f "$LIVE_PROOF"
"$PG_BIN/createdb" -h "$SOCKET_DIR" -p "$PORT" -T live_main live_adapter

psql_db live_main -q -f "$LIVE_REGISTRATION"
echo "ok: live registration applies"
LIVE_EXPECTED="$(cd "$ROOT_DIR" && npx --no-install tsx -e '
import { BINANCE_FUTURES_LEADERBOARD_EXHAUSTION } from "./lib/ingest/adapters/binance"
console.log(JSON.stringify({ binance_futures: BINANCE_FUTURES_LEADERBOARD_EXHAUSTION }))
')"
assert_equal "live registration equals the adapter declaration" "t" "$(
  psql_db live_main -Atq -v expected="$LIVE_EXPECTED" <<'SQL'
SELECT pg_catalog.jsonb_object_agg(source_row.slug, contract.declaration) = :'expected'::jsonb
  FROM arena.leaderboard_exhaustion_contracts AS contract
  JOIN arena.sources AS source_row ON source_row.id = contract.source_id
 WHERE source_row.slug LIKE 'binance\_%' AND source_row.adapter_slug = 'binance'
SQL
)"
expect_live_failure live_main "live registration replay" "already exists for: binance_futures"

psql_db live_adapter -q -c "UPDATE arena.sources SET adapter_slug = 'binance_v2' WHERE slug = 'binance_futures'"
expect_live_failure live_adapter "live registration for a re-adaptered source" \
  "source drift: binance_futures"

echo "binance live board registration PG17 proof passed"
