#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for score fallback freshness. It owns an
# isolated temporary cluster and never connects to an application database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TABLE_RPC_MIGRATION="$ROOT_DIR/supabase/migrations/20260612135918_arena_score_inputs_rpc.sql"
JSON_RPC_MIGRATION="$ROOT_DIR/supabase/migrations/20260612211910_arena_score_inputs_json.sql"
CURRENT_MIGRATION="$ROOT_DIR/supabase/migrations/20260716124500_rank_only_active_serving_sources.sql"
NEW_MIGRATION="$ROOT_DIR/supabase/migrations/20260716135000_expire_stale_score_fallbacks.sql"
BOARD_WATERMARK_MIGRATION="$ROOT_DIR/supabase/migrations/20260718184000_arena_score_inputs_board_as_of.sql"
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
  "$CURRENT_MIGRATION" \
  "$NEW_MIGRATION" \
  "$BOARD_WATERMARK_MIGRATION"; do
  if [[ ! -f "$migration" ]]; then
    echo "Required migration not found: $migration" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/expire-score-fallbacks-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((50000 + ($$ % 3000)))}"
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

INSERT INTO arena.sources
  (id, slug, product_type, currency, serving_mode, status)
VALUES
  (1, 'freshness_test', 'onchain', 'USDC', 'serving', 'active'),
  (2, 'shadow_test',    'onchain', 'USDC', 'shadow',  'active'),
  (3, 'inactive_test',  'onchain', 'USDC', 'serving', 'inactive'),
  (4, 'legacy_test',    'onchain', 'USDC', 'legacy',  'active');
-- A second active physical board maps to the same public alias. It has no
-- score row of its own, but its latest passed snapshot still bounds the
-- freshness of the combined public board.
INSERT INTO arena.sources
  (id, slug, product_type, currency, serving_mode, status, meta)
VALUES
  (
    5,
    'freshness_test_secondary',
    'onchain',
    'USDC',
    'serving',
    'active',
    '{"legacy_platform":"freshness_test"}'::jsonb
  );
INSERT INTO arena.leaderboard_snapshots
  (id, source_id, timeframe, scraped_at, count_check_passed)
VALUES
  (10, 1, 90, now() - interval '1 hour', true),
  (20, 2, 90, now() - interval '1 hour', true),
  (30, 3, 90, now() - interval '1 hour', true),
  (40, 4, 90, now() - interval '1 hour', true),
  (50, 5, 90, now() - interval '3 hours', true),
  (51, 5, 90, now() - interval '5 minutes', false),
  (52, 5, 30, now() - interval '30 minutes', true);
INSERT INTO arena.traders
  (id, source_id, exchange_trader_id, nickname, meta)
VALUES
  (1,  1, 'stale-fallback',           'Stale fallback', '{}'),
  (2,  1, 'fresh-fallback',           'Fresh fallback', '{}'),
  (3,  1, 'fresh-headline-stale-risk','Fresh headline', '{}'),
  (4,  1, 'cutoff-fallback',          'Cutoff fallback','{}'),
  (5,  1, 'claimed-fresh',            'Fresh owner',    '{"claimed":"true"}'),
  (6,  1, 'claimed-stale',            'Stale owner',    '{"claimed":"true"}'),
  (7,  1, 'board-only',               'Board only',     '{}'),
  (8,  1, 'claimed-fresh-no-board',   'Owner only',     '{"claimed":"true"}'),
  (21, 2, 'shadow-board',             'Shadow board',   '{}'),
  (22, 2, 'shadow-first-party',       'Shadow owner',   '{"claimed":"true"}'),
  (31, 3, 'inactive-board',           'Inactive board', '{}'),
  (32, 3, 'inactive-first-party',     'Inactive owner', '{"claimed":"true"}'),
  (41, 4, 'legacy-board',             'Legacy board',   '{}'),
  (42, 4, 'legacy-first-party',       'Legacy owner',   '{"claimed":"true"}');
INSERT INTO arena.leaderboard_entries
  (snapshot_id, trader_id, rank, headline_roi, headline_pnl, headline_win_rate)
VALUES
  (10, 1, 1, NULL, NULL, NULL),
  (10, 2, 2, NULL, NULL, NULL),
  (10, 3, 3, 11, 110, 51),
  (10, 4, 4, NULL, NULL, NULL),
  (10, 5, 5, 15, 150, 55),
  (10, 6, 6, 16, 160, 56),
  (10, 7, 7, 17, 170, 57),
  (20, 21, 1, 21, 210, 61),
  (30, 31, 1, 31, 310, 71),
  (40, 41, 1, 41, 410, 81);
