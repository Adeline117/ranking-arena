#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260721120000_metric_trust_shadow_gate.sql"
IDENTITY_MIGRATION="$ROOT_DIR/supabase/migrations/20260721150000_metric_trust_raw_artifact_identity.sql"
SCORE_INPUT_MIGRATION="$ROOT_DIR/supabase/migrations/20260721180903_metric_rankable_score_inputs_shadow.sql"
LEDGER_MIGRATION="$ROOT_DIR/supabase/migrations/20260722030000_durable_leaderboard_acquisition_attempt_ledger.sql"
COMPAT_MIGRATION="$ROOT_DIR/supabase/migrations/20260722040000_leaderboard_acquisition_manifest_v3_compat.sql"
TERMINAL_FENCE_MIGRATION="$ROOT_DIR/supabase/migrations/20260722042000_leaderboard_terminal_publication_fence.sql"
AUTHORITY_MIGRATION="$ROOT_DIR/supabase/migrations/20260722050000_metric_trust_attempt_outcome_authority.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/metric-trust-shadow-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((58000 + ($$ % 7000)))}"
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

expect_failure() {
  local label="$1"
  local sql="$2"
  local expected="${3:-}"
  local sqlstate="${4:-}"
  if psql_cmd -q -v VERBOSITY=verbose -c "$sql" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if [[ -n "$expected" ]] && [[ "$(<"$ERROR_FILE")" != *"$expected"* ]]; then
    echo "$label failed for the wrong reason; expected: $expected" >&2
    cat "$ERROR_FILE" >&2
    exit 1
  fi
  if [[ -n "$sqlstate" ]] && [[ "$(<"$ERROR_FILE")" != *"$sqlstate"* ]]; then
    echo "$label returned the wrong SQLSTATE; expected: $sqlstate" >&2
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
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE leaked_default_role NOLOGIN;
CREATE ROLE postgres NOLOGIN SUPERUSER;
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

INSERT INTO arena.sources (
  id, slug, adapter_slug, status, serving_mode, currency, product_type,
  fetch_region, meta,
  timeframes_native, timeframes_derived
) VALUES
  (
    1, 'binance_futures', 'binance', 'active', 'serving', 'USDT', 'futures',
    'vps_sg', '{}', '{30}', '{}'
  ),
  (
    2, 'binance_web3_bsc', 'binance_web3', 'active', 'serving', 'USDT', 'onchain',
    'vps_sg', '{}', '{30}', '{}'
  );

GRANT USAGE ON SCHEMA arena TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA arena TO service_role;
SQL

psql_cmd -q -f "$MIGRATION"
psql_cmd -q -f "$IDENTITY_MIGRATION"
psql_cmd -q -f "$SCORE_INPUT_MIGRATION"
psql_cmd -q -f "$LEDGER_MIGRATION"
psql_cmd -q -f "$COMPAT_MIGRATION"
psql_cmd -q -f "$TERMINAL_FENCE_MIGRATION"
psql_cmd -q -c \
  'ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO leaked_default_role;'
psql_cmd -q -f "$AUTHORITY_MIGRATION"

AUTHORITY_ACL="$(
  psql_cmd -Atqc "
    SELECT
      pg_catalog.has_function_privilege(
        'leaked_default_role',
        'arena.lock_leaderboard_acquisition_source_window(integer,integer)',
        'EXECUTE'
      ),
      pg_catalog.has_function_privilege(
        'leaked_default_role',
        'arena.validate_metric_trust_attempt_outcome_authority()',
        'EXECUTE'
      ),
      (
        SELECT pg_catalog.count(*)
          FROM pg_catalog.pg_proc AS function_row
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(
              function_row.proacl,
              pg_catalog.acldefault('f', function_row.proowner)
            )
          ) AS privilege_row
         WHERE function_row.oid IN (
                 'arena.lock_leaderboard_acquisition_source_window(integer,integer)'::pg_catalog.regprocedure,
                 'arena.validate_metric_trust_attempt_outcome_authority()'::pg_catalog.regprocedure
               )
           AND privilege_row.privilege_type = 'EXECUTE'
           AND privilege_row.grantee <> function_row.proowner
      );
  "
)"
if [[ "$AUTHORITY_ACL" != "f|f|0" ]]; then
  echo "metric-trust authority function ACL leaked: $AUTHORITY_ACL" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
INSERT INTO arena.traders (
  id, source_id, exchange_trader_id, nickname, trader_kind
) VALUES
  (10, 1, 'portfolio-10', 'Ten', 'human'),
  (11, 1, 'portfolio-11', 'Eleven', 'human'),
  (12, 1, 'portfolio-12', 'Twelve', 'human'),
  (13, 1, 'portfolio-13', 'Thirteen', 'human');

-- The run id is the digest of the canonical population manifest. Two extra
-- RAW objects exercise digest and snapshot-payload forgery checks below.
INSERT INTO arena.raw_objects (
  source_id, job_type, timeframe, storage_path, bytes, content_hash,
  quarantined, meta, source_run_id, trust_artifact_role, fetched_at
) VALUES
  (
    1, 'tier_a', 30, 'binance/run-1/page.json.gz', 10, repeat('a', 64),
    false,
    '{"raw_integrity":{"hash_algorithm":"sha256","hash_scope":"json_utf8"}}',
    repeat('b', 64),
    'source_payload',
    statement_timestamp() - interval '3 minutes'
  ),
  (
    1, 'tier_a_manifest', 30, 'binance/run-1/manifest.json.gz', 10, repeat('b', 64),
    false,
    '{
      "data_contract":"arena.ingest.leaderboard-acquisition-manifest@2",
      "raw_integrity":{"hash_algorithm":"sha256","hash_scope":"json_utf8"}
    }',
    repeat('b', 64),
    'population_manifest',
    statement_timestamp() - interval '1 minute'
  ),
  (
    1, 'metric_event_history', 30, 'binance/run-1/events.json.gz', 10, repeat('c', 64),
    false,
    '{"raw_integrity":{"hash_algorithm":"sha256","hash_scope":"json_utf8"}}',
    repeat('b', 64),
    'event_history',
    statement_timestamp() - interval '2 minutes'
  ),
  (
    1, 'tier_a_alt', 30, 'binance/run-1/alternate-page.json.gz', 10, repeat('d', 64),
    false,
    '{"raw_integrity":{"hash_algorithm":"sha256","hash_scope":"json_utf8"}}',
    repeat('b', 64),
    'source_payload',
    statement_timestamp() - interval '2 minutes'
  );

INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, scraped_at, actual_count,
  count_check_passed, is_derived, raw_object_id
)
SELECT
  100,
  1,
  30,
  statement_timestamp(),
  4,
  true,
  false,
  id
FROM arena.raw_objects
WHERE job_type = 'tier_a';

INSERT INTO arena.leaderboard_entries (
  scraped_at, snapshot_id, trader_id, timeframe, rank, currency
)
SELECT
  snapshot.scraped_at,
  snapshot.id,
  trader.id,
  snapshot.timeframe,
  (pg_catalog.row_number() OVER (ORDER BY trader.id))::int,
  'USDT'
FROM arena.leaderboard_snapshots AS snapshot
CROSS JOIN arena.traders AS trader
WHERE snapshot.id = 100;

INSERT INTO arena.metric_trust_runs (
  source_run_id,
  source_id,
  timeframe,
  snapshot_id,
  snapshot_scraped_at,
  population_raw_object_id,
  manifest_raw_object_id,
  started_at,
  completed_at,
  reported_population,
  fetched_population,
  caller_limited,
  acquisition_state,
  population_state
)
SELECT
  repeat('b', 64),
  1,
  30,
  snapshot.id,
  snapshot.scraped_at,
  population.id,
  manifest.id,
  statement_timestamp() - interval '4 minutes',
  statement_timestamp() - interval '1 minute',
  4,
  4,
  false,
  'complete',
  'verified'
