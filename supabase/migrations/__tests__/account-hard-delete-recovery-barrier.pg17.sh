#!/usr/bin/env bash

# PostgreSQL 17 proof that account recovery and expired hard deletion share one
# admission boundary, including requests that wait across the grace deadline.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RECOVERY_MIGRATION="$ROOT_DIR/supabase/migrations/20260729022500_account_recovery_admission_state_machine.sql"
BARRIER_MIGRATION="$ROOT_DIR/supabase/migrations/20260729075300_account_hard_delete_recovery_barrier.sql"
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

TMP_ROOT="$(mktemp -d /tmp/account-hard-delete-recovery-barrier-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55627
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if ((exit_status != 0)) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_DIR/postgres.log" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

wait_for_file() {
  local path="$1"
  for ((attempt = 0; attempt < 500; attempt += 1)); do
    [[ -f "$path" ]] && return 0
    sleep 0.01
  done
  echo "Timed out waiting for PostgreSQL concurrency marker: $path" >&2
  return 1
}

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE authenticator NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT pg_catalog.current_setting('request.jwt.claim.role', true)
$function$;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  deleted_at timestamptz,
  deletion_scheduled_at timestamptz,
  original_handle text
);
CREATE TABLE public.account_recovery_tokens (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE TABLE public.posts (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  author_id uuid NOT NULL,
  author_handle text
);
CREATE TABLE public.comments (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  author_handle text
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.account_recovery_tokens OWNER TO postgres;
ALTER TABLE public.posts OWNER TO postgres;
ALTER TABLE public.comments OWNER TO postgres;

CREATE FUNCTION public.restore_pending_account(
  p_user_id uuid,
  p_recovery_token_hash text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_profile public.user_profiles%ROWTYPE;
BEGIN
  SELECT profile.*
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_profile.deleted_at IS NULL
    OR v_profile.deletion_scheduled_at <= pg_catalog.clock_timestamp()
  THEN
    RETURN NULL;
  END IF;
  IF p_recovery_token_hash IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.account_recovery_tokens AS token
      WHERE token.user_id = p_user_id
        AND token.token_hash = p_recovery_token_hash
        AND token.used_at IS NULL
        AND token.expires_at > pg_catalog.clock_timestamp()
    )
  THEN
    RETURN NULL;
  END IF;
  UPDATE public.user_profiles
  SET deleted_at = NULL,
      deletion_scheduled_at = NULL
  WHERE id = p_user_id;
  UPDATE public.account_recovery_tokens
  SET used_at = pg_catalog.clock_timestamp()
  WHERE user_id = p_user_id
    AND used_at IS NULL;
  RETURN p_user_id;
END
$function$;
ALTER FUNCTION public.restore_pending_account(uuid, text) OWNER TO postgres;
SQL

psql_cmd -f "$RECOVERY_MIGRATION" >/dev/null
psql_cmd -f "$BARRIER_MIGRATION" >/dev/null

psql_cmd <<'SQL'
INSERT INTO public.user_profiles (
  id,
  deleted_at,
  deletion_scheduled_at,
  original_handle
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp() + interval '3 seconds',
    'recovering'
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    pg_catalog.clock_timestamp() - interval '30 days',
    pg_catalog.clock_timestamp() - interval '1 second',
    'ready'
  ),
  (
    '33333333-3333-4333-8333-333333333333',
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp() + interval '3 seconds',
    'queued-claim'
  );
INSERT INTO public.account_recovery_tokens (
  user_id,
  token_hash,
  expires_at
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    repeat('a', 64),
    pg_catalog.clock_timestamp() + interval '1 day'
  ),
  (
    '33333333-3333-4333-8333-333333333333',
    repeat('c', 64),
    pg_catalog.clock_timestamp() + interval '1 day'
  );
SQL

# $deadline_crossing_recovery$: recovery claims before the deadline and keeps
# its transaction open. The cleanup request starts before the deadline, blocks
# on the same advisory key, and must use a post-lock clock after the deadline.
psql_cmd -Atq >"$TMP_ROOT/recovery.out" <<SQL &
BEGIN;
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT public.claim_account_recovery_admission_atomic(
  '11111111-1111-4111-8111-111111111111',
  repeat('a', 64),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
);
\! touch "$TMP_ROOT/recovery.ready"
SELECT pg_catalog.pg_sleep(4);
COMMIT;
SQL
recovery_pid=$!
wait_for_file "$TMP_ROOT/recovery.ready"

psql_cmd -Atq >"$TMP_ROOT/hard-delete.out" <<'SQL' &
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT public.admit_expired_account_hard_delete_atomic(
  '11111111-1111-4111-8111-111111111111'
) ->> 'status';
SQL
hard_delete_pid=$!
sleep 0.25
if ! kill -0 "$hard_delete_pid" 2>/dev/null; then
  echo "Hard-delete admission did not wait for the recovery transaction" >&2
  wait "$hard_delete_pid" || true
  exit 1
fi

wait "$recovery_pid"
wait "$hard_delete_pid"
grep -Fxq 'claimed' "$TMP_ROOT/recovery.out"
grep -Fxq 'recovery_in_progress' "$TMP_ROOT/hard-delete.out"

psql_cmd -Atq <<'SQL'
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
DO $deadline_crossing_recovery$
DECLARE
  v_admission jsonb;
BEGIN
  v_admission := public.admit_expired_account_hard_delete_atomic(
    '11111111-1111-4111-8111-111111111111'
  );
  IF v_admission IS DISTINCT FROM pg_catalog.jsonb_build_object(
    'status', 'recovery_in_progress',
    'user_id', '11111111-1111-4111-8111-111111111111'::uuid
  ) THEN
    RAISE EXCEPTION 'deadline-crossing recovery was not retained: %', v_admission;
  END IF;
END
$deadline_crossing_recovery$;

DO $no_claim_is_ready$
DECLARE
  v_admission jsonb;
BEGIN
  v_admission := public.admit_expired_account_hard_delete_atomic(
    '22222222-2222-4222-8222-222222222222'
  );
  IF v_admission IS DISTINCT FROM pg_catalog.jsonb_build_object(
    'status', 'ready',
    'user_id', '22222222-2222-4222-8222-222222222222'::uuid
  ) THEN
    RAISE EXCEPTION 'expired account without a claim was not ready: %', v_admission;
  END IF;
END
$no_claim_is_ready$;
SQL

# A recovery call queued before the deadline must not retain its pre-lock clock
# after a hard-delete admission lock crosses that deadline.
psql_cmd -Atq >"$TMP_ROOT/delete-lock.out" <<SQL &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:33333333-3333-4333-8333-333333333333',
    0
  )
);
\! touch "$TMP_ROOT/delete-lock.ready"
SELECT pg_catalog.pg_sleep(4);
COMMIT;
SQL
delete_lock_pid=$!
wait_for_file "$TMP_ROOT/delete-lock.ready"

