#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for postgres-owner expiry compatibility.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716174000_group_subscription_expiry_owner_compat.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ ! -f "$MIGRATION" ]]; then
  echo "Group subscription owner compatibility migration is missing: $MIGRATION" >&2
  exit 1
fi
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/group-subscription-owner-compat-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55574
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if (( exit_status != 0 )) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    echo "PostgreSQL 17 integration cluster log:" >&2
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

expect_failure() {
  local sql="$1"
  local label="$2"
  if psql_cmd -Atqc "$sql" >/dev/null 2>&1; then
    echo "Expected failure: $label" >&2
    return 1
  fi
}

expect_migration_failure() {
  local needle="$1"
  local label="$2"
  local log_file="$LOG_DIR/${label// /-}.log"
  if psql_cmd -f "$MIGRATION" >"$log_file" 2>&1; then
    echo "Expected migration failure: $label" >&2
    return 1
  fi
  if ! grep -Fq "$needle" "$log_file"; then
    cat "$log_file" >&2
    echo "Missing migration failure evidence: $needle" >&2
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
  -l "$LOG_DIR/postgres.log" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd <<'SQL'
-- The table/function owner is deliberately neither superuser nor BYPASSRLS.
CREATE ROLE postgres NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE hostile_role NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE shadow_role NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT service_role TO authenticator WITH INHERIT FALSE, SET TRUE;

GRANT USAGE ON SCHEMA public
  TO anon, authenticated, service_role, hostile_role, shadow_role;

CREATE TABLE public.groups (
  id uuid PRIMARY KEY,
  name text NOT NULL
);
ALTER TABLE public.groups OWNER TO postgres;

CREATE TABLE public.group_subscriptions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  group_id uuid NOT NULL
    REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  tier text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  price_paid numeric,
  starts_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  expires_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  payment_provider text,
  payment_reference text,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz
);
ALTER TABLE public.group_subscriptions OWNER TO postgres;
ALTER TABLE public.group_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_subscriptions FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.group_subscriptions TO service_role;
CREATE POLICY service_role_manages_group_subscriptions
  ON public.group_subscriptions
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.expire_group_subscriptions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  affected integer;
BEGIN
  UPDATE public.group_subscriptions
  SET status = 'expired',
      updated_at = pg_catalog.clock_timestamp()
  WHERE status = 'active'
    AND expires_at <= pg_catalog.clock_timestamp();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END
$function$;
ALTER FUNCTION public.expire_group_subscriptions() OWNER TO postgres;
-- Preserve the historical default PUBLIC execute drift. The forward migration
-- must discover it, remove it, and retain only service execution.
GRANT EXECUTE ON FUNCTION public.expire_group_subscriptions() TO service_role;

INSERT INTO public.groups (id, name) VALUES
  ('10000000-0000-4000-8000-000000000001', 'Expiry'),
  ('20000000-0000-4000-8000-000000000002', 'Cascade');
INSERT INTO public.group_subscriptions (
  id, group_id, user_id, tier, status, price_paid, expires_at,
  payment_provider, payment_reference
) VALUES (
  '30000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000004',
  'monthly',
  'active',
  9.90,
  pg_catalog.clock_timestamp() - interval '1 day',
  'stripe',
  'pi_expired'
);
SQL

# Under FORCE RLS, the SECURITY DEFINER switches to the postgres owner, finds
# no postgres policy, and silently updates zero rows.
psql_cmd <<'SQL'
DO $forced_owner_regression$
DECLARE
  postgres_is_privileged boolean;
BEGIN
  SELECT role_row.rolsuper OR role_row.rolbypassrls
  INTO STRICT postgres_is_privileged
  FROM pg_catalog.pg_roles AS role_row
  WHERE role_row.rolname = 'postgres';

  IF postgres_is_privileged THEN
    RAISE EXCEPTION 'proof owner unexpectedly bypasses RLS';
  END IF;
END
$forced_owner_regression$;

SET ROLE service_role;
DO $force_breaks_expiry$
BEGIN
  IF public.expire_group_subscriptions() <> 0 THEN
    RAISE EXCEPTION 'FORCE RLS unexpectedly allowed the owner-side expiry update';
  END IF;
  IF (
    SELECT status
    FROM public.group_subscriptions
    WHERE id = '30000000-0000-4000-8000-000000000003'
  ) IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'FORCE RLS regression fixture was already changed';
  END IF;
END
$force_breaks_expiry$;
RESET ROLE;
SQL

psql_cmd -f "$MIGRATION" >"$LOG_DIR/first-application.log"

