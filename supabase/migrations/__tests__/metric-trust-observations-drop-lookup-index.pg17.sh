#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for
# 20261127201511_metric_trust_observations_drop_lookup_index.sql. It owns an
# isolated temporary cluster and never connects to a developer or remote DB.
#
# The table and its indexes come from the real migrations that created them
# (20260721120000, 20261113105605 entry, 20261118135918 source_run), so the
# expected definitions in the migration are checked against what PostgreSQL
# deparses for them.
#
# Proves:
#   1. the migration drops only lookup; the five other indexes stay, valid,
#      with their definitions, and every row stays readable;
#   2. a replay is a no-op;
#   3. a lookup index someone changed is refused and left in place;
#   4. while another transaction holds the table, the migration gives up
#      after lock_timeout (3 s) and changes nothing; a retry succeeds;
#   5. the rollback (autocommit, CREATE INDEX CONCURRENTLY) rebuilds lookup
#      with the 20260721120000 definition, and the migration applies again.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
TARGET="$MIGRATIONS/20261127201511_metric_trust_observations_drop_lookup_index.sql"
ROLLBACK="$ROOT_DIR/scripts/maintenance/rollbacks/20261127201511_metric_trust_observations_drop_lookup_index.rollback.sql"
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

TMP_ROOT="$(mktemp -d /tmp/mto-drop-lookup-index-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
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
"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U supabase_admin --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null

psql_admin -q <<'SQL'
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE BYPASSRLS;
CREATE ROLE anon NOLOGIN NOSUPERUSER;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER;
CREATE ROLE service_role NOLOGIN NOSUPERUSER;
GRANT anon, authenticated, service_role TO postgres;
GRANT CREATE ON DATABASE postgres TO postgres;
ALTER SCHEMA public OWNER TO postgres;
SQL
if [[ "$(psql_db postgres -Atqc "SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user")" != "f" ]]; then
  echo "migrations must run as a non-superuser postgres role" >&2
  exit 1
fi

# Base tables as the 20260610/20260721 foundations shape them; the bitget rows
# are the 20260610223356 seed rows (adapter, windows, currency, page_size).
psql_db postgres -q <<'SQL'
CREATE SCHEMA arena;

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  adapter_slug text NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL,
  currency text NOT NULL CHECK (currency IN ('USDT', 'USDx', 'USDC', 'USD')),
  product_type text NOT NULL,
  fetch_region text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}',
  timeframes_native integer[] NOT NULL DEFAULT '{}',
  timeframes_derived integer[] NOT NULL DEFAULT '{}',
  page_size int
);
CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL,
  nickname text,
  avatar_url_mirror text,
  avatar_url_origin text,
  trader_kind text NOT NULL DEFAULT 'human'
);
CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL,
  actual_count int NOT NULL,
  count_check_passed boolean NOT NULL,
  is_derived boolean NOT NULL DEFAULT false,
  raw_object_id bigint
);
CREATE TABLE arena.leaderboard_entries (
  scraped_at timestamptz NOT NULL,
  snapshot_id bigint NOT NULL,
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  timeframe smallint NOT NULL,
  rank int NOT NULL,
  currency text NOT NULL,
  PRIMARY KEY (scraped_at, snapshot_id, trader_id)
);
CREATE TABLE arena.raw_objects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  job_type text NOT NULL,
  trader_id bigint,
  timeframe smallint,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  storage_path text NOT NULL UNIQUE,
  bytes int NOT NULL,
  content_hash text NOT NULL,
  quarantined boolean NOT NULL DEFAULT false,
  meta jsonb NOT NULL DEFAULT '{}'
);
INSERT INTO arena.sources (
  id, slug, adapter_slug, status, serving_mode, currency, product_type,
  fetch_region, timeframes_native, page_size
) VALUES
  (1, 'binance_futures', 'binance', 'active', 'serving', 'USDT', 'futures', 'local', '{7,30,90}', 30),
  (2, 'binance_web3_bsc', 'binance_web3', 'active', 'serving', 'USDT', 'onchain', 'local', '{7,30,90}', 24),
  (3, 'bitget_futures', 'bitget', 'active', 'serving', 'USDT', 'futures', 'local', '{7,30,90}', 30),
  (4, 'bitget_spot', 'bitget', 'active', 'serving', 'USDT', 'spot', 'local', '{7,30,90}', 30),
  (5, 'bitget_cfd', 'bitget', 'active', 'serving', 'USDT', 'cfd', 'local', '{7,30,90}', 30);
GRANT USAGE ON SCHEMA arena TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA arena TO service_role;
SQL

