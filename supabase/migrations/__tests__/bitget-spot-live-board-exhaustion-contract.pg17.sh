#!/usr/bin/env bash
# PG17 proof for 20261124114433 (postdeploy registration of bitget_spot as a
# live board in arena.leaderboard_exhaustion_contracts). The real metric-trust
# / attempt-ledger chain, 20261114193017, 20261114211033/211034, 20261115141050
# and 20261118114230 run on stub base tables first.
#
# Like Supabase, the cluster superuser is supabase_admin and every fixture
# object and migration runs as a NOSUPERUSER postgres role, so a statement only
# a superuser may run fails here exactly as it does in production. The role
# has BYPASSRLS, as the Supabase postgres role does: the registry tables FORCE
# row-level security with a read-only policy, so their rows can only be
# written by a role with that attribute (proven below).
#
#   - before 20261118114230 the declaration is not valid: refused, no write
#   + after it bitget_spot is registered, and the row equals the adapter's own
#     declaration (BITGET_SPOT_LEADERBOARD_EXHAUSTION); bitget_cfd and
#     bitget_futures get no row
#   + the registered contract holds for the measured board (5,414 rows read,
#     5,410 distinct, 4 duplicates) and at its allowance (18 rows)
#   - it does not hold above the allowance: 19 duplicates, a board 20 rows
#     short of its last total, a total that moved by 19, or a capture that did
#     not end on a short or empty page
#   - bitget_cfd, unregistered, has no exhaustion proof at all
#   - a replay, a re-adaptered source, a source without page_size or an
#     earlier registration refuses with no write
#   - a role without BYPASSRLS is refused by row-level security, with no write

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
DRIFT_PROOF="$MIGRATIONS/20261118114230_leaderboard_exhaustion_reported_total_drift.sql"
TARGET="$MIGRATIONS/20261124114433_register_bitget_spot_live_board_exhaustion_contract.sql"
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

TMP_ROOT="$(mktemp -d /tmp/bitget-spot-live-board-pg17.XXXXXX)"
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

# Every fixture object and migration runs as the non-superuser postgres role.
psql_db() {
  local db="$1"
  shift
  PGOPTIONS='-c client_min_messages=warning' \
    "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d "$db" "$@"
}

psql_admin() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U supabase_admin -d postgres "$@"
}

