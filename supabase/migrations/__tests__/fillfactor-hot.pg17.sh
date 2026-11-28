#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for
#   20261128022325_trader_stats_fillfactor_90.sql and
#   20261128022326_traders_fillfactor_90.sql.
# It owns an isolated temporary cluster and never connects to a developer or
# remote DB.
#
# arena.traders and arena.trader_stats, with every index, are taken verbatim
# from the migrations that created them, and 20261128001007/001008 (applied
# in production 2026-11-28) are applied on top, so the tables start in their
# production shape: plain tables, reloptions empty.
#
# Proves, for each migration on its own:
#   1. it sets exactly fillfactor=90 on its table; columns, indexes, triggers,
#      constraints, rows and the other table are unchanged;
#   2. a replay is a no-op;
#   3. other storage parameters someone set are refused and left in place;
#   4. a partitioned table, or a partition, is refused;
#   5. a publication's ROW EXCLUSIVE lock does not block it; a SHARE UPDATE
#      EXCLUSIVE holder (VACUUM, DDL) makes it give up after lock_timeout
#      (3 s) and change nothing, and a retry succeeds;
#   6. after it, rows written and then updated the way a board upsert updates
#      them get more HOT updates than with the default fillfactor;
#   7. its rollback restores empty reloptions, a second rollback run is a
#      no-op, and the migration applies again;
# and 8. both together, in either order, set both tables.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
ROLLBACKS="$ROOT_DIR/scripts/maintenance/rollbacks"
STATS_MIGRATION="$MIGRATIONS/20261128022325_trader_stats_fillfactor_90.sql"
STATS_ROLLBACK="$ROLLBACKS/20261128022325_trader_stats_fillfactor_90.rollback.sql"
TRADERS_MIGRATION="$MIGRATIONS/20261128022326_traders_fillfactor_90.sql"
TRADERS_ROLLBACK="$ROLLBACKS/20261128022326_traders_fillfactor_90.rollback.sql"
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

TMP_ROOT="$(mktemp -d /tmp/fillfactor-hot-pg17.XXXXXX)"
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
  echo "INSERT INTO arena.sources VALUES (1, 'bybit_mt5');"
} >"$FIXTURE_FILE"
psql_db postgres -q -f "$FIXTURE_FILE"
psql_db postgres -q -f "$MIGRATIONS/20261128001007_trader_stats_drop_as_of_index.sql"
psql_db postgres -q -f "$MIGRATIONS/20261128001008_traders_drop_last_seen_index.sql"
psql_db postgres -q <<'SQL'
INSERT INTO arena.traders (source_id, exchange_trader_id, nickname)
SELECT 1, 'trader-' || g, 'nick ' || g FROM pg_catalog.generate_series(1, 20) AS g;
INSERT INTO arena.trader_stats (trader_id, timeframe, as_of, currency, roi, pnl)
SELECT id, 30, timestamptz '2026-11-28 07:50:00+00', 'USDT', id * 1.5, id * 100
  FROM arena.traders;
SQL

reloptions() {
  psql_db "$1" -Atqc "SELECT COALESCE(c.reloptions::text, '<empty>') FROM pg_catalog.pg_class AS c WHERE c.oid = 'arena.$2'::regclass"
}

# Everything but reloptions: columns, indexes, triggers, constraints, rows.
shape() {
  psql_db "$1" -Atqc "
    SELECT pg_catalog.md5(pg_catalog.concat_ws(E'\n',
      (SELECT pg_catalog.string_agg(a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull, ',' ORDER BY a.attnum)
         FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = 'arena.$2'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
      (SELECT pg_catalog.string_agg(pg_catalog.pg_get_indexdef(i.indexrelid) || ':' || i.indisvalid, ',' ORDER BY i.indexrelid::regclass::text)
         FROM pg_catalog.pg_index AS i WHERE i.indrelid = 'arena.$2'::regclass),
      (SELECT pg_catalog.string_agg(pg_catalog.pg_get_constraintdef(c.oid), ',' ORDER BY c.conname)
         FROM pg_catalog.pg_constraint AS c WHERE c.conrelid = 'arena.$2'::regclass),
      (SELECT pg_catalog.string_agg(t.tgname, ',' ORDER BY t.tgname)
         FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = 'arena.$2'::regclass),
      (SELECT pg_catalog.string_agg(r::text, ',' ORDER BY r::text) FROM arena.$2 AS r)))"
}

# Write 3,000 rows after the migration, then three board-like rounds that
# update every row once (as_of or last_seen_at moves, nothing indexed
# changes), each in its own committed transaction so pruning can reclaim the
# previous versions. Prints the HOT updates of the three rounds.
hot_rounds() {
  local db="$1" table="$2"
  psql_db "$db" -q <<'SQL'
INSERT INTO arena.traders (source_id, exchange_trader_id, nickname, meta)
SELECT 1, 'bulk-' || g, 'bulk nick ' || g,
       pg_catalog.jsonb_build_object('style', pg_catalog.repeat('x', 40), 'rank', g)
  FROM pg_catalog.generate_series(1, 3000) AS g;
INSERT INTO arena.trader_stats (trader_id, timeframe, as_of, currency, roi, pnl, extras)
SELECT t.id, 7, timestamptz '2026-11-28 07:50:00+00', 'USDT', t.id * 1.5, t.id * 100,
       pg_catalog.jsonb_build_object('sortino', t.id * 0.01, 'note', pg_catalog.repeat('y', 40))
  FROM arena.traders AS t WHERE t.exchange_trader_id LIKE 'bulk-%';
SQL
  local where set_clause out=""
  if [[ "$table" == trader_stats ]]; then
    where="timeframe = 7"; set_clause="as_of = as_of + interval '5 hours'"
  else
    where="exchange_trader_id LIKE 'bulk-%'"; set_clause="last_seen_at = last_seen_at + interval '5 hours'"
  fi
  for _ in 1 2 3; do
    out+="$(psql_db "$db" -Atq <<SQL
BEGIN;
UPDATE arena.$table SET $set_clause WHERE $where;
SELECT n_tup_hot_upd FROM pg_catalog.pg_stat_xact_user_tables WHERE relid = 'arena.$table'::regclass;
COMMIT;
SQL
)"
    out+=" "
  done
  echo "${out% }"
}

