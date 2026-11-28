#!/usr/bin/env bash
# PG17 proof for 20261127101312 (postdeploy: identity_merge, one ranked row per
# trader, and the bitget_cfd registration). The real metric-trust /
# attempt-ledger chain, 20261114193017, 20261114211033/211034, 20261115141050,
# 20261118114230 and 20261124114433 run on stub base tables first.
#
# Like Supabase, the cluster superuser is supabase_admin and every fixture
# object and migration runs as a NOSUPERUSER postgres role, so a statement only
# a superuser may run fails here exactly as it does in production. The role
# has BYPASSRLS, as the Supabase postgres role does: the registry tables FORCE
# row-level security with a read-only policy, so their rows can only be
# written by a role with that attribute (proven below).
#
#   - before 20261118114230 (or over replaced function bodies): refused, no write
#   + bitget_cfd is registered and equals BITGET_CFD_LEADERBOARD_EXHAUSTION;
#     the bitget_spot registration is untouched
#   = every registered declaration without identity_merge (bitget_spot,
#     binance_futures drift, binance_web3 page_count + re-read, okx token) is
#     judged exactly as before over a grid of completeness blocks, recorded
#     before the migration and compared after it
#   + the measured cfd boards (191/188, 220/218, 224/222 portfolios/traders)
#     hold, ending on a short or an empty page
#   - a portfolio read twice, portfolios != the last total, a total that moved,
#     identities != accepted rows, merged rows or deduplicated rows that do not
#     match, a block without identity_merge, a mid-board short page: refused
#   - identity_merge in a block for bitget_spot is refused
#   - identity_merge declarations without drift, with a duplicate allowance, of
#     another kind or with extra keys are not valid
#   - a replay, a re-adaptered source, a source without page_size, an earlier
#     registration and a role without BYPASSRLS refuse with no write

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
DRIFT_PROOF="$MIGRATIONS/20261118114230_leaderboard_exhaustion_reported_total_drift.sql"
SPOT_REGISTRATION="$MIGRATIONS/20261124114433_register_bitget_spot_live_board_exhaustion_contract.sql"
TARGET="$MIGRATIONS/20261127101312_bitget_cfd_one_row_per_trader_exhaustion_contract.sql"
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

TMP_ROOT="$(mktemp -d /tmp/bitget-cfd-one-row-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((51000 + ($$ % 5000)))}"
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

# ── Before 20261118114230 the migration is refused ──

clone_db postgres before_proof
expect_failure before_proof "migration before the drift proof" \
  "requires the reported_total_drift proof (20261118114230)"

psql_db postgres -q -f "$DRIFT_PROOF" >/dev/null
psql_db postgres -q -f "$SPOT_REGISTRATION" >/dev/null

# Further registered declarations without identity_merge, as their reviewed
# migrations register them (binance_futures 20261118134500, binance_web3_bsc
# 20261115160917), plus an okx-shaped token contract on bitget_futures (a
# fixture only: bitget_futures is not registered in reality).
psql_db postgres -q <<'SQL'
INSERT INTO arena.leaderboard_exhaustion_contracts (source_id, completeness_contract, declaration)
VALUES
  (1, 'arena.ingest.leaderboard-exhaustion-completeness@1',
   '{"completeness_mode": "exhausted", "list_path": ["data", "list"], "row_key_path": ["leadPortfolioId"], "end_signal": {"kind": "short_page"}, "board_version": {"kind": "reported_total_drift", "path": ["data", "total"], "max_drift_bps": 100}, "max_duplicate_rows": 200}'),
  (2, 'arena.ingest.leaderboard-exhaustion-completeness@1',
   '{"completeness_mode": "exhausted", "list_path": ["data", "data"], "row_key_path": ["address"], "end_signal": {"kind": "page_count", "path": ["data", "pages"]}, "board_version": {"kind": "first_page_reread"}, "max_duplicate_rows": 0}'),
  (3, 'arena.ingest.leaderboard-exhaustion-completeness@1',
   '{"completeness_mode": "exhausted", "list_path": ["data", "0", "ranks"], "row_key_path": ["uniqueCode"], "end_signal": {"kind": "page_count", "path": ["data", "0", "totalPage"]}, "board_version": {"kind": "token", "path": ["data", "0", "dataVer"]}, "max_duplicate_rows": 0}');
