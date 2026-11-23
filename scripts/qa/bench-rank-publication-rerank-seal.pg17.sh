#!/usr/bin/env bash

# Local-only PostgreSQL 17 timing harness for the rank publication transaction
# (lib/rankings/publication/publish-season.ts, publishInTransaction):
#   chunked write -> cleanup_leaderboard_rank_publication
#   -> rerank_leaderboard_publication -> seal_leaderboard_rank_publication
#
# It owns a throwaway cluster on a private unix socket (fsync on, default
# server settings), never connects anywhere else, and removes the cluster on
# exit. The schema is the fixture of
# supabase/migrations/__tests__/public-ranking-season-publication.pg17.sh with
# the same real migration chain applied; the publication itself is run by the
# real orchestrator, with every statement timed on the client.
#
# Usage:
#   scripts/qa/bench-rank-publication-rerank-seal.pg17.sh [ROWS] [SOURCES] [STEADY_CYCLES]
#     ROWS           rows published for season 90D (default 9000)
#     SOURCES        sources the rows are spread over (default: 11 at <= 9000
#                    rows, else ceil(ROWS / 1000)); at most 1000 rows per source
#                    and at most 32 sources (the scorer only ranks registered
#                    public sources, so real source slugs are used)
#     STEADY_CYCLES  republications over the existing rows (default 3)
# Environment:
#   PG17_BIN            PostgreSQL 17 bin directory
#   BENCH_WORK_ROOT     parent of the cluster directory (default ${TMPDIR:-/tmp})
#   BENCH_AUTO_EXPLAIN  1 = load auto_explain (nested statements, ANALYZE) and
#                       keep the server log; timings of such a run are inflated
#   BENCH_KEEP_LOG      path to copy the server log to before cleanup
#
# Output: one line per step and cycle
#   step=<name> phase=<cold|steady> cycle=<n> rows=<published rows> ms=<milliseconds>
# then min/median/max per step over the steady cycles.
# cycle 0 (cold) inserts into an empty table; later cycles (steady) republish
# over the previous publication: ~95% of rows are updated by ON CONFLICT with
# changed metrics, ~5% are new traders and the ~5% they replace are deleted.

set -Eeuo pipefail

ROWS="${1:-9000}"
if ! [[ "$ROWS" =~ ^[0-9]+$ ]] || ((ROWS < 1 || ROWS > 64000)); then
  echo "ROWS must be 1..64000, got '$ROWS'" >&2
  exit 64
fi
if [[ -n "${2:-}" ]]; then
  SOURCES="$2"
elif ((ROWS <= 9000)); then
  SOURCES=11
else
  SOURCES=$(((ROWS + 999) / 1000))
fi
STEADY_CYCLES="${3:-3}"
if ! [[ "$SOURCES" =~ ^[0-9]+$ && "$STEADY_CYCLES" =~ ^[0-9]+$ ]] \
  || ((SOURCES < 1 || SOURCES > 32 || STEADY_CYCLES > 5)); then
  echo "SOURCES must be 1..32 and STEADY_CYCLES 0..5" >&2
  exit 64
fi
if ((SOURCES > ROWS)); then SOURCES="$ROWS"; fi
if (((ROWS + SOURCES - 1) / SOURCES > 1000)); then
  echo "$ROWS rows over $SOURCES sources exceeds 1000 rows per source" >&2
  exit 64
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
# Same chain, same order as public-ranking-season-publication.pg17.sh.
CHAIN=(
  20260718130000_count_trader_account_followers.sql
  20260718134000_freshness_expected_sources.sql
  20260721175746_arena_score_inputs_publish_bundle.sql
  20260725012000_strengthen_arena_score_publish_evidence.sql
  20260724235000_leaderboard_publication_mutation_fence.sql
  20260725013000_cleanup_leaderboard_rank_publication.sql
  20260725014000_strengthen_leaderboard_publication_proof_authority.sql
  20260725015000_leaderboard_rank_generation_claim.sql
  20260725015500_bound_leaderboard_rank_generation_batches.sql
  20260816151614_public_ranked_leaderboard.sql
  20260816184500_public_ranked_leaderboard_source_freshness_gate.sql
  20261113010326_release_leaderboard_rank_generation_lease_after_seal.sql
  20261113011058_leaderboard_publication_source_isolation.sql
  20261113110430_rank_publication_source_evidence_binding.sql
  20261114193017_rank_publication_requires_attempt_bound_evidence.sql
  20261116210657_rank_publication_evidence_score_input_digest.sql
)

