#!/usr/bin/env bash

# PostgreSQL 17 end-to-end proof for the Bitget cumulative bot-board rank
# quarantine. The proof owns an isolated temporary cluster, installs the exact
# reviewed legacy function bodies from their repository migrations, and then
# executes the quarantine migration itself (including replay and rollback).

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260728124000_quarantine_bitget_bot_cumulative_rank_authority.sql"
ALIAS_MIGRATION="$ROOT_DIR/supabase/migrations/20260729065000_normalize_arena_score_input_platform_aliases.sql"
SCORE_JSON_MIGRATION="$ROOT_DIR/supabase/migrations/20260724234000_optimize_arena_score_inputs_json_hot_path.sql"
BUNDLE_MIGRATION="$ROOT_DIR/supabase/migrations/20260725012000_strengthen_arena_score_publish_evidence.sql"
FRESHNESS_MIGRATION="$ROOT_DIR/supabase/migrations/20260718134000_freshness_expected_sources.sql"
ELIGIBILITY_MIGRATION="$ROOT_DIR/supabase/migrations/20260724235000_leaderboard_publication_mutation_fence.sql"
WEEKLY_MIGRATION="$ROOT_DIR/supabase/migrations/20260611215532_arena_weekly_leaders_rpc.sql"
EXCHANGE_MIGRATION="$ROOT_DIR/supabase/migrations/20260611120850_exchange_rankings_rpc.sql"
FIRST_SCREEN_MIGRATION="$ROOT_DIR/supabase/migrations/20260629204245_clamp_arena_first_screen_headline.sql"
CORE_MIGRATION="$ROOT_DIR/supabase/migrations/20260629203649_clamp_arena_core_modules_metrics.sql"
LEGACY_SCORE_MIGRATION="$ROOT_DIR/supabase/migrations/20260612135918_arena_score_inputs_rpc.sql"
COUNT_CACHE_MIGRATION="$ROOT_DIR/supabase/migrations/20260716070000_snapshot_consistent_leaderboard_counts.sql"
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
for required_file in \
  "$MIGRATION" \
  "$ALIAS_MIGRATION" \
  "$SCORE_JSON_MIGRATION" \
  "$BUNDLE_MIGRATION" \
  "$FRESHNESS_MIGRATION" \
  "$ELIGIBILITY_MIGRATION" \
  "$WEEKLY_MIGRATION" \
  "$EXCHANGE_MIGRATION" \
  "$FIRST_SCREEN_MIGRATION" \
  "$CORE_MIGRATION" \
  "$LEGACY_SCORE_MIGRATION" \
  "$COUNT_CACHE_MIGRATION"; do
  if [[ ! -f "$required_file" ]]; then
    echo "Required migration not found: $required_file" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/bitget-bot-rank-quarantine-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((59000 + ($$ % 5000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)); then
    for diagnostic in "$ERROR_FILE" "$LOG_FILE"; do
      if [[ -f "$diagnostic" ]]; then
        echo "Diagnostic: $diagnostic" >&2
        tail -240 "$diagnostic" >&2 || true
      fi
    done
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

expect_failure() {
  local label="$1"
  local pattern="$2"
  local sql="$3"
  if psql_cmd -q -c "$sql" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if ! rg -q "$pattern" "$ERROR_FILE"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,180p' "$ERROR_FILE" >&2
    exit 1
  fi
}

expect_migration_failure() {
  local label="$1"
  local pattern="$2"
  if psql_cmd -q -f "$MIGRATION" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if ! rg -q "$pattern" "$ERROR_FILE"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,220p' "$ERROR_FILE" >&2
    exit 1
  fi
}

# Emit exactly one CREATE OR REPLACE FUNCTION statement, preserving its body
# byte-for-byte so the production migration's SHA-256 preflight is meaningful.
extract_function() {
  local source_file="$1"
  local start_needle="$2"
  awk -v needle="$start_needle" '
    !printing && index($0, needle) { printing = 1 }
    printing {
      print
      if ($0 == "$$;" || $0 == "$function$;") exit
    }
  ' "$source_file"
}

apply_function() {
  local source_file="$1"
  local start_needle="$2"
  local statement
  statement="$(extract_function "$source_file" "$start_needle")"
  if [[ -z "$statement" ]]; then
    echo "Function fixture not found in $source_file: $start_needle" >&2
    exit 1
  fi
  psql_cmd -q <<<"$statement"
}

apply_rank_authority_fixtures() {
  apply_function \
    "$SCORE_JSON_MIGRATION" \
    'CREATE OR REPLACE FUNCTION public.arena_score_inputs_json('
  psql_cmd -q -c \
    'ALTER FUNCTION public.arena_score_inputs_json(text, integer, integer) STABLE'

  apply_function \
    "$BUNDLE_MIGRATION" \
    'CREATE OR REPLACE FUNCTION public.arena_score_inputs_publish_bundle_json('
  apply_function \
    "$FRESHNESS_MIGRATION" \
    'CREATE OR REPLACE FUNCTION public.arena_freshness_expected_sources()'
  apply_function \
    "$ELIGIBILITY_MIGRATION" \
    'CREATE OR REPLACE FUNCTION arena.leaderboard_rank_row_is_public_eligible('

  psql_cmd -q <<'SQL'
ALTER FUNCTION public.arena_score_inputs_json(text, integer, integer)
  OWNER TO postgres;
ALTER FUNCTION public.arena_score_inputs_publish_bundle_json(
  text, integer, integer
) OWNER TO postgres;
ALTER FUNCTION public.arena_freshness_expected_sources() OWNER TO postgres;
ALTER FUNCTION arena.leaderboard_rank_row_is_public_eligible(
  public.leaderboard_ranks,
  timestamptz
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.arena_score_inputs_json(
  text, integer, integer
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.arena_score_inputs_publish_bundle_json(
  text, integer, integer
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.arena_freshness_expected_sources()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.leaderboard_rank_row_is_public_eligible(
  public.leaderboard_ranks,
  timestamptz
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.arena_score_inputs_json(
  text, integer, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.arena_score_inputs_publish_bundle_json(
  text, integer, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.arena_freshness_expected_sources()
  TO service_role;
SQL
}

apply_public_reader_fixtures() {
  apply_function \
    "$WEEKLY_MIGRATION" \
    'CREATE OR REPLACE FUNCTION public.arena_weekly_leaders('
  apply_function \
    "$EXCHANGE_MIGRATION" \
    'CREATE OR REPLACE FUNCTION public.arena_exchange_rankings('
  apply_function \
    "$FIRST_SCREEN_MIGRATION" \
    'CREATE OR REPLACE FUNCTION public.arena_first_screen('
  apply_function \
    "$CORE_MIGRATION" \
    'CREATE OR REPLACE FUNCTION public.arena_core_modules('

  psql_cmd -q <<'SQL'
ALTER FUNCTION public.arena_weekly_leaders(integer) OWNER TO postgres;
ALTER FUNCTION public.arena_exchange_rankings(integer) OWNER TO postgres;
ALTER FUNCTION public.arena_first_screen(text, text) OWNER TO postgres;
ALTER FUNCTION public.arena_core_modules(text, text, integer) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.arena_weekly_leaders(integer)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_exchange_rankings(integer)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_first_screen(text, text)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_core_modules(text, text, integer)
  TO anon, authenticated, service_role;
SQL
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --username=postgres \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE outsider NOLOGIN NOBYPASSRLS;
CREATE SCHEMA arena;
GRANT USAGE ON SCHEMA arena TO anon, authenticated, service_role, outsider;

CREATE TABLE arena.fixture_clock (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  observed_at timestamptz NOT NULL
);
INSERT INTO arena.fixture_clock (singleton, observed_at)
VALUES (true, pg_catalog.now());

CREATE TABLE arena.exchanges (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  name text NOT NULL
);

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  exchange_id smallint NOT NULL REFERENCES arena.exchanges(id),
  product_type text NOT NULL,
  trader_kind_scope text NOT NULL,
  adapter_slug text NOT NULL,
  status text NOT NULL,
  timeframes_native integer[] NOT NULL,
  timeframes_derived integer[] NOT NULL,
  page_size integer,
  pagination_kind text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  serving_mode text NOT NULL,
  currency text NOT NULL,
  cadence_tier_a interval NOT NULL DEFAULT interval '15 minutes'
);

CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL,
  nickname text,
  trader_kind text NOT NULL,
  bot_strategy text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz NOT NULL,
  avatar_url_mirror text,
  avatar_url_origin text,
  wallet_address text,
  UNIQUE (source_id, exchange_trader_id)
);

CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL,
  actual_count integer NOT NULL,
  count_check_passed boolean NOT NULL,
  is_derived boolean NOT NULL DEFAULT false
);

CREATE TABLE arena.leaderboard_entries (
  snapshot_id bigint NOT NULL REFERENCES arena.leaderboard_snapshots(id),
  scraped_at timestamptz NOT NULL,
  timeframe smallint NOT NULL,
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  rank integer,
  headline_roi numeric,
  headline_pnl numeric,
  headline_win_rate numeric,
  currency text,
  raw jsonb
) PARTITION BY RANGE (scraped_at);
CREATE TABLE arena.leaderboard_entries_history
  PARTITION OF arena.leaderboard_entries
  FOR VALUES FROM (MINVALUE) TO (MAXVALUE);

CREATE TABLE arena.trader_stats (
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  timeframe smallint NOT NULL,
  roi numeric,
  pnl numeric,
  sharpe numeric,
  mdd numeric,
  win_rate numeric,
  win_positions numeric,
  total_positions numeric,
  copier_pnl numeric,
  copier_count numeric,
  aum numeric,
  volume numeric,
  profit_share_rate numeric,
  holding_duration_avg interval,
  trading_preferences jsonb,
  extras jsonb NOT NULL DEFAULT '{}'::jsonb,
  as_of timestamptz NOT NULL,
  currency text,
  PRIMARY KEY (trader_id, timeframe)
);

CREATE TABLE arena.trader_series (
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  timeframe smallint NOT NULL,
  metric text NOT NULL,
  ts timestamptz NOT NULL,
  value numeric NOT NULL
);

CREATE TABLE arena.bots (
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_bot_id text NOT NULL,
  pair text NOT NULL,
  raw jsonb,
  PRIMARY KEY (source_id, exchange_bot_id)
);

CREATE TABLE public.leaderboard_ranks (
  id bigint GENERATED BY DEFAULT AS IDENTITY,
  season_id text NOT NULL,
  source text NOT NULL,
  source_trader_id text NOT NULL,
  rank integer,
  rank_change integer,
  arena_score numeric,
  roi numeric,
  pnl numeric,
  win_rate numeric,
  max_drawdown numeric,
  score_completeness text,
  metrics_estimated boolean,
  is_outlier boolean,
  computed_at timestamptz,
  rank_publication_id uuid,
  PRIMARY KEY (season_id, id),
  UNIQUE (season_id, source, source_trader_id)
) PARTITION BY LIST (season_id);
CREATE TABLE public.leaderboard_ranks_7d
  PARTITION OF public.leaderboard_ranks FOR VALUES IN ('7D');
CREATE TABLE public.leaderboard_ranks_30d
  PARTITION OF public.leaderboard_ranks FOR VALUES IN ('30D');
CREATE TABLE public.leaderboard_ranks_90d
  PARTITION OF public.leaderboard_ranks FOR VALUES IN ('90D');
CREATE TABLE public.leaderboard_ranks_default
  PARTITION OF public.leaderboard_ranks DEFAULT;

CREATE TABLE public.leaderboard_source_freshness (
  season_id text NOT NULL,
  source text NOT NULL,
  source_as_of timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (season_id, source)
);

CREATE TABLE public.leaderboard_count_cache (
  season_id text NOT NULL,
  source text NOT NULL DEFAULT '_all',
  total_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (season_id, source)
);

ALTER TABLE arena.bots ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.leaderboard_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.leaderboard_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.leaderboard_entries_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.trader_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read bots" ON arena.bots FOR SELECT USING (true);
CREATE POLICY "Public read leaderboard_snapshots"
  ON arena.leaderboard_snapshots FOR SELECT USING (true);
CREATE POLICY "Public read leaderboard_entries"
  ON arena.leaderboard_entries FOR SELECT USING (true);
CREATE POLICY "Public read trader_stats"
  ON arena.trader_stats FOR SELECT USING (true);

GRANT SELECT ON arena.bots, arena.leaderboard_snapshots,
  arena.leaderboard_entries, arena.leaderboard_entries_history,
  arena.trader_stats
  TO PUBLIC, anon, authenticated, service_role;
SQL

psql_cmd -q <<'SQL'
INSERT INTO arena.exchanges (id, slug, name) VALUES
  (1, 'bitget', 'Bitget'),
  (2, 'humanex', 'Human Exchange');

INSERT INTO arena.sources (
  id, slug, exchange_id, product_type, trader_kind_scope, adapter_slug,
  status, timeframes_native, timeframes_derived, page_size,
  pagination_kind, meta, serving_mode, currency
) VALUES
  (
    1, 'bitget_bots_futures', 1, 'futures', 'bot', 'bitget_bots',
    'active', ARRAY[30], ARRAY[]::integer[], 20, 'numeric',
    '{"boards":["futures_grid","futures_martingale"],"legacy_platform":"bitget_bots_futures"}',
    'serving', 'USDT'
  ),
  (
    2, 'bitget_bots_spot', 1, 'spot', 'bot', 'bitget_bots',
    'active', ARRAY[30], ARRAY[]::integer[], 20, 'numeric',
    '{"boards":["spot_grid","spot_martingale"],"legacy_platform":"bitget_bots_spot"}',
    'serving', 'USDT'
  ),
  (
    3, 'human_futures', 2, 'futures', 'human', 'human_adapter',
    'active', ARRAY[7,30,90], ARRAY[]::integer[], 20, 'numeric',
    '{}', 'serving', 'USDT'
  );

INSERT INTO arena.traders (
  id, source_id, exchange_trader_id, nickname, trader_kind, bot_strategy,
  meta, last_seen_at, avatar_url_origin
) VALUES
  (
    101, 1, '10001', 'Grid owner', 'bot', 'grid',
    '{"bot":{"exchange_bot_id":"10001","product_id":"BTCUSDT","owner_account_id":"owner-1","owner_name":"Owner One","pair":"BTC/USDT","product_type":"futures","strategy":"grid","direction":"long","created_at_origin":"2026-01-01T00:00:00Z","runtime_days":100,"profit_share_rate":10,"status":"running"}}',
    pg_catalog.now(), 'https://example.test/bot.png'
  ),
  (
    201, 2, '20001', 'Spot owner', 'bot', 'martingale',
    '{"bot":{"exchange_bot_id":"20001","product_id":"ETHUSDT","owner_account_id":"owner-2","owner_name":"Owner Two","pair":"ETH/USDT","product_type":"spot","strategy":"martingale","direction":null,"created_at_origin":"2026-02-01T00:00:00Z","runtime_days":80,"profit_share_rate":8,"status":"running"}}',
    pg_catalog.now(), 'https://example.test/spot-bot.png'
  ),
  (
    301, 3, 'human-a', 'Human Alpha', 'human', NULL,
    '{}', pg_catalog.now(), 'https://example.test/human-a.png'
  ),
  (
    302, 3, 'human-b', 'Human Beta', 'human', NULL,
    '{}', pg_catalog.now(), 'https://example.test/human-b.png'
  ),
  (
    303, 3, 'human-hidden', 'Human Hidden', 'human', NULL,
    '{}', pg_catalog.now(), 'https://example.test/human-hidden.png'
  );

INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, scraped_at, actual_count,
  count_check_passed, is_derived
) VALUES
  (1001, 1, 30, (SELECT observed_at - interval '60 minutes'
                  FROM arena.fixture_clock), 1, true, false),
  (1002, 1, 7, (SELECT observed_at - interval '90 minutes'
                 FROM arena.fixture_clock), 1, true, false),
  (2001, 2, 30, (SELECT observed_at - interval '55 minutes'
                  FROM arena.fixture_clock), 1, true, false),
  (3001, 3, 30, (SELECT observed_at - interval '50 minutes'
                  FROM arena.fixture_clock), 2, true, false),
  (3002, 3, 7, (SELECT observed_at - interval '80 minutes'
                 FROM arena.fixture_clock), 1, true, false);

INSERT INTO arena.leaderboard_entries (
  snapshot_id, scraped_at, timeframe, trader_id, rank,
  headline_roi, headline_pnl, headline_win_rate, currency, raw
) VALUES
  (
    1001, (SELECT observed_at - interval '60 minutes'
           FROM arena.fixture_clock), 30, 101, 1,
    250, 5000, 71, 'USDT',
    '{"strategyId":"10001","strategyType":2,"productId":"BTCUSDT","strAccountId":"owner-1","status":"running","profitRate":"2.5","profitAmount":"5000","winRate":"0.71"}'
  ),
  (
    1002, (SELECT observed_at - interval '90 minutes'
           FROM arena.fixture_clock), 7, 101, 1,
    240, 4800, 70, 'USDT',
    '{"strategyId":"10001","strategyType":2,"productId":"BTCUSDT","strAccountId":"owner-1","status":"running","profitRate":"2.4"}'
  ),
  (
    2001, (SELECT observed_at - interval '55 minutes'
           FROM arena.fixture_clock), 30, 201, 1,
    190, 3000, 65, 'USDT',
    '{"strategyId":"20001","strategyType":3,"productId":"ETHUSDT","strAccountId":"owner-2","status":"running","profitRate":"1.9"}'
  ),
  (
    3001, (SELECT observed_at - interval '50 minutes'
           FROM arena.fixture_clock), 30, 301, 1,
    55, 800, 60, 'USDT', '{"human":"safe"}'
  ),
  (
    3001, (SELECT observed_at - interval '50 minutes'
           FROM arena.fixture_clock), 30, 302, 2,
    40, 600, 57, 'USDT', '{"human":"safe"}'
  ),
  (
    3002, (SELECT observed_at - interval '80 minutes'
           FROM arena.fixture_clock), 7, 301, 1,
    25, 300, 55, 'USDT', '{"human":"weekly"}'
  );

INSERT INTO arena.trader_stats (
  trader_id, timeframe, roi, pnl, sharpe, mdd, win_rate,
  win_positions, total_positions, copier_pnl, copier_count, aum, volume,
  profit_share_rate, holding_duration_avg, trading_preferences,
  extras, as_of, currency
) VALUES
  (101, 0, 300, 6000, 2.1, 18, 72, 72, 100, 2000, 50, 10000, 50000,
   10, interval '4 hours', '{"style":"grid"}', '{"inception":true}',
   (SELECT observed_at - interval '60 minutes' FROM arena.fixture_clock),
   'USDT'),
  (101, 7, 240, 4800, 2.0, 19, 70, 70, 100, 1800, 45, 9000, 45000,
   10, interval '4 hours', '{"style":"grid"}', '{}',
   (SELECT observed_at - interval '60 minutes' FROM arena.fixture_clock),
   'USDT'),
  (101, 30, 250, 5000, 2.2, 20, 71, 71, 100, 2000, 50, 10000, 50000,
   10, interval '4 hours', '{"style":"grid"}',
   '{"_arena_profile_publication_epoch_ms":123,"legacyBoard":"cumulative"}',
   (SELECT observed_at - interval '60 minutes' FROM arena.fixture_clock),
   'USDT'),
  (101, 90, 270, 5500, 2.3, 21, 73, 73, 100, 2200, 55, 11000, 55000,
   10, interval '4 hours', '{"style":"grid"}', '{}',
   (SELECT observed_at - interval '60 minutes' FROM arena.fixture_clock),
   'USDT'),
  (201, 30, 190, 3000, 1.8, 25, 65, 65, 100, 1000, 40, 8000, 40000,
   8, interval '8 hours', '{"style":"martingale"}', '{}',
   (SELECT observed_at - interval '55 minutes' FROM arena.fixture_clock),
   'USDT'),
  (301, 7, 25, 300, 1.4, 15, 55, 55, 100, 100, 10, 1000, 5000,
   5, interval '3 hours', '{"style":"manual"}', '{"human":true}',
   (SELECT observed_at - interval '80 minutes' FROM arena.fixture_clock),
   'USDT'),
  (301, 30, 55, 800, 1.7, 12, 60, 60, 100, 250, 20, 2000, 8000,
   5, interval '3 hours', '{"style":"manual"}', '{"human":true}',
   (SELECT observed_at - interval '50 minutes' FROM arena.fixture_clock),
   'USDT');

INSERT INTO arena.trader_series (trader_id, timeframe, metric, ts, value) VALUES
  (101, 30, 'roi', (SELECT observed_at - interval '90 minutes'
                    FROM arena.fixture_clock), 10),
  (101, 30, 'roi', (SELECT observed_at - interval '60 minutes'
                    FROM arena.fixture_clock), 20),
  (101, 0, 'roi', (SELECT observed_at - interval '60 minutes'
                   FROM arena.fixture_clock), 300),
  (301, 30, 'roi', (SELECT observed_at - interval '50 minutes'
                    FROM arena.fixture_clock), 55);

INSERT INTO arena.bots (source_id, exchange_bot_id, pair, raw) VALUES
  (1, '10001', 'BTC/USDT', '{"profitRate":"2.5"}'),
  (2, '20001', 'ETH/USDT', '{"profitRate":"1.9"}');

INSERT INTO public.leaderboard_ranks (
  season_id, source, source_trader_id, rank, rank_change, arena_score,
  roi, pnl, win_rate, max_drawdown, score_completeness,
  metrics_estimated, is_outlier, computed_at
) VALUES
  ('30D', 'bitget_bots_futures', '10001', 1, 2, 99, 250, 5000, 71, 20,
   'full', false, false, pg_catalog.now()),
  ('30D', 'bitget_bots_spot', '20001', 2, 1, 95, 190, 3000, 65, 25,
   'full', false, false, pg_catalog.now()),
  ('30D', 'human_futures', 'human-a', 3, -1, 90, 55, 800, 60, 12,
   'full', false, false, pg_catalog.now()),
  ('30D', 'human_futures', 'human-b', 4, 0, 80, 40, 600, 57, 14,
   'full', false, false, pg_catalog.now()),
  ('30D', 'human_futures', 'human-hidden', 5, 0, 70, 30, 400, 50, 16,
   'partial', false, false, pg_catalog.now()),
  ('7D', 'bitget_bots_futures', '10001', 1, 1, 96, 240, 4800, 70, 19,
   'full', false, false, pg_catalog.now()),
  ('7D', 'human_futures', 'human-a', 2, -1, 75, 25, 300, 55, 15,
   'full', false, false, pg_catalog.now());

INSERT INTO public.leaderboard_source_freshness (
  season_id, source, source_as_of, recorded_at
) VALUES
  ('30D', 'bitget_bots_futures', pg_catalog.now(), pg_catalog.now()),
  ('30D', 'bitget_bots_spot', pg_catalog.now(), pg_catalog.now()),
  ('7D', 'bitget_bots_futures', pg_catalog.now(), pg_catalog.now()),
  ('30D', 'human_futures', pg_catalog.now(), pg_catalog.now()),
  ('7D', 'human_futures', pg_catalog.now(), pg_catalog.now());

INSERT INTO public.leaderboard_count_cache (
  season_id, source, total_count, updated_at
) VALUES
  ('30D', 'bitget_bots_futures', 1, pg_catalog.now()),
  ('30D', 'bitget_bots_futures_gt0', 1, pg_catalog.now()),
  ('30D', 'bitget_bots_spot', 1, pg_catalog.now()),
  ('30D', 'bitget_bots_spot_gt0', 1, pg_catalog.now()),
  ('30D', 'human_futures', 3, pg_catalog.now()),
  ('7D', 'bitget_bots_futures', 1, pg_catalog.now()),
  ('7D', 'human_futures', 1, pg_catalog.now());
SQL

# Build the legacy score view before installing its table-returning RPC.
psql_cmd -q <<'SQL'
CREATE VIEW arena.score_inputs AS
WITH latest_passed AS (
  SELECT DISTINCT ON (snapshot.source_id, snapshot.timeframe)
    snapshot.id AS snapshot_id,
    snapshot.source_id,
    snapshot.timeframe,
    snapshot.scraped_at
  FROM arena.leaderboard_snapshots AS snapshot
  WHERE snapshot.count_check_passed
  ORDER BY snapshot.source_id, snapshot.timeframe, snapshot.scraped_at DESC
)
SELECT
  COALESCE(source_row.meta->>'legacy_platform', source_row.slug) AS platform,
  CASE WHEN source_row.product_type = 'spot' THEN 'spot' ELSE 'futures' END
    AS market_type,
  trader.exchange_trader_id AS trader_key,
  latest.timeframe::text || 'D' AS "window",
  entry.rank AS board_rank,
  LEAST(GREATEST(entry.headline_roi, -10000), 10000) AS roi_pct,
  entry.headline_pnl AS pnl_usd,
  LEAST(GREATEST(entry.headline_win_rate, 0), 100) AS win_rate,
  LEAST(pg_catalog.abs(stats.mdd), 100) AS max_drawdown,
  stats.copier_count AS copiers,
  stats.total_positions AS trades_count,
  stats.sharpe AS sharpe_ratio,
  (stats.extras->>'sortino')::numeric AS sortino_ratio,
  (stats.extras->>'calmar')::numeric AS calmar_ratio,
  (stats.extras->>'volatility')::numeric AS volatility_pct,
  trader.trader_kind,
  trader.nickname AS handle,
  COALESCE(trader.avatar_url_mirror, trader.avatar_url_origin) AS avatar_url,
  source_row.currency,
  latest.scraped_at AS as_of
FROM latest_passed AS latest
JOIN arena.sources AS source_row ON source_row.id = latest.source_id
JOIN arena.leaderboard_entries AS entry
  ON entry.snapshot_id = latest.snapshot_id
JOIN arena.traders AS trader ON trader.id = entry.trader_id
LEFT JOIN arena.trader_stats AS stats
  ON stats.trader_id = trader.id
 AND stats.timeframe = latest.timeframe
WHERE source_row.serving_mode <> 'legacy'
  AND source_row.currency IN ('USDT', 'USDx', 'USDC', 'USD')
  AND (source_row.meta->>'legacy_platform') IS DISTINCT FROM 'null';

GRANT SELECT ON arena.score_inputs
  TO PUBLIC, anon, authenticated, service_role;
SQL

apply_function \
  "$LEGACY_SCORE_MIGRATION" \
  'CREATE OR REPLACE FUNCTION public.arena_score_inputs('
apply_function \
  "$COUNT_CACHE_MIGRATION" \
  'CREATE OR REPLACE FUNCTION public.refresh_leaderboard_count_cache()'
psql_cmd -q <<'SQL'
ALTER FUNCTION public.arena_score_inputs(text, integer, integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arena_score_inputs(text, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_score_inputs(text, integer, integer)
  TO service_role;
SQL

apply_rank_authority_fixtures
apply_public_reader_fixtures

# Exact fixture digests make this an old-to-new proof, not a lookalike mock.
psql_cmd -q <<'SQL'
DO $legacy_digests$
DECLARE
  v_target record;
  v_actual text;
BEGIN
  FOR v_target IN
    SELECT *
    FROM (
      VALUES
        ('public.arena_score_inputs_json(text,integer,integer)'::text,
         'e2a24067c77ba495cf73b088468d292b6cc8ab36f2f1d251d290881b3938586d'::text),
        ('public.arena_score_inputs_publish_bundle_json(text,integer,integer)'::text,
         'd20a085c89371ddc5d5a9ee70645268433e385d6b32ab348d7fd9322a31521d1'::text),
        ('public.arena_freshness_expected_sources()'::text,
         'c1739275e302ac2a7429c79a0c3456680603418004cc9c3da44913de88d28b4e'::text),
        ('public.arena_weekly_leaders(integer)'::text,
         '7404871e31d0cbc75d15d1dfad3ea2d71b3396e1c81910eab597988d73e0011c'::text),
        ('public.arena_exchange_rankings(integer)'::text,
         '2ae528a8c0e8ddbe3ce78b689a9c0d1ec2b6bd7fa841bba8855aa8367295cba8'::text),
        ('public.arena_first_screen(text,text)'::text,
         '9d6d7c3ab93ec25c3f0860df02549169cb1ebefa08ca8e001b1e636cbe1f1323'::text),
        ('public.arena_core_modules(text,text,integer)'::text,
         '17e93c1b96a0b81ae2698ec767c670a3fca7f255eb6e3785c63b8111ad4c9db5'::text),
        ('arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamptz)'::text,
         'aa87e8343569cccdeeea84bee66fbf9cd20b8b75e39b1a6d63e78f110e4bf0df'::text)
    ) AS target(signature, expected_sha256)
    ORDER BY target.signature
  LOOP
    SELECT pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
      'hex'
    )
    INTO STRICT v_actual
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure(v_target.signature);

    IF v_actual <> v_target.expected_sha256 THEN
      RAISE EXCEPTION 'legacy fixture digest drifted for %: %',
        v_target.signature, v_actual;
    END IF;
  END LOOP;
END
$legacy_digests$;
SQL

# Force a late, pinned-body failure. Reader replacements and search-path
# hardening execute earlier in the transaction, so their unchanged legacy
# state below proves the whole migration rolled back rather than only failing.
psql_cmd -q <<'SQL'
DO $unknown_hash$
DECLARE
  v_definition text;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(
    'public.arena_score_inputs_json(text,integer,integer)'
      ::pg_catalog.regprocedure
  );
  v_definition := pg_catalog.replace(
    v_definition,
    '  WITH requested AS MATERIALIZED (',
    E'  -- fixture-unknown-body-drift\n  WITH requested AS MATERIALIZED ('
  );
  EXECUTE v_definition;
END
$unknown_hash$;
SQL

expect_migration_failure \
  'unknown rank-authority body' \
  'rank authority body drifted'

psql_cmd -q <<'SQL'
DO $rollback_proof$
DECLARE
  v_weekly_hash text;
BEGIN
  SELECT pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
    'hex'
  )
  INTO STRICT v_weekly_hash
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.arena_weekly_leaders(integer)'::pg_catalog.regprocedure;

  IF v_weekly_hash <>
       '7404871e31d0cbc75d15d1dfad3ea2d71b3396e1c81910eab597988d73e0011c'
     OR (
       SELECT function_row.proconfig
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid =
         'public.arena_weekly_leaders(integer)'::pg_catalog.regprocedure
     ) IS DISTINCT FROM ARRAY['search_path=arena, public']::text[]
     OR (SELECT pg_catalog.count(*) FROM public.leaderboard_ranks
         WHERE source LIKE 'bitget_bots_%') <> 3
     OR (SELECT raw FROM arena.leaderboard_entries
         WHERE snapshot_id = 1001) IS NULL
     OR NOT pg_catalog.has_table_privilege(
       'anon', 'arena.leaderboard_entries', 'SELECT'
     ) THEN
    RAISE EXCEPTION 'failed migration leaked a partial quarantine';
  END IF;
END
$rollback_proof$;
SQL

# Restore the exact pinned old body after the deliberate unknown-hash probe.
apply_function \
  "$SCORE_JSON_MIGRATION" \
  'CREATE OR REPLACE FUNCTION public.arena_score_inputs_json('
psql_cmd -q <<'SQL'
ALTER FUNCTION public.arena_score_inputs_json(text, integer, integer) STABLE;
ALTER FUNCTION public.arena_score_inputs_json(text, integer, integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arena_score_inputs_json(
  text, integer, integer
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_score_inputs_json(
  text, integer, integer
) TO service_role;
SQL

# Execute the real old -> new transition. Replay happens after a compliant new
# publication and a profile refresh, proving it preserves live post-cutover data.
psql_cmd -q -f "$MIGRATION"

psql_cmd -q <<'SQL'
DO $quarantine_state$
DECLARE
  v_bot_30_mdd numeric;
  v_human_ranks integer[];
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.leaderboard_ranks
    WHERE source LIKE 'bitget_bots_%'
  ) OR EXISTS (
    SELECT 1 FROM public.leaderboard_source_freshness
    WHERE source LIKE 'bitget_bots_%'
  ) OR EXISTS (
    SELECT 1 FROM public.leaderboard_count_cache
    WHERE source = ANY (ARRAY[
      'bitget_bots_futures', 'bitget_bots_spot',
      'bitget_bots_futures_gt0', 'bitget_bots_spot_gt0'
    ]::text[])
  ) THEN
    RAISE EXCEPTION 'bot rank, freshness, or cache authority survived';
  END IF;

  SELECT pg_catalog.array_agg(rank ORDER BY rank)
  INTO STRICT v_human_ranks
  FROM public.leaderboard_ranks
  WHERE season_id = '30D'
    AND source = 'human_futures'
    AND source_trader_id IN ('human-a', 'human-b');
  IF v_human_ranks IS DISTINCT FROM ARRAY[1, 2]::integer[]
     OR (SELECT rank FROM public.leaderboard_ranks
         WHERE season_id = '30D'
           AND source_trader_id = 'human-hidden') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM public.leaderboard_ranks
       WHERE season_id IN ('7D', '30D') AND rank_change IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'human ranks were not reclassified continuously';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM arena.leaderboard_entries AS entry
    JOIN arena.leaderboard_snapshots AS snapshot
      ON snapshot.id = entry.snapshot_id
    WHERE snapshot.source_id IN (1, 2)
      AND pg_catalog.num_nonnulls(
        entry.headline_roi,
        entry.headline_pnl,
        entry.headline_win_rate,
        entry.raw
      ) <> 0
  ) OR EXISTS (
    SELECT 1
    FROM arena.leaderboard_entries AS entry
    JOIN arena.leaderboard_snapshots AS snapshot
      ON snapshot.id = entry.snapshot_id
    WHERE snapshot.source_id = 3
      AND entry.headline_roi IS NULL
  ) THEN
    RAISE EXCEPTION 'entry scrub widened beyond Bitget bot history';
  END IF;

  SELECT mdd INTO STRICT v_bot_30_mdd
  FROM arena.trader_stats
  WHERE trader_id = 101 AND timeframe = 30;
  IF v_bot_30_mdd <> 20
     OR EXISTS (
       SELECT 1
       FROM arena.trader_stats
       WHERE trader_id IN (101, 201)
         AND timeframe IN (7, 30, 90)
         AND (
           roi IS NOT NULL OR pnl IS NOT NULL OR win_rate IS NOT NULL
           OR (timeframe IN (7, 90) AND mdd IS NOT NULL)
           OR as_of <> '1970-01-01 00:00:00+00'::timestamptz
         )
     )
     OR (SELECT roi FROM arena.trader_stats
         WHERE trader_id = 101 AND timeframe = 0) <> 300
     OR (SELECT roi FROM arena.trader_stats
         WHERE trader_id = 301 AND timeframe = 30) <> 55 THEN
    RAISE EXCEPTION 'profile scrub lost 30D MDD, tf0, or human isolation';
  END IF;
END
$quarantine_state$;
SQL

# Direct relations are RPC-only for B2C callers, while service diagnostics stay
# readable. The retired table-returning score RPC must be closed even to service.
expect_failure \
  'anon leaderboard entry relation' \
  'permission denied for (table|relation) leaderboard_entries' \
  'SET ROLE anon; SELECT * FROM arena.leaderboard_entries LIMIT 1'
expect_failure \
  'authenticated trader stats relation' \
  'permission denied for (table|relation) trader_stats' \
  'SET ROLE authenticated; SELECT * FROM arena.trader_stats LIMIT 1'
expect_failure \
  'authenticated snapshot relation' \
  'permission denied for (table|relation) leaderboard_snapshots' \
  'SET ROLE authenticated; SELECT * FROM arena.leaderboard_snapshots LIMIT 1'
expect_failure \
  'anon bot relation' \
  'permission denied for (table|relation) bots' \
  'SET ROLE anon; SELECT * FROM arena.bots LIMIT 1'
expect_failure \
  'anon score-input view' \
  'permission denied for (table|relation|view) score_inputs' \
  'SET ROLE anon; SELECT * FROM arena.score_inputs LIMIT 1'
expect_failure \
  'authenticated entry partition relation' \
  'permission denied for (table|relation) leaderboard_entries_history' \
  'SET ROLE authenticated; SELECT * FROM arena.leaderboard_entries_history LIMIT 1'
expect_failure \
  'service legacy table score RPC' \
  'permission denied for function arena_score_inputs' \
  "SET ROLE service_role; SELECT * FROM public.arena_score_inputs('30D', 10, 48)"

psql_cmd -q <<'SQL'
SET ROLE service_role;
DO $service_readable$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM arena.bots) <> 2
     OR (SELECT pg_catalog.count(*) FROM arena.leaderboard_snapshots) <> 5
     OR (SELECT pg_catalog.count(*) FROM arena.leaderboard_entries) <> 6
     OR (SELECT pg_catalog.count(*) FROM arena.trader_stats) <> 7
     OR (SELECT pg_catalog.count(*) FROM arena.score_inputs) <> 6 THEN
    RAISE EXCEPTION 'service diagnostics cannot read ranking substrate';
  END IF;
END
$service_readable$;
RESET ROLE;
SQL

# The first post-quarantine publication carries only the five reviewed identity
# fields. The parent trigger must fire on the real scraped_at partition.
psql_cmd -q <<'SQL'
INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, scraped_at, actual_count,
  count_check_passed, is_derived
) VALUES
  (1100, 1, 30, (SELECT observed_at - interval '10 minutes'
                  FROM arena.fixture_clock), 1, true, false),
  (1101, 1, 7, (SELECT observed_at - interval '9 minutes'
                 FROM arena.fixture_clock), 1, true, false);

INSERT INTO arena.leaderboard_entries (
  snapshot_id, scraped_at, timeframe, trader_id, rank,
  headline_roi, headline_pnl, headline_win_rate, currency, raw
) VALUES (
  1100,
  (SELECT observed_at - interval '10 minutes' FROM arena.fixture_clock),
  30,
  101,
  1,
  NULL,
  NULL,
  NULL,
  'USDT',
  '{"strategyId":"10001","strategyType":2,"productId":"BTCUSDT","strAccountId":"owner-1","status":"running"}'
);
SQL

expect_failure \
  'legacy full raw card' \
  'exact identity-only projection' \
  "INSERT INTO arena.leaderboard_entries (
     snapshot_id,scraped_at,timeframe,trader_id,rank,currency,raw
   ) VALUES (
     1100,(SELECT observed_at - interval '10 minutes'
           FROM arena.fixture_clock),30,101,2,'USDT',
     '{\"strategyId\":\"10001\",\"strategyType\":2,\"productId\":\"BTCUSDT\",\"strAccountId\":\"owner-1\",\"status\":\"running\",\"profitRate\":\"2.5\"}'
   )"
expect_failure \
  'non-null cumulative headline' \
  'exact 30D identity-only publication' \
  "INSERT INTO arena.leaderboard_entries (
     snapshot_id,scraped_at,timeframe,trader_id,rank,headline_roi,currency,raw
   ) VALUES (
     1100,(SELECT observed_at - interval '10 minutes'
           FROM arena.fixture_clock),30,101,2,250,'USDT',
     '{\"strategyId\":\"10001\",\"strategyType\":2,\"productId\":\"BTCUSDT\",\"strAccountId\":\"owner-1\",\"status\":\"running\"}'
   )"
