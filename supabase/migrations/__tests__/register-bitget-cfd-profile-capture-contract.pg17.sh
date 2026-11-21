#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261121000026_register_bitget_cfd_profile_capture_contract.
# It owns an isolated cluster on a private socket and never connects to
# application data.
#
# Like Supabase, the cluster superuser is supabase_admin and every fixture
# object and migration runs as a NOSUPERUSER postgres role, so a statement only
# a superuser may run (e.g. a function-level SET of a custom parameter) fails
# here exactly as it does in production.
#
# Chain applied on a minimal fixture of the relations it reads:
#   20261116205144 trader_stats_score_input_evidence_pointer  (#489 step 2a)
#   20261116215328 profile_acquisition_evidence_ledger
#   20261117015119 register_profile_capture_contracts
#   20261121000026 register_bitget_cfd_profile_capture_contract
#
# Proves:
#   order    - the registration refuses to run before the ledger, and does not
#              depend on 20261117015119 (it registers its one row alone);
#   exact    - after both registrations the registered rows equal the worker's
#              code registry (PROFILE_CAPTURE_CONTRACTS, read through tsx) field
#              by field, and the bitget_cfd row is the code contract: name,
#              profileCaptureContractSha256, timeframes, sorted metric keys;
#   ledger   - start accepts bitget_cfd at 7/30/90 with the code hash, and
#              refuses a drifted hash and bitget_spot (no contract);
#   refusal  - a replay, an earlier registration with a drifted hash, an
#              adapter mismatch and a missing source each refuse the whole
#              migration, and nothing lands.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
STEP2A=20261116205144_trader_stats_score_input_evidence_pointer.sql
LEDGER=20261116215328_profile_acquisition_evidence_ledger.sql
REGISTER_FIRST=20261117015119_register_profile_capture_contracts.sql
REGISTER=20261121000026_register_bitget_cfd_profile_capture_contract.sql

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

TMP_ROOT="$(mktemp -d /tmp/register-bitget-cfd-profile-capture-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((55000 + ($$ % 3000)))}"
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

# Every fixture statement and migration runs as the NOSUPERUSER postgres role.
psql_in() {
  local database="$1"
  shift
  "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres \
    -d "$database" "$@"
}

psql_admin() {
  "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U supabase_admin \
    -d postgres "$@"
}

expect_failure_in() {
  local database="$1" label="$2" pattern="$3" sql="$4"
  local output
  if output="$(psql_in "$database" -c "$sql" 2>&1)"; then
    echo "$label: expected failure, succeeded" >&2
    exit 1
  fi
  if ! grep -q -- "$pattern" <<<"$output"; then
    echo "$label: expected '$pattern', got: $output" >&2
    exit 1
  fi
}