INSERT INTO arena.trader_stats
  (trader_id, timeframe, as_of, roi, pnl, win_rate, mdd,
   copier_count, total_positions, sharpe, extras)
VALUES
  (1, 90, now() - interval '72 hours', 10, 100, 50, 10,
   1, 10, 1.1, '{"sortino":1.2,"calmar":1.3,"volatility":10}'::jsonb),
  (2, 90, now() - interval '30 hours', 20, 200, 52, 20,
   2, 20, 2.1, '{"sortino":2.2,"calmar":2.3,"volatility":20}'::jsonb),
  (3, 90, now() - interval '72 hours', 30, 300, 53, 30,
   3, 30, 3.1, '{"sortino":3.2,"calmar":3.3,"volatility":30}'::jsonb),
  (4, 90, now() - interval '48 hours', 40, 400, 54, 40,
   4, 40, 4.1, '{"sortino":4.2,"calmar":4.3,"volatility":40}'::jsonb),
  (5, 90, now() - interval '2 hours', 50, 500, 55, 50,
   5, 50, 5.1, '{"provenance":"first_party","sortino":5.2,"calmar":5.3,"volatility":50}'::jsonb),
  (6, 90, now() - interval '72 hours', 60, 600, 56, 60,
   6, 60, 6.1, '{"provenance":"first_party","sortino":6.2,"calmar":6.3,"volatility":60}'::jsonb),
  (8, 90, now() - interval '2 hours', 80, 800, 58, 80,
   8, 80, 8.1, '{"provenance":"first_party","sortino":8.2,"calmar":8.3,"volatility":80}'::jsonb),
  (21, 90, now() - interval '2 hours', 21, 210, 61, 21,
   21, 210, 2.1, '{}'::jsonb),
  (22, 90, now() - interval '2 hours', 22, 220, 62, 22,
   22, 220, 2.2, '{"provenance":"first_party"}'::jsonb),
  (31, 90, now() - interval '2 hours', 31, 310, 71, 31,
   31, 310, 3.1, '{}'::jsonb),
  (32, 90, now() - interval '2 hours', 32, 320, 72, 32,
   32, 320, 3.2, '{"provenance":"first_party"}'::jsonb),
  (41, 90, now() - interval '2 hours', 41, 410, 81, 41,
   41, 410, 4.1, '{}'::jsonb),
  (42, 90, now() - interval '2 hours', 42, 420, 82, 42,
   42, 420, 4.2, '{"provenance":"first_party"}'::jsonb);

-- Seed the stable 20-column view identity with every board fixture so
-- the current production migration's no-growth postflight can establish the
-- exact pre-change implementation.
CREATE VIEW arena.score_inputs AS
SELECT s.slug AS platform,
       'futures'::text AS market_type,
       t.exchange_trader_id AS trader_key,
       '90D'::text AS "window",
       e.rank AS board_rank,
       e.headline_roi AS roi_pct,
       e.headline_pnl AS pnl_usd,
       e.headline_win_rate AS win_rate,
       NULL::numeric AS max_drawdown,
       NULL::integer AS copiers,
       NULL::integer AS trades_count,
       NULL::numeric AS sharpe_ratio,
       NULL::numeric AS sortino_ratio,
       NULL::numeric AS calmar_ratio,
       NULL::numeric AS volatility_pct,
       t.trader_kind,
       t.nickname AS handle,
       NULL::text AS avatar_url,
       s.currency,
       ls.scraped_at AS as_of
  FROM arena.leaderboard_entries e
  JOIN arena.leaderboard_snapshots ls ON ls.id = e.snapshot_id
  JOIN arena.sources s ON s.id = ls.source_id
  JOIN arena.traders t ON t.id = e.trader_id;
GRANT SELECT ON arena.score_inputs TO anon, service_role;
SQL

# Install the actual table and JSON RPCs before advancing the stable view to
# the production definition immediately preceding this migration.
psql_cmd -f "$TABLE_RPC_MIGRATION" >/dev/null
psql_cmd -f "$JSON_RPC_MIGRATION" >/dev/null
psql_cmd -f "$CURRENT_MIGRATION" >/dev/null
psql_cmd -c 'GRANT SELECT ON arena.score_inputs TO anon, authenticated' >/dev/null

psql_cmd <<'SQL'
DO $old_bug_proof$
DECLARE
  v_stale arena.score_inputs%ROWTYPE;
  v_claimed_stale arena.score_inputs%ROWTYPE;
  v_keys text[];
  v_payload jsonb;
