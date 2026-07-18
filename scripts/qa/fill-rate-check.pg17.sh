#!/usr/bin/env bash

# PostgreSQL 17 integration proof for scripts/qa/fill-rate-check.mjs.
# Exercises the real SQL writer against a disposable database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260718140000_add_metric_completeness_daily.sql"
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

TMP_ROOT="$(mktemp -d /tmp/fill-rate-check-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
CHECK_OUTPUT="$TMP_ROOT/check-output.log"
PORT="${PGPORT_OVERRIDE:-$((58000 + ($$ % 7000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)); then
    [[ -f "$CHECK_OUTPUT" ]] && tail -160 "$CHECK_OUTPUT" >&2 || true
    [[ -f "$LOG_FILE" ]] && tail -160 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

run_check() {
  DATABASE_URL="postgresql://127.0.0.1:$PORT/postgres" \
    REQUIRE_DATABASE_URL=1 \
    node "$ROOT_DIR/scripts/qa/fill-rate-check.mjs" >"$CHECK_OUTPUT" 2>&1
}

expect_check_failure() {
  local label="$1"
  if run_check; then
    echo "$label unexpectedly succeeded" >&2
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
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=127.0.0.1" \
  -w start >/dev/null

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA arena;

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL,
  meta jsonb NOT NULL,
  timeframes_native int[] NOT NULL,
  timeframes_derived int[] NOT NULL,
  deep_profile_topn int NOT NULL DEFAULT 0
);

CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id)
);

CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL,
  actual_count int NOT NULL,
  count_check_passed boolean NOT NULL
);

CREATE TABLE arena.leaderboard_entries (
  snapshot_id bigint NOT NULL,
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  scraped_at timestamptz NOT NULL,
  timeframe smallint NOT NULL
);

CREATE TABLE arena.trader_stats (
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  timeframe smallint NOT NULL,
  as_of timestamptz NOT NULL,
  roi numeric,
  pnl numeric,
  sharpe numeric,
  mdd numeric,
  win_rate numeric,
  win_positions int,
  total_positions int,
  copier_pnl numeric,
  copier_count int,
  aum numeric,
  volume numeric,
  profit_share_rate numeric,
  holding_duration_avg interval,
  PRIMARY KEY (trader_id, timeframe)
);

CREATE TABLE public.leaderboard_source_freshness (
  season_id text NOT NULL,
  source text NOT NULL,
  source_as_of timestamptz NOT NULL,
  PRIMARY KEY (season_id, source)
);

CREATE TABLE arena.metric_fill_trend (
  taken_on date NOT NULL,
  slug text NOT NULL,
  metric text NOT NULL,
  filled bigint NOT NULL,
  total bigint NOT NULL,
  PRIMARY KEY (taken_on, slug, metric)
);
SQL

psql_cmd -q -f "$MIGRATION"

psql_cmd -q <<'SQL'
INSERT INTO arena.sources (
  id, slug, status, serving_mode, meta, timeframes_native, timeframes_derived
) VALUES (
  1,
  'example',
  'active',
  'serving',
  '{"legacy_platform":"example_public","expected_metrics":["roi"]}',
  '{7}',
  '{}'
);

INSERT INTO arena.traders (id, source_id) VALUES (101, 1);

-- The newer failed snapshot must never hide the older passed snapshot.
INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, scraped_at, actual_count, count_check_passed
) VALUES
  (1001, 1, 7, now() - interval '1 hour', 1, true),
  (1002, 1, 7, now(), 0, false);

INSERT INTO arena.leaderboard_entries (
  snapshot_id, trader_id, scraped_at, timeframe
)
SELECT id, 101, scraped_at, timeframe
FROM arena.leaderboard_snapshots
WHERE id = 1001;

-- Numeric zero is a present value and must count as filled.
INSERT INTO arena.trader_stats (trader_id, timeframe, as_of, roi)
VALUES (101, 7, now() - interval '1 hour', 0);

INSERT INTO public.leaderboard_source_freshness (season_id, source, source_as_of)
VALUES ('7D', 'example_public', now() - interval '1 hour');
SQL

run_check

HEALTHY="$(
  psql_cmd -Atqc "
    SELECT measurement_state || '|' || population_total || '|' || stats_total ||
           '|' || fresh_stats_total || '|' || filled || '|' || fresh_filled
    FROM arena.metric_completeness_daily
    WHERE source_id = 1 AND timeframe = 7 AND metric = 'roi';
  "
)"
if [[ "$HEALTHY" != "measured|1|1|1|1|1" ]]; then
  echo "healthy cohort evidence drifted: $HEALTHY" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
