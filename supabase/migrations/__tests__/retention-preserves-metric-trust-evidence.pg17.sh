#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261113105605_retention_preserves_metric_trust_evidence:
# metric-trust evidence edges stop cascading, and the worker's real retention
# SQL skips evidence-pinned RAW objects and snapshot entries while still
# retiring unpinned ones. Isolated cluster on a private socket; the fixture
# reproduces the 20260721120000 evidence edges (same columns, CASCADE).

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20261113105605_retention_preserves_metric_trust_evidence.sql"
DRIVER="$ROOT_DIR/supabase/migrations/__tests__/retention-preserves-metric-trust-evidence.driver.mts"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  [[ -x "$PG_BIN/$executable" ]] || { echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2; exit 1; }
done
[[ "$("$PG_BIN/psql" --version)" == psql\ \(PostgreSQL\)\ 17.* ]] || { echo "requires PostgreSQL 17" >&2; exit 1; }

TMP_ROOT="$(mktemp -d /tmp/retention-trust-evidence-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
PORT="${PGPORT_OVERRIDE:-$((50000 + ($$ % 3000)))}"
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
CREATE SCHEMA arena;
CREATE TABLE arena.raw_objects (
  id bigint PRIMARY KEY, storage_path text NOT NULL, content_hash text NOT NULL,
  quarantined boolean NOT NULL DEFAULT false, fetched_at timestamptz NOT NULL
);
CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY, source_id smallint NOT NULL, timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL, count_check_passed boolean NOT NULL,
  raw_object_id bigint
);
CREATE TABLE arena.leaderboard_entries (
  scraped_at timestamptz NOT NULL, snapshot_id bigint NOT NULL, trader_id bigint NOT NULL,
  PRIMARY KEY (scraped_at, snapshot_id, trader_id)
) PARTITION BY RANGE (scraped_at);
CREATE TABLE arena.leaderboard_entries_all PARTITION OF arena.leaderboard_entries
  FOR VALUES FROM ('2000-01-01') TO ('2100-01-01');
CREATE TABLE arena.metric_trust_runs (
  source_run_id text PRIMARY KEY,
  snapshot_id bigint NOT NULL REFERENCES arena.leaderboard_snapshots(id) ON DELETE CASCADE,
  population_raw_object_id bigint NOT NULL REFERENCES arena.raw_objects(id) ON DELETE CASCADE,
  manifest_raw_object_id bigint NOT NULL REFERENCES arena.raw_objects(id) ON DELETE CASCADE
);
CREATE TABLE arena.metric_trust_observations (
  id bigint PRIMARY KEY,
  trader_id bigint NOT NULL,
  snapshot_id bigint NOT NULL REFERENCES arena.leaderboard_snapshots(id) ON DELETE CASCADE,
  snapshot_scraped_at timestamptz NOT NULL,
  source_run_id text NOT NULL REFERENCES arena.metric_trust_runs(source_run_id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_scraped_at, snapshot_id, trader_id)
    REFERENCES arena.leaderboard_entries (scraped_at, snapshot_id, trader_id) ON DELETE CASCADE
);
CREATE TABLE arena.metric_trust_artifacts (
  observation_id bigint NOT NULL REFERENCES arena.metric_trust_observations(id) ON DELETE CASCADE,
  raw_object_id bigint NOT NULL REFERENCES arena.raw_objects(id) ON DELETE CASCADE
);

-- 40-day-old evidence: raw 1/2 (run population/manifest), raw 3 (artifact),
-- raw 4 unpinned. Snapshot 10 (passed) and 11 (failed, older same day) on the
-- same day; entries of 11 for trader 100 are trust-pinned, trader 101 is not.
INSERT INTO arena.raw_objects VALUES
  (1, 'raw/1', 'h1', false, now() - interval '40 days'),
  (2, 'raw/2', 'h2', false, now() - interval '40 days'),
  (3, 'raw/3', 'h3', false, now() - interval '40 days'),
  (4, 'raw/4', 'h4', false, now() - interval '40 days'),
  (5, 'raw/5', 'h5', false, now() - interval '1 day'),
  (6, 'raw/6', 'h6', false, now() - interval '40 days');
