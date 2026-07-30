#!/usr/bin/env bash

# PostgreSQL 17 concurrency proof for API-key credential admission and live
# sync result fencing against account moderation/deletion and key rotation.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729165500_exchange_api_key_account_lifecycle.sql"
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

TMP_ROOT="$(mktemp -d /tmp/exchange-api-key-lifecycle-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
BAN_FIRST_LOG="$TMP_ROOT/ban-first.log"
SAVE_FIRST_LOG="$TMP_ROOT/save-first.log"
FINISH_FIRST_LOG="$TMP_ROOT/finish-first.log"
PORT="$(( 55000 + RANDOM % 5000 ))"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)); then
    for diagnostic in \
      "$BAN_FIRST_LOG" \
      "$SAVE_FIRST_LOG" \
      "$FINISH_FIRST_LOG" \
      "$LOG_FILE"; do
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

CIPHER_A="11111111111111111111111111111111:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0102"
CIPHER_B="22222222222222222222222222222222:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:0304"
CIPHER_C="33333333333333333333333333333333:cccccccccccccccccccccccccccccccc:0506"

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
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT pg_catalog.current_setting('request.jwt.claim.role', true)
$function$;
ALTER FUNCTION auth.role() OWNER TO postgres;
GRANT USAGE ON SCHEMA auth, public
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
CREATE TABLE public.user_exchange_connections (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange text NOT NULL,
  api_key_encrypted text NOT NULL,
  api_secret_encrypted text NOT NULL,
  passphrase_encrypted text,
  exchange_user_id text,
  access_token_encrypted text,
  refresh_token_encrypted text,
  expires_at timestamptz,
  is_active boolean DEFAULT true,
  verified_uid text,
  last_verified_at timestamptz,
  scope_permissions jsonb,
  last_sync_at timestamptz,
  last_sync_status text,
  last_sync_error text,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (user_id, exchange)
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
  authorization_generation bigint NOT NULL DEFAULT 1,
  UNIQUE (user_id, platform, trader_id)
);

ALTER TABLE auth.users OWNER TO postgres;
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.user_exchange_connections OWNER TO postgres;
ALTER TABLE public.trader_authorizations OWNER TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON auth.users, public.user_profiles,
     public.user_exchange_connections, public.trader_authorizations
  TO service_role;

-- Production account lifecycle transitions acquire the same advisory namespace
-- before touching a profile. This makes both race orders deterministic here.
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
  IF p_user_ids IS NULL
     OR pg_catalog.cardinality(p_user_ids) = 0
     OR p_require_active IS NULL THEN
    RAISE EXCEPTION 'trader claim principals are required'
      USING ERRCODE = '22023';
  END IF;

  FOR v_user_id IN
    SELECT DISTINCT supplied.user_id
    FROM pg_catalog.unnest(p_user_ids) AS supplied(user_id)
    ORDER BY supplied.user_id
  LOOP
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

-- Prior migration 164500 owns this authorization fence. Keep the exact fields
-- relevant to this proof so binder updates exercise production semantics.
CREATE FUNCTION public.bump_trader_authorization_generation_for_test()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.authorization_generation := 1;
  ELSIF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.platform IS DISTINCT FROM OLD.platform
     OR NEW.trader_id IS DISTINCT FROM OLD.trader_id
     OR NEW.encrypted_api_key IS DISTINCT FROM OLD.encrypted_api_key
     OR NEW.encrypted_api_secret IS DISTINCT FROM OLD.encrypted_api_secret
     OR NEW.encrypted_passphrase IS DISTINCT FROM OLD.encrypted_passphrase
     OR NEW.permissions IS DISTINCT FROM OLD.permissions
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.read_only_verified_at IS DISTINCT FROM OLD.read_only_verified_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  THEN
    NEW.authorization_generation := OLD.authorization_generation + 1;
  ELSE
    NEW.authorization_generation := OLD.authorization_generation;
  END IF;
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.bump_trader_authorization_generation_for_test()
  OWNER TO postgres;
CREATE TRIGGER aaa_bump_trader_authorization_generation_for_test
  BEFORE INSERT OR UPDATE ON public.trader_authorizations
  FOR EACH ROW EXECUTE FUNCTION
    public.bump_trader_authorization_generation_for_test();

