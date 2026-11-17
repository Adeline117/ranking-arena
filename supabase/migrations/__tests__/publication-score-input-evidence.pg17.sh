#!/usr/bin/env bash

# PostgreSQL 17 proof for score-input evidence binding (PR #476 plan, option
# B). It owns an isolated cluster on a private socket and never connects to
# application data.
#
# Chain applied on a minimal fixture of the relations it reads:
#   20260721175746 arena_score_inputs_publish_bundle
#   20260725012000 strengthen_arena_score_publish_evidence
#   (the 20261115013558 Bitget-bot bundle rewrite, replayed verbatim and
#    pinned to its reviewed f1c2aa2f... body digest)
#   20261116204006 publication_score_rows_board_headline_only     (step 1)

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
STEP1=20261116204006_publication_score_rows_board_headline_only.sql
CHAIN=(
  20260721175746_arena_score_inputs_publish_bundle.sql
  20260725012000_strengthen_arena_score_publish_evidence.sql
)

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

TMP_ROOT="$(mktemp -d /tmp/publication-score-input-evidence-pg17.XXXXXX)"
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
    tail -80 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_on() {
  local database="$1"
  shift
  "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres \
    -d "$database" "$@"
}
psql_db() { psql_on postgres "$@"; }

expect_failure() {
  local label="$1" pattern="$2"
  shift 2
  local output
  if output="$("$@" 2>&1)"; then
    echo "$label: expected failure, succeeded" >&2
    exit 1
  fi
  if ! grep -q -- "$pattern" <<<"$output"; then
    echo "$label: expected '$pattern', got: $output" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

# ---------------------------------------------------------------------------
# Fixture: the relations the bundle and the publication reader read.
# ---------------------------------------------------------------------------
psql_db <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA arena;
GRANT USAGE ON SCHEMA public, arena TO anon, authenticated, service_role;

CREATE TABLE arena.score_inputs (marker text);
CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  adapter_slug text NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL,
  currency text NOT NULL DEFAULT 'USDT',
  product_type text NOT NULL DEFAULT 'futures',
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  timeframes_native integer[] NOT NULL DEFAULT '{90}',
  timeframes_derived integer[] NOT NULL DEFAULT '{}'
);
CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL,
  actual_count integer NOT NULL,
  count_check_passed boolean NOT NULL,
  raw_object_id bigint
);
CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL,
  trader_kind text,
  nickname text,
  avatar_url_mirror text,
  avatar_url_origin text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE arena.leaderboard_entries (
  scraped_at timestamptz NOT NULL,
  snapshot_id bigint NOT NULL,
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  timeframe smallint NOT NULL,
  rank integer NOT NULL,
  headline_roi numeric,
  headline_pnl numeric,
  headline_win_rate numeric,
  PRIMARY KEY (scraped_at, snapshot_id, trader_id)
);
CREATE TABLE arena.trader_stats (
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  timeframe smallint NOT NULL,
  as_of timestamptz NOT NULL,
  currency text NOT NULL DEFAULT 'USDT',
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

-- Stand-in for the legacy score-row reader. It satisfies the read contract
-- 20260725012000 verifies and returns a marker the publication path must
-- never surface.
CREATE FUNCTION public.arena_score_inputs_json(
  p_window text,
  p_per_platform_limit int DEFAULT 1000,
  p_max_age_hours int DEFAULT 48
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('legacy_reader', true))
$$;
REVOKE ALL ON FUNCTION public.arena_score_inputs_json(text, int, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arena_score_inputs_json(text, int, int) TO service_role;
SQL

for migration in "${CHAIN[@]}"; do
  psql_db -f "$MIGRATIONS/$migration"
done

# Replay the 20261115013558 bundle rewrite (the Bitget-bot rank quarantine
# predicate after the registry's serving filter) and prove the body is the
# exact reviewed one the step-1 migration pins.
psql_db <<'SQL'
DO $replay$
DECLARE
  v_function oid := 'public.arena_score_inputs_publish_bundle_json(text,integer,integer)'::regprocedure;
  v_needle text := E'source_row.serving_mode = ''serving''\n';
  v_sha text;
BEGIN
  SELECT encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') INTO v_sha
  FROM pg_proc WHERE oid = v_function;
  IF v_sha <> 'd20a085c89371ddc5d5a9ee70645268433e385d6b32ab348d7fd9322a31521d1' THEN
    RAISE EXCEPTION 'fixture bundle is not the reviewed pre-quarantine body: %', v_sha;
  END IF;
  EXECUTE replace(pg_get_functiondef(v_function), v_needle, v_needle || format(
$predicate$%2$s-- bitget-bot-cumulative-rank-quarantine@1
%2$sAND NOT (
%2$s  %1$s.slug = ANY (
%2$s    ARRAY[
%2$s      'bitget_bots_futures',
%2$s      'bitget_bots_spot'
%2$s    ]::pg_catalog.text[]
%2$s  )
%2$s  OR %1$s.adapter_slug = 'bitget_bots'
%2$s)
$predicate$, 'source_row', '      '));
  SELECT encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') INTO v_sha
  FROM pg_proc WHERE oid = v_function;
  IF v_sha <> 'f1c2aa2f9c5bb32c70fc585fce0a5a424028041ff4473fa89984f293e2eb85bc' THEN
    RAISE EXCEPTION 'fixture bundle is not the reviewed quarantined body: %', v_sha;
  END IF;
END
$replay$;
SQL

# A drifted copy of the database, for the refusal case.
psql_db -c 'CREATE DATABASE drifted TEMPLATE postgres'
psql_on drifted <<'SQL'
DO $drift$
DECLARE
  v_function oid := 'public.arena_score_inputs_publish_bundle_json(text,integer,integer)'::regprocedure;
BEGIN
  EXECUTE replace(pg_get_functiondef(v_function), 'RETURN (', E'-- drift\n  RETURN (');
END
$drift$;
SQL
expect_failure 'step 1 refuses a drifted bundle body' 'score-input publish bundle body drifted' \
  psql_on drifted -f "$MIGRATIONS/$STEP1"

# ---------------------------------------------------------------------------
# Data: one serving source, one quarantined bot source, one board each.
# ---------------------------------------------------------------------------
psql_db <<'SQL'
INSERT INTO arena.sources (id, slug, adapter_slug, status, serving_mode) VALUES
  (1, 'alpha_futures', 'alpha', 'active', 'serving'),
  (2, 'bitget_bots_futures', 'bitget_bots', 'active', 'serving');

INSERT INTO arena.leaderboard_snapshots VALUES
  (11, 1, 90, now() - interval '1 hour', 4, true, 5011),
  (21, 2, 90, now() - interval '1 hour', 1, true, 5021);

INSERT INTO arena.traders (id, source_id, exchange_trader_id, nickname, meta) VALUES
  (101, 1, 'full', 'Full', '{}'),
  (102, 1, 'no-win', 'NoWin', '{}'),
  (103, 1, 'bare', 'Bare', '{}'),
  (104, 1, 'claimed', 'Claimed', '{"claimed":"true"}'),
  (105, 1, 'claimed-off-board', 'Off', '{"claimed":"true"}'),
  (201, 2, 'bot', 'Bot', '{}');

INSERT INTO arena.leaderboard_entries
  (scraped_at, snapshot_id, trader_id, timeframe, rank, headline_roi, headline_pnl, headline_win_rate)
SELECT s.scraped_at, s.id, e.trader_id, 90, e.rank, e.roi, e.pnl, e.win_rate
FROM (VALUES
  (11, 101, 1, 50.0, 1000.0, 60.0),
  (11, 102, 2, 40.0, 900.0, NULL),
  (11, 103, 3, NULL, NULL, NULL),
  (11, 104, 4, 30.0, 800.0, 55.0),
  (21, 201, 1, 10.0, 10.0, 50.0)
) AS e(snapshot_id, trader_id, rank, roi, pnl, win_rate)
JOIN arena.leaderboard_snapshots AS s ON s.id = e.snapshot_id;

INSERT INTO arena.trader_stats
  (trader_id, timeframe, as_of, roi, pnl, win_rate, mdd, sharpe, copier_count, total_positions, extras)
VALUES
  (101, 90, now() - interval '1 hour', 999, 99999, 99, 12, 1.5, 7, 40, '{"sortino":2.5}'),
  (102, 90, now() - interval '1 hour', 40, 900, 58, 20, NULL, NULL, 12, '{}'),
  (103, 90, now() - interval '1 hour', NULL, NULL, NULL, 30, NULL, NULL, NULL, '{}'),
  (104, 90, now() - interval '30 minutes', 777, 7777, 77, 5, NULL, NULL, 3,
   '{"provenance":"first_party"}'),
  (105, 90, now() - interval '30 minutes', 666, 6666, 66, 6, NULL, NULL, 3,
   '{"provenance":"first_party"}');
SQL

psql_db -f "$MIGRATIONS/$STEP1"
# Replay is a no-op on an already rewritten body.
psql_db -f "$MIGRATIONS/$STEP1"

psql_db <<'SQL'
DO $proof$
DECLARE
  v_bundle jsonb := public.arena_score_inputs_publish_bundle_json('90D', 1000, 48);
  v_rows jsonb := v_bundle->'scoreRows';
  v_row jsonb;
BEGIN
  IF v_rows IS DISTINCT FROM arena.publication_score_rows_json('90D', 1000, 48) THEN
    RAISE EXCEPTION 'bundle scoreRows are not the publication reader rows';
  END IF;
  IF v_rows @> '[{"legacy_reader": true}]' THEN
    RAISE EXCEPTION 'bundle still reads the legacy score-row reader';
  END IF;
  IF jsonb_array_length(v_rows) <> 4
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) AS r
                WHERE r->>'platform' <> 'alpha_futures'
                   OR r->>'trader_key' = 'claimed-off-board') THEN
    RAISE EXCEPTION 'rows must be exactly the four alpha board entries: %', v_rows;
  END IF;
  IF jsonb_array_length(v_bundle->'physicalBoards') <> 1 THEN
    RAISE EXCEPTION 'physical boards drifted: %', v_bundle->'physicalBoards';
  END IF;

  -- Headline from the entry, never from trader_stats.
  SELECT r INTO STRICT v_row FROM jsonb_array_elements(v_rows) AS r WHERE r->>'trader_key' = 'full';
  IF (v_row->>'roi_pct')::numeric <> 50 OR (v_row->>'pnl_usd')::numeric <> 1000
     OR (v_row->>'win_rate')::numeric <> 60 OR (v_row->>'max_drawdown')::numeric <> 12
     OR (v_row->>'sharpe_ratio')::numeric <> 1.5 OR (v_row->>'trades_count')::int <> 40
     OR (v_row->>'sortino_ratio')::numeric <> 2.5
     OR v_row->'unevidenced_metrics' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'full row drifted: %', v_row;
  END IF;

  -- A board without win rate no longer borrows trader_stats.win_rate.
  SELECT r INTO STRICT v_row FROM jsonb_array_elements(v_rows) AS r WHERE r->>'trader_key' = 'no-win';
  IF v_row->'win_rate' <> 'null'::jsonb
     OR v_row->'unevidenced_metrics' <> '["win_rate"]'::jsonb
     OR (v_row->>'max_drawdown')::numeric <> 20 THEN
    RAISE EXCEPTION 'headline fallback survived: %', v_row;
  END IF;

  -- Missing on both sides is plain missing, not unevidenced.
  SELECT r INTO STRICT v_row FROM jsonb_array_elements(v_rows) AS r WHERE r->>'trader_key' = 'bare';
  IF v_row->'roi_pct' <> 'null'::jsonb OR v_row->'unevidenced_metrics' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'bare row drifted: %', v_row;
  END IF;

  -- A claimed trader keeps its board row; first-party stats never replace it.
  SELECT r INTO STRICT v_row FROM jsonb_array_elements(v_rows) AS r WHERE r->>'trader_key' = 'claimed';
  IF (v_row->>'roi_pct')::numeric <> 30 OR (v_row->>'board_rank')::int <> 4 THEN
    RAISE EXCEPTION 'first-party substitution survived: %', v_row;
  END IF;

  IF has_function_privilege('anon', 'arena.publication_score_rows_json(text,integer,integer)', 'EXECUTE')
     OR has_function_privilege('service_role', 'arena.publication_score_rows_json(text,integer,integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.arena_score_inputs_publish_bundle_json(text,integer,integer)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.arena_score_inputs_publish_bundle_json(text,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'execution boundary drifted';
  END IF;
END
$proof$;
SQL

echo "publication-score-input-evidence.pg17: step 1 ok"
