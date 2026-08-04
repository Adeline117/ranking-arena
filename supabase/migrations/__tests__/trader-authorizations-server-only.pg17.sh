#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for the trader-authorization base-table ACL.
# It owns an isolated temporary cluster and never connects to an application DB.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260803211500_trader_authorizations_server_only.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/trader-authorizations-acl-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((56000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -160 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

expect_failure() {
  local name="$1"
  local sql="$2"
  if psql_cmd -c "$sql" >"$TMP_ROOT/$name.log" 2>&1; then
    echo "expected failure succeeded: $name" >&2
    exit 1
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
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
-- Do not grant BYPASSRLS: service CRUD below must work through the explicit
-- policy installed by the migration.
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE manual_authorization_reader NOLOGIN BYPASSRLS;
CREATE ROLE historical_timestamp_executor NOLOGIN;

CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(
    pg_catalog.current_setting('request.jwt.claim.sub', true),
    ''
  )::uuid
$$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);

-- Start without the service upsert's unique key so preflight rollback is
-- exercised before the fixture is brought to the production contract.
CREATE TABLE public.trader_authorizations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform text NOT NULL,
  trader_id text NOT NULL,
  encrypted_api_key text NOT NULL,
  encrypted_api_secret text NOT NULL,
  encrypted_passphrase text,
  permissions jsonb DEFAULT '["read"]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  last_verified_at timestamptz,
  read_only_verified_at timestamptz,
  last_sync_at timestamptz,
  last_sync_status text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  verification_error text,
  data_source text NOT NULL DEFAULT 'authorized',
  sync_frequency text DEFAULT 'realtime',
  label text,
  notes text,
  created_at timestamptz DEFAULT pg_catalog.now(),
  updated_at timestamptz DEFAULT pg_catalog.now(),
  expires_at timestamptz
);

-- The atomic binder requires the already-hardened connection registry and its
-- exact owner key. Keep this key valid while the authorization-key preflight
-- below is intentionally exercised first.
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
  created_at timestamptz DEFAULT pg_catalog.now(),
  updated_at timestamptz DEFAULT pg_catalog.now(),
  CONSTRAINT user_exchange_connections_user_id_exchange_key
    UNIQUE (user_id, exchange)
);

-- Reproduce the two timestamp functions/triggers installed by historical
-- migrations. Their legacy owner, public ACL, and mutable body are part of the
-- replay boundary this cutoff must converge itself.
CREATE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = pg_catalog.now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trigger_user_exchange_connections_updated_at
  BEFORE UPDATE ON public.user_exchange_connections
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE FUNCTION public.update_trader_authorizations_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = pg_catalog.now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trigger_update_trader_authorizations_updated_at
  BEFORE UPDATE ON public.trader_authorizations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_trader_authorizations_updated_at();

ALTER TABLE public.user_exchange_connections ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.trader_authorizations ENABLE ROW LEVEL SECURITY;

-- Reproduce Supabase's historical broad grants, trust-field column grants, and
-- both repository and out-of-band policies.
GRANT ALL PRIVILEGES ON TABLE public.trader_authorizations
  TO PUBLIC, anon, authenticated, service_role;
GRANT SELECT (
  encrypted_api_key,
  encrypted_api_secret,
  encrypted_passphrase,
  permissions,
  read_only_verified_at,
  last_sync_at,
  last_sync_status
), UPDATE (
  permissions,
  status,
  last_verified_at,
  read_only_verified_at,
  last_sync_at,
  last_sync_status,
  consecutive_failures,
  verification_error
) ON TABLE public.trader_authorizations
  TO PUBLIC, anon, authenticated, service_role;

CREATE POLICY "Users manage own authorizations"
  ON public.trader_authorizations FOR ALL TO public
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Dashboard verified-data writer"
  ON public.trader_authorizations FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);
CREATE POLICY "Legacy service authorization policy"
  ON public.trader_authorizations FOR ALL TO service_role
  USING (true) WITH CHECK (true);

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

INSERT INTO public.trader_authorizations (
  id,
  user_id,
  platform,
  trader_id,
  encrypted_api_key,
  encrypted_api_secret,
  encrypted_passphrase,
  permissions,
  status,
  last_verified_at,
  read_only_verified_at,
  last_sync_at,
  last_sync_status
) VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
  '11111111-1111-1111-1111-111111111111',
  'binance_futures',
  'alice-uid',
  'cipher-api-alice',
  'cipher-secret-alice',
  'cipher-passphrase-alice',
  '["read"]'::jsonb,
  'active',
  '2026-08-03 00:00:00+00'::timestamptz,
  '2026-08-03 00:00:00+00'::timestamptz,
  pg_catalog.now(),
  'success'
), (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
  '11111111-1111-1111-1111-111111111111',
  'gmx',
  'legacy-wallet-permission',
  'wallet:0xlegacy',
  'signature_verified:legacy',
  NULL,
  '["wallet_owner"]'::jsonb,
  'active',
  NULL,
  NULL,
  NULL,
  'pending'
), (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
  '22222222-2222-2222-2222-222222222222',
  'hyperliquid',
  'legacy-wallet-marker',
  'wallet:0xmarker',
  'signature_verified:marker',
  NULL,
  '[]'::jsonb,
  'active',
  NULL,
  NULL,
  NULL,
  'pending'
), (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4',
  '22222222-2222-2222-2222-222222222222',
  'bybit_spot',
  'legacy-alias-uid',
  'cipher-api-alias',
  'cipher-secret-alias',
  NULL,
  '["read"]'::jsonb,
  'active',
  pg_catalog.now(),
  pg_catalog.now(),
  NULL,
  'pending'
), (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5',
  '22222222-2222-2222-2222-222222222222',
  ' Binance ',
  'raw-noncanonical-uid',
  'cipher-api-raw',
  'cipher-secret-raw',
  NULL,
  '["read"]'::jsonb,
  'active',
  '2026-08-03 00:00:00+00'::timestamptz,
  '2026-08-03 00:00:00+00'::timestamptz,
  NULL,
  'pending'
);

