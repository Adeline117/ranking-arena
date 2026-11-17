#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for the native-board headline stats upsert
# (lib/ingest/serving/headline-stats-sql.ts). It owns an isolated temporary
# cluster and never connects to a developer or remote DB.
#
# Proves:
#   1. a full-width repeat board publish ADVANCES as_of even when the row
#      carries profile-only state (extras watermark, profit_share_rate,
#      trading_preferences) — the 2026-11 "as_of frozen → dropped after 48h" bug;
#   2. a sparse repeat publish that relies on COALESCE to retain an older
#      headline value keeps the conservative LEAST(old, new) as_of;
#   3. extras merge and profile-only columns survive the board upsert.
#   4. score-input evidence (with the real 20261116205144 table trigger): an
#      attempt-bound board write attests only the values it sent; values the
#      COALESCE retains, values another writer later overwrites, and a write
#      without a pointer are never attested.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SQL_MODULE="$ROOT_DIR/lib/ingest/serving/headline-stats-sql.ts"
EVIDENCE_MIGRATION="$ROOT_DIR/supabase/migrations/20261116205144_trader_stats_score_input_evidence_pointer.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/headline-stats-as-of-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55481
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if (( exit_code != 0 )) && [[ -f "$LOG_FILE" ]]; then
    tail -120 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

"$PG_BIN/initdb" -D "$DATA_DIR" -U postgres --auth-local=trust --auth-host=trust \
  --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null

UPSERT_SQL="$(node -e '
const s = require("fs").readFileSync(process.argv[1], "utf8")
const m = s.match(/HEADLINE_STATS_UPSERT_SQL = `([\s\S]*?)`\s*$/)
if (!m) { console.error("HEADLINE_STATS_UPSERT_SQL not found"); process.exit(1) }
process.stdout.write(m[1])
' "$SQL_MODULE")"

psql_cmd <<SQL
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA arena;
CREATE TABLE arena.traders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL,
  exchange_trader_id text NOT NULL,
  UNIQUE (source_id, exchange_trader_id)
);
CREATE TABLE arena.trader_stats (
  trader_id bigint NOT NULL REFERENCES arena.traders(id) ON DELETE CASCADE,
  timeframe smallint NOT NULL CHECK (timeframe IN (0, 7, 30, 90)),
  as_of timestamptz NOT NULL,
  currency text NOT NULL,
  roi numeric, pnl numeric, sharpe numeric, mdd numeric, win_rate numeric,
  win_positions int, total_positions int, copier_pnl numeric, copier_count int,
  aum numeric, volume numeric, profit_share_rate numeric,
  holding_duration_avg interval, trading_preferences jsonb,
  extras jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (trader_id, timeframe)
);
INSERT INTO arena.traders (source_id, exchange_trader_id) VALUES (9, 't-full'), (9, 't-sparse');
SQL

psql_cmd -f "$EVIDENCE_MIGRATION"

psql_cmd <<SQL
PREPARE upsert(smallint, timestamptz, text, jsonb, smallint, bigint, text) AS
${UPSERT_SQL};

-- Cycle 1: full-width board publish for both traders.
EXECUTE upsert(30, '2026-11-01T00:00:00Z', 'USDT',
  '[{"exchange_trader_id":"t-full","roi":10,"pnl":100,"win_rate":50,"mdd":5,"sharpe":1.2,"extras":{"risk_label":"a"}},
    {"exchange_trader_id":"t-sparse","roi":10,"pnl":100,"win_rate":50,"mdd":5,"sharpe":1.2}]'::jsonb, 9,
  NULL, NULL);

-- A profile crawl later attaches profile-only state + its own watermark.
UPDATE arena.trader_stats
   SET profit_share_rate = 0.1,
       trading_preferences = '{"BTC":0.5}'::jsonb,
       extras = extras || '{"_arena_profile_publication_epoch_ms": 1761955200000}'::jsonb;

-- Cycle 2 (72h later): t-full re-sends every headline column; t-sparse omits mdd/sharpe.
EXECUTE upsert(30, '2026-11-04T00:00:00Z', 'USDT',
  '[{"exchange_trader_id":"t-full","roi":20,"pnl":200,"win_rate":60,"mdd":6,"sharpe":1.5,"extras":{"risk_label":"b"}},
    {"exchange_trader_id":"t-sparse","roi":20,"pnl":200,"win_rate":60}]'::jsonb, 9,
  7001, repeat('a', 64));

DO \$\$
DECLARE
  full_row arena.trader_stats;
  sparse_row arena.trader_stats;
