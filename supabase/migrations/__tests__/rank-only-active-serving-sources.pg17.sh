#!/usr/bin/env bash

# Executable PostgreSQL 17 proof that only active serving sources can enter
# score inputs. It owns an isolated cluster and never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TABLE_RPC_MIGRATION="$ROOT_DIR/supabase/migrations/20260612135918_arena_score_inputs_rpc.sql"
JSON_RPC_MIGRATION="$ROOT_DIR/supabase/migrations/20260612211910_arena_score_inputs_json.sql"
FIRST_PARTY_MIGRATION="$ROOT_DIR/supabase/migrations/20260709201917_score_inputs_first_party_branch.sql"
NULL_MIGRATION="$ROOT_DIR/supabase/migrations/20260716123000_null_preserving_score_inputs.sql"
SERVING_MIGRATION="$ROOT_DIR/supabase/migrations/20260716124500_rank_only_active_serving_sources.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi
for migration in \
  "$TABLE_RPC_MIGRATION" \
  "$JSON_RPC_MIGRATION" \
  "$FIRST_PARTY_MIGRATION" \
  "$NULL_MIGRATION" \
  "$SERVING_MIGRATION"; do
  if [[ ! -f "$migration" ]]; then
    echo "Required migration not found: $migration" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/rank-active-serving-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((52000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -180 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

assert_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "$label changed: $expected -> $actual" >&2
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

psql_cmd <<'SQL'
CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE SCHEMA arena;
GRANT USAGE ON SCHEMA public, arena TO anon, authenticated, service_role;

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text NOT NULL,
  product_type text NOT NULL,
  currency text NOT NULL,
  serving_mode text NOT NULL,
  status text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL,
  timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL,
  count_check_passed boolean NOT NULL
);

CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL,
  exchange_trader_id text NOT NULL,
  nickname text,
  avatar_url_origin text,
  avatar_url_mirror text,
  trader_kind text NOT NULL DEFAULT 'human',
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE arena.leaderboard_entries (
  snapshot_id bigint NOT NULL,
  trader_id bigint NOT NULL,
  rank integer NOT NULL,
  headline_roi numeric,
  headline_pnl numeric,
  headline_win_rate numeric
);

CREATE TABLE arena.trader_stats (
  trader_id bigint NOT NULL,
  timeframe smallint NOT NULL,
  as_of timestamptz NOT NULL,
  roi numeric,
  pnl numeric,
  win_rate numeric,
  mdd numeric,
  copier_count integer,
  total_positions integer,
  sharpe numeric,
  extras jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (trader_id, timeframe)
);

INSERT INTO arena.sources (
  id, slug, product_type, currency, serving_mode, status, meta
) VALUES
  (1, 'active_serving',  'onchain', 'USDC', 'serving', 'active',   '{}'::jsonb),
  (2, 'active_shadow',   'onchain', 'USDC', 'shadow',  'active',   '{}'::jsonb),
  (3, 'inactive_serving','onchain', 'USDC', 'serving', 'inactive', '{}'::jsonb),
  (4, 'active_legacy',   'onchain', 'USDC', 'legacy',  'active',   '{}'::jsonb);

INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, scraped_at, count_check_passed
) VALUES
  (11, 1, 90, pg_catalog.now() - interval '1 hour', true),
  (12, 2, 90, pg_catalog.now() - interval '1 hour', true),
  (13, 3, 90, pg_catalog.now() - interval '1 hour', true),
  (14, 4, 90, pg_catalog.now() - interval '1 hour', true);