FROM arena.leaderboard_snapshots AS snapshot
JOIN arena.raw_objects AS population
  ON population.id = snapshot.raw_object_id
JOIN arena.raw_objects AS manifest
  ON manifest.job_type = 'tier_a_manifest'
WHERE snapshot.id = 100;

-- Test-only normalized alternatives share the board metric set. They prove
-- selection happens after a compatible ROI+PnL pair exists.
INSERT INTO arena.metric_source_contracts (
  source_id,
  contract_version,
  metric,
  field_path,
  provenance,
  methodology_version,
  metric_set_id,
  timeframes,
  value_unit,
  currencies,
  required_raw_roles,
  source_payload_scope,
  max_freshness,
  max_window_end_lag
)
SELECT
  1,
  '1',
  metric,
  field_path,
  'source_normalized',
  methodology_version,
  'binance-board-roi-pnl@1',
  ARRAY[30]::smallint[],
  value_unit,
  ARRAY['USDT']::text[],
  ARRAY['source_payload', 'population_manifest']::text[],
  'population_snapshot',
  interval '6 hours',
  interval '5 minutes'
FROM (VALUES
  ('roi'::text, 'test.normalized.roi'::text, 'test-normalized-roi@1'::text, 'percent'::text),
  ('pnl'::text, 'test.normalized.pnl'::text, 'test-normalized-pnl@1'::text, 'currency'::text)
) AS test_contract(metric, field_path, methodology_version, value_unit);

WITH snapshot AS (
  SELECT id, scraped_at
  FROM arena.leaderboard_snapshots
  WHERE id = 100
), contracts AS (
  SELECT id, metric, field_path, provenance, methodology_version
  FROM arena.metric_source_contracts
  WHERE source_id = 1
    AND field_path IN ('data.list[].roi', 'data.list[].pnl')
)
INSERT INTO arena.metric_trust_observations (
  contract_id, trader_id, source_id, snapshot_id, snapshot_scraped_at,
  source_run_id, source_contract_version, timeframe, metric, field_path,
  provenance, methodology_version, value, value_unit, currency,
  source_as_of, valid_until, window_start, window_end, quality,
  history_state, price_state, cost_basis_state, population_state,
  window_state, unit_state, freshness_state, blocking_reasons
)
SELECT
  contracts.id,
  10,
  1,
  snapshot.id,
  snapshot.scraped_at,
  repeat('b', 64),
  '1',
  30,
  contracts.metric,
  contracts.field_path,
  contracts.provenance,
  contracts.methodology_version,
  CASE contracts.metric WHEN 'roi' THEN 12.5 ELSE 1200 END,
  CASE contracts.metric WHEN 'roi' THEN 'percent' ELSE 'currency' END,
  'USDT',
  statement_timestamp() - interval '2 minutes',
  statement_timestamp() + interval '5 hours',
  statement_timestamp() - interval '30 days 2 minutes',
  statement_timestamp() - interval '2 minutes',
  'complete',
  'source_owned',
  'source_owned',
  'source_owned',
  'verified',
  'verified',
  'verified',
  'verified',
  '[]'::jsonb
FROM contracts
CROSS JOIN snapshot;

-- A complete-looking RAW chain cannot promote a partial metric. Keep this
-- trader discoverable in the evidence table but absent from both rank views.
INSERT INTO arena.metric_trust_observations (
  contract_id, trader_id, source_id, snapshot_id, snapshot_scraped_at,
  source_run_id, source_contract_version, timeframe, metric, field_path,
  provenance, methodology_version, value, value_unit, currency,
  source_as_of, valid_until, window_start, window_end, quality,
  history_state, price_state, cost_basis_state, population_state,
  window_state, unit_state, freshness_state, blocking_reasons
)
SELECT
  contract_id,
  11,
  source_id,
  snapshot_id,
  snapshot_scraped_at,
  source_run_id,
  source_contract_version,
  timeframe,
  metric,
  field_path,
  provenance,
  methodology_version,
  value,
  value_unit,
  currency,
  source_as_of,
  valid_until,
  window_start,
  window_end,
  'partial',
  'partial',
  price_state,
  cost_basis_state,
  population_state,
  window_state,
  unit_state,
  freshness_state,
  '[{"code":"history_incomplete","state":"partial"}]'::jsonb
FROM arena.metric_trust_observations
WHERE trader_id = 10;

-- Both fields are individually complete, but board ROI and profile PnL are
-- different registered metric sets and must never become one ranking input.
WITH snapshot AS (
  SELECT id, scraped_at
  FROM arena.leaderboard_snapshots
  WHERE id = 100
), contracts AS (
  SELECT id, metric, field_path, provenance, methodology_version
  FROM arena.metric_source_contracts
  WHERE source_id = 1
    AND (
      (metric = 'roi' AND field_path = 'data.list[].roi')
      OR (metric = 'pnl' AND field_path = 'performance.pnl')
    )
)
INSERT INTO arena.metric_trust_observations (
  contract_id, trader_id, source_id, snapshot_id, snapshot_scraped_at,
  source_run_id, source_contract_version, timeframe, metric, field_path,
  provenance, methodology_version, value, value_unit, currency,
  source_as_of, valid_until, window_start, window_end, quality,
  history_state, price_state, cost_basis_state, population_state,
  window_state, unit_state, freshness_state, blocking_reasons
)
SELECT
  contracts.id,
  12,
  1,
  snapshot.id,
  snapshot.scraped_at,
  repeat('b', 64),
  '1',
  30,
  contracts.metric,
  contracts.field_path,
  contracts.provenance,
  contracts.methodology_version,
  CASE contracts.metric WHEN 'roi' THEN 9.5 ELSE 900 END,
  CASE contracts.metric WHEN 'roi' THEN 'percent' ELSE 'currency' END,
  'USDT',
  statement_timestamp() - interval '2 minutes',
  statement_timestamp() + interval '5 hours',
  statement_timestamp() - interval '30 days 2 minutes',
  statement_timestamp() - interval '2 minutes',
  'complete',
  'source_owned',
  'source_owned',
  'source_owned',
  'verified',
  'verified',
  'verified',
  'verified',
  '[]'::jsonb
FROM contracts
CROSS JOIN snapshot;

-- A pair-first regression case: the individually preferred source-reported
-- ROI/PnL are eight minutes apart and incompatible. Compatible normalized/mixed
-- candidates still form one honest pair; metric-first selection would lose it.
WITH snapshot AS (
  SELECT id, scraped_at
  FROM arena.leaderboard_snapshots
  WHERE id = 100
), contracts AS (
  SELECT id, metric, field_path, provenance, methodology_version
  FROM arena.metric_source_contracts
  WHERE source_id = 1
    AND metric_set_id = 'binance-board-roi-pnl@1'
    AND field_path IN (
      'data.list[].roi',
      'data.list[].pnl',
      'test.normalized.roi',
      'test.normalized.pnl'
    )
)
INSERT INTO arena.metric_trust_observations (
  contract_id, trader_id, source_id, snapshot_id, snapshot_scraped_at,
  source_run_id, source_contract_version, timeframe, metric, field_path,
  provenance, methodology_version, value, value_unit, currency,
  source_as_of, valid_until, window_start, window_end, quality,
  history_state, price_state, cost_basis_state, population_state,
  window_state, unit_state, freshness_state, blocking_reasons
)
SELECT
  contracts.id,
  13,
  1,
  snapshot.id,
  snapshot.scraped_at,
  repeat('b', 64),
  '1',
  30,
  contracts.metric,
  contracts.field_path,
  contracts.provenance,
  contracts.methodology_version,
  CASE contracts.metric WHEN 'roi' THEN 8.5 ELSE 800 END,
  CASE contracts.metric WHEN 'roi' THEN 'percent' ELSE 'currency' END,
  'USDT',
  CASE
    WHEN contracts.provenance = 'source_reported' AND contracts.metric = 'roi'
      THEN statement_timestamp() + interval '1 minute'
    WHEN contracts.provenance = 'source_reported' AND contracts.metric = 'pnl'
      THEN statement_timestamp() - interval '7 minutes'
    ELSE statement_timestamp() - interval '3 minutes'
  END,
  statement_timestamp() + interval '5 hours',
  statement_timestamp() - interval '30 days 2 minutes',
  statement_timestamp() - interval '2 minutes',
  'complete',
  'source_owned',
  'source_owned',
  'source_owned',
  'verified',
  'verified',
  'verified',
  'verified',
  '[]'::jsonb
