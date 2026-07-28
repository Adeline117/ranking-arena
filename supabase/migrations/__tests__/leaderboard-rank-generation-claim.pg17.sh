#!/usr/bin/env bash

# PostgreSQL 17 behavioral proof for durable generation claims. It exercises
# install/replay identity, closed ACLs, frozen UUID replay, expiry takeover,
# rollback, isolation, row-lock concurrency, and post-wait DB-clock semantics.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260725015000_leaderboard_rank_generation_claim.sql"
CAPACITY_MIGRATION="$ROOT_DIR/supabase/migrations/20260725015500_bound_leaderboard_rank_generation_batches.sql"
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

TMP_ROOT="$(mktemp -d /tmp/rank-generation-claim-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((59000 + ($$ % 5000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
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
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

expect_failure() {
  local label="$1"
  local pattern="$2"
  local sql="$3"
  if psql_cmd -q -c "$sql" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if ! rg -q "$pattern" "$ERROR_FILE"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,180p' "$ERROR_FILE" >&2
    exit 1
  fi
}

expect_migration_failure() {
  local label="$1"
  local pattern="$2"
  if psql_cmd -q -f "$MIGRATION" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if ! rg -q "$pattern" "$ERROR_FILE"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,220p' "$ERROR_FILE" >&2
    exit 1
  fi
}

expect_capacity_migration_failure() {
  local label="$1"
  local pattern="$2"
  if psql_cmd -q -f "$CAPACITY_MIGRATION" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if ! rg -q "$pattern" "$ERROR_FILE"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,220p' "$ERROR_FILE" >&2
    exit 1
  fi
}

wait_for_activity() {
  local application_name="$1"
  local expected_wait="$2"
  local process_id="$3"
  local observed=""

  for _attempt in {1..120}; do
    observed="$(
      psql_cmd -Atqc "
        SELECT
          COALESCE(activity.wait_event_type, '') || '|' ||
          COALESCE(activity.wait_event, '')
        FROM pg_catalog.pg_stat_activity AS activity
        WHERE activity.application_name = '$application_name'
        LIMIT 1;
      "
    )"
    if [[ "$observed" == "$expected_wait" ]]; then
      return 0
    fi
    if ! kill -0 "$process_id" 2>/dev/null; then
      return 1
    fi
    sleep 0.05
  done
  return 1
}

wait_for_lock() {
  local application_name="$1"
  local process_id="$2"
  local observed=""

  for _attempt in {1..120}; do
    observed="$(
      psql_cmd -Atqc "
        SELECT COALESCE(activity.wait_event_type, '')
        FROM pg_catalog.pg_stat_activity AS activity
        WHERE activity.application_name = '$application_name'
        LIMIT 1;
      "
    )"
    if [[ "$observed" == "Lock" ]]; then
      return 0
    fi
    if ! kill -0 "$process_id" 2>/dev/null; then
      return 1
    fi
    sleep 0.05
  done
  return 1
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --username=postgres \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE fixture_rogue NOLOGIN;
CREATE ROLE fixture_delegate NOLOGIN;
CREATE SCHEMA arena;

GRANT USAGE ON SCHEMA arena
  TO anon, authenticated, service_role, fixture_rogue, fixture_delegate;

CREATE FUNCTION arena.reject_leaderboard_rank_publication_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'leaderboard publication receipts are immutable'
    USING ERRCODE = '55000';
END;
$function$;
ALTER FUNCTION arena.reject_leaderboard_rank_publication_mutation()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.reject_leaderboard_rank_publication_mutation()
  FROM PUBLIC, anon, authenticated, service_role, fixture_rogue, fixture_delegate;
SQL

# A partial same-name install must never be blessed by IF NOT EXISTS.
psql_cmd -q -c \
  'CREATE TABLE arena.leaderboard_rank_generation_claims (rogue text);'
expect_migration_failure \
  "generation migration accepted a partial table install" \
  "generation tables are only partially installed"

PARTIAL_ROLLBACK="$(
  psql_cmd -Atqc "
    SELECT
      (pg_catalog.to_regclass(
        'arena.leaderboard_rank_generation_claims'
      ) IS NOT NULL) || '|' ||
      (pg_catalog.to_regclass(
        'arena.leaderboard_rank_generation_heads'
      ) IS NULL) || '|' ||
      (pg_catalog.to_regprocedure(
        'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'
      ) IS NULL);
  "
)"
if [[ "$PARTIAL_ROLLBACK" != "true|true|true" ]]; then
  echo "partial generation install rejection did not roll back" >&2
  exit 1
fi
psql_cmd -q -c 'DROP TABLE arena.leaderboard_rank_generation_claims;'

# A same-name overload must abort the install without creating durable state.
psql_cmd -q <<'SQL'
CREATE FUNCTION public.claim_leaderboard_rank_generation(text)
RETURNS boolean
LANGUAGE sql
AS $$ SELECT false $$;
SQL
expect_migration_failure \
  "generation migration accepted a same-name rogue overload" \
  "generation claim RPC has an unsupported overload"

OVERLOAD_ROLLBACK="$(
  psql_cmd -Atqc "
    SELECT
      (pg_catalog.to_regprocedure(
        'public.claim_leaderboard_rank_generation(text)'
      ) IS NOT NULL) || '|' ||
      (pg_catalog.to_regclass(
        'arena.leaderboard_rank_generation_claims'
      ) IS NULL) || '|' ||
      (pg_catalog.to_regclass(
        'arena.leaderboard_rank_generation_heads'
      ) IS NULL);
  "
)"
if [[ "$OVERLOAD_ROLLBACK" != "true|true|true" ]]; then
  echo "rogue generation overload rejection did not roll back" >&2
  exit 1
fi
psql_cmd -q -c 'DROP FUNCTION public.claim_leaderboard_rank_generation(text);'

psql_cmd -q -f "$MIGRATION"

# Claim one generation before replay, then introduce direct and delegated rogue
# ACLs. Replay must reject the compromised boundary without touching durable
# state. After explicitly restoring the ACL, clean replay preserves every row
# and callable identity.
psql_cmd -q <<'SQL'
CREATE TABLE public.fixture_generation_response (response jsonb NOT NULL);
INSERT INTO public.fixture_generation_response (response)
SELECT public.claim_leaderboard_rank_generation(
  '90D',
  '11111111-1111-4111-8111-111111111111'::uuid,
  pg_catalog.repeat('a', 64),
  2,
  1,
  '2026-07-25 00:00:00+00'::timestamptz,
  300
);

CREATE TABLE public.fixture_generation_before AS
SELECT
  function_row.oid AS function_oid,
  function_row.prosrc AS function_source,
  function_row.proacl AS function_acl,
  'arena.leaderboard_rank_generation_claims'::regclass::oid AS claims_oid,
  claims_class.relacl AS claims_acl,
  'arena.leaderboard_rank_generation_heads'::regclass::oid AS heads_oid,
  heads_class.relacl AS heads_acl,
  (
    SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(claim) ORDER BY claim.generation_seq)
    FROM arena.leaderboard_rank_generation_claims AS claim
  ) AS claim_rows,
  (
    SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(head) ORDER BY head.season_id)
    FROM arena.leaderboard_rank_generation_heads AS head
  ) AS head_rows,
  (SELECT response FROM public.fixture_generation_response) AS first_response
FROM pg_catalog.pg_proc AS function_row
CROSS JOIN pg_catalog.pg_class AS claims_class
CROSS JOIN pg_catalog.pg_class AS heads_class
WHERE function_row.oid =
    'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'
      ::regprocedure
  AND claims_class.oid = 'arena.leaderboard_rank_generation_claims'::regclass
  AND heads_class.oid = 'arena.leaderboard_rank_generation_heads'::regclass;