-- Every lifecycle state has a board member. The serving source also has a
-- fresh first-party member so both admitted branches retain their NULL rules;
-- shadow and inactive get first-party rows to prove that path cannot bypass.
INSERT INTO arena.traders (
  id, source_id, exchange_trader_id, nickname, trader_kind, meta
) VALUES
  (101, 1, 'active-board-null',           'Active board',    'human', '{}'::jsonb),
  (102, 2, 'shadow-board',                'Shadow board',    'human', '{}'::jsonb),
  (103, 3, 'inactive-board',              'Inactive board',  'human', '{}'::jsonb),
  (104, 4, 'legacy-board',                'Legacy board',    'human', '{}'::jsonb),
  (201, 1, 'active-first-party-null',     'Active owner',    'human', '{"claimed":"true"}'::jsonb),
  (202, 2, 'shadow-first-party-null',     'Shadow owner',    'human', '{"claimed":"true"}'::jsonb),
  (203, 3, 'inactive-first-party-null',   'Inactive owner',  'human', '{"claimed":"true"}'::jsonb);

INSERT INTO arena.leaderboard_entries (
  snapshot_id, trader_id, rank, headline_roi, headline_pnl, headline_win_rate
) VALUES
  (11, 101, 1, NULL, NULL, NULL),
  (12, 102, 1, 22, 2200, 62),
  (13, 103, 1, 33, 3300, 63),
  (14, 104, 1, 44, 4400, 64);

INSERT INTO arena.trader_stats (
  trader_id, timeframe, as_of, roi, pnl, win_rate, mdd,
  copier_count, total_positions, sharpe, extras
) VALUES
  (101, 90, pg_catalog.now() - interval '1 hour', NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, '{}'::jsonb),
  (102, 90, pg_catalog.now() - interval '1 hour', 22, 2200, 62, 12,
   2, 20, 1.2, '{}'::jsonb),
  (103, 90, pg_catalog.now() - interval '1 hour', 33, 3300, 63, 13,
   3, 30, 1.3, '{}'::jsonb),
  (104, 90, pg_catalog.now() - interval '1 hour', 44, 4400, 64, 14,
   4, 40, 1.4, '{}'::jsonb),
  (201, 90, pg_catalog.now() - interval '1 hour', NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, '{"provenance":"first_party"}'::jsonb),
  (202, 90, pg_catalog.now() - interval '1 hour', NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, '{"provenance":"first_party"}'::jsonb),
  (203, 90, pg_catalog.now() - interval '1 hour', NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, '{"provenance":"first_party"}'::jsonb);
SQL

# Install both production RPCs before advancing the view through its current
# first-party and NULL-preserving definitions. The functions depend on the
# stable view OID and always read its latest CREATE OR REPLACE definition.
psql_cmd -f "$TABLE_RPC_MIGRATION" >/dev/null
psql_cmd -f "$JSON_RPC_MIGRATION" >/dev/null
psql_cmd -f "$FIRST_PARTY_MIGRATION" >/dev/null
psql_cmd -f "$NULL_MIGRATION" >/dev/null

# A noncanonical extra view grant makes ACL preservation observable rather
# than merely checking that service_role happens to remain present.
psql_cmd <<'SQL'
GRANT SELECT ON arena.score_inputs TO anon, authenticated;

DO $old_boundary_proof$
DECLARE
  v_keys text[];
  v_payload jsonb;
BEGIN
  SELECT pg_catalog.array_agg(trader_key ORDER BY trader_key)
    INTO v_keys
    FROM arena.score_inputs;
  IF v_keys IS DISTINCT FROM ARRAY[
    'active-board-null', 'active-first-party-null',
    'inactive-board', 'inactive-first-party-null',
    'shadow-board', 'shadow-first-party-null'
  ]::text[] THEN
    RAISE EXCEPTION 'pre-migration view did not reproduce lifecycle leakage: %', v_keys;
  END IF;

  SELECT pg_catalog.array_agg(trader_key ORDER BY trader_key)
    INTO v_keys
    FROM public.arena_score_inputs('90D', 1000, 48);
  IF pg_catalog.array_length(v_keys, 1) <> 6 THEN
    RAISE EXCEPTION 'pre-migration table RPC did not expose all six eligible rows: %', v_keys;
  END IF;

  v_payload := public.arena_score_inputs_json('90D', 1000, 48);
  IF pg_catalog.jsonb_array_length(v_payload) <> 6 THEN
    RAISE EXCEPTION 'pre-migration JSON RPC did not expose all six eligible rows: %', v_payload;
  END IF;

  IF EXISTS (
    SELECT 1 FROM arena.score_inputs WHERE trader_key = 'legacy-board'
  ) THEN
    RAISE EXCEPTION 'legacy board fixture unexpectedly entered the canonical old view';
  END IF;
