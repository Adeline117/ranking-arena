#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for
# 20261128025722_trader_stats_drop_tf_roi_index.sql. It owns an isolated
# temporary cluster and never connects to a developer or remote DB.
#
# arena.traders and arena.trader_stats, with every index, are taken verbatim
# from the migrations that created them, and the four 2026-11-28 production
# migrations on them (20261128001007/001008 index drops, 20261128022325/022326
# fillfactor 90) are applied first, so the tables start in their production
# shape.
#
# Proves:
#   1. it drops only tf_roi; trader_stats_pkey is the only index left, valid
#      and unchanged; traders and every row are unchanged;
#   2. an upsert that changes roi is not HOT before and is HOT after;
#   3. the derive-boards query (worker/src/ingest/processors/derive-boards.ts)
#      reads trader_stats through trader_stats_pkey after the drop, never a
#      sequential scan, and returns the same rows in the same order;
#   4. a replay is a no-op; a changed tf_roi is refused and left in place;
#   5. while a publication holds the table it gives up after lock_timeout
#      (3 s) and changes nothing; a retry succeeds;
#   6. the rollback (autocommit, CREATE INDEX CONCURRENTLY) rebuilds tf_roi
#      with its 20260610223901 definition, a second run is a no-op, and the
#      migration applies again.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
ROLLBACKS="$ROOT_DIR/scripts/maintenance/rollbacks"
TARGET="$MIGRATIONS/20261128025722_trader_stats_drop_tf_roi_index.sql"
ROLLBACK="$ROLLBACKS/20261128025722_trader_stats_drop_tf_roi_index.rollback.sql"
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

TMP_ROOT="$(mktemp -d /tmp/tf-roi-drop-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
FIXTURE_FILE="$TMP_ROOT/fixture.sql"
PORT="${PGPORT_OVERRIDE:-$((46000 + ($$ % 5000)))}"
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

# Every fixture object and migration runs as the non-superuser postgres role.
psql_db() {
  local db="$1"
  shift
  PGOPTIONS='-c client_min_messages=warning' \
    "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d "$db" "$@"
}

psql_admin() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U supabase_admin -d postgres "$@"
}

clone_db() {
  psql_admin -qc "CREATE DATABASE $2 TEMPLATE $1 OWNER postgres;"
}

assert_equal() {
  if [[ "$2" != "$3" ]]; then
    echo "FAIL: $1" >&2
    echo "  expected: $2" >&2
    echo "  actual:   $3" >&2
    exit 1
  fi
  echo "ok: $1"
}