GRANT SELECT ON arena.leaderboard_rank_generation_claims
  TO fixture_rogue WITH GRANT OPTION;
GRANT SELECT ON arena.leaderboard_rank_generation_heads
  TO fixture_rogue WITH GRANT OPTION;
GRANT EXECUTE ON FUNCTION public.claim_leaderboard_rank_generation(
  text, uuid, text, integer, integer, timestamptz, integer
) TO fixture_rogue WITH GRANT OPTION;

SET ROLE fixture_rogue;
GRANT SELECT ON arena.leaderboard_rank_generation_claims TO fixture_delegate;
GRANT SELECT ON arena.leaderboard_rank_generation_heads TO fixture_delegate;
GRANT EXECUTE ON FUNCTION public.claim_leaderboard_rank_generation(
  text, uuid, text, integer, integer, timestamptz, integer
) TO fixture_delegate;
RESET ROLE;
SQL

expect_migration_failure \
  "generation migration accepted rogue replay grants" \
  "ACL drifted"

ROGUE_ACL_ROLLBACK="$(
  psql_cmd -Atqc "
    SELECT
      pg_catalog.has_function_privilege(
        'fixture_rogue',
        'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)',
        'EXECUTE'
      ) || '|' ||
      pg_catalog.has_function_privilege(
        'fixture_delegate',
        'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)',
        'EXECUTE'
      ) || '|' ||
      pg_catalog.has_table_privilege(
        'fixture_rogue',
        'arena.leaderboard_rank_generation_claims',
        'SELECT'
      ) || '|' ||
      (SELECT pg_catalog.count(*)
       FROM arena.leaderboard_rank_generation_claims);
  "
)"
if [[ "$ROGUE_ACL_ROLLBACK" != "true|true|true|1" ]]; then
  echo "rogue generation ACL rejection did not roll back" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
REVOKE ALL PRIVILEGES ON TABLE arena.leaderboard_rank_generation_claims
  FROM fixture_rogue CASCADE;
REVOKE ALL PRIVILEGES ON TABLE arena.leaderboard_rank_generation_heads
  FROM fixture_rogue CASCADE;
REVOKE ALL PRIVILEGES ON TABLE arena.leaderboard_rank_generation_claims
  FROM fixture_delegate CASCADE;
REVOKE ALL PRIVILEGES ON TABLE arena.leaderboard_rank_generation_heads
  FROM fixture_delegate CASCADE;
REVOKE EXECUTE ON FUNCTION public.claim_leaderboard_rank_generation(
  text, uuid, text, integer, integer, timestamptz, integer
) FROM fixture_rogue CASCADE;
REVOKE EXECUTE ON FUNCTION public.claim_leaderboard_rank_generation(
  text, uuid, text, integer, integer, timestamptz, integer
) FROM fixture_delegate CASCADE;
SQL

psql_cmd -q -c \
  'GRANT SELECT (contract) ON arena.leaderboard_rank_generation_claims TO fixture_rogue;'
expect_migration_failure \
  "generation migration accepted a rogue column grant" \
  "generation table owner, RLS, or ACL drifted"
if [[ "$(psql_cmd -Atqc "SELECT has_column_privilege('fixture_rogue','arena.leaderboard_rank_generation_claims','contract','SELECT');")" != "t" ]]; then
  echo "rogue generation column ACL rejection did not roll back" >&2
  exit 1
fi
psql_cmd -q -c \
  'REVOKE SELECT (contract) ON arena.leaderboard_rank_generation_claims FROM fixture_rogue;'

psql_cmd -q -f "$MIGRATION"

psql_cmd -q <<'SQL'
DO $replay_contract$
DECLARE
  v_unchanged boolean;
  v_replay jsonb;
BEGIN
  SELECT
    after_function.oid = before.function_oid
    AND after_function.prosrc = before.function_source
    AND after_function.proacl IS NOT DISTINCT FROM before.function_acl
    AND claims_class.oid = before.claims_oid
    AND claims_class.relacl IS NOT DISTINCT FROM before.claims_acl
    AND heads_class.oid = before.heads_oid
    AND heads_class.relacl IS NOT DISTINCT FROM before.heads_acl
    AND (
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(claim) ORDER BY claim.generation_seq)
      FROM arena.leaderboard_rank_generation_claims AS claim
    ) = before.claim_rows
    AND (
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(head) ORDER BY head.season_id)
      FROM arena.leaderboard_rank_generation_heads AS head
    ) = before.head_rows
  INTO STRICT v_unchanged
  FROM public.fixture_generation_before AS before
  CROSS JOIN pg_catalog.pg_proc AS after_function
  CROSS JOIN pg_catalog.pg_class AS claims_class
  CROSS JOIN pg_catalog.pg_class AS heads_class
  WHERE after_function.oid =
      'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'
        ::regprocedure
    AND claims_class.oid = 'arena.leaderboard_rank_generation_claims'::regclass
    AND heads_class.oid = 'arena.leaderboard_rank_generation_heads'::regclass;

  IF v_unchanged IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'generation callable or durable state changed across replay';
  END IF;

  IF pg_catalog.has_function_privilege(
       'fixture_rogue',
       'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)',
       'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'fixture_delegate',
       'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)',
       'EXECUTE'
     ) OR pg_catalog.has_table_privilege(
       'fixture_rogue',
       'arena.leaderboard_rank_generation_claims',
       'SELECT'
     ) OR pg_catalog.has_table_privilege(
       'fixture_delegate',
       'arena.leaderboard_rank_generation_heads',
       'SELECT'
     ) THEN
    RAISE EXCEPTION 'generation replay retained a rogue grant';
  END IF;

  v_replay := public.claim_leaderboard_rank_generation(
    '90D',
    '11111111-1111-4111-8111-111111111111'::uuid,
    pg_catalog.repeat('a', 64),
    2,
    1,
    '2026-07-25 00:00:00+00'::timestamptz,
    300
  );
  IF v_replay IS DISTINCT FROM (
    SELECT response FROM public.fixture_generation_response
  ) OR (
    SELECT pg_catalog.count(*)
    FROM arena.leaderboard_rank_generation_claims
  ) <> 1 THEN
    RAISE EXCEPTION 'same generation UUID replay was not frozen';
  END IF;
END
$replay_contract$;
SQL

# A response-loss retry remains frozen after later stages have begun. Active
# heads must also retain a non-null lease that exactly matches the immutable
# claim; SQL CHECK's three-valued NULL behavior must not weaken this invariant.
psql_cmd -q <<'SQL'
DO $active_replay$
DECLARE
  v_phase text;
  v_replay jsonb;
BEGIN
  FOREACH v_phase IN ARRAY ARRAY['writing', 'cleaned', 'reranked']
  LOOP
    UPDATE arena.leaderboard_rank_generation_heads
    SET phase = v_phase
    WHERE season_id = '90D';

    v_replay := public.claim_leaderboard_rank_generation(
      '90D',
      '11111111-1111-4111-8111-111111111111'::uuid,
      pg_catalog.repeat('a', 64),
      2,
      1,
      '2026-07-25 00:00:00+00'::timestamptz,
      300
    );
    IF v_replay IS DISTINCT FROM (
      SELECT response FROM public.fixture_generation_response
    ) THEN
      RAISE EXCEPTION 'active-phase generation replay was not frozen: %', v_phase;
    END IF;
  END LOOP;

  UPDATE arena.leaderboard_rank_generation_heads
  SET phase = 'claimed'
  WHERE season_id = '90D';
END
$active_replay$;
SQL

expect_failure \
  "active generation accepted a null lease" \
  "leaderboard_rank_generation_heads_state_check" \
  "UPDATE arena.leaderboard_rank_generation_heads SET lease_expires_at = NULL WHERE season_id = '90D';"

