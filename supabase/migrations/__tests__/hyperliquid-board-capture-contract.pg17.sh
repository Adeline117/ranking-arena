#!/usr/bin/env bash
# PG17 proof for 20261118114301 (postdeploy registration of hyperliquid's
# attempt-bound V3 capture in exhaustion mode). The real metric-trust /
# attempt-ledger chain, 20261114193017, 20261114211033/211034, 20261115141050
# and 20261115160917 run on stub base tables first.
#
#   + metric contract, exhaustion contract and V3 capture rows equal the code
#     registry (lib/metric-trust.ts, HYPERLIQUID_LEADERBOARD_EXHAUSTION) field
#     by field; page_size/pagination_kind become 250000/numeric; nothing else
#     changes
#   + the registered declaration holds for a one-page short board whose
#     re-read matches, and fails for a changed re-read, a page at the
#     page-size ceiling, a rejected row, or a duplicate address
#   - a replay refuses and changes nothing
#   - adapter drift, a native 90D window and a non-USDC currency refuse the
#     whole migration and leave no rows and the source configuration as it was
#   + an absent source is skipped

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
TARGET="$MIGRATIONS/20261118114301_hyperliquid_board_capture_contract.sql"
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

TMP_ROOT="$(mktemp -d /tmp/hyperliquid-capture-pg17.XXXXXX)"
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

hyperliquid_rows() {
  psql_db "$1" -Atqc "
    SELECT (SELECT count(*) FROM arena.metric_source_contracts AS c
              JOIN arena.sources AS s ON s.id = c.source_id WHERE s.slug = 'hyperliquid') || '/' ||
           (SELECT count(*) FROM arena.leaderboard_capture_contracts AS c
              JOIN arena.sources AS s ON s.id = c.source_id WHERE s.slug = 'hyperliquid') || '/' ||
           (SELECT count(*) FROM arena.leaderboard_exhaustion_contracts AS c
              JOIN arena.sources AS s ON s.id = c.source_id WHERE s.slug = 'hyperliquid')"
}

sources_state() {
  psql_db "$1" -Atqc "
    SELECT string_agg(slug || ':' || adapter_slug || ':' || currency || ':' ||
                      timeframes_native::text || ':' || timeframes_derived::text || ':' ||
                      COALESCE(page_size::text, '') || ':' || COALESCE(pagination_kind, ''),
                      '|' ORDER BY slug)
      FROM arena.sources"
}

"$PG_BIN/initdb" -D "$DATA_DIR" --auth-local=trust --auth-host=trust \
  --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null