BEGIN
  SELECT st.* INTO full_row FROM arena.trader_stats st JOIN arena.traders t ON t.id = st.trader_id
   WHERE t.exchange_trader_id = 't-full';
  SELECT st.* INTO sparse_row FROM arena.trader_stats st JOIN arena.traders t ON t.id = st.trader_id
   WHERE t.exchange_trader_id = 't-sparse';

  IF full_row.as_of <> '2026-11-04T00:00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'full-width repeat publish must advance as_of, got %', full_row.as_of;
  END IF;
  IF full_row.roi <> 20 OR full_row.mdd <> 6 OR full_row.sharpe <> 1.5 THEN
    RAISE EXCEPTION 'full-width repeat publish must overwrite headline values: %', row_to_json(full_row);
  END IF;
  IF full_row.profit_share_rate IS DISTINCT FROM 0.1
     OR full_row.trading_preferences IS DISTINCT FROM '{"BTC":0.5}'::jsonb THEN
    RAISE EXCEPTION 'profile-only columns must survive the board upsert: %', row_to_json(full_row);
  END IF;
  IF full_row.extras ->> 'risk_label' <> 'b'
     OR (full_row.extras ->> '_arena_profile_publication_epoch_ms')::numeric <> 1761955200000 THEN
    RAISE EXCEPTION 'extras must merge (new board keys win, profile watermark kept): %', full_row.extras;
  END IF;

  IF sparse_row.as_of <> '2026-11-01T00:00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'sparse repeat publish retaining old mdd/sharpe must keep LEAST as_of, got %', sparse_row.as_of;
  END IF;
  IF sparse_row.roi <> 20 OR sparse_row.mdd <> 5 OR sparse_row.sharpe <> 1.2 THEN
    RAISE EXCEPTION 'sparse publish must COALESCE-retain old values: %', row_to_json(sparse_row);
  END IF;

  -- Evidence: the attempt-bound cycle-2 board attests what it sent, never the
  -- cycle-1 values the sparse row retained.
  IF full_row.evidence_raw_object_id IS DISTINCT FROM 7001
     OR full_row.evidence_source_run_id IS DISTINCT FROM repeat('a', 64)
     OR full_row.evidence_metrics IS DISTINCT FROM ARRAY['mdd','pnl','roi','sharpe','win_rate'] THEN
    RAISE EXCEPTION 'full board write must attest every value it sent: %', row_to_json(full_row);
  END IF;
  IF sparse_row.evidence_raw_object_id IS DISTINCT FROM 7001
     OR sparse_row.evidence_metrics IS DISTINCT FROM ARRAY['pnl','roi','win_rate'] THEN
    RAISE EXCEPTION 'retained values must not be attested: %', row_to_json(sparse_row);
  END IF;
END
\$\$;

-- A profile crawl overwrites the board drawdown and adds a trade count: the
-- drawdown loses its attestation, the trade count never gains one.
UPDATE arena.trader_stats AS st SET mdd = 9, total_positions = 40
  FROM arena.traders AS t WHERE t.id = st.trader_id AND t.exchange_trader_id = 't-full';
-- Rewriting a value to itself keeps it attested.
UPDATE arena.trader_stats AS st SET roi = 20
  FROM arena.traders AS t WHERE t.id = st.trader_id AND t.exchange_trader_id = 't-full';
DO \$\$
BEGIN
  IF (SELECT st.evidence_metrics FROM arena.trader_stats st JOIN arena.traders t ON t.id = st.trader_id
       WHERE t.exchange_trader_id = 't-full') IS DISTINCT FROM ARRAY['pnl','roi','sharpe','win_rate'] THEN
    RAISE EXCEPTION 'an overwritten value must lose its attestation';
  END IF;
END
\$\$;

-- Overwriting every attested value clears the pointer.
UPDATE arena.trader_stats AS st SET roi = 1, pnl = 1, win_rate = 1
  FROM arena.traders AS t WHERE t.id = st.trader_id AND t.exchange_trader_id = 't-sparse';
-- A board write without a pointer (not attempt-bound) stores none.
EXECUTE upsert(30, '2026-11-05T00:00:00Z', 'USDT',
  '[{"exchange_trader_id":"t-full","roi":30,"pnl":300,"win_rate":61,"mdd":7}]'::jsonb, 9, NULL, NULL);
DO \$\$
BEGIN
  IF EXISTS (SELECT 1 FROM arena.trader_stats
              WHERE evidence_raw_object_id IS NOT NULL OR evidence_metrics IS NOT NULL) THEN
    RAISE EXCEPTION 'pointer must be cleared: %',
      (SELECT json_agg(row_to_json(st)) FROM arena.trader_stats st);
  END IF;
END
\$\$;
SQL

# The shape CHECK refuses a forged pointer outside the trigger's normal form.
if forged="$(psql_cmd -c "ALTER TABLE arena.trader_stats DISABLE TRIGGER trader_stats_score_input_evidence; UPDATE arena.trader_stats SET evidence_raw_object_id = 1, evidence_source_run_id = 'x', evidence_metrics = ARRAY['roi']" 2>&1)" \
  || ! grep -q 'trader_stats_score_input_evidence_shape' <<<"$forged"; then
  echo "shape CHECK did not refuse a malformed pointer: $forged" >&2
  exit 1
fi

echo "headline-stats-as-of.pg17: OK"