# lib/constants/exchanges.ts PUBLIC_ACTIVE_RANKING_SOURCES that the publication
# policy allows (bitget_bot_* and bingx* are quarantined and not listed).
SOURCE_SLUGS=(
  binance_futures bybit bitget_futures mexc coinex okx_futures kucoin phemex
  htx_futures gateio xt lbank blofin bitget_cfd bitmart_futures bybit_mt5
  gate_cfd toobit_futures binance_spot bitget_spot blofin_spot htx_spot xt_spot
  okx_spot binance_web3 gmx hyperliquid drift paradex bitunix btcc bitfinex
)
SLUG_ARRAY="$(IFS=,; echo "${SOURCE_SLUGS[*]:0:SOURCES}")"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This harness requires PostgreSQL 17" >&2
  exit 1
fi
for migration in "${CHAIN[@]}"; do
  if [[ ! -f "$MIGRATIONS/$migration" ]]; then
    echo "Required migration not found: $migration" >&2
    exit 1
  fi
done

WORK_ROOT="${BENCH_WORK_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p "$WORK_ROOT"
TMP_ROOT="$(mktemp -d "$WORK_ROOT/bench-rank-publication-pg17.XXXXXX")"
# A unix socket path is limited to ~103 bytes; keep it short and separate.
SOCKET_DIR="$(mktemp -d /tmp/brp17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
LOG_FILE="$TMP_ROOT/postgres.log"
DRIVER="$TMP_ROOT/bench-driver.mts"
PORT="${PGPORT_OVERRIDE:-$((56000 + ($$ % 3000)))}"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m fast -w stop >/dev/null 2>&1 || true
  fi
  if [[ -n "${BENCH_KEEP_LOG:-}" && -f "$LOG_FILE" ]]; then
    cp "$LOG_FILE" "$BENCH_KEEP_LOG" || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -60 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT" "$SOCKET_DIR"
  exit "$exit_code"
}
trap cleanup EXIT

psql_db() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

SERVER_OPTIONS="-k $SOCKET_DIR -p $PORT -c listen_addresses=''"
if [[ "${BENCH_AUTO_EXPLAIN:-0}" == "1" ]]; then
  SERVER_OPTIONS+=" -c session_preload_libraries=auto_explain"
  SERVER_OPTIONS+=" -c auto_explain.log_min_duration=20ms -c auto_explain.log_analyze=on"
  SERVER_OPTIONS+=" -c auto_explain.log_nested_statements=on -c auto_explain.log_buffers=on"
fi

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --encoding=UTF8 --no-locale >/dev/null
# No -F: fsync stays on. Every other setting is the initdb default.
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -o "$SERVER_OPTIONS" -l "$LOG_FILE" -w start >/dev/null

echo "# server: $(psql_db -Atqc "SELECT pg_catalog.version()")"
echo "# settings: $(psql_db -Atqc "
  SELECT pg_catalog.string_agg(name || '=' || setting || COALESCE(unit, ''), ' ' ORDER BY name)
  FROM pg_catalog.pg_settings
  WHERE name IN ('fsync', 'synchronous_commit', 'full_page_writes', 'wal_sync_method',
                 'shared_buffers', 'work_mem', 'maintenance_work_mem', 'effective_cache_size',
                 'max_wal_size', 'checkpoint_timeout', 'autovacuum', 'jit',
                 'max_parallel_workers_per_gather', 'random_page_cost', 'wal_level')")"