sum_words() { local s=0 w; for w in $1; do s=$((s + w)); done; echo "$s"; }

assert_equal "trader_stats starts as a plain table with empty reloptions" "<empty>" "$(reloptions postgres trader_stats)"
assert_equal "traders starts as a plain table with empty reloptions" "<empty>" "$(reloptions postgres traders)"
STATS_SHAPE="$(shape postgres trader_stats)"
TRADERS_SHAPE="$(shape postgres traders)"

for db in stats_main stats_other stats_locked stats_rolled stats_ff100 stats_ff90 \
          traders_main traders_other traders_locked traders_rolled traders_ff100 traders_ff90 \
          both_ab both_ba partitioned; do
  clone_db postgres "$db"
done

# prove_one LABEL TABLE MIGRATION ROLLBACK SHAPE OTHER_TABLE OTHER_SHAPE PREFIX
prove_one() {
  local label="$1" table="$2" migration="$3" rollback="$4" own_shape="$5" other="$6" other_shape="$7" prefix="$8"

  # ── 1, 2: set and replay ──
  psql_db "${prefix}_main" -q -f "$migration"
  assert_equal "$label: reloptions are exactly fillfactor=90" "{fillfactor=90}" "$(reloptions "${prefix}_main" "$table")"
  assert_equal "$label: columns, indexes, constraints, triggers and rows are unchanged" "$own_shape" "$(shape "${prefix}_main" "$table")"
  assert_equal "$label: arena.$other is untouched" "<empty>|$other_shape" "$(reloptions "${prefix}_main" "$other")|$(shape "${prefix}_main" "$other")"
  psql_db "${prefix}_main" -q -f "$migration"
  assert_equal "$label: a replay changes nothing" "{fillfactor=90}|$own_shape" "$(reloptions "${prefix}_main" "$table")|$(shape "${prefix}_main" "$table")"

  # ── 3: storage parameters someone else set ──
  psql_db "${prefix}_other" -q -c "ALTER TABLE arena.$table SET (autovacuum_vacuum_scale_factor = 0.05);"
  if psql_db "${prefix}_other" -q -f "$migration" >"$ERROR_FILE" 2>&1; then
    echo "FAIL: $label: other storage parameters were overwritten" >&2
    exit 1
  fi
  grep -q "already has storage parameters" "$ERROR_FILE" || { cat "$ERROR_FILE" >&2; exit 1; }
  assert_equal "$label: other storage parameters are refused and left in place" \
    "{autovacuum_vacuum_scale_factor=0.05}" "$(reloptions "${prefix}_other" "$table")"

  # ── 5: locks ──
  psql_db "${prefix}_locked" -q -c "BEGIN; LOCK TABLE arena.$table IN ROW EXCLUSIVE MODE; SELECT pg_catalog.pg_sleep(6); COMMIT;" >/dev/null &
  local holder=$! started elapsed
  sleep 1
  started=$(date +%s)
  psql_db "${prefix}_locked" -q -f "$migration"
  elapsed=$(( $(date +%s) - started ))
  (( elapsed <= 2 )) || { echo "FAIL: $label: a ROW EXCLUSIVE holder delayed it ${elapsed}s" >&2; exit 1; }
  assert_equal "$label: a publication's ROW EXCLUSIVE lock does not block it" "{fillfactor=90}" "$(reloptions "${prefix}_locked" "$table")"
  wait "$holder"
  psql_db "${prefix}_locked" -q -c "ALTER TABLE arena.$table RESET (fillfactor);"
  psql_db "${prefix}_locked" -q -c "BEGIN; LOCK TABLE arena.$table IN SHARE UPDATE EXCLUSIVE MODE; SELECT pg_catalog.pg_sleep(8); COMMIT;" >/dev/null &
  holder=$!
  sleep 1
  started=$(date +%s)
  if psql_db "${prefix}_locked" -q -f "$migration" >"$ERROR_FILE" 2>&1; then
    echo "FAIL: $label: the migration did not wait for SHARE UPDATE EXCLUSIVE" >&2
    exit 1
  fi
  elapsed=$(( $(date +%s) - started ))
  grep -q "lock timeout" "$ERROR_FILE" || { cat "$ERROR_FILE" >&2; exit 1; }
  (( elapsed <= 5 )) || { echo "FAIL: $label: gave up only after ${elapsed}s" >&2; exit 1; }
  assert_equal "$label: a VACUUM/DDL holder makes it give up after lock_timeout and change nothing" "<empty>" "$(reloptions "${prefix}_locked" "$table")"
  wait "$holder"
  psql_db "${prefix}_locked" -q -f "$migration"
  assert_equal "$label: a retry succeeds" "{fillfactor=90}" "$(reloptions "${prefix}_locked" "$table")"

  # ── 6: HOT updates with and without it ──
  psql_db "${prefix}_ff90" -q -f "$migration"
  local hot100 hot90
  hot100="$(hot_rounds "${prefix}_ff100" "$table")"
  hot90="$(hot_rounds "${prefix}_ff90" "$table")"
  echo "   $label HOT updates per round of 3,000: fillfactor 100: $hot100; fillfactor 90: $hot90"
  if (( $(sum_words "$hot90") <= $(sum_words "$hot100") )); then
    echo "FAIL: $label: fillfactor 90 did not add HOT updates ($hot90 vs $hot100)" >&2
    exit 1
  fi
  echo "ok: $label: with fillfactor 90 board-like updates get more HOT updates"

  # ── 7: rollback and re-apply ──
  psql_db "${prefix}_rolled" -q -f "$migration"
  psql_db "${prefix}_rolled" -q -f "$rollback"
  assert_equal "$label: the rollback restores empty reloptions" "<empty>|$own_shape" "$(reloptions "${prefix}_rolled" "$table")|$(shape "${prefix}_rolled" "$table")"
  psql_db "${prefix}_rolled" -q -f "$rollback"
  assert_equal "$label: a second rollback run changes nothing" "<empty>" "$(reloptions "${prefix}_rolled" "$table")"
  psql_db "${prefix}_rolled" -q -f "$migration"
  assert_equal "$label: the migration applies again after the rollback" "{fillfactor=90}" "$(reloptions "${prefix}_rolled" "$table")"
}