SQL

# board_holds(source, termination, full pages, last page rows, distinct,
#             total min, max, last, accepted, deduplicated, merge, reread ok,
#             tokens equal)
# builds the completeness block the worker records for a board read in pages
# of 30 (merge NULL: no identity_merge key) and asks
# arena.leaderboard_exhaustion_completeness_holds.
psql_db postgres -q <<'SQL'
CREATE FUNCTION public.board_holds(
  p_source text, p_termination text, p_full_pages integer, p_last_rows integer,
  p_distinct integer, p_total_min integer, p_total_max integer, p_total_last integer,
  p_accepted integer, p_deduplicated integer, p_merge jsonb,
  p_reread_ok boolean DEFAULT true, p_tokens_equal boolean DEFAULT true
) RETURNS boolean
LANGUAGE sql
AS $function$
  WITH declared AS (
    SELECT contract.declaration, source_row.id AS source_id
      FROM arena.leaderboard_exhaustion_contracts AS contract
      JOIN arena.sources AS source_row ON source_row.id = contract.source_id
     WHERE source_row.slug = p_source
  ), page AS (
    SELECT n AS ordinal,
           CASE WHEN n <= p_full_pages THEN 30 ELSE p_last_rows END AS row_count
      FROM pg_catalog.generate_series(1, p_full_pages + 1) AS n
  ), block AS (
    SELECT pg_catalog.jsonb_build_object(
      'data_contract', 'arena.ingest.leaderboard-exhaustion-completeness@1',
      'declaration', declared.declaration,
      'pages', (
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'ordinal', page.ordinal,
                 'request_sha256', pg_catalog.md5('request' || page.ordinal) || pg_catalog.md5('a'),
                 'response_sha256', pg_catalog.md5('response' || page.ordinal) || pg_catalog.md5('b'),
                 'row_count', page.row_count,
                 'row_keys_sha256', pg_catalog.md5('keys' || page.ordinal) || pg_catalog.md5('c'),
                 'end_signal_value',
                   CASE declared.declaration->'end_signal'->>'kind'
                     WHEN 'page_count' THEN pg_catalog.to_jsonb(p_full_pages + 1)
                     ELSE 'null'::jsonb
                   END,
                 'version_token_sha256',
                   CASE WHEN declared.declaration->'board_version'->>'kind' = 'token' THEN
                     pg_catalog.to_jsonb(pg_catalog.md5(
                       CASE WHEN p_tokens_equal OR page.ordinal = 1 THEN 'token' ELSE 'other' END
                     ) || pg_catalog.md5('d'))
                   ELSE 'null'::jsonb END
               ) ORDER BY page.ordinal)
          FROM page
      ),
      'row_keys', pg_catalog.jsonb_build_object(
        'observed', (SELECT pg_catalog.sum(page.row_count)::integer FROM page),
        'distinct', p_distinct,
        'duplicate', (SELECT pg_catalog.sum(page.row_count)::integer FROM page) - p_distinct
      ),
      'board_version',
        CASE declared.declaration->'board_version'->>'kind'
          WHEN 'token' THEN '{"kind": "token"}'::jsonb
          WHEN 'first_page_reread' THEN pg_catalog.jsonb_build_object(
            'kind', 'first_page_reread',
            'reread', pg_catalog.jsonb_build_object(
              'request_sha256', pg_catalog.md5('reread') || pg_catalog.md5('e'),
              'response_sha256', pg_catalog.md5('reread-response') || pg_catalog.md5('f'),
              'http_status', 200,
              'row_keys_sha256',
                CASE WHEN p_reread_ok THEN pg_catalog.md5('keys1') || pg_catalog.md5('c')
                     ELSE pg_catalog.md5('moved') || pg_catalog.md5('c') END
            )
          )
          ELSE pg_catalog.jsonb_build_object(
            'kind', 'reported_total_drift',
            'reported_totals', pg_catalog.jsonb_build_object(
              'min', p_total_min, 'max', p_total_max, 'last', p_total_last
            )
          )
        END
    ) || CASE WHEN p_merge IS NULL THEN '{}'::jsonb
              ELSE pg_catalog.jsonb_build_object('identity_merge', p_merge) END
      AS completeness,
      declared.source_id
      FROM declared
  )
  SELECT COALESCE((
    SELECT arena.leaderboard_exhaustion_completeness_holds(
      block.source_id,
      block.completeness,
      p_termination,
      p_full_pages + 1,
      'unknown',
      (block.completeness->'row_keys'->>'observed')::integer,
      p_accepted,
      0,
      p_deduplicated
    )
    FROM block
  ), false)
