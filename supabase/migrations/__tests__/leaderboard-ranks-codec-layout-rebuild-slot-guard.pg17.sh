#!/usr/bin/env bash

# PostgreSQL 17 proof for the launch-slot guard of
# 20261111140053_leaderboard_ranks_codec_layout_rebuild.sql.
#
# File-name-order replay reaches this repair after 20260725016500 /
# 20260816184500 have already run. The guard must refuse with an explicit
# launch-slot error (never fall through and rebuild the table without the
# season mutation fence triggers). In its launch slot the guard must stay
# silent, so the next failure is the ordinary reviewed-state preflight.
#
# Isolated cluster on a private socket; never connects to application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20261111140053_leaderboard_ranks_codec_layout_rebuild.sql"
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

TMP_ROOT="$(mktemp -d /tmp/codec-rebuild-slot-guard-pg17.XXXXXX)"
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
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_db() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d "$1" "${@:2}"
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

fixture_db() {
  psql_db "$1" -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS arena;
CREATE TABLE public.leaderboard_ranks (
  id bigint, season_id text NOT NULL, source text, source_trader_id text
) PARTITION BY LIST (season_id);
CREATE FUNCTION arena.noop_fence() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN RETURN NULL; END $$;
SQL
}

expect_failure() {
  local database="$1" pattern="$2" label="$3" output
  if output="$(psql_db "$database" -f "$MIGRATION" 2>&1)"; then
    echo "$label: migration unexpectedly succeeded" >&2
    exit 1
  fi
  if ! grep -q "$pattern" <<<"$output"; then
    echo "$label: expected /$pattern/, got:" >&2
    echo "$output" >&2
    exit 1
  fi
  echo "ok - $label"
}

# Roles are cluster-wide: create them once.
psql_db postgres -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
SQL

# 1. File-name-order replay after 20260816184500: season fence triggers exist.
psql_db postgres -q -c 'CREATE DATABASE after_season_fence'
fixture_db after_season_fence
psql_db after_season_fence -q <<'SQL'
CREATE TRIGGER leaderboard_rank_season_insert_fence
  AFTER INSERT ON public.leaderboard_ranks
  FOR EACH STATEMENT EXECUTE FUNCTION arena.noop_fence();
SQL
expect_failure after_season_fence 'out of its launch slot' \
  'refuses a replay that already has the season fence triggers'
remaining="$(psql_db after_season_fence -XAtq -c "SELECT count(*) FROM pg_trigger WHERE tgname = 'leaderboard_rank_season_insert_fence'")"
[[ "$remaining" == 1 ]] || { echo 'season fence trigger was dropped' >&2; exit 1; }
echo 'ok - season fence trigger is untouched after the refusal'

# 2. File-name-order replay after 20260725016500: codec encoder exists.
psql_db postgres -q -c 'CREATE DATABASE after_codec'
fixture_db after_codec
psql_db after_codec -q <<'SQL'
CREATE FUNCTION arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks)
RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
SQL
expect_failure after_codec 'out of its launch slot' \
  'refuses a replay that already has the persisted codec'

# 3. In its launch slot the guard is silent; the reviewed-state preflight runs.
psql_db postgres -q -c 'CREATE DATABASE in_slot'
fixture_db in_slot
output="$(psql_db in_slot -f "$MIGRATION" 2>&1 || true)"
if grep -q 'out of its launch slot' <<<"$output"; then
  echo 'in-slot database tripped the launch-slot guard' >&2
  exit 1
fi
grep -q 'requires the reviewed parent table state' <<<"$output" || {
  echo "in-slot database did not reach the reviewed-state preflight:" >&2
  echo "$output" >&2
  exit 1
}
echo 'ok - in-slot database passes the guard and reaches the reviewed-state preflight'
