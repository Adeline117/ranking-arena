#!/usr/bin/env bash

# Executable PostgreSQL 17 regression proof for NULL-preserving score inputs.
# It owns an isolated temporary cluster and never connects to an application DB.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OLD_MIGRATION="$ROOT_DIR/supabase/migrations/20260709201917_score_inputs_first_party_branch.sql"
NEW_MIGRATION="$ROOT_DIR/supabase/migrations/20260716123000_null_preserving_score_inputs.sql"
RPC_MIGRATION="$ROOT_DIR/supabase/migrations/20260612211910_arena_score_inputs_json.sql"
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
for migration in "$OLD_MIGRATION" "$NEW_MIGRATION" "$RPC_MIGRATION"; do
  if [[ ! -f "$migration" ]]; then
    echo "Required migration not found: $migration" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/null-preserving-score-inputs-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((56000 + ($$ % 3000)))}"
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

-- This is the smallest schema that exercises every relation and column read
-- by the production score_inputs view. Constraints unrelated to the view are
-- deliberately omitted so this proof remains focused on its data contract.
CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text NOT NULL,
  product_type text NOT NULL,
  currency text NOT NULL,
  serving_mode text NOT NULL,
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
  id, slug, product_type, currency, serving_mode, meta
) VALUES (
  1, 'test_dex', 'onchain', 'USDC', 'serving', '{}'::jsonb
);

INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, scraped_at, count_check_passed
) VALUES (
  10, 1, 90, pg_catalog.now() - interval '1 hour', true
);

INSERT INTO arena.traders (
  id, source_id, exchange_trader_id, nickname, trader_kind, meta
) VALUES
  (1, 1, 'board-null',       'Board NULL',       'human', '{}'::jsonb),
  (2, 1, 'board-zero',       'Board Zero',       'human', '{}'::jsonb),
  (3, 1, 'board-clamp',      'Board Clamp',      'human', '{}'::jsonb),
  (4, 1, 'first-party-null', 'First-party NULL', 'human', '{"claimed":"true"}'::jsonb),
  (5, 1, 'first-party-zero', 'First-party Zero', 'human', '{"claimed":"true"}'::jsonb),
  (6, 1, 'first-party-clamp','First-party Clamp','human', '{"claimed":"true"}'::jsonb);

INSERT INTO arena.leaderboard_entries (
  snapshot_id, trader_id, rank, headline_roi, headline_pnl, headline_win_rate
) VALUES
  (10, 1, 1, NULL,  NULL, NULL),
  (10, 2, 2, 0,     0,    0),
  (10, 3, 3, 20000, 20, 150),
  -- These headline values must be ignored by the fresh first-party branch.
  (10, 4, 4, 321,   40,  88),
  (10, 5, 5, 321,   50,  88),
  (10, 6, 6, 321,   60,  88);

INSERT INTO arena.trader_stats (
  trader_id, timeframe, as_of, roi, pnl, win_rate, mdd,
  copier_count, total_positions, sharpe, extras
) VALUES
  (1, 90, pg_catalog.now() - interval '1 hour', NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, '{}'::jsonb),
  (2, 90, pg_catalog.now() - interval '1 hour', 0, 0, 0, 0,
   0, 0, 0, '{}'::jsonb),
  (3, 90, pg_catalog.now() - interval '1 hour', NULL, 20, NULL, -150,
   3, 30, 1.5, '{}'::jsonb),
  (4, 90, pg_catalog.now() - interval '1 hour', NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, '{"provenance":"first_party"}'::jsonb),
  (5, 90, pg_catalog.now() - interval '1 hour', 0, 0, 0, 0,
   0, 0, 0, '{"provenance":"first_party"}'::jsonb),
  (6, 90, pg_catalog.now() - interval '1 hour', -20000, -60, -5, -150,
   6, 60, -1.5, '{"provenance":"first_party"}'::jsonb);
SQL

# Establish the exact historical implementation first. This is not just a
# fixture expectation: it proves PostgreSQL 17 turns NULL into real-looking
# extrema because LEAST/GREATEST ignore NULL arguments.
psql_cmd -f "$OLD_MIGRATION" >/dev/null
psql_cmd -f "$RPC_MIGRATION" >/dev/null
psql_cmd <<'SQL'
GRANT SELECT ON arena.score_inputs TO anon, authenticated;
SQL