$function$;

-- The grid every declaration without identity_merge is judged on, before and
-- after the migration.
CREATE TABLE public.legacy_grid AS
SELECT source_slug, termination, full_pages, last_rows, distinct_rows,
       total_min, total_max, total_last, accepted, deduplicated,
       stable AS reread_ok, stable AS tokens_equal
  FROM pg_catalog.unnest(ARRAY['bitget_spot', 'binance_futures', 'binance_web3_bsc', 'bitget_futures'])
         AS source_slug,
       pg_catalog.unnest(ARRAY['short_page', 'empty_page', 'reported_page_count_reached',
                               'reported_population_reached']) AS termination,
       (VALUES (180, 14), (180, 0), (6, 11), (89, 0)) AS shape(full_pages, last_rows),
       pg_catalog.unnest(ARRAY[0, 1, 4, 18, 19, 21]) AS duplicate,
       pg_catalog.unnest(ARRAY[0, -1, 2, -20, 20]) AS shift,
       pg_catalog.unnest(ARRAY[0, 1]) AS fact_shift,
       pg_catalog.unnest(ARRAY[true, false]) AS stable,
       LATERAL (
         SELECT full_pages * 30 + last_rows AS observed
       ) AS observed_rows,
       LATERAL (
         SELECT observed - duplicate AS distinct_rows,
                observed + LEAST(shift, 0) AS total_min,
                observed + GREATEST(shift, 0) AS total_max,
                observed + CASE WHEN shift = -20 THEN -20 ELSE 0 END AS total_last,
                observed - duplicate - fact_shift AS accepted,
                duplicate + fact_shift AS deduplicated
       ) AS derived
 WHERE duplicate < full_pages * 30 + last_rows
   AND observed + LEAST(shift, 0) >= 0;
ALTER TABLE public.legacy_grid ADD COLUMN before boolean;
UPDATE public.legacy_grid SET before = public.board_holds(
  source_slug, termination, full_pages, last_rows, distinct_rows, total_min, total_max,
  total_last, accepted, deduplicated, NULL, reread_ok, tokens_equal);

-- Declarations valid before the migration, and some that were not.
CREATE TABLE public.legacy_declarations AS
SELECT declaration, arena.leaderboard_exhaustion_declaration_valid(declaration) AS before
  FROM (
    SELECT contract.declaration FROM arena.leaderboard_exhaustion_contracts AS contract
    UNION ALL SELECT '{"completeness_mode": "exhausted", "list_path": ["data", "rows"], "row_key_path": ["traderUid"], "end_signal": {"kind": "flag", "path": ["data", "nextFlag"], "end_values": [false]}, "board_version": {"kind": "token", "path": ["data", "v"]}, "max_duplicate_rows": 0}'::jsonb
    UNION ALL SELECT '{"completeness_mode": "exhausted", "list_path": ["data", "rows"], "row_key_path": ["traderUid"], "end_signal": {"kind": "short_page"}, "board_version": {"kind": "reported_total_drift", "path": ["data", "t"], "max_drift_bps": 101}, "max_duplicate_rows": 0}'::jsonb
    UNION ALL SELECT '{"completeness_mode": "exhausted", "list_path": ["data", "rows"], "row_key_path": ["traderUid"], "end_signal": {"kind": "short_page"}, "board_version": {"kind": "first_page_reread"}, "max_duplicate_rows": 0, "extra": 1}'::jsonb
  ) AS candidate(declaration);