-- One exact canonical projection keeps Alice's product-specific authorization
-- valid. The alias and retired OAuth rows must be quarantined without deleting
-- their audit material.
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
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  'binance',
  'cipher-api-alice',
  'cipher-secret-alice',
  'cipher-passphrase-alice',
  true,
  'alice-uid',
  '2026-08-03 00:00:00+00'::timestamptz,
  '["read"]'::jsonb
), (
  '22222222-2222-2222-2222-222222222222',
  'bybit_spot',
  'cipher-api-alias',
  'cipher-secret-alias',
  NULL,
  true,
  'legacy-alias-uid',
  pg_catalog.now(),
  '["read"]'::jsonb
), (
  '22222222-2222-2222-2222-222222222222',
  'okx',
  'oauth',
  'oauth',
  NULL,
  true,
  'oauth-placeholder-uid',
  pg_catalog.now(),
  '["read"]'::jsonb
), (
  '22222222-2222-2222-2222-222222222222',
  ' Binance ',
  'cipher-api-raw',
  'cipher-secret-raw',
  NULL,
  true,
  'raw-noncanonical-uid',
  '2026-08-03 00:00:00+00'::timestamptz,
  '["read"]'::jsonb
);
SQL

# Strict preflight must fail and leave all hostile ACLs/policies untouched when
# the unique service-upsert key is absent.
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/preflight.log" 2>&1; then
  echo "trader authorization ACL migration unexpectedly passed without owner key" >&2
  exit 1
fi
if ! grep -q \
  'requires a valid unique (user_id, platform, trader_id) key' \
  "$TMP_ROOT/preflight.log"; then
  cat "$TMP_ROOT/preflight.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $proof$
BEGIN
  IF NOT pg_catalog.has_table_privilege(
       'authenticated',
       'public.trader_authorizations',
       'UPDATE'
     ) OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_policy
       WHERE polrelid = 'public.trader_authorizations'::regclass
     ) <> 3 THEN
    RAISE EXCEPTION 'preflight failure did not roll back cleanly';
  END IF;
END
$proof$;

ALTER TABLE public.trader_authorizations
  ADD CONSTRAINT trader_authorizations_user_platform_trader_key
  UNIQUE (user_id, platform, trader_id);
SQL

# The second conflict target is an independent preflight gate.
psql_cmd -c "
  ALTER TABLE public.user_exchange_connections
    DROP CONSTRAINT user_exchange_connections_user_id_exchange_key;
" >/dev/null
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/connection-preflight.log" 2>&1; then
  echo "trader authorization migration unexpectedly passed without connection owner key" >&2
  exit 1
fi
if ! grep -q \
  'requires a valid unique (user_id, exchange) key' \
  "$TMP_ROOT/connection-preflight.log"; then
  cat "$TMP_ROOT/connection-preflight.log" >&2
  exit 1
fi
psql_cmd -c "
  ALTER TABLE public.user_exchange_connections
    ADD CONSTRAINT user_exchange_connections_user_id_exchange_key
    UNIQUE (user_id, exchange);
" >/dev/null

# A valid schema is still unsafe when the July connection-table ACL recovery
# was omitted. The August migration must stop before creating its definer RPC.
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/connection-acl-preflight.log" 2>&1; then
  echo "trader authorization migration unexpectedly passed without connection ACL" >&2
  exit 1
fi
if ! grep -q \
  'must satisfy 20260716112000_exchange_connections_server_only' \
  "$TMP_ROOT/connection-acl-preflight.log"; then
  cat "$TMP_ROOT/connection-acl-preflight.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.user_exchange_connections
  TO service_role;
CREATE POLICY "Service role manages exchange connections"
  ON public.user_exchange_connections
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
SQL

# A custom BYPASSRLS grant on the prerequisite connection registry must stop
# the migration rather than being ignored as an unknown role.
psql_cmd -c "
  GRANT SELECT ON TABLE public.user_exchange_connections
    TO manual_authorization_reader;
" >/dev/null
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/custom-connection-acl-preflight.log" 2>&1; then
  echo "trader authorization migration accepted a custom connection ACL" >&2
  exit 1
fi
if ! grep -q \
  'must satisfy 20260716112000_exchange_connections_server_only' \
  "$TMP_ROOT/custom-connection-acl-preflight.log"; then
  cat "$TMP_ROOT/custom-connection-acl-preflight.log" >&2
  exit 1
fi
psql_cmd -c "
  REVOKE SELECT ON TABLE public.user_exchange_connections
    FROM manual_authorization_reader;
" >/dev/null

# Same-name overloads are unreviewed RPC capabilities and must fail preflight.
psql_cmd <<'SQL'
CREATE FUNCTION public.bind_trader_account_connection_v1(text)
RETURNS uuid LANGUAGE sql AS 'SELECT pg_catalog.gen_random_uuid()';
SQL
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/overload-preflight.log" 2>&1; then
  echo "trader authorization migration accepted an unknown overload" >&2
  exit 1
fi
if ! grep -q 'unexpected trader-authorization function overloads' \
  "$TMP_ROOT/overload-preflight.log"; then
  cat "$TMP_ROOT/overload-preflight.log" >&2
  exit 1
fi
psql_cmd -c 'DROP FUNCTION public.bind_trader_account_connection_v1(text)' >/dev/null

# Unknown triggers are never auto-dropped. Even a disabled trigger must stop
# the migration before quarantine changes data, because its intent is unknown.
psql_cmd <<'SQL'
CREATE TRIGGER unexpected_disabled_account_trigger
  BEFORE UPDATE ON public.trader_authorizations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_trader_authorizations_updated_at();
ALTER TABLE public.trader_authorizations
  DISABLE TRIGGER unexpected_disabled_account_trigger;
SQL
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/trigger-preflight.log" 2>&1; then
  echo "trader authorization migration accepted an unknown disabled trigger" >&2
  exit 1
fi
if ! grep -q 'unexpected account triggers must be retired before quarantine DML' \
  "$TMP_ROOT/trigger-preflight.log"; then
  cat "$TMP_ROOT/trigger-preflight.log" >&2
  exit 1
fi
UNSWEPT_STATE="$(
  psql_cmd -Atqc "
    SELECT
      (SELECT status FROM public.trader_authorizations
       WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2') || ':' ||
      (SELECT is_active::text FROM public.user_exchange_connections
       WHERE exchange = 'bybit_spot');
  "
)"
if [[ "$UNSWEPT_STATE" != 'active:true' ]]; then
  echo "unknown-trigger failure changed quarantine data: $UNSWEPT_STATE" >&2
  exit 1
