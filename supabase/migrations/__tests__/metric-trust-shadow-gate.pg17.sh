#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260721120000_metric_trust_shadow_gate.sql"
IDENTITY_MIGRATION="$ROOT_DIR/supabase/migrations/20260721150000_metric_trust_raw_artifact_identity.sql"
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
  if psql_cmd -q -c "$sql" >"$ERROR_FILE" 2>&1; then
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
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA arena;

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL,
  currency text NOT NULL
);

CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id)
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

INSERT INTO arena.sources (id, slug, status, serving_mode, currency) VALUES
  (1, 'binance_futures', 'active', 'serving', 'USDT'),
  (2, 'binance_web3_bsc', 'active', 'serving', 'USDT');

GRANT USAGE ON SCHEMA arena TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA arena TO service_role;
SQL

psql_cmd -q -f "$MIGRATION"
psql_cmd -q -f "$IDENTITY_MIGRATION"

psql_cmd -q <<'SQL'
INSERT INTO arena.traders (id, source_id) VALUES (10, 1), (11, 1), (12, 1), (13, 1);

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
    '{"raw_integrity":{"hash_algorithm":"sha256","hash_scope":"json_utf8"}}',
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

INSERT INTO arena.leaderboard_entries (scraped_at, snapshot_id, trader_id, timeframe)
SELECT snapshot.scraped_at, snapshot.id, trader.id, snapshot.timeframe
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
    SELECT
      (SELECT count(*) FROM arena.metric_source_contracts
        WHERE field_path NOT LIKE 'test.%') || '|' ||
      (SELECT count(*) FROM arena.metric_rankable_observations) || '|' ||
      (SELECT count(*) FROM arena.metric_rankable_input_sets_shadow) || '|' ||
      (SELECT count(*) FROM arena.metric_rankable_input_sets_shadow
        WHERE trader_id = 12) || '|' ||
      (SELECT count(*) FROM arena.metric_rankable_input_sets_shadow
        WHERE trader_id = 13) || '|' ||
      (SELECT bool_and(rank_eligible) FROM arena.metric_rankable_input_sets_shadow);
  "
)"
if [[ "$IDENTITY" != "7|8|2|0|1|true" ]]; then
  echo "metric trust eligible identity drifted: $IDENTITY" >&2
  exit 1
fi

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
        'arena.metric_trust_observations', 'SELECT');
  "
)"
if [[ "$PRIVILEGES" != "true|false|true|false|true|false|false" ]]; then
  echo "metric trust privileges drifted: $PRIVILEGES" >&2
  exit 1
fi

# Exercise the actual role, not only has_table_privilege(). Supabase's
# service_role is BYPASSRLS but remains unable to mutate append-only rows.
SERVICE_READ="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT count(*) FROM arena.metric_trust_runs;
    RESET ROLE;
  "
)"
if [[ "$SERVICE_READ" != "1" ]]; then
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