registered_count() {
  psql_in "$1" -tA -c 'SELECT count(*) FROM arena.profile_capture_contracts'
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U supabase_admin --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

psql_admin <<'SQL'
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE CREATEDB NOBYPASSRLS;
CREATE ROLE anon NOLOGIN NOSUPERUSER;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER;
CREATE ROLE service_role NOLOGIN NOSUPERUSER;
GRANT anon, authenticated, service_role TO postgres;
GRANT CREATE ON DATABASE postgres TO postgres;
ALTER DATABASE postgres OWNER TO postgres;
ALTER SCHEMA public OWNER TO postgres;
SQL
if [[ "$(psql_in postgres -tA -c "SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user")" != "f" ]]; then
  echo "migrations must run as a non-superuser postgres role" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Fixture: the relations the pointer and ledger migrations read. Every source
# either registration names, plus the two sources that deliberately have no
# contract.
# ---------------------------------------------------------------------------
psql_in postgres <<'SQL'
CREATE SCHEMA arena;
GRANT USAGE ON SCHEMA public, arena TO anon, authenticated, service_role;

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  adapter_slug text NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL DEFAULT 'serving'
);
CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL
);
CREATE TABLE arena.trader_stats (
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  timeframe smallint NOT NULL,
  as_of timestamptz NOT NULL,
  roi numeric,
  pnl numeric,
  win_rate numeric,
  mdd numeric,
  sharpe numeric,
  copier_count integer,
  total_positions integer,
  extras jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (trader_id, timeframe)
);
CREATE TABLE arena.raw_objects (
  id bigint PRIMARY KEY,
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

INSERT INTO arena.sources (id, slug, adapter_slug, status) VALUES
  (1, 'binance_futures', 'binance', 'active'),
  (2, 'binance_spot', 'binance', 'active'),
  (3, 'bybit_copytrade', 'bybit_copytrade', 'active'),
  (4, 'blofin_futures', 'blofin', 'active'),
  (5, 'toobit_futures', 'toobit', 'active'),
  (6, 'blofin_spot', 'blofin', 'active'),
  (7, 'bitget_spot', 'bitget', 'active'),
  (8, 'bitget_cfd', 'bitget', 'active');
INSERT INTO arena.traders (id, source_id, exchange_trader_id)
SELECT id * 100, id, 'trader-' || id FROM arena.sources;
SQL

psql_in postgres -f "$MIGRATIONS/$STEP2A"
expect_failure_in postgres 'the registration refuses to run before the ledger' \
  'bitget_cfd profile capture contract registration requires 20261116215328' \
  "\\i $MIGRATIONS/$REGISTER"
psql_in postgres -f "$MIGRATIONS/$LEDGER"
if [[ "$(registered_count postgres)" != 0 ]]; then
  echo 'the ledger must start with an empty registry' >&2
  exit 1
fi

# Snapshot the pre-registration state for the order and refusal cases.
psql_in template1 -c 'CREATE DATABASE pre_registration TEMPLATE postgres'
clone() {
  psql_in template1 -c "CREATE DATABASE $1 TEMPLATE pre_registration"
}

# order: the bitget_cfd registration stands alone.
clone alone
psql_in alone -f "$MIGRATIONS/$REGISTER"
if [[ "$(psql_in alone -tA -c "
  SELECT string_agg(source.slug, ',')
  FROM arena.profile_capture_contracts AS contract
  JOIN arena.sources AS source ON source.id = contract.source_id")" != 'bitget_cfd' ]]; then
  echo 'the registration alone must register exactly bitget_cfd' >&2
  exit 1
fi

psql_in postgres -f "$MIGRATIONS/$REGISTER_FIRST"
psql_in postgres -f "$MIGRATIONS/$REGISTER"

# ---------------------------------------------------------------------------
# exact: the registered rows are the code registry, field by field.
# ---------------------------------------------------------------------------
REGISTRY_JSON="$(cd "$ROOT_DIR" && npx --no-install tsx -e '
const {
  PROFILE_CAPTURE_CONTRACTS,
  profileCaptureContractSha256,
} = require("./lib/ingest/profile-capture/contract")
const rows = [...PROFILE_CAPTURE_CONTRACTS.values()].map((contract) => ({
  source_slug: contract.sourceSlug,
  capture_contract: contract.captureContract,
  contract_sha256: profileCaptureContractSha256(contract),
  timeframes: [...contract.timeframes],
  attestable_metrics: Object.keys(contract.metrics).sort(),
}))
process.stdout.write(JSON.stringify(rows))
')"
CFD_JSON="$(node -e '
const row = JSON.parse(process.argv[1]).find((item) => item.source_slug === "bitget_cfd")
if (!row) throw new Error("the code registry has no bitget_cfd contract")
process.stdout.write(JSON.stringify(row))
' "$REGISTRY_JSON")"

psql_in postgres -v registry="$REGISTRY_JSON" -v cfd="$CFD_JSON" <<'SQL'
CREATE TEMPORARY TABLE code_registry AS
SELECT
  item->>'source_slug' AS source_slug,
  item->>'capture_contract' AS capture_contract,
  item->>'contract_sha256' AS contract_sha256,
  ARRAY(SELECT value::smallint FROM jsonb_array_elements_text(item->'timeframes') WITH ORDINALITY AS t(value, ord) ORDER BY ord) AS timeframes,
  ARRAY(SELECT value FROM jsonb_array_elements_text(item->'attestable_metrics') WITH ORDINALITY AS m(value, ord) ORDER BY ord) AS attestable_metrics
FROM jsonb_array_elements(:'registry'::jsonb) AS item;

CREATE TEMPORARY TABLE registered AS
SELECT source.slug AS source_slug, contract.capture_contract, contract.contract_sha256,
       contract.timeframes, contract.attestable_metrics
FROM arena.profile_capture_contracts AS contract
JOIN arena.sources AS source ON source.id = contract.source_id;

SELECT set_config('proof.cfd', :'cfd', false) \gset
DO $exact$
DECLARE
  v_missing text;
  v_extra text;
  v_cfd jsonb := current_setting('proof.cfd')::jsonb;
BEGIN
  SELECT string_agg(format('%s', c), '; ') INTO v_missing
  FROM (SELECT * FROM code_registry EXCEPT SELECT * FROM registered) AS c;
  SELECT string_agg(format('%s', r), '; ') INTO v_extra
  FROM (SELECT * FROM registered EXCEPT SELECT * FROM code_registry) AS r;
  IF v_missing IS NOT NULL OR v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'registry drift: code-only [%], database-only [%]', v_missing, v_extra;
  END IF;
  IF (SELECT count(*) FROM registered) <> (SELECT count(*) FROM code_registry) THEN
    RAISE EXCEPTION 'registered row count differs from the code registry';
  END IF;
  -- The reviewed bitget_cfd row, spelled out: the drawdown is attestable.
  IF NOT EXISTS (
    SELECT 1 FROM registered
    WHERE source_slug = 'bitget_cfd'
      AND capture_contract = 'bitget_cfd-profile-capture@1'
      AND contract_sha256 = v_cfd->>'contract_sha256'
      AND timeframes = '{7,30,90}'::smallint[]
      AND attestable_metrics = '{mdd,pnl,roi,total_positions,win_rate}'::text[]
  ) THEN
    RAISE EXCEPTION 'the bitget_cfd row is not the reviewed contract';
  END IF;
END
$exact$;
SQL

# ---------------------------------------------------------------------------
# ledger: start accepts bitget_cfd with the code hash at every timeframe.
# ---------------------------------------------------------------------------
psql_in postgres -v cfd="$CFD_JSON" <<'SQL'
SELECT set_config('proof.cfd', :'cfd', false) \gset
DO $start$
DECLARE
  v_cfd jsonb := current_setting('proof.cfd')::jsonb;
  v_timeframe integer;
BEGIN
  FOREACH v_timeframe IN ARRAY ARRAY[7, 30, 90] LOOP
    PERFORM arena.start_profile_acquisition_attempt(
      gen_random_uuid(), 8::smallint, 800, v_timeframe,
      v_cfd->>'capture_contract', v_cfd->>'contract_sha256', NULL
    );
  END LOOP;
  IF (SELECT count(*) FROM arena.profile_acquisition_attempts WHERE source_id = 8) <> 3 THEN
    RAISE EXCEPTION 'expected three bitget_cfd attempts';
  END IF;
END
$start$;
SQL

expect_failure_in postgres 'a drifted contract hash cannot start an attempt' \
  'is not registered for source' \
  "SELECT arena.start_profile_acquisition_attempt(gen_random_uuid(), 8::smallint, 800, 30,
     'bitget_cfd-profile-capture@1', repeat('0', 64), NULL)"