psql_cmd <<'SQL'
DO $old_bug_proof$
DECLARE
  v_board arena.score_inputs%ROWTYPE;
  v_first_party arena.score_inputs%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_board
  FROM arena.score_inputs
  WHERE trader_key = 'board-null';

  SELECT * INTO STRICT v_first_party
  FROM arena.score_inputs
  WHERE trader_key = 'first-party-null';

  IF v_board.roi_pct <> -10000
     OR v_board.win_rate <> 0
     OR v_board.max_drawdown <> 100 THEN
    RAISE EXCEPTION 'old board branch no longer reproduces NULL sentinels: %',
      pg_catalog.row_to_json(v_board);
  END IF;

  IF v_first_party.roi_pct <> -10000
     OR v_first_party.win_rate <> 0
     OR v_first_party.max_drawdown <> 100 THEN
    RAISE EXCEPTION 'old first-party branch no longer reproduces NULL sentinels: %',
      pg_catalog.row_to_json(v_first_party);
  END IF;

  IF (SELECT pg_catalog.count(*) FROM arena.score_inputs) <> 6 THEN
    RAISE EXCEPTION 'old score_inputs fixture did not produce exactly six rows';
  END IF;
END
$old_bug_proof$;
SQL

ROW_COUNT_BEFORE="$(psql_cmd -Atqc 'SELECT pg_catalog.count(*) FROM arena.score_inputs')"
VIEW_OID_BEFORE="$(psql_cmd -Atqc "SELECT 'arena.score_inputs'::pg_catalog.regclass::pg_catalog.oid")"
VIEW_ACL_BEFORE="$(psql_cmd -Atqc "SELECT relacl::text FROM pg_catalog.pg_class WHERE oid = 'arena.score_inputs'::pg_catalog.regclass")"
psql_cmd -f "$NEW_MIGRATION" >/dev/null
# The migration is intentionally repeatable: CREATE OR REPLACE must retain the
# serving object instead of replacing it with a new OID or privilege boundary.
psql_cmd -f "$NEW_MIGRATION" >/dev/null
ROW_COUNT_AFTER="$(psql_cmd -Atqc 'SELECT pg_catalog.count(*) FROM arena.score_inputs')"
VIEW_OID_AFTER="$(psql_cmd -Atqc "SELECT 'arena.score_inputs'::pg_catalog.regclass::pg_catalog.oid")"
VIEW_ACL_AFTER="$(psql_cmd -Atqc "SELECT relacl::text FROM pg_catalog.pg_class WHERE oid = 'arena.score_inputs'::pg_catalog.regclass")"

if [[ "$ROW_COUNT_BEFORE" != "$ROW_COUNT_AFTER" || "$ROW_COUNT_AFTER" != "6" ]]; then
  echo "score_inputs row count changed across migration: $ROW_COUNT_BEFORE -> $ROW_COUNT_AFTER" >&2
  exit 1
fi
if [[ "$VIEW_OID_BEFORE" != "$VIEW_OID_AFTER" ]]; then
  echo "score_inputs OID changed across CREATE OR REPLACE: $VIEW_OID_BEFORE -> $VIEW_OID_AFTER" >&2
  exit 1
fi
if [[ "$VIEW_ACL_BEFORE" != "$VIEW_ACL_AFTER" ]]; then
  echo "score_inputs ACL changed across migration: $VIEW_ACL_BEFORE -> $VIEW_ACL_AFTER" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $fixed_contract_proof$
DECLARE
  v_row arena.score_inputs%ROWTYPE;
  v_payload jsonb;
  v_json_row jsonb;