FROM contracts
CROSS JOIN snapshot;

INSERT INTO arena.metric_trust_artifacts (
  observation_id, role, raw_object_id, content_hash
)
SELECT observation.id, evidence.role, raw.id, raw.content_hash
FROM arena.metric_trust_observations AS observation
CROSS JOIN (VALUES
  ('source_payload'::text, 'tier_a'::text),
  ('population_manifest'::text, 'tier_a_manifest'::text)
) AS evidence(role, job_type)
JOIN arena.raw_objects AS raw
  ON raw.job_type = evidence.job_type
WHERE observation.snapshot_id = 100;
SQL

IDENTITY="$(
  psql_cmd -Atqc "
    WITH bundle AS (
      SELECT public.arena_metric_rankable_score_inputs_shadow_json(
        '30D', 1000, 48
      ) AS payload
    )
    SELECT
      (SELECT count(*) FROM arena.metric_source_contracts
        WHERE field_path NOT LIKE 'test.%') || '|' ||
      (SELECT count(*) FROM arena.metric_rankable_observations) || '|' ||
      (SELECT count(*) FROM arena.metric_rankable_input_sets_shadow) || '|' ||
      (SELECT count(*) FROM arena.metric_rankable_input_sets_shadow
        WHERE trader_id = 12) || '|' ||
      (SELECT count(*) FROM arena.metric_rankable_input_sets_shadow
        WHERE trader_id = 13) || '|' ||
      (SELECT bool_and(rank_eligible) FROM arena.metric_rankable_input_sets_shadow) || '|' ||
      (SELECT count(*) FROM arena.metric_rankable_score_inputs_shadow) || '|' ||
      pg_catalog.jsonb_array_length(bundle.payload->'scoreRows') || '|' ||
      pg_catalog.jsonb_array_length(bundle.payload->'cohorts') || '|' ||
      (SELECT cohort->>'evidence_state'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '1') || '|' ||
      (SELECT cohort->>'publication_action'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '1') || '|' ||
      (SELECT cohort->>'rows_authoritative'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '1') || '|' ||
      (SELECT cohort->>'evidence_state'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '2') || '|' ||
      (SELECT cohort->>'publication_action'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '2') || '|' ||
      (SELECT bool_and(
         win_rate IS NULL
         AND max_drawdown IS NULL
         AND sharpe_ratio IS NULL
         AND valid_until > pg_catalog.now()
         AND board_as_of IS NOT NULL
       ) FROM arena.metric_rankable_score_inputs_shadow) || '|' ||
      (bundle.payload->>'authorityScope') || '|' ||
      (bundle.payload->>'rankingMethodId') || '|' ||
      (bundle.payload->>'comparisonCurrency') || '|' ||
      (bundle.payload->>'enforcementMode') || '|' ||
      (SELECT cohort->>'returned_count'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '1') || '|' ||
      (SELECT cohort->>'rank_depth'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '1') || '|' ||
      (SELECT cohort->>'compatible_entry_count'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '1')
    FROM bundle;
  "
)"
if [[ "$IDENTITY" != "7|8|2|0|1|true|2|2|2|rankable|publish|true|ranking_contract_currency_mismatch|hold|true|persisted_leaderboard_snapshot_attempts|arena-core-roi-pnl-30d-usdt@1|USDT|shadow|2|1000|4" ]]; then
  echo "metric trust eligible identity drifted: $IDENTITY" >&2
  exit 1
fi

# The row projection and registry-complete envelope must share one timeframe
# universe. Removing a capability can never leave orphan scoreRows behind.
psql_cmd -q -c "UPDATE arena.sources SET timeframes_native = '{}' WHERE id = 1;"

REGISTRY_DRIFT="$(
  psql_cmd -Atqc "
    WITH bundle AS (
      SELECT public.arena_metric_rankable_score_inputs_shadow_json(
        '30D', 1000, 48
      ) AS payload
    )
    SELECT
      (SELECT count(*) FROM arena.metric_rankable_score_inputs_shadow) || '|' ||
      pg_catalog.jsonb_array_length(bundle.payload->'scoreRows') || '|' ||
      pg_catalog.jsonb_array_length(bundle.payload->'cohorts') || '|' ||
      (SELECT count(*)
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '1')
    FROM bundle;
  "
)"
if [[ "$REGISTRY_DRIFT" != "0|0|1|0" ]]; then
  echo "timeframe registry drift left orphan score rows: $REGISTRY_DRIFT" >&2
  exit 1
fi
psql_cmd -q -c "UPDATE arena.sources SET timeframes_native = '{30}' WHERE id = 1;"

# Total row count alone is insufficient: one cross-currency row must make both
# the projection and cohort fail closed even though actual_count still equals 4.
psql_cmd -q -c "UPDATE arena.leaderboard_entries SET currency = 'USD' WHERE snapshot_id = 100 AND trader_id = 13;"

INCOMPATIBLE_ENTRY="$(
  psql_cmd -Atqc "
    WITH bundle AS (
      SELECT public.arena_metric_rankable_score_inputs_shadow_json(
        '30D', 1000, 48
      ) AS payload
    )
    SELECT
      (SELECT count(*) FROM arena.metric_rankable_score_inputs_shadow) || '|' ||
      pg_catalog.jsonb_array_length(bundle.payload->'scoreRows') || '|' ||
      (SELECT cohort->>'evidence_state'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '1') || '|' ||
      (SELECT cohort->>'compatible_entry_count'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '1') || '|' ||
      (SELECT cohort->>'publication_action'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '1')
    FROM bundle;
  "
)"
if [[ "$INCOMPATIBLE_ENTRY" != "0|0|population_count_mismatch|3|withdraw" ]]; then
  echo "incompatible physical entry did not fail closed: $INCOMPATIBLE_ENTRY" >&2
  exit 1
fi
psql_cmd -q -c "UPDATE arena.leaderboard_entries SET currency = 'USDT' WHERE snapshot_id = 100 AND trader_id = 13;"

# A newer PASSED board with its complete physical entries but no exact trust
# run suppresses the older pair and remains a non-destructive hold state.
psql_cmd -q <<'SQL'
INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, scraped_at, actual_count,
  count_check_passed, is_derived, raw_object_id
) VALUES (
  101, 1, 30, statement_timestamp(), 4,
  true, false, NULL
);

INSERT INTO arena.leaderboard_entries (
  scraped_at, snapshot_id, trader_id, timeframe, rank, currency
)
SELECT
  snapshot.scraped_at,
  snapshot.id,
  trader.id,
  snapshot.timeframe,
  (pg_catalog.row_number() OVER (ORDER BY trader.id))::int,
  'USDT'
FROM arena.leaderboard_snapshots AS snapshot
CROSS JOIN arena.traders AS trader
WHERE snapshot.id = 101;
SQL