# Copy one statement verbatim out of a migration: from the line that starts
# with $2 through the first line ending in ';'.
extract_statement() {
  local file="$1" start="$2" out
  out="$(awk -v start="$start" '
    !found && index($0, start) == 1 { found = 1 }
    found { print; if ($0 ~ /;[[:space:]]*$/) exit }
  ' "$file")"
  if [[ -z "$out" ]]; then
    echo "statement not found in $file: $start" >&2
    exit 1
  fi
  printf '%s\n' "$out"
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U supabase_admin --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null

psql_admin -q <<'SQL'
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE BYPASSRLS;
GRANT CREATE ON DATABASE postgres TO postgres;
ALTER SCHEMA public OWNER TO postgres;
SQL
if [[ "$(psql_db postgres -Atqc "SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user")" != "f" ]]; then
  echo "migrations must run as a non-superuser postgres role" >&2
  exit 1
fi

IDENTITY="$MIGRATIONS/20260610223752_arena_identity_and_cache.sql"
STATS="$MIGRATIONS/20260610223901_arena_leaderboard_and_stats.sql"
{
  echo 'CREATE SCHEMA arena;'
  echo 'CREATE TABLE arena.sources (id smallint PRIMARY KEY, slug text UNIQUE NOT NULL);'
  extract_statement "$IDENTITY" 'CREATE TABLE arena.traders ('
  extract_statement "$IDENTITY" 'CREATE INDEX idx_arena_traders_last_seen '
  extract_statement "$IDENTITY" 'CREATE INDEX idx_arena_traders_kind '
  extract_statement "$IDENTITY" 'CREATE INDEX idx_arena_traders_wallet '
  extract_statement "$IDENTITY" 'CREATE INDEX idx_arena_traders_unmirrored '
  extract_statement "$MIGRATIONS/20260610235047_arena_serving_resolve_rpc.sql" \
    'CREATE INDEX IF NOT EXISTS idx_arena_traders_nickname_lower'
  extract_statement "$MIGRATIONS/20260709201917_score_inputs_first_party_branch.sql" \
    'CREATE INDEX IF NOT EXISTS traders_claimed_idx'
  extract_statement "$STATS" 'CREATE TABLE arena.trader_stats ('
  extract_statement "$STATS" 'CREATE INDEX idx_arena_trader_stats_as_of '
  extract_statement "$STATS" 'CREATE INDEX idx_arena_trader_stats_tf_roi'
} >"$FIXTURE_FILE"
psql_db postgres -q -f "$FIXTURE_FILE"
for m in 20261128001007_trader_stats_drop_as_of_index 20261128001008_traders_drop_last_seen_index \
         20261128022325_trader_stats_fillfactor_90 20261128022326_traders_fillfactor_90; do
  psql_db postgres -q -f "$MIGRATIONS/$m.sql"
done
# 40 sources; source 7 is a derived board of 3,000 traders among 60,000.
psql_db postgres -q <<'SQL'
INSERT INTO arena.sources SELECT g, 'src' || g FROM pg_catalog.generate_series(1, 40) AS g;
INSERT INTO arena.traders (source_id, exchange_trader_id, nickname)
SELECT CASE WHEN g <= 3000 THEN 7 ELSE 8 + (g % 33) END, 'x' || g, 'n' || g
  FROM pg_catalog.generate_series(1, 60000) AS g;
INSERT INTO arena.trader_stats (trader_id, timeframe, as_of, currency, roi, pnl, win_rate)
SELECT t.id, v.tf, timestamptz '2026-11-28 10:00:00+00' - (t.id % 60) * interval '1 hour', 'USDT',
       ((t.id * 7919) % 100000) / 100.0 - 200, t.id * 10, (t.id % 100) / 100.0
  FROM arena.traders AS t CROSS JOIN (VALUES (7), (30), (90)) AS v(tf);
ANALYZE arena.traders;
ANALYZE arena.trader_stats;
SQL

index_inventory() {
  psql_db "$1" -Atqc "
    SELECT pg_catalog.string_agg(
             c.relname || '|' || i.indisvalid::text || '|' || pg_catalog.pg_get_indexdef(c.oid),
             E'\n' ORDER BY c.relname)
      FROM pg_catalog.pg_index AS i
      JOIN pg_catalog.pg_class AS c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'arena.$2'::regclass"
}
row_digest() {
  psql_db "$1" -Atqc "
    SELECT pg_catalog.md5(
             (SELECT pg_catalog.string_agg(t::text, ',' ORDER BY t.id) FROM arena.traders AS t)
             || (SELECT pg_catalog.string_agg(s::text, ',' ORDER BY s.trader_id, s.timeframe) FROM arena.trader_stats AS s))"
}
# An upsert that moves as_of AND changes roi, on rows written after fillfactor 90.
roi_hot_updates() {
  psql_db "$1" -Atq <<'SQL'
BEGIN;
INSERT INTO arena.trader_stats (trader_id, timeframe, as_of, currency, roi)
SELECT id, 0, timestamptz '2026-11-28 07:50:00+00', 'USDT', id FROM arena.traders WHERE id <= 20;
UPDATE arena.trader_stats SET as_of = as_of + interval '5 hours', roi = roi + 1 WHERE timeframe = 0;
SELECT n_tup_upd || '/' || n_tup_hot_upd FROM pg_catalog.pg_stat_xact_user_tables
 WHERE relid = 'arena.trader_stats'::regclass;
ROLLBACK;
SQL
}
ELIGIBLE="$(psql_db postgres -Atqc "SELECT pg_catalog.array_agg(id ORDER BY id)::text FROM arena.traders WHERE source_id = 7 AND id % 10 <> 0")"
# derive-boards.ts, verbatim but for the parameters and the registry sort column (roi).
DERIVE_SQL="SELECT t.exchange_trader_id, t.nickname, t.avatar_url_origin, t.wallet_address,
              t.trader_kind, t.bot_strategy,
              s.roi::text, s.pnl::text, s.win_rate::text, s.as_of::text AS as_of
         FROM arena.trader_stats s
         JOIN arena.traders t ON t.id = s.trader_id
        WHERE t.source_id = 7
          AND t.id = ANY('$ELIGIBLE'::bigint[])
          AND s.timeframe = 30
          AND s.roi IS NOT NULL
          AND s.as_of > timestamptz '2026-11-28 10:00:00+00' - make_interval(hours => 48)
        ORDER BY s.roi DESC"
derive_rows() { psql_db "$1" -Atqc "SELECT pg_catalog.md5(pg_catalog.string_agg(r::text, ',')) FROM ($DERIVE_SQL) AS r"; }
derive_plan() { psql_db "$1" -Atqc "EXPLAIN (COSTS OFF) $DERIVE_SQL" | grep -E 'Scan' | grep -oE '(Seq Scan|Index Scan|Index Only Scan|Bitmap Heap Scan|Bitmap Index Scan)( using [a-z_]+)? on [a-z_]+' | sort -u | tr '\n' ';'; }

FULL="$(index_inventory postgres trader_stats)"
TRADERS_FULL="$(index_inventory postgres traders)"
KEPT="$(grep '^trader_stats_pkey|' <<<"$FULL")"
ROWS="$(row_digest postgres)"
DERIVE_BEFORE="$(derive_rows postgres)"
assert_equal "trader_stats starts with pkey and tf_roi (as_of already dropped)" "2" "$(wc -l <<<"$FULL" | tr -d ' ')"
assert_equal "tf_roi deparses exactly as production reports it" \
  "idx_arena_trader_stats_tf_roi|true|CREATE INDEX idx_arena_trader_stats_tf_roi ON arena.trader_stats USING btree (timeframe, roi DESC NULLS LAST)" \
  "$(grep '^idx_arena_trader_stats_tf_roi|' <<<"$FULL")"
assert_equal "before the drop, an upsert that changes roi is never HOT" "20/0" "$(roi_hot_updates postgres)"

for db in main changed locked rolled; do clone_db postgres "$db"; done

# ── 1, 2, 3 ──
psql_db main -q -f "$TARGET"
assert_equal "only tf_roi is dropped; trader_stats_pkey is the only index, unchanged" "$KEPT" "$(index_inventory main trader_stats)"
assert_equal "traders is untouched" "$TRADERS_FULL" "$(index_inventory main traders)"
assert_equal "every row is unchanged" "$ROWS" "$(row_digest main)"
assert_equal "after the drop, an upsert that changes roi is HOT" "20/20" "$(roi_hot_updates main)"
PLAN_AFTER="$(derive_plan main)"
echo "   derive-boards plan after the drop: $PLAN_AFTER"
[[ "$PLAN_AFTER" == *"Index Scan using trader_stats_pkey on trader_stats"* ]] || { echo "FAIL: derive-boards does not use trader_stats_pkey" >&2; exit 1; }
[[ "$PLAN_AFTER" != *"Seq Scan on trader_stats"* ]] || { echo "FAIL: derive-boards scans trader_stats sequentially" >&2; exit 1; }
echo "ok: derive-boards reads trader_stats through trader_stats_pkey, no sequential scan"
assert_equal "derive-boards returns the same rows in the same order" "$DERIVE_BEFORE" "$(derive_rows main)"

# ── 4 ──
psql_db main -q -f "$TARGET"
assert_equal "a replay changes nothing" "$KEPT" "$(index_inventory main trader_stats)"
psql_db changed -q -c "DROP INDEX arena.idx_arena_trader_stats_tf_roi; CREATE INDEX idx_arena_trader_stats_tf_roi ON arena.trader_stats (timeframe, roi);"
CHANGED_BEFORE="$(index_inventory changed trader_stats)"
if psql_db changed -q -f "$TARGET" >"$ERROR_FILE" 2>&1; then
  echo "FAIL: a changed tf_roi was dropped" >&2; exit 1
fi
grep -q "is not the expected definition" "$ERROR_FILE" || { cat "$ERROR_FILE" >&2; exit 1; }
assert_equal "a changed tf_roi is refused and left in place" "$CHANGED_BEFORE" "$(index_inventory changed trader_stats)"

# ── 5 ──
psql_db locked -q -c "BEGIN; LOCK TABLE arena.trader_stats IN ROW EXCLUSIVE MODE; SELECT pg_catalog.pg_sleep(8); COMMIT;" >/dev/null &
HOLDER=$!
sleep 1
started=$(date +%s)
if psql_db locked -q -f "$TARGET" >"$ERROR_FILE" 2>&1; then
  echo "FAIL: the migration did not wait for the lock" >&2; exit 1
fi
elapsed=$(( $(date +%s) - started ))
grep -q "lock timeout" "$ERROR_FILE" || { cat "$ERROR_FILE" >&2; exit 1; }
(( elapsed <= 5 )) || { echo "FAIL: gave up only after ${elapsed}s" >&2; exit 1; }
assert_equal "a held table makes the migration give up after lock_timeout and change nothing" "$FULL" "$(index_inventory locked trader_stats)"
wait "$HOLDER"
psql_db locked -q -f "$TARGET"
assert_equal "a retry after the publication succeeds" "$KEPT" "$(index_inventory locked trader_stats)"

# ── 6 ──
psql_db rolled -q -f "$TARGET"
psql_db rolled -q -f "$ROLLBACK"
assert_equal "the rollback rebuilds tf_roi with its 20260610223901 definition" "$FULL" "$(index_inventory rolled trader_stats)"
psql_db rolled -q -f "$ROLLBACK"
assert_equal "a second rollback run changes nothing" "$FULL" "$(index_inventory rolled trader_stats)"
psql_db rolled -q -f "$TARGET"
assert_equal "the migration applies again after the rollback" "$KEPT" "$(index_inventory rolled trader_stats)"

echo "trader_stats drop tf_roi index PostgreSQL 17 proof passed"
