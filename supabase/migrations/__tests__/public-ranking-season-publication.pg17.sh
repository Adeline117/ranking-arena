#!/usr/bin/env bash

# PostgreSQL 17 end-to-end proof that the season publication orchestrator
# (lib/rankings/publication/publish-season.ts) turns synthetic arena raw
# boards into a served public_ranked_leaderboard season, and that a missing or
# stale expected source leaves the public view empty / on its previous cohort.
#
# It owns an isolated cluster on a private socket and never connects to
# application data. The real migration chain is applied in launch order on a
# minimal fixture of the tables those migrations require:
#   20260718130000 count_trader_account_followers
#   20260718134000 freshness_expected_sources
#   20260721175746 arena_score_inputs_publish_bundle
#   20260725012000 strengthen_arena_score_publish_evidence
#   20260724235000 leaderboard_publication_mutation_fence   (seal / rerank)
#   20260725013000 cleanup_leaderboard_rank_publication
#   20260725014000 strengthen_leaderboard_publication_proof_authority
#   20260725015000 leaderboard_rank_generation_claim
#   20260725015500 bound_leaderboard_rank_generation_batches
#   20260816151614 public_ranked_leaderboard
#   20260816184500 public_ranked_leaderboard_source_freshness_gate
#   20261113010326 release_leaderboard_rank_generation_lease_after_seal
#   20261113011058 leaderboard_publication_source_isolation
#   20261113110430 rank_publication_source_evidence_binding
# leaderboard_ranks itself is created in the reviewed codec layout of
# 20261111140053 (the forward repair that rebuilds it in production).

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
DRIVER="$ROOT_DIR/supabase/migrations/__tests__/public-ranking-season-publication.driver.mts"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
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
for migration in "${CHAIN[@]}"; do
  if [[ ! -f "$MIGRATIONS/$migration" ]]; then
    echo "Required migration not found: $migration" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/public-ranking-season-publication-pg17.XXXXXX)"
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
    tail -80 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_db() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

assert_equal() {
  if [[ "$2" != "$3" ]]; then
    echo "$1: expected '$2', got '$3'" >&2
    exit 1
  fi
}

publish() {
  # The orchestrator logs to stdout; the driver's verdict is its RESULT line.
  (cd "$ROOT_DIR" && PGHOST="$SOCKET_DIR" PGPORT="$PORT" npx --no-install tsx "$DRIVER" "$1") \
    | sed -n 's/^RESULT //p' | tail -1
}

