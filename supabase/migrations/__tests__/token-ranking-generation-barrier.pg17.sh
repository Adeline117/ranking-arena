#!/usr/bin/env bash

# PostgreSQL 17 integration proof for the token MV generation/read barrier.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729230000_token_ranking_generation_barrier.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  [[ -x "$PG_BIN/$executable" ]] || {
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  }
done
[[ "$($PG_BIN/psql --version)" == psql\ \(PostgreSQL\)\ 17.* ]] || {
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
}

TMP_ROOT="$(mktemp -d /tmp/token-ranking-generation-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
REFRESH_LOG="$TMP_ROOT/refresh.log"
PORT="${PGPORT_OVERRIDE:-$((58000 + ($$ % 4000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -180 "$LOG_FILE" >&2 || true
  fi
  if ((exit_code != 0)) && [[ -f "$REFRESH_LOG" ]]; then
    tail -120 "$REFRESH_LOG" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_db() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

assert_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "$label: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

psql_db -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE outsider NOLOGIN;
CREATE SCHEMA arena AUTHORIZATION postgres;
CREATE SCHEMA cron AUTHORIZATION postgres;

ALTER DATABASE postgres SET cron.use_background_workers = 'off';

CREATE TABLE cron.job (
  jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jobname text NOT NULL UNIQUE,
  schedule text NOT NULL,
  command text NOT NULL,
  database text NOT NULL,
  username text NOT NULL,
  active boolean NOT NULL
);

INSERT INTO cron.job (
  jobname,
  schedule,
  command,
  database,
  username,
  active
) VALUES (
  'refresh-mv-popular-tokens',
  '*/30 * * * *',
  'SELECT public.refresh_popular_tokens_mv()',
  pg_catalog.current_database(),
  'postgres',
  true
);

CREATE TABLE public.token_daily_source (
  trade_date date NOT NULL,
  token text NOT NULL,
  source text NOT NULL,
  source_trader_id text NOT NULL,
  token_pnl numeric NOT NULL,
  trade_count bigint NOT NULL,
  win_count bigint NOT NULL,
  pnl_pct_sum numeric,
  pnl_pct_count bigint NOT NULL
);

CREATE FUNCTION public.token_refresh_probe_pause()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_seconds numeric;
BEGIN
  v_seconds := COALESCE(
    NULLIF(pg_catalog.current_setting('arena.token_refresh_pause', true), '')::numeric,
    0
  );
  IF v_seconds > 0 THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(23002300);
    PERFORM pg_catalog.pg_sleep(v_seconds::double precision);
  END IF;
  RETURN 1;
END
$function$;

CREATE MATERIALIZED VIEW public.mv_token_trader_daily_90d AS
SELECT
  source_row.trade_date,
  source_row.token,
  source_row.source,
  source_row.source_trader_id,
  source_row.token_pnl,
  source_row.trade_count,
  source_row.win_count,
  source_row.pnl_pct_sum,
  source_row.pnl_pct_count,
  pg_catalog.current_setting('TimeZone') AS refresh_timezone
FROM public.token_daily_source AS source_row;

CREATE UNIQUE INDEX idx_token_daily_generation_proof
  ON public.mv_token_trader_daily_90d (
    trade_date,
    token,
    source,
    source_trader_id
  );

CREATE MATERIALIZED VIEW public.mv_popular_tokens_90d AS
WITH refresh_gate AS MATERIALIZED (
  SELECT public.token_refresh_probe_pause() AS marker
)
SELECT
  daily.token,
  pg_catalog.sum(daily.trade_count)::bigint AS trade_count,
  pg_catalog.count(DISTINCT (daily.source, daily.source_trader_id))::bigint
    AS trader_count,
  pg_catalog.round(pg_catalog.sum(daily.token_pnl), 2) AS total_pnl
FROM public.mv_token_trader_daily_90d AS daily
CROSS JOIN refresh_gate
GROUP BY daily.token;

CREATE UNIQUE INDEX idx_popular_token_generation_proof
  ON public.mv_popular_tokens_90d (token);

