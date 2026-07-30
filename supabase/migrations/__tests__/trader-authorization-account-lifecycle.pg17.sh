#!/usr/bin/env bash

# PostgreSQL 17 proof for account-bound first-party credential and publication
# fencing.  Both lifecycle race orders are exercised with independent sessions.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729164500_trader_authorization_account_lifecycle.sql"
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

TMP_ROOT="$(mktemp -d /tmp/trader-authorization-lifecycle-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
BAN_FIRST_LOG="$TMP_ROOT/ban-first.log"
CLAIM_FIRST_LOG="$TMP_ROOT/claim-first.log"
PORT="$(( 55000 + RANDOM % 5000 ))"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)); then
    for diagnostic in "$BAN_FIRST_LOG" "$CLAIM_FIRST_LOG" "$LOG_FILE"; do
      [[ -f "$diagnostic" ]] && tail -240 "$diagnostic" >&2 || true
    done
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

service_query() {
  local sql="$1"
  psql_cmd -qAtc "
    SET ROLE service_role;
    SET request.jwt.claim.role = 'service_role';
    $sql
    RESET ROLE;
  "
}

expect_value() {
  local label="$1"
  local expected="$2"
  local sql="$3"
  local actual
  actual="$(service_query "$sql")"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label drifted: expected '$expected', got '$actual'" >&2
    return 1
  fi
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticator NOLOGIN NOINHERIT;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE SCHEMA arena AUTHORIZATION postgres;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT pg_catalog.current_setting('request.jwt.claim.role', true)
$function$;
ALTER FUNCTION auth.role() OWNER TO postgres;
GRANT USAGE ON SCHEMA auth, arena, public
  TO anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION auth.role()
  TO anon, authenticated, service_role, authenticator;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz
);
CREATE TABLE public.trader_authorizations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform text NOT NULL,
  trader_id text NOT NULL,
  encrypted_api_key text NOT NULL,
  encrypted_api_secret text NOT NULL,
  encrypted_passphrase text,
  permissions jsonb DEFAULT '["read"]'::jsonb,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'revoked', 'expired')),
  last_verified_at timestamptz,
  verification_error text,
  data_source text NOT NULL DEFAULT 'authorized',
  sync_frequency text DEFAULT 'realtime',
  label text,
  notes text,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  expires_at timestamptz,
  read_only_verified_at timestamptz,
  last_sync_at timestamptz,
  last_sync_status text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  UNIQUE (user_id, platform, trader_id)
);
CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  exchange_trader_id text NOT NULL
);
CREATE TABLE arena.first_party_snapshots (
  trader_id bigint NOT NULL REFERENCES arena.traders(id) ON DELETE CASCADE,
  ts timestamptz NOT NULL,
  equity numeric NOT NULL,
  balance numeric,
  unrealized_pnl numeric,
  net_transfer_cum numeric,
  currency text NOT NULL DEFAULT 'USDT',
  PRIMARY KEY (trader_id, ts)
);

ALTER TABLE auth.users OWNER TO postgres;
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.trader_authorizations OWNER TO postgres;
ALTER TABLE arena.traders OWNER TO postgres;
ALTER TABLE arena.first_party_snapshots OWNER TO postgres;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.trader_authorizations TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON auth.users, public.user_profiles, arena.traders, arena.first_party_snapshots
  TO service_role;

CREATE FUNCTION public.lock_account_lifecycle_subject_transition_for_test()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_user_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || v_user_id::text,
      0
    )
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
ALTER FUNCTION public.lock_account_lifecycle_subject_transition_for_test()
  OWNER TO postgres;
CREATE TRIGGER aaa_account_lifecycle_lock_for_test
  BEFORE INSERT OR UPDATE OR DELETE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION
    public.lock_account_lifecycle_subject_transition_for_test();

CREATE FUNCTION public.lock_trader_claim_principals_internal(
  p_user_ids uuid[],
  p_require_active boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_user_id uuid;
  v_profile public.user_profiles%ROWTYPE;
BEGIN
  FOREACH v_user_id IN ARRAY p_user_ids LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'account-recovery-admission:' || v_user_id::text,
        0
      )
    );
  END LOOP;
  FOREACH v_user_id IN ARRAY p_user_ids LOOP
    PERFORM 1 FROM auth.users AS auth_user
    WHERE auth_user.id = v_user_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'active trader claim principal not found'
        USING ERRCODE = 'P0002';
    END IF;
  END LOOP;
  FOREACH v_user_id IN ARRAY p_user_ids LOOP
    SELECT profile.* INTO v_profile
    FROM public.user_profiles AS profile
    WHERE profile.id = v_user_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'trader claim principal profile not found'
        USING ERRCODE = 'P0002';
    END IF;
    IF p_require_active AND (
      v_profile.deleted_at IS NOT NULL
      OR v_profile.banned_at IS NOT NULL
      OR (
        v_profile.is_banned
        AND (
          v_profile.ban_expires_at IS NULL
          OR v_profile.ban_expires_at > pg_catalog.clock_timestamp()
        )
      )
    ) THEN
      RAISE EXCEPTION 'inactive trader claim principal'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