json_field() {
  node -e 'const v=JSON.parse(process.argv[1]); const p=process.argv[2].split("."); let x=v; for (const k of p) x=x?.[k]; console.log(typeof x === "object" ? JSON.stringify(x) : String(x))' "$1" "$2"
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

# ---------------------------------------------------------------------------
# Fixture: the relations and helpers the real migration chain requires.
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

-- Stand-in for the legacy score-row RPC. It honours the same contract the
-- bundle migrations verify: SQL, definer, pinned search_path, read-only body,
-- and rows only for the latest PASSED, non-stale board of each serving source.
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
    CHECK ((roi IS NULL) OR ((roi >= -10000) AND (roi <= 10000)));
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

-- Synthetic registry: three active serving 90D sources, one shadow source.
INSERT INTO arena.exchanges (id, name) VALUES
  (1, 'Binance'), (2, 'Bybit'), (3, 'Hyperliquid'), (4, 'OKX');
INSERT INTO arena.sources (id, slug, exchange_id, status, serving_mode, timeframes_native)
VALUES
  (1, 'binance_futures', 1, 'active', 'serving', '{90}'),
  (2, 'bybit', 2, 'active', 'serving', '{90}'),
  (3, 'hyperliquid', 3, 'active', 'serving', '{90}'),
  (4, 'okx_futures', 4, 'active', 'shadow', '{90}');

INSERT INTO arena.fixture_trader_metrics (
  trader_id, trader_key, handle, roi_pct, pnl_usd, win_rate, max_drawdown,
  trades_count, sharpe_ratio, sortino_ratio
) VALUES
  (11, 'bn-ace',   'Ace',    180.5, 52000,   71.2, 12.5, 140, 2.4, 3.1),
  (12, 'bn-bolt',  'Bolt',    95.0, 18000,   63.0, 18.0, 90,  1.8, 2.2),
  (13, 'bn-cove',  'Cove',    40.2,  6100,   55.5, 22.0, 60,  1.1, 1.5),
  (21, 'by-dune',  'Dune',   130.0, 41000,   68.0, 15.0, 120, 2.0, 2.6),
  (22, 'by-echo',  'Echo',    20.0,  2500,   51.0, 30.0, 45,  0.7, 0.9),
  -- Missing win rate: scored as partial and never published.
  (23, 'by-flux',  'Flux',    75.0, 15000,   NULL, 20.0, 80,  1.5, 1.9),
  (31, 'hl-gale',  'Gale',   210.0, 99000,   74.0, 10.0, 200, 2.9, 3.6),
  (32, 'hl-haze',  'Haze',    60.0,  9000,   58.0, 25.0, 70,  1.3, 1.6),
  -- Second-cycle trader that replaces bn-cove on the binance board.
  (14, 'bn-dawn',  'Dawn',    66.0, 11000,   60.0, 19.0, 75,  1.4, 1.8);

-- binance and hyperliquid are fresh; bybit's only PASSED board is 50h old.
INSERT INTO arena.leaderboard_snapshots VALUES
  (101, 1, 90, pg_catalog.statement_timestamp() - interval '1 hour', 3, true),
  (201, 2, 90, pg_catalog.statement_timestamp() - interval '50 hours', 3, true),
  (301, 3, 90, pg_catalog.statement_timestamp() - interval '2 hours', 2, true);
INSERT INTO arena.leaderboard_entries (snapshot_id, scraped_at, trader_id, rank)
SELECT snapshot.id, snapshot.scraped_at, input.trader_id, input.rank
FROM (VALUES
  (101, 11, 1), (101, 12, 2), (101, 13, 3),
  (201, 21, 1), (201, 22, 2), (201, 23, 3),
  (301, 31, 1), (301, 32, 2)
) AS input(snapshot_id, trader_id, rank)
JOIN arena.leaderboard_snapshots AS snapshot ON snapshot.id = input.snapshot_id;
SQL

for migration in "${CHAIN[@]}"; do
  PGOPTIONS='-c client_min_messages=warning' psql_db -q -f "$MIGRATIONS/$migration" >/dev/null
done

view_count() {
  psql_db -Atqc "SELECT pg_catalog.count(*) FROM public.public_ranked_leaderboard WHERE season_id = '90D'"
}
anon_view() {
  psql_db -Atqc "SET ROLE anon; SELECT COALESCE(pg_catalog.string_agg(
    rank || ':' || source || ':' || source_trader_id, ',' ORDER BY rank), '')
    FROM public.public_ranked_leaderboard WHERE season_id = '90D'"
}

# ---------------------------------------------------------------------------
# Isolation: one of three expected sources (bybit) is stale -> bybit is
# isolated and the other two publish as one sealed season.
# ---------------------------------------------------------------------------
OUT="$(publish 90D)"
assert_equal "stale minority source is isolated, not refused" "true" "$(json_field "$OUT" ok)"
[[ "$(json_field "$OUT" result.isolatedSources)" == '[{"source":"bybit","reasons":["stale"],'* ]] || {
  echo "isolated source is not reported: $OUT" >&2
  exit 1
}
assert_equal "isolated publication serves the other sources" "5" "$(view_count)"
assert_equal "bybit is not served while isolated" "0" "$(psql_db -Atqc "
  SELECT pg_catalog.count(*) FROM public.public_ranked_leaderboard WHERE source = 'bybit'")"
assert_equal "isolation row and event are recorded" "bybit:{stale}|1" "$(psql_db -Atqc "
  SELECT (SELECT pg_catalog.string_agg(filter_source || ':' || reasons::text, ',')
            FROM arena.leaderboard_publication_source_isolations WHERE season_id = '90D') || '|' ||
         (SELECT pg_catalog.count(*) FROM arena.leaderboard_publication_source_isolation_events
           WHERE filter_source = 'bybit' AND action = 'isolated')")"
assert_equal "monitoring RPC lists the isolation for service_role" "90D:bybit:{stale}" \
  "$(psql_db -Atqc "SET ROLE service_role; SELECT season_id || ':' || filter_source || ':' || reasons::text
     FROM public.arena_publication_source_isolations()")"
assert_equal "monitoring RPC is not anon-callable" "f" "$(psql_db -Atqc "
  SELECT pg_catalog.has_function_privilege('anon', 'public.arena_publication_source_isolations()', 'EXECUTE')")"