CREATE FUNCTION public.get_token_trader_rankings(
  token_symbol text,
  lookback_days integer DEFAULT 90,
  max_traders integer DEFAULT 50,
  row_offset integer DEFAULT 0
)
RETURNS TABLE(
  source text,
  source_trader_id text,
  token_rank bigint,
  token_pnl numeric,
  token_trade_count bigint,
  token_win_rate numeric,
  token_avg_pnl_pct numeric,
  total_count bigint
)
LANGUAGE sql
AS 'SELECT NULL::text, NULL::text, NULL::bigint, NULL::numeric, NULL::bigint, NULL::numeric, NULL::numeric, 0::bigint WHERE false';

CREATE FUNCTION public.get_popular_tokens(
  lookback_days integer DEFAULT 90,
  max_tokens integer DEFAULT 50
)
RETURNS TABLE(
  token text,
  trade_count bigint,
  trader_count bigint,
  total_pnl numeric
)
LANGUAGE sql
AS 'SELECT NULL::text, NULL::bigint, NULL::bigint, NULL::numeric WHERE false';

CREATE FUNCTION public.refresh_popular_tokens_mv()
RETURNS void
LANGUAGE plpgsql
AS 'BEGIN NULL; END';

INSERT INTO public.token_daily_source (
  trade_date,
  token,
  source,
  source_trader_id,
  token_pnl,
  trade_count,
  win_count,
  pnl_pct_sum,
  pnl_pct_count
) VALUES
  (CURRENT_DATE, 'BTC', 'z-source', 'trader-z', 100, 2, 1, 5, 2),
  (CURRENT_DATE, 'BTC', 'a-source', 'trader-b', 100, 4, 3, 8, 4),
  (CURRENT_DATE, 'BTC', 'a-source', 'trader-a', 100, 1, 1, 3, 1),
  (CURRENT_DATE, 'BTC', 'c-source', 'trader-c', 50, 5, 2, NULL, 0),
  (CURRENT_DATE, 'ETH', 'a-source', 'eth-trader', 999, 1, 1, 9, 1);

REFRESH MATERIALIZED VIEW public.mv_token_trader_daily_90d;
REFRESH MATERIALIZED VIEW public.mv_popular_tokens_90d;
SQL

psql_db -q -f "$MIGRATION"

CRON_CONTRACT="$(psql_db -Atqc "
  SELECT
    pg_catalog.current_setting('cron.use_background_workers') || '|' ||
    job.schedule || '|' || job.command || '|' ||
    (job.database = pg_catalog.current_database()) || '|' ||
    job.username || '|' || job.active
  FROM cron.job AS job
  WHERE job.jobname = 'refresh-mv-popular-tokens';")"
assert_equal \
  "refresh cron arms timeout before its SELECT" \
  "off|*/30 * * * *|SET statement_timeout = '25min'; SELECT public.refresh_popular_tokens_mv();|true|postgres|true" \
  "$CRON_CONTRACT"

BOOTSTRAP="$(psql_db -Atqc "
  SELECT generation_seq || '|' ||
    (published_at IS NULL) || '|' ||
    (published_at_epoch_ms IS NULL) || '|' ||
    (window_through_date IS NULL) || '|' ||
    (source_as_of IS NULL) || '|' ||
    daily_row_count || '|' || popular_row_count
  FROM public.get_token_ranking_publication_head();")"
assert_equal "honest bootstrap head" "0|true|true|true|true|5|2" "$BOOTSTRAP"

set +e
MODE_OUTPUT="$(psql_db -q -c "SET cron.use_background_workers = 'on'; SELECT public.refresh_popular_tokens_mv();" 2>&1)"
MODE_STATUS=$?
set -e
if ((MODE_STATUS == 0)); then
  echo "background-worker refresh mode unexpectedly published" >&2
  exit 1
fi
[[ "$MODE_OUTPUT" == *"token ranking refresh requires pg_cron libpq mode"* ]] || {
  echo "unexpected background-worker rejection: $MODE_OUTPUT" >&2
  exit 1
}

psql_db -q <<'SQL'
DO $proof$
BEGIN
  PERFORM public.get_token_trader_rankings_v2('BTC', 90, 2, 0, 0);
  RAISE EXCEPTION 'generation zero unexpectedly served';
