#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260722053000_binance_spot_metric_source_contract.sql"
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

TMP_ROOT="$(mktemp -d /tmp/binance-spot-contract-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((57500 + ($$ % 7500)))}"
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

assert_no_contracts() {
  local label="$1"
  if [[ "$(psql_cmd -Atqc 'SELECT pg_catalog.count(*) FROM arena.metric_source_contracts;')" != "0" ]]; then
    echo "failed $label migration left partial contracts" >&2
    exit 1
  fi
}

bootstrap_contract_registry() {
  local page_size="$1"
  local serving_mode="$2"
  psql_cmd -q -v page_size="$page_size" -v serving_mode="$serving_mode" <<'SQL'
DROP SCHEMA IF EXISTS arena CASCADE;
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
  copier_table_depth text NOT NULL
    CHECK (copier_table_depth IN ('full', 'top10', 'top3_preview', 'none')),
  currency text NOT NULL CHECK (currency IN ('USDT', 'USDx', 'USDC', 'USD')),
  page_size integer,
  pagination_kind text CHECK (
    pagination_kind IS NULL
    OR pagination_kind IN ('numeric', 'next_prev', 'infinite_scroll', 'api_cursor')
  ),
  fetch_region text NOT NULL CHECK (fetch_region IN ('local', 'vps_sg', 'vps_jp')),
  serving_mode text NOT NULL CHECK (serving_mode IN ('legacy', 'shadow', 'serving')),
  status text NOT NULL CHECK (
    status IN ('active', 'inactive', 'blocked_pending_vps', 'dropped')
  ),
  meta jsonb NOT NULL
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
    AND pg_catalog.array_position(currencies, NULL) IS NULL
  ),
  required_raw_roles text[] NOT NULL CHECK (
    pg_catalog.cardinality(required_raw_roles) > 0
    AND required_raw_roles <@ ARRAY[
      'source_payload',
      'population_manifest',
      'normalization_components',
      'event_history',
      'price_history',
      'opening_inventory'
    ]::text[]
    AND pg_catalog.array_position(required_raw_roles, NULL) IS NULL
  ),
  source_payload_scope text NOT NULL CHECK (
    source_payload_scope IN ('population_snapshot', 'metric_payload', 'not_required')
  ),
  max_freshness interval NOT NULL CHECK (max_freshness > interval '0 seconds'),
  max_window_end_lag interval NOT NULL CHECK (max_window_end_lag >= interval '0 seconds'),
  allow_derived_population boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (
    source_id,
    contract_version,
    metric,
    field_path,
    provenance,
    methodology_version
  ),
  CHECK (
    (source_payload_scope = 'not_required')
    = NOT ('source_payload' = ANY (required_raw_roles))
  )
);

CREATE FUNCTION arena.reject_direct_metric_trust_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'TRUNCATE' OR pg_catalog.pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'metric trust records are append-only; insert a new run instead';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER metric_source_contracts_reject_direct_mutation
BEFORE UPDATE OR DELETE ON arena.metric_source_contracts
FOR EACH ROW EXECUTE FUNCTION arena.reject_direct_metric_trust_mutation();
CREATE TRIGGER metric_source_contracts_reject_truncate
BEFORE TRUNCATE ON arena.metric_source_contracts
FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_direct_metric_trust_mutation();

ALTER TABLE arena.metric_source_contracts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON arena.metric_source_contracts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON arena.metric_source_contracts TO service_role;

INSERT INTO arena.exchanges (id, slug) VALUES (1, 'binance');