BEGIN
  SELECT * INTO STRICT v_stale
    FROM arena.score_inputs
   WHERE trader_key = 'stale-fallback';

  IF v_stale.roi_pct <> 10
     OR v_stale.max_drawdown <> 10
     OR v_stale.copiers <> 1
     OR v_stale.as_of < now() - interval '2 hours' THEN
    RAISE EXCEPTION 'current view no longer reproduces stale fallback relabelling: %',
      row_to_json(v_stale);
  END IF;

  SELECT * INTO STRICT v_claimed_stale
    FROM arena.score_inputs
   WHERE trader_key = 'claimed-stale';
  IF v_claimed_stale.board_rank <> 6
     OR v_claimed_stale.max_drawdown <> 60
     OR v_claimed_stale.as_of < now() - interval '2 hours' THEN
    RAISE EXCEPTION 'current view no longer reproduces stale claimed fallback: %',
      row_to_json(v_claimed_stale);
  END IF;

  SELECT array_agg(trader_key ORDER BY trader_key)
    INTO v_keys
    FROM arena.score_inputs;
  IF v_keys IS DISTINCT FROM ARRAY[
    'board-only', 'claimed-fresh', 'claimed-fresh-no-board', 'claimed-stale',
    'cutoff-fallback', 'fresh-fallback', 'fresh-headline-stale-risk',
    'stale-fallback'
  ]::text[] THEN
    RAISE EXCEPTION 'pre-migration view identity fixture changed: %', v_keys;
  END IF;

  SELECT array_agg(trader_key ORDER BY trader_key)
    INTO v_keys
    FROM public.arena_score_inputs('90D', 1000, 48);
  IF array_length(v_keys, 1) <> 8 THEN
    RAISE EXCEPTION 'pre-migration table RPC48 fixture changed: %', v_keys;
  END IF;

  v_payload := public.arena_score_inputs_json('90D', 1000, 48);
  IF jsonb_array_length(v_payload) <> 8 THEN
    RAISE EXCEPTION 'pre-migration JSON RPC48 fixture changed: %', v_payload;
  END IF;

  IF (SELECT count(*) FROM public.arena_score_inputs('90D', 1000, 24)) <> 8 THEN
    RAISE EXCEPTION 'pre-migration RPC24 fixture must expose board-labelled mixed rows';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM arena.score_inputs
     WHERE trader_key LIKE 'shadow-%'
        OR trader_key LIKE 'inactive-%'
        OR trader_key LIKE 'legacy-%'
  ) THEN
    RAISE EXCEPTION 'pre-migration active-serving boundary fixture changed';
  END IF;
END
$old_bug_proof$;
SQL

VIEW_OID_BEFORE="$(psql_cmd -Atqc "SELECT 'arena.score_inputs'::regclass::oid")"
VIEW_ACL_BEFORE="$(psql_cmd -Atqc "SELECT relacl::text FROM pg_class WHERE oid='arena.score_inputs'::regclass")"
VIEW_COLUMNS_BEFORE="$(psql_cmd -Atqc "SELECT string_agg(attname||':'||format_type(atttypid,atttypmod),'|' ORDER BY attnum) FROM pg_attribute WHERE attrelid='arena.score_inputs'::regclass AND attnum>0 AND NOT attisdropped")"
ROWS_BEFORE="$(psql_cmd -Atqc 'SELECT count(*) FROM arena.score_inputs')"
VIEW_MEMBERSHIP_BEFORE="$(psql_cmd -Atqc "SELECT string_agg(platform||'/'||\"window\"||'/'||trader_key||'/'||coalesce(board_rank::text,'null'),',' ORDER BY platform,\"window\",trader_key,board_rank) FROM arena.score_inputs")"
TABLE_RPC48_BEFORE="$(psql_cmd -Atqc "SELECT string_agg(platform||'/'||trader_key||'/'||coalesce(board_rank::text,'null'),',' ORDER BY platform,trader_key,board_rank) FROM public.arena_score_inputs('90D',1000,48)")"
JSON_RPC48_BEFORE="$(psql_cmd -Atqc "SELECT string_agg((value->>'platform')||'/'||(value->>'trader_key')||'/'||coalesce(value->>'board_rank','null'),',' ORDER BY value->>'platform',value->>'trader_key',value->>'board_rank') FROM jsonb_array_elements(public.arena_score_inputs_json('90D',1000,48))")"
TABLE_RPC_OID_BEFORE="$(psql_cmd -Atqc "SELECT 'public.arena_score_inputs(text,integer,integer)'::regprocedure::oid")"
TABLE_RPC_ACL_BEFORE="$(psql_cmd -Atqc "SELECT proacl::text FROM pg_proc WHERE oid='public.arena_score_inputs(text,integer,integer)'::regprocedure")"
JSON_RPC_OID_BEFORE="$(psql_cmd -Atqc "SELECT 'public.arena_score_inputs_json(text,integer,integer)'::regprocedure::oid")"
JSON_RPC_ACL_BEFORE="$(psql_cmd -Atqc "SELECT proacl::text FROM pg_proc WHERE oid='public.arena_score_inputs_json(text,integer,integer)'::regprocedure")"

