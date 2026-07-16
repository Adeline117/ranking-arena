#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for the exchange-connection base-table ACL.
# It owns an isolated temporary cluster and never connects to local or remote
# application databases.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716112000_exchange_connections_server_only.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/exchange-connections-acl-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55468
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
-- Deliberately do not grant BYPASSRLS: successful service CRUD below proves
-- that the migration's explicit service policy is functional, not decorative.
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;

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

-- Start without the required unique owner key so preflight rollback can be
-- proved before the fixture is brought to the production contract.
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
  updated_at timestamptz DEFAULT pg_catalog.now()
);

ALTER TABLE public.user_exchange_connections ENABLE ROW LEVEL SECURITY;

-- Reproduce both Supabase's broad historical defaults and direct column ACLs.
-- Revoking the table ACL alone would leave these column paths open.
GRANT ALL PRIVILEGES ON TABLE public.user_exchange_connections
  TO PUBLIC, anon, authenticated, service_role;
GRANT SELECT (
  api_key_encrypted,
  api_secret_encrypted,
  verified_uid,
  last_verified_at,
  scope_permissions
), UPDATE (
  verified_uid,
  last_verified_at,
  scope_permissions
) ON TABLE public.user_exchange_connections
  TO PUBLIC, anon, authenticated, service_role;
GRANT INSERT (
  id,
  user_id,
  exchange,
  api_key_encrypted,
  api_secret_encrypted,
  verified_uid,
  last_verified_at,
  scope_permissions
) ON TABLE public.user_exchange_connections
  TO PUBLIC, anon, authenticated, service_role;

CREATE POLICY "Users can view own exchange connections"
  ON public.user_exchange_connections FOR SELECT TO public
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can insert own exchange connections"
  ON public.user_exchange_connections FOR INSERT TO public
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can update own exchange connections"
  ON public.user_exchange_connections FOR UPDATE TO public
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can delete own exchange connections"
  ON public.user_exchange_connections FOR DELETE TO public
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Dashboard verification writer"
  ON public.user_exchange_connections FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);
CREATE POLICY "Legacy service role all"
  ON public.user_exchange_connections FOR ALL TO service_role
  USING (true) WITH CHECK (true);

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

INSERT INTO public.user_exchange_connections (
  id,
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
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
  '11111111-1111-1111-1111-111111111111',
  'binance',
  'cipher-api-alice',
  'cipher-secret-alice',
  'cipher-passphrase-alice',
  true,
  'alice-verified-uid',
  pg_catalog.now(),
  '["read"]'::jsonb
);
SQL

# The strict schema preflight must fail and roll back before touching any ACL
# when the server upsert's unique (user_id, exchange) target is missing.
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/preflight.log" 2>&1; then
  echo "exchange ACL migration unexpectedly passed without the owner key" >&2
  exit 1
fi
if ! grep -q \
  'requires a valid unique (user_id, exchange) key' \
  "$TMP_ROOT/preflight.log"; then
  cat "$TMP_ROOT/preflight.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $proof$
BEGIN
  IF NOT pg_catalog.has_table_privilege(
       'authenticated',
       'public.user_exchange_connections',
       'UPDATE'
     ) OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_policy
       WHERE polrelid = 'public.user_exchange_connections'::regclass
     ) <> 6 THEN
    RAISE EXCEPTION 'preflight failure did not roll back cleanly';
  END IF;
END
$proof$;

ALTER TABLE public.user_exchange_connections
  ADD CONSTRAINT user_exchange_connections_user_id_exchange_key
  UNIQUE (user_id, exchange);
SQL

# First application closes every historical privilege and policy path.
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $first_replay_proof$
BEGIN
  IF (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_policy
       WHERE polrelid = 'public.user_exchange_connections'::regclass
     ) <> 1 OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy
       WHERE polrelid = 'public.user_exchange_connections'::regclass
         AND polname = 'Service role manages exchange connections'
         AND polcmd = '*'
     ) THEN
    RAISE EXCEPTION 'first replay did not converge policies';
  END IF;
END
$first_replay_proof$;

-- These OAuth ciphertext columns historically existed only in some deployed
-- schemas. Adding them after the first clean-baseline replay proves the second
-- replay discovers and secures every live column without a hard-coded list.
ALTER TABLE public.user_exchange_connections
  ADD COLUMN access_token_encrypted text,
  ADD COLUMN refresh_token_encrypted text;