echo "# rows=$ROWS sources=$SOURCES steady_cycles=$STEADY_CYCLES auto_explain=${BENCH_AUTO_EXPLAIN:-0}"

# ---------------------------------------------------------------------------
# Fixture: the relations and helpers the real migration chain requires
# (copied from public-ranking-season-publication.pg17.sh; leaderboard_ranks is
# the reviewed codec layout of 20261111140053, with its production indexes).
# ---------------------------------------------------------------------------
psql_db -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA arena;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA public, arena TO anon, authenticated, service_role;

CREATE TABLE arena.exchanges (id bigint PRIMARY KEY, name text NOT NULL);
CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  exchange_id bigint NOT NULL REFERENCES arena.exchanges(id),
  status text NOT NULL,
  serving_mode text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  timeframes_native integer[] NOT NULL DEFAULT '{}',
  timeframes_derived integer[] NOT NULL DEFAULT '{}'
);
CREATE TABLE arena.score_inputs (marker text);
CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL,
  actual_count integer NOT NULL,
  count_check_passed boolean NOT NULL,
  raw_object_id bigint,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE arena.leaderboard_entries (
  snapshot_id bigint NOT NULL,
  scraped_at timestamptz NOT NULL,
  trader_id bigint NOT NULL,
  rank integer NOT NULL
);
CREATE INDEX ON arena.leaderboard_entries (snapshot_id);
-- Synthetic per-trader metrics standing in for arena.trader_stats.
CREATE TABLE arena.fixture_trader_metrics (
  trader_id bigint PRIMARY KEY,
  trader_key text NOT NULL,
  handle text,
  roi_pct numeric,
  pnl_usd numeric,
  win_rate numeric,
  max_drawdown numeric,
  trades_count integer,
  sharpe_ratio numeric,
  sortino_ratio numeric
);

-- Stand-in for the legacy score-row RPC (same contract as the season fixture).
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
  WITH requested AS (
    SELECT (pg_catalog.rtrim(p_window, 'D'))::int AS timeframe
  ),
  boards AS (
    SELECT DISTINCT ON (snapshot.source_id)
      snapshot.id, snapshot.source_id, snapshot.scraped_at,
      COALESCE(NULLIF(pg_catalog.btrim(source_row.meta->>'legacy_platform'), ''),
               source_row.slug) AS platform
    FROM arena.leaderboard_snapshots AS snapshot
    JOIN arena.sources AS source_row ON source_row.id = snapshot.source_id
    JOIN requested ON requested.timeframe = snapshot.timeframe
    WHERE snapshot.count_check_passed
      AND source_row.status = 'active'
      AND source_row.serving_mode = 'serving'
    ORDER BY snapshot.source_id, snapshot.scraped_at DESC, snapshot.id DESC
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'platform', board.platform,
    'market_type', 'futures',
    'trader_key', metric.trader_key,
    'board_rank', entry.rank,
    'roi_pct', metric.roi_pct,
    'pnl_usd', metric.pnl_usd,
    'win_rate', metric.win_rate,
    'max_drawdown', metric.max_drawdown,
    'copiers', NULL,
    'trades_count', metric.trades_count,
    'sharpe_ratio', metric.sharpe_ratio,
    'sortino_ratio', metric.sortino_ratio,
    'calmar_ratio', NULL,
    'volatility_pct', NULL,
    'trader_kind', NULL,
    'handle', metric.handle,
    'avatar_url', NULL,
    'currency', 'USD',
    'as_of', board.scraped_at,
    'board_as_of', board.scraped_at
  ) ORDER BY board.platform, entry.rank), '[]'::jsonb)
  FROM boards AS board
  JOIN arena.leaderboard_entries AS entry
    ON entry.snapshot_id = board.id AND entry.scraped_at = board.scraped_at
  JOIN arena.fixture_trader_metrics AS metric ON metric.trader_id = entry.trader_id
  WHERE entry.rank <= p_per_platform_limit
    AND board.scraped_at > pg_catalog.statement_timestamp()
          - pg_catalog.make_interval(hours => p_max_age_hours)
    AND board.scraped_at <= pg_catalog.statement_timestamp() + interval '5 minutes'