END
$function$;
ALTER FUNCTION public.lock_trader_claim_principals_internal(uuid[], boolean)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.lock_trader_claim_principals_internal(uuid[], boolean)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

INSERT INTO auth.users (id)
SELECT (
  '10000000-0000-4000-8000-' ||
  pg_catalog.lpad(number::text, 12, '0')
)::uuid
FROM pg_catalog.generate_series(1, 9) AS generated(number);

INSERT INTO public.user_profiles (id, banned_at)
SELECT (
         '10000000-0000-4000-8000-' ||
         pg_catalog.lpad(number::text, 12, '0')
       )::uuid,
       CASE WHEN number = 3 THEN pg_catalog.clock_timestamp() ELSE NULL END
FROM pg_catalog.generate_series(1, 9) AS generated(number)
WHERE number <> 2;

INSERT INTO arena.traders (id, exchange_trader_id)
VALUES (901, 'exchange-trader');

INSERT INTO public.trader_authorizations (
  id,
  user_id,
  platform,
  trader_id,
  encrypted_api_key,
  encrypted_api_secret,
  read_only_verified_at,
  last_sync_status
)
SELECT (
         '20000000-0000-4000-8000-' ||
         pg_catalog.lpad(number::text, 12, '0')
       )::uuid,
       (
         '10000000-0000-4000-8000-' ||
         pg_catalog.lpad(number::text, 12, '0')
       )::uuid,
       'bybit',
       'exchange-trader',
       'encrypted-key-' || number::text,
       'encrypted-secret-' || number::text,
       pg_catalog.clock_timestamp(),
       'pending'
FROM pg_catalog.generate_series(1, 9) AS generated(number);
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

expect_value \
  "active profile authorization was changed by backfill" \
  "active|1" \
  "SELECT status || '|' || authorization_generation::text
     FROM public.trader_authorizations
    WHERE id = '20000000-0000-4000-8000-000000000001';"
expect_value \
  "missing profile authorization survived backfill" \
  "suspended|2" \
  "SELECT status || '|' || authorization_generation::text
     FROM public.trader_authorizations
    WHERE id = '20000000-0000-4000-8000-000000000002';"
expect_value \
  "banned profile authorization survived backfill" \
  "suspended|2" \
  "SELECT status || '|' || authorization_generation::text
     FROM public.trader_authorizations
    WHERE id = '20000000-0000-4000-8000-000000000003';"

expect_value \
  "browser caller can execute worker credential claim" \
  "f" \
  "SELECT pg_catalog.has_function_privilege(
     'authenticated',
     'public.claim_first_party_authorization_sync_atomic(uuid)',
     'EXECUTE'
   );"
expect_value \
  "browser caller can mutate worker credential rows" \
  "f" \
  "SELECT pg_catalog.has_table_privilege(
     'authenticated',
     'public.trader_authorizations',
     'INSERT,UPDATE,DELETE'
   );"

# Ban wins the account namespace.  The waiting worker must return only a
# suspended status; encrypted credentials never cross the function boundary.
(
  psql_cmd -qAtc "
    BEGIN;
    UPDATE public.user_profiles
       SET banned_at = pg_catalog.clock_timestamp()
     WHERE id = '10000000-0000-4000-8000-000000000004';
    SELECT pg_catalog.pg_sleep(1);
    COMMIT;
  "
) >"$BAN_FIRST_LOG" 2>&1 &
BAN_FIRST_PID=$!
sleep 0.2
BAN_FIRST_RESULT="$(service_query "
  SELECT result ->> 'status'
    FROM (
      SELECT public.claim_first_party_authorization_sync_atomic(
        '20000000-0000-4000-8000-000000000004'
      ) AS result
    ) AS claimed;
")"
wait "$BAN_FIRST_PID"
if [[ "$BAN_FIRST_RESULT" != "suspended" ]]; then
  echo "ban-first claim released credentials: $BAN_FIRST_RESULT" >&2
  exit 1
fi

# Claim wins first and holds lifecycle/Auth/profile/authorization locks until
# its transaction commits.  The later ban then quiesces and bumps generation.
(
  psql_cmd -qAtc "
    SET ROLE service_role;
    SET request.jwt.claim.role = 'service_role';
    BEGIN;
    SELECT public.claim_first_party_authorization_sync_atomic(
      '20000000-0000-4000-8000-000000000005'
    ) ->> 'status';
    SELECT pg_catalog.pg_sleep(1);
    COMMIT;
  "
) >"$CLAIM_FIRST_LOG" 2>&1 &
CLAIM_FIRST_PID=$!
sleep 0.2
psql_cmd -qAtc "
  UPDATE public.user_profiles
     SET banned_at = pg_catalog.clock_timestamp()
   WHERE id = '10000000-0000-4000-8000-000000000005';