BEGIN
  IF (
    SELECT pg_catalog.array_agg(
      attribute.attname || ':' || pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
      ORDER BY attribute.attnum
    )
    FROM pg_catalog.pg_attribute attribute
    WHERE attribute.attrelid = 'arena.score_inputs'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) IS DISTINCT FROM ARRAY[
    'platform:text', 'market_type:text', 'trader_key:text', 'window:text',
    'board_rank:integer', 'roi_pct:numeric', 'pnl_usd:numeric', 'win_rate:numeric',
    'max_drawdown:numeric', 'copiers:integer', 'trades_count:integer',
    'sharpe_ratio:numeric', 'sortino_ratio:numeric', 'calmar_ratio:numeric',
    'volatility_pct:numeric', 'trader_kind:text', 'handle:text', 'avatar_url:text',
    'currency:text', 'as_of:timestamp with time zone'
  ]::text[] THEN
    RAISE EXCEPTION 'score_inputs 20-column order/type contract changed';
  END IF;

  -- Both branches must preserve unknown metrics as SQL NULL.
  FOR v_row IN
    SELECT *
    FROM arena.score_inputs
    WHERE trader_key IN ('board-null', 'first-party-null')
  LOOP
    IF v_row.roi_pct IS NOT NULL
       OR v_row.win_rate IS NOT NULL
       OR v_row.max_drawdown IS NOT NULL THEN
      RAISE EXCEPTION 'unknown metrics became values for %: %',
        v_row.trader_key, pg_catalog.row_to_json(v_row);
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM arena.score_inputs
    WHERE trader_key IN ('board-null', 'first-party-null')
      AND roi_pct IS NULL
      AND win_rate IS NULL
      AND max_drawdown IS NULL
  ) <> 2 THEN
    RAISE EXCEPTION 'NULL preservation did not cover both score-input branches';
  END IF;

  -- Legitimate zero is data, not missingness, and must survive in each branch.
  IF (
    SELECT pg_catalog.count(*)
    FROM arena.score_inputs
    WHERE trader_key IN ('board-zero', 'first-party-zero')
      AND roi_pct = 0
      AND win_rate = 0
      AND max_drawdown = 0
  ) <> 2 THEN
    RAISE EXCEPTION 'legitimate zero metrics were not preserved in both branches';
  END IF;

  -- Non-NULL anomalies remain bounded at both ROI/win-rate edges and at MDD.
  SELECT * INTO STRICT v_row
  FROM arena.score_inputs
  WHERE trader_key = 'board-clamp';
  IF v_row.roi_pct <> 10000
     OR v_row.win_rate <> 100
     OR v_row.max_drawdown <> 100 THEN
    RAISE EXCEPTION 'board anomaly clamps changed: %', pg_catalog.row_to_json(v_row);
  END IF;

  SELECT * INTO STRICT v_row
  FROM arena.score_inputs
  WHERE trader_key = 'first-party-clamp';
  IF v_row.roi_pct <> -10000
     OR v_row.win_rate <> 0
     OR v_row.max_drawdown <> 100 THEN
    RAISE EXCEPTION 'first-party anomaly clamps changed: %',
      pg_catalog.row_to_json(v_row);
  END IF;

  -- The one-row JSON RPC is the production consumer. JSON null (not a string,
  -- an omitted key, or a numeric sentinel) is the public downstream contract.
  v_payload := public.arena_score_inputs_json('90D', 1000, 48);
  IF pg_catalog.jsonb_array_length(v_payload) <> 6 THEN
    RAISE EXCEPTION 'score-input JSON RPC returned the wrong row count: %', v_payload;
  END IF;

  SELECT payload_row INTO STRICT v_json_row
  FROM pg_catalog.jsonb_array_elements(v_payload) AS payload_row
  WHERE payload_row->>'trader_key' = 'board-null';

  IF NOT (v_json_row ? 'roi_pct')
     OR NOT (v_json_row ? 'win_rate')
     OR NOT (v_json_row ? 'max_drawdown')
     OR v_json_row->'roi_pct' <> 'null'::jsonb
     OR v_json_row->'win_rate' <> 'null'::jsonb
     OR v_json_row->'max_drawdown' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'board NULLs did not cross the JSON RPC as JSON null: %', v_json_row;
  END IF;

  SELECT payload_row INTO STRICT v_json_row
  FROM pg_catalog.jsonb_array_elements(v_payload) AS payload_row
  WHERE payload_row->>'trader_key' = 'first-party-null';

  IF v_json_row->'roi_pct' <> 'null'::jsonb
     OR v_json_row->'win_rate' <> 'null'::jsonb
     OR v_json_row->'max_drawdown' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'first-party NULLs did not cross the JSON RPC as JSON null: %',
      v_json_row;
  END IF;
END
$fixed_contract_proof$;
SQL

echo "PostgreSQL 17 NULL-preserving score-input proof passed"