$$;
REVOKE ALL ON FUNCTION public.arena_score_inputs_json(text, int, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arena_score_inputs_json(text, int, int) TO service_role;

CREATE TABLE public.trader_follows (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  trader_id text NOT NULL,
  source text
);

-- leaderboard_ranks in the reviewed codec layout (20261111140053).
CREATE SEQUENCE public.leaderboard_ranks_id_seq;
CREATE TABLE public.leaderboard_ranks (
  id bigint NOT NULL DEFAULT pg_catalog.nextval('public.leaderboard_ranks_id_seq'::pg_catalog.regclass),
  season_id text NOT NULL,
  source text NOT NULL,
  source_type text,
  source_trader_id text NOT NULL,
  rank integer,
  arena_score numeric(10,2),
  roi numeric(12,4),
  pnl numeric(18,2),
  win_rate numeric(5,2),
  max_drawdown numeric(5,2),
  followers integer,
  trades_count integer,
  handle text,
  avatar_url text,
  computed_at timestamp with time zone,
  profitability_score numeric(6,2),
  risk_control_score numeric(6,2),
  execution_score numeric(6,2),
  score_completeness text,
  trading_style text,
  avg_holding_hours numeric(10,2),
  style_confidence numeric(6,4),
  sharpe_ratio numeric(10,4),
  sortino_ratio numeric(10,4),
  profit_factor numeric(10,4),
  calmar_ratio numeric(10,4),
  trader_type text,
  is_outlier boolean,
  metrics_estimated boolean,
  rank_change integer,
  is_new boolean,
  copiers integer,
  arena_score_v4 numeric,
  arena_score_v3 numeric,
  score_factors jsonb,
  rank_publication_id uuid
) PARTITION BY LIST (season_id);
CREATE TABLE public.lr_7d PARTITION OF public.leaderboard_ranks FOR VALUES IN ('7D');
CREATE TABLE public.lr_30d PARTITION OF public.leaderboard_ranks FOR VALUES IN ('30D');
CREATE TABLE public.lr_90d PARTITION OF public.leaderboard_ranks FOR VALUES IN ('90D');
CREATE TABLE public.lr_default PARTITION OF public.leaderboard_ranks DEFAULT;
ALTER TABLE public.leaderboard_ranks
  ADD CONSTRAINT leaderboard_ranks_partitioned_pkey PRIMARY KEY (id, season_id),
  ADD CONSTRAINT leaderboard_ranks_partitioned_season_id_source_source_trade_key
    UNIQUE (season_id, source, source_trader_id),
  ADD CONSTRAINT chk_lr_part_arena_score
    CHECK ((arena_score IS NULL) OR ((arena_score >= 0) AND (arena_score <= 100))),
  ADD CONSTRAINT chk_lr_part_mdd
    CHECK ((max_drawdown IS NULL) OR ((max_drawdown >= 0) AND (max_drawdown <= 100))),
  ADD CONSTRAINT chk_lr_part_roi
    CHECK ((roi IS NULL) OR ((roi >= -10000) AND (roi <= 10000))),
  ADD CONSTRAINT leaderboard_ranks_block_unverified_okx_web3_solana
    CHECK (source <> 'okx_web3_solana'::text);
-- The five production indexes of 20261111140053 (the season fixture omits
-- them; every rank UPDATE has to maintain them, so the harness keeps them).
CREATE INDEX idx_leaderboard_ranks_diverse_v2 ON public.leaderboard_ranks
  USING btree (season_id, source, arena_score DESC NULLS LAST)
  INCLUDE (id, source_type, source_trader_id, rank, roi, pnl, win_rate, max_drawdown,
           followers, trades_count, handle, avatar_url, computed_at, profitability_score,
           risk_control_score, execution_score, score_completeness, trading_style,
           avg_holding_hours, style_confidence, sharpe_ratio, trader_type, is_outlier,
           copiers, sortino_ratio, profit_factor, calmar_ratio)
  WHERE ((arena_score > (0)::numeric) AND ((is_outlier IS NULL) OR (is_outlier = false)));
CREATE INDEX idx_lr_api_default ON public.leaderboard_ranks
  USING btree (season_id, arena_score DESC NULLS LAST)
  INCLUDE (source_trader_id, handle, source, source_type, roi, pnl, win_rate, max_drawdown,
           trades_count, followers, copiers, avatar_url, rank, rank_change, is_new,
           computed_at, profitability_score, risk_control_score, execution_score,
           score_completeness, trading_style, avg_holding_hours, sharpe_ratio,
           sortino_ratio, calmar_ratio, profit_factor, trader_type, is_outlier,
           metrics_estimated)
  WHERE ((arena_score IS NOT NULL) AND ((is_outlier IS NULL) OR (is_outlier = false))
         AND ((roi >= ('-50000'::integer)::numeric) AND (roi <= (50000)::numeric)));
CREATE INDEX idx_lr_part_season_rank ON public.leaderboard_ranks
  USING btree (season_id, rank);
CREATE INDEX idx_lr_part_season_score ON public.leaderboard_ranks
  USING btree (season_id, arena_score DESC);
CREATE INDEX idx_lr_part_source_season ON public.leaderboard_ranks
  USING btree (source, season_id, arena_score DESC);
ALTER TABLE public.leaderboard_ranks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read leaderboard_ranks" ON public.leaderboard_ranks
  FOR SELECT USING (true);
REVOKE ALL ON TABLE public.leaderboard_ranks FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.leaderboard_ranks TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.leaderboard_ranks TO service_role;

CREATE TABLE public.leaderboard_source_freshness (
  season_id text NOT NULL,
  source text NOT NULL,
  source_as_of timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  PRIMARY KEY (season_id, source)
);
GRANT SELECT, INSERT, UPDATE ON public.leaderboard_source_freshness TO service_role;

-- Minimal acquisition ledger (20260722030000) and attempt-bound binding.
CREATE TABLE arena.leaderboard_acquisition_attempts (
  attempt_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL,
  timeframe smallint NOT NULL,
  capture_contract text NOT NULL
);
CREATE TABLE arena.leaderboard_acquisition_outcomes (
  attempt_seq bigint PRIMARY KEY REFERENCES arena.leaderboard_acquisition_attempts(attempt_seq),
  terminal_state text NOT NULL,
  source_run_id text,
  source_payload_raw_object_id bigint,
  manifest_raw_object_id bigint
);
CREATE FUNCTION public.fixture_bind(
  p_snapshot_id bigint,
  p_contract text DEFAULT 'arena.ingest.leaderboard-acquisition-manifest@3',
  p_terminal_state text DEFAULT 'complete',
  p_run_char text DEFAULT 'b'
) RETURNS void LANGUAGE sql AS $$
  UPDATE arena.leaderboard_snapshots
     SET raw_object_id = COALESCE(raw_object_id, 9000000 + p_snapshot_id)
   WHERE id = p_snapshot_id;
  WITH attempt AS (
    INSERT INTO arena.leaderboard_acquisition_attempts (source_id, timeframe, capture_contract)
    SELECT source_id, timeframe, p_contract FROM arena.leaderboard_snapshots WHERE id = p_snapshot_id
    RETURNING attempt_seq
  )
  INSERT INTO arena.leaderboard_acquisition_outcomes
  SELECT attempt.attempt_seq, p_terminal_state, pg_catalog.repeat(p_run_char, 64),
         snapshot.raw_object_id, snapshot.raw_object_id + 1
  FROM attempt, arena.leaderboard_snapshots AS snapshot WHERE snapshot.id = p_snapshot_id;
$$;

-- One PASSED, attempt-bound 90D board per source for cycle p_cycle.
-- Cycle 0 creates the population; a later cycle changes every trader's
-- metrics (so scores and the global order move) and replaces the last ~5% of
-- each board with new traders.
CREATE FUNCTION public.bench_load_cycle(p_cycle integer, p_rows integer, p_slugs text[])
RETURNS integer
LANGUAGE plpgsql
AS $load$
DECLARE
  v_source integer;
  p_sources integer := pg_catalog.cardinality(p_slugs);
  v_board_rows integer;
  v_snapshot_id bigint;
  v_scraped_at timestamptz :=
    pg_catalog.statement_timestamp() - pg_catalog.make_interval(mins => 70 - 10 * p_cycle);
  v_churn integer;
  v_total integer := 0;
BEGIN
  PERFORM pg_catalog.setseed(0.4242 + p_cycle / 100.0);
  IF p_cycle = 0 THEN
    INSERT INTO arena.exchanges (id, name)
    SELECT source_no, 'Bench Exchange ' || source_no
    FROM pg_catalog.generate_series(1, p_sources) AS source_no;
    INSERT INTO arena.sources (id, slug, exchange_id, status, serving_mode, timeframes_native)
    SELECT source_no, p_slugs[source_no], source_no, 'active', 'serving', '{90}'
    FROM pg_catalog.generate_series(1, p_sources) AS source_no;
  ELSE
    UPDATE arena.fixture_trader_metrics
       SET roi_pct = pg_catalog.round(roi_pct * (0.85 + 0.30 * pg_catalog.random())::numeric, 4),
           pnl_usd = pg_catalog.round(pnl_usd * (0.85 + 0.30 * pg_catalog.random())::numeric, 2);
  END IF;

  FOR v_source IN 1..p_sources LOOP
    -- Spread the rows evenly; the first (p_rows mod p_sources) boards get one more.
    v_board_rows := p_rows / p_sources + (v_source <= p_rows % p_sources)::integer;
    v_churn := CASE WHEN p_cycle = 0 THEN 0 ELSE pg_catalog.ceil(v_board_rows * 0.05)::integer END;
    v_snapshot_id := v_source * 1000 + p_cycle * 2;

    -- Traders that join the board in this cycle (all of them in cycle 0).
    INSERT INTO arena.fixture_trader_metrics (
      trader_id, trader_key, handle, roi_pct, pnl_usd, win_rate, max_drawdown,
      trades_count, sharpe_ratio, sortino_ratio
    )
    SELECT
      v_source * 1000000 + p_cycle * 10000 + position_no,
      '0x' || pg_catalog.substr(pg_catalog.md5(v_source || ':' || p_cycle || ':' || position_no), 1, 30),
      'Trader ' || v_source || '-' || p_cycle || '-' || position_no,
      pg_catalog.round((5 + 395 * pg_catalog.power(pg_catalog.random(), 2))::numeric, 4),
      pg_catalog.round((500 + 400000 * pg_catalog.power(pg_catalog.random(), 3))::numeric, 2),
      pg_catalog.round((35 + 50 * pg_catalog.random())::numeric, 2),
      pg_catalog.round((3 + 45 * pg_catalog.random())::numeric, 2),
      (30 + 600 * pg_catalog.random())::integer,
      pg_catalog.round((0.3 + 3 * pg_catalog.random())::numeric, 4),
      pg_catalog.round((0.4 + 4 * pg_catalog.random())::numeric, 4)
    FROM pg_catalog.generate_series(
      CASE WHEN p_cycle = 0 THEN 1 ELSE v_board_rows - v_churn + 1 END, v_board_rows
    ) AS position_no;

    INSERT INTO arena.leaderboard_snapshots (
      id, source_id, timeframe, scraped_at, actual_count, count_check_passed
    ) VALUES (v_snapshot_id, v_source, 90, v_scraped_at, v_board_rows, true);

    -- Board position n is held by the newest trader created for that position.
    INSERT INTO arena.leaderboard_entries (snapshot_id, scraped_at, trader_id, rank)
    SELECT v_snapshot_id, v_scraped_at,
           v_source * 1000000
             + CASE WHEN position_no > v_board_rows - v_churn THEN p_cycle ELSE 0 END * 10000
             + position_no,
           position_no
    FROM pg_catalog.generate_series(1, v_board_rows) AS position_no;

    PERFORM public.fixture_bind(
      v_snapshot_id, p_run_char => pg_catalog.substr('abcdef', p_cycle + 1, 1)
    );
    v_total := v_total + v_board_rows;
  END LOOP;
  RETURN v_total;
END
$load$;
SQL

for migration in "${CHAIN[@]}"; do
  PGOPTIONS='-c client_min_messages=warning' psql_db -q -f "$MIGRATIONS/$migration" >/dev/null
done

# ---------------------------------------------------------------------------
# Driver: the real orchestrator, with every statement of the publication
# transaction timed on the client (round trip included).
# ---------------------------------------------------------------------------
cat >"$DRIVER" <<DRIVER_SOURCE
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'

import {
  createDefaultCohortScorer,
  pgRankPublicationDatabase,
  publishLeaderboardSeason,
} from '$ROOT_DIR/lib/rankings/publication/publish-season'

const { Pool } = createRequire('$ROOT_DIR/package.json')('pg')
const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: 'postgres',
  database: 'postgres',
  max: 2,
})