psql_cmd -f "$NEW_MIGRATION" >/dev/null

VIEW_OID_AFTER="$(psql_cmd -Atqc "SELECT 'arena.score_inputs'::regclass::oid")"
VIEW_ACL_AFTER="$(psql_cmd -Atqc "SELECT relacl::text FROM pg_class WHERE oid='arena.score_inputs'::regclass")"
VIEW_COLUMNS_AFTER="$(psql_cmd -Atqc "SELECT string_agg(attname||':'||format_type(atttypid,atttypmod),'|' ORDER BY attnum) FROM pg_attribute WHERE attrelid='arena.score_inputs'::regclass AND attnum>0 AND NOT attisdropped")"
ROWS_AFTER="$(psql_cmd -Atqc 'SELECT count(*) FROM arena.score_inputs')"
VIEW_MEMBERSHIP_AFTER="$(psql_cmd -Atqc "SELECT string_agg(platform||'/'||\"window\"||'/'||trader_key||'/'||coalesce(board_rank::text,'null'),',' ORDER BY platform,\"window\",trader_key,board_rank) FROM arena.score_inputs")"
TABLE_RPC48_AFTER="$(psql_cmd -Atqc "SELECT string_agg(platform||'/'||trader_key||'/'||coalesce(board_rank::text,'null'),',' ORDER BY platform,trader_key,board_rank) FROM public.arena_score_inputs('90D',1000,48)")"
JSON_RPC48_AFTER="$(psql_cmd -Atqc "SELECT string_agg((value->>'platform')||'/'||(value->>'trader_key')||'/'||coalesce(value->>'board_rank','null'),',' ORDER BY value->>'platform',value->>'trader_key',value->>'board_rank') FROM jsonb_array_elements(public.arena_score_inputs_json('90D',1000,48))")"
TABLE_RPC_OID_AFTER="$(psql_cmd -Atqc "SELECT 'public.arena_score_inputs(text,integer,integer)'::regprocedure::oid")"
TABLE_RPC_ACL_AFTER="$(psql_cmd -Atqc "SELECT proacl::text FROM pg_proc WHERE oid='public.arena_score_inputs(text,integer,integer)'::regprocedure")"
JSON_RPC_OID_AFTER="$(psql_cmd -Atqc "SELECT 'public.arena_score_inputs_json(text,integer,integer)'::regprocedure::oid")"
JSON_RPC_ACL_AFTER="$(psql_cmd -Atqc "SELECT proacl::text FROM pg_proc WHERE oid='public.arena_score_inputs_json(text,integer,integer)'::regprocedure")"

assert_equal "view OID" "$VIEW_OID_BEFORE" "$VIEW_OID_AFTER"
assert_equal "view ACL" "$VIEW_ACL_BEFORE" "$VIEW_ACL_AFTER"
assert_equal "view columns" "$VIEW_COLUMNS_BEFORE" "$VIEW_COLUMNS_AFTER"
assert_equal "view row count" "$ROWS_BEFORE" "$ROWS_AFTER"
assert_equal "view membership" "$VIEW_MEMBERSHIP_BEFORE" "$VIEW_MEMBERSHIP_AFTER"
assert_equal "table RPC48 membership" "$TABLE_RPC48_BEFORE" "$TABLE_RPC48_AFTER"
assert_equal "JSON RPC48 membership" "$JSON_RPC48_BEFORE" "$JSON_RPC48_AFTER"
assert_equal "table RPC OID" "$TABLE_RPC_OID_BEFORE" "$TABLE_RPC_OID_AFTER"
assert_equal "table RPC ACL" "$TABLE_RPC_ACL_BEFORE" "$TABLE_RPC_ACL_AFTER"
assert_equal "JSON RPC OID" "$JSON_RPC_OID_BEFORE" "$JSON_RPC_OID_AFTER"
assert_equal "JSON RPC ACL" "$JSON_RPC_ACL_BEFORE" "$JSON_RPC_ACL_AFTER"

psql_cmd <<'SQL'
DO $freshness_proof$
DECLARE
  v_stale arena.score_inputs%ROWTYPE;
  v_fresh arena.score_inputs%ROWTYPE;
  v_headline arena.score_inputs%ROWTYPE;
  v_cutoff arena.score_inputs%ROWTYPE;
  v_claimed_fresh arena.score_inputs%ROWTYPE;
  v_claimed_stale arena.score_inputs%ROWTYPE;
  v_claimed_no_board arena.score_inputs%ROWTYPE;
  v_snapshot_at timestamptz;
  v_fresh_stats_at timestamptz;
  v_claimed_stats_at timestamptz;
  v_keys text[];
  v_payload jsonb;