SQL
assert_equal "the legacy grid exercises holding and refused blocks" "t" "$(psql_db postgres -Atqc "
  SELECT bool_or(before) AND bool_or(NOT before) AND count(*) > 5000 FROM public.legacy_grid")"
psql_db postgres -Atqc "SELECT count(*) FILTER (WHERE before), count(*) FROM public.legacy_grid" |
  sed 's/^/  legacy grid holding|total: /'

for db in main readaptered no_page_size earlier no_bypassrls drifted_body; do
  clone_db postgres "$db"
done

# ── Migration ──

psql_db main -q -f "$TARGET"
echo "ok: migration applies as a non-superuser"
assert_equal "bitget_cfd and bitget_spot are registered beside the fixtures" \
  "binance_futures,binance_web3_bsc,bitget_cfd,bitget_futures,bitget_spot" "$(contract_rows main)"
EXPECTED="$(cd "$ROOT_DIR" && npx --no-install tsx -e '
import { BITGET_CFD_LEADERBOARD_EXHAUSTION, BITGET_SPOT_LEADERBOARD_EXHAUSTION } from "./lib/ingest/adapters/bitget"
console.log(JSON.stringify({ cfd: BITGET_CFD_LEADERBOARD_EXHAUSTION, spot: BITGET_SPOT_LEADERBOARD_EXHAUSTION }))
')"
assert_equal "registrations equal the adapter declarations" "t|t" "$(
  psql_db main -Atq -v expected="$EXPECTED" <<'SQL'
SELECT pg_catalog.bool_and(contract.declaration = (:'expected'::jsonb)->'cfd')
         FILTER (WHERE source_row.slug = 'bitget_cfd'),
       pg_catalog.bool_and(contract.declaration = (:'expected'::jsonb)->'spot')
         FILTER (WHERE source_row.slug = 'bitget_spot')
  FROM arena.leaderboard_exhaustion_contracts AS contract
  JOIN arena.sources AS source_row ON source_row.id = contract.source_id
SQL
)"
assert_equal "the seed table does not outlive the applying session" "0" "$(psql_db main -Atqc "
  SELECT pg_catalog.count(*) FROM pg_catalog.pg_class WHERE relname = 'bitget_cfd_one_row_seed'")"
assert_equal "the replaced functions keep their owner" "postgres|postgres" "$(psql_db main -Atqc "
  SELECT pg_catalog.string_agg(pg_catalog.pg_get_userbyid(proowner)::text, '|' ORDER BY proname)
    FROM pg_catalog.pg_proc
   WHERE proname IN ('leaderboard_exhaustion_completeness_holds',
                     'leaderboard_exhaustion_declaration_valid')")"
assert_equal "the replaced functions keep their grants" "false|false" "$(psql_db main -Atqc "
  SELECT pg_catalog.has_function_privilege('service_role',
           'arena.leaderboard_exhaustion_completeness_holds(smallint,jsonb,text,integer,text,integer,integer,integer,integer)',
           'EXECUTE')
         || '|' ||
         pg_catalog.has_function_privilege('anon',
           'arena.leaderboard_exhaustion_declaration_valid(jsonb)', 'EXECUTE')")"

# ── Every other declaration: unchanged ──

assert_equal "every legacy grid block is judged as before" "0" "$(psql_db main -Atqc "
  SELECT pg_catalog.count(*) FROM public.legacy_grid
   WHERE before IS DISTINCT FROM public.board_holds(
     source_slug, termination, full_pages, last_rows, distinct_rows, total_min, total_max,
     total_last, accepted, deduplicated, NULL, reread_ok, tokens_equal)")"