UPDATE public.user_exchange_connections
SET access_token_encrypted = 'cipher-access-alice',
    refresh_token_encrypted = 'cipher-refresh-alice'
WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';

-- Simulate later dashboard/manual drift. The second replay must dynamically
-- remove this unknown policy and both table- and column-level browser grants.
GRANT SELECT ON TABLE public.user_exchange_connections TO anon;
GRANT SELECT (
        api_key_encrypted,
        access_token_encrypted,
        refresh_token_encrypted,
        verified_uid,
        scope_permissions
      ),
      UPDATE (verified_uid, scope_permissions)
  ON TABLE public.user_exchange_connections
  TO PUBLIC, authenticated;
CREATE POLICY "Unknown manual browser drift"
  ON public.user_exchange_connections FOR ALL TO public
  USING (true) WITH CHECK (true);
SQL

# Second application proves idempotency and drift convergence.
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
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
    WHERE oid = 'public.user_exchange_connections'::regclass
  ) THEN
    RAISE EXCEPTION 'RLS is disabled';
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
        'public.user_exchange_connections',
        v_privilege
      ) THEN
        RAISE EXCEPTION 'browser table privilege remains: % %', v_role, v_privilege;
      END IF;
    END LOOP;

    FOR v_column IN
      SELECT attname
      FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.user_exchange_connections'::regclass
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
          'public.user_exchange_connections',
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

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = 'public.user_exchange_connections'::regclass
      AND acl_entry.grantee = 0::oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = 'public.user_exchange_connections'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee = 0::oid
  ) THEN
    RAISE EXCEPTION 'PUBLIC ACL remains after replay';
  END IF;

  FOREACH v_privilege IN ARRAY ARRAY[
    'SELECT',
    'INSERT',
    'UPDATE',
    'DELETE'
  ]::text[]
  LOOP
    IF NOT pg_catalog.has_table_privilege(
      'service_role',
      'public.user_exchange_connections',
      v_privilege
    ) THEN
      RAISE EXCEPTION 'service CRUD privilege missing: %', v_privilege;
    END IF;
  END LOOP;

  FOREACH v_privilege IN ARRAY ARRAY[
    'TRUNCATE',
    'REFERENCES',
    'TRIGGER'
  ]::text[]
  LOOP
    IF pg_catalog.has_table_privilege(
      'service_role',
      'public.user_exchange_connections',
      v_privilege
    ) THEN
      RAISE EXCEPTION 'service excess privilege remains: %', v_privilege;
    END IF;
  END LOOP;

  IF (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_policy
       WHERE polrelid = 'public.user_exchange_connections'::regclass
     ) <> 1 OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy
       JOIN pg_catalog.pg_roles AS role_row
         ON policy.polroles = ARRAY[role_row.oid]::oid[]
       WHERE policy.polrelid = 'public.user_exchange_connections'::regclass
         AND policy.polname = 'Service role manages exchange connections'
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
    SELECT
      api_key_encrypted,
      api_secret_encrypted,
      passphrase_encrypted,
      access_token_encrypted,
      refresh_token_encrypted,
      verified_uid,
      last_verified_at,
      scope_permissions
    FROM public.user_exchange_connections
  $statement$,
  'authenticated ciphertext and verification read'
);
SELECT public.assert_insufficient_privilege(
  $statement$
    INSERT INTO public.user_exchange_connections (
      id,
      user_id,
      exchange,
      api_key_encrypted,
      api_secret_encrypted,
      verified_uid,
      last_verified_at,
      scope_permissions
    ) VALUES (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
      '11111111-1111-1111-1111-111111111111',
      'bybit',
      'forged-api',
      'forged-secret',
      'forged-verified-uid',
      pg_catalog.now(),
      '["trade", "withdraw"]'::jsonb
    )
  $statement$,
  'authenticated connection insert'
);
SELECT public.assert_insufficient_privilege(
  $statement$
    UPDATE public.user_exchange_connections
    SET verified_uid = 'forged-verified-uid',
        last_verified_at = pg_catalog.now(),
        scope_permissions = '["trade", "withdraw"]'::jsonb
    WHERE user_id = '11111111-1111-1111-1111-111111111111'
  $statement$,
  'authenticated ownership proof forgery'
);
SELECT public.assert_insufficient_privilege(
  $statement$
    DELETE FROM public.user_exchange_connections
    WHERE user_id = '11111111-1111-1111-1111-111111111111'
  $statement$,
  'authenticated connection delete'
);
SELECT public.assert_insufficient_privilege(
  'TRUNCATE TABLE public.user_exchange_connections',
  'authenticated connection truncate'
);
RESET ROLE;

