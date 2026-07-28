#!/usr/bin/env bash

# Disposable PostgreSQL 17 proof for the inert ingest-worker fence substrate.
# This exercises real concurrent sessions; static SQL assertions cannot prove
# transaction advisory-lock ordering or stale-owner rejection after a waiter.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260725011000_durable_ingest_worker_fence_substrate.sql"
PREDECESSOR="$ROOT_DIR/supabase/migrations/20260722055000_metric_trust_source_page_lineage_forward_repair.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/durable-ingest-worker-fence-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((61000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  local child
  for child in $(jobs -pr); do
    kill "$child" >/dev/null 2>&1 || true
  done
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -200 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

fail() {
  echo "durable ingest-worker fence PG17 failure: $*" >&2
  exit 1
}

assert_query() {
  local description="$1"
  local expected="$2"
  local sql="$3"
  local observed
  observed="$(psql_cmd -qAt -c "$sql")"
  [[ "$observed" == "$expected" ]] ||
    fail "$description (expected '$expected', observed '$observed')"
}

expect_failure() {
  local description="$1"
  local sql="$2"
  local pattern="$3"
  if psql_cmd -qAt -c "$sql" >"$ERROR_FILE" 2>&1; then
    fail "$description unexpectedly succeeded"
  fi
  grep -Eq "$pattern" "$ERROR_FILE" || {
    cat "$ERROR_FILE" >&2
    fail "$description failed for the wrong reason"
  }
}

expect_sqlstate_failure() {
  local description="$1"
  local sql="$2"
  local sqlstate="$3"
  local pattern="$4"
  if psql_cmd -v VERBOSITY=verbose -qAt -c "$sql" >"$ERROR_FILE" 2>&1; then
    fail "$description unexpectedly succeeded"
  fi
  grep -Eq "$sqlstate:.*$pattern" "$ERROR_FILE" || {
    cat "$ERROR_FILE" >&2
    fail "$description failed with the wrong SQLSTATE or message"
  }
}

wait_for_activity() {
  local application_name="$1"
  local predicate="$2"
  local description="$3"
  local attempt
  for attempt in $(seq 1 160); do
    if [[ "$(psql_cmd -qAt -c "
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_stat_activity
      WHERE application_name = '$application_name' AND ($predicate)
    ")" == '1' ]]; then
      return 0
    fi
    sleep 0.05
  done
  psql_cmd -q -x -c "
    SELECT application_name, state, wait_event_type, wait_event, query
    FROM pg_catalog.pg_stat_activity
    WHERE application_name = '$application_name'
  " >&2 || true
  fail "$description"
}

TOKEN_A="$(printf 'a%.0s' {1..64})"
TOKEN_B="$(printf 'b%.0s' {1..64})"
TOKEN_C="$(printf 'c%.0s' {1..64})"
TOKEN_D="$(printf 'd%.0s' {1..64})"
TOKEN_E="$(printf 'e%.0s' {1..64})"
TOKEN_F="$(printf 'f%.0s' {1..64})"
RELEASE="$(printf '1%.0s' {1..64})"
SHA="$(printf '2%.0s' {1..40})"
SCOPE='region:local'
REGION='local'
NODE='mac-mini'
INSTANCE_A='11111111-1111-4111-8111-111111111111'
INSTANCE_B='22222222-2222-4222-8222-222222222222'
INSTANCE_C='33333333-3333-4333-8333-333333333333'
INSTANCE_D='44444444-4444-4444-8444-444444444444'
INSTANCE_E='55555555-5555-4555-8555-555555555555'
INSTANCE_F='66666666-6666-4666-8666-666666666666'

activate_sql() {
  local instance="$1" token="$2" control_epoch="$3" server_time="$4"
  printf "arena.activate_ingest_worker_authority('%s','%s','%s','%s','%s',%s,%s,'%s','%s')" \
    "$SCOPE" "$REGION" "$NODE" "$instance" "$token" "$control_epoch" "$server_time" \
    "$RELEASE" "$SHA"
}

renew_sql() {
  local instance="$1" token="$2" control_epoch="$3" server_time="$4" db_epoch="$5"
  printf "arena.renew_ingest_worker_authority('%s','%s','%s','%s','%s',%s,%s,%s)" \
    "$SCOPE" "$REGION" "$NODE" "$instance" "$token" "$control_epoch" "$server_time" \
    "$db_epoch"
}