psql_cmd <<'SQL'
DO $first_catalog_contract$
DECLARE
  postgres_oid oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres'
  );
  service_oid oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role'
  );
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_subscriptions'::pg_catalog.regclass
      AND relation.relowner = postgres_oid
      AND relation.relrowsecurity
      AND NOT relation.relforcerowsecurity
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid =
        'public.group_subscriptions'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> postgres_oid
  ) THEN
    RAISE EXCEPTION 'owner-compatible table/RLS/column ACL contract failed';
  END IF;

  IF EXISTS (
    WITH expected(grantee, grantor, privilege_type, is_grantable) AS (
      VALUES
        (service_oid, postgres_oid, 'DELETE'::text, false),
        (service_oid, postgres_oid, 'INSERT'::text, false),
        (service_oid, postgres_oid, 'SELECT'::text, false),
        (service_oid, postgres_oid, 'UPDATE'::text, false)
    ),
    actual AS (
      SELECT acl_entry.grantee,
             acl_entry.grantor,
             acl_entry.privilege_type::text,
             acl_entry.is_grantable
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS acl_entry
      WHERE relation.oid = 'public.group_subscriptions'::pg_catalog.regclass
        AND acl_entry.grantee <> relation.relowner
    )
    SELECT 1
    FROM expected
    FULL JOIN actual
      USING (grantee, grantor, privilege_type, is_grantable)
    WHERE expected.grantee IS NULL OR actual.grantee IS NULL
  ) THEN
    RAISE EXCEPTION 'exact service table ACL contract failed';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_subscriptions'::pg_catalog.regclass
      AND policy.polname = 'service_role_manages_group_subscriptions'
      AND policy.polroles = ARRAY[service_oid]::oid[]
      AND policy.polcmd = '*'
      AND policy.polpermissive
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_subscriptions'::pg_catalog.regclass
  ) <> 1 THEN
    RAISE EXCEPTION 'exact service policy contract failed';
  END IF;

  IF EXISTS (
    WITH expected(grantee, grantor, privilege_type, is_grantable) AS (
      VALUES (service_oid, postgres_oid, 'EXECUTE'::text, false)
    ),
    actual AS (
      SELECT acl_entry.grantee,
             acl_entry.grantor,
             acl_entry.privilege_type::text,
             acl_entry.is_grantable
      FROM pg_catalog.pg_proc AS procedure_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(procedure_row.proacl) AS acl_entry
      WHERE procedure_row.oid =
        'public.expire_group_subscriptions()'::pg_catalog.regprocedure
        AND acl_entry.grantee <> procedure_row.proowner
    )
    SELECT 1
    FROM expected
    FULL JOIN actual
      USING (grantee, grantor, privilege_type, is_grantable)
    WHERE expected.grantee IS NULL OR actual.grantee IS NULL
  ) THEN
    RAISE EXCEPTION 'exact expiry function ACL contract failed';
  END IF;
END
$first_catalog_contract$;

SET ROLE service_role;
DO $owner_expiry_and_service_crud$
BEGIN
  IF public.expire_group_subscriptions() <> 1 THEN
    RAISE EXCEPTION 'postgres-owned SECURITY DEFINER expiry did not update';
  END IF;
  IF (
    SELECT status
    FROM public.group_subscriptions
    WHERE id = '30000000-0000-4000-8000-000000000003'
  ) IS DISTINCT FROM 'expired' THEN
    RAISE EXCEPTION 'expired subscription status was not persisted';
  END IF;
END
$owner_expiry_and_service_crud$;

INSERT INTO public.group_subscriptions (
  id, group_id, user_id, tier, status, price_paid, expires_at,
  payment_provider, payment_reference
) VALUES (
  '50000000-0000-4000-8000-000000000005',
  '10000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000006',
  'yearly',
  'active',
  99.90,
  pg_catalog.clock_timestamp() + interval '1 year',
  'stripe',
  'pi_service'
);
DO $service_select$
BEGIN
  IF (
    SELECT payment_reference
    FROM public.group_subscriptions
    WHERE id = '50000000-0000-4000-8000-000000000005'
  ) IS DISTINCT FROM 'pi_service' THEN
    RAISE EXCEPTION 'NOBYPASSRLS service SELECT failed';
  END IF;
END
$service_select$;
UPDATE public.group_subscriptions
SET status = 'cancelled', cancelled_at = pg_catalog.clock_timestamp()
WHERE id = '50000000-0000-4000-8000-000000000005';
DELETE FROM public.group_subscriptions
WHERE id = '50000000-0000-4000-8000-000000000005';
RESET ROLE;
SQL

expect_failure \
  "SET ROLE anon; SELECT public.expire_group_subscriptions()" \
  'anonymous expiry function execution'
expect_failure \
  "SET ROLE authenticated; SELECT public.expire_group_subscriptions()" \
  'authenticated expiry function execution'
expect_failure \
  "SET ROLE anon; SELECT id FROM public.group_subscriptions" \
  'anonymous subscription SELECT'