assert_equal "serving head covers exactly the non-isolated sources" "binance_futures,hyperliquid" \
  "$(psql_db -Atqc "SELECT pg_catalog.string_agg(source, ',' ORDER BY source)
     FROM arena.public_ranked_leaderboard_serving_sources WHERE season_id = '90D'")"
[[ "$(json_field "$OUT" alerts)" == *'"code":"sources_isolated"'* ]] || {
  echo "isolation did not alert: $OUT" >&2
  exit 1
}
assert_equal "isolation events are append-only" "rejected" "$(psql_db -Atqc "
  DELETE FROM arena.leaderboard_publication_source_isolation_events" >/dev/null 2>&1 \
  && echo deleted || echo rejected)"

# ---------------------------------------------------------------------------
# Positive: bybit publishes a fresh board -> it rejoins; the whole season is served.
# ---------------------------------------------------------------------------
psql_db -q <<'SQL'
INSERT INTO arena.leaderboard_snapshots VALUES
  (202, 2, 90, pg_catalog.statement_timestamp() - interval '30 minutes', 3, true);
INSERT INTO arena.leaderboard_entries (snapshot_id, scraped_at, trader_id, rank)
SELECT 202, scraped_at, input.trader_id, input.rank
FROM arena.leaderboard_snapshots, (VALUES (21, 1), (22, 2), (23, 3)) AS input(trader_id, rank)
WHERE id = 202;
SQL

OUT="$(publish 90D)"
assert_equal "fresh season publishes" "true" "$(json_field "$OUT" ok)"
COHORT_ONE="$(json_field "$OUT" result.scoreCohortId)"
assert_equal "published rank count (partial by-flux excluded)" "7" \
  "$(json_field "$OUT" result.publishedRankCount)"
assert_equal "bybit is reported restored" '["bybit"]' "$(json_field "$OUT" result.restoredSources)"
assert_equal "exclusion reasons are reported" '{"filtered_by_scorer":1}' \
  "$(json_field "$OUT" result.exclusions.byReason)"
assert_equal "isolation rows cleared, restore event recorded" "0|1" "$(psql_db -Atqc "
  SELECT (SELECT pg_catalog.count(*) FROM arena.leaderboard_publication_source_isolations) || '|' ||
         (SELECT pg_catalog.count(*) FROM arena.leaderboard_publication_source_isolation_events
           WHERE filter_source = 'bybit' AND action = 'restored')")"
assert_equal "public view row count" "7" "$(view_count)"
assert_equal "every source is bound with its evidence grade" \
  '{"bybit":"count_check_only","hyperliquid":"count_check_only","binance_futures":"count_check_only"}' \
  "$(json_field "$OUT" result.evidenceGrades)"
assert_equal "evidence rows bind the exact passed snapshots" "binance_futures:{101},bybit:{202},hyperliquid:{301}" \
  "$(psql_db -Atqc "SELECT string_agg(source || ':' || snapshot_ids::text, ',' ORDER BY source)
     FROM arena.leaderboard_rank_publication_source_evidence WHERE score_cohort_id = '$COHORT_ONE'")"
assert_equal "anon sees the served evidence level per source" "binance_futures:count_check_only,bybit:count_check_only,hyperliquid:count_check_only" \
  "$(psql_db -Atqc "SET ROLE anon; SELECT string_agg(source || ':' || evidence_grade, ',' ORDER BY source)
     FROM public.public_ranked_leaderboard_source_evidence WHERE season_id = '90D'")"
if psql_db -qc "DELETE FROM arena.leaderboard_rank_publication_source_evidence" >/dev/null 2>&1; then
  echo "publication evidence is not immutable" >&2; exit 1
fi
EVIDENCE_ERROR="$(psql_db -Atqc "SELECT public.record_leaderboard_rank_publication_evidence('90D',
  '$COHORT_ONE', '[]'::jsonb)" 2>&1 || true)"
[[ "$EVIDENCE_ERROR" == *"only by the transaction that sealed the cohort"* ]] || {
  echo "evidence was recordable outside the sealing transaction: $EVIDENCE_ERROR" >&2; exit 1
}