psql_db postgres -q -f "$MIGRATIONS/20260721120000_metric_trust_shadow_gate.sql" >/dev/null
# The two later indexes, verbatim from 20261113105605 and 20261118135918.
psql_db postgres -q <<'SQL'
CREATE INDEX IF NOT EXISTS idx_arena_metric_trust_observations_entry
  ON arena.metric_trust_observations (snapshot_id, trader_id, snapshot_scraped_at);
CREATE INDEX IF NOT EXISTS idx_arena_metric_trust_observations_source_run
  ON arena.metric_trust_observations (source_run_id, id);
SQL

index_inventory() {
  psql_db "$1" -Atqc "
    SELECT pg_catalog.string_agg(
             c.relname || '|' || i.indisvalid::text || '|' || pg_catalog.pg_get_indexdef(c.oid),
             E'\n' ORDER BY c.relname)
      FROM pg_catalog.pg_index AS i
      JOIN pg_catalog.pg_class AS c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'arena.metric_trust_observations'::regclass"
}

KEPT="$(index_inventory postgres | grep -v '^idx_arena_metric_trust_observations_lookup|')"
assert_equal "the fixture has the six production indexes" "6" "$(index_inventory postgres | wc -l | tr -d ' ')"
assert_equal "lookup deparses exactly as production reports it" \
  "idx_arena_metric_trust_observations_lookup|true|CREATE INDEX idx_arena_metric_trust_observations_lookup ON arena.metric_trust_observations USING btree (source_id, timeframe, metric, trader_id, source_as_of DESC)" \
  "$(index_inventory postgres | grep '^idx_arena_metric_trust_observations_lookup|')"

for db in main changed locked rolled; do
  clone_db postgres "$db"
done

# ── 1, 2: drop and replay ──
psql_db main -q -f "$TARGET"
assert_equal "only lookup is dropped; the five others stay valid and unchanged" "$KEPT" "$(index_inventory main)"
psql_db main -q -f "$TARGET"
assert_equal "a replay changes nothing" "$KEPT" "$(index_inventory main)"

# ── 3: an index someone changed ──
psql_db changed -q <<'SQL'
DROP INDEX arena.idx_arena_metric_trust_observations_lookup;
CREATE INDEX idx_arena_metric_trust_observations_lookup
  ON arena.metric_trust_observations (source_id, timeframe, metric, trader_id);
SQL
CHANGED_BEFORE="$(index_inventory changed)"
if psql_db changed -q -f "$TARGET" >"$ERROR_FILE" 2>&1; then
  echo "FAIL: a changed lookup index was dropped" >&2
  exit 1
fi
grep -q "is not the expected definition" "$ERROR_FILE" || { cat "$ERROR_FILE" >&2; exit 1; }
assert_equal "a changed lookup index is refused and left in place" "$CHANGED_BEFORE" "$(index_inventory changed)"

# ── 4: lock_timeout while a publication holds the table ──
LOCKED_BEFORE="$(index_inventory locked)"
psql_db locked -q -c "BEGIN; LOCK TABLE arena.metric_trust_observations IN ROW EXCLUSIVE MODE; SELECT pg_catalog.pg_sleep(8); COMMIT;" >/dev/null &
HOLDER=$!
sleep 1
started=$(date +%s)
if psql_db locked -q -f "$TARGET" >"$ERROR_FILE" 2>&1; then
  echo "FAIL: the migration did not wait for the lock" >&2
  exit 1
fi
elapsed=$(( $(date +%s) - started ))
grep -q "lock timeout" "$ERROR_FILE" || { cat "$ERROR_FILE" >&2; exit 1; }
(( elapsed <= 5 )) || { echo "FAIL: gave up only after ${elapsed}s" >&2; exit 1; }
assert_equal "a held table makes the migration give up after lock_timeout and change nothing" \
  "$LOCKED_BEFORE" "$(index_inventory locked)"
wait "$HOLDER"
psql_db locked -q -f "$TARGET"
assert_equal "a retry after the publication succeeds" "$KEPT" "$(index_inventory locked)"

# ── 5: rollback and re-apply ──
psql_db rolled -q -f "$TARGET"
ROLLED_FULL="$(index_inventory postgres)"
psql_db rolled -q -f "$ROLLBACK"
assert_equal "the rollback rebuilds lookup with the 20260721120000 definition" "$ROLLED_FULL" "$(index_inventory rolled)"
psql_db rolled -q -f "$ROLLBACK"
assert_equal "a second rollback run changes nothing" "$ROLLED_FULL" "$(index_inventory rolled)"
psql_db rolled -q -f "$TARGET"
assert_equal "the migration applies again after the rollback" "$KEPT" "$(index_inventory rolled)"

echo "metric_trust_observations drop lookup index PostgreSQL 17 proof passed"