expect_failure \
  "SET ROLE authenticated; UPDATE public.group_subscriptions SET status='active'" \
  'authenticated subscription UPDATE'

# Add table, future-column, policy, function, RLS and dependent-grant drift.
psql_cmd <<'SQL'
ALTER TABLE public.group_subscriptions
  ADD COLUMN processor_payload jsonb;
ALTER TABLE public.group_subscriptions DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_subscriptions FORCE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE public.group_subscriptions
  TO hostile_role WITH GRANT OPTION;
SET ROLE hostile_role;
GRANT SELECT ON TABLE public.group_subscriptions TO shadow_role;
RESET ROLE;
GRANT SELECT (payment_reference, processor_payload),
      INSERT (processor_payload),
      UPDATE (processor_payload)
  ON TABLE public.group_subscriptions
  TO authenticated, hostile_role;
CREATE POLICY late_unknown_subscription_writer
  ON public.group_subscriptions
  FOR ALL TO authenticated, hostile_role
  USING (true) WITH CHECK (true);

GRANT EXECUTE ON FUNCTION public.expire_group_subscriptions()
  TO hostile_role WITH GRANT OPTION;
SET ROLE hostile_role;
GRANT EXECUTE ON FUNCTION public.expire_group_subscriptions() TO shadow_role;
RESET ROLE;

UPDATE public.group_subscriptions
SET status = 'active',
    expires_at = pg_catalog.clock_timestamp() - interval '1 day'
WHERE id = '30000000-0000-4000-8000-000000000003';
SQL

psql_cmd -f "$MIGRATION" >"$LOG_DIR/replay-application.log"

psql_cmd <<'SQL'
DO $replay_contract$
DECLARE
  postgres_oid oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres'
  );
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_subscriptions'::pg_catalog.regclass
      AND relation.relrowsecurity
      AND NOT relation.relforcerowsecurity
      AND relation.relowner = postgres_oid
  ) OR pg_catalog.has_table_privilege(
    'hostile_role', 'public.group_subscriptions', 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'shadow_role', 'public.group_subscriptions', 'SELECT'
  ) OR pg_catalog.has_column_privilege(
    'authenticated',
    'public.group_subscriptions',
    'processor_payload',
    'SELECT'
  ) OR pg_catalog.has_function_privilege(
    'hostile_role',
    'public.expire_group_subscriptions()',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'shadow_role',
    'public.expire_group_subscriptions()',
    'EXECUTE'
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_subscriptions'::pg_catalog.regclass
  ) <> 1 THEN
    RAISE EXCEPTION 'replay did not converge unknown authority/RLS drift';
  END IF;
END
$replay_contract$;

SET ROLE service_role;
DO $replayed_expiry$
BEGIN
  IF public.expire_group_subscriptions() <> 1 THEN
    RAISE EXCEPTION 'expiry writer failed after replay convergence';
  END IF;
END
$replayed_expiry$;
RESET ROLE;
SQL

# NO FORCE is safe only while unprivileged/browser roles cannot inherit or SET
# the postgres table-owner role. The migration must fail before changing state.
psql_cmd -c \
  'GRANT postgres TO authenticated WITH INHERIT TRUE, SET FALSE' >/dev/null
expect_migration_failure \
  'group subscription owner or service-role inheritance graph is unsafe' \
  'owner-inheritance-drift'
psql_cmd -c 'REVOKE postgres FROM authenticated' >/dev/null
psql_cmd -f "$MIGRATION" >"$LOG_DIR/post-inheritance-replay.log"

# The validated FK and service policy must still allow parent hard-delete
# cascade without leaving a paid entitlement orphan.
psql_cmd <<'SQL'
ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.groups FORCE ROW LEVEL SECURITY;
GRANT SELECT, DELETE ON TABLE public.groups TO service_role;
CREATE POLICY service_role_deletes_groups
  ON public.groups
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

INSERT INTO public.group_subscriptions (
  id, group_id, user_id, tier, status, price_paid, expires_at,
  payment_provider, payment_reference, processor_payload
) VALUES (
  '70000000-0000-4000-8000-000000000007',
  '20000000-0000-4000-8000-000000000002',
  '80000000-0000-4000-8000-000000000008',
  'monthly',
  'active',
  12.50,
  pg_catalog.clock_timestamp() + interval '30 days',
  'stripe',
  'pi_cascade',
  '{"verified":true}'::jsonb
);

SET ROLE service_role;
DELETE FROM public.groups
WHERE id = '20000000-0000-4000-8000-000000000002';
RESET ROLE;

DO $cascade_result$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.group_subscriptions
    WHERE id = '70000000-0000-4000-8000-000000000007'
  ) THEN
    RAISE EXCEPTION 'group parent hard-delete did not cascade subscriptions';
  END IF;
END
$cascade_result$;
SQL

echo "group subscription expiry owner compatibility PG17 proof passed"
