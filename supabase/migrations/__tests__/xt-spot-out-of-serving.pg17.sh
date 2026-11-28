#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261127094031: xt_spot leaves collection and
# serving (status inactive, serving_mode shadow), and nothing else changes.
#
#   + from active/serving, xt_spot becomes inactive/shadow; it leaves the
#     scheduler's active set (status = 'active') and the serving names
#     (public.arena_serving_sources, the Redis mirror's twin query)
#   = other sources, including xt_futures, are unchanged
#   + the real arena.sources guards are installed: the update is accepted;
#     the Tier-A transition guard would refuse it inside a transaction that
#     holds an execution write guard for xt_spot
#   - a state someone else set (active/shadow) is refused, not overwritten
#   = a replay changes nothing
# The migration is applied by a non-superuser owner. Isolated cluster on a
# private socket; never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
GUARD_MIGRATION="$MIGRATIONS/20261111192134_tier_a_execution_claim_enforcement_later_raw_guards.sql"
NAME_GUARD_MIGRATION="$MIGRATIONS/20261122204058_resolve_trader_public_source.sql"
SERVING_RPC_MIGRATION="$MIGRATIONS/20260615125511_arena_serving_sources_rpc.sql"
NEW_MIGRATION="$MIGRATIONS/20261127094031_xt_spot_out_of_serving.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/xt-spot-out-of-serving-pg17.XXXXXX)"
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

psql_as() {
  local role="$1"
  shift
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U "$role" -d postgres "$@"
}

assert_equal() {
  if [[ "$2" != "$3" ]]; then
    echo "$1: expected '$2', got '$3'" >&2
    exit 1
  fi
  echo "ok: $1"
}