CURRENT_ONLY="$(
  psql_cmd -Atqc "
    WITH bundle AS (
      SELECT public.arena_metric_rankable_score_inputs_shadow_json(
        '30D', 1000, 48
      ) AS payload
    )
    SELECT
      (SELECT count(*) FROM arena.metric_rankable_input_sets_shadow) || '|' ||
      (SELECT count(*) FROM arena.metric_rankable_score_inputs_shadow) || '|' ||
      pg_catalog.jsonb_array_length(bundle.payload->'scoreRows') || '|' ||
      (SELECT cohort->>'evidence_state'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '1') || '|' ||
      (SELECT cohort->>'withdrawal_allowed'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '1') || '|' ||
      (SELECT cohort->>'publication_action'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '1')
    FROM bundle;
  "
)"
if [[ "$CURRENT_ONLY" != "2|0|0|trust_run_missing|false|hold" ]]; then
  echo "current PASSED population did not suppress old score pairs: $CURRENT_ONLY" >&2
  exit 1
fi
psql_cmd -q -c "DELETE FROM arena.leaderboard_entries WHERE snapshot_id = 101;"
psql_cmd -q -c "DELETE FROM arena.leaderboard_snapshots WHERE id = 101;"

# A newer failed/partial persisted board is current. It cannot fall back to the
# older PASSED pair and explicitly authorizes withdrawal of the old cohort.
psql_cmd -q <<'SQL'
INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, scraped_at, actual_count,
  count_check_passed, is_derived, raw_object_id
) VALUES (
  102, 1, 30, statement_timestamp(), 0,
  false, false, NULL
);
SQL

FAILED_CURRENT="$(
  psql_cmd -Atqc "
    WITH bundle AS (
      SELECT public.arena_metric_rankable_score_inputs_shadow_json(
        '30D', 1000, 48
      ) AS payload
    )
    SELECT
      (SELECT count(*) FROM arena.metric_rankable_score_inputs_shadow) || '|' ||
      pg_catalog.jsonb_array_length(bundle.payload->'scoreRows') || '|' ||
      (SELECT cohort->>'evidence_state'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '1') || '|' ||
      (SELECT cohort->>'withdrawal_allowed'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '1') || '|' ||
      (SELECT cohort->>'publication_action'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '1')
    FROM bundle;
  "
)"
if [[ "$FAILED_CURRENT" != "0|0|snapshot_partial|true|withdraw" ]]; then
  echo "failed current board did not suppress/withdraw old score pairs: $FAILED_CURRENT" >&2
  exit 1
fi
psql_cmd -q -c "DELETE FROM arena.leaderboard_snapshots WHERE id = 102;"

# A future-dated newest board suppresses old rows but cannot authorize a
# destructive replacement because its clock evidence is not current.
psql_cmd -q <<'SQL'
INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, scraped_at, actual_count,
  count_check_passed, is_derived, raw_object_id
) VALUES (
  103, 1, 30, statement_timestamp() + interval '10 minutes', 0,
  true, false, NULL
);
SQL

FUTURE_CURRENT="$(
  psql_cmd -Atqc "
    WITH bundle AS (
      SELECT public.arena_metric_rankable_score_inputs_shadow_json(
        '30D', 1000, 48
      ) AS payload
    )
    SELECT
      (SELECT count(*) FROM arena.metric_rankable_score_inputs_shadow) || '|' ||
      pg_catalog.jsonb_array_length(bundle.payload->'scoreRows') || '|' ||
      (SELECT cohort->>'evidence_state'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '1') || '|' ||
      (SELECT cohort->>'withdrawal_allowed'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '1') || '|' ||
      (SELECT cohort->>'publication_action'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '1')
    FROM bundle;
  "
)"
if [[ "$FUTURE_CURRENT" != "0|0|snapshot_future|false|hold" ]]; then
  echo "future current board did not fail closed: $FUTURE_CURRENT" >&2
  exit 1
fi
psql_cmd -q -c "DELETE FROM arena.leaderboard_snapshots WHERE id = 103;"

# Simulate privileged storage drift to prove a future acquisition completion
# cannot enter the projection even if all lower-level observations remain live.
psql_cmd -q <<'SQL'
ALTER TABLE arena.metric_trust_runs
  DISABLE TRIGGER metric_trust_runs_reject_direct_mutation;
UPDATE arena.metric_trust_runs
SET completed_at = statement_timestamp() + interval '10 minutes';
ALTER TABLE arena.metric_trust_runs
  ENABLE TRIGGER metric_trust_runs_reject_direct_mutation;
SQL

FUTURE_RUN="$(
  psql_cmd -Atqc "
    WITH bundle AS (
      SELECT public.arena_metric_rankable_score_inputs_shadow_json(
        '30D', 1000, 48
      ) AS payload
    )
    SELECT
      (SELECT count(*) FROM arena.metric_rankable_score_inputs_shadow) || '|' ||
      pg_catalog.jsonb_array_length(bundle.payload->'scoreRows') || '|' ||
      (SELECT cohort->>'evidence_state'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '1') || '|' ||
      (SELECT cohort->>'withdrawal_allowed'
         FROM pg_catalog.jsonb_array_elements(bundle.payload->'cohorts') AS cohort
        WHERE cohort->>'source_id' = '1')
    FROM bundle;
  "
)"
if [[ "$FUTURE_RUN" != "0|0|trust_run_future|false" ]]; then
  echo "future trust run did not fail closed: $FUTURE_RUN" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
ALTER TABLE arena.metric_trust_runs
  DISABLE TRIGGER metric_trust_runs_reject_direct_mutation;
UPDATE arena.metric_trust_runs
SET completed_at = statement_timestamp() - interval '1 minute';
ALTER TABLE arena.metric_trust_runs
  ENABLE TRIGGER metric_trust_runs_reject_direct_mutation;
SQL

expect_failure \
  "invalid score-input canary window" \
  "SELECT public.arena_metric_rankable_score_inputs_shadow_json('1Y', 1000, 48);"
expect_failure \
  "invalid score-input canary limit" \
  "SELECT public.arena_metric_rankable_score_inputs_shadow_json('30D', 0, 48);"
expect_failure \
  "invalid score-input canary max age" \
  "SELECT public.arena_metric_rankable_score_inputs_shadow_json('30D', 1000, 0);"

expect_failure \
  "forged artifact digest" \
  "INSERT INTO arena.metric_trust_artifacts
     (observation_id, role, raw_object_id, content_hash)
   SELECT observation.id, 'event_history', raw.id, repeat('f', 64)
   FROM arena.metric_trust_observations AS observation
   CROSS JOIN arena.raw_objects AS raw
   WHERE observation.metric = 'roi' AND raw.job_type = 'metric_event_history'
   LIMIT 1;"

expect_failure \
  "alternate board payload" \
  "INSERT INTO arena.metric_trust_artifacts
     (observation_id, role, raw_object_id, content_hash)
   SELECT observation.id, 'source_payload', raw.id, raw.content_hash
   FROM arena.metric_trust_observations AS observation
   CROSS JOIN arena.raw_objects AS raw
   WHERE observation.trader_id = 10
     AND observation.metric = 'roi'
     AND raw.job_type = 'tier_a_alt'
   LIMIT 1;"

expect_failure \
  "duplicate population manifest identity" \
  "INSERT INTO arena.raw_objects (
     source_id, job_type, timeframe, storage_path, bytes, content_hash,
     quarantined, meta, source_run_id, trust_artifact_role
   ) VALUES (
     1, 'tier_a_manifest', 30, 'binance/run-1/duplicate-manifest.json.gz', 10,
     repeat('b', 64), false, '{}', repeat('b', 64), 'population_manifest'
   );"