release_sql() {
  local instance="$1" token="$2" control_epoch="$3" db_epoch="$4"
  printf "arena.release_ingest_worker_authority('%s','%s','%s','%s','%s',%s,%s)" \
    "$SCOPE" "$REGION" "$NODE" "$instance" "$token" "$control_epoch" "$db_epoch"
}

begin_write_sql() {
  local instance="$1" token="$2" control_epoch="$3" db_epoch="$4"
  printf "arena.begin_ingest_worker_fenced_write('%s','%s','%s','%s','%s',%s,%s)" \
    "$SCOPE" "$REGION" "$NODE" "$instance" "$token" "$control_epoch" "$db_epoch"
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  -U postgres \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses= -c deadlock_timeout=100ms" \
  -w start >/dev/null

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA arena AUTHORIZATION postgres;
CREATE SCHEMA extensions AUTHORIZATION postgres;
CREATE SCHEMA supabase_migrations AUTHORIZATION postgres;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE TABLE supabase_migrations.schema_migrations (
  version text NOT NULL,
  statements text[] NOT NULL,
  name text NOT NULL
);
CREATE FUNCTION public.arena_metric_trust_release_readiness()
RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"ready":true}'::jsonb $$;
CREATE ROLE hostile_default_grantee NOLOGIN;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA arena
  GRANT ALL PRIVILEGES ON TABLES TO hostile_default_grantee;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA arena
  GRANT ALL PRIVILEGES ON SEQUENCES TO hostile_default_grantee;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA arena
  GRANT ALL PRIVILEGES ON FUNCTIONS TO hostile_default_grantee;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL PRIVILEGES ON FUNCTIONS TO hostile_default_grantee;
SQL

{
  printf '%s' \
    "INSERT INTO supabase_migrations.schema_migrations(version, statements, name) " \
    "VALUES ('20260722055000', ARRAY[\$ingest_fence_055\$"
  perl -0pe '' "$PREDECESSOR"
  printf '%s\n' "\$ingest_fence_055\$], 'metric_trust_source_page_lineage_forward_repair');"
} | psql_cmd -q

psql_cmd -q -f "$MIGRATION"

# Supabase records the exact migration body immediately after apply_migration
# commits. Mirror that external ledger step before exercising release readiness.
{
  printf '%s' \
    "INSERT INTO supabase_migrations.schema_migrations(version, statements, name) " \
    "VALUES ('20260725011000', ARRAY[\$ingest_fence_current\$"
  perl -0pe '' "$MIGRATION"
  printf '%s\n' "\$ingest_fence_current\$], 'durable_ingest_worker_fence_substrate');"
} | psql_cmd -q

assert_query 'substrate readiness' 'true' \
  "SELECT public.arena_ingest_worker_fence_release_readiness()->>'ready'"
assert_query 'only the internal deferred trigger is installed' '1' "
  SELECT pg_catalog.count(*)
  FROM pg_catalog.pg_trigger
  WHERE NOT tgisinternal
"
assert_query 'both authority scopes are pre-registered' 'region:local,region:vps_sg' "
  SELECT pg_catalog.string_agg(authority_scope, ',' ORDER BY authority_scope)
  FROM arena.ingest_worker_authorities
"
assert_query 'hostile default relation ACLs are converged, including sequence privileges' 'f' "
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation_row.relacl,
        pg_catalog.acldefault(
          (CASE WHEN relation_row.relkind = 'S' THEN 'S' ELSE 'r' END)::pg_catalog.\"char\",
          relation_row.relowner
        )
      )
    ) AS privilege_row
    WHERE relation_row.oid = ANY (ARRAY[
      'arena.ingest_worker_fence_epoch_seq'::pg_catalog.regclass,
      'arena.ingest_worker_instances'::pg_catalog.regclass,
      'arena.ingest_worker_authorities'::pg_catalog.regclass,
      'arena.ingest_worker_activations'::pg_catalog.regclass,
      'arena.ingest_worker_write_guards'::pg_catalog.regclass
    ]::oid[])
      AND privilege_row.grantee = pg_catalog.to_regrole('hostile_default_grantee')
  )
"
assert_query 'hostile default function ACLs are converged' 'f' "
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS privilege_row
    WHERE function_row.oid = ANY (ARRAY[
      pg_catalog.to_regprocedure('arena.activate_ingest_worker_authority(text,text,text,uuid,text,bigint,bigint,text,text)'),
      pg_catalog.to_regprocedure('arena.renew_ingest_worker_authority(text,text,text,uuid,text,bigint,bigint,bigint)'),
      pg_catalog.to_regprocedure('arena.release_ingest_worker_authority(text,text,text,uuid,text,bigint,bigint)'),
      pg_catalog.to_regprocedure('arena.begin_ingest_worker_fenced_write(text,text,text,uuid,text,bigint,bigint)'),
      pg_catalog.to_regprocedure('arena.assert_ingest_worker_fence_at_commit()'),
      pg_catalog.to_regprocedure('public.arena_ingest_worker_fence_release_readiness()')
    ]::oid[])
      AND privilege_row.grantee = pg_catalog.to_regrole('hostile_default_grantee')
  )