assert_equal "every legacy declaration is valid or not as before" "0" "$(psql_db main -Atqc "
  SELECT pg_catalog.count(*) FROM public.legacy_declarations
   WHERE before IS DISTINCT FROM arena.leaderboard_exhaustion_declaration_valid(declaration)")"
assert_equal "identity_merge evidence in a bitget_spot block is refused" "f" "$(psql_db main -Atqc "
  SELECT public.board_holds('bitget_spot', 'short_page', 180, 14, 5414, 5414, 5414, 5414,
                            5414, 0, '{\"identities\": 5414, \"merged_rows\": 0}')")"
assert_equal "the same bitget_spot block without it holds" "t" "$(psql_db main -Atqc "
  SELECT public.board_holds('bitget_spot', 'short_page', 180, 14, 5414, 5414, 5414, 5414,
                            5414, 0, NULL)")"

# ── bitget_cfd: one ranked row per trader ──

cfd() {
  # cfd <termination> <full pages> <last rows> <distinct> <total min> <max> <last>
  #     <accepted> <deduplicated> <identities> <merged>
  local merge="NULL"
  if [[ "${10}" != "-" ]]; then
    merge="'{\"identities\": ${10}, \"merged_rows\": ${11}}'"
  fi
  psql_db main -Atqc "SELECT public.board_holds('bitget_cfd', '$1', $2, $3, $4, $5, $6, $7, $8, $9, $merge)"
}

# Measured 2026-11-27: 191 = 6x30+11, 220 = 7x30+10, 224 = 7x30+14.
assert_equal "7D: 191 portfolios of 188 traders hold" "t" "$(cfd short_page 6 11 191 191 191 191 188 3 188 3)"
assert_equal "30D: 220 portfolios of 218 traders hold" "t" "$(cfd short_page 7 10 220 220 220 220 218 2 218 2)"
assert_equal "90D: 224 portfolios of 222 traders hold" "t" "$(cfd short_page 7 14 224 224 224 224 222 2 222 2)"
assert_equal "a board ending on an empty page holds" "t" "$(cfd empty_page 7 0 210 210 210 210 207 3 207 3)"
assert_equal "one trader per portfolio (nothing merged) holds" "t" "$(cfd short_page 6 11 191 191 191 191 191 0 191 0)"

assert_equal "a portfolio read twice does not hold" "f" "$(cfd short_page 6 11 190 191 191 191 187 4 187 3)"
assert_equal "a portfolio read twice does not hold even when the board total matches" "f" \
  "$(cfd short_page 6 11 190 190 190 190 188 3 188 2)"
assert_equal "fewer portfolios than the last total do not hold" "f" "$(cfd short_page 6 11 191 192 192 192 188 3 188 3)"
assert_equal "more portfolios than the last total do not hold" "f" "$(cfd short_page 6 11 191 190 190 190 188 3 188 3)"
# max_drift_bps 60: the total may move by floor(last x 0.6%) = 1 at 191, 220 and 224.
assert_equal "90D: a total that moved by one (224-225) holds" "t" "$(cfd short_page 7 14 224 224 225 224 222 2 222 2)"
assert_equal "90D: a total that moved by one, with one portfolio read twice, does not hold" "f" \
  "$(cfd short_page 7 14 223 224 225 224 221 3 221 2)"
assert_equal "90D: a total that moved by two does not hold" "f" "$(cfd short_page 7 14 224 223 225 224 222 2 222 2)"
assert_equal "90D: one portfolio short of the last total does not hold" "f" "$(cfd short_page 7 14 224 225 225 225 222 2 222 2)"
assert_equal "7D: a total that moved by one (191-192, back to 191) holds" "t" "$(cfd short_page 6 11 191 191 192 191 188 3 188 3)"
assert_equal "7D: a total that moved 191 -> 192, 192 portfolios read, holds" "t" "$(cfd short_page 6 12 192 191 192 192 189 3 189 3)"
assert_equal "7D: a total that moved by two (191-193) does not hold" "f" "$(cfd short_page 6 11 191 191 193 191 188 3 188 3)"
assert_equal "7D: a total that moved by one, with one portfolio read twice, does not hold" "f" \
  "$(cfd short_page 6 11 190 191 192 191 187 4 187 3)"
