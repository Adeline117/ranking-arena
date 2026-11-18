#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof that the index-probe rewrite of
# arena.mv_source_capabilities (20261117204557) yields exactly the rows of the
# original definition (20260703004045), still refreshes, and moves the cron
# job to hourly at :17. This cluster never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ORIGINAL="$ROOT_DIR/supabase/migrations/20260703004045_materialize_source_capabilities.sql"
MIGRATION="$ROOT_DIR/supabase/migrations/20261117204557_source_capabilities_refresh_index_probe.sql"
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

TMP_ROOT="$(mktemp -d /tmp/source-capabilities-probe-pg17.XXXXXX)"
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

psql_db() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

assert_equal() {
  if [[ "$2" != "$3" ]]; then
    echo "$1: expected '$2', got '$3'" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

psql_db -q <<'SQL'
-- pg_cron stand-in: the two entry points the migrations call.
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobname text PRIMARY KEY, schedule text NOT NULL, command text NOT NULL);
CREATE FUNCTION cron.unschedule(p_name text) RETURNS boolean LANGUAGE sql AS
  $$ DELETE FROM cron.job WHERE jobname = p_name RETURNING true $$;
CREATE FUNCTION cron.schedule(p_name text, p_schedule text, p_command text) RETURNS bigint
  LANGUAGE sql AS $$ INSERT INTO cron.job VALUES (p_name, p_schedule, p_command) RETURNING 1::bigint $$;

CREATE SCHEMA arena;
CREATE TABLE arena.exchanges (id int PRIMARY KEY, name text NOT NULL);
CREATE TABLE arena.sources (
  id int PRIMARY KEY, slug text UNIQUE NOT NULL, exchange_id int NOT NULL, status text NOT NULL,
  currency text, product_type text, copier_table_depth text, serving_mode text,
  timeframes_native int[], timeframes_derived int[]
);
CREATE TABLE arena.traders (id bigint PRIMARY KEY, source_id int NOT NULL);
CREATE TABLE arena.trader_stats (
  trader_id bigint NOT NULL, timeframe int NOT NULL,
  roi numeric, pnl numeric, sharpe numeric, mdd numeric, win_rate numeric, win_positions int,
  total_positions int, copier_pnl numeric, copier_count int, aum numeric, volume numeric,
  profit_share_rate numeric, holding_duration_avg numeric,
  PRIMARY KEY (trader_id, timeframe)
);
CREATE TABLE arena.positions_current (
  trader_id bigint NOT NULL, symbol text NOT NULL, side text NOT NULL,
  PRIMARY KEY (trader_id, symbol, side)
);
DO $tables$
DECLARE
  record_table text;
  time_column text;
BEGIN
  FOR record_table, time_column IN VALUES
    ('position_history', 'closed_at'), ('order_records', 'ts'),
    ('transfer_history', 'ts'), ('copier_records', 'ts')
  LOOP
    EXECUTE format(
      'CREATE TABLE arena.%1$I (trader_id bigint NOT NULL, %2$I timestamptz NOT NULL)
         PARTITION BY RANGE (%2$I)', record_table, time_column);
    EXECUTE format('CREATE INDEX ON arena.%1$I (trader_id, %2$I DESC)', record_table, time_column);
    EXECUTE format(
      'CREATE TABLE arena.%1$I PARTITION OF arena.%2$I
         FOR VALUES FROM (''2026-10-01'') TO (''2026-11-01'')', record_table || '_2026_10', record_table);
    EXECUTE format('CREATE TABLE arena.%1$I PARTITION OF arena.%2$I DEFAULT',
      record_table || '_default', record_table);
  END LOOP;
END
$tables$;

INSERT INTO arena.exchanges VALUES (1, 'Binance'), (2, 'Bybit'), (3, 'OKX');
INSERT INTO arena.sources VALUES
  (1, 'binance_futures', 1, 'active', 'USDT', 'futures', 'full', 'serving', '{7,30,90}', '{}'),
  (2, 'bybit', 2, 'active', 'USDT', 'futures', 'none', 'serving', '{90}', '{7}'),
  -- No trader, no stats, no record: every flag false, empty metric list.
  (3, 'okx_web3', 3, 'active', 'USD', 'onchain', 'none', 'shadow', '{30}', '{}'),
  (4, 'retired', 3, 'inactive', 'USDT', 'futures', 'none', 'serving', '{90}', '{}');
INSERT INTO arena.traders VALUES (11, 1), (12, 1), (21, 2), (41, 4);
INSERT INTO arena.trader_stats (trader_id, timeframe, roi, pnl, sharpe, copier_count) VALUES
  (11, 90, 10, 100, 1.5, NULL), (12, 90, 5, NULL, NULL, 3), (21, 90, 7, 70, NULL, NULL);
-- binance: every surface, some only through its second trader or the default partition.
INSERT INTO arena.positions_current VALUES (12, 'BTCUSDT', 'long');
INSERT INTO arena.position_history VALUES (11, '2026-10-05'), (11, '2026-10-06');
INSERT INTO arena.order_records VALUES (12, '2026-12-01');
INSERT INTO arena.transfer_history VALUES (12, '2026-10-09');
INSERT INTO arena.copier_records VALUES (11, '2026-10-09');
-- bybit: history only. The inactive source's rows must stay invisible.
INSERT INTO arena.position_history VALUES (21, '2026-10-07'), (41, '2026-10-07');
SQL

psql_db -q -f "$ORIGINAL" >/dev/null
snapshot() {
  psql_db -Atqc "SELECT slug || ' ' || cap::text FROM arena.mv_source_capabilities ORDER BY slug"
}
BEFORE="$(snapshot)"
assert_equal "fixture covers three active sources" "3" "$(wc -l <<<"$BEFORE" | tr -d ' ')"
assert_equal "fixture exercises true and false surface flags" \
  "binance_futures:true:true|bybit:false:true|okx_web3:false:false" "$(psql_db -Atqc "
    SELECT string_agg(slug || ':' || (cap->'surfaces'->>'orders') || ':' ||
             (cap->'surfaces'->>'position_history'), '|' ORDER BY slug)
    FROM arena.mv_source_capabilities")"

psql_db -q -f "$MIGRATION" >/dev/null
assert_equal "rewritten view returns exactly the original rows" "$BEFORE" "$(snapshot)"

# A refresh picks up a new surface and still runs CONCURRENTLY (unique index kept).
psql_db -qc "INSERT INTO arena.order_records VALUES (21, '2026-10-20')" >/dev/null
psql_db -qc "SELECT public.refresh_source_capabilities_mv()" >/dev/null
assert_equal "refresh picks up a new record surface" "true" "$(psql_db -Atqc "
  SELECT cap->'surfaces'->>'orders' FROM arena.mv_source_capabilities WHERE slug = 'bybit'")"
assert_equal "refresh waits at most 5s for a lock" "lock_timeout=5s" "$(psql_db -Atqc "
  SELECT setting FROM pg_catalog.pg_proc, pg_catalog.unnest(proconfig) AS setting
  WHERE oid = 'public.refresh_source_capabilities_mv()'::regprocedure
    AND setting LIKE 'lock_timeout=%'")"
assert_equal "one hourly job away from the :00/:30 marks" \
  "17 * * * *|SELECT public.refresh_source_capabilities_mv()" "$(psql_db -Atqc "
  SELECT string_agg(schedule || '|' || command, ';') FROM cron.job")"

echo 'source capabilities index-probe PostgreSQL 17 proof passed'