# Ranks are 1..N, follow arena_score DESC, and every row carries the cohort.
assert_equal "view rank order matches arena_score" "t" "$(psql_db -Atqc "
  SELECT pg_catalog.bool_and(view_row.rank = expected.expected_rank)
     AND pg_catalog.count(*) = 7
     AND pg_catalog.min(view_row.rank) = 1 AND pg_catalog.max(view_row.rank) = 7
  FROM public.public_ranked_leaderboard AS view_row
  JOIN (
    SELECT id, pg_catalog.row_number() OVER (ORDER BY arena_score DESC, id) AS expected_rank
    FROM public.leaderboard_ranks WHERE season_id = '90D'
  ) AS expected ON expected.id = view_row.id
  WHERE view_row.season_id = '90D'")"
assert_equal "every 90D row carries the sealed cohort" "7" "$(psql_db -Atqc "
  SELECT pg_catalog.count(*) FROM public.leaderboard_ranks
  WHERE season_id = '90D' AND rank_publication_id = '$COHORT_ONE'")"
assert_equal "partial-metric trader is not public" "0" "$(psql_db -Atqc "
  SELECT pg_catalog.count(*) FROM public.public_ranked_leaderboard
  WHERE source_trader_id = 'by-flux'")"
assert_equal "anon reads the same served season" "7" "$(psql_db -Atqc "
  SET ROLE anon; SELECT pg_catalog.count(*) FROM public.public_ranked_leaderboard")"

# computed_at is the publication clock (now), and source watermarks equal the
# PASSED board scraped_at of each source.
assert_equal "computed_at is current" "t" "$(psql_db -Atqc "
  SELECT pg_catalog.bool_and(computed_at BETWEEN pg_catalog.now() - interval '5 minutes'
                                             AND pg_catalog.now() + interval '1 minute')
  FROM public.public_ranked_leaderboard")"
assert_equal "source watermarks equal board scraped_at" "binance_futures:true,bybit:true,hyperliquid:true" \
  "$(psql_db -Atqc "
  SELECT pg_catalog.string_agg(serving.source || ':' || (serving.source_as_of = board.scraped_at),
                               ',' ORDER BY serving.source)
  FROM arena.public_ranked_leaderboard_serving_sources AS serving
  JOIN arena.sources AS source_row ON source_row.slug = serving.source
  JOIN LATERAL (
    SELECT snapshot.scraped_at FROM arena.leaderboard_snapshots AS snapshot
    WHERE snapshot.source_id = source_row.id AND snapshot.count_check_passed
    ORDER BY snapshot.scraped_at DESC LIMIT 1
  ) AS board ON true
  WHERE serving.season_id = '90D'")"
assert_equal "serving head is valid for ~48h" "t" "$(psql_db -Atqc "
  SELECT rank_valid_until > pg_catalog.now() + interval '47 hours'
  FROM arena.public_ranked_leaderboard_serving_heads WHERE season_id = '90D'")"
FIRST_VIEW="$(anon_view)"

# ---------------------------------------------------------------------------
# Negative 2: four new expected sources without any board (4/7 > half) ->
# refusal; nothing is written and the previous cohort is kept.
# ---------------------------------------------------------------------------
psql_db -q <<'SQL'
INSERT INTO arena.exchanges (id, name) VALUES (5, 'Gate'), (6, 'MEXC'), (7, 'KuCoin'), (8, 'HTX');
INSERT INTO arena.sources (id, slug, exchange_id, status, serving_mode, timeframes_native) VALUES
  (5, 'gate_futures', 5, 'active', 'serving', '{90}'),
  (6, 'mexc_futures', 6, 'active', 'serving', '{90}'),
  (7, 'kucoin_futures', 7, 'active', 'serving', '{90}'),
  (8, 'htx_futures', 8, 'active', 'serving', '{90}');
SQL
COUNTS_BEFORE="$(psql_db -Atqc "
  SELECT (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_generation_claims) || '|' ||
         (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_publications) || '|' ||
         (SELECT pg_catalog.count(*) FROM arena.leaderboard_publication_source_isolation_events)")"
OUT="$(publish 90D)"
assert_equal "majority-missing season is refused" "false" "$(json_field "$OUT" ok)"
assert_equal "majority refusal code" "expected_source_not_fresh" "$(json_field "$OUT" code)"
[[ "$(json_field "$OUT" message)" == *"more than 50%"*"gate_futures(missing)"* ]] || {
  echo "majority refusal has an unexpected message: $OUT" >&2
  exit 1
}
[[ "$(json_field "$OUT" alerts)" == *'"severity":"critical","code":"season_publication_refused"'* ]] || {
  echo "refusal did not alert: $OUT" >&2
  exit 1
}
assert_equal "refusal wrote no claim, receipt, isolation or event" "$COUNTS_BEFORE|0" "$(psql_db -Atqc "
  SELECT (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_generation_claims) || '|' ||
         (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_publications) || '|' ||
         (SELECT pg_catalog.count(*) FROM arena.leaderboard_publication_source_isolation_events) || '|' ||
         (SELECT pg_catalog.count(*) FROM arena.leaderboard_publication_source_isolations)")"
