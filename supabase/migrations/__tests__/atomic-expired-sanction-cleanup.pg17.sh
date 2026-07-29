#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729157000_atomic_expired_sanction_cleanup.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ ! -f "$MIGRATION" ]]; then
  echo "Expired-sanction cleanup migration is missing: $MIGRATION" >&2
  exit 1
fi
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/atomic-expired-sanctions-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55567
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if ((exit_status != 0)) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    echo "PostgreSQL 17 integration cluster log:" >&2
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

ISSUER_ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
MODERN_ID="11111111-1111-4111-8111-111111111111"
LEGACY_ID="22222222-2222-4222-8222-222222222222"
ACTIVE_ID="33333333-3333-4333-8333-333333333333"
PERM_ID="44444444-4444-4444-8444-444444444444"
MANUAL_ID="55555555-5555-4555-8555-555555555555"
MUTE_ONLY_ID="66666666-6666-4666-8666-666666666666"
DELETED_ID="77777777-7777-4777-8777-777777777777"
CONCURRENT_ID="88888888-8888-4888-8888-888888888888"
ROLLBACK_ID="99999999-9999-4999-8999-999999999999"
GROUP_ID="10000000-0000-4000-8000-000000000001"

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth AUTHORIZATION postgres;

CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$function$;
ALTER FUNCTION auth.role() OWNER TO postgres;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
ALTER TABLE auth.users OWNER TO postgres;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  deleted_at timestamptz,
  banned_at timestamptz,
  banned_reason text,
  banned_by uuid REFERENCES auth.users(id),
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz
);
CREATE TABLE public.user_strikes (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  issued_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reason text NOT NULL,
  strike_type text NOT NULL,
  expires_at timestamptz,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE public.group_members (
  group_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  muted_until timestamptz,
  mute_reason text,
  muted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (group_id, user_id)
);
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.user_strikes OWNER TO postgres;
ALTER TABLE public.group_members OWNER TO postgres;

GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;
GRANT SELECT, UPDATE ON public.user_profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_strikes TO service_role;
GRANT SELECT, UPDATE ON public.group_members TO service_role;

SET ROLE postgres;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd \
  -v issuer="$ISSUER_ID" \
  -v modern="$MODERN_ID" \
  -v legacy="$LEGACY_ID" \
  -v active="$ACTIVE_ID" \
  -v perm="$PERM_ID" \
  -v manual="$MANUAL_ID" \
  -v mute_only="$MUTE_ONLY_ID" \
  -v deleted="$DELETED_ID" \
  -v concurrent="$CONCURRENT_ID" \
  -v rollback="$ROLLBACK_ID" \
  -v group_id="$GROUP_ID" <<'SQL'
SET ROLE postgres;

DO $assert_metadata$
DECLARE
  v_function oid := 'public.expire_mutes_and_temporary_bans_atomic(integer)'::pg_catalog.regprocedure;
BEGIN
  IF pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE') THEN
    RAISE EXCEPTION 'service-only function ACL was not installed';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prosecdef
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s',
        'statement_timeout=20s'
      ]::text[]
  ) THEN
    RAISE EXCEPTION 'function execution metadata drifted';
  END IF;

  PERFORM pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  BEGIN
    PERFORM public.expire_mutes_and_temporary_bans_atomic(10);
    RAISE EXCEPTION 'runtime service-role guard was bypassed';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END
$assert_metadata$;

INSERT INTO auth.users(id) VALUES
  (:'issuer'),
  (:'modern'),
  (:'legacy'),
  (:'active'),
  (:'perm'),
  (:'manual'),
  (:'mute_only'),
  (:'deleted'),
  (:'concurrent'),
  (:'rollback');