BEGIN
  SELECT scraped_at INTO STRICT v_snapshot_at
    FROM arena.leaderboard_snapshots WHERE id = 10;
  SELECT as_of INTO STRICT v_fresh_stats_at
    FROM arena.trader_stats WHERE trader_id = 2 AND timeframe = 90;
  SELECT as_of INTO STRICT v_claimed_stats_at
    FROM arena.trader_stats WHERE trader_id = 5 AND timeframe = 90;
  SELECT * INTO STRICT v_stale
    FROM arena.score_inputs WHERE trader_key = 'stale-fallback';
  SELECT * INTO STRICT v_fresh
    FROM arena.score_inputs WHERE trader_key = 'fresh-fallback';
  SELECT * INTO STRICT v_headline
    FROM arena.score_inputs WHERE trader_key = 'fresh-headline-stale-risk';
  SELECT * INTO STRICT v_cutoff
    FROM arena.score_inputs WHERE trader_key = 'cutoff-fallback';
  SELECT * INTO STRICT v_claimed_fresh
    FROM arena.score_inputs WHERE trader_key = 'claimed-fresh';
  SELECT * INTO STRICT v_claimed_stale
    FROM arena.score_inputs WHERE trader_key = 'claimed-stale';
  SELECT * INTO STRICT v_claimed_no_board
    FROM arena.score_inputs WHERE trader_key = 'claimed-fresh-no-board';

  IF v_stale.roi_pct IS NOT NULL
     OR v_stale.pnl_usd IS NOT NULL
     OR v_stale.win_rate IS NOT NULL
     OR v_stale.max_drawdown IS NOT NULL
     OR v_stale.copiers IS NOT NULL
     OR v_stale.trades_count IS NOT NULL
     OR v_stale.sharpe_ratio IS NOT NULL
     OR v_stale.sortino_ratio IS NOT NULL
     OR v_stale.calmar_ratio IS NOT NULL
     OR v_stale.volatility_pct IS NOT NULL
     OR v_stale.as_of IS DISTINCT FROM v_snapshot_at THEN
    RAISE EXCEPTION 'stale stats still leak into sparse board row: %', row_to_json(v_stale);
  END IF;

  IF v_fresh.roi_pct <> 20
     OR v_fresh.pnl_usd <> 200
     OR v_fresh.win_rate <> 52
     OR v_fresh.max_drawdown <> 20
     OR v_fresh.copiers <> 2
     OR v_fresh.trades_count <> 20
     OR v_fresh.sharpe_ratio <> 2.1
     OR v_fresh.sortino_ratio <> 2.2
     OR v_fresh.calmar_ratio <> 2.3
     OR v_fresh.volatility_pct <> 20
     OR v_fresh.as_of IS DISTINCT FROM v_fresh_stats_at THEN
    RAISE EXCEPTION 'fresh fallback or conservative as_of was lost: %', row_to_json(v_fresh);
  END IF;

  IF v_headline.roi_pct <> 11
     OR v_headline.pnl_usd <> 110
     OR v_headline.win_rate <> 51
     OR v_headline.max_drawdown IS NOT NULL
     OR v_headline.copiers IS NOT NULL
     OR v_headline.sharpe_ratio IS NOT NULL
     OR v_headline.as_of IS DISTINCT FROM v_snapshot_at THEN
    RAISE EXCEPTION 'fresh headline did not survive stale risk expiry: %',
      row_to_json(v_headline);
  END IF;

  -- The join is strict > 48h. A row inserted at the exact boundary is older
  -- by the time this transaction starts and must fail closed as expired.
  IF v_cutoff.roi_pct IS NOT NULL
     OR v_cutoff.max_drawdown IS NOT NULL
     OR v_cutoff.copiers IS NOT NULL
     OR v_cutoff.trades_count IS NOT NULL
     OR v_cutoff.sharpe_ratio IS NOT NULL
     OR v_cutoff.sortino_ratio IS NOT NULL
     OR v_cutoff.calmar_ratio IS NOT NULL
     OR v_cutoff.volatility_pct IS NOT NULL
     OR v_cutoff.as_of IS DISTINCT FROM v_snapshot_at THEN
    RAISE EXCEPTION '48h boundary fallback was not expired: %', row_to_json(v_cutoff);
  END IF;

  IF v_claimed_fresh.board_rank <> 5
     OR v_claimed_fresh.roi_pct <> 50
     OR v_claimed_fresh.max_drawdown <> 50
     OR v_claimed_fresh.trades_count <> 50
     OR v_claimed_fresh.as_of IS DISTINCT FROM v_claimed_stats_at THEN
    RAISE EXCEPTION 'fresh claimed trader did not remain first-party-only: %',
      row_to_json(v_claimed_fresh);
  END IF;

  IF v_claimed_stale.board_rank <> 6
     OR v_claimed_stale.roi_pct <> 16
     OR v_claimed_stale.pnl_usd <> 160
     OR v_claimed_stale.win_rate <> 56
     OR v_claimed_stale.max_drawdown IS NOT NULL
     OR v_claimed_stale.copiers IS NOT NULL
     OR v_claimed_stale.trades_count IS NOT NULL
     OR v_claimed_stale.sharpe_ratio IS NOT NULL
     OR v_claimed_stale.as_of IS DISTINCT FROM v_snapshot_at THEN
    RAISE EXCEPTION 'stale claimed trader did not fall back to board-only truth: %',
      row_to_json(v_claimed_stale);
  END IF;

  IF v_claimed_no_board.board_rank IS NOT NULL
     OR v_claimed_no_board.roi_pct <> 80
     OR v_claimed_no_board.as_of < now() - interval '3 hours' THEN
    RAISE EXCEPTION 'fresh boardless first-party row changed: %',
      row_to_json(v_claimed_no_board);
  END IF;

  IF EXISTS (
    SELECT 1
      FROM arena.score_inputs
     WHERE trader_key LIKE 'shadow-%'
        OR trader_key LIKE 'inactive-%'
        OR trader_key LIKE 'legacy-%'
  ) THEN
    RAISE EXCEPTION 'non-active-serving source entered the rewritten view';
  END IF;

  SELECT array_agg(trader_key ORDER BY trader_key)
    INTO v_keys
    FROM public.arena_score_inputs('90D', 1000, 24);
  IF v_keys IS DISTINCT FROM ARRAY[
    'board-only', 'claimed-fresh', 'claimed-fresh-no-board', 'claimed-stale',
    'cutoff-fallback', 'fresh-headline-stale-risk', 'stale-fallback'
  ]::text[] THEN
    RAISE EXCEPTION 'RPC24 conservative mixed-row boundary changed: %', v_keys;
  END IF;

  SELECT array_agg(trader_key ORDER BY trader_key)
    INTO v_keys
    FROM public.arena_score_inputs('90D', 1000, 48);
  IF array_length(v_keys, 1) <> 8 THEN
    RAISE EXCEPTION 'default table RPC48 lost membership: %', v_keys;
  END IF;

  v_payload := public.arena_score_inputs_json('90D', 1000, 48);
  IF jsonb_array_length(v_payload) <> 8 THEN
    RAISE EXCEPTION 'default JSON RPC48 lost membership: %', v_payload;
  END IF;

  IF NOT has_function_privilege(
       'service_role', 'public.arena_score_inputs(text,integer,integer)', 'EXECUTE'
     ) OR NOT has_function_privilege(
       'service_role', 'public.arena_score_inputs_json(text,integer,integer)', 'EXECUTE'
     ) OR has_function_privilege(
       'anon', 'public.arena_score_inputs(text,integer,integer)', 'EXECUTE'
     ) OR has_function_privilege(
       'authenticated', 'public.arena_score_inputs_json(text,integer,integer)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'score-input RPC execution boundary changed';
  END IF;
END
$freshness_proof$;
SQL

# Replay must preserve the same object and data contract.
psql_cmd -f "$NEW_MIGRATION" >/dev/null
assert_equal "replayed view OID" "$VIEW_OID_AFTER" \
  "$(psql_cmd -Atqc "SELECT 'arena.score_inputs'::regclass::oid")"
assert_equal "replayed view ACL" "$VIEW_ACL_AFTER" \
  "$(psql_cmd -Atqc "SELECT relacl::text FROM pg_class WHERE oid='arena.score_inputs'::regclass")"
assert_equal "replayed view columns" "$VIEW_COLUMNS_AFTER" \
  "$(psql_cmd -Atqc "SELECT string_agg(attname||':'||format_type(atttypid,atttypmod),'|' ORDER BY attnum) FROM pg_attribute WHERE attrelid='arena.score_inputs'::regclass AND attnum>0 AND NOT attisdropped")"
assert_equal "replayed view row count" "$ROWS_AFTER" \
  "$(psql_cmd -Atqc 'SELECT count(*) FROM arena.score_inputs')"

# Deliberately drift the JSON RPC grants before replacement. The board
# migration must keep the same object identity while removing both API roles.
psql_cmd -c \
  'GRANT EXECUTE ON FUNCTION public.arena_score_inputs_json(text, int, int) TO anon, authenticated' \
  >/dev/null

BOARD_VIEW_OID_BEFORE="$(psql_cmd -Atqc "SELECT 'arena.score_inputs'::regclass::oid")"
BOARD_VIEW_ACL_BEFORE="$(psql_cmd -Atqc "SELECT relacl::text FROM pg_class WHERE oid='arena.score_inputs'::regclass")"
BOARD_VIEW_COLUMNS_BEFORE="$(psql_cmd -Atqc "SELECT string_agg(attname||':'||format_type(atttypid,atttypmod),'|' ORDER BY attnum) FROM pg_attribute WHERE attrelid='arena.score_inputs'::regclass AND attnum>0 AND NOT attisdropped")"
BOARD_TABLE_RPC_OID_BEFORE="$(psql_cmd -Atqc "SELECT 'public.arena_score_inputs(text,integer,integer)'::regprocedure::oid")"
BOARD_TABLE_RPC_ACL_BEFORE="$(psql_cmd -Atqc "SELECT proacl::text FROM pg_proc WHERE oid='public.arena_score_inputs(text,integer,integer)'::regprocedure")"
BOARD_TABLE_RPC_RESULT_BEFORE="$(psql_cmd -Atqc "SELECT pg_get_function_result('public.arena_score_inputs(text,integer,integer)'::regprocedure)")"
BOARD_JSON_RPC_OID_BEFORE="$(psql_cmd -Atqc "SELECT 'public.arena_score_inputs_json(text,integer,integer)'::regprocedure::oid")"
BOARD_JSON_BASE_PAYLOAD_BEFORE="$(psql_cmd -Atqc "SELECT coalesce(jsonb_agg(value ORDER BY value->>'trader_key'),'[]'::jsonb)::text FROM jsonb_array_elements(public.arena_score_inputs_json('90D',1000,48)) AS payload(value)")"

psql_cmd -f "$BOARD_WATERMARK_MIGRATION" >/dev/null

assert_equal "board migration view OID" "$BOARD_VIEW_OID_BEFORE" \
  "$(psql_cmd -Atqc "SELECT 'arena.score_inputs'::regclass::oid")"
assert_equal "board migration view ACL" "$BOARD_VIEW_ACL_BEFORE" \
  "$(psql_cmd -Atqc "SELECT relacl::text FROM pg_class WHERE oid='arena.score_inputs'::regclass")"
assert_equal "board migration view columns" "$BOARD_VIEW_COLUMNS_BEFORE" \
  "$(psql_cmd -Atqc "SELECT string_agg(attname||':'||format_type(atttypid,atttypmod),'|' ORDER BY attnum) FROM pg_attribute WHERE attrelid='arena.score_inputs'::regclass AND attnum>0 AND NOT attisdropped")"
assert_equal "board migration table RPC OID" "$BOARD_TABLE_RPC_OID_BEFORE" \
  "$(psql_cmd -Atqc "SELECT 'public.arena_score_inputs(text,integer,integer)'::regprocedure::oid")"
assert_equal "board migration table RPC ACL" "$BOARD_TABLE_RPC_ACL_BEFORE" \
  "$(psql_cmd -Atqc "SELECT proacl::text FROM pg_proc WHERE oid='public.arena_score_inputs(text,integer,integer)'::regprocedure")"
assert_equal "board migration table RPC columns" "$BOARD_TABLE_RPC_RESULT_BEFORE" \
  "$(psql_cmd -Atqc "SELECT pg_get_function_result('public.arena_score_inputs(text,integer,integer)'::regprocedure)")"
assert_equal "board migration JSON RPC OID" "$BOARD_JSON_RPC_OID_BEFORE" \
  "$(psql_cmd -Atqc "SELECT 'public.arena_score_inputs_json(text,integer,integer)'::regprocedure::oid")"
assert_equal "board migration JSON base payload" "$BOARD_JSON_BASE_PAYLOAD_BEFORE" \
  "$(psql_cmd -Atqc "SELECT coalesce(jsonb_agg(value - 'board_as_of' ORDER BY value->>'trader_key'),'[]'::jsonb)::text FROM jsonb_array_elements(public.arena_score_inputs_json('90D',1000,48)) AS payload(value)")"

psql_cmd <<'SQL'
DO $board_watermark_proof$
DECLARE
  v_payload jsonb;
  v_stale_metric_row jsonb;
  v_boardless_claimed_row jsonb;
  v_expected_alias_board timestamptz;
  v_primary_board timestamptz;
  v_failed_board timestamptz;
  v_other_window_board timestamptz;
  v_stale_metric_as_of timestamptz;
BEGIN
  SELECT scraped_at INTO STRICT v_expected_alias_board
    FROM arena.leaderboard_snapshots
   WHERE id = 50;
  SELECT scraped_at INTO STRICT v_primary_board
    FROM arena.leaderboard_snapshots
   WHERE id = 10;
  SELECT scraped_at INTO STRICT v_failed_board
    FROM arena.leaderboard_snapshots
   WHERE id = 51;
  SELECT scraped_at INTO STRICT v_other_window_board
    FROM arena.leaderboard_snapshots
   WHERE id = 52;
  SELECT as_of INTO STRICT v_stale_metric_as_of
    FROM arena.trader_stats
   WHERE trader_id = 2
     AND timeframe = 90;

  v_payload := public.arena_score_inputs_json('90D', 1000, 48);
  IF pg_catalog.jsonb_array_length(v_payload) <> 8 THEN
    RAISE EXCEPTION 'board watermark changed JSON membership: %', v_payload;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(v_payload) AS payload_row
    WHERE (payload_row->>'board_as_of')::timestamptz
      IS DISTINCT FROM v_expected_alias_board
  ) THEN
    RAISE EXCEPTION 'rows did not receive the alias-level oldest passed board: %',
      v_payload;
  END IF;

  SELECT payload_row INTO STRICT v_stale_metric_row
    FROM pg_catalog.jsonb_array_elements(v_payload) AS payload_row
   WHERE payload_row->>'trader_key' = 'fresh-fallback';
  IF (v_stale_metric_row->>'as_of')::timestamptz
       IS DISTINCT FROM v_stale_metric_as_of
     OR (v_stale_metric_row->>'board_as_of')::timestamptz
       IS DISTINCT FROM v_expected_alias_board
     OR (v_stale_metric_row->>'as_of')::timestamptz
       >= (v_stale_metric_row->>'board_as_of')::timestamptz THEN
    RAISE EXCEPTION 'metric as_of and board_as_of are not independent: %',
      v_stale_metric_row;
  END IF;

  SELECT payload_row INTO STRICT v_boardless_claimed_row
    FROM pg_catalog.jsonb_array_elements(v_payload) AS payload_row
   WHERE payload_row->>'trader_key' = 'claimed-fresh-no-board';
  IF v_boardless_claimed_row->'board_rank' IS DISTINCT FROM 'null'::jsonb
     OR (v_boardless_claimed_row->>'board_as_of')::timestamptz
       IS DISTINCT FROM v_expected_alias_board THEN
    RAISE EXCEPTION 'boardless claimed row did not inherit its source board: %',
      v_boardless_claimed_row;
  END IF;

  IF v_expected_alias_board >= v_primary_board
     OR v_expected_alias_board = v_failed_board
     OR v_expected_alias_board = v_other_window_board THEN
    RAISE EXCEPTION
      'fixture no longer proves alias MIN, failed-snapshot, and p_window isolation';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.arena_score_inputs_json(text,integer,integer)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon',
       'public.arena_score_inputs_json(text,integer,integer)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.arena_score_inputs_json(text,integer,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'board watermark JSON RPC execution ACL is not service-only';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
      'public.arena_score_inputs_json(text,integer,integer)'::regprocedure
      AND function_row.prosecdef
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'board watermark JSON RPC is not search-path hardened';
  END IF;