fi
psql_cmd -c \
  'DROP TRIGGER unexpected_disabled_account_trigger ON public.trader_authorizations' \
  >/dev/null

psql_cmd <<'SQL'
GRANT SELECT ON TABLE public.trader_authorizations
  TO manual_authorization_reader;
GRANT UPDATE (permissions, read_only_verified_at)
  ON TABLE public.trader_authorizations
  TO manual_authorization_reader;
SQL

# First application closes every historical privilege and policy path.
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $legacy_connection_quarantine_proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM public.user_exchange_connections
       WHERE user_id = '11111111-1111-1111-1111-111111111111'
         AND exchange = 'binance'
         AND verified_uid = 'alice-uid'
         AND is_active IS TRUE
     ) OR NOT EXISTS (
       SELECT 1
       FROM public.trader_authorizations
       WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
         AND status = 'active'
     ) OR (
       SELECT pg_catalog.count(*)
       FROM public.user_exchange_connections
       WHERE user_id = '22222222-2222-2222-2222-222222222222'
         AND exchange IN ('bybit_spot', 'okx')
         AND is_active IS FALSE
     ) <> 2 OR NOT EXISTS (
       SELECT 1
       FROM public.trader_authorizations
       WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4'
         AND status = 'revoked'
         AND verification_error LIKE 'Quarantined:%'
     ) OR NOT EXISTS (
       SELECT 1
       FROM public.user_exchange_connections
       WHERE user_id = '22222222-2222-2222-2222-222222222222'
         AND exchange = ' Binance '
         AND is_active IS FALSE
     ) OR NOT EXISTS (
       SELECT 1
       FROM public.trader_authorizations
       WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5'
         AND platform = ' Binance '
         AND status = 'revoked'
         AND verification_error LIKE 'Quarantined:%'
     ) THEN
    RAISE EXCEPTION 'legacy alias/OAuth quarantine contract is incomplete';
  END IF;
END
$legacy_connection_quarantine_proof$;
SQL

# Retired auth-first writers must fail immediately, even if they intended to
# add the connection later in the same transaction.
expect_failure authorization_first_writer "
  BEGIN;
  SET ROLE service_role;
  INSERT INTO public.trader_authorizations(
    user_id, platform, trader_id, encrypted_api_key, encrypted_api_secret,
    permissions, status, read_only_verified_at, last_verified_at,
    last_sync_status
  ) VALUES (
    '22222222-2222-2222-2222-222222222222', 'binance',
    'auth-first-uid', 'auth-first-key', 'auth-first-secret',
    '[\"read\"]'::jsonb, 'active',
    '2026-08-03 00:00:00+00'::timestamptz,
    '2026-08-03 00:00:00+00'::timestamptz, 'pending'
  );
  INSERT INTO public.user_exchange_connections(
    user_id, exchange, api_key_encrypted, api_secret_encrypted, is_active,
    verified_uid, last_verified_at, scope_permissions
  ) VALUES (
    '22222222-2222-2222-2222-222222222222', 'binance',
    'auth-first-key', 'auth-first-secret', true, 'auth-first-uid',
    '2026-08-03 00:00:00+00'::timestamptz, '[\"read\"]'::jsonb
  );
  COMMIT;
"

# Operational bookkeeping that does not alter credential trust must not take
# the connection lock or be rejected by the forward guard.
psql_cmd -q <<'SQL'
SET ROLE service_role;
UPDATE public.trader_authorizations
SET last_sync_at = pg_catalog.statement_timestamp(),
    last_sync_status = 'success',
    status = status
WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
RESET ROLE;
SQL

# Every connection-side trust field is protected by the deferred reverse edge.
for mismatch in api_key_encrypted passphrase_encrypted scope_permissions last_verified_at; do
  case "$mismatch" in
    api_key_encrypted) assignment="api_key_encrypted = 'drifted-key'" ;;
    passphrase_encrypted) assignment="passphrase_encrypted = 'drifted-passphrase'" ;;
    scope_permissions) assignment="scope_permissions = '[\"trade\"]'::jsonb" ;;
    last_verified_at) assignment="last_verified_at = last_verified_at + interval '1 second'" ;;
  esac
  expect_failure "connection_${mismatch}_drift" "
    SET ROLE service_role;
    UPDATE public.user_exchange_connections
    SET $assignment
    WHERE user_id = '11111111-1111-1111-1111-111111111111'
      AND exchange = 'binance';
  "
done

expect_failure direct_guard_execution "
  SET ROLE service_role;
  SELECT public.guard_trader_authorization_v1_contract();
"

psql_cmd <<'SQL'
-- Simulate one in-flight immutable pre-cutover writer after the migration. The
-- binder must lock and deactivate the full normalized family before publishing
-- the exact canonical row.
UPDATE public.user_exchange_connections
SET is_active = true
WHERE user_id = '22222222-2222-2222-2222-222222222222'
  AND exchange = 'bybit_spot';

-- The service role has only EXECUTE authority on the binder. The definer-owned
-- function must still commit both projections in the same statement.
SET ROLE service_role;
SELECT public.bind_trader_account_connection_v1(
  '22222222-2222-2222-2222-222222222222',
  'bybit_spot',
  'atomic-success-uid',
  'cipher-api-atomic-success',
  'cipher-secret-atomic-success',
  NULL,
  '["read"]'::jsonb,
  pg_catalog.statement_timestamp(),
  'Atomic success',
  '5min'
);
RESET ROLE;