INSERT INTO public.user_profiles (
  id, deleted_at, banned_at, banned_reason, banned_by, is_banned, ban_expires_at
) VALUES
  (:'issuer', NULL, NULL, NULL, NULL, false, NULL),
  (:'modern', NULL, now() - interval '8 days', 'modern temp', :'issuer', false, now() - interval '1 hour'),
  (:'legacy', NULL, NULL, NULL, NULL, true, now() - interval '2 hours'),
  (:'active', NULL, now() - interval '8 days', 'active old temp', :'issuer', false, now() - interval '3 hours'),
  (:'perm', NULL, now() - interval '8 days', 'perm old temp', :'issuer', false, now() - interval '4 hours'),
  (:'manual', NULL, now() - interval '5 minutes', 'manual permanent override', :'issuer', false, now() - interval '5 hours'),
  (:'mute_only', NULL, NULL, NULL, NULL, true, now() - interval '6 hours'),
  (:'deleted', now() - interval '1 day', now() - interval '8 days', 'deleted temp', :'issuer', false, now() - interval '7 hours'),
  (:'concurrent', NULL, NULL, NULL, NULL, false, NULL),
  (:'rollback', NULL, NULL, NULL, NULL, false, NULL);

INSERT INTO public.user_strikes(user_id, issued_by, reason, strike_type, expires_at)
SELECT id, banned_by, banned_reason, 'temp_ban', ban_expires_at
FROM public.user_profiles
WHERE id IN (:'modern', :'active', :'perm', :'deleted');
INSERT INTO public.user_strikes(user_id, issued_by, reason, strike_type, expires_at) VALUES
  (:'legacy', :'issuer', 'legacy temp', 'temp_ban', (SELECT ban_expires_at FROM public.user_profiles WHERE id = :'legacy')),
  (:'active', :'issuer', 'new active temp', 'temp_ban', now() + interval '1 day'),
  (:'perm', :'issuer', 'permanent sanction', 'perm_ban', NULL),
  (:'manual', :'issuer', 'old temporary sanction', 'temp_ban', (SELECT ban_expires_at FROM public.user_profiles WHERE id = :'manual')),
  (:'mute_only', :'issuer', 'expired mute only', 'mute', now() - interval '1 hour');

INSERT INTO public.group_members(group_id, user_id, muted_until, mute_reason, muted_by) VALUES
  (:'group_id', :'modern', now() - interval '1 minute', 'expired', :'issuer'),
  (:'group_id', :'legacy', now() + interval '1 day', 'future', :'issuer');

SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.expire_mutes_and_temporary_bans_atomic(100);
RESET ROLE;

DO $assert_first_cleanup$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id IN (
      '11111111-1111-4111-8111-111111111111'::uuid,
      '22222222-2222-4222-8222-222222222222'::uuid
    )
      AND (
        banned_at IS NOT NULL
        OR is_banned
        OR ban_expires_at IS NOT NULL
        OR banned_reason IS NOT NULL
        OR banned_by IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'modern or legacy expired temporary ban survived';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id IN (
      '33333333-3333-4333-8333-333333333333'::uuid,
      '44444444-4444-4444-8444-444444444444'::uuid,
      '55555555-5555-4555-8555-555555555555'::uuid,
      '66666666-6666-4666-8666-666666666666'::uuid,
      '77777777-7777-4777-8777-777777777777'::uuid
    )
      AND banned_at IS NULL
      AND NOT is_banned
  ) THEN
    RAISE EXCEPTION 'active, permanent, ambiguous, mute-only, or deleted ban was cleared';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = '10000000-0000-4000-8000-000000000001'::uuid
      AND user_id = '11111111-1111-4111-8111-111111111111'::uuid
      AND muted_until IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = '10000000-0000-4000-8000-000000000001'::uuid
      AND user_id = '22222222-2222-4222-8222-222222222222'::uuid
      AND muted_until IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'group mute temporal cleanup was incorrect';
  END IF;
END
$assert_first_cleanup$;