INSERT INTO arena.sources (
  id,
  slug,
  exchange_id,
  product_type,
  trader_kind_scope,
  adapter_slug,
  timeframes_native,
  timeframes_derived,
  copier_table_depth,
  currency,
  page_size,
  pagination_kind,
  fetch_region,
  serving_mode,
  status,
  meta
) VALUES (
  1,
  'binance_spot',
  1,
  'spot',
  'human',
  'binance',
  ARRAY[7, 30, 90],
  ARRAY[]::integer[],
  'full',
  'USDT',
  :page_size,
  'numeric',
  'vps_sg',
  :'serving_mode',
  'inactive',
  '{"boardKey":"spot","click_all_portfolios":true,"position_history_dual_sort":true}'
);
SQL
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
CREATE ROLE leaked_registry_role NOLOGIN;
SQL

bootstrap_contract_registry 20 legacy
psql_cmd -q -f "$MIGRATION"

RESULT="$(
  psql_cmd -Atqc "
    SELECT
      pg_catalog.count(*) || '|' ||
      pg_catalog.count(*) FILTER (
        WHERE metric = 'roi' AND field_path = 'data.list[].roi'
      ) || '|' ||
      pg_catalog.count(*) FILTER (
        WHERE metric = 'pnl' AND field_path = 'data.list[].pnl'
      ) || '|' ||
      pg_catalog.count(*) FILTER (
        WHERE source_payload_scope <> 'population_snapshot'
           OR provenance <> 'source_reported'
           OR allow_derived_population
      )
    FROM arena.metric_source_contracts;
  "
)"
if [[ "$RESULT" != "2|1|1|0" ]]; then
  echo "Binance Spot contracts did not match the reviewed fields: $RESULT" >&2
  exit 1
fi

EXACT_RESULT="$(
  psql_cmd -Atqc "
    WITH expected(
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
      max_window_end_lag,
      allow_derived_population,
      active
    ) AS (
      VALUES
        (
          '1'::text,
          'roi'::text,
          'data.list[].roi'::text,
          'source_reported'::text,
          'binance-board-roi@1'::text,
          'binance-board-roi-pnl@1'::text,
          ARRAY[7, 30, 90]::smallint[],
          'percent'::text,
          ARRAY['USDT']::text[],
          ARRAY['source_payload', 'population_manifest']::text[],
          'population_snapshot'::text,
          interval '6 hours',
          interval '5 minutes',
          false,
          true
        ),
        (
          '1'::text,
          'pnl'::text,
          'data.list[].pnl'::text,
          'source_reported'::text,
          'binance-board-pnl@1'::text,
          'binance-board-roi-pnl@1'::text,
          ARRAY[7, 30, 90]::smallint[],
          'currency'::text,
          ARRAY['USDT']::text[],
          ARRAY['source_payload', 'population_manifest']::text[],
          'population_snapshot'::text,
          interval '6 hours',
          interval '5 minutes',
          false,
          true
        )
    ), actual AS (
      SELECT
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
        max_window_end_lag,
        allow_derived_population,
        active
      FROM arena.metric_source_contracts
    ), drift AS (
      (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)
      UNION ALL
      (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
    )
    SELECT
      (SELECT pg_catalog.count(*) FROM actual) || '|' ||
      (SELECT pg_catalog.count(*) FROM drift);
  "
)"
if [[ "$EXACT_RESULT" != "2|0" ]]; then
  echo "Binance Spot full contract semantics drifted: $EXACT_RESULT" >&2
  exit 1
fi

SOURCE_STATE="$(psql_cmd -Atqc "SELECT serving_mode || '|' || status FROM arena.sources;")"
if [[ "$SOURCE_STATE" != "legacy|inactive" ]]; then
  echo "successful registration changed source serving state: $SOURCE_STATE" >&2
  exit 1
fi

expect_migration_failure replay 'already has metric source contracts'
if [[ "$(psql_cmd -Atqc 'SELECT pg_catalog.count(*) FROM arena.metric_source_contracts;')" != "2" ]]; then
  echo "failed replay changed Binance Spot contract rows" >&2
  exit 1
fi

bootstrap_contract_registry 25 legacy
expect_migration_failure 'source drift' 'source registry drifted'
assert_no_contracts 'source-drift'