expect_failure \
  'non-30D board publication' \
  'exact 30D identity-only publication' \
  "INSERT INTO arena.leaderboard_entries (
     snapshot_id,scraped_at,timeframe,trader_id,rank,currency,raw
   ) VALUES (
     1101,(SELECT observed_at - interval '9 minutes'
           FROM arena.fixture_clock),7,101,2,'USDT',
     '{\"strategyId\":\"10001\",\"strategyType\":2,\"productId\":\"BTCUSDT\",\"strAccountId\":\"owner-1\",\"status\":\"running\"}'
   )"
expect_failure \
  'identity drift publication' \
  'exact identity-only projection' \
  "INSERT INTO arena.leaderboard_entries (
     snapshot_id,scraped_at,timeframe,trader_id,rank,currency,raw
   ) VALUES (
     1100,(SELECT observed_at - interval '10 minutes'
           FROM arena.fixture_clock),30,101,2,'USDT',
     '{\"strategyId\":\"99999\",\"strategyType\":2,\"productId\":\"BTCUSDT\",\"strAccountId\":\"owner-1\",\"status\":\"running\"}'
   )"

# Prove malformed writes fail through the guard's stable CHECK-violation
# contract, not an incidental FK, NO_DATA_FOUND, or implementation exception.
psql_cmd -q <<'SQL'
DO $guard_sqlstates$
DECLARE
  v_rejected boolean;
