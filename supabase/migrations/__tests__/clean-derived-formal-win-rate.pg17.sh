#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261115142045_clean_derived_formal_win_rate_scoped_probe.sql
# (issue #441). Builds the arena.* columns the migration reads with their real
# types, seeds dirty on-chain fills, dirty BTCC derived ratios, exchange-owned
# values, unprovable rows and pure-DEX / other-CEX controls, then proves:
#   * only the provable dirty rows change, with the documented values/markers;
#   * every other trader_stats row and every leaderboard entry is byte-identical;
#   * malformed extras values do not abort the migration;
#   * the NOTICE reports the cleaned and unprovable counts;
#   * a rerun is a no-op;
#   * schema drift aborts in preflight before any write.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20261115142045_clean_derived_formal_win_rate_scoped_probe.sql"
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

TMP_ROOT="$(mktemp -d /tmp/clean-formal-win-rate-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
RUN_LOG="$TMP_ROOT/run.log"
PORT="${PGPORT_OVERRIDE:-$((52000 + ($$ % 6000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -100 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

"$PG_BIN/initdb" -D "$DATA_DIR" --auth-local=trust --auth-host=trust \
  --encoding=UTF8 --username=postgres --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null

# Column types copied from 20260610223356 / 20260610223901.
psql_cmd -q <<'SQL'
CREATE SCHEMA arena;
CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text NOT NULL UNIQUE
);
CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL,
  UNIQUE (source_id, exchange_trader_id)
);
CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL,
  count_check_passed boolean NOT NULL DEFAULT true,
  is_derived boolean NOT NULL DEFAULT false
);
CREATE TABLE arena.leaderboard_entries (
  scraped_at timestamptz NOT NULL,
  snapshot_id bigint NOT NULL,
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  timeframe smallint NOT NULL,
  rank int NOT NULL,
  headline_roi numeric,
  headline_pnl numeric,
  headline_win_rate numeric,
  currency text NOT NULL,
  raw jsonb,
  PRIMARY KEY (scraped_at, snapshot_id, trader_id)
) PARTITION BY RANGE (scraped_at);
CREATE TABLE arena.leaderboard_entries_y2026 PARTITION OF arena.leaderboard_entries
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE arena.trader_stats (
  trader_id bigint NOT NULL REFERENCES arena.traders(id) ON DELETE CASCADE,
  timeframe smallint NOT NULL CHECK (timeframe IN (0, 7, 30, 90)),
  as_of timestamptz NOT NULL,
  currency text NOT NULL,
  roi numeric, pnl numeric, sharpe numeric, mdd numeric,
  win_rate numeric,
  win_positions int,
  total_positions int,
  extras jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (trader_id, timeframe)
);

INSERT INTO arena.sources (id, slug) VALUES
  (1, 'okx_web3_solana'), (2, 'binance_web3_bsc'), (3, 'btcc_futures'),
  (4, 'hyperliquid'), (5, 'gmx'), (6, 'bybit_copytrade');

INSERT INTO arena.traders (id, source_id, exchange_trader_id) VALUES
  (101, 2, 'w1-bsc-dirty'),
  (102, 1, 'w2-okx-dirty'),
  (103, 1, 'w3-okx-board-value'),
  (104, 1, 'w4-okx-profiled'),
  (105, 2, 'w5-bsc-refreshed'),
  (106, 2, 'w6-bsc-tf30'),
  (107, 2, 'w7-bsc-first-party'),
  (108, 2, 'w8-bsc-malformed'),
  (109, 1, 'w9-okx-null'),
  (201, 3, 'b1-dirty'),
  (202, 3, 'b2-exchange'),
  (203, 3, 'b3-native-headline'),
  (204, 3, 'b4-derived-headline'),
  (205, 3, 'b5-no-all-time'),
  (206, 3, 'b6-rounding-edge'),
  (207, 3, 'b7-malformed-all-time'),
  (301, 4, 'h1-hyperliquid'),
  (302, 5, 'g1-gmx'),
  (303, 6, 'c1-bybit');

INSERT INTO arena.leaderboard_snapshots (id, source_id, timeframe, scraped_at, is_derived) VALUES
  (1, 1, 90, '2026-07-20T00:00:00Z', false),
  (2, 3, 30, '2026-07-20T00:00:00Z', false),
  (3, 3, 90, '2026-07-20T00:00:00Z', true);

INSERT INTO arena.leaderboard_entries
  (scraped_at, snapshot_id, trader_id, timeframe, rank, headline_win_rate, currency)
VALUES
  ('2026-07-20T00:00:00Z', 1, 102, 90, 1, NULL, 'USD'),   -- board sent no win rate
  ('2026-07-20T00:00:00Z', 1, 103, 90, 2, 55, 'USD'),     -- exchange value
  ('2026-07-20T00:00:00Z', 2, 203, 30, 1, 50, 'USDT'),    -- native headline equals ratio
  ('2026-07-20T00:00:00Z', 3, 204, 90, 1, 33.33, 'USDT'); -- derived board copied dirty value