DO $atomic_success_proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM public.user_exchange_connections AS connection
       WHERE connection.user_id = '22222222-2222-2222-2222-222222222222'
         AND connection.exchange = 'bybit'
         AND connection.verified_uid = 'atomic-success-uid'
         AND connection.api_key_encrypted = 'cipher-api-atomic-success'
         AND connection.api_secret_encrypted = 'cipher-secret-atomic-success'
         AND connection.scope_permissions = '["read"]'::jsonb
         AND connection.is_active IS TRUE
         AND connection.last_verified_at IS NOT NULL
     ) OR EXISTS (
       SELECT 1
       FROM public.user_exchange_connections AS connection
       WHERE connection.user_id = '22222222-2222-2222-2222-222222222222'
         AND connection.exchange = 'bybit_spot'
         AND connection.is_active IS TRUE
     ) OR NOT EXISTS (
       SELECT 1
       FROM public.trader_authorizations AS auth_row
       WHERE auth_row.user_id = '22222222-2222-2222-2222-222222222222'
         AND auth_row.platform = 'bybit_spot'
         AND auth_row.trader_id = 'atomic-success-uid'
         AND auth_row.encrypted_api_key = 'cipher-api-atomic-success'
         AND auth_row.permissions = '["read"]'::jsonb
         AND auth_row.status = 'active'
         AND auth_row.read_only_verified_at IS NOT NULL
         AND auth_row.last_verified_at IS NOT NULL
         AND auth_row.last_sync_status = 'pending'
         AND auth_row.consecutive_failures = 0
         AND auth_row.label = 'Atomic success'
         AND auth_row.sync_frequency = '5min'
     ) THEN
    RAISE EXCEPTION 'atomic account-binding success projection is incomplete';
  END IF;
END
$atomic_success_proof$;

-- Rebinding the same canonical exchange with a different product identity must
-- retire the old authorization in the same transaction that moves the shared
-- connection row.
SET ROLE service_role;
SELECT public.bind_trader_account_connection_v1(
  '22222222-2222-2222-2222-222222222222',
  'bybit',
  'atomic-rebind-uid',
  'cipher-api-atomic-rebind',
  'cipher-secret-atomic-rebind',
  NULL,
  '["read"]'::jsonb,
  pg_catalog.statement_timestamp(),
  'Atomic rebind',
  'realtime'
);
RESET ROLE;

DO $atomic_rebind_proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.user_exchange_connections
       WHERE user_id = '22222222-2222-2222-2222-222222222222'
         AND exchange = 'bybit'
         AND verified_uid = 'atomic-rebind-uid'
         AND api_key_encrypted = 'cipher-api-atomic-rebind'
         AND is_active
     ) OR NOT EXISTS (
       SELECT 1 FROM public.trader_authorizations
       WHERE user_id = '22222222-2222-2222-2222-222222222222'
         AND platform = 'bybit_spot'
         AND trader_id = 'atomic-success-uid'
         AND status = 'revoked'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.trader_authorizations
       WHERE user_id = '22222222-2222-2222-2222-222222222222'
         AND platform = 'bybit'
         AND trader_id = 'atomic-rebind-uid'
         AND status = 'active'
     ) THEN
    RAISE EXCEPTION 'canonical exchange rebind retained old live credentials';
  END IF;
END
$atomic_rebind_proof$;

-- Authorization-ID selector: both the canonical connection and every sibling
-- authorization are revoked together.
UPDATE public.user_exchange_connections
SET is_active = true
WHERE user_id = '22222222-2222-2222-2222-222222222222'
  AND exchange = 'bybit_spot';
SET ROLE service_role;
SELECT public.revoke_trader_account_connection_v1(
  '22222222-2222-2222-2222-222222222222',
  (
    SELECT id FROM public.trader_authorizations
    WHERE user_id = '22222222-2222-2222-2222-222222222222'
      AND platform = 'bybit'
      AND trader_id = 'atomic-rebind-uid'
  ),
  NULL
);
RESET ROLE;

DO $authorization_selector_revoke_proof$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.user_exchange_connections
       WHERE user_id = '22222222-2222-2222-2222-222222222222'
         AND exchange IN ('bybit', 'bybit_spot') AND is_active
     ) OR EXISTS (
       SELECT 1 FROM public.trader_authorizations
       WHERE user_id = '22222222-2222-2222-2222-222222222222'
         AND platform IN ('bybit', 'bybit_spot')
         AND status = 'active'
     ) THEN
    RAISE EXCEPTION 'authorization selector left a live credential projection';
  END IF;
END
$authorization_selector_revoke_proof$;

-- Exchange selector is the disconnect entrypoint and has the same lifecycle
-- result after a fresh bind.
SET ROLE service_role;
SELECT public.bind_trader_account_connection_v1(
  '22222222-2222-2222-2222-222222222222',
  'binance_spot',
  'atomic-disconnect-uid',
  'cipher-api-atomic-disconnect',
  'cipher-secret-atomic-disconnect',
  NULL,
  '["read"]'::jsonb,
  pg_catalog.statement_timestamp(),
  NULL,
  '15min'
);
SELECT public.revoke_trader_account_connection_v1(
  '22222222-2222-2222-2222-222222222222',
  NULL,
  'binance'
);
RESET ROLE;

DO $exchange_selector_revoke_proof$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.user_exchange_connections
       WHERE user_id = '22222222-2222-2222-2222-222222222222'
         AND exchange = 'binance' AND is_active
     ) OR EXISTS (
       SELECT 1 FROM public.trader_authorizations
       WHERE user_id = '22222222-2222-2222-2222-222222222222'
         AND platform = 'binance_spot'
         AND trader_id = 'atomic-disconnect-uid'
         AND status = 'active'
     ) THEN
    RAISE EXCEPTION 'exchange selector left a live credential projection';
  END IF;
END
$exchange_selector_revoke_proof$;

-- Force the second revocation write to fail. The connection update executes
-- first and must roll back with it.
SET ROLE service_role;
SELECT public.bind_trader_account_connection_v1(
  '22222222-2222-2222-2222-222222222222',
  'bitget',
  'atomic-revoke-rollback-uid',
  'cipher-api-revoke-rollback',
  'cipher-secret-revoke-rollback',
  'cipher-passphrase-revoke-rollback',
  '["read"]'::jsonb,
  pg_catalog.statement_timestamp(),
  NULL,
  'realtime'
);
RESET ROLE;

CREATE FUNCTION public.reject_atomic_revocation_fixture()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.trader_id = 'atomic-revoke-rollback-uid'
     AND NEW.status = 'revoked' THEN
    RAISE EXCEPTION 'forced revocation authorization failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER reject_atomic_revocation_fixture
  BEFORE UPDATE ON public.trader_authorizations
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_atomic_revocation_fixture();
SQL

if psql_cmd -c "
  SET ROLE service_role;
  SELECT public.revoke_trader_account_connection_v1(
    '22222222-2222-2222-2222-222222222222',
    NULL,
    'bitget'
  );