"

# Readiness is an independent catalog attestation, not just an existence check.
psql_cmd -q -c \
  'ALTER SEQUENCE arena.ingest_worker_fence_epoch_seq SET UNLOGGED'
assert_query 'unlogged epoch allocator fails readiness' 'false' \
  "SELECT public.arena_ingest_worker_fence_release_readiness()->>'ready'"
psql_cmd -q -c \
  'ALTER SEQUENCE arena.ingest_worker_fence_epoch_seq SET LOGGED'

psql_cmd -q -c \
  'ALTER TABLE arena.ingest_worker_write_guards SET UNLOGGED'
assert_query 'unlogged guard relation fails readiness' 'false' \
  "SELECT public.arena_ingest_worker_fence_release_readiness()->>'ready'"
psql_cmd -q -c \
  'ALTER TABLE arena.ingest_worker_write_guards SET LOGGED'

psql_cmd -q -c "
  ALTER SEQUENCE arena.ingest_worker_fence_epoch_seq
    INCREMENT BY 7 CACHE 9 CYCLE
"
assert_query 'sequence parameter drift fails readiness' 'false' \
  "SELECT public.arena_ingest_worker_fence_release_readiness()->>'ready'"
psql_cmd -q -c "
  ALTER SEQUENCE arena.ingest_worker_fence_epoch_seq
    INCREMENT BY 1 CACHE 1 NO CYCLE
"

psql_cmd -q <<'SQL'
ALTER FUNCTION arena.activate_ingest_worker_authority(
  text, text, text, uuid, text, bigint, bigint, text, text
) STABLE;
ALTER FUNCTION arena.activate_ingest_worker_authority(
  text, text, text, uuid, text, bigint, bigint, text, text
) PARALLEL SAFE;
ALTER FUNCTION arena.activate_ingest_worker_authority(
  text, text, text, uuid, text, bigint, bigint, text, text
) STRICT;
ALTER FUNCTION arena.activate_ingest_worker_authority(
  text, text, text, uuid, text, bigint, bigint, text, text
) RESET ALL;
SQL
assert_query 'function execution-contract drift fails readiness' 'false' \
  "SELECT public.arena_ingest_worker_fence_release_readiness()->>'ready'"
psql_cmd -q <<'SQL'
ALTER FUNCTION arena.activate_ingest_worker_authority(
  text, text, text, uuid, text, bigint, bigint, text, text
) VOLATILE;
ALTER FUNCTION arena.activate_ingest_worker_authority(
  text, text, text, uuid, text, bigint, bigint, text, text
) PARALLEL UNSAFE;
ALTER FUNCTION arena.activate_ingest_worker_authority(
  text, text, text, uuid, text, bigint, bigint, text, text
) CALLED ON NULL INPUT;
ALTER FUNCTION arena.activate_ingest_worker_authority(
  text, text, text, uuid, text, bigint, bigint, text, text
) SET search_path TO pg_catalog, pg_temp;
ALTER FUNCTION arena.activate_ingest_worker_authority(
  text, text, text, uuid, text, bigint, bigint, text, text
) SET "TimeZone" TO 'UTC';
ALTER FUNCTION arena.activate_ingest_worker_authority(
  text, text, text, uuid, text, bigint, bigint, text, text
) SET lock_timeout TO '5s';
ALTER FUNCTION arena.activate_ingest_worker_authority(
  text, text, text, uuid, text, bigint, bigint, text, text
) SET statement_timeout TO '30s';
SQL

psql_cmd -q <<'SQL'
CREATE CONSTRAINT TRIGGER ingest_worker_fence_commit_assertion_duplicate
AFTER INSERT ON arena.ingest_worker_write_guards
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION arena.assert_ingest_worker_fence_at_commit();
SQL
assert_query 'a second guard trigger fails readiness' 'false' \
  "SELECT public.arena_ingest_worker_fence_release_readiness()->>'ready'"
psql_cmd -q -c "
  DROP TRIGGER ingest_worker_fence_commit_assertion_duplicate
    ON arena.ingest_worker_write_guards