expect_failure_in postgres 'bitget_spot has no registered contract' \
  'is not registered for source' \
  "SELECT arena.start_profile_acquisition_attempt(gen_random_uuid(), 7::smallint, 700, 30,
     'bitget_spot-profile-capture@1', repeat('a', 64), NULL)"

# ---------------------------------------------------------------------------
# refusal: replay, drifted earlier registration, adapter mismatch, missing
# source. Each refuses the whole migration; nothing lands.
# ---------------------------------------------------------------------------
before="$(registered_count postgres)"
expect_failure_in postgres 'a replay is refused' \
  'source bitget_cfd already has a registered profile capture contract' \
  "\\i $MIGRATIONS/$REGISTER"
if [[ "$(registered_count postgres)" != "$before" ]]; then
  echo 'a refused replay changed the registry' >&2
  exit 1
fi

clone drifted
psql_in drifted -c "INSERT INTO arena.profile_capture_contracts
  (source_id, capture_contract, contract_sha256, timeframes, attestable_metrics)
  VALUES (8, 'bitget_cfd-profile-capture@1', repeat('b', 64), '{7,30,90}', '{mdd}')"
expect_failure_in drifted 'an earlier registration with a drifted hash is refused' \
  'source bitget_cfd already has a registered profile capture contract' \
  "\\i $MIGRATIONS/$REGISTER"
if [[ "$(registered_count drifted)" != 1 ]]; then
  echo 'a refused registration landed rows next to a drifted one' >&2
  exit 1
fi

clone wrong_adapter
psql_in wrong_adapter -c "UPDATE arena.sources SET adapter_slug = 'bitget_bots' WHERE slug = 'bitget_cfd'"
expect_failure_in wrong_adapter 'an adapter mismatch is refused' \
  'profile capture contract source bitget_cfd uses adapter bitget_bots, reviewed bitget' \
  "\\i $MIGRATIONS/$REGISTER"
if [[ "$(registered_count wrong_adapter)" != 0 ]]; then
  echo 'a refused registration landed rows' >&2
  exit 1
fi

clone missing_source
psql_in missing_source -c "UPDATE arena.sources SET slug = 'bitget_cfd_retired' WHERE slug = 'bitget_cfd'"
expect_failure_in missing_source 'a missing source is refused' \
  'profile capture contract source bitget_cfd does not exist' \
  "\\i $MIGRATIONS/$REGISTER"
if [[ "$(registered_count missing_source)" != 0 ]]; then
  echo 'a refused registration landed rows' >&2
  exit 1
fi

echo 'bitget_cfd profile capture contract registration PG17 proof passed'