EXCEPTION
  WHEN SQLSTATE '55000' THEN NULL;
END
$proof$;
SQL

V1_PAGE="$(psql_db -Atqc "
  SELECT pg_catalog.string_agg(
    token_rank || ':' || source || ':' || source_trader_id || ':' || total_count,
    ',' ORDER BY token_rank
  )
  FROM public.get_token_trader_rankings('BTC', 90, 2, 0);")"
assert_equal \
  "rolling v1 uses canonical deterministic payload" \
  "1:a-source:trader-a:4,2:a-source:trader-b:4" \
  "$V1_PAGE"

V1_CONTRACT="$(psql_db -Atqc "
  SELECT pg_catalog.pg_get_function_result(
    'public.get_token_trader_rankings(text,integer,integer,integer)'::pg_catalog.regprocedure
  );")"
assert_equal \
  "rolling v1 return contract" \
  "TABLE(source text, source_trader_id text, token_rank bigint, token_pnl numeric, token_trade_count bigint, token_win_rate numeric, token_avg_pnl_pct numeric, total_count bigint)" \
  "$V1_CONTRACT"

psql_db -q <<'SQL'
SET "TimeZone" = 'America/Los_Angeles';
SELECT public.refresh_popular_tokens_mv();
SQL

HEAD_ONE="$(psql_db -Atqc "
  SELECT generation_seq || '|' ||
    (published_at IS NOT NULL) || '|' ||
    (published_at_epoch_ms IS NOT NULL) || '|' ||
    (window_through_date = pg_catalog.timezone(
      'UTC',
      pg_catalog.transaction_timestamp()
    )::date) || '|' ||
    (source_as_of IS NULL) || '|' ||
    daily_row_count || '|' || popular_row_count
  FROM public.get_token_ranking_publication_head();")"
assert_equal "first controlled publication" "1|true|true|true|true|5|2" "$HEAD_ONE"

REFRESH_TIMEZONE="$(psql_db -Atqc "
  SELECT pg_catalog.string_agg(DISTINCT refresh_timezone, ',' ORDER BY refresh_timezone)
  FROM public.mv_token_trader_daily_90d;")"
assert_equal "refresh pins MV date bucketing to UTC" "UTC" "$REFRESH_TIMEZONE"

PAGE_ONE="$(psql_db -Atqc "
  SELECT
    (payload->>'contract') || '|' ||
    (payload->>'generation') || '|' ||
    (payload->>'token') || '|' ||
    ((payload->>'published_at_epoch_ms')::bigint = (
      SELECT published_at_epoch_ms
      FROM public.get_token_ranking_publication_head()
    )) || '|' ||
    (payload->>'window_through_date' = (
      SELECT window_through_date::text
      FROM public.get_token_ranking_publication_head()
    )) || '|' ||
    (payload->>'total') || '|' ||
    (payload->'traders'->0->>'token_rank') || '|' ||
    (payload->'traders'->0->>'source_trader_id') || '|' ||
    (payload->>'source_as_of' IS NULL)
  FROM (
    SELECT public.get_token_trader_rankings_v2('btc', 90, 2, 0, 1) AS payload
  ) AS response;")"
assert_equal \
  "generation-bound token page" \
  "token-ranking-page@1|1|BTC|true|true|4|1|trader-a|true" \
  "$PAGE_ONE"

POPULAR_ONE="$(psql_db -Atqc "
  SELECT
    (payload->>'contract') || '|' ||
    (payload->>'generation') || '|' ||
    ((payload->>'published_at_epoch_ms')::bigint = (
      SELECT published_at_epoch_ms
      FROM public.get_token_ranking_publication_head()
    )) || '|' ||
    (payload->>'window_through_date' = (
      SELECT window_through_date::text
      FROM public.get_token_ranking_publication_head()
    )) || '|' ||
    (payload->>'total') || '|' ||
    (payload->'tokens'->0->>'token')
  FROM (
    SELECT public.get_popular_tokens_v2(90, 1, 1) AS payload
  ) AS response;")"