-- Deleted profiles remain suspended. Once account recovery clears deleted_at,
-- the same expired sanction can be safely finalized on the next run.
UPDATE public.user_profiles SET deleted_at = NULL WHERE id = :'deleted';
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.expire_mutes_and_temporary_bans_atomic(100);
RESET ROLE;
DO $assert_recovery$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = '77777777-7777-4777-8777-777777777777'::uuid
      AND (banned_at IS NOT NULL OR is_banned OR ban_expires_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'recovered profile did not finish expired temporary-ban cleanup';
  END IF;
END
$assert_recovery$;

-- Real failure injection: a profile trigger aborts after group-mute work. The
-- RPC exception must roll back both relation updates, never partially expire.
UPDATE public.user_profiles
SET banned_at = now() - interval '8 days',
    banned_reason = 'rollback temp',
    banned_by = :'issuer',
    is_banned = false,
    ban_expires_at = now() - interval '9 hours'
WHERE id = :'rollback';
INSERT INTO public.user_strikes(user_id, issued_by, reason, strike_type, expires_at)
SELECT id, banned_by, banned_reason, 'temp_ban', ban_expires_at
FROM public.user_profiles
WHERE id = :'rollback';
INSERT INTO public.group_members(group_id, user_id, muted_until, mute_reason, muted_by)
VALUES (:'group_id', :'rollback', now() - interval '1 minute', 'rollback', :'issuer');
CREATE FUNCTION public.inject_expiry_failure()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.id = '99999999-9999-4999-8999-999999999999'::uuid
     AND NEW.banned_at IS NULL THEN
    RAISE EXCEPTION 'injected expired-sanction write failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER inject_expiry_failure
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.inject_expiry_failure();

SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $expect_failure$
BEGIN
  BEGIN
    PERFORM public.expire_mutes_and_temporary_bans_atomic(100);
    RAISE EXCEPTION 'expected injected cleanup failure';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM <> 'injected expired-sanction write failure' THEN
        RAISE;
      END IF;
  END;
END
$expect_failure$;
RESET ROLE;

DO $assert_rollback$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = '10000000-0000-4000-8000-000000000001'::uuid
      AND user_id = '99999999-9999-4999-8999-999999999999'::uuid
      AND muted_until IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = '99999999-9999-4999-8999-999999999999'::uuid
      AND banned_at IS NOT NULL
      AND ban_expires_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'injected failure left partial cleanup state';
  END IF;
END
$assert_rollback$;
DROP TRIGGER inject_expiry_failure ON public.user_profiles;
DROP FUNCTION public.inject_expiry_failure();
SQL

# Concurrent permanent ban wins when it acquires the shared lifecycle lock
# first. Cleanup blocks, then rechecks the committed sanction while locked.
psql_cmd -v issuer="$ISSUER_ID" -v concurrent="$CONCURRENT_ID" <<'SQL'
UPDATE public.user_profiles
SET banned_at = now() - interval '8 days',
    banned_reason = 'concurrent temp',
    banned_by = :'issuer',
    is_banned = false,
    ban_expires_at = now() - interval '8 hours'
WHERE id = :'concurrent';
INSERT INTO public.user_strikes(user_id, issued_by, reason, strike_type, expires_at)
SELECT id, banned_by, banned_reason, 'temp_ban', ban_expires_at
FROM public.user_profiles
WHERE id = :'concurrent';
SQL

psql_cmd \
  -v issuer="$ISSUER_ID" \
  -v concurrent="$CONCURRENT_ID" >"$TMP_ROOT/ban-first.log" 2>&1 <<'SQL' &
SET application_name = 'expired-sanctions-ban-first';
SET ROLE service_role;
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('account-recovery-admission:' || :'concurrent', 0)
);
UPDATE public.user_profiles
SET banned_at = pg_catalog.clock_timestamp(),
    banned_reason = 'concurrent permanent',
    banned_by = :'issuer',
    is_banned = true,
    ban_expires_at = NULL
WHERE id = :'concurrent';
INSERT INTO public.user_strikes(user_id, issued_by, reason, strike_type, expires_at)
VALUES (:'concurrent', :'issuer', 'concurrent permanent', 'perm_ban', NULL);
SELECT pg_catalog.pg_sleep(1.5);
COMMIT;
SQL
BAN_FIRST_PID=$!