"

psql_cmd -q <<'SQL'
DROP TRIGGER ingest_worker_fence_commit_assertion
  ON arena.ingest_worker_write_guards;
CREATE CONSTRAINT TRIGGER ingest_worker_fence_commit_assertion
AFTER UPDATE ON arena.ingest_worker_write_guards
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION arena.assert_ingest_worker_fence_at_commit();
SQL
assert_query 'guard trigger event drift fails readiness' 'false' \
  "SELECT public.arena_ingest_worker_fence_release_readiness()->>'ready'"
psql_cmd -q <<'SQL'
DROP TRIGGER ingest_worker_fence_commit_assertion
  ON arena.ingest_worker_write_guards;
CREATE CONSTRAINT TRIGGER ingest_worker_fence_commit_assertion
AFTER INSERT ON arena.ingest_worker_write_guards
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION arena.assert_ingest_worker_fence_at_commit();
SQL
assert_query 'restored exact catalog contract is ready' 'true' \
  "SELECT public.arena_ingest_worker_fence_release_readiness()->>'ready'"

psql_cmd -q -c "
  GRANT EXECUTE
  ON FUNCTION public.arena_ingest_worker_fence_release_readiness()
  TO service_role WITH GRANT OPTION
"
assert_query 'readiness grant-option drift fails readiness' 'false' \
  "SELECT public.arena_ingest_worker_fence_release_readiness()->>'ready'"
psql_cmd -q -c "
  REVOKE GRANT OPTION FOR EXECUTE
  ON FUNCTION public.arena_ingest_worker_fence_release_readiness()
  FROM service_role
"

psql_cmd -q <<'SQL'
CREATE FUNCTION public.arena_ingest_worker_fence_release_readiness(integer)
RETURNS jsonb
LANGUAGE sql
AS $overload$ SELECT '{"ready":false}'::jsonb $overload$;
SQL
assert_query 'readiness overload drift fails readiness' 'false' \
  "SELECT public.arena_ingest_worker_fence_release_readiness()->>'ready'"
psql_cmd -q -c \
  'DROP FUNCTION public.arena_ingest_worker_fence_release_readiness(integer)'

psql_cmd -q -c "
  UPDATE supabase_migrations.schema_migrations
  SET version = 'wrong-version'
  WHERE name = 'durable_ingest_worker_fence_substrate'
"
assert_query 'wrong release-ledger version fails readiness' 'false' \
  "SELECT public.arena_ingest_worker_fence_release_readiness()->>'ready'"
psql_cmd -q -c "
  UPDATE supabase_migrations.schema_migrations
  SET version = '20260725011000'
  WHERE name = 'durable_ingest_worker_fence_substrate'
"
assert_query 'restored ACL, overload and ledger contract is ready' 'true' \
  "SELECT public.arena_ingest_worker_fence_release_readiness()->>'ready'"

ACTIVATE_A="$(activate_sql "$INSTANCE_A" "$TOKEN_A" 1 1800000000000)"
EPOCH_A="$(psql_cmd -qAt -c "SELECT ($ACTIVATE_A)->>'epoch'")"
[[ "$EPOCH_A" == '1' ]] || fail "first database epoch was not 1 (got $EPOCH_A)"
EXPIRY_A="$(psql_cmd -qAt -c "SELECT lease_expires_at::text FROM arena.ingest_worker_authorities WHERE authority_scope='$SCOPE'")"
REPLAY_EXPIRY_A="$(psql_cmd -qAt -c "SELECT ($ACTIVATE_A)->>'lease_expires_at'")"
assert_query 'activation exact replay does not extend its lease' "$EXPIRY_A" "
  SELECT lease_expires_at::text
  FROM arena.ingest_worker_authorities
  WHERE authority_scope = '$SCOPE'
"
[[ -n "$REPLAY_EXPIRY_A" ]] || fail 'activation replay returned no expiry'

expect_failure 'live contender' \
  "SELECT $(activate_sql "$INSTANCE_B" "$TOKEN_B" 2 1800000001000)" \
  'already has a live owner|55P03'
expect_failure 'same control epoch with another identity' \
  "SELECT $(activate_sql "$INSTANCE_B" "$TOKEN_B" 1 1800000001000)" \
  'control epoch|stale|conflict|55000'
expect_failure 'repeatable-read activation' \
  "BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT $ACTIVATE_A; COMMIT" \
  'READ COMMITTED|read committed|55000'