expect_failure \
  "duplicate Tier-A population identity" \
  "INSERT INTO arena.raw_objects (
     source_id, job_type, timeframe, storage_path, bytes, content_hash,
     quarantined, meta, source_run_id, trust_artifact_role
   ) VALUES (
     1, 'tier_a', 30, 'binance/run-1/duplicate-population.json.gz', 10,
     repeat('a', 64), false, '{}', repeat('b', 64), 'source_payload'
   );"

expect_failure \
  "mutating referenced RAW digest" \
  "UPDATE arena.raw_objects
      SET content_hash = repeat('f', 64)
    WHERE job_type = 'tier_a';"

expect_failure \
  "owner mutating partial observation" \
  "UPDATE arena.metric_trust_observations
      SET quality = 'complete', history_state = 'source_owned', blocking_reasons = '[]'
    WHERE trader_id = 11;"

expect_failure \
  "owner deleting trust artifact" \
  "DELETE FROM arena.metric_trust_artifacts
    WHERE observation_id = (
      SELECT id FROM arena.metric_trust_observations WHERE trader_id = 10 LIMIT 1
    );"

expect_failure \
  "owner mutating source contract" \
  "UPDATE arena.metric_source_contracts SET active = false WHERE id = 1;"

PRIVILEGES="$(
  psql_cmd -Atqc "
    SELECT
      has_table_privilege('service_role',
        'arena.metric_source_contracts', 'SELECT') || '|' ||
      has_table_privilege('service_role',
        'arena.metric_source_contracts', 'INSERT,UPDATE,DELETE') || '|' ||
      has_table_privilege('service_role',
        'arena.metric_trust_runs', 'SELECT,INSERT') || '|' ||
      has_table_privilege('service_role',
        'arena.metric_trust_runs', 'UPDATE,DELETE') || '|' ||
      has_table_privilege('service_role',
        'arena.metric_trust_observations', 'SELECT,INSERT') || '|' ||
      has_table_privilege('service_role',
        'arena.metric_trust_observations', 'UPDATE,DELETE') || '|' ||
      has_table_privilege('anon',
        'arena.metric_trust_observations', 'SELECT') || '|' ||
      has_table_privilege('service_role',
        'arena.metric_rankable_score_inputs_shadow', 'SELECT') || '|' ||
      has_table_privilege('anon',
        'arena.metric_rankable_score_inputs_shadow', 'SELECT') || '|' ||
      has_function_privilege('service_role',
        'public.arena_metric_rankable_score_inputs_shadow_json(text,integer,integer)',
        'EXECUTE') || '|' ||
      has_function_privilege('authenticated',
        'public.arena_metric_rankable_score_inputs_shadow_json(text,integer,integer)',
        'EXECUTE');
  "
)"
if [[ "$PRIVILEGES" != "true|false|true|false|true|false|false|true|false|true|false" ]]; then
  echo "metric trust privileges drifted: $PRIVILEGES" >&2
  exit 1
fi

# Exercise the actual role, not only has_table_privilege(). Supabase's
# service_role is BYPASSRLS but remains unable to mutate append-only rows.
SERVICE_READ="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT
      (SELECT count(*) FROM arena.metric_trust_runs) || '|' ||
      pg_catalog.jsonb_array_length(
        public.arena_metric_rankable_score_inputs_shadow_json('30D', 1000, 48)
        ->'scoreRows'
      );
    RESET ROLE;
  "
)"
if [[ "$SERVICE_READ" != "1|2" ]]; then
  echo "service_role could not read private trust runs: $SERVICE_READ" >&2
  exit 1
fi

expect_failure \
  "service role updating observation" \
  "SET ROLE service_role;
   UPDATE arena.metric_trust_observations SET quality = 'unknown' WHERE trader_id = 10;"

expect_failure \
  "anonymous trust read" \
  "SET ROLE anon; SELECT count(*) FROM arena.metric_trust_runs;"

expect_failure \
  "anonymous score-input canary execution" \
  "SET ROLE anon;
   SELECT public.arena_metric_rankable_score_inputs_shadow_json('30D', 1000, 48);"

# Exercise the real 030000 attempt ledger, 040000 v2/v3 compatibility layer,
# 042000 terminal serializer, and 050000 database authority in the same
# PostgreSQL 17 process as the metric trust views above. The helpers only
# construct deterministic test evidence;
# every attempt, terminal outcome, trust INSERT, and rankability decision still
# passes through the production tables, RPCs, triggers, and views.
psql_cmd -q <<'SQL'
CREATE TABLE public.metric_trust_v3_pairs (
  attempt_id uuid PRIMARY KEY,
  snapshot_id bigint NOT NULL UNIQUE,
  capture_started_at timestamptz NOT NULL,
  capture_completed_at timestamptz NOT NULL,
  source_run_id text NOT NULL UNIQUE,
  payload_id bigint NOT NULL UNIQUE,
  manifest_id bigint NOT NULL UNIQUE
);