" >"$TMP_ROOT/revoke-rollback.log" 2>&1; then
  echo 'atomic account revocation unexpectedly survived its second-write failure' >&2
  exit 1
fi
if ! grep -q 'forced revocation authorization failure' "$TMP_ROOT/revoke-rollback.log"; then
  cat "$TMP_ROOT/revoke-rollback.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $atomic_revoke_rollback_proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.user_exchange_connections
       WHERE user_id = '22222222-2222-2222-2222-222222222222'
         AND exchange = 'bitget'
         AND verified_uid = 'atomic-revoke-rollback-uid'
         AND is_active
     ) OR NOT EXISTS (
       SELECT 1 FROM public.trader_authorizations
       WHERE user_id = '22222222-2222-2222-2222-222222222222'
         AND platform = 'bitget'
         AND trader_id = 'atomic-revoke-rollback-uid'
         AND status = 'active'
     ) THEN
    RAISE EXCEPTION 'failed atomic account revocation left partial state';
  END IF;
END
$atomic_revoke_rollback_proof$;
DROP TRIGGER reject_atomic_revocation_fixture ON public.trader_authorizations;
DROP FUNCTION public.reject_atomic_revocation_fixture();

-- Force the second projection to fail. If the function is genuinely atomic,
-- the connection upsert executed immediately before it is rolled back too.
CREATE FUNCTION public.reject_atomic_authorization_fixture()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.platform = 'okx_spot' THEN
    RAISE EXCEPTION 'forced second projection failure';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER reject_atomic_authorization_fixture
  BEFORE INSERT OR UPDATE ON public.trader_authorizations
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_atomic_authorization_fixture();
SQL

if psql_cmd -c "
  SET ROLE service_role;
  SELECT public.bind_trader_account_connection_v1(
    '22222222-2222-2222-2222-222222222222',
    'okx_spot',
    'atomic-rollback-uid',
    'cipher-api-atomic-rollback',
    'cipher-secret-atomic-rollback',
    'cipher-passphrase-atomic-rollback',
    '[\"read_only\"]'::jsonb,
    pg_catalog.statement_timestamp(),
    NULL,
    'realtime'
  );
" >"$TMP_ROOT/atomic-rollback.log" 2>&1; then
  echo 'atomic account binding unexpectedly survived its second-write failure' >&2
  exit 1
fi
if ! grep -q 'forced second projection failure' "$TMP_ROOT/atomic-rollback.log"; then
  cat "$TMP_ROOT/atomic-rollback.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $atomic_rollback_proof$
BEGIN
  IF EXISTS (
       SELECT 1
       FROM public.user_exchange_connections
       WHERE user_id = '22222222-2222-2222-2222-222222222222'
         AND exchange = 'okx'
         AND verified_uid = 'atomic-rollback-uid'
     ) OR EXISTS (
       SELECT 1
       FROM public.trader_authorizations
       WHERE user_id = '22222222-2222-2222-2222-222222222222'
         AND platform = 'okx_spot'
         AND trader_id = 'atomic-rollback-uid'
     ) THEN
    RAISE EXCEPTION 'failed atomic account binding left a partial projection';
  END IF;
END
$atomic_rollback_proof$;

DROP TRIGGER reject_atomic_authorization_fixture
  ON public.trader_authorizations;
DROP FUNCTION public.reject_atomic_authorization_fixture();

-- Remove the lifecycle fixtures so the existing ACL assertions keep their
-- original one-row baseline.
DELETE FROM public.trader_authorizations
WHERE user_id = '22222222-2222-2222-2222-222222222222'
  AND trader_id IN (
    'atomic-success-uid',
    'atomic-rebind-uid',
    'atomic-disconnect-uid',
    'atomic-revoke-rollback-uid'
  );
DELETE FROM public.user_exchange_connections
WHERE user_id = '22222222-2222-2222-2222-222222222222'
  AND exchange IN ('bybit', 'binance', 'bitget');
SQL

psql_cmd <<'SQL'
DO $legacy_wallet_quarantine_proof$
BEGIN
  IF (
       SELECT pg_catalog.count(*)
       FROM public.trader_authorizations
       WHERE id IN (
         'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
         'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3'
       )
         AND status = 'revoked'
         AND read_only_verified_at IS NULL
         AND last_sync_status = 'failed'
         AND verification_error LIKE 'Retired bind-wallet%'
         AND NOT (COALESCE(permissions, '[]'::jsonb) ? 'wallet_owner')
         AND encrypted_api_key NOT LIKE 'wallet:%'
         AND encrypted_api_secret NOT LIKE 'signature_verified:%'
     ) <> 2 THEN
    RAISE EXCEPTION 'legacy bind-wallet rows were not quarantined';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = 'public.trader_authorizations'::regclass
         AND constraint_row.conname = 'trader_authorizations_no_legacy_wallet_marker'
         AND constraint_row.convalidated
     ) THEN
    RAISE EXCEPTION 'legacy bind-wallet marker constraint is not validated';
  END IF;
END
$legacy_wallet_quarantine_proof$;

-- Keep the later ACL count assertions focused on the one non-legacy row.
DELETE FROM public.trader_authorizations
WHERE id IN (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5'
);
SQL

psql_cmd <<'SQL'
-- Simulate a later OAuth credential column plus dashboard/manual drift. Replay
-- must discover and secure the new ciphertext column without a hard-coded list.
ALTER TABLE public.trader_authorizations
  ADD COLUMN oauth_token_encrypted text;
UPDATE public.trader_authorizations
SET oauth_token_encrypted = 'cipher-oauth-alice'
WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';

GRANT SELECT ON TABLE public.trader_authorizations TO anon;
GRANT SELECT (
        encrypted_api_key,
        oauth_token_encrypted,
        read_only_verified_at,
        last_sync_status
      ),
      UPDATE (
        permissions,
        read_only_verified_at,
        last_sync_at,
        last_sync_status
      )
  ON TABLE public.trader_authorizations
  TO PUBLIC, authenticated;
CREATE POLICY "Unknown manual authorization drift"
  ON public.trader_authorizations FOR ALL TO public
  USING (true) WITH CHECK (true);
GRANT SELECT ON TABLE public.trader_authorizations
  TO manual_authorization_reader;