SET ROLE anon;
SELECT public.assert_insufficient_privilege(
  $statement$
    SELECT
      api_key_encrypted,
      api_secret_encrypted,
      access_token_encrypted,
      refresh_token_encrypted,
      verified_uid,
      last_verified_at,
      scope_permissions
    FROM public.user_exchange_connections
  $statement$,
  'anonymous ciphertext and verification read'
);
SELECT public.assert_insufficient_privilege(
  $statement$
    INSERT INTO public.user_exchange_connections (
      id,
      user_id,
      exchange,
      api_key_encrypted,
      api_secret_encrypted,
      verified_uid,
      last_verified_at,
      scope_permissions
    ) VALUES (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
      '22222222-2222-2222-2222-222222222222',
      'okx',
      'forged-api',
      'forged-secret',
      'forged-verified-uid',
      pg_catalog.now(),
      '["withdraw"]'::jsonb
    )
  $statement$,
  'anonymous connection insert'
);
SELECT public.assert_insufficient_privilege(
  $statement$
    UPDATE public.user_exchange_connections
    SET verified_uid = 'forged-verified-uid',
        scope_permissions = '["withdraw"]'::jsonb
  $statement$,
  'anonymous ownership proof forgery'
);
SELECT public.assert_insufficient_privilege(
  'DELETE FROM public.user_exchange_connections',
  'anonymous connection delete'
);
SELECT public.assert_insufficient_privilege(
  'TRUNCATE TABLE public.user_exchange_connections',
  'anonymous connection truncate'
);
RESET ROLE;

DO $browser_write_proof$
BEGIN
  IF (
       SELECT pg_catalog.count(*)
       FROM public.user_exchange_connections
     ) <> 1 OR NOT EXISTS (
       SELECT 1
       FROM public.user_exchange_connections
       WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
         AND verified_uid = 'alice-verified-uid'
         AND scope_permissions = '["read"]'::jsonb
     ) THEN
    RAISE EXCEPTION 'a rejected browser mutation changed connection state';
  END IF;
END
$browser_write_proof$;

SET ROLE service_role;
DO $service_read_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_exchange_connections
    WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
      AND api_key_encrypted = 'cipher-api-alice'
      AND access_token_encrypted = 'cipher-access-alice'
      AND refresh_token_encrypted = 'cipher-refresh-alice'
      AND verified_uid = 'alice-verified-uid'
      AND scope_permissions = '["read"]'::jsonb
  ) THEN
    RAISE EXCEPTION 'service read failed through explicit RLS policy';
  END IF;
END
$service_read_proof$;

INSERT INTO public.user_exchange_connections (
  id,
  user_id,
  exchange,
  api_key_encrypted,
  api_secret_encrypted,
  is_active,
  verified_uid,
  last_verified_at,
  scope_permissions
) VALUES (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
  '22222222-2222-2222-2222-222222222222',
  'bybit',
  'cipher-api-bob',
  'cipher-secret-bob',
  true,
  'bob-verified-uid',
  pg_catalog.now(),
  '["read"]'::jsonb
);

UPDATE public.user_exchange_connections
SET verified_uid = 'bob-updated-uid',
    scope_permissions = '["read", "positions"]'::jsonb
WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1';

DO $service_update_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_exchange_connections
    WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1'
      AND verified_uid = 'bob-updated-uid'
      AND scope_permissions = '["read", "positions"]'::jsonb
  ) THEN
    RAISE EXCEPTION 'service update failed';
  END IF;
END
$service_update_proof$;

DELETE FROM public.user_exchange_connections
WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1';

SELECT public.assert_insufficient_privilege(
  'TRUNCATE TABLE public.user_exchange_connections',
  'service connection truncate'
);
RESET ROLE;

DO $service_delete_proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.user_exchange_connections
    WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1'
  ) OR (
    SELECT pg_catalog.count(*)
    FROM public.user_exchange_connections
  ) <> 1 THEN
    RAISE EXCEPTION 'service delete contract failed';
  END IF;
END
$service_delete_proof$;
SQL

echo "exchange connections server-only PG17 proof passed"