CREATE FUNCTION public.prepare_metric_trust_v3_pair(
  p_attempt_id uuid,
  p_snapshot_id bigint,
  p_run_seed text,
  p_path_prefix text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_attempt arena.leaderboard_acquisition_attempts%ROWTYPE;
  v_completed_at timestamptz := pg_catalog.clock_timestamp();
  v_source_run_id text := pg_catalog.md5(p_run_seed)
    || pg_catalog.md5(p_run_seed || ':metric-trust-v3');
  v_payload_id bigint;
  v_manifest_id bigint;
  v_attempt_summary jsonb;
BEGIN
  SELECT *
    INTO STRICT v_attempt
    FROM arena.leaderboard_acquisition_attempts
   WHERE attempt_id = p_attempt_id;

  IF v_attempt.capture_contract IS DISTINCT FROM
     'arena.ingest.leaderboard-acquisition-manifest@3' THEN
    RAISE EXCEPTION 'test v3 pair requires a manifest@3 attempt';
  END IF;

  v_attempt_summary := pg_catalog.jsonb_build_object(
    'binding_contract', v_attempt.attempt_binding_contract,
    'attempt_id', v_attempt.attempt_id,
    'attempt_seq', v_attempt.attempt_seq,
    'runner_git_sha', v_attempt.runner_git_sha,
    'capture_started_at', v_attempt.recorded_started_at,
    'capture_completed_at', v_completed_at,
    'capture_evidence_state', 'verified',
    'termination_reason', 'reported_population_reached',
    'source_page_count', 1,
    'population_report_state', 'consistent',
    'reported_population', 1,
    'page_count_report_state', 'consistent',
    'reported_page_count', 1,
    'observed_population', 1,
    'accepted_population', 1,
    'rejected_row_count', 0,
    'deduplicated_row_count', 0,
    'caller_limited', false,
    'safety_limited', false,
    'acquisition_state', 'complete',
    'population_state', 'verified'
  );

  INSERT INTO arena.raw_objects (
    source_id, job_type, trader_id, timeframe, fetched_at, storage_path,
    bytes, content_hash, quarantined, meta, source_run_id, trust_artifact_role
  ) VALUES (
    v_attempt.source_id,
    'tier_a',
    NULL,
    v_attempt.timeframe,
    v_completed_at,
    p_path_prefix || '/payload.json.gz',
    100,
    pg_catalog.repeat('a', 64),
    false,
    pg_catalog.jsonb_build_object(
      'surface', 'tier_a_leaderboard',
      'source_run_id', v_source_run_id,
      'observation_cycle_id', v_attempt.observation_cycle_id,
      'acquisition_attempt', v_attempt_summary,
      'raw_integrity', pg_catalog.jsonb_build_object(
        'hash_algorithm', 'sha256',
        'hash_scope', 'json_utf8',
        'serialization_contract', 'arena.strict-canonical-json@1'
      )
    ),
    v_source_run_id,
    'source_payload'
  ) RETURNING id INTO STRICT v_payload_id;

  INSERT INTO arena.raw_objects (
    source_id, job_type, trader_id, timeframe, fetched_at, storage_path,
    bytes, content_hash, quarantined, meta, source_run_id, trust_artifact_role
  ) VALUES (
    v_attempt.source_id,
    'tier_a_manifest',
    NULL,
    v_attempt.timeframe,
    v_completed_at,
    p_path_prefix || '/manifest.json.gz',
    100,
    v_source_run_id,
    false,
    pg_catalog.jsonb_build_object(
      'surface', 'tier_a_leaderboard',
      'source_run_id', v_source_run_id,
      'observation_cycle_id', v_attempt.observation_cycle_id,
      'data_contract', v_attempt.capture_contract,
      'acquisition_attempt', v_attempt_summary,
      'raw_integrity', pg_catalog.jsonb_build_object(
        'hash_algorithm', 'sha256',
        'hash_scope', 'json_utf8',
        'serialization_contract', 'arena.strict-canonical-json@1'
      )
    ),
    v_source_run_id,
    'population_manifest'
  ) RETURNING id INTO STRICT v_manifest_id;

  INSERT INTO arena.leaderboard_snapshots (
    id, source_id, timeframe, scraped_at, actual_count,
    count_check_passed, is_derived, raw_object_id
  ) VALUES (
    p_snapshot_id,
    v_attempt.source_id,
    v_attempt.timeframe,
    v_completed_at,
    1,
    true,
    false,
    v_payload_id
  );

  INSERT INTO arena.leaderboard_entries (
    scraped_at, snapshot_id, trader_id, timeframe, rank, currency
  ) VALUES (
    v_completed_at, p_snapshot_id, 10, v_attempt.timeframe, 1, 'USDT'
  );

  INSERT INTO public.metric_trust_v3_pairs (
    attempt_id, snapshot_id, capture_started_at, capture_completed_at,
    source_run_id, payload_id, manifest_id
  ) VALUES (
    p_attempt_id, p_snapshot_id, v_attempt.recorded_started_at, v_completed_at,
    v_source_run_id, v_payload_id, v_manifest_id
  );
END
$function$;

CREATE FUNCTION public.finish_metric_trust_v3_success(p_attempt_id uuid)
RETURNS bigint
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT outcome.attempt_seq
    FROM public.metric_trust_v3_pairs AS pair
    CROSS JOIN LATERAL arena.finish_leaderboard_acquisition_attempt(
      pair.attempt_id,
      'complete', 'complete', 'verified', 'verified',
      'reported_population_reached',
      pair.capture_started_at, pair.capture_completed_at,
      pair.source_run_id, pair.payload_id, pair.manifest_id, NULL,
      1, 'consistent', 1, 1, 'consistent',
      1, 1, 0, 0, false, false, NULL, NULL
    ) AS outcome
   WHERE pair.attempt_id = p_attempt_id
$function$;

CREATE FUNCTION public.finish_metric_trust_v3_failure(p_attempt_id uuid)
RETURNS bigint
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT outcome.attempt_seq
    FROM arena.finish_leaderboard_acquisition_attempt(
      p_attempt_id,
      'processing_failed', 'unknown', 'unknown', 'unassessed',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      false, false, 'upstream_fetch', 'upstream_unavailable'
    ) AS outcome
$function$;

CREATE FUNCTION public.insert_metric_trust_v3_run(p_attempt_id uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_source_run_id text;
BEGIN
  INSERT INTO arena.metric_trust_runs (
    source_run_id, source_id, timeframe, snapshot_id, snapshot_scraped_at,
    population_raw_object_id, manifest_raw_object_id,
    started_at, completed_at, reported_population, fetched_population,
    caller_limited, acquisition_state, population_state
  )
  SELECT
    pair.source_run_id,
    snapshot.source_id,
    snapshot.timeframe,
    snapshot.id,
    snapshot.scraped_at,
    pair.payload_id,
    pair.manifest_id,
    pair.capture_started_at,
    pair.capture_completed_at,
    1,
    1,
    false,
    'complete',
    'verified'
  FROM public.metric_trust_v3_pairs AS pair
  JOIN arena.leaderboard_snapshots AS snapshot
    ON snapshot.id = pair.snapshot_id
  WHERE pair.attempt_id = p_attempt_id
  RETURNING source_run_id INTO STRICT v_source_run_id;

  RETURN v_source_run_id;
END
$function$;

CREATE FUNCTION public.add_metric_trust_v3_observations(p_attempt_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  WITH pair AS (
    SELECT *
      FROM public.metric_trust_v3_pairs
     WHERE attempt_id = p_attempt_id
  ), contracts AS (
    SELECT id, metric, field_path, provenance, methodology_version
      FROM arena.metric_source_contracts
     WHERE source_id = 1
       AND field_path IN ('data.list[].roi', 'data.list[].pnl')
  )
  INSERT INTO arena.metric_trust_observations (
    contract_id, trader_id, source_id, snapshot_id, snapshot_scraped_at,
    source_run_id, source_contract_version, timeframe, metric, field_path,
    provenance, methodology_version, value, value_unit, currency,
    source_as_of, valid_until, window_start, window_end, quality,
    history_state, price_state, cost_basis_state, population_state,
    window_state, unit_state, freshness_state, blocking_reasons
  )
  SELECT
    contracts.id,
    10,
    1,
    pair.snapshot_id,
    pair.capture_completed_at,
    pair.source_run_id,
    '1',
    30,
    contracts.metric,
    contracts.field_path,
    contracts.provenance,
    contracts.methodology_version,
    CASE contracts.metric WHEN 'roi' THEN 15.5 ELSE 1500 END,
    CASE contracts.metric WHEN 'roi' THEN 'percent' ELSE 'currency' END,
    'USDT',
    pair.capture_completed_at,
    pair.capture_completed_at + interval '5 hours',
    pair.capture_completed_at - interval '30 days',
    pair.capture_completed_at,
    'complete',
    'source_owned',
    'source_owned',
    'source_owned',
    'verified',
    'verified',
    'verified',
    'verified',
    '[]'::jsonb
  FROM pair
  CROSS JOIN contracts;

  INSERT INTO arena.metric_trust_artifacts (
    observation_id, role, raw_object_id, content_hash
  )
  SELECT
    observation.id,
    evidence.role,
    raw.id,
    raw.content_hash
  FROM public.metric_trust_v3_pairs AS pair
  JOIN arena.metric_trust_observations AS observation
    ON observation.source_run_id = pair.source_run_id
  CROSS JOIN (VALUES
    ('source_payload'::text, 'tier_a'::text),
    ('population_manifest'::text, 'tier_a_manifest'::text)
  ) AS evidence(role, job_type)
  JOIN arena.raw_objects AS raw
    ON raw.source_run_id = pair.source_run_id
   AND raw.job_type = evidence.job_type
  WHERE pair.attempt_id = p_attempt_id;
END
$function$;
SQL

# 050000 must preserve the explicit manifest@2 branch. This is the original
# direct metric-trust run and its original eight rankable observations; no
# acquisition-ledger terminal is required merely because v3 is registered.
V2_COMPAT="$(
  psql_cmd -Atqc "
    SELECT
      (SELECT count(*)
         FROM arena.metric_trust_runs AS run
         JOIN arena.raw_objects AS manifest
           ON manifest.id = run.manifest_raw_object_id
        WHERE manifest.meta->>'data_contract' =
              'arena.ingest.leaderboard-acquisition-manifest@2') || '|' ||
      (SELECT count(*)
         FROM arena.metric_rankable_observations
        WHERE source_run_id = repeat('b', 64));
  "
)"
if [[ "$V2_COMPAT" != "1|8" ]]; then
  echo "manifest v2 compatibility drifted: $V2_COMPAT" >&2
  exit 1
fi

# A syntactically and cryptographically coherent v3 RAW/snapshot bundle is not
# trusted merely because an owner can INSERT it. Without the exact terminal
# outcome, direct SQL publication must fail closed.
psql_cmd -q <<'SQL'
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000100', 1, 30,
  'metric-trust:fake:100', 'metric-trust-fake-100', 0,
  'arena.ingest.leaderboard-acquisition-manifest@3', repeat('1', 40), 'vps_sg'
);
SELECT public.prepare_metric_trust_v3_pair(
  '00000000-0000-0000-0000-000000000100', 200,
  'metric-trust-direct-fake', 'metric-trust-direct-fake'
);
SQL

expect_failure \
  "direct v3 metric-trust forgery" \
  "SELECT public.insert_metric_trust_v3_run(
     '00000000-0000-0000-0000-000000000100'
   );" \
  "v3 metric-trust run is not authorized by the exact latest terminal outcome" \
  "23514"

