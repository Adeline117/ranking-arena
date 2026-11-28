#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for
#   20261128001007_trader_stats_drop_as_of_index.sql and
#   20261128001008_traders_drop_last_seen_index.sql.
# It owns an isolated temporary cluster and never connects to a developer or
# remote DB.
#
# arena.traders, arena.trader_stats and every one of their indexes are taken
# verbatim from the migrations that created them (20260610223752,
# 20260610223901, 20260610235047, 20260709201917), so the definitions each
# migration expects are checked against what PostgreSQL deparses for them.
#
# Proves, for each migration on its own:
#   1. it drops only its index; every other index stays, valid, with its
#      definition, and the other table is untouched;
#   2. the update a board upsert makes (as_of or last_seen_at moves, nothing
#      else indexed changes) is not HOT before the drop and is HOT after it;
#   3. a replay is a no-op;
#   4. an index someone changed is refused and left in place;
#   5. while another transaction holds the table, it gives up after
#      lock_timeout (3 s) and changes nothing; a retry succeeds;
#   6. its rollback (autocommit, CREATE INDEX CONCURRENTLY) rebuilds the
#      index with the original definition, a second rollback run is a no-op,
#      and the migration applies again;
# and 7. both together leave exactly the kept indexes, in either order.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
ROLLBACKS="$ROOT_DIR/scripts/maintenance/rollbacks"
STATS_MIGRATION="$MIGRATIONS/20261128001007_trader_stats_drop_as_of_index.sql"
STATS_ROLLBACK="$ROLLBACKS/20261128001007_trader_stats_drop_as_of_index.rollback.sql"
TRADERS_MIGRATION="$MIGRATIONS/20261128001008_traders_drop_last_seen_index.sql"
TRADERS_ROLLBACK="$ROLLBACKS/20261128001008_traders_drop_last_seen_index.rollback.sql"
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

TMP_ROOT="$(mktemp -d /tmp/hot-index-drops-pg17.XXXXXX)"
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
  # A few rows on pages with room, as the live tables have after vacuum.
  cat <<'SQL'
INSERT INTO arena.sources VALUES (1, 'bybit_mt5');
INSERT INTO arena.traders (source_id, exchange_trader_id, nickname)
SELECT 1, 'trader-' || g, 'nick ' || g FROM pg_catalog.generate_series(1, 20) AS g;
INSERT INTO arena.trader_stats (trader_id, timeframe, as_of, currency, roi, pnl)
SELECT id, 30, timestamptz '2026-11-28 07:50:00+00', 'USDT', id * 1.5, id * 100
  FROM arena.traders;
SQL
} >"$FIXTURE_FILE"
psql_db postgres -q -f "$FIXTURE_FILE"

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
             || (SELECT pg_catalog.string_agg(s::text, ',' ORDER BY s.trader_id) FROM arena.trader_stats AS s))"
}

# HOT updates the board upsert's kind of update makes, counted inside its own
# transaction (pg_stat_xact_* is exact and immediate).
hot_updates() {
  local db="$1" table="$2" set_clause="$3"
  psql_db "$db" -Atq <<SQL
BEGIN;
UPDATE arena.$table SET $set_clause;
SELECT n_tup_upd || '/' || n_tup_hot_upd
  FROM pg_catalog.pg_stat_xact_user_tables
 WHERE relid = 'arena.$table'::regclass;
ROLLBACK;
SQL
}
STATS_UPDATE="as_of = as_of + interval '5 hours'"
TRADERS_UPDATE="last_seen_at = last_seen_at + interval '5 hours'"

FULL_STATS="$(index_inventory postgres trader_stats)"
FULL_TRADERS="$(index_inventory postgres traders)"
KEPT_STATS="$(grep -v '^idx_arena_trader_stats_as_of|' <<<"$FULL_STATS")"
KEPT_TRADERS="$(grep -v '^idx_arena_traders_last_seen|' <<<"$FULL_TRADERS")"
ROWS="$(row_digest postgres)"

assert_equal "trader_stats has its three production indexes" "3" "$(wc -l <<<"$FULL_STATS" | tr -d ' ')"
assert_equal "traders has its eight production indexes" "8" "$(wc -l <<<"$FULL_TRADERS" | tr -d ' ')"
assert_equal "as_of deparses exactly as production reports it" \
  "idx_arena_trader_stats_as_of|true|CREATE INDEX idx_arena_trader_stats_as_of ON arena.trader_stats USING btree (as_of)" \
  "$(grep '^idx_arena_trader_stats_as_of|' <<<"$FULL_STATS")"
assert_equal "last_seen deparses exactly as production reports it" \
  "idx_arena_traders_last_seen|true|CREATE INDEX idx_arena_traders_last_seen ON arena.traders USING btree (last_seen_at DESC)" \
  "$(grep '^idx_arena_traders_last_seen|' <<<"$FULL_TRADERS")"
assert_equal "before the drop, moving as_of is never HOT" "20/0" "$(hot_updates postgres trader_stats "$STATS_UPDATE")"
assert_equal "before the drop, moving last_seen_at is never HOT" "20/0" "$(hot_updates postgres traders "$TRADERS_UPDATE")"

for db in stats_main stats_changed stats_locked stats_rolled traders_main traders_changed traders_locked traders_rolled both_ab both_ba; do
  clone_db postgres "$db"
done