-- Neither a non-member nor a wrong-timeframe row may inflate board evidence.
INSERT INTO arena.traders (id, source_id) VALUES (102, 1);
INSERT INTO arena.trader_stats (trader_id, timeframe, as_of, roi) VALUES
  (102, 7, now() - interval '1 hour', 10),
  (101, 30, now() - interval '1 hour', 20);
SQL

run_check

COHORT_VS_LEGACY="$(
  psql_cmd -Atqc "
    SELECT
      evidence.population_total || '|' || evidence.filled || '|' ||
      trend.total || '|' || trend.filled
    FROM arena.metric_completeness_daily AS evidence
    JOIN arena.metric_fill_trend AS trend
      ON trend.taken_on = evidence.taken_on
     AND trend.slug = 'example'
     AND trend.metric = evidence.metric
    WHERE evidence.source_id = 1
      AND evidence.timeframe = 7
      AND evidence.metric = 'roi';
  "
)"
if [[ "$COHORT_VS_LEGACY" != "1|1|3|3" ]]; then
  echo "board cohort or legacy trend semantics drifted: $COHORT_VS_LEGACY" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
INSERT INTO arena.sources (
  id, slug, status, serving_mode, meta, timeframes_native, timeframes_derived
) VALUES (
  2,
  'missing-board',
  'active',
  'serving',
  '{"expected_metrics":["roi"]}',
  '{30}',
  '{}'
);
INSERT INTO public.leaderboard_source_freshness (season_id, source, source_as_of)
VALUES ('30D', 'missing-board', now() - interval '1 hour');
SQL

expect_check_failure "missing board hard gate"

MISSING="$(
  psql_cmd -Atqc "
    SELECT measurement_state || '|' || population_total || '|' || filled
    FROM arena.metric_completeness_daily
    WHERE source_id = 2 AND timeframe = 30 AND metric = 'roi';
  "
)"
if [[ "$MISSING" != "missing_board_snapshot|0|0" ]]; then
  echo "missing-board evidence was not committed: $MISSING" >&2
  exit 1
fi

# A configured database with an unavailable evidence sink must fail closed
# before the compatibility trend can be partially rewritten.
TREND_BEFORE="$(
  psql_cmd -Atqc "
    SELECT filled || '|' || total
    FROM arena.metric_fill_trend
    WHERE taken_on = (transaction_timestamp() AT TIME ZONE 'UTC')::date
      AND slug = 'example'
      AND metric = 'roi';
  "
)"
psql_cmd -q -c \
  "ALTER TABLE arena.metric_completeness_daily RENAME TO metric_completeness_daily_offline"
expect_check_failure "evidence write failure"
psql_cmd -q -c \
  "ALTER TABLE arena.metric_completeness_daily_offline RENAME TO metric_completeness_daily"
TREND_AFTER="$(
  psql_cmd -Atqc "
    SELECT filled || '|' || total
    FROM arena.metric_fill_trend
    WHERE taken_on = (transaction_timestamp() AT TIME ZONE 'UTC')::date
      AND slug = 'example'
      AND metric = 'roi';
  "
)"
if [[ "$TREND_BEFORE" != "$TREND_AFTER" ]]; then
  echo "evidence write failure partially rewrote legacy trend" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
INSERT INTO arena.sources (
  id, slug, status, serving_mode, meta, timeframes_native, timeframes_derived
) VALUES (
  3,
  'broken-membership',
  'active',
  'serving',
  '{"expected_metrics":["roi"]}',
  '{90}',
  '{}'
);
INSERT INTO arena.traders (id, source_id) VALUES (301, 3);
INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, scraped_at, actual_count, count_check_passed
) VALUES (3001, 3, 90, now() - interval '1 hour', 2, true);
INSERT INTO arena.leaderboard_entries (
  snapshot_id, trader_id, scraped_at, timeframe
)
SELECT id, 301, scraped_at, timeframe
FROM arena.leaderboard_snapshots
WHERE id = 3001;
INSERT INTO arena.trader_stats (trader_id, timeframe, as_of, roi)
VALUES (301, 90, now() - interval '1 hour', 1);
INSERT INTO public.leaderboard_source_freshness (season_id, source, source_as_of)
VALUES ('90D', 'broken-membership', now() - interval '1 hour');
SQL

expect_check_failure "inconsistent passed snapshot membership"
if ! rg -q "passed snapshot membership is inconsistent" "$CHECK_OUTPUT"; then
  echo "membership failure did not identify the broken invariant" >&2
  exit 1
fi

BROKEN_ROWS="$(
  psql_cmd -Atqc "
    SELECT count(*)
    FROM arena.metric_completeness_daily
    WHERE source_id = 3;
  "
)"
if [[ "$BROKEN_ROWS" != "0" ]]; then
  echo "broken membership wrote partial evidence: $BROKEN_ROWS rows" >&2
  exit 1
fi

echo "fill-rate-check PostgreSQL 17 proof passed"
