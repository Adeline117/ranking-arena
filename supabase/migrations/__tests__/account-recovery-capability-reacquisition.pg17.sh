#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729075000_account_recovery_capability_reacquisition.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
for executable in initdb pg_ctl psql; do
  [[ -x "$PG_BIN/$executable" ]] || {
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  }
done
[[ "$("$PG_BIN/psql" --version)" == psql\ \(PostgreSQL\)\ 17.* ]] || {
  echo 'PostgreSQL 17 required' >&2
  exit 1
}

TMP_ROOT="$(mktemp -d /tmp/account-recovery-reacquisition-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55539
mkdir -p "$SOCKET_DIR" "$LOG_DIR"
cleanup() {
  local status=$?
  ((status == 0)) || tail -200 "$LOG_DIR/postgres.log" >&2 || true
  [[ ! -s "$DATA_DIR/postmaster.pid" ]] ||
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

"$PG_BIN/initdb" -D "$DATA_DIR" --auth-local=trust --auth-host=trust \
  --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_DIR/postgres.log" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null
psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE authenticator NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE leaked_default_role NOLOGIN;
CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE SCHEMA extensions AUTHORIZATION postgres;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
AS $function$
  SELECT pg_catalog.current_setting('request.jwt.claim.role', true)
$function$;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email text,
  encrypted_password text
);
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  email text,
  deleted_at timestamptz,
  deletion_scheduled_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz
);
CREATE TABLE public.account_recovery_tokens (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE TABLE public.account_recovery_admissions (
  operation_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  recovery_token_hash text,
  state text NOT NULL,
  claimed_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  finished_at timestamptz,
  aborted_at timestamptz,
  abort_reason text,
  updated_at timestamptz NOT NULL,
  auth_finalization_capability_hash text,
  auth_finalization_state text,
  auth_finalization_prepared_at timestamptz,
  auth_finalization_attempt_id uuid,
  auth_finalization_attempt_expires_at timestamptz,
  auth_finalized_at timestamptz,
  recovery_billing_resumed boolean,
  recovery_billing_may_have_changed boolean,
  recovery_billing_target_snapshot jsonb,
  recovery_billing_target_digest text,
  recovery_billing_v2_result jsonb
);
CREATE UNIQUE INDEX account_recovery_one_unfinished_finalization_v2
  ON public.account_recovery_admissions (user_id)
  WHERE state IN ('claimed', 'finished')
    AND (
      auth_finalization_state IS NULL
      OR auth_finalization_state NOT IN ('completed', 'superseded')
    );
CREATE TABLE public.account_deletion_auth_fences (
  user_id uuid PRIMARY KEY,
  operation_id uuid NOT NULL,
  recovery_token_hash text NOT NULL,
  state text NOT NULL
);
CREATE TABLE public.account_hard_deletion_fences (
  user_id uuid PRIMARY KEY,
  state text NOT NULL
);
CREATE TABLE public.account_deletion_one_time_settlements (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  settlement_status text NOT NULL
);
CREATE TABLE public.account_recovery_password_guards (
  user_id uuid PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  failure_count integer NOT NULL CHECK (failure_count BETWEEN 1 AND 5),
  locked_until timestamptz,
  updated_at timestamptz NOT NULL
);

ALTER TABLE auth.users OWNER TO postgres;
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.account_recovery_tokens OWNER TO postgres;
ALTER TABLE public.account_recovery_admissions OWNER TO postgres;
ALTER TABLE public.account_deletion_auth_fences OWNER TO postgres;
ALTER TABLE public.account_hard_deletion_fences OWNER TO postgres;
ALTER TABLE public.account_deletion_one_time_settlements OWNER TO postgres;
ALTER TABLE public.account_recovery_password_guards OWNER TO postgres;

ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
  TO leaked_default_role;
ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO leaked_default_role;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $acl_contract$
DECLARE
  v_external regprocedure[] := ARRAY[
    'public.status_account_recovery_capability_reacquisition_atomic(uuid,text)'::regprocedure,
    'public.locate_account_recovery_capability_reacquisition_atomic(text,text,text)'::regprocedure,
    'public.attest_account_recovery_capability_reacquisition_atomic(uuid,text,text,text)'::regprocedure
  ];
BEGIN
  IF has_table_privilege(
      'service_role',
      'public.account_recovery_capability_reacquisition_tickets',
      'SELECT,INSERT,UPDATE,DELETE'
    )
    OR has_table_privilege(
      'leaked_default_role',
      'public.account_recovery_capability_reacquisition_tickets',
      'SELECT,INSERT,UPDATE,DELETE'
    )
    OR has_function_privilege(
      'service_role',
      'public.resolve_account_recovery_capability_reacquisition_candidate_v1(uuid,text,uuid)',
      'EXECUTE'
    )
    OR EXISTS (
      SELECT 1 FROM unnest(v_external) AS function_oid
      WHERE NOT has_function_privilege('service_role', function_oid, 'EXECUTE')
        OR has_function_privilege('leaked_default_role', function_oid, 'EXECUTE')
    )
  THEN
    RAISE EXCEPTION 'reacquisition ACLs are not service-role-only';
  END IF;
END
$acl_contract$;

INSERT INTO auth.users (id, email, encrypted_password)
SELECT fixture.user_id, fixture.email,
  extensions.crypt('correct-password', extensions.gen_salt('bf', 10))
FROM (VALUES
  ('11111111-1111-4111-8111-111111111111'::uuid, 'initial@example.test'),
  ('22222222-2222-4222-8222-222222222222'::uuid, 'prepared@example.test'),
  ('33333333-3333-4333-8333-333333333333'::uuid, 'finished@example.test'),
  ('44444444-4444-4444-8444-444444444444'::uuid, 'password@example.test'),
  ('55555555-5555-4555-8555-555555555555'::uuid, 'manual@example.test'),
  ('66666666-6666-4666-8666-666666666666'::uuid, 'duplicate@example.test')
) AS fixture(user_id, email);

INSERT INTO public.user_profiles (
  id, email, deleted_at, deletion_scheduled_at
)
SELECT auth_user.id, auth_user.email,
  CASE WHEN auth_user.id IN (
    '11111111-1111-4111-8111-111111111111'::uuid,
    '22222222-2222-4222-8222-222222222222'::uuid,
    '55555555-5555-4555-8555-555555555555'::uuid,
    '66666666-6666-4666-8666-666666666666'::uuid
  ) THEN clock_timestamp() ELSE NULL END,
  CASE WHEN auth_user.id IN (
    '11111111-1111-4111-8111-111111111111'::uuid,
    '22222222-2222-4222-8222-222222222222'::uuid,
    '55555555-5555-4555-8555-555555555555'::uuid,
    '66666666-6666-4666-8666-666666666666'::uuid
  ) THEN clock_timestamp() + interval '20 days' ELSE NULL END
FROM auth.users AS auth_user;

INSERT INTO public.account_recovery_tokens (
  user_id, token_hash, expires_at, used_at
)
VALUES
  ('11111111-1111-4111-8111-111111111111', repeat('1',64), clock_timestamp()+interval '20 days', NULL),
  ('22222222-2222-4222-8222-222222222222', repeat('2',64), clock_timestamp()+interval '20 days', NULL),
  ('33333333-3333-4333-8333-333333333333', repeat('3',64), clock_timestamp()+interval '20 days', clock_timestamp()),
  ('55555555-5555-4555-8555-555555555555', repeat('5',64), clock_timestamp()+interval '20 days', NULL),
  ('66666666-6666-4666-8666-666666666666', repeat('6',64), clock_timestamp()+interval '20 days', NULL);

INSERT INTO public.account_deletion_auth_fences (
  user_id, operation_id, recovery_token_hash, state
)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', repeat('1',64), 'completed'),
  ('22222222-2222-4222-8222-222222222222', 'a2222222-2222-4222-8222-222222222222', repeat('2',64), 'completed'),
  ('33333333-3333-4333-8333-333333333333', 'a3333333-3333-4333-8333-333333333333', repeat('3',64), 'completed'),
  ('55555555-5555-4555-8555-555555555555', 'a5555555-5555-4555-8555-555555555555', repeat('5',64), 'completed'),
  ('66666666-6666-4666-8666-666666666666', 'a6666666-6666-4666-8666-666666666666', repeat('6',64), 'completed');

INSERT INTO public.account_recovery_admissions (
  operation_id, user_id, recovery_token_hash, state, claimed_at,
  lease_expires_at, finished_at, updated_at,
  auth_finalization_capability_hash, auth_finalization_state,
  auth_finalization_prepared_at
)
VALUES
  ('b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', repeat('2',64), 'claimed', clock_timestamp(), clock_timestamp()+interval '1 hour', NULL, clock_timestamp(), repeat('a',64), 'prepared', clock_timestamp()),
  ('b3333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333333', repeat('3',64), 'finished', clock_timestamp(), clock_timestamp()+interval '1 hour', clock_timestamp(), clock_timestamp(), repeat('b',64), 'pending', clock_timestamp()),
  ('b4444444-4444-4444-8444-444444444444', '44444444-4444-4444-8444-444444444444', NULL, 'finished', clock_timestamp(), clock_timestamp()+interval '1 hour', clock_timestamp(), clock_timestamp(), repeat('c',64), 'billing_pending', clock_timestamp()),
  ('b5555555-5555-4555-8555-555555555555', '55555555-5555-4555-8555-555555555555', repeat('5',64), 'finished', clock_timestamp(), clock_timestamp()+interval '1 hour', clock_timestamp(), clock_timestamp(), repeat('d',64), 'expired_manual', clock_timestamp());
SQL

psql_cmd <<'SQL'
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;

DO $initial_absent_and_status$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.locate_account_recovery_capability_reacquisition_atomic(
    repeat('1',64), NULL, NULL
  );
  IF v_result IS DISTINCT FROM '{"status":"absent"}'::jsonb THEN
    RAISE EXCEPTION 'initial recovery did not return exact absent: %', v_result;
  END IF;
  v_result := public.status_account_recovery_capability_reacquisition_atomic(
    'a1111111-1111-4111-8111-111111111111', repeat('1',64)
  );
  IF v_result IS DISTINCT FROM '{"status":"available"}'::jsonb THEN
    RAISE EXCEPTION 'initial fallback status was not available: %', v_result;
  END IF;
END
$initial_absent_and_status$;

DO $prepared_current_and_replay$
DECLARE
  v_located jsonb;
  v_attested jsonb;
  v_replay jsonb;
BEGIN
  v_located := public.locate_account_recovery_capability_reacquisition_atomic(
    repeat('2',64), NULL, NULL
  );
  IF (SELECT count(*) FROM jsonb_object_keys(v_located)) <> 5
    OR v_located ->> 'status' <> 'located'
    OR v_located ->> 'operation_id' <> 'b2222222-2222-4222-8222-222222222222'
    OR length(v_located ->> 'reacquisition_proof') <> 43
  THEN
    RAISE EXCEPTION 'prepared token locator drifted: %', v_located;
  END IF;
  v_attested := public.attest_account_recovery_capability_reacquisition_atomic(
    (v_located ->> 'reacquisition_id')::uuid,
    v_located ->> 'reacquisition_proof',
    repeat('a',64),
    repeat('e',64)
  );
  IF v_attested ->> 'status' <> 'reacquired'
    OR v_attested ->> 'candidate_index' <> '0'
    OR v_attested ->> 'auth_finalization_state' <> 'prepared'
  THEN
    RAISE EXCEPTION 'current capability attestation drifted: %', v_attested;
  END IF;
  v_replay := public.attest_account_recovery_capability_reacquisition_atomic(
    (v_located ->> 'reacquisition_id')::uuid,
    v_located ->> 'reacquisition_proof',
    repeat('a',64),
    repeat('e',64)
  );
  IF v_replay IS DISTINCT FROM '{"status":"invalid"}'::jsonb THEN
    RAISE EXCEPTION 'consumed ticket replay succeeded: %', v_replay;
  END IF;
END
$prepared_current_and_replay$;

DO $used_token_previous_rotation$
DECLARE
  v_located jsonb;
  v_no_match jsonb;
  v_attested jsonb;
  v_status jsonb;
BEGIN
  v_status := public.status_account_recovery_capability_reacquisition_atomic(
    'a3333333-3333-4333-8333-333333333333', repeat('3',64)
  );
  IF v_status IS DISTINCT FROM '{"status":"available"}'::jsonb THEN
    RAISE EXCEPTION 'used admission-bound token was not discoverable: %', v_status;
  END IF;
  v_located := public.locate_account_recovery_capability_reacquisition_atomic(
    repeat('3',64), NULL, NULL
  );
  v_no_match := public.attest_account_recovery_capability_reacquisition_atomic(
    (v_located ->> 'reacquisition_id')::uuid,
    v_located ->> 'reacquisition_proof',
    repeat('8',64),
    repeat('9',64)
  );
  IF v_no_match IS DISTINCT FROM '{"status":"invalid"}'::jsonb THEN
    RAISE EXCEPTION 'rotation mismatch was not fail closed: %', v_no_match;
  END IF;
  v_attested := public.attest_account_recovery_capability_reacquisition_atomic(
    (v_located ->> 'reacquisition_id')::uuid,
    v_located ->> 'reacquisition_proof',
    repeat('8',64),
    repeat('b',64)
  );
  IF v_attested ->> 'status' <> 'reacquired'
    OR v_attested ->> 'candidate_index' <> '1'
    OR v_attested ->> 'auth_finalization_state' <> 'pending'
  THEN
    RAISE EXCEPTION 'previous capability attestation drifted: %', v_attested;
  END IF;
END
$used_token_previous_rotation$;

DO $password_bcrypt_ticket$
DECLARE
  v_located jsonb;
  v_attested jsonb;
BEGIN
  v_located := public.locate_account_recovery_capability_reacquisition_atomic(
    NULL, 'password@example.test', 'correct-password'
  );
  IF v_located ->> 'status' <> 'located' THEN
    RAISE EXCEPTION 'password locator did not verify bcrypt authority: %', v_located;
  END IF;
  v_attested := public.attest_account_recovery_capability_reacquisition_atomic(
    (v_located ->> 'reacquisition_id')::uuid,
    v_located ->> 'reacquisition_proof',
    repeat('c',64),
    NULL
  );
  IF v_attested ->> 'status' <> 'reacquired'
    OR v_attested ->> 'candidate_index' <> '0'
  THEN
    RAISE EXCEPTION 'password ticket attestation drifted: %', v_attested;
  END IF;
END
$password_bcrypt_ticket$;

DO $password_can_reacquire_token_origin$
DECLARE
  v_located jsonb;
  v_attested jsonb;
BEGIN
  v_located := public.locate_account_recovery_capability_reacquisition_atomic(
    NULL, 'prepared@example.test', 'correct-password'
  );
  IF v_located ->> 'status' <> 'located'
    OR v_located ->> 'operation_id'
      <> 'b2222222-2222-4222-8222-222222222222'
  THEN
    RAISE EXCEPTION 'password could not reacquire a token-origin operation: %', v_located;
  END IF;
  v_attested := public.attest_account_recovery_capability_reacquisition_atomic(
    (v_located ->> 'reacquisition_id')::uuid,
    v_located ->> 'reacquisition_proof',
    repeat('a',64),
    NULL
  );
  IF v_attested ->> 'status' <> 'reacquired' THEN
    RAISE EXCEPTION 'password token-origin attestation drifted: %', v_attested;
  END IF;
END
$password_can_reacquire_token_origin$;

RESET ROLE;

DO $strict_email_identity$
DECLARE
  v_result jsonb;
BEGIN
  UPDATE auth.users
  SET email = 'auth-drift@example.test'
  WHERE id = '44444444-4444-4444-8444-444444444444';
  v_result := public.locate_account_recovery_capability_reacquisition_atomic(
    NULL, 'password@example.test', 'correct-password'
  );
  IF v_result IS DISTINCT FROM '{"status":"invalid"}'::jsonb THEN
    RAISE EXCEPTION 'Auth/profile/input email drift was accepted: %', v_result;
  END IF;
  UPDATE auth.users
  SET email = 'password@example.test'
  WHERE id = '44444444-4444-4444-8444-444444444444';

  UPDATE public.user_profiles
  SET email = 'profile-drift@example.test'
  WHERE id = '44444444-4444-4444-8444-444444444444';
  v_result := public.locate_account_recovery_capability_reacquisition_atomic(
    NULL, 'password@example.test', 'correct-password'
  );
  IF v_result IS DISTINCT FROM '{"status":"invalid"}'::jsonb THEN
    RAISE EXCEPTION 'profile/Auth/input email drift was accepted: %', v_result;
  END IF;
  UPDATE public.user_profiles
  SET email = 'password@example.test'
  WHERE id = '44444444-4444-4444-8444-444444444444';
END
$strict_email_identity$;

DO $single_active_proof$
DECLARE
  v_first jsonb;
  v_second jsonb;
  v_result jsonb;
BEGIN
  v_first := public.locate_account_recovery_capability_reacquisition_atomic(
    repeat('2',64), NULL, NULL
  );
  v_second := public.locate_account_recovery_capability_reacquisition_atomic(
    repeat('2',64), NULL, NULL
  );
  IF (
    SELECT pg_catalog.count(*)
    FROM public.account_recovery_capability_reacquisition_tickets AS ticket
    WHERE ticket.operation_id = 'b2222222-2222-4222-8222-222222222222'
      AND ticket.consumed_at IS NULL
      AND ticket.revoked_at IS NULL
  ) <> 1 OR (
    SELECT ticket.revoked_at IS NULL
    FROM public.account_recovery_capability_reacquisition_tickets AS ticket
    WHERE ticket.id = (v_first ->> 'reacquisition_id')::uuid
  ) THEN
    RAISE EXCEPTION 'one-active-proof invariant drifted';
  END IF;
  v_result := public.attest_account_recovery_capability_reacquisition_atomic(
    (v_first ->> 'reacquisition_id')::uuid,
    v_first ->> 'reacquisition_proof',
    repeat('a',64),
    NULL
  );
  IF v_result IS DISTINCT FROM '{"status":"invalid"}'::jsonb THEN
    RAISE EXCEPTION 'superseded proof remained usable: %', v_result;
  END IF;
  v_result := public.attest_account_recovery_capability_reacquisition_atomic(
    (v_second ->> 'reacquisition_id')::uuid,
    v_second ->> 'reacquisition_proof',
    repeat('a',64),
    NULL
  );
  IF v_result ->> 'status' <> 'reacquired' THEN
    RAISE EXCEPTION 'newest proof was not usable: %', v_result;
  END IF;
END
$single_active_proof$;

DO $ticket_foreign_keys_cascade$
DECLARE
  v_user_id uuid := '77777777-7777-4777-8777-777777777777';
  v_admission_id uuid := 'b7777777-7777-4777-8777-777777777771';
  v_ticket_id uuid := 'c7777777-7777-4777-8777-777777777771';
BEGIN
  INSERT INTO auth.users (id, email, encrypted_password)
  VALUES (v_user_id, 'cascade@example.test', NULL);
  INSERT INTO public.account_recovery_admissions (
    operation_id, user_id, state, claimed_at, lease_expires_at, updated_at
  ) VALUES (
    v_admission_id, v_user_id, 'aborted', clock_timestamp(),
    clock_timestamp() + interval '1 hour', clock_timestamp()
  );
  INSERT INTO public.account_recovery_capability_reacquisition_tickets (
    id, user_id, operation_id, locator_kind, recovery_token_hash,
    credential_snapshot_hash, proof_hash, issued_at, expires_at
  ) VALUES (
    v_ticket_id, v_user_id, v_admission_id, 'token', repeat('7',64),
    repeat('8',64), repeat('9',64), clock_timestamp(),
    clock_timestamp() + interval '15 minutes'
  );
  DELETE FROM public.account_recovery_admissions
  WHERE operation_id = v_admission_id;
  IF EXISTS (
    SELECT 1
    FROM public.account_recovery_capability_reacquisition_tickets
    WHERE id = v_ticket_id
  ) THEN
    RAISE EXCEPTION 'admission delete did not cascade ticket';
  END IF;

  v_admission_id := 'b7777777-7777-4777-8777-777777777772';
  v_ticket_id := 'c7777777-7777-4777-8777-777777777772';
  INSERT INTO public.account_recovery_admissions (
    operation_id, user_id, state, claimed_at, lease_expires_at, updated_at
  ) VALUES (
    v_admission_id, v_user_id, 'aborted', clock_timestamp(),
    clock_timestamp() + interval '1 hour', clock_timestamp()
  );
  INSERT INTO public.account_recovery_capability_reacquisition_tickets (
    id, user_id, operation_id, locator_kind, recovery_token_hash,
    credential_snapshot_hash, proof_hash, issued_at, expires_at
  ) VALUES (
    v_ticket_id, v_user_id, v_admission_id, 'token', repeat('7',64),
    repeat('8',64), repeat('9',64), clock_timestamp(),
    clock_timestamp() + interval '15 minutes'
  );
  DELETE FROM auth.users WHERE id = v_user_id;
  IF EXISTS (
    SELECT 1
    FROM public.account_recovery_capability_reacquisition_tickets
    WHERE id = v_ticket_id
  ) THEN
    RAISE EXCEPTION 'Auth user delete did not cascade ticket';
  END IF;
END
$ticket_foreign_keys_cascade$;

SET ROLE service_role;

DO $unsafe_states_fail_closed$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.locate_account_recovery_capability_reacquisition_atomic(
    repeat('5',64), NULL, NULL
  );
  IF v_result IS DISTINCT FROM '{"status":"invalid"}'::jsonb THEN
    RAISE EXCEPTION 'expired_manual operation was reacquired: %', v_result;
  END IF;
  v_result := public.status_account_recovery_capability_reacquisition_atomic(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', repeat('1',64)
  );
  IF v_result IS DISTINCT FROM '{"status":"unavailable"}'::jsonb THEN
    RAISE EXCEPTION 'wrong fallback operation was available: %', v_result;
  END IF;
END
$unsafe_states_fail_closed$;
SQL

# The status authority must not issue a ticket or persist any other row change.
before_status="$(psql_cmd -Atq -c "SELECT count(*) FROM public.account_recovery_capability_reacquisition_tickets")"
psql_cmd -q <<'SQL'
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT public.status_account_recovery_capability_reacquisition_atomic(
  'a1111111-1111-4111-8111-111111111111', repeat('1',64)
);
SQL
after_status="$(psql_cmd -Atq -c "SELECT count(*) FROM public.account_recovery_capability_reacquisition_tickets")"
[[ "$before_status" == "$after_status" ]] || {
  echo 'fallback status created a durable ticket' >&2
  exit 1
}

# Five password failures are durable for fifteen minutes and a correct sixth
# attempt cannot bypass the lock.
psql_cmd -q <<'SQL'
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT public.locate_account_recovery_capability_reacquisition_atomic(
  NULL, 'initial@example.test', 'wrong-password'
) FROM generate_series(1,5);
DO $password_guard_is_durable$
DECLARE v_result jsonb;
BEGIN
  v_result := public.locate_account_recovery_capability_reacquisition_atomic(
    NULL, 'initial@example.test', 'correct-password'
  );
  IF v_result IS DISTINCT FROM '{"status":"invalid"}'::jsonb THEN
    RAISE EXCEPTION 'password guard was bypassed: %', v_result;
  END IF;
END
;
$password_guard_is_durable$;
SQL
psql_cmd -Atq <<'SQL' | grep -qx '5|true'
SELECT failure_count || '|' || (locked_until > clock_timestamp())::text
FROM public.account_recovery_password_guards
WHERE user_id = '11111111-1111-4111-8111-111111111111';
SQL

# One ticket has exactly one concurrent winner.
located="$({ psql_cmd -Atq <<'SQL'
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT (result ->> 'reacquisition_id') || '|' || (result ->> 'reacquisition_proof')
FROM (
  SELECT public.locate_account_recovery_capability_reacquisition_atomic(
    repeat('2',64), NULL, NULL
  ) AS result
) AS located;
SQL
} | tail -n 1)"
ticket_id="${located%%|*}"
ticket_proof="${located#*|}"
attest_once() {
  local output_file="$1"
  psql_cmd -Atq >"$output_file" <<SQL
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT public.attest_account_recovery_capability_reacquisition_atomic(
  '$ticket_id', '$ticket_proof', repeat('a',64), repeat('e',64)
) ->> 'status';
SQL
}
attest_once "$TMP_ROOT/attest-1" & first_pid=$!
attest_once "$TMP_ROOT/attest-2" & second_pid=$!
wait "$first_pid" "$second_pid"
sort "$TMP_ROOT/attest-1" "$TMP_ROOT/attest-2" >"$TMP_ROOT/attest-results"
diff -u <(printf 'invalid\nreacquired\n') "$TMP_ROOT/attest-results"