# prove_one LABEL TABLE INDEX MIGRATION ROLLBACK KEPT FULL OTHER_TABLE OTHER_FULL UPDATE CHANGED_SQL PREFIX
prove_one() {
  local label="$1" table="$2" index="$3" migration="$4" rollback="$5" kept="$6" full="$7"
  local other="$8" other_full="$9" update="${10}" changed_sql="${11}" prefix="${12}"

  # ── 1, 2, 3: drop, HOT, replay ──
  psql_db "${prefix}_main" -q -f "$migration"
  assert_equal "$label: only $index is dropped; the others stay valid and unchanged" "$kept" "$(index_inventory "${prefix}_main" "$table")"
  assert_equal "$label: arena.$other is untouched" "$other_full" "$(index_inventory "${prefix}_main" "$other")"
  assert_equal "$label: every row is unchanged" "$ROWS" "$(row_digest "${prefix}_main")"
  assert_equal "$label: the board upsert's update is now HOT" "20/20" "$(hot_updates "${prefix}_main" "$table" "$update")"
  psql_db "${prefix}_main" -q -f "$migration"
  assert_equal "$label: a replay changes nothing" "$kept" "$(index_inventory "${prefix}_main" "$table")"

  # ── 4: an index someone changed ──
  psql_db "${prefix}_changed" -q -c "DROP INDEX arena.$index; $changed_sql"
  local changed_before
  changed_before="$(index_inventory "${prefix}_changed" "$table")"
  if psql_db "${prefix}_changed" -q -f "$migration" >"$ERROR_FILE" 2>&1; then
    echo "FAIL: $label: a changed $index was dropped" >&2
    exit 1
  fi
  grep -q "is not the expected definition" "$ERROR_FILE" || { cat "$ERROR_FILE" >&2; exit 1; }
  assert_equal "$label: a changed index is refused and left in place" "$changed_before" "$(index_inventory "${prefix}_changed" "$table")"

  # ── 5: lock_timeout while a publication holds the table ──
  psql_db "${prefix}_locked" -q -c "BEGIN; LOCK TABLE arena.$table IN ROW EXCLUSIVE MODE; SELECT pg_catalog.pg_sleep(8); COMMIT;" >/dev/null &
  local holder=$! started elapsed
  sleep 1
  started=$(date +%s)
  if psql_db "${prefix}_locked" -q -f "$migration" >"$ERROR_FILE" 2>&1; then
    echo "FAIL: $label: the migration did not wait for the lock" >&2
    exit 1
  fi
  elapsed=$(( $(date +%s) - started ))
  grep -q "lock timeout" "$ERROR_FILE" || { cat "$ERROR_FILE" >&2; exit 1; }
  (( elapsed <= 5 )) || { echo "FAIL: $label: gave up only after ${elapsed}s" >&2; exit 1; }
  assert_equal "$label: a held table makes the migration give up after lock_timeout and change nothing" \
    "$full" "$(index_inventory "${prefix}_locked" "$table")"
  wait "$holder"
  psql_db "${prefix}_locked" -q -f "$migration"
  assert_equal "$label: a retry after the publication succeeds" "$kept" "$(index_inventory "${prefix}_locked" "$table")"

  # ── 6: rollback and re-apply ──
  psql_db "${prefix}_rolled" -q -f "$migration"
  psql_db "${prefix}_rolled" -q -f "$rollback"
  assert_equal "$label: the rollback rebuilds $index with its original definition" "$full" "$(index_inventory "${prefix}_rolled" "$table")"
  psql_db "${prefix}_rolled" -q -f "$rollback"
  assert_equal "$label: a second rollback run changes nothing" "$full" "$(index_inventory "${prefix}_rolled" "$table")"
  assert_equal "$label: after the rollback the update is not HOT again" "20/0" "$(hot_updates "${prefix}_rolled" "$table" "$update")"
  psql_db "${prefix}_rolled" -q -f "$migration"
  assert_equal "$label: the migration applies again after the rollback" "$kept" "$(index_inventory "${prefix}_rolled" "$table")"
}

prove_one "trader_stats" trader_stats idx_arena_trader_stats_as_of \
  "$STATS_MIGRATION" "$STATS_ROLLBACK" "$KEPT_STATS" "$FULL_STATS" traders "$FULL_TRADERS" \
  "$STATS_UPDATE" "CREATE INDEX idx_arena_trader_stats_as_of ON arena.trader_stats (as_of DESC);" stats

prove_one "traders" traders idx_arena_traders_last_seen \
  "$TRADERS_MIGRATION" "$TRADERS_ROLLBACK" "$KEPT_TRADERS" "$FULL_TRADERS" trader_stats "$FULL_STATS" \
  "$TRADERS_UPDATE" "CREATE INDEX idx_arena_traders_last_seen ON arena.traders (last_seen_at);" traders

# ── 7: both, in either order ──
psql_db both_ab -q -f "$STATS_MIGRATION"
psql_db both_ab -q -f "$TRADERS_MIGRATION"
psql_db both_ba -q -f "$TRADERS_MIGRATION"
psql_db both_ba -q -f "$STATS_MIGRATION"
for db in both_ab both_ba; do
  assert_equal "$db: trader_stats keeps exactly its two other indexes" "$KEPT_STATS" "$(index_inventory "$db" trader_stats)"
  assert_equal "$db: traders keeps exactly its seven other indexes" "$KEPT_TRADERS" "$(index_inventory "$db" traders)"
done

echo "trader_stats as_of / traders last_seen index drops PostgreSQL 17 proof passed"