# Base tables as the 20260610/20260721 foundations shape them. The sources are
# the 20260610223356 seed rows the earlier registrations expect, plus
# hyperliquid as docs/hyperliquid-spike.md §7 configured it (page_size 5000,
# native 7/30, 90 derived, USDC, seeded api_cursor pagination).
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
  page_size int,
  pagination_kind text
    CHECK (pagination_kind IS NULL OR
           pagination_kind IN ('numeric', 'next_prev', 'infinite_scroll', 'api_cursor'))
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
  fetch_region, timeframes_native, timeframes_derived, page_size, pagination_kind
) VALUES
  (1, 'binance_futures', 'binance', 'active', 'serving', 'USDT', 'futures', 'vps_sg', '{7,30,90}', '{}', 20, 'numeric'),
  (2, 'binance_web3_bsc', 'binance_web3', 'active', 'serving', 'USDT', 'onchain', 'local', '{7,30,90}', '{}', 24, 'numeric'),
  (3, 'bitget_futures', 'bitget', 'active', 'serving', 'USDT', 'futures', 'local', '{7,30,90}', '{}', 30, 'numeric'),
  (4, 'bitget_spot', 'bitget', 'active', 'serving', 'USDT', 'spot', 'local', '{7,30,90}', '{}', 30, 'numeric'),
  (5, 'bitget_cfd', 'bitget', 'active', 'serving', 'USDT', 'cfd', 'local', '{7,30,90}', '{}', 30, 'numeric'),
  (6, 'kucoin_futures', 'kucoin', 'active', 'serving', 'USDT', 'futures', 'local', '{7,30,90}', '{}', 12, 'numeric'),
  (7, 'okx_futures', 'okx', 'blocked_pending_vps', 'legacy', 'USDT', 'futures', 'vps_sg', '{7,30,90}', '{}', NULL, 'numeric'),
  (8, 'okx_spot', 'okx', 'blocked_pending_vps', 'legacy', 'USDT', 'spot', 'vps_sg', '{7,30,90}', '{}', NULL, 'numeric'),
  (9, 'toobit_futures', 'toobit', 'blocked_pending_vps', 'legacy', 'USDT', 'futures', 'vps_sg', '{7,30,90}', '{}', NULL, 'numeric'),
  (10, 'xt_futures', 'xt', 'inactive', 'legacy', 'USDT', 'futures', 'local', '{7,30,90}', '{}', 10, 'numeric'),
  (11, 'xt_spot', 'xt', 'inactive', 'legacy', 'USDT', 'spot', 'local', '{7,30,90}', '{}', 10, 'numeric'),
  (12, 'lbank_futures', 'lbank', 'active', 'serving', 'USDT', 'futures', 'local', '{7,30}', '{}', 20, 'numeric'),
  (20, 'hyperliquid', 'hyperliquid', 'active', 'serving', 'USDC', 'onchain', 'local', '{7,30}', '{90}', 5000, 'api_cursor');
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
  20261115141050_leaderboard_exhaustion_completeness_evidence.sql \
  20261115160917_public_source_exhaustion_and_total_capture_contracts.sql; do
  psql_db postgres -q -f "$MIGRATIONS/$migration" >/dev/null
done

for db in main absent adapter_drift window_90 currency_drift; do
  "$PG_BIN/createdb" -h "$SOCKET_DIR" -p "$PORT" -T postgres "$db"
done
assert_equal "hyperliquid starts unregistered" "0/0/0" "$(hyperliquid_rows main)"
OTHERS_BEFORE="$(psql_db main -Atqc "
  SELECT string_agg(s::text, '|' ORDER BY s.id) FROM arena.sources AS s WHERE slug <> 'hyperliquid'")"
REGISTRY_BEFORE="$(psql_db main -Atqc "
  SELECT (SELECT count(*) FROM arena.metric_source_contracts) || '/' ||
         (SELECT count(*) FROM arena.leaderboard_capture_contracts) || '/' ||
         (SELECT count(*) FROM arena.leaderboard_exhaustion_contracts)")"

psql_db main -q -f "$TARGET"
echo "ok: migration applies"

# ── Rows equal the code registry ──

EXPECTED_JSON="$(cd "$ROOT_DIR" && npx --no-install tsx -e '
import { getRegisteredMetricSourceContract } from "./lib/metric-trust"
import { HYPERLIQUID_LEADERBOARD_EXHAUSTION } from "./lib/ingest/adapters/hyperliquid"
const contract = getRegisteredMetricSourceContract("hyperliquid")!
const metrics = contract.fields.map((f) => ({
  source: "hyperliquid", version: contract.version, metric: f.metric, field_path: f.fieldPath,
  provenance: f.provenance, methodology_version: f.methodologyVersion, metric_set_id: f.metricSetId,
  timeframes: f.windowKeys.map((w) => Number(w.slice(0, -1))).sort((a, b) => a - b),
  value_unit: f.valueUnit, currencies: [...f.currencies].sort(),
  required_raw_roles: [...f.requiredRawRoles].sort(), scope: f.sourcePayloadScope,
  freshness_ms: f.maxFreshnessMs, lag_ms: f.maxWindowEndLagMs }))
console.log(JSON.stringify({ metrics, declaration: HYPERLIQUID_LEADERBOARD_EXHAUSTION }))
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
  WHERE contract.active AND NOT contract.allow_derived_population
    AND source_row.slug = 'hyperliquid'
),
expected AS (SELECT pg_catalog.jsonb_array_elements((:'expected'::jsonb)->'metrics') AS item)
SELECT (SELECT count(*) FROM actual) = 4
   AND (SELECT count(*) FROM actual) = (SELECT count(*) FROM expected)
   AND NOT EXISTS (SELECT item FROM expected EXCEPT SELECT item FROM actual)