CREATE FUNCTION public.quiesce_inactive_exchange_state_for_test()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_user_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  v_inactive boolean := TG_OP = 'DELETE';
BEGIN
  IF TG_OP <> 'DELETE' THEN
    v_inactive := NEW.deleted_at IS NOT NULL
      OR NEW.banned_at IS NOT NULL
      OR (
        NEW.is_banned
        AND (
          NEW.ban_expires_at IS NULL
          OR NEW.ban_expires_at > pg_catalog.clock_timestamp()
        )
      );
  END IF;
  IF v_inactive THEN
    UPDATE public.user_exchange_connections AS connection
    SET is_active = false,
        last_sync_status = 'inactive',
        last_sync_error = 'Arena account inactive'
    WHERE connection.user_id = v_user_id
      AND connection.is_active IS DISTINCT FROM false;
    UPDATE public.trader_authorizations AS authorization_row
    SET status = 'suspended',
        verification_error = 'Arena account inactive'
    WHERE authorization_row.user_id = v_user_id
      AND authorization_row.status = 'active';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
ALTER FUNCTION public.quiesce_inactive_exchange_state_for_test()
  OWNER TO postgres;
CREATE TRIGGER zzz_quiesce_inactive_exchange_state_for_test
  AFTER UPDATE OF deleted_at, banned_at, is_banned, ban_expires_at
  ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION
    public.quiesce_inactive_exchange_state_for_test();
CREATE TRIGGER zzz_quiesce_deleted_exchange_state_for_test
  AFTER DELETE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION
    public.quiesce_inactive_exchange_state_for_test();
SQL

psql_cmd -f "$MIGRATION" >/dev/null

# Replaying the migration must preserve the exact function/trigger/ACL contract.
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
INSERT INTO auth.users (id) VALUES
  ('10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000003'),
  ('10000000-0000-4000-8000-000000000004'),
  ('10000000-0000-4000-8000-000000000005'),
  ('10000000-0000-4000-8000-000000000006'),
  ('10000000-0000-4000-8000-000000000007'),
  ('10000000-0000-4000-8000-000000000008');
INSERT INTO public.user_profiles (id)
SELECT id FROM auth.users
WHERE id <> '10000000-0000-4000-8000-000000000008';
SQL

# Generic connection writes clear stale OAuth/proof fields and return an exact
# generation acknowledgement.
expect_value \
  "generic connection admission" \
  "saved|false|1" \
  "SELECT result->>'status', result->>'verified', result->>'generation'
   FROM (SELECT public.upsert_exchange_api_connection_for_active_profile_atomic(
     '10000000-0000-4000-8000-000000000001',
     'binance', '$CIPHER_A', '$CIPHER_A', NULL, NULL, '[\"read\"]'::jsonb
   ) AS result) AS admitted;"
expect_value \
  "permission-only connection proof" \
  "|[\"read\"]|t" \
  "SELECT verified_uid, scope_permissions, last_verified_at IS NOT NULL
   FROM public.user_exchange_connections
   WHERE user_id = '10000000-0000-4000-8000-000000000001'
     AND exchange = 'binance';"

expect_value \
  "missing profile admission" \
  "missing_account" \
  "SELECT public.upsert_exchange_api_connection_for_active_profile_atomic(
     '10000000-0000-4000-8000-000000000008',
     'binance', '$CIPHER_A', '$CIPHER_A', NULL, NULL, NULL
   )->>'status';"

# Verified binding commits proof connection + worker authorization together and
# derives the base connection exchange from a futures authorization platform.
expect_value \
  "atomic verified binding" \
  "bound|binance_futures|1|1" \
  "SELECT result->>'status', result->>'platform',
          result->>'connection_generation',
          result->>'authorization_generation'
   FROM (SELECT public.bind_trader_authorization_for_active_profile_atomic(
     '10000000-0000-4000-8000-000000000002',
     'binance_futures', 'uid-2',
     '$CIPHER_A', '$CIPHER_B', NULL,
     '[\"read_balance\"]'::jsonb, 'main', '5min'
   ) AS result) AS bound;"
expect_value \
  "atomic verified binding rows" \
  "binance|uid-2|active|uid-2" \
  "SELECT connection.exchange, connection.verified_uid,
          authorization_row.status, authorization_row.trader_id
   FROM public.user_exchange_connections AS connection
   JOIN public.trader_authorizations AS authorization_row
     ON authorization_row.user_id = connection.user_id
   WHERE connection.user_id = '10000000-0000-4000-8000-000000000002';"

# Inject a downstream authorization failure. The connection helper ran first,
# so absence of both rows proves statement-level atomic rollback.
psql_cmd <<'SQL'
CREATE FUNCTION public.reject_atomic_bind_for_test()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.label = 'explode' THEN
    RAISE EXCEPTION 'injected authorization failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER reject_atomic_bind_for_test
  BEFORE INSERT OR UPDATE ON public.trader_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.reject_atomic_bind_for_test();
SQL
if service_query "
  SELECT public.bind_trader_authorization_for_active_profile_atomic(
    '10000000-0000-4000-8000-000000000003',
    'binance', 'uid-3', '$CIPHER_A', '$CIPHER_B', NULL,
    '[\"read\"]'::jsonb, 'explode', 'realtime'
  );