# Finish-first ordering: an older complete terminal exists, but a newer failure
# takes the shared source/timeframe fence before the old trust INSERT. The trust
# statement must visibly wait on that exact advisory lock and, after COMMIT,
# take a fresh READ COMMITTED snapshot that rejects the now-stale old success.
psql_cmd -q <<'SQL'
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000110', 1, 30,
  'metric-trust:old:110', 'metric-trust-old-110', 0,
  'arena.ingest.leaderboard-acquisition-manifest@3', repeat('1', 40), 'vps_sg'
);
SELECT public.prepare_metric_trust_v3_pair(
  '00000000-0000-0000-0000-000000000110', 201,
  'metric-trust-old-success', 'metric-trust-old-success'
);
SELECT public.finish_metric_trust_v3_success(
  '00000000-0000-0000-0000-000000000110'
);
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000111', 1, 30,
  'metric-trust:failure:111', 'metric-trust-failure-111', 0,
  'arena.ingest.leaderboard-acquisition-manifest@3', repeat('1', 40), 'vps_sg'
);
SQL

FINISH_FIRST_LOG="$TMP_ROOT/finish-first.log"
FINISH_FIRST_TRUST_LOG="$TMP_ROOT/finish-first-trust.log"
PGAPPNAME=metric-trust-finish-first psql_cmd -q -c \
  "BEGIN ISOLATION LEVEL READ COMMITTED;
   SELECT public.finish_metric_trust_v3_failure(
     '00000000-0000-0000-0000-000000000111'
   );
   SELECT pg_catalog.pg_sleep(5);
   COMMIT;" \
  >"$FINISH_FIRST_LOG" 2>&1 &
finish_first_pid=$!

finish_sleep_seen=false
for _ in {1..80}; do
  if [[ "$(psql_cmd -Atqc "
    SELECT count(*)
      FROM pg_catalog.pg_stat_activity
     WHERE application_name = 'metric-trust-finish-first'
       AND wait_event = 'PgSleep';
  ")" -eq 1 ]]; then
    finish_sleep_seen=true
    break
  fi
  sleep 0.05
done
if [[ "$finish_sleep_seen" != true ]]; then
  echo "finish-first terminal never reached its held-lock sleep" >&2
  wait "$finish_first_pid" || cat "$FINISH_FIRST_LOG" >&2
  exit 1
fi

PGAPPNAME=metric-trust-finish-first-waiter psql_cmd -q -v VERBOSITY=verbose -c \
  "BEGIN ISOLATION LEVEL READ COMMITTED;
   SELECT public.insert_metric_trust_v3_run(
     '00000000-0000-0000-0000-000000000110'
   );
   COMMIT;" \
  >"$FINISH_FIRST_TRUST_LOG" 2>&1 &
finish_first_trust_pid=$!

shared_lock_seen=false
for _ in {1..80}; do
  if [[ "$(psql_cmd -Atqc "
    SELECT count(*)
      FROM pg_catalog.pg_locks AS waiter
      JOIN pg_catalog.pg_stat_activity AS waiter_activity
        ON waiter_activity.pid = waiter.pid
      JOIN pg_catalog.pg_locks AS holder
        ON holder.locktype = waiter.locktype
       AND holder.database IS NOT DISTINCT FROM waiter.database
       AND holder.classid IS NOT DISTINCT FROM waiter.classid
       AND holder.objid IS NOT DISTINCT FROM waiter.objid
       AND holder.objsubid IS NOT DISTINCT FROM waiter.objsubid
       AND holder.pid <> waiter.pid
      JOIN pg_catalog.pg_stat_activity AS holder_activity
        ON holder_activity.pid = holder.pid
     WHERE waiter.locktype = 'advisory'
       AND NOT waiter.granted
       AND holder.granted
       AND waiter_activity.application_name =
           'metric-trust-finish-first-waiter'
       AND holder_activity.application_name = 'metric-trust-finish-first';
  ")" -gt 0 ]]; then
    shared_lock_seen=true
    break
  fi
  sleep 0.05
done
if [[ "$shared_lock_seen" != true ]]; then
  echo "finish and trust did not contend on the same source/timeframe advisory lock" >&2
  wait "$finish_first_pid" || cat "$FINISH_FIRST_LOG" >&2
  wait "$finish_first_trust_pid" || true
  cat "$FINISH_FIRST_TRUST_LOG" >&2
  exit 1
fi

if ! wait "$finish_first_pid"; then
  echo "finish-first terminal transaction failed" >&2
  cat "$FINISH_FIRST_LOG" >&2
  wait "$finish_first_trust_pid" || true
  exit 1
fi
set +e
wait "$finish_first_trust_pid"
finish_first_trust_status=$?
set -e
if [[ "$finish_first_trust_status" -eq 0 ]]; then
  echo "stale v3 trust unexpectedly survived the newer terminal" >&2
  exit 1
fi
if [[ "$(<"$FINISH_FIRST_TRUST_LOG")" != *"23514"* ]] \
   || [[ "$(<"$FINISH_FIRST_TRUST_LOG")" != *"v3 metric-trust run is not authorized by the exact latest terminal outcome"* ]]; then
  echo "finish-first trust rejection drifted" >&2
  cat "$FINISH_FIRST_TRUST_LOG" >&2
  exit 1
fi

FINISH_FIRST_RESULT="$(
  psql_cmd -Atqc "
    SELECT
      (SELECT attempt_id
         FROM arena.latest_terminal_leaderboard_acquisitions
        WHERE source_id = 1 AND timeframe = 30) || '|' ||
      (SELECT count(*)
         FROM arena.metric_trust_runs AS run
         JOIN public.metric_trust_v3_pairs AS pair
           ON pair.source_run_id = run.source_run_id
        WHERE pair.attempt_id =
              '00000000-0000-0000-0000-000000000110'::uuid);
  "
)"
if [[ "$FINISH_FIRST_RESULT" != "00000000-0000-0000-0000-000000000111|0" ]]; then
  echo "finish-first latest terminal was not visible: $FINISH_FIRST_RESULT" >&2
  exit 1
fi

# Trust-first ordering: publish one exact v3 success, attach complete metric
# evidence, and prove it is rankable. A current-source region drift hides it;
# restoring the frozen worker/source region restores it. Merely starting a newer
# attempt does not withdraw it, but the newer failure terminal does immediately.
psql_cmd -q <<'SQL'
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000120', 1, 30,
  'metric-trust:success:120', 'metric-trust-success-120', 0,
  'arena.ingest.leaderboard-acquisition-manifest@3', repeat('1', 40), 'vps_sg'
);
SELECT public.prepare_metric_trust_v3_pair(
  '00000000-0000-0000-0000-000000000120', 202,
  'metric-trust-live-success', 'metric-trust-live-success'
);
SELECT public.finish_metric_trust_v3_success(
  '00000000-0000-0000-0000-000000000120'
);
SQL

