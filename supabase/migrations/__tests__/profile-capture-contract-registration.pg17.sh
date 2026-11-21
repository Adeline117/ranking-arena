#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261117015119_register_profile_capture_contracts.
# It owns an isolated cluster on a private socket and never connects to
# application data.
#
# Chain applied on a minimal fixture of the relations it reads:
#   20261116205144 trader_stats_score_input_evidence_pointer  (#489 step 2a)
#   20261116215328 profile_acquisition_evidence_ledger
#   20261117015119 register_profile_capture_contracts
#   20261121000026 register_bitget_cfd_profile_capture_contract (a source added
#                  later; its own proof is
#                  register-bitget-cfd-profile-capture-contract.pg17.sh)
#
# Proves:
#   order    - the registration refuses to run before the ledger;
#   exact    - after every registration migration the registered rows equal
#              the worker's code registry
#              (PROFILE_CAPTURE_CONTRACTS, read through tsx) field by field:
#              source, contract name, profileCaptureContractSha256, timeframes
#              and the sorted metric keys; nothing else is registered;
#   ledger   - start accepts every registered contract at every registered
#              timeframe with the code hash, and refuses a drifted hash and the
#              sources without a contract (blofin_spot, bitget_spot);
#   refusal  - a replay, an earlier registration with a drifted hash, an
#              adapter mismatch and a missing source each refuse the whole
#              migration, and nothing lands.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
STEP2A=20261116205144_trader_stats_score_input_evidence_pointer.sql
LEDGER=20261116215328_profile_acquisition_evidence_ledger.sql
REGISTER=20261117015119_register_profile_capture_contracts.sql
REGISTER_BITGET_CFD=20261121000026_register_bitget_cfd_profile_capture_contract.sql

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

TMP_ROOT="$(mktemp -d /tmp/profile-capture-contract-registration-pg17.XXXXXX)"
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

psql_in() {
  local database="$1"
  shift
  "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres \
    -d "$database" "$@"
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

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

# ---------------------------------------------------------------------------
# Fixture: the relations the pointer and ledger migrations read. Every source
# a registration names, plus the two sources that deliberately have no
# contract.
# ---------------------------------------------------------------------------
psql_in postgres <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
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
  'profile capture contract registration requires 20261116215328' \
  "\\i $MIGRATIONS/$REGISTER"
psql_in postgres -f "$MIGRATIONS/$LEDGER"
if [[ "$(registered_count postgres)" != 0 ]]; then
  echo 'the ledger must start with an empty registry' >&2
  exit 1
fi

# Snapshot the pre-registration state for the refusal cases.
psql_in template1 -c 'CREATE DATABASE pre_registration TEMPLATE postgres'

psql_in postgres -f "$MIGRATIONS/$REGISTER"
if [[ "$(registered_count postgres)" != 5 ]]; then
  echo '20261117015119 must register exactly its five sources' >&2
  exit 1
fi
psql_in postgres -f "$MIGRATIONS/$REGISTER_BITGET_CFD"

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
if [[ "$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).length))' "$REGISTRY_JSON")" -lt 1 ]]; then
  echo 'the code registry is empty' >&2
  exit 1
fi

psql_in postgres -v registry="$REGISTRY_JSON" <<'SQL'
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

DO $exact$
DECLARE
  v_missing text;
  v_extra text;
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
END
$exact$;
SQL

# ---------------------------------------------------------------------------
# ledger: start accepts every registered contract with the code hash.
# ---------------------------------------------------------------------------
psql_in postgres -v registry="$REGISTRY_JSON" <<'SQL'
SELECT set_config('proof.registry', :'registry', false) \gset
DO $start$
DECLARE
  v_item jsonb;
  v_timeframe text;
  v_source arena.sources%ROWTYPE;
  v_started integer := 0;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(current_setting('proof.registry')::jsonb) LOOP
    SELECT * INTO STRICT v_source FROM arena.sources WHERE slug = v_item->>'source_slug';
    FOR v_timeframe IN SELECT * FROM jsonb_array_elements_text(v_item->'timeframes') LOOP
      PERFORM arena.start_profile_acquisition_attempt(
        gen_random_uuid(), v_source.id, v_source.id * 100, v_timeframe::integer,
        v_item->>'capture_contract', v_item->>'contract_sha256', NULL
      );
      v_started := v_started + 1;
    END LOOP;
  END LOOP;
  IF v_started <> (SELECT count(*) FROM arena.profile_acquisition_attempts) THEN
    RAISE EXCEPTION 'expected % attempts', v_started;
  END IF;
END
$start$;
SQL

expect_failure_in postgres 'a drifted contract hash cannot start an attempt' \
  'is not registered for source' \
  "SELECT arena.start_profile_acquisition_attempt(gen_random_uuid(), 1, 100, 90,
     'binance_futures-profile-capture@1', repeat('0', 64), NULL)"
for unregistered in '6:blofin_spot' '7:bitget_spot'; do
  id="${unregistered%%:*}"
  slug="${unregistered#*:}"
  expect_failure_in postgres "$slug has no registered contract" 'is not registered for source' \
    "SELECT arena.start_profile_acquisition_attempt(gen_random_uuid(), $id, ${id}00, 30,
       '${slug}-profile-capture@1', repeat('a', 64), NULL)"
done

# ---------------------------------------------------------------------------
# refusal: replay, drifted earlier registration, adapter mismatch, missing
# source. Each refuses the whole migration; nothing lands.
# ---------------------------------------------------------------------------
before="$(registered_count postgres)"
expect_failure_in postgres 'a replay is refused' \
  'source binance_futures already has a registered profile capture contract' \
  "\\i $MIGRATIONS/$REGISTER"
if [[ "$(registered_count postgres)" != "$before" ]]; then
  echo 'a refused replay changed the registry' >&2
  exit 1
fi

clone() {
  psql_in template1 -c "CREATE DATABASE $1 TEMPLATE pre_registration"
}

clone drifted
psql_in drifted -c "INSERT INTO arena.profile_capture_contracts
  (source_id, capture_contract, contract_sha256, timeframes, attestable_metrics)
  VALUES (5, 'toobit_futures-profile-capture@1', repeat('b', 64), '{7,30,90}', '{mdd}')"
expect_failure_in drifted 'an earlier registration with a drifted hash is refused' \
  'source toobit_futures already has a registered profile capture contract' \
  "\\i $MIGRATIONS/$REGISTER"
if [[ "$(registered_count drifted)" != 1 ]]; then
  echo 'a refused registration landed rows next to a drifted one' >&2
  exit 1
fi

clone wrong_adapter
psql_in wrong_adapter -c "UPDATE arena.sources SET adapter_slug = 'bybit' WHERE slug = 'bybit_copytrade'"
expect_failure_in wrong_adapter 'an adapter mismatch is refused' \
  'profile capture contract source bybit_copytrade uses adapter bybit, reviewed bybit_copytrade' \
  "\\i $MIGRATIONS/$REGISTER"
if [[ "$(registered_count wrong_adapter)" != 0 ]]; then
  echo 'a refused registration landed rows' >&2
  exit 1
fi

clone missing_source
psql_in missing_source -c "UPDATE arena.sources SET slug = 'blofin_futures_retired' WHERE slug = 'blofin_futures'"
expect_failure_in missing_source 'a missing source is refused' \
  'profile capture contract source blofin_futures does not exist' \
  "\\i $MIGRATIONS/$REGISTER"
if [[ "$(registered_count missing_source)" != 0 ]]; then
  echo 'a refused registration landed rows' >&2
  exit 1
fi

echo 'profile capture contract registration PG17 proof passed'