expect_failure \
  "drifted active generation lease was trusted" \
  "active generation head lease disagrees with its claim" \
  "BEGIN; UPDATE arena.leaderboard_rank_generation_heads SET lease_expires_at = lease_expires_at + interval '1 second' WHERE season_id = '90D'; SET LOCAL ROLE service_role; SELECT public.claim_leaderboard_rank_generation('90D','11111111-1111-4111-8111-111111111111',repeat('a',64),2,1,'2026-07-25 00:00:00+00',300); COMMIT;"

expect_failure \
  "anonymous generation RPC" \
  "permission denied for function claim_leaderboard_rank_generation" \
  "SET ROLE anon; SELECT public.claim_leaderboard_rank_generation('7D','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',repeat('a',64),0,0,'2026-07-25 00:00:00+00',300);"
expect_failure \
  "authenticated generation RPC" \
  "permission denied for function claim_leaderboard_rank_generation" \
  "SET ROLE authenticated; SELECT public.claim_leaderboard_rank_generation('7D','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',repeat('a',64),0,0,'2026-07-25 00:00:00+00',300);"
expect_failure \
  "service direct generation ledger read" \
  "permission denied for table leaderboard_rank_generation_claims" \
  "SET ROLE service_role; SELECT * FROM arena.leaderboard_rank_generation_claims;"
expect_failure \
  "service direct generation head write" \
  "permission denied for table leaderboard_rank_generation_heads" \
  "SET ROLE service_role; UPDATE arena.leaderboard_rank_generation_heads SET updated_at = clock_timestamp() WHERE season_id = '90D';"
expect_failure \
  "generation ledger update" \
  "leaderboard publication receipts are immutable" \
  "UPDATE arena.leaderboard_rank_generation_claims SET write_set_sha256 = write_set_sha256 WHERE season_id = '90D';"
expect_failure \
  "generation ledger delete" \
  "leaderboard publication receipts are immutable" \
  "DELETE FROM arena.leaderboard_rank_generation_claims WHERE season_id = '90D';"

SERVICE_REPLAY="$(
  psql_cmd -Atq <<'SQL'
SET ROLE service_role;
SELECT result->>'generation_seq'
FROM (
  SELECT public.claim_leaderboard_rank_generation(
    '90D',
    '11111111-1111-4111-8111-111111111111'::uuid,
    pg_catalog.repeat('a', 64),
    2,
    1,
    '2026-07-25 00:00:00+00'::timestamptz,
    300
  ) AS result
) AS replay;
RESET ROLE;
SQL
)"
if [[ "$SERVICE_REPLAY" != "1" ]]; then
  echo "service generation replay drifted: $SERVICE_REPLAY" >&2
  exit 1
fi

expect_failure \
  "same generation UUID accepted a different payload" \
  "generation cohort UUID was reused with different input" \
  "SET ROLE service_role; SELECT public.claim_leaderboard_rank_generation('90D','11111111-1111-4111-8111-111111111111',repeat('b',64),2,1,'2026-07-25 00:00:00+00',300);"
expect_failure \
  "generation UUID was accepted across seasons" \
  "generation cohort UUID was reused with different input" \
  "SET ROLE service_role; SELECT public.claim_leaderboard_rank_generation('30D','11111111-1111-4111-8111-111111111111',repeat('a',64),2,1,'2026-07-25 00:00:00+00',300);"
expect_failure \
  "active generation accepted a competing cohort" \
  "another leaderboard generation owns the active lease" \
  "SET ROLE service_role; SELECT public.claim_leaderboard_rank_generation('90D','22222222-2222-4222-8222-222222222222',repeat('b',64),0,0,'2026-07-25 00:01:00+00',300);"

if [[ "$(psql_cmd -Atqc "SELECT generation_seq || '|' || phase FROM arena.leaderboard_rank_generation_heads WHERE season_id = '30D';")" != "0|idle" ]]; then
  echo "cross-season UUID rejection changed the losing season head" >&2
  exit 1
fi

# Equality/past expiry is inactive. Takeover must allocate the next sequence and
# the historical UUID must remain permanently non-revivable.
psql_cmd -q <<'SQL'
BEGIN;
SET LOCAL session_replication_role = replica;
WITH expiry AS (
  SELECT pg_catalog.clock_timestamp() - interval '1 second' AS value
)
UPDATE arena.leaderboard_rank_generation_claims AS claim
SET
  claimed_at = expiry.value - claim.lease_seconds * interval '1 second',
  lease_expires_at = expiry.value
FROM expiry
WHERE claim.season_id = '90D'
  AND claim.score_cohort_id =
    '11111111-1111-4111-8111-111111111111'::uuid;
UPDATE arena.leaderboard_rank_generation_heads AS head
SET lease_expires_at = claim.lease_expires_at
FROM arena.leaderboard_rank_generation_claims AS claim
WHERE head.season_id = '90D'
  AND claim.season_id = head.season_id
  AND claim.generation_seq = head.generation_seq
  AND claim.score_cohort_id = head.score_cohort_id;
SET LOCAL session_replication_role = origin;
COMMIT;
SQL

TAKEOVER="$(
  psql_cmd -Atq <<'SQL'
SET ROLE service_role;
SELECT result->>'generation_seq'
FROM (
  SELECT public.claim_leaderboard_rank_generation(
    '90D',
    '22222222-2222-4222-8222-222222222222'::uuid,
    pg_catalog.repeat('b', 64),
    0,
    0,
    '2026-07-25 00:01:00+00'::timestamptz,
    300
  ) AS result
) AS claimed;
RESET ROLE;
SQL
)"
if [[ "$TAKEOVER" != "2" ]] || [[ "$(psql_cmd -Atqc "SELECT generation_seq || '|' || score_cohort_id FROM arena.leaderboard_rank_generation_heads WHERE season_id = '90D';")" != "2|22222222-2222-4222-8222-222222222222" ]]; then
  echo "expired generation did not permit monotonic takeover" >&2
  exit 1
fi

expect_failure \
  "expired historical generation revived" \
  "generation claim is expired, terminal, or superseded" \
  "SET ROLE service_role; SELECT public.claim_leaderboard_rank_generation('90D','11111111-1111-4111-8111-111111111111',repeat('a',64),2,1,'2026-07-25 00:00:00+00',300);"

# Two identical response-loss retries serialize to one ledger row and return
# byte-identical frozen JSON rather than renewing the lease or allocating seq4.
psql_cmd -q <<'SQL'
BEGIN;
SET LOCAL session_replication_role = replica;
WITH expiry AS (
  SELECT pg_catalog.clock_timestamp() - interval '1 second' AS value
)
UPDATE arena.leaderboard_rank_generation_claims AS claim
SET
  claimed_at = expiry.value - claim.lease_seconds * interval '1 second',
  lease_expires_at = expiry.value
FROM expiry
WHERE claim.season_id = '90D'
  AND claim.generation_seq = 2;
UPDATE arena.leaderboard_rank_generation_heads AS head
SET lease_expires_at = claim.lease_expires_at
FROM arena.leaderboard_rank_generation_claims AS claim
WHERE head.season_id = '90D'
  AND claim.season_id = head.season_id
  AND claim.generation_seq = head.generation_seq
  AND claim.score_cohort_id = head.score_cohort_id;
SET LOCAL session_replication_role = origin;
COMMIT;
SQL

IDENTICAL_HOLDER_OUT="$TMP_ROOT/identical-holder.out"
IDENTICAL_WAITER_OUT="$TMP_ROOT/identical-waiter.out"
PGAPPNAME=generation_identical_holder \
  psql_cmd -Atq >"$IDENTICAL_HOLDER_OUT" 2>&1 <<'SQL' &