INSERT INTO arena.trader_stats (trader_id, timeframe, as_of, currency, win_rate, win_positions, total_positions, extras) VALUES
  (101, 90, '2026-07-20', 'USD', 66.67, NULL, NULL,
    '{"onchain_derivation":"onchain-computed","onchain_win_rate":66.67,"onchain_score_eligible":false}'),
  (102, 90, '2026-07-20', 'USD', 41.5, NULL, NULL,
    '{"onchain_derivation":"onchain-computed","onchain_win_rate":41.5}'),
  (103, 90, '2026-07-20', 'USD', 55, NULL, NULL,
    '{"onchain_derivation":"onchain-computed","onchain_win_rate":55}'),
  (104, 90, '2026-07-20', 'USD', 70, NULL, NULL,
    '{"onchain_derivation":"onchain-computed","onchain_win_rate":70,"win_rate_distribution":null,"txs_buy":12}'),
  (105, 90, '2026-07-20', 'USD', 40, NULL, NULL,
    '{"onchain_derivation":"onchain-computed","onchain_win_rate":45}'),
  (106, 30, '2026-07-20', 'USD', 25, NULL, NULL,
    '{"onchain_derivation":"onchain-computed","onchain_win_rate":25}'),
  (107, 90, '2026-07-20', 'USD', 80, NULL, NULL,
    '{"onchain_derivation":"onchain-computed","onchain_win_rate":80,"provenance":"first_party"}'),
  (108, 90, '2026-07-20', 'USD', 10, NULL, NULL,
    '{"onchain_derivation":"onchain-computed","onchain_win_rate":"abc"}'),
  (109, 90, '2026-07-20', 'USD', NULL, NULL, NULL,
    '{"onchain_derivation":"onchain-computed","onchain_win_rate":61}'),
  (201, 30, '2026-07-20', 'USDT', 97.92, 47, 48,
    '{"all_time":{"roi":304.43,"pnl":35392.5,"win_rate":93.8},"bio":"kept"}'),
  (202, 30, '2026-07-20', 'USDT', 93.8, 47, 48,
    '{"all_time":{"win_rate":93.8}}'),
  (203, 30, '2026-07-20', 'USDT', 50, 1, 2,
    '{"all_time":{"win_rate":60}}'),
  (204, 90, '2026-07-20', 'USDT', 33.33, 1, 3,
    '{"all_time":{"win_rate":45},"derived_window_win_rate_pct":33.33,"derived_window_win_rate_basis":"pre-existing"}'),
  (205, 7, '2026-07-20', 'USDT', 75, 3, 4,
    '{}'),
  (206, 7, '2026-07-20', 'USDT', 0.63, 1, 160,
    '{"all_time":{"win_rate":1.5}}'),
  (207, 30, '2026-07-20', 'USDT', 20, 1, 5,
    '{"all_time":{"win_rate":"93.8"}}'),
  (301, 90, '2026-07-20', 'USD', 60, 6, 10,
    '{"onchain_derivation":"onchain-computed","onchain_win_rate":60,"all_time":{"win_rate":10}}'),
  (302, 90, '2026-07-20', 'USD', 60, 6, 10,
    '{"onchain_derivation":"onchain-computed","onchain_win_rate":60,"all_time":{"win_rate":10}}'),
  (303, 30, '2026-07-20', 'USDT', 60, 6, 10,
    '{"onchain_derivation":"onchain-computed","onchain_win_rate":60,"all_time":{"win_rate":10}}');

CREATE TABLE public.before_stats AS SELECT * FROM arena.trader_stats;
CREATE TABLE public.before_entries AS SELECT * FROM arena.leaderboard_entries;
SQL

psql_cmd -q -f "$MIGRATION" >"$RUN_LOG" 2>&1 || { cat "$RUN_LOG" >&2; exit 1; }
if ! grep -q 'onchain nulled=2, btcc restored=3; unprovable left untouched: web3 refreshed=2, okx profiled=1, btcc without all_time=2' "$RUN_LOG"; then
  echo "first run NOTICE did not report the expected counts:" >&2
  cat "$RUN_LOG" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DO $assert$
DECLARE
  v_row arena.trader_stats;
  v_unexpected integer;