RENEW_A="$(renew_sql "$INSTANCE_A" "$TOKEN_A" 1 1800000001000 "$EPOCH_A")"
psql_cmd -qAt -c "SELECT $RENEW_A" >/dev/null
RENEWED_EXPIRY="$(psql_cmd -qAt -c "SELECT lease_expires_at::text FROM arena.ingest_worker_authorities WHERE authority_scope='$SCOPE'")"
psql_cmd -qAt -c "SELECT $RENEW_A" >/dev/null
assert_query 'renew exact replay does not extend its lease' "$RENEWED_EXPIRY" "
  SELECT lease_expires_at::text
  FROM arena.ingest_worker_authorities
  WHERE authority_scope = '$SCOPE'
"
expect_failure 'older renewal proof' \
  "SELECT $(renew_sql "$INSTANCE_A" "$TOKEN_A" 1 1800000000500 "$EPOCH_A")" \
  'renewal proof|regressed|stale|fenced|55000'

# Force the proof read to wait on the instances relation while a privileged
# test transaction commits the two mutable rows exactly as a renewal does. A
# legacy three-SELECT implementation has already captured the old authority
# row at this point and then mixes it with the new activation row. The joined
# implementation takes one MVCC snapshot and must authorize the exact owner.
SNAPSHOT_BLOCKER_OUT="$TMP_ROOT/snapshot-blocker.out"
PGAPPNAME='fence-proof-snapshot-blocker' psql_cmd -qAt >"$SNAPSHOT_BLOCKER_OUT" 2>&1 <<'SQL' &
BEGIN;
LOCK TABLE arena.ingest_worker_instances IN ACCESS EXCLUSIVE MODE;
SELECT pg_catalog.pg_sleep(30);
COMMIT;
SQL
SNAPSHOT_BLOCKER_PID=$!
wait_for_activity 'fence-proof-snapshot-blocker' \
  "state = 'active' AND query LIKE '%pg_sleep(30)%'" \
  'proof-snapshot blocker never reached its deterministic hold point'

SNAPSHOT_WRITER_OUT="$TMP_ROOT/snapshot-writer.out"
PGAPPNAME='fence-proof-snapshot-writer' psql_cmd -qAt \
  -c "SELECT $(begin_write_sql "$INSTANCE_A" "$TOKEN_A" 1 "$EPOCH_A")" \
  >"$SNAPSHOT_WRITER_OUT" 2>&1 &
SNAPSHOT_WRITER_PID=$!
wait_for_activity 'fence-proof-snapshot-writer' \
  "wait_event_type = 'Lock' AND wait_event = 'relation'" \
  'proof-snapshot writer did not wait on the instance relation'

psql_cmd -q <<SQL
BEGIN;
UPDATE arena.ingest_worker_authorities
SET active_control_server_time_ms = 1800000001250,
    renewed_at = pg_catalog.date_trunc(
      'milliseconds', pg_catalog.clock_timestamp()
    ),
    lease_expires_at = pg_catalog.date_trunc(
      'milliseconds', pg_catalog.clock_timestamp() + INTERVAL '180 seconds'
    )
WHERE authority_scope = '$SCOPE';
UPDATE arena.ingest_worker_activations
SET control_server_time_ms = 1800000001250,
    last_renewed_at = pg_catalog.date_trunc(
      'milliseconds', pg_catalog.clock_timestamp()
    )
WHERE authority_scope = '$SCOPE'
  AND epoch = $EPOCH_A;
COMMIT;
SQL
assert_query 'proof-snapshot blocker is released deterministically' 't' "
  SELECT pg_catalog.pg_terminate_backend(pid)
  FROM pg_catalog.pg_stat_activity
  WHERE application_name = 'fence-proof-snapshot-blocker'
"
if wait "$SNAPSHOT_BLOCKER_PID"; then
  fail 'proof-snapshot blocker unexpectedly survived termination'
fi
wait "$SNAPSHOT_WRITER_PID" || {
  cat "$SNAPSHOT_WRITER_OUT" >&2
  fail 'valid writer mixed authority and activation snapshot generations'
}
assert_query 'snapshot-race writer guard was deleted at commit' '0' \
  'SELECT pg_catalog.count(*) FROM arena.ingest_worker_write_guards'