BEGIN;
SET LOCAL ROLE service_role;
SELECT public.claim_leaderboard_rank_generation(
  '90D',
  '90909090-9090-4090-8090-909090909003'::uuid,
  pg_catalog.repeat('9', 64),
  3,
  1,
  '2026-07-25 00:01:30+00'::timestamptz,
  300
)::text;
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
IDENTICAL_HOLDER_PID=$!

if ! wait_for_activity \
  "generation_identical_holder" \
  "Timeout|PgSleep" \
  "$IDENTICAL_HOLDER_PID"; then
  wait "$IDENTICAL_HOLDER_PID" || true
  echo "identical generation holder never acquired the season head" >&2
  exit 1
fi

PGAPPNAME=generation_identical_waiter \
  psql_cmd -Atq -c "
    SET ROLE service_role;
    SELECT public.claim_leaderboard_rank_generation(
      '90D',
      '90909090-9090-4090-8090-909090909003'::uuid,
      pg_catalog.repeat('9', 64),
      3,
      1,
      '2026-07-25 00:01:30+00'::timestamptz,
      300
    )::text;
  " >"$IDENTICAL_WAITER_OUT" 2>&1 &
IDENTICAL_WAITER_PID=$!

if ! wait_for_lock "generation_identical_waiter" "$IDENTICAL_WAITER_PID"; then
  wait "$IDENTICAL_HOLDER_PID" || true
  wait "$IDENTICAL_WAITER_PID" || true
  echo "concurrent identical generation waiter did not block" >&2
  exit 1
fi
wait "$IDENTICAL_HOLDER_PID"
wait "$IDENTICAL_WAITER_PID"

IDENTICAL_HOLDER_RESPONSE="$(sed -n '1p' "$IDENTICAL_HOLDER_OUT")"
IDENTICAL_WAITER_RESPONSE="$(sed -n '1p' "$IDENTICAL_WAITER_OUT")"
if [[ -z "$IDENTICAL_HOLDER_RESPONSE" ]] \
   || [[ "$IDENTICAL_HOLDER_RESPONSE" != "$IDENTICAL_WAITER_RESPONSE" ]] \
   || [[ "$(psql_cmd -Atqc "SELECT count(*) FROM arena.leaderboard_rank_generation_claims WHERE score_cohort_id = '90909090-9090-4090-8090-909090909003';")" != "1" ]]; then
  echo "concurrent identical generation replay was not frozen" >&2
  exit 1
fi

expect_failure \
  "generation claim accepted REPEATABLE READ" \
  "generation claims require READ COMMITTED isolation" \
  "BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL ROLE service_role; SELECT public.claim_leaderboard_rank_generation('30D','33333333-3333-4333-8333-333333333333',repeat('c',64),0,0,'2026-07-25 00:02:00+00',300); COMMIT;"

# Even a post-deploy BEFORE UPDATE trigger that suppresses the head write must
# not leave the claim INSERT behind. ROW_COUNT and the outer statement rollback
# turn that hostile no-op into an atomic failure.
psql_cmd -q <<'SQL'
CREATE FUNCTION arena.fixture_suppress_generation_head_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RETURN NULL;
END;
$function$;
CREATE TRIGGER fixture_suppress_generation_head_update
BEFORE UPDATE ON arena.leaderboard_rank_generation_heads
FOR EACH ROW
EXECUTE FUNCTION arena.fixture_suppress_generation_head_update();
SQL

expect_failure \
  "suppressed generation head compare-and-set" \
  "generation head compare-and-set did not update exactly one row" \
  "SET ROLE service_role; SELECT public.claim_leaderboard_rank_generation('7D','77777777-7777-4777-8777-777777777700',repeat('d',64),1,1,'2026-07-25 00:02:30+00',300);"

if [[ "$(psql_cmd -Atqc "SELECT (SELECT count(*) FROM arena.leaderboard_rank_generation_claims WHERE season_id = '7D') || '|' || (SELECT generation_seq FROM arena.leaderboard_rank_generation_heads WHERE season_id = '7D');")" != "0|0" ]]; then
  echo "generation head no-op trigger left an orphan claim" >&2
  exit 1
fi
psql_cmd -q <<'SQL'
DROP TRIGGER fixture_suppress_generation_head_update
  ON arena.leaderboard_rank_generation_heads;
DROP FUNCTION arena.fixture_suppress_generation_head_update();
SQL

# Transaction rollback must erase both the ledger row and the head advance.
psql_cmd -q <<'SQL'
BEGIN;
SET LOCAL ROLE service_role;
SELECT public.claim_leaderboard_rank_generation(
  '7D',
  '77777777-7777-4777-8777-777777777701'::uuid,
  pg_catalog.repeat('d', 64),
  1,
  1,
  '2026-07-25 00:03:00+00'::timestamptz,
  300
);
ROLLBACK;
SQL

ROLLBACK_STATE="$(
  psql_cmd -Atqc "
    SELECT
      (SELECT pg_catalog.count(*)
       FROM arena.leaderboard_rank_generation_claims
       WHERE season_id = '7D') || '|' ||
      (SELECT generation_seq
       FROM arena.leaderboard_rank_generation_heads
       WHERE season_id = '7D') || '|' ||
      (SELECT phase
       FROM arena.leaderboard_rank_generation_heads
       WHERE season_id = '7D');
  "
)"
if [[ "$ROLLBACK_STATE" != "0|0|idle" ]]; then
  echo "rolled-back generation claim left durable state: $ROLLBACK_STATE" >&2
  exit 1
fi

# Two different cohorts on one idle season serialize on its durable head. The
# loser must block until the winner commits, then fail against the active lease.
CONCURRENT_HOLDER_OUT="$TMP_ROOT/concurrent-holder.out"
CONCURRENT_WAITER_OUT="$TMP_ROOT/concurrent-waiter.out"
PGAPPNAME=generation_claim_holder \
  psql_cmd -Atq >"$CONCURRENT_HOLDER_OUT" 2>&1 <<'SQL' &
BEGIN;
SET LOCAL ROLE service_role;
SELECT result->>'generation_seq'
FROM (
  SELECT public.claim_leaderboard_rank_generation(
    '30D',
    '30303030-3030-4030-8030-303030303001'::uuid,
    pg_catalog.repeat('e', 64),
    10,
    2,
    '2026-07-25 00:04:00+00'::timestamptz,
    300
  ) AS result
) AS claimed;
SELECT pg_catalog.pg_sleep(3);
COMMIT;
SQL
CONCURRENT_HOLDER_PID=$!

if ! wait_for_activity \
  "generation_claim_holder" \
  "Timeout|PgSleep" \
  "$CONCURRENT_HOLDER_PID"; then
  wait "$CONCURRENT_HOLDER_PID" || true
  echo "concurrent generation holder never acquired the season head" >&2
  exit 1
fi

PGAPPNAME=generation_claim_waiter \
  psql_cmd -Atq -c "
    SET ROLE service_role;
    SELECT public.claim_leaderboard_rank_generation(
      '30D',
      '30303030-3030-4030-8030-303030303002'::uuid,
      pg_catalog.repeat('f', 64),
      10,
      2,
      '2026-07-25 00:04:01+00'::timestamptz,
      300
    );
  " >"$CONCURRENT_WAITER_OUT" 2>&1 &
CONCURRENT_WAITER_PID=$!

if ! wait_for_lock "generation_claim_waiter" "$CONCURRENT_WAITER_PID"; then
  wait "$CONCURRENT_HOLDER_PID" || true
  wait "$CONCURRENT_WAITER_PID" || true
  echo "concurrent generation waiter did not block on the season head" >&2
  exit 1
fi

wait "$CONCURRENT_HOLDER_PID"
if wait "$CONCURRENT_WAITER_PID"; then
  echo "concurrent generation loser unexpectedly succeeded" >&2
  exit 1