GRANT UPDATE (oauth_token_encrypted)
  ON TABLE public.trader_authorizations
  TO manual_authorization_reader;
GRANT EXECUTE ON FUNCTION public.bind_trader_account_connection_v1(
  uuid, text, text, text, text, text, jsonb, timestamptz, text, text
), public.revoke_trader_account_connection_v1(uuid, uuid, text)
  TO manual_authorization_reader;

-- Seed rows that both replay quarantine sweeps must touch, then replace all
-- three live trigger bodies with sentinel writers. The migration must drop the
-- old triggers before DML and rebuild their reviewed definitions afterward.
CREATE TABLE public.account_guard_replay_sentinel (label text NOT NULL);
GRANT INSERT ON TABLE public.account_guard_replay_sentinel
  TO manual_authorization_reader;
ALTER TABLE public.user_exchange_connections
  DISABLE TRIGGER exchange_connection_v1_mutation_serializer;
ALTER TABLE public.user_exchange_connections
  DISABLE TRIGGER exchange_connection_authorization_v1_contract_guard;
ALTER TABLE public.trader_authorizations
  DISABLE TRIGGER trader_authorization_v1_contract_guard;
INSERT INTO public.user_exchange_connections (
  user_id, exchange, api_key_encrypted, api_secret_encrypted, is_active,
  verified_uid, last_verified_at, scope_permissions
) VALUES (
  '22222222-2222-2222-2222-222222222222', 'mexc',
  'guard-replay-key', 'guard-replay-secret', true, 'guard-replay-uid',
  pg_catalog.now(), '["read"]'::jsonb
);
INSERT INTO public.trader_authorizations (
  id, user_id, platform, trader_id, encrypted_api_key,
  encrypted_api_secret, permissions, status, last_verified_at,
  read_only_verified_at, last_sync_status
) VALUES (
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  '22222222-2222-2222-2222-222222222222',
  'mexc', 'guard-replay-uid', 'guard-replay-key',
  'guard-replay-secret', '["read"]'::jsonb, 'active',
  pg_catalog.now(), pg_catalog.now(), 'pending'
);
ALTER TABLE public.user_exchange_connections
  ENABLE TRIGGER exchange_connection_v1_mutation_serializer;
ALTER TABLE public.user_exchange_connections
  ENABLE TRIGGER exchange_connection_authorization_v1_contract_guard;
ALTER TABLE public.trader_authorizations
  ENABLE TRIGGER trader_authorization_v1_contract_guard;

GRANT CREATE ON SCHEMA public TO manual_authorization_reader;
ALTER FUNCTION public.bind_trader_account_connection_v1(
  uuid, text, text, text, text, text, jsonb, timestamptz, text, text
) OWNER TO manual_authorization_reader;
ALTER FUNCTION public.revoke_trader_account_connection_v1(uuid, uuid, text)
  OWNER TO manual_authorization_reader;
ALTER FUNCTION public.guard_trader_authorization_v1_contract()
  OWNER TO manual_authorization_reader;
ALTER FUNCTION public.serialize_exchange_connection_v1_mutation()
  OWNER TO manual_authorization_reader;
ALTER FUNCTION public.guard_exchange_connection_authorization_v1_contract()
  OWNER TO manual_authorization_reader;
ALTER FUNCTION public.update_updated_at_column()
  OWNER TO manual_authorization_reader;
ALTER FUNCTION public.update_trader_authorizations_updated_at()
  OWNER TO manual_authorization_reader;
SET ROLE manual_authorization_reader;
CREATE OR REPLACE FUNCTION public.guard_trader_authorization_v1_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $hostile$
BEGIN
  INSERT INTO public.account_guard_replay_sentinel(label)
  VALUES ('authorization');
  RETURN NEW;
END;
$hostile$;
CREATE OR REPLACE FUNCTION public.serialize_exchange_connection_v1_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $hostile$
BEGIN
  INSERT INTO public.account_guard_replay_sentinel(label)
  VALUES ('serializer');
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$hostile$;
CREATE OR REPLACE FUNCTION public.guard_exchange_connection_authorization_v1_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $hostile$
BEGIN
  INSERT INTO public.account_guard_replay_sentinel(label)
  VALUES ('connection-authorization');
  RETURN NULL;
END;
$hostile$;
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $hostile$
BEGIN
  INSERT INTO public.account_guard_replay_sentinel(label)
  VALUES ('connection timestamp');
  RETURN NEW;
END;
$hostile$;
CREATE OR REPLACE FUNCTION public.update_trader_authorizations_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $hostile$
BEGIN
  INSERT INTO public.account_guard_replay_sentinel(label)
  VALUES ('authorization timestamp');
  RETURN NEW;
END;
$hostile$;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM manual_authorization_reader;
GRANT EXECUTE ON FUNCTION public.update_updated_at_column(),
  public.update_trader_authorizations_updated_at()
  TO historical_timestamp_executor;
SQL

# Second application proves idempotency and hostile-drift convergence.
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $guard_replay_order_proof$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.account_guard_replay_sentinel
     ) OR NOT EXISTS (
       SELECT 1
       FROM public.user_exchange_connections
       WHERE user_id = '22222222-2222-2222-2222-222222222222'
         AND exchange = 'mexc'
         AND is_active IS FALSE
     ) OR NOT EXISTS (
       SELECT 1
       FROM public.trader_authorizations
       WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
         AND status = 'revoked'
     ) THEN
    RAISE EXCEPTION
      'hostile account guard executed before replay quarantine convergence';
  END IF;
END
$guard_replay_order_proof$;
DELETE FROM public.trader_authorizations
WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
DELETE FROM public.user_exchange_connections
WHERE user_id = '22222222-2222-2222-2222-222222222222'
  AND exchange = 'mexc';
DROP TABLE public.account_guard_replay_sentinel;