" >/dev/null 2>&1; then
  echo "injected authorization failure unexpectedly committed" >&2
  exit 1
fi
expect_value \
  "atomic bind rollback" \
  "0|0" \
  "SELECT
     (SELECT count(*) FROM public.user_exchange_connections
       WHERE user_id = '10000000-0000-4000-8000-000000000003'),
     (SELECT count(*) FROM public.trader_authorizations
       WHERE user_id = '10000000-0000-4000-8000-000000000003');"
psql_cmd -qAtc 'DROP TRIGGER reject_atomic_bind_for_test ON public.trader_authorizations;'

# Ban-first: credential admission waits behind moderation and then rejects the
# now-suspended account instead of reactivating it.
(
  psql_cmd >"$BAN_FIRST_LOG" 2>&1 <<'SQL'
BEGIN;
UPDATE public.user_profiles
SET is_banned = true, banned_at = pg_catalog.clock_timestamp()
WHERE id = '10000000-0000-4000-8000-000000000004';
SELECT pg_catalog.pg_sleep(1.2);
COMMIT;
SQL
) &
ban_pid=$!
sleep 0.2
expect_value \
  "ban-first admission" \
  "suspended" \
  "SELECT public.upsert_exchange_api_connection_for_active_profile_atomic(
     '10000000-0000-4000-8000-000000000004',
     'binance', '$CIPHER_A', '$CIPHER_B', NULL, NULL, NULL
   )->>'status';"
wait "$ban_pid"
expect_value \
  "ban-first left no credential" \
  "0" \
  "SELECT count(*) FROM public.user_exchange_connections
   WHERE user_id = '10000000-0000-4000-8000-000000000004';"

# Save-first: moderation waits for the admission transaction, then quiesces the
# connection and bumps its generation before it can be used again.
(
  psql_cmd >"$SAVE_FIRST_LOG" 2>&1 <<SQL
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
BEGIN;
SELECT public.upsert_exchange_api_connection_for_active_profile_atomic(
  '10000000-0000-4000-8000-000000000005',
  'binance', '$CIPHER_A', '$CIPHER_B', NULL, NULL, NULL
)->>'status';
SELECT pg_catalog.pg_sleep(1.2);
COMMIT;
RESET ROLE;
SQL
) &
save_pid=$!
sleep 0.2
psql_cmd -qAtc "
  UPDATE public.user_profiles
  SET is_banned = true, banned_at = pg_catalog.clock_timestamp()
  WHERE id = '10000000-0000-4000-8000-000000000005';
" >/dev/null
wait "$save_pid"
if ! grep -Eq '^[[:space:]]*saved[[:space:]]*$' "$SAVE_FIRST_LOG"; then
  echo "save-first admission did not commit before moderation" >&2
  exit 1
fi
expect_value \
  "save-first quiescence" \
  "f|inactive|2" \
  "SELECT is_active, last_sync_status, connection_generation
   FROM public.user_exchange_connections
   WHERE user_id = '10000000-0000-4000-8000-000000000005';"

# A credential generation claimed before rotation cannot write its result over
# the new credential or expose stale stats to the API caller.
expect_value \
  "rotation seed" \
  "saved" \
  "SELECT public.upsert_exchange_api_connection_for_active_profile_atomic(
     '10000000-0000-4000-8000-000000000006',
     'binance', '$CIPHER_A', '$CIPHER_B', NULL, NULL, NULL
   )->>'status';"
claim_tuple="$(service_query "
  SELECT result->>'connection_id', result->>'generation'
  FROM (SELECT public.claim_exchange_api_sync_atomic(
    '10000000-0000-4000-8000-000000000006', 'binance'
  ) AS result) AS claimed;
")"
claim_id="${claim_tuple%%|*}"
claim_generation="${claim_tuple##*|}"
expect_value \
  "credential rotation" \
  "saved" \
  "SELECT public.upsert_exchange_api_connection_for_active_profile_atomic(
     '10000000-0000-4000-8000-000000000006',
     'binance', '$CIPHER_C', '$CIPHER_B', NULL, NULL, NULL
   )->>'status';"
expect_value \
  "rotated result fence" \
  "superseded" \
  "SELECT public.finish_exchange_api_sync_atomic(
     '10000000-0000-4000-8000-000000000006',
     '$claim_id', $claim_generation, true, NULL
   )->>'status';"
expect_value \
  "rotated result did not overwrite status" \
  "pending|" \
  "SELECT last_sync_status, last_sync_at
   FROM public.user_exchange_connections
   WHERE id = '$claim_id';"

# A ban after claim causes finish to reject at lifecycle admission and the
# quiescence result remains authoritative.
expect_value \
  "ban-after-claim seed" \
  "saved" \
  "SELECT public.upsert_exchange_api_connection_for_active_profile_atomic(
     '10000000-0000-4000-8000-000000000007',
     'binance', '$CIPHER_A', '$CIPHER_B', NULL, NULL, NULL
   )->>'status';"