fi
if ! rg -q "another leaderboard generation owns the active lease" "$CONCURRENT_WAITER_OUT"; then
  echo "concurrent generation loser did not observe the active lease" >&2
  sed -n '1,120p' "$CONCURRENT_WAITER_OUT" >&2
  exit 1
fi

if [[ "$(psql_cmd -Atqc "SELECT count(*) || '|' || min(score_cohort_id::text) FROM arena.leaderboard_rank_generation_claims WHERE season_id = '30D';")" != "1|30303030-3030-4030-8030-303030303001" ]]; then
  echo "concurrent generation race persisted a losing cohort" >&2
  exit 1
fi

# Prove clock_timestamp is taken after a blocked SELECT FOR UPDATE. The holder
# shortens an existing lease inside its transaction and keeps the row locked
# until that lease is expired. A waiter whose statement began earlier must then
# take over instead of using its statement-start clock.
psql_cmd -q <<'SQL'
SET ROLE service_role;
SELECT public.claim_leaderboard_rank_generation(
  '7D',
  '77777777-7777-4777-8777-777777777702'::uuid,
  pg_catalog.repeat('7', 64),
  1,
  1,
  '2026-07-25 00:05:00+00'::timestamptz,
  300
);
RESET ROLE;
SQL

CLOCK_HOLDER_OUT="$TMP_ROOT/clock-holder.out"
CLOCK_WAITER_OUT="$TMP_ROOT/clock-waiter.out"
PGAPPNAME=generation_clock_holder \
  psql_cmd -Atq >"$CLOCK_HOLDER_OUT" 2>&1 <<'SQL' &
BEGIN;
SET LOCAL session_replication_role = replica;
WITH expiry AS (
  SELECT pg_catalog.clock_timestamp() + interval '2 seconds' AS value
)
UPDATE arena.leaderboard_rank_generation_claims AS claim
SET
  claimed_at = expiry.value - claim.lease_seconds * interval '1 second',
  lease_expires_at = expiry.value
FROM expiry
WHERE claim.season_id = '7D'
  AND claim.score_cohort_id =
    '77777777-7777-4777-8777-777777777702'::uuid;
UPDATE arena.leaderboard_rank_generation_heads AS head
SET lease_expires_at = claim.lease_expires_at
FROM arena.leaderboard_rank_generation_claims AS claim
WHERE head.season_id = '7D'
  AND claim.season_id = head.season_id
  AND claim.generation_seq = head.generation_seq
  AND claim.score_cohort_id = head.score_cohort_id;
SET LOCAL session_replication_role = origin;
SELECT pg_catalog.pg_sleep(3);
COMMIT;
SQL
CLOCK_HOLDER_PID=$!

if ! wait_for_activity \
  "generation_clock_holder" \
  "Timeout|PgSleep" \
  "$CLOCK_HOLDER_PID"; then
  wait "$CLOCK_HOLDER_PID" || true
  echo "post-lock clock holder did not acquire the generation head" >&2
  exit 1
fi

PGAPPNAME=generation_clock_waiter \
  psql_cmd -Atq -c "
    SET ROLE service_role;
    SELECT result->>'generation_seq'
    FROM (
      SELECT public.claim_leaderboard_rank_generation(
        '7D',
        '77777777-7777-4777-8777-777777777703'::uuid,
        pg_catalog.repeat('8', 64),
        1,
        1,
        '2026-07-25 00:05:01+00'::timestamptz,
        300
      ) AS result
    ) AS claimed;
  " >"$CLOCK_WAITER_OUT" 2>&1 &
CLOCK_WAITER_PID=$!

if ! wait_for_lock "generation_clock_waiter" "$CLOCK_WAITER_PID"; then
  wait "$CLOCK_HOLDER_PID" || true
  wait "$CLOCK_WAITER_PID" || true
  echo "post-lock authorization clock waiter did not block" >&2
  exit 1
fi

wait "$CLOCK_HOLDER_PID"
if ! wait "$CLOCK_WAITER_PID"; then
  echo "post-lock authorization clock did not permit expired takeover" >&2
  sed -n '1,120p' "$CLOCK_WAITER_OUT" >&2
  exit 1
fi
if ! rg -q '^2$' "$CLOCK_WAITER_OUT"; then
  echo "post-lock authorization clock returned the wrong sequence" >&2
  sed -n '1,120p' "$CLOCK_WAITER_OUT" >&2
  exit 1
fi

# The cohort UUID is globally unique, not merely unique inside one season. Two
# expired heads may race independently, but the global ledger index permits one
# winner and the losing season transaction must leave its head untouched.
LOSING_HEAD_BEFORE="$(psql_cmd -Atqc "SELECT generation_seq || '|' || score_cohort_id FROM arena.leaderboard_rank_generation_heads WHERE season_id = '30D';")"
psql_cmd -q <<'SQL'
BEGIN;
SET LOCAL session_replication_role = replica;
WITH expiry AS (
  SELECT pg_catalog.clock_timestamp() - interval '1 second' AS value
)
UPDATE arena.leaderboard_rank_generation_claims AS claim
SET
  claimed_at = expiry.value - claim.lease_seconds * interval '1 second',
  lease_expires_at = expiry.value
FROM arena.leaderboard_rank_generation_heads AS head, expiry
WHERE head.season_id IN ('7D', '30D')
  AND claim.season_id = head.season_id
  AND claim.generation_seq = head.generation_seq
  AND claim.score_cohort_id = head.score_cohort_id;
UPDATE arena.leaderboard_rank_generation_heads AS head
SET lease_expires_at = claim.lease_expires_at
FROM arena.leaderboard_rank_generation_claims AS claim
WHERE head.season_id IN ('7D', '30D')
  AND claim.season_id = head.season_id
  AND claim.generation_seq = head.generation_seq
  AND claim.score_cohort_id = head.score_cohort_id;
SET LOCAL session_replication_role = origin;
COMMIT;
SQL

CROSS_HOLDER_OUT="$TMP_ROOT/cross-season-holder.out"
CROSS_WAITER_OUT="$TMP_ROOT/cross-season-waiter.out"
PGAPPNAME=generation_cross_season_holder \
  psql_cmd -Atq >"$CROSS_HOLDER_OUT" 2>&1 <<'SQL' &
BEGIN;
SET LOCAL ROLE service_role;
SELECT result->>'generation_seq'
FROM (
  SELECT public.claim_leaderboard_rank_generation(
    '7D',
    'abababab-abab-4bab-8bab-abababababab'::uuid,
    pg_catalog.repeat('a', 64),
    1,
    1,
    '2026-07-25 00:06:00+00'::timestamptz,
    300
  ) AS result
) AS claimed;
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
CROSS_HOLDER_PID=$!

if ! wait_for_activity \
  "generation_cross_season_holder" \
  "Timeout|PgSleep" \
  "$CROSS_HOLDER_PID"; then
  wait "$CROSS_HOLDER_PID" || true
  echo "cross-season UUID holder did not acquire its head" >&2
  exit 1
fi

PGAPPNAME=generation_cross_season_waiter \
  psql_cmd -Atq -c "
    SET ROLE service_role;
    SELECT public.claim_leaderboard_rank_generation(
      '30D',
      'abababab-abab-4bab-8bab-abababababab'::uuid,
      pg_catalog.repeat('b', 64),
      1,
      1,
      '2026-07-25 00:06:01+00'::timestamptz,
      300
    );
  " >"$CROSS_WAITER_OUT" 2>&1 &
CROSS_WAITER_PID=$!

if ! wait_for_lock "generation_cross_season_waiter" "$CROSS_WAITER_PID"; then
  wait "$CROSS_HOLDER_PID" || true
  wait "$CROSS_WAITER_PID" || true
  echo "cross-season UUID waiter did not block on global uniqueness" >&2
  exit 1