SQL
)"

assert_equal "exhaustion contract row equals HYPERLIQUID_LEADERBOARD_EXHAUSTION" "t" "$(
  psql_db main -Atq -v expected="$EXPECTED_JSON" <<'SQL'
SELECT pg_catalog.count(*) = 1
   AND pg_catalog.bool_and(
         contract.declaration = (:'expected'::jsonb)->'declaration'
         AND contract.completeness_contract = 'arena.ingest.leaderboard-exhaustion-completeness@1'
       )
  FROM arena.leaderboard_exhaustion_contracts AS contract
  JOIN arena.sources AS source_row ON source_row.id = contract.source_id
 WHERE source_row.slug = 'hyperliquid'
SQL
)"

assert_equal "V3 attempt-bound capture registered for hyperliquid" "1" "$(psql_db main -Atqc "
  SELECT count(*)
    FROM arena.leaderboard_capture_contracts AS capture
    JOIN arena.sources AS source_row ON source_row.id = capture.source_id
   WHERE source_row.slug = 'hyperliquid'
     AND capture.capture_contract = 'arena.ingest.leaderboard-acquisition-manifest@3'
     AND capture.adapter_slug = 'hyperliquid'
     AND capture.attempt_binding_contract = 'arena.ingest.leaderboard-acquisition-attempt-binding@1'
     AND capture.requires_runner_git_sha")"

assert_equal "hyperliquid capture mechanics set, windows and currency kept" \
  "hyperliquid:hyperliquid:USDC:{7,30}:{90}:250000:numeric" \
  "$(psql_db main -Atqc "
    SELECT slug || ':' || adapter_slug || ':' || currency || ':' || timeframes_native::text ||
           ':' || timeframes_derived::text || ':' || page_size || ':' || pagination_kind
      FROM arena.sources WHERE slug = 'hyperliquid'")"
assert_equal "no other source row changed" "$OTHERS_BEFORE" "$(psql_db main -Atqc "
  SELECT string_agg(s::text, '|' ORDER BY s.id) FROM arena.sources AS s WHERE slug <> 'hyperliquid'")"
assert_equal "only the hyperliquid rows were added" "$REGISTRY_BEFORE" "$(psql_db main -Atqc "
  SELECT ((SELECT count(*) FROM arena.metric_source_contracts) - 4) || '/' ||
         ((SELECT count(*) FROM arena.leaderboard_capture_contracts) - 1) || '/' ||
         ((SELECT count(*) FROM arena.leaderboard_exhaustion_contracts) - 1)")"

# ── The registered declaration binds one short page with a matching re-read ──

holds() {
  local row_count="$1" reread_keys="$2" rejected="$3" distinct="$4" duplicate="$5"
  psql_db main -Atq -v rows="$row_count" -v reread="$reread_keys" -v rejected="$rejected" \
    -v distinct="$distinct" -v duplicate="$duplicate" <<'SQL'
WITH contract AS (
  SELECT contract.source_id, contract.declaration
    FROM arena.leaderboard_exhaustion_contracts AS contract
    JOIN arena.sources AS source_row ON source_row.id = contract.source_id
   WHERE source_row.slug = 'hyperliquid'
)
SELECT arena.leaderboard_exhaustion_completeness_holds(
  contract.source_id,
  pg_catalog.jsonb_build_object(
    'data_contract', 'arena.ingest.leaderboard-exhaustion-completeness@1',
    'declaration', contract.declaration,
    'pages', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('ordinal', 1, 'request_sha256', pg_catalog.repeat('a', 64),
        'response_sha256', pg_catalog.repeat('b', 64), 'row_count', (:'rows')::int,
        'row_keys_sha256', pg_catalog.repeat('c', 64),
        'version_token_sha256', NULL, 'end_signal_value', NULL)
    ),
    'row_keys', pg_catalog.jsonb_build_object(
      'observed', (:'rows')::int, 'distinct', (:'distinct')::int,
      'duplicate', (:'duplicate')::int),
    'board_version', pg_catalog.jsonb_build_object(
      'kind', 'first_page_reread',
      'reread', pg_catalog.jsonb_build_object(
        'request_sha256', pg_catalog.repeat('a', 64),
        'response_sha256', pg_catalog.repeat('b', 64),
        'http_status', 200,
        'row_keys_sha256', :'reread'))
  ),
  'short_page', 1, 'unknown', (:'rows')::int, (:'distinct')::int - (:'rejected')::int,
  (:'rejected')::int, (:'duplicate')::int
)
FROM contract
SQL
}
SAME="$(printf 'c%.0s' {1..64})"
MOVED="$(printf 'd%.0s' {1..64})"
assert_equal "a 48,027-row single short page with a matching re-read binds" "t" \
  "$(holds 48027 "$SAME" 0 48027 0)"
