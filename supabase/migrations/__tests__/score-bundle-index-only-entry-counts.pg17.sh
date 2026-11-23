#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261122154211: the score bundle's per-snapshot
# entry counts come from indexes and keep their exact values.
#
# The 20261116204006 bundle is installed on a fixture of the relations it
# reads (the score-row reader is a stand-in) and called for 7D/30D/90D; the
# migration is applied as written and the calls are repeated:
#   = the whole bundle JSON is identical before and after, across a snapshot
#     with more entries than the rank limit, one with fewer, an empty one, a
#     count mismatch, a failed latest attempt, a stale board, and a snapshot
#     that has entries under a DIFFERENT scraped_at (the case the index
#     without scraped_at would miscount; the exact heap count is taken)
#   + after VACUUM, the new counting step runs without a single heap fetch
#   - a replay is refused
# Isolated cluster on a private socket; never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
OLD_MIGRATION="$MIGRATIONS/20261116204006_publication_score_rows_board_headline_only.sql"
NEW_MIGRATION="$MIGRATIONS/20261122154211_score_bundle_index_only_entry_counts.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/score-bundle-counts-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((53000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -40 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_db() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses='' -c autovacuum=off" \
  -l "$LOG_FILE" -w start >/dev/null

OLD_FUNCTION="$TMP_ROOT/old-bundle.sql"
awk '/^CREATE OR REPLACE FUNCTION public.arena_score_inputs_publish_bundle_json\(/ { on = 1 }
     on { print }
     on && /^\$function\$;/ { exit }' "$OLD_MIGRATION" >"$OLD_FUNCTION"
grep -q "passed_entry_counts" "$OLD_FUNCTION"

psql_db -q >/dev/null <<'SQL'
CREATE SCHEMA arena;
CREATE TABLE arena.sources (
  id int PRIMARY KEY, slug text NOT NULL, adapter_slug text NOT NULL, status text NOT NULL,
  serving_mode text NOT NULL, meta jsonb NOT NULL DEFAULT '{}',
  timeframes_native int[] NOT NULL DEFAULT '{7,30,90}', timeframes_derived int[]
);
CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY, source_id int NOT NULL, timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL, count_check_passed boolean NOT NULL, actual_count int
);
CREATE TABLE arena.leaderboard_entries (
  scraped_at timestamptz NOT NULL, snapshot_id bigint NOT NULL, trader_id bigint NOT NULL,
  timeframe smallint NOT NULL, rank int NOT NULL, raw jsonb,
  PRIMARY KEY (scraped_at, snapshot_id, trader_id)
) PARTITION BY RANGE (scraped_at);
CREATE INDEX idx_arena_lb_entries_snapshot ON arena.leaderboard_entries (snapshot_id, rank);
CREATE TABLE arena.leaderboard_entries_old PARTITION OF arena.leaderboard_entries
  FOR VALUES FROM (MINVALUE) TO ('2026-11-01+00');
CREATE TABLE arena.leaderboard_entries_new PARTITION OF arena.leaderboard_entries
  FOR VALUES FROM ('2026-11-01+00') TO (MAXVALUE);
-- Stand-in for the score-row reader: not what this migration changes.
CREATE FUNCTION arena.publication_score_rows_json(text, integer, integer)
RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '[]'::jsonb $$;

INSERT INTO arena.sources (id, slug, adapter_slug, status, serving_mode, meta) VALUES
  (1, 'big_board', 'a', 'active', 'serving', '{"legacy_platform": "big"}'),
  (2, 'small_board', 'a', 'active', 'serving', '{}'),
  (3, 'empty_board', 'a', 'active', 'serving', '{}'),
  (4, 'mismatch_board', 'a', 'active', 'serving', '{}'),
  (5, 'failed_latest', 'a', 'active', 'serving', '{}'),
  (6, 'stale_board', 'a', 'active', 'serving', '{}'),
  (7, 'stray_entries', 'a', 'active', 'serving', '{}'),
  (8, 'never_passed', 'a', 'active', 'serving', '{}'),
  (9, 'shadow_board', 'a', 'active', 'shadow', '{}');