INSERT INTO arena.leaderboard_snapshots VALUES
  (10, 1, 90, date_trunc('day', now() - interval '20 days') + interval '20 hours', true),
  (11, 1, 90, date_trunc('day', now() - interval '20 days') + interval '10 hours', false);
-- Snapshot 10 is a no-trust-path board: raw 6 is its soft-referenced payload.
UPDATE arena.leaderboard_snapshots SET raw_object_id = 6 WHERE id = 10;
INSERT INTO arena.leaderboard_entries VALUES
  ((SELECT scraped_at FROM arena.leaderboard_snapshots WHERE id = 11), 11, 100),
  ((SELECT scraped_at FROM arena.leaderboard_snapshots WHERE id = 11), 11, 101),
  ((SELECT scraped_at FROM arena.leaderboard_snapshots WHERE id = 10), 10, 100);
INSERT INTO arena.metric_trust_runs VALUES ('run-a', 11, 1, 2);
INSERT INTO arena.metric_trust_observations VALUES
  (1, 100, 11, (SELECT scraped_at FROM arena.leaderboard_snapshots WHERE id = 11), 'run-a');
INSERT INTO arena.metric_trust_artifacts VALUES (1, 3);
SQL

# Before the migration the edges cascade: deleting raw 3 erases the artifact.
assert_equal "fixture cascades before the migration" "0" "$(psql_db -Atq <<'SQL'
BEGIN;
DELETE FROM arena.raw_objects WHERE id = 3;
SELECT count(*) FROM arena.metric_trust_artifacts;
ROLLBACK;
SQL
)"

psql_db -q -f "$MIGRATION" >/dev/null
psql_db -q -f "$MIGRATION" >/dev/null # idempotent replay

assert_equal "every evidence edge is RESTRICT" "6" "$(psql_db -Atqc "
  SELECT count(*) FROM pg_constraint
   WHERE contype = 'f' AND conparentid = 0 AND confdeltype = 'r'
     AND conrelid::regclass::text LIKE 'arena.metric_trust_%'
     AND confrelid::regclass::text IN ('arena.raw_objects', 'arena.leaderboard_snapshots', 'arena.leaderboard_entries')")"
assert_equal "internal observation->run edge still cascades" "c" "$(psql_db -Atqc "
  SELECT confdeltype FROM pg_constraint
   WHERE conrelid = 'arena.metric_trust_observations'::regclass
     AND confrelid = 'arena.metric_trust_runs'::regclass")"

for target in "raw_objects WHERE id = 1" "raw_objects WHERE id = 3" "leaderboard_snapshots WHERE id = 11" "leaderboard_entries WHERE snapshot_id = 11 AND trader_id = 100"; do
  if psql_db -qc "DELETE FROM arena.$target" >/dev/null 2>&1; then
    echo "deleting pinned evidence ($target) was not refused" >&2
    exit 1
  fi
done
echo "ok - deleting pinned RAW/snapshot/entry evidence is refused"

OUT="$(cd "$ROOT_DIR" && PGHOST="$SOCKET_DIR" PGPORT="$PORT" npx --no-install tsx "$DRIVER" | sed -n 's/^RESULT //p' | tail -1)"
assert_equal "retention SQL keeps pinned RAW, retires only the unpinned expired one" \
  '{"present":true,"rawCandidates":[4],"entriesDeleted":1}' "$OUT"
assert_equal "pinned entry and every trust row survive downsampling" "1|1|1|1" "$(psql_db -Atqc "
  SELECT (SELECT count(*) FROM arena.leaderboard_entries WHERE snapshot_id = 11 AND trader_id = 100) || '|' ||
         (SELECT count(*) FROM arena.metric_trust_runs) || '|' ||
         (SELECT count(*) FROM arena.metric_trust_observations) || '|' ||
         (SELECT count(*) FROM arena.metric_trust_artifacts)")"

echo "retention preserves metric-trust evidence PostgreSQL 17 proof passed"