END
$old_boundary_proof$;
SQL

VIEW_OID_BEFORE="$(psql_cmd -Atqc "SELECT 'arena.score_inputs'::pg_catalog.regclass::pg_catalog.oid")"
VIEW_ACL_BEFORE="$(psql_cmd -Atqc "SELECT relacl::text FROM pg_catalog.pg_class WHERE oid = 'arena.score_inputs'::pg_catalog.regclass")"
VIEW_COLUMNS_BEFORE="$(psql_cmd -Atqc "SELECT pg_catalog.string_agg(attribute.attname || ':' || pg_catalog.format_type(attribute.atttypid, attribute.atttypmod), '|' ORDER BY attribute.attnum) FROM pg_catalog.pg_attribute attribute WHERE attribute.attrelid = 'arena.score_inputs'::regclass AND attribute.attnum > 0 AND NOT attribute.attisdropped")"
TABLE_RPC_OID_BEFORE="$(psql_cmd -Atqc "SELECT 'public.arena_score_inputs(text,integer,integer)'::pg_catalog.regprocedure::pg_catalog.oid")"
TABLE_RPC_ACL_BEFORE="$(psql_cmd -Atqc "SELECT proacl::text FROM pg_catalog.pg_proc WHERE oid = 'public.arena_score_inputs(text,integer,integer)'::pg_catalog.regprocedure")"
JSON_RPC_OID_BEFORE="$(psql_cmd -Atqc "SELECT 'public.arena_score_inputs_json(text,integer,integer)'::pg_catalog.regprocedure::pg_catalog.oid")"
JSON_RPC_ACL_BEFORE="$(psql_cmd -Atqc "SELECT proacl::text FROM pg_catalog.pg_proc WHERE oid = 'public.arena_score_inputs_json(text,integer,integer)'::pg_catalog.regprocedure")"

psql_cmd -f "$SERVING_MIGRATION" >/dev/null

VIEW_OID_AFTER="$(psql_cmd -Atqc "SELECT 'arena.score_inputs'::pg_catalog.regclass::pg_catalog.oid")"
VIEW_ACL_AFTER="$(psql_cmd -Atqc "SELECT relacl::text FROM pg_catalog.pg_class WHERE oid = 'arena.score_inputs'::pg_catalog.regclass")"
VIEW_COLUMNS_AFTER="$(psql_cmd -Atqc "SELECT pg_catalog.string_agg(attribute.attname || ':' || pg_catalog.format_type(attribute.atttypid, attribute.atttypmod), '|' ORDER BY attribute.attnum) FROM pg_catalog.pg_attribute attribute WHERE attribute.attrelid = 'arena.score_inputs'::regclass AND attribute.attnum > 0 AND NOT attribute.attisdropped")"
TABLE_RPC_OID_AFTER="$(psql_cmd -Atqc "SELECT 'public.arena_score_inputs(text,integer,integer)'::pg_catalog.regprocedure::pg_catalog.oid")"
TABLE_RPC_ACL_AFTER="$(psql_cmd -Atqc "SELECT proacl::text FROM pg_catalog.pg_proc WHERE oid = 'public.arena_score_inputs(text,integer,integer)'::pg_catalog.regprocedure")"
JSON_RPC_OID_AFTER="$(psql_cmd -Atqc "SELECT 'public.arena_score_inputs_json(text,integer,integer)'::pg_catalog.regprocedure::pg_catalog.oid")"
JSON_RPC_ACL_AFTER="$(psql_cmd -Atqc "SELECT proacl::text FROM pg_catalog.pg_proc WHERE oid = 'public.arena_score_inputs_json(text,integer,integer)'::pg_catalog.regprocedure")"

