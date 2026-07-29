#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729055000_account_recovery_auth_manual_review.sql"
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

TMP_ROOT="$(mktemp -d /tmp/account-recovery-auth-review-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55527
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
  id uuid PRIMARY KEY
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
  updated_at timestamptz NOT NULL
);
CREATE TABLE public.stripe_manual_reviews (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  object_type text NOT NULL,
  object_id text NOT NULL,
  user_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  action text NOT NULL DEFAULT 'investigate',
  reason_key text NOT NULL,
  reason text NOT NULL,
  state text NOT NULL DEFAULT 'open',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  resolved_at timestamptz,
  CONSTRAINT stripe_manual_reviews_stable_key
    UNIQUE (object_type, object_id, reason_key)
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.account_recovery_admissions OWNER TO postgres;
ALTER TABLE public.stripe_manual_reviews OWNER TO postgres;

INSERT INTO public.user_profiles (id)
VALUES ('11111111-1111-4111-8111-111111111111');
INSERT INTO public.account_recovery_admissions (
  operation_id,
  user_id,
  recovery_token_hash,
  state,
  claimed_at,
  lease_expires_at,
  updated_at
)
VALUES (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  repeat('a', 64),
  'claimed',
  now(),
  now() + interval '15 minutes',
  now()
);
SQL

psql_cmd -f "$MIGRATION" >/dev/null

if psql_cmd -c "
  SET ROLE authenticated;
  SELECT public.record_account_recovery_auth_manual_review(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'auth_reban_failed'
  );
" >"$TMP_ROOT/unauthorized.out" 2>"$TMP_ROOT/unauthorized.err"; then
  echo "authenticated unexpectedly recorded an account recovery Auth review" >&2
  exit 1
fi
grep -Fq 'permission denied for function record_account_recovery_auth_manual_review' \
  "$TMP_ROOT/unauthorized.err"

record_review() {
  local reason="$1"
  psql_cmd -Atqc "
    SET request.jwt.claim.role = 'service_role';
    SET ROLE service_role;
    SELECT public.record_account_recovery_auth_manual_review(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '$reason'
    );
    RESET ROLE;
  "
}

[[ "$(record_review auth_reban_failed)" == "recorded" ]]
[[ "$(record_review auth_reban_failed)" == "existing" ]]
[[ "$(record_review finish_outcome_unknown)" == "recorded" ]]

psql_cmd -Atqc "
  SELECT
    count(*) = 2
    AND bool_and(object_type = 'account_recovery')
    AND bool_and(object_id = '22222222-2222-4222-8222-222222222222')
    AND bool_and(action = 'reconcile_auth')
    AND bool_and(metadata ->> 'user_id' =
      '11111111-1111-4111-8111-111111111111')
    AND bool_and(metadata ->> 'operation_id' =
      '22222222-2222-4222-8222-222222222222')
  FROM public.stripe_manual_reviews;
" | grep -Fxq t

if psql_cmd -c "
  SET request.jwt.claim.role = 'service_role';
  SET ROLE service_role;
  SELECT public.record_account_recovery_auth_manual_review(
    '33333333-3333-4333-8333-333333333333',
    '22222222-2222-4222-8222-222222222222',
    'auth_reban_failed'
  );
" >"$TMP_ROOT/identity.out" 2>"$TMP_ROOT/identity.err"; then
  echo "cross-subject Auth review unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'account recovery Auth review identity conflict' "$TMP_ROOT/identity.err"

if psql_cmd -c "
  SET request.jwt.claim.role = 'service_role';
  SET ROLE service_role;
  SELECT public.record_account_recovery_auth_manual_review(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'unsupported'
  );
" >"$TMP_ROOT/reason.out" 2>"$TMP_ROOT/reason.err"; then
  echo "unsupported Auth review reason unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'invalid account recovery Auth review input' "$TMP_ROOT/reason.err"

[[ "$(psql_cmd -Atqc "
  SELECT
    NOT has_function_privilege(
      'authenticated',
      'public.record_account_recovery_auth_manual_review(uuid,uuid,text)',
      'EXECUTE'
    )
    AND has_function_privilege(
      'service_role',
      'public.record_account_recovery_auth_manual_review(uuid,uuid,text)',
      'EXECUTE'
    );
")" == "t" ]]

echo "Account recovery Auth manual-review PostgreSQL 17 proof passed"