# Prints the statement of a migration that starts with the line $2 through
# the first following line equal to $3.
statement_of() {
  FIRST_LINE="$2" LAST_LINE="$3" awk '
    !printing && index($0, ENVIRON["FIRST_LINE"]) == 1 { printing = 1 }
    printing { print }
    printing && $0 == ENVIRON["LAST_LINE"] { exit }
  ' "$1"
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U bootstrap --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

psql_as bootstrap -q <<'SQL'
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE;
CREATE ROLE anon NOSUPERUSER;
CREATE ROLE authenticated NOSUPERUSER;
CREATE ROLE service_role NOSUPERUSER;
GRANT CREATE ON DATABASE postgres TO postgres;
ALTER SCHEMA public OWNER TO postgres;
SQL

psql_as postgres -q <<'SQL'
CREATE SCHEMA arena;
CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  fetch_region text NOT NULL DEFAULT 'local',
  serving_mode text NOT NULL CHECK (serving_mode IN ('legacy', 'shadow', 'serving')),
  status text NOT NULL CHECK (status IN ('active', 'inactive', 'blocked_pending_vps', 'dropped')),
  meta jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE arena.tier_a_execution_write_guards (
  top_xid8_text text NOT NULL,
  source_id smallint NOT NULL
);
INSERT INTO arena.sources (id, slug, serving_mode, status, meta) VALUES
  (1, 'xt_spot', 'serving', 'active', '{}'),
  (2, 'xt_futures', 'serving', 'active', '{"legacy_platform": "xt"}'),
  (3, 'gate_cfd', 'serving', 'active', '{}'),
  (4, 'okx_old', 'shadow', 'inactive', '{}');
SQL

# The real guards on arena.sources and the serving-names RPC.
{
  statement_of "$GUARD_MIGRATION" \
    'CREATE OR REPLACE FUNCTION arena.reject_guarded_tier_a_source_transition()' '$function$;'
  echo 'CREATE TRIGGER sources_reject_guarded_tier_a_transition AFTER UPDATE ON arena.sources'
  echo '  FOR EACH ROW EXECUTE FUNCTION arena.reject_guarded_tier_a_source_transition();'
  statement_of "$NAME_GUARD_MIGRATION" \
    'CREATE FUNCTION arena.reject_ambiguous_serving_source_name()' '$function$;'
  statement_of "$NAME_GUARD_MIGRATION" \
    'CREATE TRIGGER sources_reject_ambiguous_serving_name' \
    'FOR EACH ROW EXECUTE FUNCTION arena.reject_ambiguous_serving_source_name();'
  statement_of "$SERVING_RPC_MIGRATION" \
    'CREATE OR REPLACE FUNCTION public.arena_serving_sources()' '$$;'
} >"$TMP_ROOT/guards.sql"
psql_as postgres -q -f "$TMP_ROOT/guards.sql"
assert_equal "both arena.sources guards and the serving-names RPC are installed" "2:1" \
  "$(psql_as postgres -Atqc "
     SELECT (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'arena.sources'::regclass AND NOT tgisinternal)
            || ':' || (SELECT count(*) FROM pg_proc WHERE proname = 'arena_serving_sources')")"

state() {
  psql_as postgres -Atqc "
    SELECT string_agg(slug || ':' || status || '/' || serving_mode, ' ' ORDER BY id) FROM arena.sources"
}
active_sources() {
  # The scheduler's selection (lib/ingest/sources.ts getActiveSources).
  psql_as postgres -Atqc "
    SELECT string_agg(slug, ',' ORDER BY slug) FROM arena.sources WHERE status = 'active'"
}
serving_names() {
  psql_as postgres -Atqc "SELECT array_to_string(public.arena_serving_sources(), ',')"
}

assert_equal "before: the fixture" \
  "xt_spot:active/serving xt_futures:active/serving gate_cfd:active/serving okx_old:inactive/shadow" \
  "$(state)"
assert_equal "before: xt_spot is scheduled" "gate_cfd,xt_futures,xt_spot" "$(active_sources)"
assert_equal "before: xt_spot is a serving name" "gate_cfd,xt,xt_futures,xt_spot" "$(serving_names)"

# Inside a transaction that holds an execution write guard for xt_spot, the
# Tier-A transition guard refuses the status change (the migration holds none).
if psql_as postgres -q -c "BEGIN;
    INSERT INTO arena.tier_a_execution_write_guards
      VALUES (pg_catalog.pg_current_xact_id()::text, 1);
    UPDATE arena.sources SET status = 'inactive', serving_mode = 'shadow' WHERE slug = 'xt_spot';
    COMMIT;" 2>"$TMP_ROOT/guarded.err"; then
  echo "the Tier-A transition guard let a guarded status change through" >&2
  exit 1
fi
grep -q 'guarded Tier-A source authority cannot change before COMMIT' "$TMP_ROOT/guarded.err"
echo "ok: the real transition guard refuses the change inside a guarded Tier-A transaction"

psql_as postgres -q -f "$NEW_MIGRATION" 2>"$TMP_ROOT/apply.err" >/dev/null
grep -q 'xt_spot out of serving: 1 row(s) updated' "$TMP_ROOT/apply.err"
echo "ok: the migration updated one row"

assert_equal "after: xt_spot inactive/shadow, everything else unchanged" \
  "xt_spot:inactive/shadow xt_futures:active/serving gate_cfd:active/serving okx_old:inactive/shadow" \
  "$(state)"
assert_equal "after: xt_spot is no longer scheduled" "gate_cfd,xt_futures" "$(active_sources)"
assert_equal "after: xt_spot is no longer a serving name" "gate_cfd,xt,xt_futures" "$(serving_names)"

psql_as postgres -q -f "$NEW_MIGRATION" 2>"$TMP_ROOT/replay.err" >/dev/null
grep -q 'xt_spot out of serving: 0 row(s) updated' "$TMP_ROOT/replay.err"
assert_equal "a replay changes nothing" \
  "xt_spot:inactive/shadow xt_futures:active/serving gate_cfd:active/serving okx_old:inactive/shadow" \
  "$(state)"

# A state someone else set is refused, not overwritten.
psql_as postgres -q -c "UPDATE arena.sources SET status = 'active' WHERE slug = 'xt_spot'"
if psql_as postgres -q -f "$NEW_MIGRATION" 2>"$TMP_ROOT/refused.err" >/dev/null; then
  echo "the migration overwrote an active/shadow xt_spot" >&2
  exit 1
fi
grep -q 'xt_spot is status active / serving_mode shadow, not active/serving; refusing' "$TMP_ROOT/refused.err"
assert_equal "a refused run leaves the row as it was" "active/shadow" \
  "$(psql_as postgres -Atqc "SELECT status || '/' || serving_mode FROM arena.sources WHERE slug = 'xt_spot'")"

echo "xt_spot out of serving PostgreSQL 17 proof passed"