const STEPS: Array<[string, string]> = [
  ['INSERT INTO public.leaderboard_ranks', 'write_chunks'],
  ['public.cleanup_leaderboard_rank_publication', 'cleanup'],
  ['public.rerank_leaderboard_publication', 'rerank'],
  ['public.seal_leaderboard_rank_publication', 'seal'],
  ['public.claim_leaderboard_rank_generation', 'claim'],
  ['public.record_leaderboard_rank_publication_evidence', 'record_evidence'],
  ['public.release_leaderboard_rank_generation_lease', 'release_lease'],
  ['arena_score_inputs_publish_bundle', 'read_bundle'],
  ['COMMIT', 'commit'],
]
const totals = new Map<string, { ms: number; calls: number; max: number }>()
const record = (step: string, ms: number) => {
  const entry = totals.get(step) ?? { ms: 0, calls: 0, max: 0 }
  entry.ms += ms
  entry.calls += 1
  entry.max = Math.max(entry.max, ms)
  totals.set(step, entry)
}

const started = performance.now()
try {
  const result = await publishLeaderboardSeason('90D', {
    alert: () => undefined,
    database: pgRankPublicationDatabase(async () => {
      const client = await pool.connect()
      return {
        query: async (text: string, values?: readonly unknown[]) => {
          const step = STEPS.find(([marker]) => text.includes(marker))?.[1] ?? 'other_statements'
          const before = performance.now()
          try {
            return await client.query(text, values ? [...values] : undefined)
          } finally {
            record(step, performance.now() - before)
          }
        },
        release: (destroy?: boolean) => client.release(destroy),
      }
    }),
    scoreCohort: createDefaultCohortScorer(),
    minExpectedSources: 1,
  })
  const total = performance.now() - started
  let inStatements = 0
  for (const entry of totals.values()) inStatements += entry.ms
  record('client_scoring_and_js', total - inStatements)
  record('transaction_total', total)
  const chunks = totals.get('write_chunks')
  if (chunks) totals.set('write_chunk_slowest', { ms: chunks.max, calls: 1, max: chunks.max })
  process.stdout.write(
    'PUBLISHED ' + result.publishedRankCount + ' ' + result.deletedRankCount + ' '
      + result.sources.length + ' ' + (chunks?.calls ?? 0) + '\n'
  )
  for (const [step, entry] of totals) {
    process.stdout.write('STEP ' + step + ' ' + entry.ms.toFixed(1) + '\n')
  }
} catch (error) {
  process.stdout.write('FAILED ' + (error instanceof Error ? error.message : String(error)) + '\n')
  process.exitCode = 1
} finally {
  await pool.end()
}
DRIVER_SOURCE