# A ticket snapshots password authority. A password rotation between locator and
# attestation invalidates it without consuming another external capability.
password_ticket="$({ psql_cmd -Atq <<'SQL'
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT (result ->> 'reacquisition_id') || '|' || (result ->> 'reacquisition_proof')
FROM (
  SELECT public.locate_account_recovery_capability_reacquisition_atomic(
    NULL, 'password@example.test', 'correct-password'
  ) AS result
) AS located;
SQL
} | tail -n 1)"
password_ticket_id="${password_ticket%%|*}"
password_ticket_proof="${password_ticket#*|}"
psql_cmd -q <<'SQL'
UPDATE auth.users
SET encrypted_password = extensions.crypt(
  'rotated-password', extensions.gen_salt('bf',10)
)
WHERE id = '44444444-4444-4444-8444-444444444444';
SQL
psql_cmd -Atq <<SQL | grep -qx 'invalid'
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT public.attest_account_recovery_capability_reacquisition_atomic(
  '$password_ticket_id', '$password_ticket_proof', repeat('c',64), NULL
) ->> 'status';
SQL

# The table stores only proof/credential hashes, never raw passwords, raw proof,
# or a derived HMAC capability. Its ticket lifetime is exactly bounded to 15m.
psql_cmd <<'SQL'
DO $ticket_storage_is_hash_only$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'account_recovery_capability_reacquisition_tickets'
      AND column_name IN ('password', 'capability', 'reacquisition_proof')
  ) OR EXISTS (
    SELECT 1
    FROM public.account_recovery_capability_reacquisition_tickets AS ticket
    WHERE ticket.proof_hash !~ '^[0-9a-f]{64}$'
      OR ticket.credential_snapshot_hash !~ '^[0-9a-f]{64}$'
      OR ticket.expires_at > ticket.issued_at + interval '15 minutes'
  ) THEN
    RAISE EXCEPTION 'ticket storage retained raw authority or exceeded 15m';
  END IF;