assert_equal \
  "generation-bound popular tokens" \
  "popular-token-page@1|1|true|true|2|BTC" \
  "$POPULAR_ONE"

psql_db -q <<'SQL'
DO $proof$
DECLARE
  v_detail text;
BEGIN
  PERFORM public.get_token_trader_rankings_v2('BTC', 90, 2, 0, 0);
  RAISE EXCEPTION 'stale generation unexpectedly served';
EXCEPTION
  WHEN SQLSTATE '40001' THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF v_detail IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'stale token detail mismatch: %', v_detail;
    END IF;
END
$proof$;

DO $proof$
DECLARE
  v_detail text;
BEGIN
  PERFORM public.get_popular_tokens_v2(90, 1, 0);
  RAISE EXCEPTION 'stale popular generation unexpectedly served';
EXCEPTION
  WHEN SQLSTATE '40001' THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF v_detail IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'stale popular detail mismatch: %', v_detail;
    END IF;
END
$proof$;
SQL

ACL="$(psql_db -Atqc "
  SELECT
    pg_catalog.has_table_privilege(
      'service_role',
      'arena.token_ranking_publication_head',
      'SELECT'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'service_role',
      'public.get_token_trader_rankings_v2(text,integer,integer,integer,bigint)',
      'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'anon',
      'public.get_token_trader_rankings_v2(text,integer,integer,integer,bigint)',
      'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'outsider',
      'public.refresh_popular_tokens_mv()',
      'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'service_role',
      'public.refresh_popular_tokens_mv()',
      'EXECUTE'
    );")"
assert_equal "private head, service reads, and owner-only refresh" "false|true|false|false|false" "$ACL"

# The timeout must be armed by a statement before the refresh SELECT, exactly
# like the libpq-mode pg_cron command. A canceled second-MV refresh rolls back
# the first MV and publication head in the same implicit transaction.
psql_db -q <<'SQL'
INSERT INTO public.token_daily_source (
  trade_date, token, source, source_trader_id, token_pnl,
  trade_count, win_count, pnl_pct_sum, pnl_pct_count
) VALUES (
  pg_catalog.timezone('UTC', pg_catalog.transaction_timestamp())::date,
  'BTC', 'timeout-source', 'timeout-trader', 250,
  1, 1, 2, 1
);
SQL

set +e
TIMEOUT_OUTPUT="$(psql_db -q -c "SET arena.token_refresh_pause = '1'; SET statement_timeout = '100ms'; SELECT public.refresh_popular_tokens_mv();" 2>&1)"
TIMEOUT_STATUS=$?
set -e
if ((TIMEOUT_STATUS == 0)); then
  echo "caller-armed refresh timeout unexpectedly succeeded" >&2
  exit 1
fi
[[ "$TIMEOUT_OUTPUT" == *"canceling statement due to statement timeout"* ]] || {
  echo "unexpected caller-armed timeout error: $TIMEOUT_OUTPUT" >&2
  exit 1
}

TIMEOUT_ROLLBACK="$(psql_db -Atqc "
  SELECT
    (SELECT generation_seq FROM arena.token_ranking_publication_head) || '|' ||
    (SELECT pg_catalog.count(*) FROM public.mv_token_trader_daily_90d) || '|' ||
    (SELECT pg_catalog.count(*) FROM public.mv_token_trader_daily_90d
      WHERE source_trader_id = 'timeout-trader');")"
assert_equal "caller timeout rolls back MV and head" "1|5|0" "$TIMEOUT_ROLLBACK"
psql_db -q -c "DELETE FROM public.token_daily_source WHERE source_trader_id = 'timeout-trader';"

# A source row beyond the UTC publication window is untrusted. The controlled
# refresh must reject it and keep both the published MVs and head unchanged.
psql_db -q <<'SQL'
INSERT INTO public.token_daily_source (
  trade_date, token, source, source_trader_id, token_pnl,
  trade_count, win_count, pnl_pct_sum, pnl_pct_count
) VALUES (
  pg_catalog.timezone('UTC', pg_catalog.transaction_timestamp())::date + 1,
  'BTC', 'future-source', 'future-trader', 500,
  1, 1, 5, 1
);
SQL