clone_db() {
  psql_admin -qc "CREATE DATABASE $2 TEMPLATE $1 OWNER postgres;"
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

contract_rows() {
  psql_db "$1" -Atqc "
    SELECT COALESCE(pg_catalog.string_agg(source_row.slug, ',' ORDER BY source_row.slug), '')
      FROM arena.leaderboard_exhaustion_contracts AS contract
      JOIN arena.sources AS source_row ON source_row.id = contract.source_id"
}

expect_failure() {
  local db="$1" label="$2" expected="$3"
  local before
  before="$(contract_rows "$db")"
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
  assert_equal "$label writes nothing" "$before" "$(contract_rows "$db")"
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U supabase_admin --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null

psql_admin -q <<'SQL'
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE BYPASSRLS;
CREATE ROLE anon NOLOGIN NOSUPERUSER;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER;
CREATE ROLE service_role NOLOGIN NOSUPERUSER;
GRANT anon, authenticated, service_role TO postgres;
GRANT CREATE ON DATABASE postgres TO postgres;
ALTER SCHEMA public OWNER TO postgres;
SQL
if [[ "$(psql_db postgres -Atqc "SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user")" != "f" ]]; then
  echo "migrations must run as a non-superuser postgres role" >&2
  exit 1
fi

# Base tables as the 20260610/20260721 foundations shape them; the bitget rows
# are the 20260610223356 seed rows (adapter, windows, currency, page_size).
psql_db postgres -q <<'SQL'
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
  (1, 'binance_futures', 'binance', 'active', 'serving', 'USDT', 'futures', 'local', '{7,30,90}', 30),
  (2, 'binance_web3_bsc', 'binance_web3', 'active', 'serving', 'USDT', 'onchain', 'local', '{7,30,90}', 24),
  (3, 'bitget_futures', 'bitget', 'active', 'serving', 'USDT', 'futures', 'local', '{7,30,90}', 30),
  (4, 'bitget_spot', 'bitget', 'active', 'serving', 'USDT', 'spot', 'local', '{7,30,90}', 30),
  (5, 'bitget_cfd', 'bitget', 'active', 'serving', 'USDT', 'cfd', 'local', '{7,30,90}', 30);
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

# ── Before 20261118114230 the declaration is not valid ──

clone_db postgres before_proof
expect_failure before_proof "registration before the drift proof" \
  "requires the reported_total_drift proof (20261118114230)"

psql_db postgres -q -f "$DRIFT_PROOF" >/dev/null
for db in main readaptered no_page_size earlier no_bypassrls; do
  clone_db postgres "$db"
done

# ── Registration ──

psql_db main -q -f "$TARGET"
echo "ok: registration applies as a non-superuser"
assert_equal "only bitget_spot is registered" "bitget_spot" "$(contract_rows main)"
EXPECTED="$(cd "$ROOT_DIR" && npx --no-install tsx -e '
import { BITGET_SPOT_LEADERBOARD_EXHAUSTION } from "./lib/ingest/adapters/bitget"
console.log(JSON.stringify(BITGET_SPOT_LEADERBOARD_EXHAUSTION))
')"
assert_equal "registration equals the adapter declaration" "t" "$(
  psql_db main -Atq -v expected="$EXPECTED" <<'SQL'
SELECT contract.declaration = :'expected'::jsonb
  FROM arena.leaderboard_exhaustion_contracts AS contract
  JOIN arena.sources AS source_row ON source_row.id = contract.source_id
 WHERE source_row.slug = 'bitget_spot'
SQL
)"
assert_equal "the seed table does not outlive the applying session" "0" "$(psql_db main -Atqc "
  SELECT pg_catalog.count(*) FROM pg_catalog.pg_class WHERE relname = 'bitget_spot_live_board_seed'")"

# ── The registered contract against captured boards ──
#
# holds <source> <termination> <full pages> <last page rows> <distinct>
#       <total min> <total max> <total last>
# builds the completeness block the worker records for a board read in pages
# of 30 and asks arena.leaderboard_exhaustion_completeness_holds.
psql_db main -q <<'SQL'
CREATE FUNCTION public.bitget_board_holds(
  p_source text, p_termination text, p_full_pages integer, p_last_rows integer,
  p_distinct integer, p_total_min integer, p_total_max integer, p_total_last integer
) RETURNS boolean
LANGUAGE sql
AS $function$
  WITH page AS (
    SELECT n AS ordinal,
           CASE WHEN n <= p_full_pages THEN 30 ELSE p_last_rows END AS row_count
      FROM pg_catalog.generate_series(1, p_full_pages + 1) AS n
  ), block AS (
    SELECT pg_catalog.jsonb_build_object(
      'data_contract', 'arena.ingest.leaderboard-exhaustion-completeness@1',
      'declaration', (
        SELECT contract.declaration
          FROM arena.leaderboard_exhaustion_contracts AS contract
          JOIN arena.sources AS source_row ON source_row.id = contract.source_id
         WHERE source_row.slug = 'bitget_spot'
      ),
      'pages', (
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'ordinal', page.ordinal,
                 'request_sha256', pg_catalog.md5('request' || page.ordinal) || pg_catalog.md5('a'),
                 'response_sha256', pg_catalog.md5('response' || page.ordinal) || pg_catalog.md5('b'),
                 'row_count', page.row_count,
                 'row_keys_sha256', pg_catalog.md5('keys' || page.ordinal) || pg_catalog.md5('c'),
                 'end_signal_value', NULL,
                 'version_token_sha256', NULL
               ) ORDER BY page.ordinal)
          FROM page
      ),
      'row_keys', pg_catalog.jsonb_build_object(
        'observed', (SELECT pg_catalog.sum(page.row_count)::integer FROM page),
        'distinct', p_distinct,
        'duplicate', (SELECT pg_catalog.sum(page.row_count)::integer FROM page) - p_distinct
      ),
      'board_version', pg_catalog.jsonb_build_object(
        'kind', 'reported_total_drift',
        'reported_totals', pg_catalog.jsonb_build_object(
          'min', p_total_min, 'max', p_total_max, 'last', p_total_last
        )
      )
    ) AS completeness
  )
  SELECT arena.leaderboard_exhaustion_completeness_holds(
    (SELECT id FROM arena.sources WHERE slug = p_source),
    block.completeness,
    p_termination,
    p_full_pages + 1,
    'unknown',
    (block.completeness->'row_keys'->>'observed')::integer,
    p_distinct,
    0,
    (block.completeness->'row_keys'->>'duplicate')::integer
  )
  FROM block
$function$;
SQL
holds() {
  psql_db main -Atqc "SELECT public.bitget_board_holds('$1', '$2', $3, $4, $5, $6, $7, $8)"
}

# 5,414 rows = 180 pages of 30 and a final page of 14.
assert_equal "quiet board holds" "t" "$(holds bitget_spot short_page 180 14 5414 5414 5414 5414)"
assert_equal "measured board (5,414 read, 5,410 distinct, 4 duplicates) holds" "t" \
  "$(holds bitget_spot short_page 180 14 5410 5414 5414 5414)"