for _ in $(seq 1 100); do
  active_sessions="$(psql_cmd -Atc \
    "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE application_name = 'expired-sanctions-ban-first' AND wait_event = 'PgSleep'")"
  [[ "$active_sessions" == "1" ]] && break
  sleep 0.05
done
if [[ "${active_sessions:-0}" != "1" ]]; then
  echo "Concurrent ban-first session did not reach its lock hold" >&2
  exit 1
fi

psql_cmd <<SQL
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.expire_mutes_and_temporary_bans_atomic(100);
SQL
wait "$BAN_FIRST_PID"

psql_cmd -v concurrent="$CONCURRENT_ID" <<'SQL'
DO $assert_ban_first$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = '88888888-8888-4888-8888-888888888888'::uuid
      AND banned_at IS NOT NULL
      AND is_banned
      AND ban_expires_at IS NULL
      AND banned_reason = 'concurrent permanent'
  ) THEN
    RAISE EXCEPTION 'concurrent permanent ban was erased by cleanup';
  END IF;
END
$assert_ban_first$;
SQL

# Cleanup-first is also safe: it holds the lifecycle lock through commit, so a
# new permanent ban waits and becomes the final state after expiry completes.
psql_cmd -v issuer="$ISSUER_ID" -v concurrent="$CONCURRENT_ID" <<'SQL'
DELETE FROM public.user_strikes
WHERE user_id = :'concurrent' AND strike_type = 'perm_ban';
UPDATE public.user_profiles
SET banned_at = now() - interval '8 days',
    banned_reason = 'concurrent temp',
    banned_by = :'issuer',
    is_banned = false,
    ban_expires_at = now() - interval '8 hours'
WHERE id = :'concurrent';
SQL

psql_cmd >"$TMP_ROOT/cleanup-first.log" 2>&1 <<'SQL' &
SET application_name = 'expired-sanctions-cleanup-first';
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
BEGIN;
SELECT public.expire_mutes_and_temporary_bans_atomic(100);
SELECT pg_catalog.pg_sleep(1.5);
COMMIT;
SQL
CLEANUP_FIRST_PID=$!

for _ in $(seq 1 100); do
  active_sessions="$(psql_cmd -Atc \
    "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE application_name = 'expired-sanctions-cleanup-first' AND wait_event = 'PgSleep'")"
  [[ "$active_sessions" == "1" ]] && break
  sleep 0.05
done
if [[ "${active_sessions:-0}" != "1" ]]; then
  echo "Concurrent cleanup-first session did not reach its lock hold" >&2
  exit 1
fi

psql_cmd -v issuer="$ISSUER_ID" -v concurrent="$CONCURRENT_ID" <<'SQL'
SET ROLE service_role;
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('account-recovery-admission:' || :'concurrent', 0)
);
UPDATE public.user_profiles
SET banned_at = pg_catalog.clock_timestamp(),
    banned_reason = 'post-cleanup permanent',
    banned_by = :'issuer',
    is_banned = true,
    ban_expires_at = NULL
WHERE id = :'concurrent';
INSERT INTO public.user_strikes(user_id, issued_by, reason, strike_type, expires_at)
VALUES (:'concurrent', :'issuer', 'post-cleanup permanent', 'perm_ban', NULL);
COMMIT;
SQL
wait "$CLEANUP_FIRST_PID"

psql_cmd -v concurrent="$CONCURRENT_ID" <<'SQL'
DO $assert_cleanup_first$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = '88888888-8888-4888-8888-888888888888'::uuid
      AND banned_at IS NOT NULL
      AND is_banned
      AND ban_expires_at IS NULL
      AND banned_reason = 'post-cleanup permanent'
  ) THEN
    RAISE EXCEPTION 'post-cleanup permanent ban did not become final state';
  END IF;
END
$assert_cleanup_first$;
SQL

echo "atomic expired-sanction cleanup PostgreSQL 17 proof passed"