CREATE FUNCTION public.fixture_snapshot(
  p_id bigint, p_source int, p_age interval, p_passed boolean, p_actual int, p_entries int,
  p_timeframe int DEFAULT 7
) RETURNS void LANGUAGE sql AS $$
  INSERT INTO arena.leaderboard_snapshots
  VALUES (p_id, p_source, p_timeframe, pg_catalog.date_trunc('second', pg_catalog.now()) - p_age,
          p_passed, p_actual);
  INSERT INTO arena.leaderboard_entries (scraped_at, snapshot_id, trader_id, timeframe, rank)
  SELECT pg_catalog.date_trunc('second', pg_catalog.now()) - p_age, p_id, n, p_timeframe, n
    FROM pg_catalog.generate_series(1, p_entries) AS n;
$$;
SELECT public.fixture_snapshot(10, 1, '2 hours', true, 1500, 1500);      -- above the rank limit
SELECT public.fixture_snapshot(11, 1, '9 hours', true, 1400, 1400);      -- an older pass
SELECT public.fixture_snapshot(20, 2, '2 hours', true, 40, 40);
SELECT public.fixture_snapshot(30, 3, '2 hours', true, 0, 0);
SELECT public.fixture_snapshot(40, 4, '2 hours', true, 50, 47);          -- fewer entries than counted
SELECT public.fixture_snapshot(50, 5, '5 hours', true, 30, 30);
SELECT public.fixture_snapshot(51, 5, '1 hour', false, 0, 0);            -- newer failed attempt
SELECT public.fixture_snapshot(60, 6, '120 days', true, 1200, 1200);     -- stale, old partition
SELECT public.fixture_snapshot(70, 7, '2 hours', true, 20, 20);
SELECT public.fixture_snapshot(80, 8, '2 hours', false, 0, 0);
SELECT public.fixture_snapshot(90, 9, '2 hours', true, 5, 5);
SELECT public.fixture_snapshot(12, 1, '3 hours', true, 900, 900, 30);    -- another window
-- Volume in both partitions so the planner has a reason to use the indexes.
INSERT INTO arena.leaderboard_entries (scraped_at, snapshot_id, trader_id, timeframe, rank)
SELECT pg_catalog.date_trunc('second', pg_catalog.now()) - pg_catalog.make_interval(days => 1 + 100 * (s % 2)),
       1000 + s, n, 7, n
  FROM pg_catalog.generate_series(1, 60) AS s, pg_catalog.generate_series(1, 1000) AS n;
-- Entries of snapshot 70 written under a different scraped_at (one of them
-- inside the rank limit, in the other partition).
INSERT INTO arena.leaderboard_entries (scraped_at, snapshot_id, trader_id, timeframe, rank) VALUES
  (pg_catalog.now() - interval '40 days', 70, 9001, 7, 3),
  (pg_catalog.now() - interval '1 hour', 70, 9002, 7, 5000);
VACUUM ANALYZE;
SQL
psql_db -q -f "$OLD_FUNCTION"

bundle() {
  psql_db -Atq -c "SELECT jsonb_pretty(public.arena_score_inputs_publish_bundle_json('7D', 1000, 48)),
                          jsonb_pretty(public.arena_score_inputs_publish_bundle_json('30D', 1000, 48)),
                          jsonb_pretty(public.arena_score_inputs_publish_bundle_json('90D', 1000, 48)),
                          jsonb_pretty(public.arena_score_inputs_publish_bundle_json('7D', 10, 48))" |
    sed -E 's/"(scraped_at|latest_attempt_scraped_at)": "[^"]*"/"\1": "<time>"/'
}
summary() {
  psql_db -Atq -c "SELECT string_agg(board->>'registry_slug' || ':' || (board->>'evidence_status') || ':' ||
                          coalesce(board->>'entry_count', '-') || ':' ||
                          coalesce(board->>'rank_limited_entry_count', '-'), ' ' ORDER BY board->>'registry_slug')
                     FROM jsonb_array_elements(
                            public.arena_score_inputs_publish_bundle_json('7D', 1000, 48)->'physicalBoards') AS board"
}