prove_one "trader_stats" trader_stats "$STATS_MIGRATION" "$STATS_ROLLBACK" "$STATS_SHAPE" traders "$TRADERS_SHAPE" stats
prove_one "traders" traders "$TRADERS_MIGRATION" "$TRADERS_ROLLBACK" "$TRADERS_SHAPE" trader_stats "$STATS_SHAPE" traders

# ── 4: a partitioned table and a partition are refused ──
psql_db partitioned -q <<'SQL'
ALTER TABLE arena.trader_stats RENAME TO trader_stats_plain;
CREATE TABLE arena.trader_stats (trader_id bigint, timeframe smallint) PARTITION BY LIST (timeframe);
ALTER TABLE arena.traders RENAME TO traders_plain;
CREATE TABLE arena.traders_parent (id bigint, source_id smallint) PARTITION BY LIST (source_id);
CREATE TABLE arena.traders PARTITION OF arena.traders_parent FOR VALUES IN (1);
SQL
for pair in "trader_stats|$STATS_MIGRATION|a partitioned trader_stats" "traders|$TRADERS_MIGRATION|a traders partition"; do
  IFS='|' read -r table migration what <<<"$pair"
  if psql_db partitioned -q -f "$migration" >"$ERROR_FILE" 2>&1; then
    echo "FAIL: $what was accepted" >&2
    exit 1
  fi
  grep -q "is not a plain, unpartitioned table" "$ERROR_FILE" || { cat "$ERROR_FILE" >&2; exit 1; }
  assert_equal "$what is refused and left unchanged" "<empty>" "$(reloptions partitioned "$table")"
done

# ── 8: both, in either order ──
psql_db both_ab -q -f "$STATS_MIGRATION"
psql_db both_ab -q -f "$TRADERS_MIGRATION"
psql_db both_ba -q -f "$TRADERS_MIGRATION"
psql_db both_ba -q -f "$STATS_MIGRATION"
for db in both_ab both_ba; do
  assert_equal "$db: both tables have fillfactor=90 and are otherwise unchanged" \
    "{fillfactor=90}|$STATS_SHAPE|{fillfactor=90}|$TRADERS_SHAPE" \
    "$(reloptions "$db" trader_stats)|$(shape "$db" trader_stats)|$(reloptions "$db" traders)|$(shape "$db" traders)"
done

echo "trader_stats / traders fillfactor 90 PostgreSQL 17 proof passed"