# A renewal may strengthen the same owner's proof while an already-authorized
# writer is open. The writer must commit from one consistent MVCC snapshot; it
# must not wait on the renewal's row update and then mix snapshot generations.
RENEW_RACE_WRITER_OUT="$TMP_ROOT/renew-race-writer.out"
PGAPPNAME='fence-renew-race-writer' psql_cmd -qAt >"$RENEW_RACE_WRITER_OUT" 2>&1 <<SQL &
BEGIN;
SELECT $(begin_write_sql "$INSTANCE_A" "$TOKEN_A" 1 "$EPOCH_A");
SELECT pg_catalog.pg_sleep(3);
COMMIT;
SQL
RENEW_RACE_WRITER_PID=$!
wait_for_activity 'fence-renew-race-writer' \
  "state = 'active' AND query LIKE '%pg_sleep(3)%'" \
  'renew-race writer never reached its deterministic hold point'

RENEW_RACE_OUT="$TMP_ROOT/renew-race.out"
PGAPPNAME='fence-concurrent-renew' psql_cmd -qAt >"$RENEW_RACE_OUT" 2>&1 <<SQL &
BEGIN;
SELECT $(renew_sql "$INSTANCE_A" "$TOKEN_A" 1 1800000001500 "$EPOCH_A");
SELECT pg_catalog.pg_sleep(6);
COMMIT;
SQL
RENEW_RACE_PID=$!
wait_for_activity 'fence-concurrent-renew' \
  "state = 'active' AND query LIKE '%pg_sleep(6)%'" \
  'concurrent renewal never reached its deterministic hold point'
wait "$RENEW_RACE_WRITER_PID" || {
  cat "$RENEW_RACE_WRITER_OUT" >&2
  fail 'valid writer was falsely fenced by a concurrent same-owner renewal'
}
wait_for_activity 'fence-concurrent-renew' \
  "state = 'active' AND query LIKE '%pg_sleep(6)%'" \
  'valid writer waited for the concurrent same-owner renewal'
wait "$RENEW_RACE_PID" || {
  cat "$RENEW_RACE_OUT" >&2
  fail 'concurrent same-owner renewal failed'
}
assert_query 'renew-race writer guard was deleted at commit' '0' \
  'SELECT pg_catalog.count(*) FROM arena.ingest_worker_write_guards'

# Old writer owns the shared xact lock. Exact release must wait for its COMMIT.
WRITER_OUT="$TMP_ROOT/writer-a.out"
PGAPPNAME='fence-shared-writer' psql_cmd -qAt >"$WRITER_OUT" 2>&1 <<SQL &
BEGIN;
SELECT $(begin_write_sql "$INSTANCE_A" "$TOKEN_A" 1 "$EPOCH_A");
SELECT pg_catalog.pg_sleep(3);
COMMIT;
SQL
WRITER_PID=$!
wait_for_activity 'fence-shared-writer' \
  "state = 'active' AND query LIKE '%pg_sleep(3)%'" \
  'shared writer never reached its deterministic hold point'

RELEASE_OUT="$TMP_ROOT/release-a.out"
PGAPPNAME='fence-exclusive-release' psql_cmd -qAt \
  -c "SELECT $(release_sql "$INSTANCE_A" "$TOKEN_A" 1 "$EPOCH_A")" \
  >"$RELEASE_OUT" 2>&1 &
RELEASE_PID=$!
wait_for_activity 'fence-exclusive-release' \
  "wait_event_type = 'Lock' AND wait_event = 'advisory'" \
  'exclusive release did not wait behind the shared writer'
wait "$WRITER_PID" || {
  cat "$WRITER_OUT" >&2
  fail 'authorized writer failed before release'
}
wait "$RELEASE_PID" || {
  cat "$RELEASE_OUT" >&2
  fail 'release failed after the writer committed'
}
assert_query 'release exact replay is idempotent before a successor exists' 'true' \
  "SELECT ($(release_sql "$INSTANCE_A" "$TOKEN_A" 1 "$EPOCH_A"))->>'released'"
assert_query 'committed guards are deleted at the deferred assertion' '0' \
  'SELECT pg_catalog.count(*) FROM arena.ingest_worker_write_guards'

ACTIVATE_B="$(activate_sql "$INSTANCE_B" "$TOKEN_B" 2 1800000002000)"
EPOCH_B="$(psql_cmd -qAt -c "SELECT ($ACTIVATE_B)->>'epoch'")"
((EPOCH_B > EPOCH_A)) || fail 'database epoch did not increase after release'
expect_failure 'old owner cannot begin after successor activation' \
  "SELECT $(begin_write_sql "$INSTANCE_A" "$TOKEN_A" 1 "$EPOCH_A")" \
  'stale|expired|fenced|55000'