BEFORE="$(bundle)"
EXPECTED="big_board:passed:1500:1000 empty_board:passed:0:0 failed_latest:latest_attempt_failed:30:30 mismatch_board:entry_count_mismatch:47:47 never_passed:failed:-:- small_board:passed:40:40 stale_board:stale:1200:1000 stray_entries:passed:20:20"
if [[ "$(summary)" != "$EXPECTED" ]]; then
  echo "baseline bundle is not what the fixture intends:" >&2
  summary >&2
  exit 1
fi
echo "ok: baseline bundle covers passed, empty, mismatch, failed, stale and stray-entry boards"

psql_db -q -f "$NEW_MIGRATION" >/dev/null

if [[ "$(summary)" != "$EXPECTED" ]]; then
  echo "bundle summary changed after the migration:" >&2
  summary >&2
  exit 1
fi
AFTER="$(bundle)"
if [[ "$BEFORE" != "$AFTER" ]]; then
  echo "bundle JSON changed after the migration:" >&2
  diff <(echo "$BEFORE") <(echo "$AFTER") >&2 || true
  exit 1
fi
echo "ok: the bundle JSON for 7D, 30D, 90D and a rank limit of 10 is identical after the migration"

# The counting step, lifted out of the migration, reads no heap page once the
# visibility map is set (the stray-entry snapshot is left out: it takes the
# exact heap count by design).
{
  echo "EXPLAIN (ANALYZE, COSTS OFF, FORMAT JSON) WITH latest_passed_snapshot AS MATERIALIZED ("
  echo "  SELECT id AS snapshot_id, scraped_at FROM arena.leaderboard_snapshots WHERE id IN (10, 20, 30, 40, 60)"
  echo "),"
  awk '/-- entry-counts:begin/ { on = 1; next } /-- entry-counts:end/ { on = 0 } on { print }' "$NEW_MIGRATION" |
    grep -v '^  --' | sed 's/p_per_platform_limit/1000/g' | sed '$ s/),$/)/'
  echo "SELECT * FROM passed_entry_counts;"
} >"$TMP_ROOT/explain.sql"
psql_db -Atq -f "$TMP_ROOT/explain.sql" >"$TMP_ROOT/plan.json"
HEAP="$(node -e '
  const plan = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[0].Plan
  let heapFetches = 0, indexOnly = 0, other = 0
  const walk = (node) => {
    if (String(node["Relation Name"] ?? "").startsWith("leaderboard_entries") && (node["Actual Loops"] ?? 0) > 0) {
      if (node["Node Type"] === "Index Only Scan") {
        indexOnly += 1
        heapFetches += (node["Heap Fetches"] ?? 0) * node["Actual Loops"]
      } else other += 1
    }
    for (const child of node.Plans ?? []) walk(child)
  }
  walk(plan)
  console.log(`${indexOnly} ${heapFetches} ${other}`)
' "$TMP_ROOT/plan.json")"
read -r INDEX_ONLY HEAP_FETCHES OTHER_SCANS <<<"$HEAP"
if ((INDEX_ONLY == 0 || HEAP_FETCHES != 0 || OTHER_SCANS != 0)); then
  echo "entry counts are not index-only: index-only scans $INDEX_ONLY, heap fetches $HEAP_FETCHES, other scans $OTHER_SCANS" >&2
  exit 1
fi
echo "ok: the counting step ran $INDEX_ONLY index-only scans with 0 heap fetches and no other scan of the entries"

if psql_db -q -f "$NEW_MIGRATION" >/dev/null 2>"$TMP_ROOT/replay.err"; then
  echo "replaying the migration was not refused" >&2
  exit 1
fi
grep -q "is not the 20261116204006 definition" "$TMP_ROOT/replay.err"
echo "ok: a replay is refused"

echo "score bundle index-only entry counts PostgreSQL 17 proof passed"