assert_equal "30D: a total that moved by one (220-221) holds" "t" "$(cfd short_page 7 10 220 220 221 220 218 2 218 2)"
assert_equal "30D: a total that moved by two does not hold" "f" "$(cfd short_page 7 10 220 219 221 220 218 2 218 2)"
assert_equal "identities other than the accepted rows do not hold" "f" "$(cfd short_page 6 11 191 191 191 191 189 3 188 3)"
assert_equal "merged rows other than distinct - identities do not hold" "f" "$(cfd short_page 6 11 191 191 191 191 188 2 188 2)"
assert_equal "deduplicated rows other than the merged rows do not hold" "f" "$(cfd short_page 6 11 191 191 191 191 188 4 188 3)"
assert_equal "more identities than portfolios do not hold" "f" "$(cfd short_page 6 11 191 191 191 191 192 0 192 0)"
assert_equal "no accepted row does not hold" "f" "$(cfd short_page 6 11 191 191 191 191 0 191 0 191)"
assert_equal "a block without identity_merge does not hold" "f" "$(cfd short_page 6 11 191 191 191 191 188 3 - -)"
assert_equal "a block without identity_merge, counted per portfolio, does not hold" "f" \
  "$(cfd short_page 6 11 191 191 191 191 191 0 - -)"
assert_equal "a capture cut at the reported total does not hold" "f" \
  "$(cfd reported_population_reached 6 11 191 191 191 191 188 3 188 3)"
assert_equal "a silently emptied page mid-board does not hold" "f" "$(cfd empty_page 3 0 90 191 191 191 88 2 88 2)"
assert_equal "malformed merge evidence does not hold" "f" "$(psql_db main -Atqc "
  SELECT public.board_holds('bitget_cfd', 'short_page', 6, 11, 191, 191, 191, 191, 188, 3,
                            '{\"identities\": 188, \"merged_rows\": 3, \"extra\": 0}')
      OR public.board_holds('bitget_cfd', 'short_page', 6, 11, 191, 191, 191, 191, 188, 3,
                            '{\"identities\": \"188\", \"merged_rows\": 3}')")"

# ── identity_merge declaration validity ──

valid() {
  psql_db main -Atqc "SELECT arena.leaderboard_exhaustion_declaration_valid('$1'::jsonb)"
}
CFD_DECL='{"completeness_mode": "exhausted", "list_path": ["data", "rows"], "row_key_path": ["portfolioId"], "end_signal": {"kind": "short_page"}, "board_version": {"kind": "reported_total_drift", "path": ["data", "maxShowSizes"], "max_drift_bps": 60}, "max_duplicate_rows": 0, "identity_merge": {"kind": "best_rank", "identity_path": ["traderUid"]}}'
assert_equal "the cfd declaration is valid" "t" "$(valid "$CFD_DECL")"
assert_equal "identity_merge with a duplicate allowance is not valid" "f" \
  "$(valid "${CFD_DECL/\"max_duplicate_rows\": 0/\"max_duplicate_rows\": 1}")"
assert_equal "identity_merge without a drift allowance is still valid" "t" \
  "$(valid "${CFD_DECL/\"max_drift_bps\": 60/\"max_drift_bps\": 0}")"
assert_equal "identity_merge above 1% drift is not valid" "f" \
  "$(valid "${CFD_DECL/\"max_drift_bps\": 60/\"max_drift_bps\": 101}")"
assert_equal "identity_merge without reported_total_drift is not valid" "f" \
  "$(valid '{"completeness_mode": "exhausted", "list_path": ["data", "rows"], "row_key_path": ["portfolioId"], "end_signal": {"kind": "short_page"}, "board_version": {"kind": "first_page_reread"}, "max_duplicate_rows": 0, "identity_merge": {"kind": "best_rank", "identity_path": ["traderUid"]}}')"