CREATE FUNCTION public.assert_insufficient_privilege(
  p_sql text,
  p_label text
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RETURN;
  END;

  RAISE EXCEPTION '% unexpectedly succeeded', p_label;
END
$function$;
REVOKE ALL ON FUNCTION public.assert_insufficient_privilege(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_insufficient_privilege(text, text)
  TO anon, authenticated, service_role;

DO $catalog_proof$
DECLARE
  v_role name;
  v_privilege text;
  v_column name;
BEGIN
  IF NOT (
    SELECT relrowsecurity
    FROM pg_catalog.pg_class
    WHERE oid = 'public.trader_authorizations'::regclass
  ) THEN
    RAISE EXCEPTION 'RLS is disabled';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure_row
    WHERE procedure_row.oid IN (
      'public.bind_trader_account_connection_v1(uuid,text,text,text,text,text,jsonb,timestamptz,text,text)'::regprocedure,
      'public.revoke_trader_account_connection_v1(uuid,uuid,text)'::regprocedure,
      'public.guard_trader_authorization_v1_contract()'::regprocedure,
      'public.serialize_exchange_connection_v1_mutation()'::regprocedure,
      'public.guard_exchange_connection_authorization_v1_contract()'::regprocedure,
      'public.update_updated_at_column()'::regprocedure,
      'public.update_trader_authorizations_updated_at()'::regprocedure
    )
      AND procedure_row.proowner IS DISTINCT FROM (
        SELECT relation.relowner
        FROM pg_catalog.pg_class AS relation
        WHERE relation.oid = 'public.trader_authorizations'::regclass
      )
  ) THEN
    RAISE EXCEPTION 'custom trader-authorization function owner survived replay';
  END IF;

  IF (
    SELECT rolbypassrls
    FROM pg_catalog.pg_roles
    WHERE rolname = 'service_role'
  ) THEN
    RAISE EXCEPTION 'fixture service role unexpectedly bypasses RLS';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
  LOOP
    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(
        v_role,
        'public.trader_authorizations',
        v_privilege
      ) THEN
        RAISE EXCEPTION 'browser table privilege remains: % %', v_role, v_privilege;
      END IF;
    END LOOP;

    FOR v_column IN
      SELECT attname
      FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.trader_authorizations'::regclass
        AND attnum > 0
        AND NOT attisdropped
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'SELECT',
        'INSERT',
        'UPDATE',
        'REFERENCES'
      ]::text[]
      LOOP
        IF pg_catalog.has_column_privilege(
          v_role,
          'public.trader_authorizations',
          v_column,
          v_privilege
        ) THEN
          RAISE EXCEPTION
            'browser column privilege remains: % % %',
            v_role,
            v_privilege,
            v_column;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  IF pg_catalog.has_table_privilege(
       'manual_authorization_reader',
       'public.trader_authorizations',
       'SELECT'
     ) OR pg_catalog.has_column_privilege(
       'manual_authorization_reader',
       'public.trader_authorizations',
       'oauth_token_encrypted',
       'UPDATE'
     ) OR pg_catalog.has_function_privilege(
       'manual_authorization_reader',
       'public.bind_trader_account_connection_v1(uuid,text,text,text,text,text,jsonb,timestamptz,text,text)',
       'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'manual_authorization_reader',
       'public.revoke_trader_account_connection_v1(uuid,uuid,text)',
       'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'historical_timestamp_executor',
       'public.update_updated_at_column()',
       'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'historical_timestamp_executor',
       'public.update_trader_authorizations_updated_at()',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'custom trader-authorization ACL survived replay';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = 'public.trader_authorizations'::regclass
      AND acl_entry.grantee = 0::oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = 'public.trader_authorizations'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee = 0::oid
  ) THEN
    RAISE EXCEPTION 'PUBLIC ACL remains after replay';
  END IF;

  IF (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_policy
       WHERE polrelid = 'public.trader_authorizations'::regclass
     ) <> 1 OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy
       JOIN pg_catalog.pg_roles AS role_row
         ON policy.polroles = ARRAY[role_row.oid]::oid[]
       WHERE policy.polrelid = 'public.trader_authorizations'::regclass
         AND policy.polname = 'Service role manages trader authorizations'
         AND policy.polcmd = '*'
         AND role_row.rolname = 'service_role'
         AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
         AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
     ) THEN
    RAISE EXCEPTION 'service-only policy catalog contract failed';
  END IF;
END
$catalog_proof$;

SET ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  '11111111-1111-1111-1111-111111111111',
  false
);
SELECT public.assert_insufficient_privilege(
  $statement$
    SELECT public.bind_trader_account_connection_v1(
      '11111111-1111-1111-1111-111111111111',
      'binance',
      'browser-forged-uid',
      'browser-forged-api',
      'browser-forged-secret',
      NULL,
      '["read"]'::jsonb,
      pg_catalog.statement_timestamp(),
      NULL,
      'realtime'
    )
  $statement$,
  'authenticated atomic account binding'
);
SELECT public.assert_insufficient_privilege(
  $statement$
    SELECT public.revoke_trader_account_connection_v1(
      '11111111-1111-1111-1111-111111111111',
      NULL,
      'binance'
    )
  $statement$,
  'authenticated atomic account revocation'
);
SELECT public.assert_insufficient_privilege(
  $statement$
    SELECT
      encrypted_api_key,
      encrypted_api_secret,
      encrypted_passphrase,
      oauth_token_encrypted,
      permissions,
      read_only_verified_at,
      last_sync_at,
      last_sync_status
    FROM public.trader_authorizations
  $statement$,
  'authenticated credential/trust read'
);
SELECT public.assert_insufficient_privilege(
  $statement$
    INSERT INTO public.trader_authorizations (
      user_id,
      platform,
      trader_id,
      encrypted_api_key,
      encrypted_api_secret,
      permissions,
      read_only_verified_at,
      last_sync_status
    ) VALUES (
      '11111111-1111-1111-1111-111111111111',
      'bybit',
      'forged-uid',
      'forged-api',
      'forged-secret',
      '["trade", "withdraw"]'::jsonb,
      pg_catalog.now(),
      'success'
    )
  $statement$,
  'authenticated authorization insert'
);
SELECT public.assert_insufficient_privilege(
  $statement$
    UPDATE public.trader_authorizations
    SET permissions = '["trade", "withdraw"]'::jsonb,
        read_only_verified_at = pg_catalog.now(),
        last_sync_at = pg_catalog.now(),
        last_sync_status = 'success'
    WHERE user_id = '11111111-1111-1111-1111-111111111111'
  $statement$,
  'authenticated trust-field forgery'
);
SELECT public.assert_insufficient_privilege(
  $statement$
    DELETE FROM public.trader_authorizations
    WHERE user_id = '11111111-1111-1111-1111-111111111111'
  $statement$,
  'authenticated authorization delete'
);
SELECT public.assert_insufficient_privilege(
  'TRUNCATE TABLE public.trader_authorizations',
  'authenticated authorization truncate'
);
RESET ROLE;