# The registry change alone invalidates the old head (expected set changed),
# which is the database's own rule; restoring it re-serves the unchanged
# previous cohort because the refusal wrote nothing.
psql_db -qc "UPDATE arena.sources SET serving_mode = 'shadow' WHERE id IN (5, 6, 7, 8)"
assert_equal "previous cohort still served after refusal" "$FIRST_VIEW" "$(anon_view)"

# ---------------------------------------------------------------------------
# Negative 3 (database side): even if a caller skipped the orchestrator's gate,
# a seal that omits an expected source cannot create a serving head.
# ---------------------------------------------------------------------------
psql_db -qc "UPDATE arena.sources SET serving_mode = 'serving' WHERE slug = 'okx_futures'"
SEAL_ERROR="$(psql_db -Atq 2>&1 <<SQL || true
BEGIN;
UPDATE public.leaderboard_ranks SET rank_publication_id = '00000000-0000-4000-8000-000000000001'
WHERE season_id = '90D';
SELECT public.seal_leaderboard_rank_publication('90D', '00000000-0000-4000-8000-000000000001',
  (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
     'source', source_row.source,
     'source_as_of', pg_catalog.now() - interval '10 minutes',
     'trader_ids', COALESCE((SELECT pg_catalog.jsonb_agg(source_trader_id)
                             FROM public.leaderboard_ranks AS ranks
                             WHERE ranks.season_id = '90D' AND ranks.source = source_row.source), '[]'::jsonb)))
   FROM (VALUES ('binance_futures'), ('bybit'), ('hyperliquid')) AS source_row(source)));
COMMIT;
SQL
)"
[[ "$SEAL_ERROR" == *"freshness witness is incomplete"* ]] || {
  echo "partial seal was not rejected by the database: $SEAL_ERROR" >&2
  exit 1
}
psql_db -qc "UPDATE arena.sources SET serving_mode = 'shadow' WHERE slug = 'okx_futures'"
assert_equal "rejected partial seal leaves the previous cohort served" "$FIRST_VIEW" "$(anon_view)"

# The successful publication released its own lease inside its transaction.
assert_equal "sealed publication released its claim lease" "sealed|" "$(psql_db -Atqc "
  SELECT phase || '|' || COALESCE(lease_expires_at::text, '')
  FROM arena.leaderboard_rank_generation_heads WHERE season_id = '90D'")"

# A transaction that did not seal the cohort cannot release a live lease.
psql_db -q >/dev/null <<'SQL'
BEGIN;
SELECT public.claim_leaderboard_rank_generation('90D',
  '00000000-0000-4000-8000-0000000000c1', repeat('a', 64), 1, 1, now(), 15);
COMMIT;
SQL
RELEASE_ERROR="$(psql_db -Atqc "SELECT public.release_leaderboard_rank_generation_lease('90D',
  '00000000-0000-4000-8000-0000000000c1')" 2>&1 || true)"
[[ "$RELEASE_ERROR" == *"only by the transaction that sealed it"* ]] || {
  echo "unsealed lease release was not refused: $RELEASE_ERROR" >&2
  exit 1
}

# A live lease held by another (e.g. crashed or concurrent) publisher still
# blocks the season until it expires.
OUT="$(publish 90D)"
assert_equal "a publication inside a foreign live lease is refused" "false" "$(json_field "$OUT" ok)"
[[ "$(json_field "$OUT" message)" == *"active lease"* ]] || {
  echo "lease refusal has an unexpected reason: $OUT" >&2
  exit 1
}
assert_equal "lease refusal keeps the previous cohort served" "$FIRST_VIEW" "$(anon_view)"
sleep 16

# ---------------------------------------------------------------------------
# Positive 2: next cycle -> a new cohort replaces the old one atomically and
# rows that left the board are removed.
# ---------------------------------------------------------------------------
psql_db -q <<'SQL'
INSERT INTO arena.leaderboard_snapshots VALUES
  (102, 1, 90, pg_catalog.statement_timestamp() - interval '5 minutes', 3, true);