psql_cmd -Atq >"$TMP_ROOT/queued-claim.out" <<'SQL' &
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT public.claim_account_recovery_admission_atomic(
  '33333333-3333-4333-8333-333333333333',
  repeat('c', 64),
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
);
SQL
queued_claim_pid=$!
sleep 0.25
if ! kill -0 "$queued_claim_pid" 2>/dev/null; then
  echo "Recovery claim did not wait for the hard-delete admission lock" >&2
  wait "$queued_claim_pid" || true
  exit 1
fi

wait "$delete_lock_pid"
wait "$queued_claim_pid"
grep -Fxq 'invalid' "$TMP_ROOT/queued-claim.out"

psql_cmd -Atq <<'SQL'
DO $queued_claim_uses_post_lock_clock$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.account_recovery_admissions AS admission
    WHERE admission.user_id = '33333333-3333-4333-8333-333333333333'
      AND admission.state = 'claimed'
  ) THEN
    RAISE EXCEPTION 'queued recovery claim retained a stale pre-deadline clock';
  END IF;
END
$queued_claim_uses_post_lock_clock$;
SQL

if psql_cmd -c "
  SET ROLE authenticated;
  SELECT public.admit_expired_account_hard_delete_atomic(
    '22222222-2222-4222-8222-222222222222'
  );
" >"$TMP_ROOT/unauthorized.out" 2>"$TMP_ROOT/unauthorized.err"; then
  echo "authenticated unexpectedly admitted an account hard deletion" >&2
  exit 1
fi
grep -Fq 'permission denied for function admit_expired_account_hard_delete_atomic' \
  "$TMP_ROOT/unauthorized.err"

[[ "$(psql_cmd -Atqc "
  SELECT
    has_function_privilege(
      'service_role',
      'public.admit_expired_account_hard_delete_atomic(uuid)',
      'EXECUTE'
    )
    AND has_function_privilege(
      'service_role',
      'public.claim_account_recovery_admission_atomic(uuid,text,uuid)',
      'EXECUTE'
    )
    AND NOT has_function_privilege(
      'service_role',
      'public.claim_account_recovery_admission_atomic_locked_impl(uuid,text,uuid)',
      'EXECUTE'
    );
")" == 't' ]]

echo "Account hard-delete recovery barrier PostgreSQL 17 proof passed"