fi
wait "$CROSS_HOLDER_PID"
if wait "$CROSS_WAITER_PID"; then
  echo "cross-season generation UUID race accepted two winners" >&2
  exit 1
fi
if ! rg -q "leaderboard_rank_generation_claims_cohort_key" "$CROSS_WAITER_OUT" \
   || [[ "$(psql_cmd -Atqc "SELECT count(*) || '|' || min(season_id) FROM arena.leaderboard_rank_generation_claims WHERE score_cohort_id = 'abababab-abab-4bab-8bab-abababababab';")" != "1|7D" ]] \
   || [[ "$(psql_cmd -Atqc "SELECT generation_seq || '|' || score_cohort_id FROM arena.leaderboard_rank_generation_heads WHERE season_id = '30D';")" != "$LOSING_HEAD_BEFORE" ]]; then
  echo "cross-season generation UUID race persisted more than one winner" >&2
  exit 1
fi

# The final JS-safe sequence is usable, but another claim must fail with 54000
# before inserting a ledger row or changing the head.
psql_cmd -q <<'SQL'
WITH claimed AS (
  SELECT pg_catalog.clock_timestamp() AS claimed_at
)
INSERT INTO arena.leaderboard_rank_generation_claims (
  contract,
  season_id,
  generation_seq,
  score_cohort_id,
  write_set_sha256,
  expected_rank_count,
  expected_batch_count,
  computed_at,
  lease_seconds,
  claimed_at,
  lease_expires_at
)
SELECT
  'leaderboard-rank-generation-claim@1',
  '90D',
  9007199254740000,
  'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid,
  pg_catalog.repeat('f', 64),
  0,
  0,
  '2026-07-25 00:07:00+00'::timestamptz,
  300,
  claimed.claimed_at,
  claimed.claimed_at + interval '300 seconds'
FROM claimed;
UPDATE arena.leaderboard_rank_generation_heads AS head
SET
  generation_seq = claim.generation_seq,
  score_cohort_id = claim.score_cohort_id,
  phase = 'failed',
  lease_expires_at = NULL,
  updated_at = pg_catalog.clock_timestamp()
FROM arena.leaderboard_rank_generation_claims AS claim
WHERE head.season_id = '90D'
  AND claim.season_id = head.season_id
  AND claim.generation_seq = 9007199254740000;
SQL

OVERFLOW_BEFORE="$(psql_cmd -Atqc "SELECT count(*) || '|' || (SELECT generation_seq FROM arena.leaderboard_rank_generation_heads WHERE season_id = '90D') FROM arena.leaderboard_rank_generation_claims;")"
expect_failure \
  "generation sequence overflow accepted another claim" \
  "leaderboard generation sequence exhausted" \
  "SET ROLE service_role; SELECT public.claim_leaderboard_rank_generation('90D','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',repeat('e',64),0,0,'2026-07-25 00:07:01+00',300);"
OVERFLOW_AFTER="$(psql_cmd -Atqc "SELECT count(*) || '|' || (SELECT generation_seq FROM arena.leaderboard_rank_generation_heads WHERE season_id = '90D') FROM arena.leaderboard_rank_generation_claims;")"
if [[ "$OVERFLOW_BEFORE" != "$OVERFLOW_AFTER" ]]; then
  echo "generation sequence overflow changed durable state" >&2
  exit 1
fi

# PostgreSQL inheritance does not copy unique indexes or user triggers. A rogue
# child can therefore accept duplicate UUIDs under its own ACL. Runtime ONLY
# must ignore it, while migration replay must reject either inheritance edge.
psql_cmd -q <<'SQL'
CREATE TABLE arena.leaderboard_rank_generation_claims_shadow ()
INHERITS (arena.leaderboard_rank_generation_claims);
GRANT INSERT, SELECT ON arena.leaderboard_rank_generation_claims_shadow
  TO service_role;
SET ROLE service_role;
WITH claimed AS (
  SELECT pg_catalog.clock_timestamp() AS claimed_at
)
INSERT INTO arena.leaderboard_rank_generation_claims_shadow (
  contract,
  season_id,
  generation_seq,
  score_cohort_id,
  write_set_sha256,
  expected_rank_count,
  expected_batch_count,
  computed_at,
  lease_seconds,
  claimed_at,
  lease_expires_at
)
SELECT
  'leaderboard-rank-generation-claim@1',
  '7D',
  99,
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
  pg_catalog.repeat('c', 64),
  0,
  0,
  '2026-07-25 00:08:00+00'::timestamptz,
  300,
  claimed.claimed_at,
  claimed.claimed_at + interval '300 seconds'
FROM claimed, pg_catalog.generate_series(1, 2);
RESET ROLE;
SQL

expect_failure \
  "inherited generation claims polluted runtime lookup" \
  "leaderboard generation sequence exhausted" \
  "SET ROLE service_role; SELECT public.claim_leaderboard_rank_generation('90D','cccccccc-cccc-4ccc-8ccc-cccccccccccc',repeat('c',64),0,0,'2026-07-25 00:08:00+00',300);"
expect_migration_failure \
  "generation migration accepted an inherited claim child" \
  "generation table owner, RLS, or ACL drifted"
if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM ONLY arena.leaderboard_rank_generation_claims_shadow;")" != "2" ]]; then
  echo "inherited generation drift rejection did not roll back" >&2
  exit 1
fi
psql_cmd -q -c \
  'DROP TABLE arena.leaderboard_rank_generation_claims_shadow;'

psql_cmd -q -c \
  'ALTER TABLE arena.leaderboard_rank_generation_heads DISABLE TRIGGER ALL;'
expect_migration_failure \
  "generation migration accepted disabled FK triggers" \
  "generation foreign-key trigger contract drifted"
if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid = 'arena.leaderboard_rank_generation_heads'::regclass AND tgisinternal AND tgenabled = 'D';")" != "2" ]]; then
  echo "disabled generation FK trigger rejection did not roll back" >&2
  exit 1
fi
psql_cmd -q -c \
  'ALTER TABLE arena.leaderboard_rank_generation_heads ENABLE TRIGGER ALL;'

# Existing relations must remain closed under replay. A rogue user trigger is a
# hard drift failure, and the failed migration must leave it and all data intact.
psql_cmd -q <<'SQL'
CREATE FUNCTION arena.fixture_rogue_generation_head_trigger()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RETURN NEW;
END;
$function$;
CREATE TRIGGER fixture_rogue_generation_head_trigger
BEFORE UPDATE ON arena.leaderboard_rank_generation_heads
FOR EACH ROW
EXECUTE FUNCTION arena.fixture_rogue_generation_head_trigger();

CREATE TABLE public.fixture_rogue_generation_before AS
SELECT
  'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'
    ::regprocedure::oid AS function_oid,
  (
    SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(claim) ORDER BY claim.season_id, claim.generation_seq)
    FROM arena.leaderboard_rank_generation_claims AS claim
  ) AS claim_rows,
  (
    SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(head) ORDER BY head.season_id)
    FROM arena.leaderboard_rank_generation_heads AS head
  ) AS head_rows;
SQL

expect_migration_failure \
  "generation migration accepted a rogue head trigger" \
  "drifted"

psql_cmd -q <<'SQL'
DO $rogue_rollback$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
        'arena.leaderboard_rank_generation_heads'::regclass
      AND trigger_row.tgname = 'fixture_rogue_generation_head_trigger'
      AND NOT trigger_row.tgisinternal
  ) OR EXISTS (
    SELECT 1
    FROM public.fixture_rogue_generation_before AS before
    WHERE before.function_oid IS DISTINCT FROM
        'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'
          ::regprocedure::oid
       OR before.claim_rows IS DISTINCT FROM (
         SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(claim) ORDER BY claim.season_id, claim.generation_seq)
         FROM arena.leaderboard_rank_generation_claims AS claim
       )
       OR before.head_rows IS DISTINCT FROM (
         SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(head) ORDER BY head.season_id)
         FROM arena.leaderboard_rank_generation_heads AS head
       )
  ) THEN
    RAISE EXCEPTION 'rogue generation drift rejection did not roll back';
  END IF;