BEGIN
  v_rejected := false;
  BEGIN
    INSERT INTO arena.leaderboard_entries (
      snapshot_id, scraped_at, timeframe, trader_id, rank, currency, raw
    ) VALUES (
      1100,
      (SELECT observed_at - interval '10 minutes'
       FROM arena.fixture_clock),
      30,
      101,
      90,
      'USDT',
      '{"strategyId":"10001","strategyType":2,"productId":"BTCUSDT","strAccountId":"owner-1","status":"running","profitRate":"2.5"}'
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '23514' THEN
      RAISE EXCEPTION 'full raw rejected with SQLSTATE %, expected 23514',
        SQLSTATE;
    END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'full raw unexpectedly bypassed the entry guard';
  END IF;

  v_rejected := false;
  BEGIN
    INSERT INTO arena.leaderboard_entries (
      snapshot_id, scraped_at, timeframe, trader_id, rank, currency, raw
    ) VALUES (
      999999,
      (SELECT observed_at FROM arena.fixture_clock),
      30,
      101,
      91,
      'USDT',
      '{"strategyId":"10001","strategyType":2,"productId":"BTCUSDT","strAccountId":"owner-1","status":"running"}'
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '23514' THEN
      RAISE EXCEPTION 'missing snapshot rejected with SQLSTATE %, expected 23514',
        SQLSTATE;
    END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'missing snapshot unexpectedly bypassed the entry guard';
  END IF;

  v_rejected := false;
  BEGIN
    INSERT INTO arena.leaderboard_entries (
      snapshot_id, scraped_at, timeframe, trader_id, rank, currency, raw
    ) VALUES (
      1100,
      (SELECT observed_at - interval '10 minutes'
       FROM arena.fixture_clock),
      30,
      201,
      92,
      'USDT',
      '{"strategyId":"20001","strategyType":3,"productId":"ETHUSDT","strAccountId":"owner-2","status":"running"}'
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> '23514' THEN
      RAISE EXCEPTION 'cross-source trader rejected with SQLSTATE %, expected 23514',
        SQLSTATE;
    END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'cross-source trader unexpectedly bypassed the entry guard';
  END IF;
END
$guard_sqlstates$;
SQL

# Reader RPCs preserve a bot profile shell while returning no board entries;
# human rows remain available. Weekly/exchange aggregations contain no bot source.
psql_cmd -q <<'SQL'
DO $reader_behavior$
DECLARE
  v_weekly jsonb;
  v_exchange jsonb;
  v_bot_screen jsonb;
  v_human_screen jsonb;
BEGIN
  SET LOCAL ROLE anon;
  v_weekly := public.arena_weekly_leaders(25);
  v_exchange := public.arena_exchange_rankings(30);
  v_bot_screen := public.arena_first_screen(
    'bitget_bots_futures', '10001'
  );
  v_human_screen := public.arena_first_screen('human_futures', 'human-a');
  RESET ROLE;

  IF pg_catalog.jsonb_array_length(v_weekly->'rows') <> 1
     OR v_weekly->'rows'->0->>'source' <> 'human_futures'
     OR pg_catalog.jsonb_array_length(v_exchange->'rows') <> 1
     OR v_exchange->'rows'->0->>'source' <> 'human_futures'
     OR v_bot_screen->>'source' <> 'bitget_bots_futures'
     OR v_bot_screen->'entries' <> '[]'::jsonb
     OR pg_catalog.jsonb_array_length(v_human_screen->'entries') = 0 THEN
    RAISE EXCEPTION 'public reader leaked bot board data or hid human data';
  END IF;
END
$reader_behavior$;
SQL

# Core profile rules: humans and tf0 remain public; bot window metrics require a
# numeric publication watermark. String lookalikes stay closed, while safe 30D
# MDD can remain visible and series/extras follow the same gate.
psql_cmd -q <<'SQL'
DO $core_behavior_before_profile$
DECLARE
  v_bot_30 jsonb;
  v_bot_0 jsonb;
  v_human_30 jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  v_bot_30 := public.arena_core_modules(
    'bitget_bots_futures', '10001', 30
  );
  v_bot_0 := public.arena_core_modules(
    'bitget_bots_futures', '10001', 0
  );
  v_human_30 := public.arena_core_modules('human_futures', 'human-a', 30);
  RESET ROLE;

  IF v_bot_30->'stats' ? 'roi'
     OR v_bot_30->'stats' ? 'pnl'
     OR v_bot_30->'stats' ? 'win_rate'
     OR (v_bot_30->'stats'->>'mdd')::numeric <> 20
     OR (v_bot_0->'stats'->>'roi')::numeric <> 300
     OR (v_bot_0->'stats'->>'pnl')::numeric <> 6000
     OR (v_human_30->'stats'->>'roi')::numeric <> 55
     OR (v_human_30->'stats'->>'pnl')::numeric <> 800 THEN
    RAISE EXCEPTION 'core scrub, tf0, or human behavior drifted';
  END IF;
END
$core_behavior_before_profile$;

UPDATE arena.trader_stats
SET roi = 12,
    pnl = 120,
    sharpe = 1.2,
    win_rate = 61,
    extras = '{"_arena_profile_publication_epoch_ms":"123"}',
    as_of = pg_catalog.now()
WHERE trader_id = 101 AND timeframe = 30;

DO $string_watermark_closed$
DECLARE
  v_payload jsonb;
BEGIN
  SET LOCAL ROLE anon;
  v_payload := public.arena_core_modules(
    'bitget_bots_futures', '10001', 30
  );
  RESET ROLE;
  IF v_payload->'stats' ? 'roi'
     OR v_payload->'stats' ? 'pnl'
     OR v_payload->'stats' ? 'sharpe'
     OR v_payload->'stats' ? 'win_rate'
     OR v_payload->'extras' <> '{}'::jsonb
     OR v_payload->'series' <> '{}'::jsonb
     OR (v_payload->'stats'->>'mdd')::numeric <> 20 THEN
    RAISE EXCEPTION 'string watermark opened bot profile metrics';
  END IF;
END
$string_watermark_closed$;

UPDATE arena.trader_stats
SET extras = '{"_arena_profile_publication_epoch_ms":123}'
WHERE trader_id = 101 AND timeframe = 30;

DO $numeric_watermark_open$
DECLARE
  v_payload jsonb;
BEGIN
  SET LOCAL ROLE service_role;
  v_payload := public.arena_core_modules(
    'bitget_bots_futures', '10001', 30
  );
  RESET ROLE;
  IF (v_payload->'stats'->>'roi')::numeric <> 12
     OR (v_payload->'stats'->>'pnl')::numeric <> 120
     OR (v_payload->'stats'->>'win_rate')::numeric <> 61
     OR v_payload->'extras'->>'_arena_profile_publication_epoch_ms' <> '123'
     OR pg_catalog.jsonb_array_length(v_payload->'series'->'roi') <> 2 THEN
    RAISE EXCEPTION 'numeric profile watermark did not open exact-window data';
  END IF;
END
$numeric_watermark_open$;
SQL

# The rank-authority functions must also exclude bots after their source-body
# rewrite; the guard constraint rejects any delayed rank writer.
psql_cmd -q <<'SQL'
DO $authority_readers$
DECLARE
  v_rows jsonb;
  v_bundle jsonb;
  v_expected text[];
BEGIN
  v_rows := public.arena_score_inputs_json('30D', 1000, 48);
  v_bundle := public.arena_score_inputs_publish_bundle_json('30D', 1000, 48);
  SELECT pg_catalog.array_agg(authority.filter_source ORDER BY authority.filter_source)
  INTO STRICT v_expected
  FROM public.arena_freshness_expected_sources() AS authority
  WHERE authority.season_id = '30D';

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(v_rows) AS score_row
    WHERE score_row->>'platform' LIKE 'bitget_bots_%'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(v_bundle->'physicalBoards') AS board
    WHERE board->>'registry_slug' LIKE 'bitget_bots_%'
  ) OR v_expected IS DISTINCT FROM ARRAY['human_futures']::text[] THEN
    RAISE EXCEPTION 'rank authority reader still includes Bitget bots';
  END IF;
END
$authority_readers$;
SQL

expect_failure \
  'delayed bot rank writer' \
  'leaderboard_ranks_block_cumulative_bitget_bot_authority' \
  "INSERT INTO public.leaderboard_ranks (
     season_id,source,source_trader_id,rank,arena_score,roi,pnl,win_rate,
     max_drawdown,score_completeness,metrics_estimated,is_outlier,computed_at
   ) VALUES (
     '30D','bitget_bots_futures','late-writer',1,99,10,100,60,10,
     'full',false,false,pg_catalog.now()
   )"

# Replay after post-cutover writes is the stronger idempotency case: the exact
# identity projection and a provenance-gated profile must survive byte-for-byte.
GUARD_OID_BEFORE="$(psql_cmd -Atqc \
  "SELECT 'arena.guard_bitget_bot_leaderboard_entry()'::regprocedure::oid")"
CORE_OID_BEFORE="$(psql_cmd -Atqc \
  "SELECT 'public.arena_core_modules(text,text,integer)'::regprocedure::oid")"
psql_cmd -q -f "$MIGRATION"
GUARD_OID_AFTER="$(psql_cmd -Atqc \
  "SELECT 'arena.guard_bitget_bot_leaderboard_entry()'::regprocedure::oid")"
CORE_OID_AFTER="$(psql_cmd -Atqc \
  "SELECT 'public.arena_core_modules(text,text,integer)'::regprocedure::oid")"
if [[ "$GUARD_OID_AFTER" != "$GUARD_OID_BEFORE" \
      || "$CORE_OID_AFTER" != "$CORE_OID_BEFORE" ]]; then
  echo "quarantine replay replaced a callable object identity" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DO $live_replay_preservation$
DECLARE
  v_raw jsonb;
  v_profile jsonb;
BEGIN
  SELECT entry.raw
  INTO STRICT v_raw
  FROM arena.leaderboard_entries AS entry
  WHERE entry.snapshot_id = 1100
    AND entry.trader_id = 101;

  v_profile := public.arena_core_modules(
    'bitget_bots_futures', '10001', 30
  );

  IF v_raw IS DISTINCT FROM
       '{"strategyId":"10001","strategyType":2,"productId":"BTCUSDT","strAccountId":"owner-1","status":"running"}'::jsonb
     OR (SELECT roi FROM arena.trader_stats
         WHERE trader_id = 101 AND timeframe = 30) <> 12
     OR (SELECT as_of FROM arena.trader_stats
         WHERE trader_id = 101 AND timeframe = 30) =
          '1970-01-01 00:00:00+00'::timestamptz
     OR (v_profile->'stats'->>'roi')::numeric <> 12
     OR (v_profile->'stats'->>'pnl')::numeric <> 120
     OR EXISTS (
       SELECT 1 FROM public.leaderboard_ranks
       WHERE source LIKE 'bitget_bots_%'
     )
     OR EXISTS (
       SELECT 1 FROM public.leaderboard_source_freshness
       WHERE source LIKE 'bitget_bots_%'
     )
     OR EXISTS (
       SELECT 1 FROM public.leaderboard_count_cache
       WHERE source LIKE 'bitget_bots_%'
     ) THEN
    RAISE EXCEPTION 'live replay lost canonical data or restored bot authority';
  END IF;
END
$live_replay_preservation$;
SQL

# The follow-up alias normalization must preserve the quarantine rewrite while
# converging padded/blank/null legacy aliases on the bundle's canonical key.
SCORE_OID_BEFORE_ALIAS="$(psql_cmd -Atqc \
  "SELECT 'public.arena_score_inputs_json(text,integer,integer)'::regprocedure::oid")"
psql_cmd -q -f "$ALIAS_MIGRATION"
SCORE_OID_AFTER_ALIAS="$(psql_cmd -Atqc \
  "SELECT 'public.arena_score_inputs_json(text,integer,integer)'::regprocedure::oid")"
if [[ "$SCORE_OID_AFTER_ALIAS" != "$SCORE_OID_BEFORE_ALIAS" ]]; then
  echo "alias normalization replaced the score-input callable identity" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DO $alias_normalization$
DECLARE
  v_rows jsonb;
  v_bundle jsonb;
  v_platforms text[];
  v_physical_platforms text[];
BEGIN
  UPDATE arena.sources
  SET meta = '{"legacy_platform":"  human_alias  "}'::jsonb
  WHERE id = 3;

  v_rows := public.arena_score_inputs_json('30D', 1000, 48);
  v_bundle := public.arena_score_inputs_publish_bundle_json('30D', 1000, 48);
  SELECT pg_catalog.array_agg(DISTINCT score_row->>'platform')
  INTO v_platforms
  FROM pg_catalog.jsonb_array_elements(v_rows) AS score_row;
  SELECT pg_catalog.array_agg(DISTINCT board->>'filter_source')
  INTO v_physical_platforms
  FROM pg_catalog.jsonb_array_elements(v_bundle->'physicalBoards') AS board;
  IF v_platforms IS DISTINCT FROM ARRAY['human_alias']::text[]
     OR v_physical_platforms IS DISTINCT FROM ARRAY['human_alias']::text[] THEN
    RAISE EXCEPTION
      'padded alias did not converge across score and physical-board surfaces: %/%',
      v_platforms,
      v_physical_platforms;
  END IF;

  UPDATE arena.sources
  SET meta = '{"legacy_platform":"   "}'::jsonb
  WHERE id = 3;
  v_rows := public.arena_score_inputs_json('30D', 1000, 48);
  IF EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements(v_rows) AS score_row
       WHERE score_row->>'platform' <> 'human_futures'
     ) OR pg_catalog.jsonb_array_length(v_rows) = 0 THEN
    RAISE EXCEPTION 'blank alias did not fall back to registry slug';
  END IF;

  UPDATE arena.sources
  SET meta = '{"legacy_platform":null}'::jsonb
  WHERE id = 3;
  v_rows := public.arena_score_inputs_json('30D', 1000, 48);
  IF EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements(v_rows) AS score_row
       WHERE score_row->>'platform' <> 'human_futures'
     ) OR pg_catalog.jsonb_array_length(v_rows) = 0 THEN
    RAISE EXCEPTION 'JSON null alias did not fall back to registry slug';
  END IF;

  UPDATE arena.sources
  SET meta = '{"legacy_platform":" null "}'::jsonb
  WHERE id = 3;
  v_rows := public.arena_score_inputs_json('30D', 1000, 48);
  v_bundle := public.arena_score_inputs_publish_bundle_json('30D', 1000, 48);
  IF pg_catalog.jsonb_array_length(v_rows) <> 0
     OR pg_catalog.jsonb_array_length(v_bundle->'physicalBoards') <> 0 THEN
    RAISE EXCEPTION 'padded string null alias remained publishable';
  END IF;

  UPDATE arena.sources
  SET meta = '{}'::jsonb
  WHERE id = 3;
  v_rows := public.arena_score_inputs_json('30D', 1000, 48);
  IF pg_catalog.jsonb_array_length(v_rows) = 0
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements(v_rows) AS score_row
       WHERE score_row->>'platform' LIKE 'bitget_bots_%'
     ) THEN
    RAISE EXCEPTION 'alias rewrite removed human rows or reopened bot ranks';
  END IF;
END
$alias_normalization$;
SQL

# Replay must be a no-op over the already normalized source body and preserve
# the same callable object identity.
psql_cmd -q -f "$ALIAS_MIGRATION"
SCORE_OID_AFTER_ALIAS_REPLAY="$(psql_cmd -Atqc \
  "SELECT 'public.arena_score_inputs_json(text,integer,integer)'::regprocedure::oid")"
if [[ "$SCORE_OID_AFTER_ALIAS_REPLAY" != "$SCORE_OID_BEFORE_ALIAS" ]]; then
  echo "alias normalization replay replaced the score-input callable identity" >&2
  exit 1
fi

echo "Bitget bot rank quarantine and platform-alias normalization PG17 proof passed"