END
$ticket_storage_is_hash_only$;
SQL

# Runtime duplicate defense remains fail-closed even if the deployment index is
# later corrupted or removed.
psql_cmd <<'SQL'
DROP INDEX public.account_recovery_one_unfinished_finalization_v2;
INSERT INTO public.account_recovery_admissions (
  operation_id, user_id, recovery_token_hash, state, claimed_at,
  lease_expires_at, updated_at, auth_finalization_capability_hash,
  auth_finalization_state, auth_finalization_prepared_at
)
VALUES
  ('b6666666-6666-4666-8666-666666666661', '66666666-6666-4666-8666-666666666666', repeat('6',64), 'claimed', clock_timestamp(), clock_timestamp()+interval '1 hour', clock_timestamp(), repeat('6',64), 'prepared', clock_timestamp()),
  ('b6666666-6666-4666-8666-666666666662', '66666666-6666-4666-8666-666666666666', repeat('6',64), 'claimed', clock_timestamp(), clock_timestamp()+interval '1 hour', clock_timestamp(), repeat('6',64), 'prepared', clock_timestamp());
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
DO $duplicate_unfinished_is_invalid$
DECLARE v_result jsonb;
BEGIN
  v_result := public.locate_account_recovery_capability_reacquisition_atomic(
    repeat('6',64), NULL, NULL
  );
  IF v_result IS DISTINCT FROM '{"status":"invalid"}'::jsonb THEN
    RAISE EXCEPTION 'duplicate unfinished recovery was not fail closed: %', v_result;
  END IF;
END
$duplicate_unfinished_is_invalid$;
SQL

echo 'account recovery capability reacquisition PG17 tests passed'