psql_cmd -q -c "UPDATE arena.sources SET fetch_region = 'vps_jp' WHERE id = 1;"
expect_failure \
  "v3 trust with stale source-region snapshot" \
  "SELECT public.insert_metric_trust_v3_run(
     '00000000-0000-0000-0000-000000000120'
   );" \
  "v3 metric-trust run is not authorized by the exact latest terminal outcome" \
  "23514"
psql_cmd -q -c "UPDATE arena.sources SET fetch_region = 'vps_sg' WHERE id = 1;"

psql_cmd -q <<'SQL'
SELECT public.insert_metric_trust_v3_run(
  '00000000-0000-0000-0000-000000000120'
);
SELECT public.add_metric_trust_v3_observations(
  '00000000-0000-0000-0000-000000000120'
);
SQL

TRUST_FIRST_LIVE="$(
  psql_cmd -Atqc "
    SELECT
      (SELECT count(*)
         FROM arena.metric_rankable_observations AS observation
         JOIN public.metric_trust_v3_pairs AS pair
           ON pair.source_run_id = observation.source_run_id
        WHERE pair.attempt_id =
              '00000000-0000-0000-0000-000000000120'::uuid) || '|' ||
      terminal.worker_region || '|' ||
      terminal.source_fetch_region || '|' ||
      source.fetch_region || '|' ||
      terminal.source_status || '|' ||
      source.status || '|' ||
      terminal.source_serving_mode || '|' ||
      source.serving_mode || '|' ||
      terminal.source_currency || '|' ||
      source.currency
    FROM arena.latest_terminal_leaderboard_acquisitions AS terminal
    JOIN arena.sources AS source ON source.id = terminal.source_id
    WHERE terminal.attempt_id =
          '00000000-0000-0000-0000-000000000120'::uuid;
  "
)"
if [[ "$TRUST_FIRST_LIVE" != "2|vps_sg|vps_sg|vps_sg|active|active|serving|serving|USDT|USDT" ]]; then
  echo "trust-first v3 success or worker/source snapshot drifted: $TRUST_FIRST_LIVE" >&2
  exit 1
fi

psql_cmd -q -c "UPDATE arena.sources SET fetch_region = 'vps_jp' WHERE id = 1;"
REGION_DRIFT="$(
  psql_cmd -Atqc "
    SELECT
      (SELECT count(*)
         FROM arena.metric_rankable_observations AS observation
         JOIN public.metric_trust_v3_pairs AS pair
           ON pair.source_run_id = observation.source_run_id
        WHERE pair.attempt_id =
              '00000000-0000-0000-0000-000000000120'::uuid) || '|' ||
      (SELECT count(*)
         FROM arena.metric_rankable_observations
        WHERE source_run_id = repeat('b', 64));
  "
)"
if [[ "$REGION_DRIFT" != "0|8" ]]; then
  echo "source-region drift did not hide only v3: $REGION_DRIFT" >&2
  exit 1
fi
psql_cmd -q -c "UPDATE arena.sources SET fetch_region = 'vps_sg' WHERE id = 1;"

psql_cmd -q <<'SQL'
DO $test$
BEGIN
  IF (
    SELECT count(*)
      FROM arena.metric_rankable_observations AS observation
      JOIN public.metric_trust_v3_pairs AS pair
        ON pair.source_run_id = observation.source_run_id
     WHERE pair.attempt_id =
           '00000000-0000-0000-0000-000000000120'::uuid
  ) <> 2 THEN
    RAISE EXCEPTION 'restoring current source region did not restore exact v3 evidence';
  END IF;
END
$test$;

SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000121', 1, 30,
  'metric-trust:failure:121', 'metric-trust-failure-121', 0,
  'arena.ingest.leaderboard-acquisition-manifest@3', repeat('1', 40), 'vps_sg'
);

DO $test$
BEGIN
  IF (
    SELECT count(*)
      FROM arena.metric_rankable_observations AS observation
      JOIN public.metric_trust_v3_pairs AS pair
        ON pair.source_run_id = observation.source_run_id
     WHERE pair.attempt_id =
           '00000000-0000-0000-0000-000000000120'::uuid
  ) <> 2 THEN
    RAISE EXCEPTION 'a newer in-progress attempt withdrew the prior terminal success';
  END IF;
END
$test$;

SELECT public.finish_metric_trust_v3_failure(
  '00000000-0000-0000-0000-000000000121'
);
SQL

TRUST_FIRST_HIDDEN="$(
  psql_cmd -Atqc "
    SELECT
      (SELECT count(*)
         FROM arena.metric_rankable_observations AS observation
         JOIN public.metric_trust_v3_pairs AS pair
           ON pair.source_run_id = observation.source_run_id
        WHERE pair.attempt_id =
              '00000000-0000-0000-0000-000000000120'::uuid) || '|' ||
      (SELECT count(*)
         FROM arena.metric_rankable_observations
        WHERE source_run_id = repeat('b', 64)) || '|' ||
      (SELECT attempt_id
         FROM arena.latest_terminal_leaderboard_acquisitions
        WHERE source_id = 1 AND timeframe = 30);
  "
)"
if [[ "$TRUST_FIRST_HIDDEN" != "0|8|00000000-0000-0000-0000-000000000121" ]]; then
  echo "new failure terminal did not dynamically hide only v3: $TRUST_FIRST_HIDDEN" >&2
  exit 1
fi

# Even a fully valid, latest v3 terminal cannot be published from a transaction-
# wide snapshot. The explicit 25001 rejection is the fail-closed contract that
# keeps the post-lock latest-terminal read meaningful.
psql_cmd -q <<'SQL'
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000130', 1, 30,
  'metric-trust:repeatable:130', 'metric-trust-repeatable-130', 0,
  'arena.ingest.leaderboard-acquisition-manifest@3', repeat('1', 40), 'vps_sg'
);
SELECT public.prepare_metric_trust_v3_pair(
  '00000000-0000-0000-0000-000000000130', 203,
  'metric-trust-repeatable-read', 'metric-trust-repeatable-read'
);
SELECT public.finish_metric_trust_v3_success(
  '00000000-0000-0000-0000-000000000130'
);
SQL

expect_failure \
  "repeatable-read v3 metric-trust publication" \
  "BEGIN ISOLATION LEVEL REPEATABLE READ;
   SELECT public.insert_metric_trust_v3_run(
     '00000000-0000-0000-0000-000000000130'
   );
   COMMIT;" \
  "attempt-bound metric-trust publication requires READ COMMITTED isolation" \
  "25001"

RR_RUNS="$(
  psql_cmd -Atqc "
    SELECT count(*)
      FROM arena.metric_trust_runs AS run
      JOIN public.metric_trust_v3_pairs AS pair
        ON pair.source_run_id = run.source_run_id
     WHERE pair.attempt_id =
           '00000000-0000-0000-0000-000000000130'::uuid;
  "
)"
if [[ "$RR_RUNS" != "0" ]]; then
  echo "repeatable-read rejection left a v3 trust row: $RR_RUNS" >&2
  exit 1
fi

# RAW cleanup remains possible. ON DELETE CASCADE removes the evidence link,
# and the shadow input fails closed immediately instead of blocking cleanup.
psql_cmd -q -c "DELETE FROM arena.raw_objects WHERE job_type = 'tier_a';"

AFTER_DELETE="$(
  psql_cmd -Atqc "
    SELECT
      (SELECT count(*) FROM arena.metric_trust_artifacts) || '|' ||
      (SELECT count(*) FROM arena.metric_rankable_input_sets_shadow);
  "
)"
if [[ "$AFTER_DELETE" != "0|0" ]]; then
  echo "RAW deletion did not fail the shadow gate closed: $AFTER_DELETE" >&2
  exit 1
fi

echo "metric trust shadow gate PostgreSQL 17 proof passed"