assert_equal "identity_merge of another kind is not valid" "f" \
  "$(valid "${CFD_DECL/best_rank/first_row}")"
assert_equal "identity_merge with an extra key is not valid" "f" \
  "$(valid "${CFD_DECL/\"kind\": \"best_rank\"/\"kind\": \"best_rank\", \"extra\": 1}")"
assert_equal "identity_merge with an invalid path is not valid" "f" \
  "$(valid '{"completeness_mode": "exhausted", "list_path": ["data", "rows"], "row_key_path": ["portfolioId"], "end_signal": {"kind": "short_page"}, "board_version": {"kind": "reported_total_drift", "path": ["data", "maxShowSizes"], "max_drift_bps": 0}, "max_duplicate_rows": 0, "identity_merge": {"kind": "best_rank", "identity_path": []}}')"

# ── Refusals ──

expect_failure main "migration replay" "already exists for: bitget_cfd"

psql_db readaptered -q -c "UPDATE arena.sources SET adapter_slug = 'bitget_v2' WHERE slug = 'bitget_cfd'"
expect_failure readaptered "migration for a re-adaptered source" "source drift: bitget_cfd"

psql_db no_page_size -q -c "UPDATE arena.sources SET page_size = NULL WHERE slug = 'bitget_cfd'"
expect_failure no_page_size "migration for a source without page_size" "source drift: bitget_cfd"

psql_db earlier -q -c "
  INSERT INTO arena.leaderboard_exhaustion_contracts (source_id, completeness_contract, declaration)
  SELECT id, 'arena.ingest.leaderboard-exhaustion-completeness@1',
         '{\"completeness_mode\": \"exhausted\", \"list_path\": [\"data\", \"rows\"], \"row_key_path\": [\"traderUid\"], \"end_signal\": {\"kind\": \"short_page\"}, \"board_version\": {\"kind\": \"first_page_reread\"}, \"max_duplicate_rows\": 0}'
    FROM arena.sources WHERE slug = 'bitget_cfd'"
expect_failure earlier "migration over an earlier bitget_cfd contract" \
  "already exists for: bitget_cfd"

psql_db drifted_body -q <<'SQL'
CREATE OR REPLACE FUNCTION arena.leaderboard_exhaustion_declaration_valid(p_declaration jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $function$ SELECT true $function$;
SQL
expect_failure drifted_body "migration over a replaced function body" \
  "requires the reported_total_drift proof (20261118114230)"

# The registry forces row-level security and has no write policy.
psql_admin -qc "ALTER ROLE postgres NOBYPASSRLS;"
if psql_db no_bypassrls -q -f "$TARGET" >"$ERROR_FILE" 2>&1; then
  psql_admin -qc "ALTER ROLE postgres BYPASSRLS;"
  echo "FAIL: migration without BYPASSRLS unexpectedly succeeded" >&2
  exit 1
fi
psql_admin -qc "ALTER ROLE postgres BYPASSRLS;"
if [[ "$(<"$ERROR_FILE")" != *'row-level security policy for table "leaderboard_exhaustion_contracts"'* ]]; then
  echo "FAIL: migration without BYPASSRLS failed for the wrong reason" >&2
  cat "$ERROR_FILE" >&2
  exit 1
fi
echo "ok: migration without BYPASSRLS refused"
assert_equal "migration without BYPASSRLS writes nothing (functions unchanged too)" "t" "$(psql_db no_bypassrls -Atqc "
  SELECT NOT arena.leaderboard_exhaustion_declaration_valid('$CFD_DECL'::jsonb)
     AND NOT EXISTS (
       SELECT 1 FROM arena.leaderboard_exhaustion_contracts AS contract
         JOIN arena.sources AS source_row ON source_row.id = contract.source_id
        WHERE source_row.slug = 'bitget_cfd')")"

echo "bitget_cfd one-row-per-trader PG17 proof passed"