assert_equal "score_inputs OID" "$VIEW_OID_BEFORE" "$VIEW_OID_AFTER"
assert_equal "score_inputs ACL" "$VIEW_ACL_BEFORE" "$VIEW_ACL_AFTER"
assert_equal "score_inputs columns" "$VIEW_COLUMNS_BEFORE" "$VIEW_COLUMNS_AFTER"
assert_equal "table RPC OID" "$TABLE_RPC_OID_BEFORE" "$TABLE_RPC_OID_AFTER"
assert_equal "table RPC ACL" "$TABLE_RPC_ACL_BEFORE" "$TABLE_RPC_ACL_AFTER"
assert_equal "JSON RPC OID" "$JSON_RPC_OID_BEFORE" "$JSON_RPC_OID_AFTER"
assert_equal "JSON RPC ACL" "$JSON_RPC_ACL_BEFORE" "$JSON_RPC_ACL_AFTER"

EXPECTED_COLUMNS='platform:text|market_type:text|trader_key:text|window:text|board_rank:integer|roi_pct:numeric|pnl_usd:numeric|win_rate:numeric|max_drawdown:numeric|copiers:integer|trades_count:integer|sharpe_ratio:numeric|sortino_ratio:numeric|calmar_ratio:numeric|volatility_pct:numeric|trader_kind:text|handle:text|avatar_url:text|currency:text|as_of:timestamp with time zone'
assert_equal "score_inputs 20-column contract" "$EXPECTED_COLUMNS" "$VIEW_COLUMNS_AFTER"

# Replay is a release requirement. Compare every serving object fingerprint
# again so an apparently idempotent result cannot silently replace an object.
psql_cmd -f "$SERVING_MIGRATION" >/dev/null

VIEW_OID_REPLAY="$(psql_cmd -Atqc "SELECT 'arena.score_inputs'::pg_catalog.regclass::pg_catalog.oid")"
VIEW_ACL_REPLAY="$(psql_cmd -Atqc "SELECT relacl::text FROM pg_catalog.pg_class WHERE oid = 'arena.score_inputs'::pg_catalog.regclass")"
VIEW_COLUMNS_REPLAY="$(psql_cmd -Atqc "SELECT pg_catalog.string_agg(attribute.attname || ':' || pg_catalog.format_type(attribute.atttypid, attribute.atttypmod), '|' ORDER BY attribute.attnum) FROM pg_catalog.pg_attribute attribute WHERE attribute.attrelid = 'arena.score_inputs'::regclass AND attribute.attnum > 0 AND NOT attribute.attisdropped")"
TABLE_RPC_OID_REPLAY="$(psql_cmd -Atqc "SELECT 'public.arena_score_inputs(text,integer,integer)'::pg_catalog.regprocedure::pg_catalog.oid")"
TABLE_RPC_ACL_REPLAY="$(psql_cmd -Atqc "SELECT proacl::text FROM pg_catalog.pg_proc WHERE oid = 'public.arena_score_inputs(text,integer,integer)'::pg_catalog.regprocedure")"
JSON_RPC_OID_REPLAY="$(psql_cmd -Atqc "SELECT 'public.arena_score_inputs_json(text,integer,integer)'::pg_catalog.regprocedure::pg_catalog.oid")"
JSON_RPC_ACL_REPLAY="$(psql_cmd -Atqc "SELECT proacl::text FROM pg_catalog.pg_proc WHERE oid = 'public.arena_score_inputs_json(text,integer,integer)'::pg_catalog.regprocedure")"

assert_equal "replayed score_inputs OID" "$VIEW_OID_AFTER" "$VIEW_OID_REPLAY"
assert_equal "replayed score_inputs ACL" "$VIEW_ACL_AFTER" "$VIEW_ACL_REPLAY"
assert_equal "replayed score_inputs columns" "$VIEW_COLUMNS_AFTER" "$VIEW_COLUMNS_REPLAY"
assert_equal "replayed table RPC OID" "$TABLE_RPC_OID_AFTER" "$TABLE_RPC_OID_REPLAY"
assert_equal "replayed table RPC ACL" "$TABLE_RPC_ACL_AFTER" "$TABLE_RPC_ACL_REPLAY"
assert_equal "replayed JSON RPC OID" "$JSON_RPC_OID_AFTER" "$JSON_RPC_OID_REPLAY"
assert_equal "replayed JSON RPC ACL" "$JSON_RPC_ACL_AFTER" "$JSON_RPC_ACL_REPLAY"