while IFS='|' read -r label mutation; do
  bootstrap_contract_registry 20 legacy
  psql_cmd -q -c "$mutation"
  expect_migration_failure "$label" 'source registry drifted'
  assert_no_contracts "$label"
done <<'CASES'
exchange drift|UPDATE arena.exchanges SET slug = 'not-binance'
adapter drift|UPDATE arena.sources SET adapter_slug = 'not-binance'
product drift|UPDATE arena.sources SET product_type = 'futures'
trader kind drift|UPDATE arena.sources SET trader_kind_scope = 'mixed'
currency drift|UPDATE arena.sources SET currency = 'USDC'
copier depth drift|UPDATE arena.sources SET copier_table_depth = 'top10'
pagination drift|UPDATE arena.sources SET pagination_kind = 'api_cursor'
region drift|UPDATE arena.sources SET fetch_region = 'local'
native windows drift|UPDATE arena.sources SET timeframes_native = ARRAY[7, 30]
derived windows drift|UPDATE arena.sources SET timeframes_derived = ARRAY[90]
board key drift|UPDATE arena.sources SET meta = jsonb_set(meta, '{boardKey}', '"futures"')
portfolio flag drift|UPDATE arena.sources SET meta = jsonb_set(meta, '{click_all_portfolios}', 'false')
history flag drift|UPDATE arena.sources SET meta = jsonb_set(meta, '{position_history_dual_sort}', 'false')
CASES

bootstrap_contract_registry 20 legacy
psql_cmd -q <<'SQL'
DROP TRIGGER metric_source_contracts_reject_direct_mutation
  ON arena.metric_source_contracts;
DROP TRIGGER metric_source_contracts_reject_truncate
  ON arena.metric_source_contracts;
CREATE FUNCTION arena.noop_metric_trust_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER metric_source_contracts_reject_direct_mutation
BEFORE UPDATE OR DELETE ON arena.metric_source_contracts
FOR EACH ROW EXECUTE FUNCTION arena.noop_metric_trust_mutation();
CREATE TRIGGER metric_source_contracts_reject_truncate
BEFORE TRUNCATE ON arena.metric_source_contracts
FOR EACH STATEMENT EXECUTE FUNCTION arena.noop_metric_trust_mutation();
SQL
expect_migration_failure 'no-op trigger' 'append-only or ACL boundary drifted'
assert_no_contracts 'no-op trigger'

bootstrap_contract_registry 20 legacy
psql_cmd -q <<'SQL'
CREATE OR REPLACE FUNCTION arena.reject_direct_metric_trust_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;
SQL
expect_migration_failure 'no-op reject function' 'reject function drifted'
assert_no_contracts 'no-op reject function'

bootstrap_contract_registry 20 legacy
psql_cmd -q <<'SQL'
DROP TRIGGER metric_source_contracts_reject_direct_mutation
  ON arena.metric_source_contracts;
CREATE TRIGGER metric_source_contracts_reject_direct_mutation
BEFORE UPDATE OR DELETE ON arena.metric_source_contracts
FOR EACH ROW
WHEN (OLD.id IS NOT NULL)
EXECUTE FUNCTION arena.reject_direct_metric_trust_mutation();
SQL
expect_migration_failure 'conditional reject trigger' 'append-only or ACL boundary drifted'
assert_no_contracts 'conditional reject trigger'

bootstrap_contract_registry 20 legacy
psql_cmd -q <<'SQL'
CREATE FUNCTION arena.extra_metric_source_contract_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN NEW;
END
$function$;
CREATE TRIGGER metric_source_contracts_extra_after_insert
AFTER INSERT ON arena.metric_source_contracts
FOR EACH ROW EXECUTE FUNCTION arena.extra_metric_source_contract_trigger();
SQL
expect_migration_failure 'extra registry trigger' 'append-only or ACL boundary drifted'
assert_no_contracts 'extra registry trigger'