assert_query 'historical exact release replay remains idempotent' 'true' \
  "SELECT ($(release_sql "$INSTANCE_A" "$TOKEN_A" 1 "$EPOCH_A"))->>'released'"
assert_query 'historical release replay preserved successor' "$INSTANCE_B" "
  SELECT active_instance_id::text
  FROM arena.ingest_worker_authorities
  WHERE authority_scope = '$SCOPE'
"

# Activation wins first: an old shared writer waits, then observes the new row
# and fails after the exclusive activation commits.
psql_cmd -q -c "
  UPDATE arena.ingest_worker_authorities
  SET activated_at = pg_catalog.date_trunc(
        'milliseconds', pg_catalog.clock_timestamp() - INTERVAL '3 seconds'
      ),
      renewed_at = pg_catalog.date_trunc(
        'milliseconds', pg_catalog.clock_timestamp() - INTERVAL '2 seconds'
      ),
      lease_expires_at = pg_catalog.date_trunc(
        'milliseconds', pg_catalog.clock_timestamp() - INTERVAL '1 second'
      )
  WHERE authority_scope = '$SCOPE'
"
ACTIVATION_OUT="$TMP_ROOT/activation-c.out"
PGAPPNAME='fence-exclusive-activation' psql_cmd -qAt >"$ACTIVATION_OUT" 2>&1 <<SQL &
BEGIN;
SELECT $(activate_sql "$INSTANCE_C" "$TOKEN_C" 3 1800000003000);
SELECT pg_catalog.pg_sleep(3);
COMMIT;
SQL
ACTIVATION_PID=$!
wait_for_activity 'fence-exclusive-activation' \
  "state = 'active' AND query LIKE '%pg_sleep(3)%'" \
  'exclusive activation never reached its deterministic hold point'

STALE_OUT="$TMP_ROOT/stale-writer.out"
PGAPPNAME='fence-stale-writer' psql_cmd -qAt \
  -c "SELECT $(begin_write_sql "$INSTANCE_B" "$TOKEN_B" 2 "$EPOCH_B")" \
  >"$STALE_OUT" 2>&1 &
STALE_PID=$!
wait_for_activity 'fence-stale-writer' \
  "wait_event_type = 'Lock' AND wait_event = 'advisory'" \
  'old writer did not wait behind the exclusive activation'
wait "$ACTIVATION_PID" || {
  cat "$ACTIVATION_OUT" >&2
  fail 'exclusive activation failed'
}
if wait "$STALE_PID"; then
  fail 'stale writer succeeded after the successor activation'
fi
grep -Eq 'stale|expired|fenced' "$STALE_OUT" || {
  cat "$STALE_OUT" >&2
  fail 'stale writer failed for the wrong reason'
}
EPOCH_C="$(psql_cmd -qAt -c "SELECT active_epoch FROM arena.ingest_worker_authorities WHERE authority_scope='$SCOPE'")"
assert_query 'expired predecessor release is fenced' 'false' \
  "SELECT ($(release_sql "$INSTANCE_B" "$TOKEN_B" 2 "$EPOCH_B"))->>'released'"
assert_query 'expired predecessor release preserved current owner' "$INSTANCE_C" "
  SELECT active_instance_id::text
  FROM arena.ingest_worker_authorities
  WHERE authority_scope = '$SCOPE'
"

# A rolled-back activation consumes a sequence value but cannot reuse it.
psql_cmd -qAt -c "SELECT $(release_sql "$INSTANCE_C" "$TOKEN_C" 3 "$EPOCH_C")" >/dev/null
psql_cmd -qAt <<SQL >/dev/null
BEGIN;
SELECT $(activate_sql "$INSTANCE_D" "$TOKEN_D" 4 1800000004000);
ROLLBACK;
SQL
EPOCH_F="$(psql_cmd -qAt -c "SELECT ($(activate_sql "$INSTANCE_F" "$TOKEN_F" 5 1800000005000))->>'epoch'")"
((EPOCH_F > EPOCH_C + 1)) || fail 'rolled-back activation reused a database epoch'

# Exercise the production API's normal deferred path: deliberately do not
# issue SET CONSTRAINTS ... IMMEDIATE. A transaction that begins while the
# lease is live, performs a business write, and then crosses lease_expires_at
# must be rejected by the initially-deferred trigger at COMMIT.
assert_query 'commit assertion remains deferrable and initially deferred' 't,t' "
  SELECT pg_catalog.concat_ws(',', trigger_row.tgdeferrable, trigger_row.tginitdeferred)
  FROM pg_catalog.pg_trigger AS trigger_row
  WHERE trigger_row.tgrelid = 'arena.ingest_worker_write_guards'::pg_catalog.regclass
    AND trigger_row.tgname = 'ingest_worker_fence_commit_assertion'
    AND NOT trigger_row.tgisinternal