END
$rogue_rollback$;

DROP TRIGGER fixture_rogue_generation_head_trigger
  ON arena.leaderboard_rank_generation_heads;
DROP FUNCTION arena.fixture_rogue_generation_head_trigger();
SQL

psql_cmd -q -f "$MIGRATION"

# The forward capacity guard must reject pre-existing impossible claims without
# partially installing its constraint. The immutable-row trigger is disabled
# only to remove this deliberately invalid owner fixture after the failed test.
psql_cmd -q <<'SQL'
WITH claimed AS (
  SELECT pg_catalog.clock_timestamp() AS claimed_at
)
INSERT INTO arena.leaderboard_rank_generation_claims (
  contract,
  season_id,
  generation_seq,
  score_cohort_id,
  write_set_sha256,
  expected_rank_count,
  expected_batch_count,
  computed_at,
  lease_seconds,
  claimed_at,
  lease_expires_at
)
SELECT
  'leaderboard-rank-generation-claim@1',
  '7D',
  8000000000000000,
  '71717171-7171-4171-8171-717171717171'::uuid,
  pg_catalog.repeat('7', 64),
  2001,
  2,
  '2026-07-25 00:09:00+00'::timestamptz,
  300,
  claimed.claimed_at,
  claimed.claimed_at + interval '300 seconds'
FROM claimed;
SQL
expect_capacity_migration_failure \
  "capacity migration accepted an impossible existing claim" \
  "existing generation claim exceeds bounded batch capacity"
if [[ "$(psql_cmd -Atqc "SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'arena.leaderboard_rank_generation_claims'::regclass AND conname = 'leaderboard_rank_generation_claims_batch_capacity_check');")" != "t" ]] \
   || [[ "$(psql_cmd -Atqc "SELECT pg_catalog.to_regprocedure('public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)') IS NOT NULL;")" != "t" ]]; then
  echo "failed capacity preflight left partial state" >&2
  exit 1
fi
psql_cmd -q <<'SQL'
ALTER TABLE arena.leaderboard_rank_generation_claims DISABLE TRIGGER USER;
DELETE FROM ONLY arena.leaderboard_rank_generation_claims
WHERE score_cohort_id = '71717171-7171-4171-8171-717171717171'::uuid;
ALTER TABLE arena.leaderboard_rank_generation_claims ENABLE TRIGGER USER;
SQL

# A hostile BEFORE INSERT trigger can rewrite an oversized request into a
# durable smaller claim while the old RPC still echoes the caller's values.
# The upgrade must treat every extra trigger/rule/policy as hostile evidence
# before it rewrites the RPC or installs the capacity constraint.
psql_cmd -q <<'SQL'
DROP TRIGGER leaderboard_rank_generation_claim_immutable
  ON arena.leaderboard_rank_generation_claims;
CREATE TRIGGER leaderboard_rank_generation_claim_immutable
BEFORE UPDATE OF write_set_sha256 OR DELETE
ON arena.leaderboard_rank_generation_claims
FOR EACH ROW
EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();
SQL
expect_capacity_migration_failure \
  "capacity migration accepted a column-restricted immutable trigger" \
  "generation table trigger, rule, or policy drifted"
psql_cmd -q <<'SQL'
DROP TRIGGER leaderboard_rank_generation_claim_immutable
  ON arena.leaderboard_rank_generation_claims;
CREATE TRIGGER leaderboard_rank_generation_claim_immutable
BEFORE UPDATE OR DELETE
ON arena.leaderboard_rank_generation_claims
FOR EACH ROW
EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

CREATE FUNCTION arena.fixture_rewrite_generation_claim()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.expected_rank_count := 1;
  NEW.expected_batch_count := 1;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER fixture_rewrite_generation_claim
BEFORE INSERT ON arena.leaderboard_rank_generation_claims
FOR EACH ROW
EXECUTE FUNCTION arena.fixture_rewrite_generation_claim();
SQL
HOSTILE_TRIGGER_FUNCTION_SHA_BEFORE="$(psql_cmd -Atqc "SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_catalog.pg_proc WHERE oid = 'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'::regprocedure;")"
expect_capacity_migration_failure \
  "capacity migration accepted a claim-rewriting trigger" \
  "generation table trigger, rule, or policy drifted"
if [[ "$(psql_cmd -Atqc "SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_catalog.pg_proc WHERE oid = 'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'::regprocedure;")" != "$HOSTILE_TRIGGER_FUNCTION_SHA_BEFORE" ]] \
   || [[ "$(psql_cmd -Atqc "SELECT to_regclass('arena.leaderboard_rank_generation_claims') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'arena.leaderboard_rank_generation_claims'::regclass AND conname = 'leaderboard_rank_generation_claims_batch_capacity_check');")" != "t" ]]; then
  echo "hostile trigger rejection changed the RPC or installed partial capacity state" >&2
  exit 1
fi
psql_cmd -q <<'SQL'
DROP TRIGGER fixture_rewrite_generation_claim
  ON arena.leaderboard_rank_generation_claims;
DROP FUNCTION arena.fixture_rewrite_generation_claim();

CREATE POLICY fixture_generation_claim_read
ON arena.leaderboard_rank_generation_claims
FOR SELECT
USING (true);
SQL
expect_capacity_migration_failure \
  "capacity migration accepted a rogue claim policy" \
  "generation table trigger, rule, or policy drifted"
psql_cmd -q <<'SQL'
DROP POLICY fixture_generation_claim_read
  ON arena.leaderboard_rank_generation_claims;

CREATE RULE fixture_generation_claim_insert AS
ON INSERT TO arena.leaderboard_rank_generation_claims
DO ALSO NOTHING;
SQL
expect_capacity_migration_failure \
  "capacity migration accepted a rogue claim rule" \
  "generation table trigger, rule, or policy drifted"
psql_cmd -q <<'SQL'
DROP RULE fixture_generation_claim_insert
  ON arena.leaderboard_rank_generation_claims;

ALTER TABLE ONLY arena.leaderboard_rank_generation_claims
  DROP CONSTRAINT leaderboard_rank_generation_claims_cohort_key;
ALTER TABLE ONLY arena.leaderboard_rank_generation_claims
  ADD CONSTRAINT fixture_generation_claims_cohort_key
  UNIQUE (score_cohort_id, season_id);
SQL
expect_capacity_migration_failure \
  "capacity migration accepted a replaced cohort identity constraint" \
  "generation foundational constraint contract drifted"
psql_cmd -q <<'SQL'
ALTER TABLE ONLY arena.leaderboard_rank_generation_claims
  DROP CONSTRAINT fixture_generation_claims_cohort_key;
ALTER TABLE ONLY arena.leaderboard_rank_generation_claims
  ADD CONSTRAINT leaderboard_rank_generation_claims_cohort_key
  UNIQUE (score_cohort_id);
SQL