BEGIN
  -- Exactly these rows changed.
  SELECT pg_catalog.count(*) INTO v_unexpected
  FROM arena.trader_stats AS now_row
  JOIN public.before_stats AS before_row USING (trader_id, timeframe)
  WHERE now_row::text IS DISTINCT FROM before_row::text
    AND now_row.trader_id NOT IN (101, 102, 201, 204, 206);
  IF v_unexpected <> 0 THEN
    RAISE EXCEPTION 'cleanup touched % rows outside the provable dirty set', v_unexpected;
  END IF;
  IF (SELECT pg_catalog.count(*) FROM arena.trader_stats) <> (SELECT pg_catalog.count(*) FROM public.before_stats) THEN
    RAISE EXCEPTION 'cleanup changed the trader_stats row count';
  END IF;
  IF EXISTS (
    (SELECT * FROM arena.leaderboard_entries EXCEPT SELECT * FROM public.before_entries)
    UNION ALL
    (SELECT * FROM public.before_entries EXCEPT SELECT * FROM arena.leaderboard_entries)
  ) THEN
    RAISE EXCEPTION 'cleanup mutated leaderboard entries';
  END IF;

  -- On-chain fills: NULL formal, chain value stays in extras, old value archived.
  FOR v_row IN SELECT * FROM arena.trader_stats WHERE trader_id IN (101, 102) LOOP
    IF v_row.win_rate IS NOT NULL
       OR v_row.extras->'onchain_win_rate' IS NULL
       OR (v_row.extras #>> '{onchain_typed_win_rate_quarantine,value}')::numeric
          <> (v_row.extras->>'onchain_win_rate')::numeric
       OR v_row.extras #>> '{onchain_typed_win_rate_quarantine,migration}' <> '20261113150757'
       OR v_row.extras #>> '{onchain_typed_win_rate_quarantine,reason}'
          <> 'onchain_derived_value_in_formal_column' THEN
      RAISE EXCEPTION 'on-chain dirty row not cleaned as documented: %', pg_catalog.row_to_json(v_row);
    END IF;
  END LOOP;

  -- BTCC: exchange value restored, ratio moved to extras, old value archived.
  SELECT * INTO v_row FROM arena.trader_stats WHERE trader_id = 201;
  IF v_row.win_rate <> 93.8
     OR (v_row.extras->>'derived_window_win_rate_pct')::numeric <> 97.92
     OR v_row.extras->>'derived_window_win_rate_basis' <> 'totalWinTradeNum/totalTradeNum (Arena-derived)'
     OR (v_row.extras #>> '{formal_win_rate_cleanup,previous_value}')::numeric <> 97.92
     OR v_row.extras #>> '{formal_win_rate_cleanup,restored_from}' <> 'extras.all_time.win_rate'
     OR v_row.extras->>'bio' <> 'kept'
     OR v_row.win_positions <> 47 OR v_row.total_positions <> 48 THEN
    RAISE EXCEPTION 'btcc dirty row not restored as documented: %', pg_catalog.row_to_json(v_row);
  END IF;
  SELECT * INTO v_row FROM arena.trader_stats WHERE trader_id = 204;
  IF v_row.win_rate <> 45
     OR v_row.extras->>'derived_window_win_rate_basis' <> 'pre-existing' THEN
    RAISE EXCEPTION 'btcc row with derived-only headline must restore and keep existing extras keys: %',
      pg_catalog.row_to_json(v_row);
  END IF;
  SELECT * INTO v_row FROM arena.trader_stats WHERE trader_id = 206;
  IF v_row.win_rate <> 1.5 OR (v_row.extras->>'derived_window_win_rate_pct')::numeric <> 0.63 THEN
    RAISE EXCEPTION 'btcc JS half-rounding edge row not restored: %', pg_catalog.row_to_json(v_row);
  END IF;
END
$assert$;

CREATE TABLE public.after_first_run AS SELECT * FROM arena.trader_stats;
SQL

# Rerun twice in one session (temp work tables are reused): nothing left to
# clean, table byte-identical.
psql_cmd -q -f "$MIGRATION" -f "$MIGRATION" >"$RUN_LOG" 2>&1 || { cat "$RUN_LOG" >&2; exit 1; }
if [[ "$(grep -c 'onchain nulled=0, btcc restored=0;' "$RUN_LOG")" != "2" ]]; then
  echo "rerun was not a no-op:" >&2
  cat "$RUN_LOG" >&2
  exit 1
fi
RERUN_DIFF="$(psql_cmd -qtA -c "
  SELECT pg_catalog.count(*) FROM (
    (SELECT * FROM arena.trader_stats EXCEPT SELECT * FROM public.after_first_run)
    UNION ALL
    (SELECT * FROM public.after_first_run EXCEPT SELECT * FROM arena.trader_stats)
  ) AS diff")"
if [[ "$RERUN_DIFF" != "0" ]]; then
  echo "rerun changed $RERUN_DIFF trader_stats rows" >&2
  exit 1
fi

# Schema drift: a retyped column must abort before any write.
psql_cmd -q -c "ALTER TABLE arena.trader_stats ALTER COLUMN win_positions TYPE bigint;
  UPDATE arena.trader_stats SET win_rate = 97.92 WHERE trader_id = 201;"
if psql_cmd -q -f "$MIGRATION" >"$RUN_LOG" 2>&1; then
  echo "migration unexpectedly succeeded on drifted schema" >&2
  exit 1
fi
if ! grep -q 'formal win-rate cleanup preflight: expected 16 arena columns' "$RUN_LOG"; then
  echo "drifted schema failed for an unexpected reason:" >&2
  cat "$RUN_LOG" >&2
  exit 1
fi
if [[ "$(psql_cmd -qtA -c "SELECT win_rate FROM arena.trader_stats WHERE trader_id = 201")" != "97.92" ]]; then
  echo "preflight failure still wrote rows" >&2
  exit 1
fi

echo "clean-derived-formal-win-rate PostgreSQL 17 proof passed"