"
psql_cmd -q <<'SQL'
CREATE TABLE public.ingest_worker_fence_commit_probe (
  probe_id bigint PRIMARY KEY,
  marker text NOT NULL
);
SQL
psql_cmd -q -c "
  UPDATE arena.ingest_worker_authorities
  SET lease_expires_at = pg_catalog.date_trunc(
        'milliseconds', pg_catalog.clock_timestamp() + INTERVAL '5 seconds'
      )
  WHERE authority_scope = '$SCOPE'
    AND active_epoch = $EPOCH_F
    AND active_instance_id = '$INSTANCE_F'
"
expect_sqlstate_failure 'deferred commit fences a write that crosses lease expiry' "
  BEGIN;
  SELECT $(begin_write_sql "$INSTANCE_F" "$TOKEN_F" 5 "$EPOCH_F");
  INSERT INTO public.ingest_worker_fence_commit_probe (probe_id, marker)
  VALUES (1, 'must roll back');
  SELECT pg_catalog.pg_sleep((
    SELECT GREATEST(
             0.0,
             EXTRACT(EPOCH FROM (
               authority.lease_expires_at - pg_catalog.clock_timestamp()
             ))
           ) + 0.250
    FROM arena.ingest_worker_authorities AS authority
    WHERE authority.authority_scope = '$SCOPE'
  )::double precision);
  COMMIT;
" '55000' 'ingest worker write transaction was fenced before commit'
assert_query 'fenced transaction business write was rolled back' '0' \
  'SELECT pg_catalog.count(*) FROM public.ingest_worker_fence_commit_probe'
assert_query 'fenced transaction guard was rolled back' '0' \
  'SELECT pg_catalog.count(*) FROM arena.ingest_worker_write_guards'

psql_cmd -q -c "
  UPDATE arena.ingest_worker_authorities
  SET activated_at = pg_catalog.date_trunc(
        'milliseconds', pg_catalog.clock_timestamp() - INTERVAL '3 seconds'
      ),
      renewed_at = pg_catalog.date_trunc(
        'milliseconds', pg_catalog.clock_timestamp() - INTERVAL '2 seconds'
      ),
      lease_expires_at = pg_catalog.date_trunc(
        'milliseconds', pg_catalog.clock_timestamp() - INTERVAL '1 second'
      )
  WHERE authority_scope = '$SCOPE'
"
expect_failure 'expired lease cannot renew' \
  "SELECT $(renew_sql "$INSTANCE_F" "$TOKEN_F" 5 1800000006000 "$EPOCH_F")" \
  'expired|fenced|55000'

assert_query 'private token digests are fixed SHA-256 values' '32' "
  SELECT pg_catalog.min(pg_catalog.octet_length(owner_token_digest))
  FROM arena.ingest_worker_instances
"
assert_query 'no API role can execute activation' 'f,f,f' "
  SELECT pg_catalog.concat_ws(',',
    pg_catalog.has_function_privilege(
      'anon',
      'arena.activate_ingest_worker_authority(text,text,text,uuid,text,bigint,bigint,text,text)',
      'EXECUTE'
    ),
    pg_catalog.has_function_privilege(
      'authenticated',
      'arena.activate_ingest_worker_authority(text,text,text,uuid,text,bigint,bigint,text,text)',
      'EXECUTE'
    ),
    pg_catalog.has_function_privilege(
      'service_role',
      'arena.activate_ingest_worker_authority(text,text,text,uuid,text,bigint,bigint,text,text)',
      'EXECUTE'
    )
  )
"

# Keep all catalog attributes identical while replacing only the enforcement
# body. Readiness must detect semantic drift, not merely function metadata.
psql_cmd -q <<'SQL'
CREATE OR REPLACE FUNCTION arena.assert_ingest_worker_fence_at_commit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $drift$
BEGIN
  DELETE FROM arena.ingest_worker_write_guards
  WHERE top_xid8_text = NEW.top_xid8_text
    AND authority_scope = NEW.authority_scope;
  RETURN NEW;
END
$drift$;
SQL
assert_query 'commit-assertion body drift fails readiness' 't' "
  SELECT (public.arena_ingest_worker_fence_release_readiness()->'missing')
         ? 'functions:body-sha256'
"

echo 'durable ingest-worker fence PG17 proof passed'