ban_claim_tuple="$(service_query "
  SELECT result->>'connection_id', result->>'generation'
  FROM (SELECT public.claim_exchange_api_sync_atomic(
    '10000000-0000-4000-8000-000000000007', 'binance'
  ) AS result) AS claimed;
")"
ban_claim_id="${ban_claim_tuple%%|*}"
ban_claim_generation="${ban_claim_tuple##*|}"
psql_cmd -qAtc "
  UPDATE public.user_profiles
  SET is_banned = true, banned_at = pg_catalog.clock_timestamp()
  WHERE id = '10000000-0000-4000-8000-000000000007';
" >/dev/null
expect_value \
  "ban-after-claim result fence" \
  "suspended" \
  "SELECT public.finish_exchange_api_sync_atomic(
     '10000000-0000-4000-8000-000000000007',
     '$ban_claim_id', $ban_claim_generation, true, NULL
   )->>'status';"
expect_value \
  "ban-after-claim quiescence" \
  "f|inactive|Arena account inactive" \
  "SELECT is_active, last_sync_status, last_sync_error
   FROM public.user_exchange_connections
   WHERE id = '$ban_claim_id';"

# Finish-first is the opposite serialization order: finish records while holding
# profile state; moderation waits and then wins the final visible state.
psql_cmd -qAtc "
  UPDATE public.user_profiles
  SET is_banned = false, banned_at = NULL
  WHERE id = '10000000-0000-4000-8000-000000000003';
" >/dev/null
expect_value \
  "finish-first seed" \
  "saved" \
  "SELECT public.upsert_exchange_api_connection_for_active_profile_atomic(
     '10000000-0000-4000-8000-000000000003',
     'binance', '$CIPHER_A', '$CIPHER_B', NULL, NULL, NULL
   )->>'status';"
finish_tuple="$(service_query "
  SELECT result->>'connection_id', result->>'generation'
  FROM (SELECT public.claim_exchange_api_sync_atomic(
    '10000000-0000-4000-8000-000000000003', 'binance'
  ) AS result) AS claimed;
")"
finish_id="${finish_tuple%%|*}"
finish_generation="${finish_tuple##*|}"
(
  psql_cmd >"$FINISH_FIRST_LOG" 2>&1 <<SQL
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
BEGIN;
SELECT public.finish_exchange_api_sync_atomic(
  '10000000-0000-4000-8000-000000000003',
  '$finish_id', $finish_generation, true, NULL
)->>'status';
SELECT pg_catalog.pg_sleep(1.2);
COMMIT;
RESET ROLE;
SQL
) &
finish_pid=$!
sleep 0.2
psql_cmd -qAtc "
  UPDATE public.user_profiles
  SET is_banned = true, banned_at = pg_catalog.clock_timestamp()
  WHERE id = '10000000-0000-4000-8000-000000000003';
" >/dev/null
wait "$finish_pid"
if ! grep -Eq '^[[:space:]]*recorded[[:space:]]*$' "$FINISH_FIRST_LOG"; then
  echo "finish-first sync result was not recorded" >&2
  exit 1
fi
expect_value \
  "finish-first final moderation state" \
  "f|inactive|2" \
  "SELECT is_active, last_sync_status, connection_generation
   FROM public.user_exchange_connections
   WHERE id = '$finish_id';"

# Browser roles cannot invoke any credential authority; service_role cannot
# invoke the deliberately private helper.
expect_value \
  "function ACL" \
  "f|f|f|f|f" \
  "SELECT
     pg_catalog.has_function_privilege(
       'anon',
       'public.upsert_exchange_api_connection_for_active_profile_atomic(uuid,text,text,text,text,text,jsonb)',
       'EXECUTE'
     ),
     pg_catalog.has_function_privilege(
       'authenticated',
       'public.bind_trader_authorization_for_active_profile_atomic(uuid,text,text,text,text,text,jsonb,text,text)',
       'EXECUTE'
     ),
     pg_catalog.has_function_privilege(
       'anon',
       'public.claim_exchange_api_sync_atomic(uuid,text)',
       'EXECUTE'
     ),
     pg_catalog.has_function_privilege(
       'authenticated',
       'public.finish_exchange_api_sync_atomic(uuid,uuid,bigint,boolean,text)',
       'EXECUTE'
     ),
     pg_catalog.has_function_privilege(
       'service_role',
       'public.upsert_exchange_api_connection_without_lifecycle_internal(uuid,text,text,text,text,text,jsonb,timestamptz)',
       'EXECUTE'
     );"

echo "PostgreSQL 17 exchange API-key lifecycle proof passed"
