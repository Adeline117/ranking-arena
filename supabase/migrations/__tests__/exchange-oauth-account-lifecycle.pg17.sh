#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729164000_exchange_oauth_account_lifecycle.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo 'This integration proof requires PostgreSQL 17' >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/exchange-oauth-lifecycle-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT="$((57000 + RANDOM % 1500))"
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if ((exit_status != 0)); then
    for diagnostic in "$LOG_DIR"/*.log; do
      [[ -f "$diagnostic" ]] && tail -200 "$diagnostic" >&2 || true
    done
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
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

service_value() {
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
  actual="$(service_value "$sql")"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label drifted: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

wait_for_subject_lock() {
  local user_id="$1"
  local attempt
  local acquired
  for attempt in $(seq 1 200); do
    acquired="$(psql_cmd -qAtc "
      SELECT pg_catalog.pg_try_advisory_lock(
        pg_catalog.hashtextextended(
          'account-recovery-admission:' || '$user_id'::uuid::text,
          0
        )
      );
    ")"
    if [[ "$acquired" == 'f' ]]; then
      return 0
    fi
    sleep 0.02
  done
  echo "timed out waiting for lifecycle lock: $user_id" >&2
  exit 1
}

ACTIVE='11111111-1111-4111-8111-111111111111'
INACTIVE='22222222-2222-4222-8222-222222222222'
MISSING_PROFILE='33333333-3333-4333-8333-333333333333'
DELETE_PROFILE='44444444-4444-4444-8444-444444444444'
REFRESH_RACE='55555555-5555-4555-8555-555555555555'
CALLBACK_FIRST='66666666-6666-4666-8666-666666666666'
BAN_FIRST='77777777-7777-4777-8777-777777777777'
EXPIRING='88888888-8888-4888-8888-888888888888'
ROLLBACK_USER='99999999-9999-4999-8999-999999999999'

ACCESS_A='v2:aaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cc'
REFRESH_A='v2:111111111111111111111111:22222222222222222222222222222222:33'
ACCESS_B='v2:444444444444444444444444:55555555555555555555555555555555:66'
REFRESH_B='v2:777777777777777777777777:88888888888888888888888888888888:99'
LEASE_A='refresh-lease-v1:1999999999999:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:dmFsaWQ'
LEASE_B='refresh-lease-v1:1999999999999:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:dmFsaWQ'

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticator NOLOGIN NOINHERIT;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(
    pg_catalog.current_setting('request.jwt.claim.role', true),
    ''
  )
$function$;
ALTER FUNCTION auth.role() OWNER TO postgres;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email text
);
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz
);
CREATE TABLE public.oauth_states (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange text NOT NULL,
  state text NOT NULL,
  code_verifier text,
  expires_at timestamptz NOT NULL,
  claim_token uuid,
  claim_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE UNIQUE INDEX oauth_states_callback_identity_key
  ON public.oauth_states (user_id, exchange, state);
CREATE TABLE public.user_exchange_connections (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange text NOT NULL,
  api_key_encrypted text NOT NULL,
  api_secret_encrypted text NOT NULL,
  passphrase_encrypted text,
  is_active boolean DEFAULT true,
  verified_uid text,
  last_verified_at timestamptz,
  scope_permissions jsonb,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (user_id, exchange)
);
ALTER TABLE auth.users OWNER TO postgres;
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.oauth_states OWNER TO postgres;
ALTER TABLE public.user_exchange_connections OWNER TO postgres;

CREATE FUNCTION public.claim_exchange_oauth_state_atomic(uuid, text, text, integer)
RETURNS jsonb
LANGUAGE sql
AS $function$
  SELECT '{}'::jsonb
$function$;
CREATE FUNCTION public.finish_exchange_oauth_state_claim_atomic(
  uuid,
  text,
  text,
  uuid,
  boolean
)
RETURNS jsonb
LANGUAGE sql
AS $function$
  SELECT '{}'::jsonb
$function$;

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
    PERFORM 1 FROM auth.users WHERE id = v_user_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Auth user missing';
    END IF;
    SELECT * INTO v_profile
    FROM public.user_profiles
    WHERE id = v_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'profile missing';
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
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'profile inactive';
    END IF;
  END LOOP;
END
$function$;
ALTER FUNCTION public.claim_exchange_oauth_state_atomic(uuid, text, text, integer)
  OWNER TO postgres;
ALTER FUNCTION public.finish_exchange_oauth_state_claim_atomic(
  uuid, text, text, uuid, boolean
) OWNER TO postgres;
ALTER FUNCTION public.lock_trader_claim_principals_internal(uuid[], boolean)
  OWNER TO postgres;

CREATE FUNCTION public.lock_exchange_lifecycle_transition()
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
ALTER FUNCTION public.lock_exchange_lifecycle_transition() OWNER TO postgres;
CREATE TRIGGER "000_exchange_lifecycle_status_lock"
  BEFORE UPDATE OF deleted_at, banned_at, is_banned, ban_expires_at
  ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.lock_exchange_lifecycle_transition();
CREATE TRIGGER "000_exchange_lifecycle_delete_lock"
  BEFORE DELETE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.lock_exchange_lifecycle_transition();

GRANT USAGE ON SCHEMA public, auth
  TO anon, authenticated, service_role, authenticator;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.user_profiles, public.oauth_states, public.user_exchange_connections
  TO service_role;

INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-4111-8111-111111111111', 'active@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'inactive@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'missing@example.com'),
  ('44444444-4444-4444-8444-444444444444', 'delete@example.com'),
  ('55555555-5555-4555-8555-555555555555', 'refresh-race@example.com'),
  ('66666666-6666-4666-8666-666666666666', 'callback-first@example.com'),
  ('77777777-7777-4777-8777-777777777777', 'ban-first@example.com'),
  ('88888888-8888-4888-8888-888888888888', 'expiring@example.com'),
  ('99999999-9999-4999-8999-999999999999', 'rollback@example.com');
INSERT INTO public.user_profiles (id, deleted_at, banned_at, is_banned) VALUES
  ('11111111-1111-4111-8111-111111111111', NULL, NULL, false),
  ('22222222-2222-4222-8222-222222222222', NULL, pg_catalog.clock_timestamp(), true),
  ('44444444-4444-4444-8444-444444444444', NULL, NULL, false),
  ('55555555-5555-4555-8555-555555555555', NULL, NULL, false),
  ('66666666-6666-4666-8666-666666666666', NULL, NULL, false),
  ('77777777-7777-4777-8777-777777777777', NULL, NULL, false),
  ('88888888-8888-4888-8888-888888888888', NULL, NULL, false),
  ('99999999-9999-4999-8999-999999999999', NULL, NULL, false);

INSERT INTO public.user_exchange_connections (
  user_id,
  exchange,
  api_key_encrypted,
  api_secret_encrypted,
  passphrase_encrypted,
  is_active,
  verified_uid,
  last_verified_at,
  scope_permissions
) VALUES
  ('11111111-1111-4111-8111-111111111111', 'binance', 'old-api', 'old-secret', 'old-pass', true, 'old-proof', pg_catalog.clock_timestamp(), '{"read":true}'::jsonb),
  ('22222222-2222-4222-8222-222222222222', 'binance', 'inactive-api', 'inactive-secret', NULL, true, NULL, NULL, NULL),
  ('33333333-3333-4333-8333-333333333333', 'binance', 'missing-api', 'missing-secret', NULL, true, NULL, NULL, NULL),
  ('44444444-4444-4444-8444-444444444444', 'binance', 'delete-api', 'delete-secret', NULL, true, NULL, NULL, NULL);
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >"$LOG_DIR/reapply.log"

expect_value \
  'repository migration creates all OAuth columns' \
  '7' \
  "SELECT pg_catalog.count(*) FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'user_exchange_connections'
     AND column_name = ANY (ARRAY[
       'exchange_user_id', 'access_token_encrypted',
       'refresh_token_encrypted', 'expires_at', 'last_sync_at',
       'last_sync_status', 'last_sync_error'
     ]);"
expect_value \
  'inactive profile connection backfill' \
  'false' \
  "SELECT is_active::text FROM public.user_exchange_connections
   WHERE user_id = '$INACTIVE';"
expect_value \
  'missing profile connection backfill' \
  'false' \
  "SELECT is_active::text FROM public.user_exchange_connections
   WHERE user_id = '$MISSING_PROFILE';"

if psql_cmd -qAtc "
  SET ROLE authenticated;
  SET request.jwt.claim.role = 'authenticated';
  SELECT public.claim_exchange_oauth_refresh_atomic(
    '$ACTIVE', 'binance', pg_catalog.gen_random_uuid(), 'old', '$LEASE_A'
  );
" >"$LOG_DIR/authenticated-denied.log" 2>&1; then
  echo 'authenticated caller executed service-only OAuth lifecycle RPC' >&2
  exit 1
fi

ACTIVE_STATE='binance.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
ACTIVE_STATE_ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
ACTIVE_CLAIM='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
psql_cmd -q <<SQL
INSERT INTO public.oauth_states (
  id, user_id, exchange, state, expires_at, claim_token, claim_expires_at
) VALUES (
  '$ACTIVE_STATE_ID', '$ACTIVE', 'binance', '$ACTIVE_STATE',
  pg_catalog.clock_timestamp() + interval '10 minutes',
  '$ACTIVE_CLAIM', pg_catalog.clock_timestamp() + interval '5 minutes'
);
SQL
expect_value \
  'active callback completes atomically' \
  'true' \
  "SELECT public.complete_exchange_oauth_callback_atomic(
    '$ACTIVE', 'binance', '$ACTIVE_STATE', '$ACTIVE_STATE_ID', '$ACTIVE_CLAIM',
    'exchange-active', '$ACCESS_A', '$REFRESH_A',
    pg_catalog.clock_timestamp() + interval '1 hour'
  )->>'success';"
expect_value \
  'callback consumes exact state' \
  '0' \
  "SELECT pg_catalog.count(*) FROM public.oauth_states WHERE id = '$ACTIVE_STATE_ID';"
expect_value \
  'OAuth mode clears API-key proof state' \
  'oauth|oauth|NULL|NULL|NULL|NULL' \
  "SELECT pg_catalog.concat_ws(
     '|', api_key_encrypted, api_secret_encrypted,
     COALESCE(passphrase_encrypted, 'NULL'), COALESCE(verified_uid, 'NULL'),
     COALESCE(last_verified_at::text, 'NULL'), COALESCE(scope_permissions::text, 'NULL')
   ) FROM public.user_exchange_connections
   WHERE user_id = '$ACTIVE' AND exchange = 'binance';"
expect_value \
  'consumed callback cannot replay' \
  'STALE_CLAIM' \
  "SELECT public.complete_exchange_oauth_callback_atomic(
    '$ACTIVE', 'binance', '$ACTIVE_STATE', '$ACTIVE_STATE_ID', '$ACTIVE_CLAIM',
    'exchange-active', '$ACCESS_B', '$REFRESH_B',
    pg_catalog.clock_timestamp() + interval '1 hour'
  )->>'reason';"

INVALID_STATE='binance.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
INVALID_STATE_ID='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
INVALID_CLAIM='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
psql_cmd -q <<SQL
INSERT INTO public.oauth_states (
  id, user_id, exchange, state, expires_at, claim_token, claim_expires_at
) VALUES (
  '$INVALID_STATE_ID', '$ROLLBACK_USER', 'binance', '$INVALID_STATE',
  pg_catalog.clock_timestamp() + interval '10 minutes',
  '$INVALID_CLAIM', pg_catalog.clock_timestamp() + interval '5 minutes'
);
SQL
expect_value \
  'odd-length GCM ciphertext is rejected' \
  'INVALID' \
  "SELECT public.complete_exchange_oauth_callback_atomic(
    '$ROLLBACK_USER', 'binance', '$INVALID_STATE', '$INVALID_STATE_ID', '$INVALID_CLAIM',
    NULL, 'v2:aaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:c',
    NULL, NULL
  )->>'reason';"
expect_value \
  'invalid callback leaves its state retryable' \
  '1' \
  "SELECT pg_catalog.count(*) FROM public.oauth_states WHERE id = '$INVALID_STATE_ID';"

INACTIVE_STATE='binance.cccccccccccccccccccccccccccccccccccccccc'
INACTIVE_STATE_ID='cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
INACTIVE_CLAIM='cccccccc-cccc-4ccc-8ccc-ccccccccccc2'
psql_cmd -q <<SQL
INSERT INTO public.oauth_states (
  id, user_id, exchange, state, expires_at, claim_token, claim_expires_at
) VALUES (
  '$INACTIVE_STATE_ID', '$INACTIVE', 'binance', '$INACTIVE_STATE',
  pg_catalog.clock_timestamp() + interval '10 minutes',
  '$INACTIVE_CLAIM', pg_catalog.clock_timestamp() + interval '5 minutes'
);
SQL
expect_value \
  'inactive account callback is rejected' \
  'ACTOR_UNAVAILABLE' \
  "SELECT public.complete_exchange_oauth_callback_atomic(
    '$INACTIVE', 'binance', '$INACTIVE_STATE', '$INACTIVE_STATE_ID', '$INACTIVE_CLAIM',
    NULL, '$ACCESS_A', '$REFRESH_A', NULL
  )->>'reason';"
expect_value \
  'inactive callback does not consume state' \
  '1' \
  "SELECT pg_catalog.count(*) FROM public.oauth_states WHERE id = '$INACTIVE_STATE_ID';"

service_value "
  DELETE FROM public.user_profiles WHERE id = '$DELETE_PROFILE';
" >/dev/null
expect_value \
  'profile deletion quiesces credentials' \
  'false' \
  "SELECT is_active::text FROM public.user_exchange_connections
   WHERE user_id = '$DELETE_PROFILE';"

ACTIVE_CONNECTION_ID="$(service_value "
  SELECT id FROM public.user_exchange_connections
  WHERE user_id = '$ACTIVE' AND exchange = 'binance';
")"
expect_value \
  'refresh generation claim succeeds' \
  'true' \
  "SELECT public.claim_exchange_oauth_refresh_atomic(
    '$ACTIVE', 'binance', '$ACTIVE_CONNECTION_ID', '$REFRESH_A', '$LEASE_A'
  )->>'success';"
expect_value \
  'stale refresh generation loses CAS' \
  'CONNECTION_CHANGED' \
  "SELECT public.claim_exchange_oauth_refresh_atomic(
    '$ACTIVE', 'binance', '$ACTIVE_CONNECTION_ID', '$REFRESH_A', '$LEASE_B'
  )->>'reason';"

REFRESH_RACE_CONNECTION='dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
psql_cmd -q <<SQL
INSERT INTO public.user_exchange_connections (
  id, user_id, exchange, api_key_encrypted, api_secret_encrypted,
  refresh_token_encrypted, is_active
) VALUES (
  '$REFRESH_RACE_CONNECTION', '$REFRESH_RACE', 'bybit', 'oauth', 'oauth',
  '$REFRESH_B', true
);
SQL
service_value "
  WITH result AS (
    SELECT public.claim_exchange_oauth_refresh_atomic(
      '$REFRESH_RACE', 'bybit', '$REFRESH_RACE_CONNECTION', '$REFRESH_B', '$LEASE_A'
    ) AS ack
  )
  SELECT CASE WHEN ack->>'success' = 'true' THEN 'claimed' ELSE ack->>'reason' END
  FROM result;
" >"$LOG_DIR/refresh-race-a.log" &
refresh_pid_a=$!
service_value "
  WITH result AS (
    SELECT public.claim_exchange_oauth_refresh_atomic(
      '$REFRESH_RACE', 'bybit', '$REFRESH_RACE_CONNECTION', '$REFRESH_B', '$LEASE_B'
    ) AS ack
  )
  SELECT CASE WHEN ack->>'success' = 'true' THEN 'claimed' ELSE ack->>'reason' END
  FROM result;
" >"$LOG_DIR/refresh-race-b.log" &
refresh_pid_b=$!
wait "$refresh_pid_a"
wait "$refresh_pid_b"
refresh_results="$(sort "$LOG_DIR/refresh-race-a.log" "$LOG_DIR/refresh-race-b.log" | paste -sd ',' -)"
if [[ "$refresh_results" != 'CONNECTION_CHANGED,claimed' ]]; then
  echo "refresh race drifted: $refresh_results" >&2
  exit 1
fi

psql_cmd -q <<SQL
CREATE FUNCTION public.delay_callback_connection_insert()
RETURNS trigger
LANGUAGE plpgsql
AS \$function\$
BEGIN
  IF NEW.user_id = '$CALLBACK_FIRST'::uuid THEN
    PERFORM pg_catalog.pg_sleep(1);
  END IF;
  RETURN NEW;
END
\$function\$;
CREATE TRIGGER delay_callback_connection_insert
  BEFORE INSERT ON public.user_exchange_connections
  FOR EACH ROW EXECUTE FUNCTION public.delay_callback_connection_insert();

INSERT INTO public.oauth_states (
  id, user_id, exchange, state, expires_at, claim_token, claim_expires_at
) VALUES (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', '$CALLBACK_FIRST', 'binance',
  'binance.dddddddddddddddddddddddddddddddddddddddd',
  pg_catalog.clock_timestamp() + interval '10 minutes',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
  pg_catalog.clock_timestamp() + interval '5 minutes'
);
SQL
service_value "
  SELECT public.complete_exchange_oauth_callback_atomic(
    '$CALLBACK_FIRST', 'binance',
    'binance.dddddddddddddddddddddddddddddddddddddddd',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
    NULL, '$ACCESS_A', '$REFRESH_A', NULL
  )->>'success';
" >"$LOG_DIR/callback-first.log" &
callback_first_pid=$!
wait_for_subject_lock "$CALLBACK_FIRST"
psql_cmd -qAtc "
  UPDATE public.user_profiles
  SET banned_at = pg_catalog.clock_timestamp(), is_banned = true
  WHERE id = '$CALLBACK_FIRST';
" >"$LOG_DIR/callback-first-ban.log" &
callback_first_ban_pid=$!
wait "$callback_first_pid"
wait "$callback_first_ban_pid"
if [[ "$(<"$LOG_DIR/callback-first.log")" != 'true' ]]; then
  echo 'callback-first writer did not complete before the queued ban' >&2
  exit 1
fi
expect_value \
  'callback-first then ban ends inactive' \
  'false|0' \
  "SELECT connection.is_active::text || '|' || pg_catalog.count(state.id)::text
   FROM public.user_exchange_connections AS connection
   LEFT JOIN public.oauth_states AS state
     ON state.user_id = connection.user_id AND state.exchange = connection.exchange
   WHERE connection.user_id = '$CALLBACK_FIRST'
   GROUP BY connection.is_active;"

psql_cmd -q <<SQL
INSERT INTO public.oauth_states (
  id, user_id, exchange, state, expires_at, claim_token, claim_expires_at
) VALUES (
  'ffffffff-ffff-4fff-8fff-fffffffffff1', '$BAN_FIRST', 'binance',
  'binance.eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  pg_catalog.clock_timestamp() + interval '10 minutes',
  'ffffffff-ffff-4fff-8fff-fffffffffff2',
  pg_catalog.clock_timestamp() + interval '5 minutes'
);
SQL
psql_cmd -qAtc "
  BEGIN;
  UPDATE public.user_profiles
  SET banned_at = pg_catalog.clock_timestamp(), is_banned = true
  WHERE id = '$BAN_FIRST';
  SELECT pg_catalog.pg_sleep(1);
  COMMIT;
" >"$LOG_DIR/ban-first-ban.log" &
ban_first_pid=$!
wait_for_subject_lock "$BAN_FIRST"
service_value "
  SELECT public.complete_exchange_oauth_callback_atomic(
    '$BAN_FIRST', 'binance',
    'binance.eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    'ffffffff-ffff-4fff-8fff-fffffffffff1',
    'ffffffff-ffff-4fff-8fff-fffffffffff2',
    NULL, '$ACCESS_A', '$REFRESH_A', NULL
  )->>'reason';
" >"$LOG_DIR/ban-first-callback.log" &
ban_first_callback_pid=$!
wait "$ban_first_pid"
wait "$ban_first_callback_pid"
if [[ "$(<"$LOG_DIR/ban-first-callback.log")" != 'ACTOR_UNAVAILABLE' ]]; then
  echo 'ban-first callback did not fail closed' >&2
  exit 1
fi
expect_value \
  'ban-first callback preserves state and publishes no connection' \
  '1|0' \
  "SELECT
     (SELECT pg_catalog.count(*) FROM public.oauth_states WHERE user_id = '$BAN_FIRST')::text
     || '|' ||
     (SELECT pg_catalog.count(*) FROM public.user_exchange_connections WHERE user_id = '$BAN_FIRST')::text;"

psql_cmd -q <<SQL
INSERT INTO public.oauth_states (
  id, user_id, exchange, state, expires_at, claim_token, claim_expires_at
) VALUES (
  '12121212-1212-4212-8212-121212121211', '$EXPIRING', 'binance',
  'binance.ffffffffffffffffffffffffffffffffffffffff',
  pg_catalog.clock_timestamp() + interval '10 minutes',
  '12121212-1212-4212-8212-121212121212',
  pg_catalog.clock_timestamp() + interval '500 milliseconds'
);
SQL
psql_cmd -qAtc "
  BEGIN;
  SELECT pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || '$EXPIRING'::uuid::text,
      0
    )
  );
  SELECT pg_catalog.pg_sleep(1);
  COMMIT;
" >"$LOG_DIR/expiring-holder.log" &
expiring_holder_pid=$!
wait_for_subject_lock "$EXPIRING"
service_value "
  SELECT public.complete_exchange_oauth_callback_atomic(
    '$EXPIRING', 'binance',
    'binance.ffffffffffffffffffffffffffffffffffffffff',
    '12121212-1212-4212-8212-121212121211',
    '12121212-1212-4212-8212-121212121212',
    NULL, '$ACCESS_A', '$REFRESH_A', NULL
  )->>'reason';
" >"$LOG_DIR/expiring-callback.log" &
expiring_callback_pid=$!
wait "$expiring_holder_pid"
wait "$expiring_callback_pid"
if [[ "$(<"$LOG_DIR/expiring-callback.log")" != 'STALE_CLAIM' ]]; then
  echo 'post-wait state expiry was admitted with a stale timestamp' >&2
  exit 1
fi

psql_cmd -q <<SQL
CREATE FUNCTION public.reject_rollback_connection_insert()
RETURNS trigger
LANGUAGE plpgsql
AS \$function\$
BEGIN
  IF NEW.user_id = '$ROLLBACK_USER'::uuid THEN
    RAISE EXCEPTION 'forced connection publication failure';
  END IF;
  RETURN NEW;
END
\$function\$;
CREATE TRIGGER reject_rollback_connection_insert
  BEFORE INSERT ON public.user_exchange_connections
  FOR EACH ROW EXECUTE FUNCTION public.reject_rollback_connection_insert();
SQL
if service_value "
  SELECT public.complete_exchange_oauth_callback_atomic(
    '$ROLLBACK_USER', 'binance', '$INVALID_STATE', '$INVALID_STATE_ID', '$INVALID_CLAIM',
    NULL, '$ACCESS_A', '$REFRESH_A', NULL
  );
" >"$LOG_DIR/forced-rollback.log" 2>&1; then
  echo 'forced connection failure unexpectedly committed' >&2
  exit 1
fi
expect_value \
  'connection publication failure rolls back state consumption' \
  '1|0' \
  "SELECT
     (SELECT pg_catalog.count(*) FROM public.oauth_states WHERE id = '$INVALID_STATE_ID')::text
     || '|' ||
     (SELECT pg_catalog.count(*) FROM public.user_exchange_connections WHERE user_id = '$ROLLBACK_USER')::text;"

echo 'Exchange OAuth account lifecycle PostgreSQL 17 proof passed'