RESULTS="$TMP_ROOT/results.txt"
: >"$RESULTS"

run_cycle() {
  local cycle="$1" phase="$2" loaded out published
  loaded="$(psql_db -Atqc "SELECT public.bench_load_cycle($cycle, $ROWS, '{$SLUG_ARRAY}'::text[])")"
  # Planner statistics for the fixture tables, as autovacuum keeps them in a
  # long-running database; leaderboard_ranks is left to autovacuum alone.
  psql_db -qc "ANALYZE arena.leaderboard_entries, arena.fixture_trader_metrics, arena.leaderboard_snapshots"
  out="$(cd "$ROOT_DIR" && PGHOST="$SOCKET_DIR" PGPORT="$PORT" \
    npx --no-install tsx "$DRIVER" 2>&1)" || {
    echo "cycle $cycle failed:" >&2
    echo "$out" | tail -20 >&2
    exit 1
  }
  published="$(sed -n 's/^PUBLISHED \([0-9]*\) .*/\1/p' <<<"$out")"
  echo "# cycle=$cycle phase=$phase loaded=$loaded $(sed -n \
    's/^PUBLISHED \([0-9]*\) \([0-9]*\) \([0-9]*\) \([0-9]*\)$/published=\1 deleted=\2 sources=\3 write_chunks=\4/p' <<<"$out")" \
    "table_rows=$(psql_db -Atqc "SELECT pg_catalog.count(*) FROM public.leaderboard_ranks WHERE season_id = '90D'")" \
    "eligible_ranked=$(psql_db -Atqc "SELECT pg_catalog.count(*) FROM public.leaderboard_ranks AS ranks
       WHERE season_id = '90D' AND rank IS NOT NULL
         AND arena.leaderboard_rank_row_is_public_eligible(ranks, pg_catalog.statement_timestamp())")" \
    "lr_90d_bytes=$(psql_db -Atqc "SELECT pg_catalog.pg_total_relation_size('public.lr_90d')")"
  if [[ "$published" != "$ROWS" ]]; then
    echo "cycle $cycle published $published rows, expected $ROWS" >&2
    exit 1
  fi
  sed -n 's/^STEP \([a-z_]*\) \([0-9.]*\)$/\1 \2/p' <<<"$out" | while read -r step ms; do
    echo "step=$step phase=$phase cycle=$cycle rows=$published ms=$ms"
    echo "$phase $step $ms" >>"$RESULTS"
  done
}

run_cycle 0 cold
for ((cycle = 1; cycle <= STEADY_CYCLES; cycle++)); do
  run_cycle "$cycle" steady
done

if ((STEADY_CYCLES > 0)); then
  echo "# steady cycles: min / median / max (ms)"
  awk '$1 == "steady" { print $2, $3 }' "$RESULTS" | sort -k1,1 -k2,2n | awk -v rows="$ROWS" '
    function flush() {
      if (count == 0) return
      median = (count % 2) ? values[(count + 1) / 2] : (values[count / 2] + values[count / 2 + 1]) / 2
      printf "summary step=%s phase=steady rows=%s runs=%d min_ms=%.1f median_ms=%.1f max_ms=%.1f\n",
        step, rows, count, values[1], median, values[count]
    }
    $1 != step { flush(); step = $1; count = 0 }
    { values[++count] = $2 }
    END { flush() }'
fi
