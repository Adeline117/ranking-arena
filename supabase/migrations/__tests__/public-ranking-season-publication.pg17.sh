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
  count_check_passed boolean NOT NULL
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
# Negative 1: one expected source (bybit) is stale -> nothing is written.
# ---------------------------------------------------------------------------
OUT="$(publish 90D)"
assert_equal "stale source is refused" "false" "$(json_field "$OUT" ok)"
assert_equal "stale source refusal code" "expected_source_not_fresh" "$(json_field "$OUT" code)"
[[ "$(json_field "$OUT" message)" == *"bybit(stale)"* ]] || {
  echo "stale refusal does not name bybit: $OUT" >&2
  exit 1
}
assert_equal "view stays empty after stale refusal" "0" "$(view_count)"
assert_equal "no rank row, claim, or receipt survives a refusal" "0|0|0" "$(psql_db -Atqc "
  SELECT (SELECT pg_catalog.count(*) FROM public.leaderboard_ranks) || '|' ||
         (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_generation_claims) || '|' ||
         (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_publications)")"

# ---------------------------------------------------------------------------
# Positive: bybit publishes a fresh board -> the whole season is served.
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
assert_equal "public view row count" "7" "$(view_count)"

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
# Negative 2: a new expected source without any board -> refusal; the view
# keeps serving the previous cohort byte-for-byte.
# ---------------------------------------------------------------------------
psql_db -qc "UPDATE arena.sources SET serving_mode = 'serving' WHERE slug = 'okx_futures'"
OUT="$(publish 90D)"
assert_equal "missing source is refused" "false" "$(json_field "$OUT" ok)"
assert_equal "missing source refusal code" "expected_source_not_fresh" "$(json_field "$OUT" code)"
[[ "$(json_field "$OUT" message)" == *"okx_futures(missing)"* ]] || {
  echo "missing refusal does not name okx_futures: $OUT" >&2
  exit 1
}
# The registry change alone invalidates the old head (expected set changed),
# which is the database's own all-or-nothing rule; restoring it re-serves the
# unchanged previous cohort because the refusal wrote nothing.
psql_db -qc "UPDATE arena.sources SET serving_mode = 'shadow' WHERE slug = 'okx_futures'"
assert_equal "previous cohort still served after refusal" "$FIRST_VIEW" "$(anon_view)"
assert_equal "refusal left one claim and one receipt" "1|1" "$(psql_db -Atqc "
  SELECT (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_generation_claims) || '|' ||
         (SELECT pg_catalog.count(*) FROM arena.leaderboard_rank_publications)")"

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
assert_equal "generation sequence advanced past the foreign claim" "3" \
  "$(json_field "$OUT" result.generationSeq)"
assert_equal "second cycle released its lease" "true" "$(json_field "$OUT" result.leaseReleased)"

# ---------------------------------------------------------------------------
# Positive 3: an immediate re-publication is no longer blocked by the previous
# run's lease (it was released in the sealing transaction).
# ---------------------------------------------------------------------------
OUT="$(publish 90D)"
assert_equal "immediate re-publication succeeds" "true" "$(json_field "$OUT" ok)"
assert_equal "immediate re-publication is generation 4" "4" "$(json_field "$OUT" result.generationSeq)"
assert_equal "view still serves 7 rows" "7" "$(view_count)"

echo "public ranking season publication PostgreSQL 17 proof passed"