INSERT INTO arena.leaderboard_entries (snapshot_id, scraped_at, trader_id, rank)
SELECT 102, scraped_at, input.trader_id, input.rank
FROM arena.leaderboard_snapshots, (VALUES (11, 1), (12, 2), (14, 3)) AS input(trader_id, rank)
WHERE id = 102;
SQL
# Attempt-bound capture for binance's new board: a metric-trust run exists.
psql_db -q <<'SQL'
CREATE TABLE arena.metric_trust_runs (
  source_run_id text PRIMARY KEY, snapshot_id bigint NOT NULL, manifest_raw_object_id bigint NOT NULL
);
UPDATE arena.leaderboard_snapshots SET raw_object_id = 9001 WHERE id = 102;
INSERT INTO arena.metric_trust_runs VALUES (repeat('a', 64), 102, 9002);
SQL
OUT="$(publish 90D)"
assert_equal "second cycle publishes" "true" "$(json_field "$OUT" ok)"
COHORT_TWO="$(json_field "$OUT" result.scoreCohortId)"
[[ "$COHORT_TWO" != "$COHORT_ONE" ]] || { echo "second cycle reused the cohort" >&2; exit 1; }
assert_equal "second cycle deleted the departed trader" "1" "$(json_field "$OUT" result.deletedRankCount)"
assert_equal "view serves only the new cohort" "7|0|1" "$(psql_db -Atqc "
  SELECT pg_catalog.count(*) || '|' ||
         pg_catalog.count(*) FILTER (WHERE source_trader_id = 'bn-cove') || '|' ||
         pg_catalog.count(*) FILTER (WHERE source_trader_id = 'bn-dawn')
  FROM public.public_ranked_leaderboard WHERE season_id = '90D'")"
assert_equal "every served row is the new cohort" "7" "$(psql_db -Atqc "
  SELECT pg_catalog.count(*) FROM public.leaderboard_ranks
  WHERE season_id = '90D' AND rank_publication_id = '$COHORT_TWO'")"
assert_equal "generation sequence advanced past the foreign claim" "4" \
  "$(json_field "$OUT" result.generationSeq)"
assert_equal "second cycle released its lease" "true" "$(json_field "$OUT" result.leaseReleased)"
assert_equal "attempt-bound source is graded and traceable to run/manifest/RAW" \
  "attempt_bound|{102}|{9001}|{$(printf 'a%.0s' {1..64})}|{9002}" \
  "$(psql_db -Atqc "SELECT evidence_grade || '|' || snapshot_ids::text || '|' || raw_object_ids::text
       || '|' || source_run_ids::text || '|' || manifest_raw_object_ids::text
     FROM arena.leaderboard_rank_publication_source_evidence
     WHERE score_cohort_id = '$COHORT_TWO' AND source = 'binance_futures'")"

# ---------------------------------------------------------------------------
# Positive 3: an immediate re-publication is no longer blocked by the previous
# run's lease (it was released in the sealing transaction).
# ---------------------------------------------------------------------------
OUT="$(publish 90D)"
assert_equal "immediate re-publication succeeds" "true" "$(json_field "$OUT" ok)"
assert_equal "immediate re-publication is generation 5" "5" "$(json_field "$OUT" result.generationSeq)"
assert_equal "view still serves 7 rows" "7" "$(view_count)"

# ---------------------------------------------------------------------------
# Public snapshot readers (20261113012028): anon RPCs serve only sealed, fresh
# boards. Extend the fixture with the reader columns, install marker-bearing
# stand-ins for the 20261111134416 bodies, then apply the forward migration.
# ---------------------------------------------------------------------------
psql_db -q <<'SQL'
ALTER TABLE arena.exchanges ADD COLUMN slug text;
UPDATE arena.exchanges SET slug = pg_catalog.lower(name);
ALTER TABLE arena.sources
  ADD COLUMN adapter_slug text,
  ADD COLUMN currency text NOT NULL DEFAULT 'USDT',
  ADD COLUMN product_type text NOT NULL DEFAULT 'futures';
UPDATE arena.sources SET adapter_slug = slug;
ALTER TABLE arena.leaderboard_entries
  ADD COLUMN timeframe smallint NOT NULL DEFAULT 90,
  ADD COLUMN headline_roi numeric,
  ADD COLUMN headline_pnl numeric,
  ADD COLUMN headline_win_rate numeric,
  ADD COLUMN currency text,
  ADD COLUMN raw jsonb;