" >/dev/null
wait "$CLAIM_FIRST_PID"
if ! grep -qx 'claimed' "$CLAIM_FIRST_LOG"; then
  echo "claim-first lifecycle claim did not win cleanly" >&2
  exit 1
fi
expect_value \
  "claim-first lifecycle transition did not quiesce authorization" \
  "suspended|2" \
  "SELECT status || '|' || authorization_generation::text
     FROM public.trader_authorizations
    WHERE id = '20000000-0000-4000-8000-000000000005';"

expect_value \
  "active credential claim" \
  "claimed|1|encrypted-key-6" \
  "SELECT (result ->> 'status') || '|' ||
          (result ->> 'generation') || '|' ||
          (result ->> 'encrypted_api_key')
     FROM (
       SELECT public.claim_first_party_authorization_sync_atomic(
         '20000000-0000-4000-8000-000000000006'
       ) AS result
     ) AS claimed;"

psql_cmd -qAtc "
  UPDATE public.trader_authorizations
     SET encrypted_api_key = 'rotated-key'
   WHERE id = '20000000-0000-4000-8000-000000000006';
" >/dev/null
expect_value \
  "stale generation crossed publication fence" \
  "superseded" \
  "SELECT public.lock_first_party_authorization_publication_atomic(
     '20000000-0000-4000-8000-000000000006',
     1
   );"

# Ban after claim but before the outcome must prevent both snapshot and mark.
ACTIVE_SEVEN="$(service_query "
  SELECT result ->> 'generation'
  FROM (
    SELECT public.claim_first_party_authorization_sync_atomic(
      '20000000-0000-4000-8000-000000000007'
    ) AS result
  ) AS claimed;
")"
psql_cmd -qAtc "
  UPDATE public.user_profiles
     SET deleted_at = pg_catalog.clock_timestamp()
   WHERE id = '10000000-0000-4000-8000-000000000007';
" >/dev/null
expect_value \
  "ban-first outcome published a financial snapshot" \
  "suspended|0" \
  "SELECT (result ->> 'status') || '|' ||
          (SELECT pg_catalog.count(*)::text
             FROM arena.first_party_snapshots
            WHERE trader_id = 901)
     FROM (
       SELECT public.finish_first_party_authorization_sync_atomic(
         '20000000-0000-4000-8000-000000000007',
         $ACTIVE_SEVEN,
         0,
         true,
         'ok',
         901,
         100,
         90,
         10,
         0,
         'USDT'
       ) AS result
     ) AS finished;"

expect_value \
  "successful outcome did not atomically publish snapshot and watermark" \
  "recorded" \
  "SELECT public.finish_first_party_authorization_sync_atomic(
     '20000000-0000-4000-8000-000000000008',
     1,
     0,
     true,
     'ok',
     901,
     100,
     90,
     10,
     0,
     'USDT'
   ) ->> 'status';"
expect_value \
  "successful outcome projections were not committed together" \
  "success|0|1" \
  "SELECT authorization_row.last_sync_status || '|' ||
          authorization_row.consecutive_failures::text || '|' ||
          (SELECT pg_catalog.count(*)::text
             FROM arena.first_party_snapshots
            WHERE trader_id = 901)
     FROM public.trader_authorizations AS authorization_row
    WHERE authorization_row.id = '20000000-0000-4000-8000-000000000008';"

# The third failure is itself an authority transition, so the generation bumps
# while the failure count and suspension commit in the same transaction.
psql_cmd -qAtc "
  UPDATE public.trader_authorizations
     SET consecutive_failures = 2
   WHERE id = '20000000-0000-4000-8000-000000000009';
" >/dev/null
expect_value \
  "third failure did not atomically suspend and bump generation" \
  "recorded|suspended|3|2|true" \
  "SELECT (result ->> 'status') || '|' ||
          (result ->> 'authorization_status') || '|' ||
          (result ->> 'consecutive_failures') || '|' ||
          (result ->> 'generation') || '|' ||
          (result ->> 'notification_needed')
     FROM (
       SELECT public.finish_first_party_authorization_sync_atomic(
         '20000000-0000-4000-8000-000000000009',
         1,
         2,
         false,
         'credential rejected',
         NULL,
         NULL,
         NULL,
         NULL,
         NULL,
         NULL
       ) AS result
     ) AS finished;"

echo "trader authorization account lifecycle PostgreSQL 17 proof passed"
