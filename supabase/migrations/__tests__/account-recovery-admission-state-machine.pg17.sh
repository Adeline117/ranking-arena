#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729022500_account_recovery_admission_state_machine.sql"
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

TMP_ROOT="$(mktemp -d /tmp/account-recovery-admission-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55523
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

psql_cmd -f "$MIGRATION" >/dev/null

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
    pg_catalog.clock_timestamp() + interval '30 days',
    'winner'
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp() + interval '30 days',
    'retry'
  );
INSERT INTO public.account_recovery_tokens (
  user_id,
  token_hash,
  expires_at
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    repeat('a', 64),
    pg_catalog.clock_timestamp() + interval '30 days'
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    repeat('b', 64),
    pg_catalog.clock_timestamp() + interval '30 days'
  );
SQL

# $two_request_concurrency$: both requests race the same user/token. The
# advisory lock and claimed-user partial unique index must yield one winner.
psql_cmd -Atq >"$TMP_ROOT/claim-a.out" <<'SQL' &
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT public.claim_account_recovery_admission_atomic(
  '11111111-1111-4111-8111-111111111111',
  repeat('a', 64),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
);
SQL
pid_a=$!
psql_cmd -Atq >"$TMP_ROOT/claim-b.out" <<'SQL' &
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT public.claim_account_recovery_admission_atomic(
  '11111111-1111-4111-8111-111111111111',
  repeat('a', 64),
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
);
SQL
pid_b=$!
wait "$pid_a"
wait "$pid_b"

claim_a="$(tr -d '[:space:]' <"$TMP_ROOT/claim-a.out")"
claim_b="$(tr -d '[:space:]' <"$TMP_ROOT/claim-b.out")"
if [[ "$(printf '%s\n%s\n' "$claim_a" "$claim_b" | sort | tr '\n' ' ')" != "busy claimed " ]]; then
  echo "Concurrent recovery claims were not exactly busy/claimed: $claim_a $claim_b" >&2
  exit 1
fi

if [[ "$claim_a" == 'claimed' ]]; then
  winner_operation='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  loser_operation='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
else
  winner_operation='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  loser_operation='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
fi

finish_result="$(
  psql_cmd -Atq <<SQL
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT public.finish_account_recovery_admission_atomic(
  '11111111-1111-4111-8111-111111111111',
  '$winner_operation'
);
SQL
)"
if [[ "$(tr -d '[:space:]' <<<"$finish_result")" != 'finished' ]]; then
  echo "Winning recovery did not finish exactly: $finish_result" >&2
  exit 1
fi

psql_cmd -Atq <<SQL
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
DO \$two_request_concurrency\$
DECLARE
  v_retry text;
  v_abort text;
  v_loser text;
BEGIN
  v_retry := public.finish_account_recovery_admission_atomic(
    '11111111-1111-4111-8111-111111111111',
    '$winner_operation'
  );
  v_abort := public.abort_account_recovery_admission_atomic(
    '11111111-1111-4111-8111-111111111111',
    '$winner_operation'
  );
  v_loser := public.finish_account_recovery_admission_atomic(
    '11111111-1111-4111-8111-111111111111',
    '$loser_operation'
  );
  IF v_retry IS DISTINCT FROM 'finished'
    OR v_abort IS DISTINCT FROM 'finished'
    OR v_loser IS DISTINCT FROM 'absent'
  THEN
    RAISE EXCEPTION
      'recovery winner/loser terminal ACKs were not exact: %, %, %',
      v_retry,
      v_abort,
      v_loser;
  END IF;
END
\$two_request_concurrency\$;
SQL

psql_cmd -Atq <<'SQL'
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
DO $abort_and_retry$
DECLARE
  v_claim text;
  v_abort text;
BEGIN
  v_claim := public.claim_account_recovery_admission_atomic(
    '22222222-2222-4222-8222-222222222222',
    repeat('b', 64),
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  );
  v_abort := public.abort_account_recovery_admission_atomic(
    '22222222-2222-4222-8222-222222222222',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  );
  IF v_claim IS DISTINCT FROM 'claimed'
    OR v_abort IS DISTINCT FROM 'aborted'
    OR public.abort_account_recovery_admission_atomic(
      '22222222-2222-4222-8222-222222222222',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    ) IS DISTINCT FROM 'aborted'
    OR public.claim_account_recovery_admission_atomic(
      '22222222-2222-4222-8222-222222222222',
      repeat('b', 64),
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    ) IS DISTINCT FROM 'claimed'
  THEN
    RAISE EXCEPTION 'abort/retry recovery state machine was not idempotent';
  END IF;
END
$abort_and_retry$;
SQL

psql_cmd -Atq <<'SQL'
DO $final_state$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.user_profiles AS profile
    WHERE profile.id = '11111111-1111-4111-8111-111111111111'
      AND profile.deleted_at IS NOT NULL
  )
    OR NOT EXISTS (
      SELECT 1
      FROM public.account_recovery_tokens AS token
      WHERE token.user_id = '11111111-1111-4111-8111-111111111111'
        AND token.used_at IS NOT NULL
    )
    OR (
      SELECT pg_catalog.count(*)
      FROM public.account_recovery_admissions AS admission
      WHERE admission.user_id = '11111111-1111-4111-8111-111111111111'
        AND admission.state = 'finished'
    ) <> 1
  THEN
    RAISE EXCEPTION 'recovery final state did not retain one exact winner';
  END IF;
END
$final_state$;
SQL

echo "Account recovery admission PostgreSQL 17 concurrency proof passed"