UPDATE arena.leaderboard_entries AS entry
SET headline_roi = metric.roi_pct, headline_pnl = metric.pnl_usd,
    headline_win_rate = metric.win_rate
FROM arena.fixture_trader_metrics AS metric WHERE metric.trader_id = entry.trader_id;
CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL,
  exchange_trader_id text NOT NULL,
  nickname text, trader_kind text, avatar_url_mirror text, avatar_url_origin text,
  wallet_address text, bot_strategy text
);
INSERT INTO arena.traders (id, source_id, exchange_trader_id, nickname)
SELECT metric.trader_id, (metric.trader_id / 10)::smallint, metric.trader_key, metric.handle
FROM arena.fixture_trader_metrics AS metric;
CREATE TABLE arena.trader_stats (
  trader_id bigint NOT NULL, timeframe smallint NOT NULL, as_of timestamptz,
  currency text, roi numeric, pnl numeric, sharpe numeric, mdd numeric, win_rate numeric,
  win_positions integer, total_positions integer, copier_pnl numeric, copier_count integer,
  aum numeric, volume numeric, profit_share_rate numeric, holding_duration_avg interval,
  trading_preferences jsonb, extras jsonb
);
INSERT INTO arena.trader_stats (trader_id, timeframe, as_of, roi, mdd)
VALUES (11, 90, pg_catalog.now() - interval '1 hour', 180.5, 12.5),
       (12, 90, pg_catalog.now() - interval '20 days', 95.0, 18.0);
CREATE TABLE arena.trader_series (
  trader_id bigint, timeframe smallint, metric text, ts timestamptz, value numeric
);

-- Stand-ins carrying the Bitget quarantine marker the forward migration
-- requires (the real bodies need the full production substrate).
CREATE FUNCTION public.arena_weekly_leaders(p_limit integer DEFAULT 25) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT '{}'::jsonb /* bitget-bot-cumulative-public-reader-quarantine@1 */ $$;
CREATE FUNCTION public.arena_exchange_rankings(p_timeframe integer) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT '{}'::jsonb /* bitget-bot-cumulative-public-reader-quarantine@1 */ $$;
CREATE FUNCTION public.arena_first_screen(p_source text, p_trader text) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT '{}'::jsonb /* bitget-bot-cumulative-public-reader-quarantine@1 */ $$;
CREATE FUNCTION public.arena_core_modules(p_source text, p_trader text, p_timeframe integer)
  RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT '{}'::jsonb /* bitget-bot-cumulative-public-reader-quarantine@1 */ $$;

-- Boards the old readers would have served:
--   * okx_futures (active shadow, never sealed) has a fresh passed 90D board;
--   * binance has a NEWER passed 90D board than its sealed watermark;
--   * binance has a fresh passed 7D board, but no 7D season is sealed;
--   * hyperliquid has a 60h-old 30D board and an empty fresh 7D board.
INSERT INTO arena.leaderboard_snapshots VALUES
  (401, 4, 90, pg_catalog.now() - interval '10 minutes', 1, true),
  (103, 1, 90, pg_catalog.now() - interval '1 minute', 1, true),
  (104, 1, 7, pg_catalog.now() - interval '1 hour', 1, true),
  (302, 3, 30, pg_catalog.now() - interval '60 hours', 1, true),
  (303, 3, 7, pg_catalog.now() - interval '1 hour', 0, true);
INSERT INTO arena.traders (id, source_id, exchange_trader_id, nickname)
VALUES (41, 4, 'okx-only', 'OkxOnly');
INSERT INTO arena.leaderboard_entries
  (snapshot_id, scraped_at, trader_id, rank, timeframe, headline_roi)
SELECT snapshot.id, snapshot.scraped_at, input.trader_id, 1, snapshot.timeframe, input.roi
FROM (VALUES (401, 41, 999.0), (103, 11, 555.0), (104, 11, 77.0), (302, 31, 12.0))
  AS input(snapshot_id, trader_id, roi)
JOIN arena.leaderboard_snapshots AS snapshot ON snapshot.id = input.snapshot_id;
SQL
PGOPTIONS='-c client_min_messages=warning' psql_db -q \
  -f "$MIGRATIONS/20261113012028_public_snapshot_readers_sealed_freshness.sql" >/dev/null