psql_cmd <<'SQL'
DO $serving_boundary_proof$
DECLARE
  v_keys text[];
  v_payload jsonb;
BEGIN
  SELECT pg_catalog.array_agg(trader_key ORDER BY trader_key)
    INTO v_keys
    FROM arena.score_inputs;
  IF v_keys IS DISTINCT FROM ARRAY[
    'active-board-null', 'active-first-party-null'
  ]::text[] THEN
    RAISE EXCEPTION 'view crossed the active-serving boundary: %', v_keys;
  END IF;

  IF (SELECT pg_catalog.count(DISTINCT platform) FROM arena.score_inputs) <> 1
     OR (SELECT pg_catalog.min(platform) FROM arena.score_inputs) <> 'active_serving' THEN
    RAISE EXCEPTION 'view admitted a non-active-serving platform';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM arena.score_inputs
    WHERE roi_pct IS NULL
      AND win_rate IS NULL
      AND max_drawdown IS NULL
  ) <> 2 THEN
    RAISE EXCEPTION 'NULL preservation no longer covers admitted board and first-party rows';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM arena.score_inputs
    WHERE (trader_key = 'active-board-null' AND board_rank = 1)
       OR (trader_key = 'active-first-party-null' AND board_rank IS NULL)
  ) <> 2 THEN
    RAISE EXCEPTION 'admitted rows no longer exercise both view branches';
  END IF;

  SELECT pg_catalog.array_agg(trader_key ORDER BY trader_key)
    INTO v_keys
    FROM public.arena_score_inputs('90D', 1000, 48)
   WHERE roi_pct IS NULL
     AND win_rate IS NULL
     AND max_drawdown IS NULL;
  IF v_keys IS DISTINCT FROM ARRAY[
    'active-board-null', 'active-first-party-null'
  ]::text[] THEN
    RAISE EXCEPTION 'table RPC crossed the active-serving or NULL boundary: %', v_keys;
  END IF;

  v_payload := public.arena_score_inputs_json('90D', 1000, 48);
  IF pg_catalog.jsonb_array_length(v_payload) <> 2 THEN
    RAISE EXCEPTION 'JSON RPC crossed the active-serving boundary: %', v_payload;
  END IF;

  SELECT pg_catalog.array_agg(payload_row->>'trader_key' ORDER BY payload_row->>'trader_key')
    INTO v_keys
    FROM pg_catalog.jsonb_array_elements(v_payload) AS payload_row;
  IF v_keys IS DISTINCT FROM ARRAY[
    'active-board-null', 'active-first-party-null'
  ]::text[] THEN
    RAISE EXCEPTION 'JSON RPC returned unexpected identities: %', v_keys;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(v_payload) AS payload_row
    WHERE NOT (payload_row ? 'roi_pct')
       OR NOT (payload_row ? 'win_rate')
       OR NOT (payload_row ? 'max_drawdown')
       OR payload_row->'roi_pct' <> 'null'::jsonb
       OR payload_row->'win_rate' <> 'null'::jsonb
       OR payload_row->'max_drawdown' <> 'null'::jsonb
  ) THEN
    RAISE EXCEPTION 'JSON RPC no longer exposes unknown metrics as JSON null: %', v_payload;
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role', 'public.arena_score_inputs(text,integer,integer)', 'EXECUTE'
     ) OR NOT pg_catalog.has_function_privilege(
       'service_role', 'public.arena_score_inputs_json(text,integer,integer)', 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'anon', 'public.arena_score_inputs(text,integer,integer)', 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'authenticated', 'public.arena_score_inputs_json(text,integer,integer)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'score-input RPC execute ACL changed';
  END IF;
END
$serving_boundary_proof$;
SQL

echo "PostgreSQL 17 active-serving score-input proof passed"