set +e
FUTURE_OUTPUT="$(psql_db -q -c "SELECT public.refresh_popular_tokens_mv();" 2>&1)"
FUTURE_STATUS=$?
set -e
if ((FUTURE_STATUS == 0)); then
  echo "future-dated source unexpectedly published" >&2
  exit 1
fi
[[ "$FUTURE_OUTPUT" == *"token ranking source contains future UTC dates"* ]] || {
  echo "unexpected future-date rejection: $FUTURE_OUTPUT" >&2
  exit 1
}

FUTURE_ROLLBACK="$(psql_db -Atqc "
  SELECT
    (SELECT generation_seq FROM arena.token_ranking_publication_head) || '|' ||
    (SELECT pg_catalog.count(*) FROM public.mv_token_trader_daily_90d) || '|' ||
    (SELECT pg_catalog.count(*) FROM public.mv_token_trader_daily_90d
      WHERE source_trader_id = 'future-trader');")"
assert_equal "future-date rejection rolls back MV and head" "1|5|0" "$FUTURE_ROLLBACK"
psql_db -q -c "DELETE FROM public.token_daily_source WHERE source_trader_id = 'future-trader';"

# A failure after the daily refresh but before the publication-head UPDATE must
# roll back both the new daily contents and the generation.
psql_db -q <<'SQL'
INSERT INTO public.token_daily_source (
  trade_date, token, source, source_trader_id, token_pnl,
  trade_count, win_count, pnl_pct_sum, pnl_pct_count
) VALUES (
  CURRENT_DATE, 'BTC', 'new-source', 'rollback-trader', 200,
  1, 1, 2, 1
);
DROP INDEX public.idx_popular_token_generation_proof;
SQL

set +e
FAILURE_OUTPUT="$(psql_db -q -c "SELECT public.refresh_popular_tokens_mv();" 2>&1)"
FAILURE_STATUS=$?
set -e
if ((FAILURE_STATUS == 0)); then
  echo "broken second MV refresh unexpectedly committed" >&2
  exit 1
fi
[[ "$FAILURE_OUTPUT" == *"cannot refresh materialized view"* ]] || {
  echo "unexpected failed-refresh error: $FAILURE_OUTPUT" >&2
  exit 1
}

ROLLBACK_STATE="$(psql_db -Atqc "
  SELECT
    (SELECT generation_seq FROM arena.token_ranking_publication_head) || '|' ||
    (SELECT pg_catalog.count(*) FROM public.mv_token_trader_daily_90d) || '|' ||
    (SELECT pg_catalog.count(*) FROM public.mv_token_trader_daily_90d
      WHERE source_trader_id = 'rollback-trader');")"
assert_equal "failed publication rolls back MV and head" "1|5|0" "$ROLLBACK_STATE"

psql_db -q <<'SQL'
CREATE UNIQUE INDEX idx_popular_token_generation_proof
  ON public.mv_popular_tokens_90d (token);
SELECT public.refresh_popular_tokens_mv();
SQL

AFTER_RECOVERY="$(psql_db -Atqc "
  SELECT
    (SELECT generation_seq FROM arena.token_ranking_publication_head) || '|' ||
    (SELECT pg_catalog.count(*) FROM public.mv_token_trader_daily_90d) || '|' ||
    (SELECT pg_catalog.count(*) FROM public.mv_token_trader_daily_90d
      WHERE source_trader_id = 'rollback-trader');")"
assert_equal "successful retry publishes once" "2|6|1" "$AFTER_RECOVERY"

# Put a new row behind a deliberately slow popular-MV refresh. While the first
# MV has refreshed inside the writer transaction, an ordinary v2 reader must
# return the old head plus old daily contents without blocking. Only commit may
# expose the new row and generation. A second writer must still fail immediately
# with 55P03 instead of queuing another 30M-row refresh.
psql_db -q <<'SQL'
INSERT INTO public.token_daily_source (
  trade_date, token, source, source_trader_id, token_pnl,
  trade_count, win_count, pnl_pct_sum, pnl_pct_count
) VALUES (
  pg_catalog.timezone('UTC', pg_catalog.transaction_timestamp())::date,
  'BTC', 'atomic-source', 'atomic-reader', 300,
  1, 1, 3, 1
);
SQL