anon_rpc() {
  psql_db -Atqc "SET ROLE anon; SELECT $1"
}
assert_equal "exchange rankings list only sealed sources" "binance_futures,bybit,hyperliquid" \
  "$(anon_rpc "pg_catalog.string_agg(r->>'source', ',' ORDER BY r->>'source')
     FROM pg_catalog.jsonb_array_elements(public.arena_exchange_rankings(90)->'rows') AS r")"
assert_equal "exchange rankings read the sealed board, not a newer unsealed one" "3" \
  "$(anon_rpc "(r->>'rankedTraders')
     FROM pg_catalog.jsonb_array_elements(public.arena_exchange_rankings(90)->'rows') AS r
     WHERE r->>'source' = 'binance_futures'")"
assert_equal "weekly leaders serve nothing without a sealed 7D season" "[]" \
  "$(anon_rpc "public.arena_weekly_leaders(25)->'rows'")"
assert_equal "first screen hides 60h-old and empty boards" "90" \
  "$(anon_rpc "pg_catalog.string_agg(e->>'timeframe', ',')
     FROM pg_catalog.jsonb_array_elements(
       public.arena_first_screen('hyperliquid', 'hl-gale')->'entries') AS e")"
assert_equal "core modules flag stale stats" "false|true" \
  "$(anon_rpc "(public.arena_core_modules('binance_futures', 'bn-ace', 90)->>'stale') || '|' ||
              (public.arena_core_modules('binance_futures', 'bn-bolt', 90)->>'stale')")"
assert_equal "sealed-source helper is not anon-callable" "f" \
  "$(psql_db -Atqc "SELECT pg_catalog.has_function_privilege('anon',
     'arena.public_sealed_rank_sources()', 'EXECUTE')")"
assert_equal "before 20261114101605 the first screen shows unsealed boards" "999.0|7:77.0,90:555.0" \
  "$(anon_rpc "(public.arena_first_screen('okx_futures', 'okx-only')#>>'{entries,0,headlineRoi}')
     || '|' || (SELECT pg_catalog.string_agg((e->>'timeframe') || ':' || (e->>'headlineRoi'), ','
                ORDER BY (e->>'timeframe')::int)
     FROM pg_catalog.jsonb_array_elements(
       public.arena_first_screen('binance_futures', 'bn-ace')->'entries') AS e)")"

# 20261114101605: profile readers serve sealed boards only and drop stale stats.
PGOPTIONS='-c client_min_messages=warning' psql_db -q \
  -f "$MIGRATIONS/20261114101605_first_screen_core_modules_sealed_only.sql" >/dev/null
assert_equal "first screen shows nothing for a never-sealed source" "[]|OkxOnly" \
  "$(anon_rpc "(public.arena_first_screen('okx_futures', 'okx-only')->'entries')::text
     || '|' || (public.arena_first_screen('okx_futures', 'okx-only')->>'nickname')")"
assert_equal "first screen shows the sealed 90D board only (no newer board, no unsealed 7D)" \
  "90:$(psql_db -Atqc "SELECT headline_roi FROM arena.leaderboard_entries
                        WHERE snapshot_id = 101 AND trader_id = 11")" \
  "$(anon_rpc "pg_catalog.string_agg((e->>'timeframe') || ':' || (e->>'headlineRoi'), ',')
     FROM pg_catalog.jsonb_array_elements(
       public.arena_first_screen('binance_futures', 'bn-ace')->'entries') AS e")"
psql_db -q <<'SQL'
INSERT INTO arena.leaderboard_publication_source_isolations
  (season_id, filter_source, reasons, first_isolated_at, score_cohort_id)
SELECT '90D', 'binance_futures', ARRAY['stale'], pg_catalog.now(), head.score_cohort_id
FROM arena.public_ranked_leaderboard_serving_heads AS head WHERE head.season_id = '90D';
DELETE FROM arena.public_ranked_leaderboard_serving_sources
WHERE season_id = '90D' AND source = 'binance_futures';
SQL
assert_equal "first screen hides a source the sealed season no longer witnesses" "[]" \
  "$(anon_rpc "(public.arena_first_screen('binance_futures', 'bn-ace')->'entries')::text")"
assert_equal "core modules serve fresh stats and drop stale ones" "180.5|null" \
  "$(anon_rpc "(public.arena_core_modules('binance_futures', 'bn-ace', 90)#>>'{stats,roi}') || '|' ||
              COALESCE(public.arena_core_modules('binance_futures', 'bn-bolt', 90)::text, 'null')")"

echo "public ranking season publication PostgreSQL 17 proof passed"