bootstrap_contract_registry 20 legacy
psql_cmd -q <<'SQL'
ALTER TABLE arena.metric_source_contracts
  DROP CONSTRAINT metric_source_contracts_source_id_fkey,
  ADD CONSTRAINT metric_source_contracts_source_id_fkey
  FOREIGN KEY (source_id) REFERENCES arena.sources(id) ON DELETE CASCADE;
SQL
expect_migration_failure 'foreign-key drift' 'foreign-key or uniqueness boundary drifted'
assert_no_contracts 'foreign-key drift'

bootstrap_contract_registry 20 legacy
psql_cmd -q <<'SQL'
DO $drop_unique$
DECLARE
  v_constraint text;
BEGIN
  SELECT constraint_row.conname
    INTO STRICT v_constraint
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid =
         'arena.metric_source_contracts'::pg_catalog.regclass
     AND constraint_row.contype = 'u';
  EXECUTE pg_catalog.format(
    'ALTER TABLE arena.metric_source_contracts DROP CONSTRAINT %I',
    v_constraint
  );
END
$drop_unique$;
SQL
expect_migration_failure 'unique drift' 'foreign-key or uniqueness boundary drifted'
assert_no_contracts 'unique drift'

bootstrap_contract_registry 20 legacy
psql_cmd -q -c 'ALTER TABLE arena.metric_source_contracts DISABLE ROW LEVEL SECURITY;'
expect_migration_failure 'disabled RLS' 'append-only or ACL boundary drifted'
assert_no_contracts 'disabled RLS'

bootstrap_contract_registry 20 legacy
psql_cmd -q -c 'GRANT SELECT ON arena.metric_source_contracts TO PUBLIC;'
expect_migration_failure 'PUBLIC ACL leak' 'append-only or ACL boundary drifted'
assert_no_contracts 'PUBLIC ACL leak'

bootstrap_contract_registry 20 legacy
psql_cmd -q -c 'GRANT SELECT ON arena.metric_source_contracts TO leaked_registry_role;'
expect_migration_failure 'third-role ACL leak' 'append-only or ACL boundary drifted'
assert_no_contracts 'third-role ACL leak'

bootstrap_contract_registry 20 legacy
psql_cmd -q <<'SQL'
CREATE POLICY latent_anon_read
  ON arena.metric_source_contracts
  FOR SELECT
  TO anon
  USING (true);
SQL
expect_migration_failure 'policy-only leak' 'append-only or ACL boundary drifted'
assert_no_contracts 'policy-only leak'

bootstrap_contract_registry 20 legacy
psql_cmd -q <<'SQL'
GRANT INSERT ON arena.metric_source_contracts TO anon;
CREATE POLICY leaked_anon_insert
  ON arena.metric_source_contracts
  FOR INSERT
  TO anon
  WITH CHECK (true);
SQL
expect_migration_failure 'anonymous insert policy' 'append-only or ACL boundary drifted'
assert_no_contracts 'anonymous insert policy'

bootstrap_contract_registry 20 serving
expect_migration_failure 'serving source' 'must be non-serving and non-dropped'
assert_no_contracts 'serving-source'

bootstrap_contract_registry 20 shadow
psql_cmd -q <<'SQL'
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
) VALUES (
  1,
  'drift',
  'roi',
  'unknown.path',
  'derived',
  'unknown@1',
  'unknown@1',
  ARRAY[7]::smallint[],
  'percent',
  ARRAY['USDT'],
  ARRAY['source_payload'],
  'population_snapshot',
  interval '1 hour',
  interval '5 minutes'
);
SQL
expect_migration_failure 'preexisting contract' 'already has metric source contracts'
if [[ "$(psql_cmd -Atqc 'SELECT pg_catalog.count(*) FROM arena.metric_source_contracts;')" != "1" ]]; then
  echo "failed preexisting-contract migration changed registry rows" >&2
  exit 1
fi

echo "Binance Spot metric source contract PostgreSQL 17 proof passed"