(
  psql_db -q <<'SQL'
SET arena.token_refresh_pause = '3';
SELECT public.refresh_popular_tokens_mv();
SQL
) >"$REFRESH_LOG" 2>&1 &
REFRESH_PID=$!
PAUSE_READY=0
for _attempt in {1..50}; do
  if [[ "$(psql_db -Atqc "SELECT pg_catalog.pg_try_advisory_lock(23002300);")" == 'f' ]]; then
    PAUSE_READY=1
    break
  fi
  sleep 0.1
done
if ((PAUSE_READY != 1)); then
  echo "slow popular refresh never reached its transaction barrier" >&2
  exit 1
fi

MID_REFRESH_READ="$(psql_db -Atqc "
  WITH response AS MATERIALIZED (
    SELECT public.get_token_trader_rankings_v2('BTC', 90, 200, 0, 2) AS payload
  )
  SELECT
    (SELECT generation_seq FROM public.get_token_ranking_publication_head()) || '|' ||
    (response.payload->>'generation') || '|' ||
    (response.payload->>'total') || '|' ||
    pg_catalog.jsonb_path_exists(
      response.payload->'traders',
      '\$[*] ? (@.source_trader_id == \"atomic-reader\")'
    )
  FROM response;")"
assert_equal \
  "mid-refresh reader sees one nonblocking old snapshot" \
  "2|2|5|false" \
  "$MID_REFRESH_READ"
if ! kill -0 "$REFRESH_PID" 2>/dev/null; then
  echo "ordinary v2 reader blocked until the writer committed" >&2
  exit 1
fi

set +e
OVERLAP_OUTPUT="$(psql_db -q -c "SELECT public.refresh_popular_tokens_mv();" 2>&1)"
OVERLAP_STATUS=$?
set -e
if ((OVERLAP_STATUS == 0)); then
  echo "overlapping refresh unexpectedly queued or succeeded" >&2
  exit 1
fi
[[ "$OVERLAP_OUTPUT" == *"could not obtain lock on row"* ]] || {
  echo "unexpected overlapping-refresh error: $OVERLAP_OUTPUT" >&2
  exit 1
}
wait "$REFRESH_PID"

GENERATION_THREE="$(psql_db -Atqc "
  SELECT generation_seq FROM arena.token_ranking_publication_head;")"
assert_equal "one overlapping caller advances once" "3" "$GENERATION_THREE"

AFTER_ATOMIC_COMMIT="$(psql_db -Atqc "
  WITH response AS MATERIALIZED (
    SELECT public.get_token_trader_rankings_v2('BTC', 90, 200, 0, 3) AS payload
  )
  SELECT
    (response.payload->>'generation') || '|' ||
    (response.payload->>'total') || '|' ||
    pg_catalog.jsonb_path_exists(
      response.payload->'traders',
      '\$[*] ? (@.source_trader_id == \"atomic-reader\")'
    )
  FROM response;")"
assert_equal \
  "commit exposes new head and daily contents together" \
  "3|6|true" \
  "$AFTER_ATOMIC_COMMIT"

psql_db -q <<'SQL'
DO $proof$
BEGIN
  PERFORM public.get_token_trader_rankings_v2('BTC', 90, 200, 0, 2);
  RAISE EXCEPTION 'pre-commit generation unexpectedly survived commit';
EXCEPTION
  WHEN SQLSTATE '40001' THEN NULL;
END
$proof$;
SQL

# Replay must preserve the already-published generation rather than resetting
# the head to bootstrap state.
psql_db -q -f "$MIGRATION"
REPLAY_GENERATION="$(psql_db -Atqc "
  SELECT generation_seq FROM arena.token_ranking_publication_head;")"
assert_equal "idempotent migration replay preserves head" "3" "$REPLAY_GENERATION"

echo "token ranking generation barrier PostgreSQL 17 proof passed"