assert_equal "a changed re-read does not bind" "f" "$(holds 48027 "$MOVED" 0 48027 0)"
assert_equal "a page at the page-size ceiling does not bind" "f" \
  "$(holds 250000 "$SAME" 0 250000 0)"
assert_equal "a rejected row does not bind" "f" "$(holds 48027 "$SAME" 1 48027 0)"
assert_equal "a duplicate address does not bind" "f" "$(holds 48027 "$SAME" 0 48026 1)"

# ── Replay and drift refuse the whole migration ──

AFTER="$(hyperliquid_rows main)"
STATE_AFTER="$(sources_state main)"
expect_failure main "replay" "board metric source contracts already registered for: hyperliquid"
assert_equal "refused replay changes nothing" "$AFTER" "$(hyperliquid_rows main)"
assert_equal "refused replay leaves the source configuration" "$STATE_AFTER" "$(sources_state main)"

drift_case() {
  local db="$1" label="$2" sql="$3" expected="$4"
  psql_db "$db" -q -c "$sql"
  local before
  before="$(sources_state "$db")"
  expect_failure "$db" "$label" "$expected"
  assert_equal "refused $label leaves no hyperliquid rows" "0/0/0" "$(hyperliquid_rows "$db")"
  assert_equal "refused $label leaves every source row as it was" "$before" "$(sources_state "$db")"
}

drift_case adapter_drift "adapter drift" \
  "UPDATE arena.sources SET adapter_slug = 'hyperliquid_v2' WHERE slug = 'hyperliquid'" \
  "hyperliquid capture adapter drift: hyperliquid"
drift_case window_90 "a native 90D window (allTime is not a 90-day board)" \
  "UPDATE arena.sources SET timeframes_native = '{7,30,90}', timeframes_derived = '{}' WHERE slug = 'hyperliquid'" \
  "attempt-bound capture needs a population metric contract for: hyperliquid:90d"
drift_case currency_drift "a currency the contract does not cover" \
  "UPDATE arena.sources SET currency = 'USDT' WHERE slug = 'hyperliquid'" \
  "hyperliquid board metric contract currency drift: hyperliquid"

# ── An absent source is skipped ──

psql_db absent -q -c "DELETE FROM arena.sources WHERE slug = 'hyperliquid'"
ABSENT_BEFORE="$(sources_state absent)"
ABSENT_REGISTRY="$(psql_db absent -Atqc "
  SELECT (SELECT count(*) FROM arena.metric_source_contracts) || '/' ||
         (SELECT count(*) FROM arena.leaderboard_capture_contracts) || '/' ||
         (SELECT count(*) FROM arena.leaderboard_exhaustion_contracts)")"
psql_db absent -q -f "$TARGET"
assert_equal "absent hyperliquid is skipped and no source changes" \
  "$ABSENT_BEFORE" "$(sources_state absent)"
assert_equal "absent hyperliquid adds no contract rows" "$ABSENT_REGISTRY" "$(psql_db absent -Atqc "
  SELECT (SELECT count(*) FROM arena.metric_source_contracts) || '/' ||
         (SELECT count(*) FROM arena.leaderboard_capture_contracts) || '/' ||
         (SELECT count(*) FROM arena.leaderboard_exhaustion_contracts)")"

echo "hyperliquid board capture contract PG17 proof passed"
