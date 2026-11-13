#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261113110021_leaderboard_snapshot_retention:
# arena.prune_leaderboard_snapshots deletes old snapshots (and their entries)
# but never the latest passed board, a board a sealed publication was built
# from, or a snapshot referenced by trust evidence / Tier-A receipts.
# Isolated cluster on a private socket; minimal fixture of referenced tables.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20261113110021_leaderboard_snapshot_retention.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  [[ -x "$PG_BIN/$executable" ]] || { echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2; exit 1; }
done
[[ "$("$PG_BIN/psql" --version)" == psql\ \(PostgreSQL\)\ 17.* ]] || { echo "requires PostgreSQL 17" >&2; exit 1; }

TMP_ROOT="$(mktemp -d /tmp/snapshot-retention-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
PORT="${PGPORT_OVERRIDE:-$((47000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"
cleanup() {
  local code=$?
  [[ -s "$DATA_DIR/postmaster.pid" ]] && "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$TMP_ROOT"
  exit "$code"
}
trap cleanup EXIT

psql_db() { "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"; }
assert_equal() { [[ "$2" == "$3" ]] || { echo "$1: expected '$2', got '$3'" >&2; exit 1; }; }

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$TMP_ROOT/postgres.log" -w start >/dev/null

psql_db -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA arena;
CREATE TABLE arena.sources (id smallint PRIMARY KEY, slug text NOT NULL, meta jsonb NOT NULL DEFAULT '{}');
CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY, source_id smallint NOT NULL REFERENCES arena.sources(id),
  timeframe smallint NOT NULL, scraped_at timestamptz NOT NULL, count_check_passed boolean NOT NULL
);
CREATE TABLE arena.leaderboard_entries (
  scraped_at timestamptz NOT NULL, snapshot_id bigint NOT NULL, trader_id bigint NOT NULL,
  PRIMARY KEY (scraped_at, snapshot_id, trader_id)
) PARTITION BY RANGE (scraped_at);
CREATE TABLE arena.leaderboard_entries_all PARTITION OF arena.leaderboard_entries
  FOR VALUES FROM ('2000-01-01') TO ('2100-01-01');
CREATE TABLE arena.leaderboard_rank_publications (id uuid PRIMARY KEY, proofs jsonb NOT NULL);
CREATE TABLE public.leaderboard_source_freshness (
  season_id text NOT NULL, source text NOT NULL, source_as_of timestamptz NOT NULL
);
CREATE TABLE arena.metric_trust_runs (
  source_run_id text PRIMARY KEY,
  snapshot_id bigint NOT NULL REFERENCES arena.leaderboard_snapshots(id) ON DELETE RESTRICT
);
CREATE TABLE arena.metric_trust_observations (
  id bigint PRIMARY KEY,
  snapshot_id bigint NOT NULL REFERENCES arena.leaderboard_snapshots(id) ON DELETE RESTRICT
);
CREATE TABLE arena.tier_a_execution_window_receipts (
  id bigint PRIMARY KEY,
  snapshot_id bigint REFERENCES arena.leaderboard_snapshots(id) ON DELETE RESTRICT
);

INSERT INTO arena.sources VALUES
  (1, 'binance_futures', '{}'),
  (2, 'bybit_copytrade', '{"legacy_platform": "bybit"}');

-- 1: old plain (delete)      2: old, sealed board of bybit (keep)
-- 3: old, trust run (keep)   4: old, Tier-A receipt (keep)
-- 5: latest passed binance, old (keep)   6: recent failed (keep, inside window)
-- 7: old failed bybit (delete)
INSERT INTO arena.leaderboard_snapshots VALUES
  (1, 1, 90, '2025-01-01 00:00:00+00', true),
  (2, 2, 90, '2025-01-02 00:00:00+00', true),
  (3, 1, 90, '2025-01-03 00:00:00+00', true),
  (4, 1, 90, '2025-01-04 00:00:00+00', true),
  (5, 1, 90, '2025-01-05 00:00:00+00', true),
  (6, 1, 90, now() - interval '1 day', false),
  (7, 2, 90, '2025-01-06 00:00:00+00', false);
INSERT INTO arena.leaderboard_entries
SELECT snapshot.scraped_at, snapshot.id, trader.id
FROM arena.leaderboard_snapshots AS snapshot CROSS JOIN (VALUES (100), (101)) AS trader(id);
INSERT INTO arena.leaderboard_rank_publications VALUES
  ('00000000-0000-4000-8000-000000000001',
   '[{"source": "bybit", "source_as_of": "2025-01-02T00:00:00.000000Z", "trader_ids": []}]');
INSERT INTO arena.metric_trust_runs VALUES ('run-3', 3);
INSERT INTO arena.tier_a_execution_window_receipts VALUES (1, 4);
SQL

psql_db -q -f "$MIGRATION" >/dev/null

for bad in "0, 10" "89, 10" "180, 0"; do
  if psql_db -qc "SELECT arena.prune_leaderboard_snapshots($bad)" >/dev/null 2>&1; then
    echo "prune accepted out-of-range arguments ($bad)" >&2
    exit 1
  fi
done
echo "ok - retention window and batch bounds are enforced"

assert_equal "first batch of one deletes the oldest unpinned snapshot" \
  '{"contract": "leaderboard-snapshot-retention@1", "retention_days": 90, "deleted_entries": 2, "deleted_snapshots": 1}' \
  "$(psql_db -Atqc "SELECT arena.prune_leaderboard_snapshots(90, 1)")"
psql_db -Atqc "SELECT arena.prune_leaderboard_snapshots(90, 100)" >/dev/null
assert_equal "only unpinned old snapshots are gone" "2,3,4,5,6" "$(psql_db -Atqc "
  SELECT string_agg(id::text, ',' ORDER BY id) FROM arena.leaderboard_snapshots")"
assert_equal "their entries went with them, pinned ones stayed" "10" "$(psql_db -Atqc "
  SELECT count(*) FROM arena.leaderboard_entries")"
assert_equal "a second run is a no-op" '0' "$(psql_db -Atqc "
  SELECT arena.prune_leaderboard_snapshots(90, 100)->>'deleted_snapshots'")"
assert_equal "service_role may run it, anon may not" "true|false" "$(psql_db -Atqc "
  SELECT has_function_privilege('service_role', 'arena.prune_leaderboard_snapshots(integer,integer)', 'EXECUTE')
    || '|' || has_function_privilege('anon', 'arena.prune_leaderboard_snapshots(integer,integer)', 'EXECUTE')")"

echo "leaderboard snapshot retention PostgreSQL 17 proof passed"
