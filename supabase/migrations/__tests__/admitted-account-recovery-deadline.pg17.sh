#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ADMISSION_MIGRATION="$ROOT_DIR/supabase/migrations/20260729022500_account_recovery_admission_state_machine.sql"
DEADLINE_MIGRATION="$ROOT_DIR/supabase/migrations/20260729173500_admitted_account_recovery_deadline.sql"
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

TMP_ROOT="$(mktemp -d /tmp/admitted-account-recovery-deadline-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55639
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
  deletion_reason text,
  original_handle text,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
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

-- Baseline helper reproduces the finish-time deadline check that rejected a
-- valid claim after it crossed the user-visible deadline.
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
  RETURN p_user_id;
END
$function$;
ALTER FUNCTION public.restore_pending_account(uuid, text) OWNER TO postgres;
SQL

psql_cmd -f "$ADMISSION_MIGRATION" >/dev/null
psql_cmd -f "$DEADLINE_MIGRATION" >/dev/null

psql_cmd <<'SQL'
INSERT INTO public.user_profiles (
  id,
  deleted_at,
  deletion_scheduled_at,
  deletion_reason,
  original_handle
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp() + interval '2 seconds',
    'privacy',
    'deadline_winner'
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    pg_catalog.clock_timestamp() - interval '30 days',
    pg_catalog.clock_timestamp() - interval '1 second',
    'expired',
    'expired_without_claim'
  );

INSERT INTO public.account_recovery_tokens (
  user_id,
  token_hash,
  expires_at
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    repeat('a', 64),
    (
      SELECT profile.deletion_scheduled_at
      FROM public.user_profiles AS profile
      WHERE profile.id = '11111111-1111-4111-8111-111111111111'
    )
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    repeat('b', 64),
    pg_catalog.clock_timestamp() - interval '1 second'
  );

INSERT INTO public.posts (author_id, author_handle)
VALUES ('11111111-1111-4111-8111-111111111111', NULL);
INSERT INTO public.comments (user_id, author_handle)
VALUES ('11111111-1111-4111-8111-111111111111', NULL);
SQL

claim_result="$(
  psql_cmd -Atq <<'SQL'
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT public.claim_account_recovery_admission_atomic(
  '11111111-1111-4111-8111-111111111111',
  repeat('a', 64),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
);
SQL
)"
if [[ "$(tr -d '[:space:]' <<<"$claim_result")" != 'claimed' ]]; then
  echo "Pre-deadline recovery was not claimed: $claim_result" >&2
  exit 1
fi

# Cross both the profile deadline and token expiry after the claim committed,
# while remaining far inside the admission's 15-minute lease.
psql_cmd -Atqc 'SELECT pg_catalog.pg_sleep(3);'

psql_cmd -Atq <<'SQL'
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
DO $deadline_crossing_finish$
DECLARE
  v_finish text;
BEGIN
  v_finish := public.finish_account_recovery_admission_atomic(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  IF v_finish IS DISTINCT FROM 'finished' THEN
    RAISE EXCEPTION 'admitted recovery did not finish after deadline: %', v_finish;
  END IF;
END
$deadline_crossing_finish$;

DO $expired_without_admission$
DECLARE
  v_restore uuid;
BEGIN
  v_restore := public.restore_pending_account(
    '22222222-2222-4222-8222-222222222222',
    repeat('b', 64)
  );
  IF v_restore IS NOT NULL THEN
    RAISE EXCEPTION 'expired account restored without a live admission: %', v_restore;
  END IF;
END
$expired_without_admission$;
SQL

psql_cmd -Atq <<'SQL'
DO $final_state$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.user_profiles AS profile
    WHERE profile.id = '11111111-1111-4111-8111-111111111111'
      AND (
        profile.deleted_at IS NOT NULL
        OR profile.deletion_scheduled_at IS NOT NULL
        OR profile.deletion_reason IS NOT NULL
      )
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.account_recovery_tokens AS token
    WHERE token.user_id = '11111111-1111-4111-8111-111111111111'
      AND token.used_at IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.account_recovery_admissions AS admission
    WHERE admission.operation_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      AND admission.state = 'finished'
  ) OR EXISTS (
    SELECT 1
    FROM public.posts AS post
    WHERE post.author_id = '11111111-1111-4111-8111-111111111111'
      AND post.author_handle IS DISTINCT FROM 'deadline_winner'
  ) OR EXISTS (
    SELECT 1
    FROM public.comments AS comment
    WHERE comment.user_id = '11111111-1111-4111-8111-111111111111'
      AND comment.author_handle IS DISTINCT FROM 'deadline_winner'
  ) THEN
    RAISE EXCEPTION 'deadline-crossing recovery final state was incomplete';
  END IF;
END
$final_state$;
SQL

if psql_cmd -c "
  SET ROLE authenticated;
  SELECT public.restore_pending_account(
    '22222222-2222-4222-8222-222222222222',
    repeat('b', 64)
  );
" >"$TMP_ROOT/unauthorized.out" 2>"$TMP_ROOT/unauthorized.err"; then
  echo "authenticated unexpectedly executed account recovery restore" >&2
  exit 1
fi
grep -Fq 'permission denied for function restore_pending_account' \
  "$TMP_ROOT/unauthorized.err"

echo "Admitted account recovery deadline PostgreSQL 17 proof passed"