END
$board_watermark_proof$;
SQL

BOARD_JSON_PAYLOAD_AFTER="$(psql_cmd -Atqc "SELECT public.arena_score_inputs_json('90D',1000,48)::text")"
psql_cmd -f "$BOARD_WATERMARK_MIGRATION" >/dev/null
assert_equal "replayed board JSON RPC OID" "$BOARD_JSON_RPC_OID_BEFORE" \
  "$(psql_cmd -Atqc "SELECT 'public.arena_score_inputs_json(text,integer,integer)'::regprocedure::oid")"
assert_equal "replayed board JSON payload" "$BOARD_JSON_PAYLOAD_AFTER" \
  "$(psql_cmd -Atqc "SELECT public.arena_score_inputs_json('90D',1000,48)::text")"
assert_equal "replayed board view OID" "$BOARD_VIEW_OID_BEFORE" \
  "$(psql_cmd -Atqc "SELECT 'arena.score_inputs'::regclass::oid")"
assert_equal "replayed board table RPC OID" "$BOARD_TABLE_RPC_OID_BEFORE" \
  "$(psql_cmd -Atqc "SELECT 'public.arena_score_inputs(text,integer,integer)'::regprocedure::oid")"

echo "stale score fallback and independent board watermark PostgreSQL 17 proof passed"