SET ROLE anon;
SELECT public.assert_insufficient_privilege(
  $statement$
    SELECT public.bind_trader_account_connection_v1(
      '11111111-1111-1111-1111-111111111111',
      'binance',
      'anonymous-forged-uid',
      'anonymous-forged-api',
      'anonymous-forged-secret',
      NULL,
      '["read"]'::jsonb,
      pg_catalog.statement_timestamp(),
      NULL,
      'realtime'
    )
  $statement$,
  'anonymous atomic account binding'
);
SELECT public.assert_insufficient_privilege(
  $statement$
    SELECT public.revoke_trader_account_connection_v1(
      '11111111-1111-1111-1111-111111111111',
      NULL,
      'binance'
    )
  $statement$,
  'anonymous atomic account revocation'
);
SELECT public.assert_insufficient_privilege(
  'SELECT encrypted_api_key, read_only_verified_at FROM public.trader_authorizations',
  'anonymous authorization read'
);
SELECT public.assert_insufficient_privilege(
  $statement$
    UPDATE public.trader_authorizations
    SET read_only_verified_at = pg_catalog.now()
  $statement$,
  'anonymous trust-field forgery'
);
SELECT public.assert_insufficient_privilege(
  'DELETE FROM public.trader_authorizations',
  'anonymous authorization delete'
);
RESET ROLE;

DO $browser_write_proof$
BEGIN
  IF (
       SELECT pg_catalog.count(*)
       FROM public.trader_authorizations
     ) <> 1 OR NOT EXISTS (
       SELECT 1
       FROM public.trader_authorizations
       WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
         AND encrypted_api_key = 'cipher-api-alice'
         AND oauth_token_encrypted = 'cipher-oauth-alice'
         AND permissions = '["read"]'::jsonb
         AND last_sync_status = 'success'
     ) THEN
    RAISE EXCEPTION 'a rejected browser mutation changed authorization state';
  END IF;
END
$browser_write_proof$;

SET ROLE service_role;
DO $service_read_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.trader_authorizations
    WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
      AND encrypted_api_key = 'cipher-api-alice'
      AND encrypted_api_secret = 'cipher-secret-alice'
      AND oauth_token_encrypted = 'cipher-oauth-alice'
      AND read_only_verified_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'service read failed through explicit RLS policy';
  END IF;
END
$service_read_proof$;

INSERT INTO public.user_exchange_connections(
  user_id, exchange, api_key_encrypted, api_secret_encrypted, is_active,
  verified_uid, last_verified_at, scope_permissions
) VALUES (
  '22222222-2222-2222-2222-222222222222', 'bybit',
  'cipher-api-bob', 'cipher-secret-bob', true, 'bob-uid',
  pg_catalog.now(), '["read"]'::jsonb
);

INSERT INTO public.trader_authorizations (
  id,
  user_id,
  platform,
  trader_id,
  encrypted_api_key,
  encrypted_api_secret,
  permissions,
  read_only_verified_at,
  last_verified_at,
  last_sync_status
) VALUES (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
  '22222222-2222-2222-2222-222222222222',
  'bybit',
  'bob-uid',
  'cipher-api-bob',
  'cipher-secret-bob',
  '["read"]'::jsonb,
  (
    SELECT connection.last_verified_at
    FROM public.user_exchange_connections AS connection
    WHERE connection.user_id = '22222222-2222-2222-2222-222222222222'
      AND connection.exchange = 'bybit'
  ),
  (
    SELECT connection.last_verified_at
    FROM public.user_exchange_connections AS connection
    WHERE connection.user_id = '22222222-2222-2222-2222-222222222222'
      AND connection.exchange = 'bybit'
  ),
  'pending'
);

UPDATE public.trader_authorizations
SET last_sync_at = pg_catalog.now(),
    last_sync_status = 'success'
WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1';

DELETE FROM public.trader_authorizations
WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1';

DELETE FROM public.user_exchange_connections
WHERE user_id = '22222222-2222-2222-2222-222222222222'
  AND exchange = 'bybit';

SELECT public.assert_insufficient_privilege(
  'TRUNCATE TABLE public.trader_authorizations',
  'service authorization truncate'
);
RESET ROLE;

DO $service_delete_proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.trader_authorizations
    WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1'
  ) OR (
    SELECT pg_catalog.count(*)
    FROM public.trader_authorizations
  ) <> 1 THEN
    RAISE EXCEPTION 'service CRUD contract failed';
  END IF;
END
$service_delete_proof$;
SQL

if psql_cmd -c "
  SET ROLE service_role;
  INSERT INTO public.trader_authorizations (
    user_id, platform, trader_id, encrypted_api_key, encrypted_api_secret,
    permissions, status
  ) VALUES (
    '22222222-2222-2222-2222-222222222222',
    'gmx', 'legacy-reinsert', 'wallet:0xlegacy',
    'signature_verified:legacy', '[\"wallet_owner\"]'::jsonb, 'active'
  );
" >"$TMP_ROOT/legacy-reinsert.log" 2>&1; then
  echo 'service_role unexpectedly recreated a legacy wallet authorization' >&2
  exit 1
fi

if psql_cmd -c "
  SET ROLE service_role;
  UPDATE public.trader_authorizations
  SET permissions = '[\"wallet_owner\"]'::jsonb
  WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
" >"$TMP_ROOT/legacy-update.log" 2>&1; then
  echo 'service_role unexpectedly converted a read-only authorization to wallet_owner' >&2
  exit 1
fi

if psql_cmd -c "
  SET ROLE service_role;
  UPDATE public.trader_authorizations
  SET permissions = '[\"Wallet_Owner\"]'::jsonb
  WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
" >"$TMP_ROOT/legacy-update-case.log" 2>&1; then
  echo 'service_role unexpectedly bypassed wallet_owner retirement with mixed case' >&2
  exit 1
fi

echo "trader authorizations server-only PG17 proof passed"