psql_cmd -q -f "$CAPACITY_MIGRATION"
CAPACITY_OID_BEFORE="$(psql_cmd -Atqc "SELECT oid FROM pg_catalog.pg_constraint WHERE conrelid = 'arena.leaderboard_rank_generation_claims'::regclass AND conname = 'leaderboard_rank_generation_claims_batch_capacity_check';")"
CAPACITY_FUNCTION_OID_BEFORE="$(psql_cmd -Atqc "SELECT 'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'::regprocedure::oid;")"
CAPACITY_FUNCTION_SHA_BEFORE="$(psql_cmd -Atqc "SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_catalog.pg_proc WHERE oid = 'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'::regprocedure;")"
CAPACITY_STATE_BEFORE="$(psql_cmd -Atqc "SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(claim) ORDER BY claim.season_id, claim.generation_seq)::text FROM ONLY arena.leaderboard_rank_generation_claims AS claim;")"
psql_cmd -q -f "$CAPACITY_MIGRATION"
CAPACITY_OID_AFTER="$(psql_cmd -Atqc "SELECT oid FROM pg_catalog.pg_constraint WHERE conrelid = 'arena.leaderboard_rank_generation_claims'::regclass AND conname = 'leaderboard_rank_generation_claims_batch_capacity_check';")"
CAPACITY_FUNCTION_OID_AFTER="$(psql_cmd -Atqc "SELECT 'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'::regprocedure::oid;")"
CAPACITY_FUNCTION_SHA_AFTER="$(psql_cmd -Atqc "SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_catalog.pg_proc WHERE oid = 'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'::regprocedure;")"
CAPACITY_STATE_AFTER="$(psql_cmd -Atqc "SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(claim) ORDER BY claim.season_id, claim.generation_seq)::text FROM ONLY arena.leaderboard_rank_generation_claims AS claim;")"
if [[ -z "$CAPACITY_OID_BEFORE" ]] \
   || [[ "$CAPACITY_OID_BEFORE" != "$CAPACITY_OID_AFTER" ]] \
   || [[ "$CAPACITY_FUNCTION_OID_BEFORE" != "$CAPACITY_FUNCTION_OID_AFTER" ]] \
   || [[ "$CAPACITY_FUNCTION_SHA_BEFORE" != "09f136557ede5e00ef5c519736c81abf44ea7780f336e216591304a746a746a2" ]] \
   || [[ "$CAPACITY_FUNCTION_SHA_BEFORE" != "$CAPACITY_FUNCTION_SHA_AFTER" ]] \
   || [[ "$CAPACITY_STATE_BEFORE" != "$CAPACITY_STATE_AFTER" ]]; then
  echo "capacity migration replay changed RPC, constraint identity, or claim state" >&2
  exit 1
fi

# Both dimensions fail at the RPC boundary and leave the generation head
# untouched. The exact capacity boundary remains claimable and replayable.
psql_cmd -q <<'SQL'
UPDATE ONLY arena.leaderboard_rank_generation_heads
SET phase = 'failed', lease_expires_at = NULL, updated_at = pg_catalog.clock_timestamp()
WHERE season_id = '30D';
SQL
CAPACITY_HEAD_BEFORE="$(psql_cmd -Atqc "SELECT pg_catalog.to_jsonb(head)::text FROM ONLY arena.leaderboard_rank_generation_heads AS head WHERE season_id = '30D';")"
CAPACITY_CLAIM_COUNT_BEFORE="$(psql_cmd -Atqc 'SELECT count(*) FROM ONLY arena.leaderboard_rank_generation_claims;')"
expect_failure \
  "generation claim exceeded one-batch row capacity" \
  "generation rank and batch counts are inconsistent" \
  "SET ROLE service_role; SELECT public.claim_leaderboard_rank_generation('30D','72727272-7272-4272-8272-727272727272',repeat('7',64),1001,1,'2026-07-25 00:10:00+00',300);"
expect_failure \
  "generation claim exceeded receipt capacity" \
  "generation rank and batch counts are inconsistent" \
  "SET ROLE service_role; SELECT public.claim_leaderboard_rank_generation('30D','73737373-7373-4373-8373-737373737373',repeat('7',64),4097,4097,'2026-07-25 00:10:00+00',300);"
expect_failure \
  "generation claim exceeded authoritative scorer capacity" \
  "generation rank and batch counts are inconsistent" \
  "SET ROLE service_role; SELECT public.claim_leaderboard_rank_generation('30D','75757575-7575-4575-8575-757575757575',repeat('7',64),64001,65,'2026-07-25 00:10:00+00',300);"
if [[ "$CAPACITY_HEAD_BEFORE" != "$(psql_cmd -Atqc "SELECT pg_catalog.to_jsonb(head)::text FROM ONLY arena.leaderboard_rank_generation_heads AS head WHERE season_id = '30D';")" ]] \
   || [[ "$CAPACITY_CLAIM_COUNT_BEFORE" != "$(psql_cmd -Atqc 'SELECT count(*) FROM ONLY arena.leaderboard_rank_generation_claims;')" ]]; then
  echo "rejected capacity claims changed durable state" >&2
  exit 1
fi

CAPACITY_BOUNDARY="$(psql_cmd -Atqc "SET ROLE service_role; SELECT (result->>'expected_rank_count') || '|' || (result->>'expected_batch_count') FROM (SELECT public.claim_leaderboard_rank_generation('30D','74747474-7474-4474-8474-747474747474',repeat('7',64),64000,64,'2026-07-25 00:10:00+00',300) AS result) AS claimed;")"
if [[ "$CAPACITY_BOUNDARY" != "64000|64" ]]; then
  echo "generation claim rejected the exact scorer and batch capacity boundary" >&2
  exit 1
fi

# Same-name weakened drift is evidence, never something replay may converge.
psql_cmd -q <<'SQL'
ALTER TABLE ONLY arena.leaderboard_rank_generation_claims
  DROP CONSTRAINT leaderboard_rank_generation_claims_batch_capacity_check;
ALTER TABLE ONLY arena.leaderboard_rank_generation_claims
  ADD CONSTRAINT leaderboard_rank_generation_claims_batch_capacity_check
  CHECK (expected_batch_count <= 5000);
SQL
expect_capacity_migration_failure \
  "capacity migration accepted a weakened same-name constraint" \
  "generation batch capacity constraint drifted"
psql_cmd -q <<'SQL'
ALTER TABLE ONLY arena.leaderboard_rank_generation_claims
  DROP CONSTRAINT leaderboard_rank_generation_claims_batch_capacity_check;
ALTER TABLE ONLY arena.leaderboard_rank_generation_claims
  ADD CONSTRAINT leaderboard_rank_generation_claims_batch_capacity_check
  CHECK (
    expected_batch_count <= 4096
    AND expected_rank_count <= 64000
    AND expected_rank_count::bigint <=
      expected_batch_count::bigint * 1000
  );
SQL
psql_cmd -q -f "$CAPACITY_MIGRATION"

# A same-signature hostile body after installation must not be converged back
# to trusted code by replay. Put this final because the intentionally hostile
# body should remain installed after the expected failure.
psql_cmd -q <<'SQL'
CREATE OR REPLACE FUNCTION public.claim_leaderboard_rank_generation(
  p_season_id text,
  p_score_cohort_id uuid,
  p_write_set_sha256 text,
  p_expected_rank_count integer,
  p_expected_batch_count integer,
  p_computed_at timestamptz,
  p_lease_seconds integer
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '10s'
AS $function$
  SELECT pg_catalog.jsonb_build_object('hostile', true)
$function$;
SQL
HOSTILE_FUNCTION_SHA="$(psql_cmd -Atqc "SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_catalog.pg_proc WHERE oid = 'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'::regprocedure;")"
expect_capacity_migration_failure \
  "capacity migration repaired a hostile same-signature RPC" \
  "generation claim RPC body does not match the install state"
if [[ "$HOSTILE_FUNCTION_SHA" != "$(psql_cmd -Atqc "SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_catalog.pg_proc WHERE oid = 'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'::regprocedure;")" ]]; then
  echo "hostile claim RPC rejection silently repaired function evidence" >&2
  exit 1
fi

echo "leaderboard rank generation claim PG17 proof passed"