assert_equal "measured board with a total that moved by 2 holds" "t" \
  "$(holds bitget_spot short_page 180 14 5412 5413 5415 5414)"
assert_equal "the largest measured drift (6 duplicates, total moved by 1) holds" "t" \
  "$(holds bitget_spot short_page 180 14 5408 5414 5415 5414)"
assert_equal "18 duplicates (the allowance at 5,414) hold" "t" \
  "$(holds bitget_spot short_page 180 14 5396 5414 5414 5414)"
assert_equal "board ending on an empty page holds" "t" \
  "$(holds bitget_spot empty_page 180 0 5400 5400 5400 5400)"

assert_equal "19 duplicates do not hold" "f" \
  "$(holds bitget_spot short_page 180 14 5395 5414 5414 5414)"
assert_equal "a board 20 rows short of its last total (5,434, allowance 19) does not hold" "f" \
  "$(holds bitget_spot short_page 180 14 5414 5434 5434 5434)"
assert_equal "a board 18 rows short of its last total holds" "t" \
  "$(holds bitget_spot short_page 180 14 5414 5432 5432 5432)"
assert_equal "a total that moved by 19 does not hold" "f" \
  "$(holds bitget_spot short_page 180 14 5414 5395 5414 5414)"
assert_equal "a board cut at the reported total, not at a short page, does not hold" "f" \
  "$(holds bitget_spot reported_population_reached 180 14 5410 5414 5414 5414)"
assert_equal "a silently emptied page mid-board does not hold" "f" \
  "$(holds bitget_spot empty_page 89 0 2670 5414 5414 5414)"
# A board ten times larger: 0.35% would be 189 rows, the absolute cap is 20.
assert_equal "20 duplicates on a 54,140-row board hold" "t" \
  "$(holds bitget_spot short_page 1804 20 54120 54140 54140 54140)"
assert_equal "21 duplicates on a 54,140-row board do not hold" "f" \
  "$(holds bitget_spot short_page 1804 20 54119 54140 54140 54140)"

assert_equal "bitget_cfd has no exhaustion proof" "f" \
  "$(holds bitget_cfd short_page 6 28 208 208 208 208)"
assert_equal "bitget_futures has no exhaustion proof" "f" \
  "$(holds bitget_futures short_page 180 14 5414 5414 5414 5414)"

# ── Refusals ──

expect_failure main "registration replay" "already exists for: bitget_spot"

psql_db readaptered -q -c "UPDATE arena.sources SET adapter_slug = 'bitget_v2' WHERE slug = 'bitget_spot'"
expect_failure readaptered "registration for a re-adaptered source" "source drift: bitget_spot"

psql_db no_page_size -q -c "UPDATE arena.sources SET page_size = NULL WHERE slug = 'bitget_spot'"
expect_failure no_page_size "registration for a source without page_size" "source drift: bitget_spot"

psql_db earlier -q -c "
  INSERT INTO arena.leaderboard_exhaustion_contracts (source_id, completeness_contract, declaration)
  SELECT id, 'arena.ingest.leaderboard-exhaustion-completeness@1',
         '{\"completeness_mode\": \"exhausted\", \"list_path\": [\"data\", \"rows\"], \"row_key_path\": [\"traderUid\"], \"end_signal\": {\"kind\": \"short_page\"}, \"board_version\": {\"kind\": \"first_page_reread\"}, \"max_duplicate_rows\": 0}'
    FROM arena.sources WHERE slug = 'bitget_spot'"
expect_failure earlier "registration over an earlier bitget_spot contract" \
  "already exists for: bitget_spot"

# The registry forces row-level security and has no write policy.
psql_admin -qc "ALTER ROLE postgres NOBYPASSRLS;"
if psql_db no_bypassrls -q -f "$TARGET" >"$ERROR_FILE" 2>&1; then
  echo "FAIL: registration without BYPASSRLS unexpectedly succeeded" >&2
  exit 1
fi
psql_admin -qc "ALTER ROLE postgres BYPASSRLS;"
if [[ "$(<"$ERROR_FILE")" != *'row-level security policy for table "leaderboard_exhaustion_contracts"'* ]]; then
  echo "FAIL: registration without BYPASSRLS failed for the wrong reason" >&2
  cat "$ERROR_FILE" >&2
  exit 1
fi
echo "ok: registration without BYPASSRLS refused"
assert_equal "registration without BYPASSRLS writes nothing" "" "$(contract_rows no_bypassrls)"

echo "bitget_spot live board registration PG17 proof passed"
