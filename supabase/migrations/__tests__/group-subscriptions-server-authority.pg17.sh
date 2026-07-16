#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for the paid-group subscription authority ACL.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716172000_group_subscriptions_server_authority.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/group-subscriptions-authority-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55572
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -200 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
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
  local log_file="$TMP_ROOT/${label// /-}.log"
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
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT;
CREATE ROLE hostile_role NOLOGIN;
CREATE ROLE shadow_role NOLOGIN;
CREATE ROLE hostile_parent NOLOGIN;
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

-- Reproduce the vulnerable historical ACL/policies and unknown manual drift.
GRANT ALL PRIVILEGES ON TABLE public.group_subscriptions
  TO PUBLIC, anon, authenticated, service_role, hostile_role;
GRANT SELECT (payment_provider, payment_reference, price_paid),
      INSERT (group_id, user_id, tier, status, price_paid, starts_at,
              expires_at, payment_provider, payment_reference),
      UPDATE (status, price_paid, expires_at, payment_provider,
              payment_reference)
  ON TABLE public.group_subscriptions
  TO PUBLIC, anon, authenticated, service_role, hostile_role;

CREATE POLICY "Users can create their own subscriptions"
  ON public.group_subscriptions
  FOR INSERT TO public
  WITH CHECK (true);
CREATE POLICY "Users can view their own subscriptions"
  ON public.group_subscriptions
  FOR SELECT TO public
  USING (true);
CREATE POLICY "Unknown dashboard payment reader"
  ON public.group_subscriptions
  FOR SELECT TO hostile_role
  USING (true);
CREATE POLICY "Legacy service writer"
  ON public.group_subscriptions
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

INSERT INTO public.groups (id, name) VALUES
  ('10000000-0000-4000-8000-000000000001', 'Existing'),
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
  pg_catalog.clock_timestamp() + interval '30 days',
  'stripe',
  'pi_existing'
);
SQL

# A drifted owner must fail before any ACL or policy is changed.
psql_cmd -c \
  'ALTER TABLE public.group_subscriptions OWNER TO hostile_role' >/dev/null
expect_migration_failure \
  'ordinary permanent postgres-owned tables' \
  'owner-drift'
psql_cmd <<'SQL'
DO $rollback_proof$
BEGIN
  IF NOT pg_catalog.has_table_privilege(
    'authenticated',
    'public.group_subscriptions',
    'INSERT'
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_subscriptions'::pg_catalog.regclass
  ) <> 4 THEN
    RAISE EXCEPTION 'owner preflight failure did not leave authority unchanged';
  END IF;
END
$rollback_proof$;
ALTER TABLE public.group_subscriptions OWNER TO postgres;
SQL

# Any non-gateway service-role membership is a fail-closed deployment barrier.
psql_cmd -c \
  'GRANT service_role TO hostile_role WITH INHERIT TRUE, SET FALSE' >/dev/null
expect_migration_failure \
  'service_role membership or inheritance graph is unsafe' \
  'role-inheritance-drift'
psql_cmd -c 'REVOKE service_role FROM hostile_role' >/dev/null

# JWT roles must not inherit postgres/service through an intermediate role.
psql_cmd <<'SQL'
GRANT postgres TO hostile_parent WITH INHERIT TRUE, SET FALSE;
GRANT hostile_parent TO authenticated WITH INHERIT TRUE, SET FALSE;
SQL
expect_migration_failure \
  'service_role membership or inheritance graph is unsafe' \
  'jwt-inheritance-drift'
psql_cmd <<'SQL'
REVOKE hostile_parent FROM authenticated;
REVOKE postgres FROM hostile_parent;
SQL

# First successful application converges all historical and unknown drift.
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $first_application_proof$
DECLARE
  v_service_oid oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role'
  );
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.group_subscriptions) <> 1
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = 'public.group_subscriptions'::pg_catalog.regclass
        AND relation.relrowsecurity
        AND relation.relforcerowsecurity
        AND relation.relowner = (
          SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres'
        )
    ) OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = 'public.group_subscriptions'::pg_catalog.regclass
        AND policy.polname = 'service_role_manages_group_subscriptions'
        AND policy.polroles = ARRAY[v_service_oid]::oid[]
    ) <> 1
  THEN
    RAISE EXCEPTION 'first subscription authority application failed';
  END IF;
END
$first_application_proof$;
SQL

expect_failure \
  "SET ROLE authenticated; SELECT payment_provider, payment_reference FROM public.group_subscriptions" \
  'authenticated payment metadata SELECT'
expect_failure \
  "SET ROLE authenticated; INSERT INTO public.group_subscriptions (group_id,user_id,tier,status,price_paid,expires_at,payment_provider,payment_reference) VALUES ('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000005','yearly','active',0,clock_timestamp()+interval '1 year','forged','forged')" \
  'authenticated forged active INSERT'
expect_failure \
  "SET ROLE anon; SELECT id FROM public.group_subscriptions" \
  'anonymous subscription SELECT'
expect_failure \
  "SET ROLE hostile_role; SELECT id FROM public.group_subscriptions" \
  'unknown grantee subscription SELECT'

# NOBYPASSRLS service CRUD proves the explicit policy and exact table ACL work.
psql_cmd <<'SQL'
SET ROLE service_role;
INSERT INTO public.group_subscriptions (
  id, group_id, user_id, tier, status, price_paid, expires_at,
  payment_provider, payment_reference
) VALUES (
  '60000000-0000-4000-8000-000000000006',
  '10000000-0000-4000-8000-000000000001',
  '70000000-0000-4000-8000-000000000007',
  'monthly',
  'active',
  12.50,
  pg_catalog.clock_timestamp() + interval '30 days',
  'stripe',
  'pi_service'
);
DO $service_read$
BEGIN
  IF (
    SELECT payment_reference
    FROM public.group_subscriptions
    WHERE id = '60000000-0000-4000-8000-000000000006'
  ) IS DISTINCT FROM 'pi_service' THEN
    RAISE EXCEPTION 'service SELECT failed';
  END IF;
END
$service_read$;
UPDATE public.group_subscriptions
SET status = 'cancelled',
    cancelled_at = pg_catalog.clock_timestamp()
WHERE id = '60000000-0000-4000-8000-000000000006';
DELETE FROM public.group_subscriptions
WHERE id = '60000000-0000-4000-8000-000000000006';
RESET ROLE;
SQL

# Reintroduce policy, table, column, future-column and RLS drift. A dependent
# grant proves the dynamic REVOKE uses CASCADE rather than silently stopping.
psql_cmd <<'SQL'
ALTER TABLE public.group_subscriptions
  ADD COLUMN processor_payload jsonb;
ALTER TABLE public.group_subscriptions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.group_subscriptions DISABLE ROW LEVEL SECURITY;
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
CREATE POLICY "Late unknown metadata reader"
  ON public.group_subscriptions
  FOR SELECT TO authenticated, hostile_role
  USING (true);
SQL

# Second successful application must discover and remove every new drift path.
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $replay_and_cascade_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_subscriptions'::pg_catalog.regclass
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) OR pg_catalog.has_table_privilege(
    'hostile_role',
    'public.group_subscriptions',
    'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'shadow_role',
    'public.group_subscriptions',
    'SELECT'
  ) OR pg_catalog.has_column_privilege(
    'authenticated',
    'public.group_subscriptions',
    'processor_payload',
    'SELECT'
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_subscriptions'::pg_catalog.regclass
  ) <> 1 THEN
    RAISE EXCEPTION 'second application did not converge unknown drift';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.group_subscriptions'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'public.groups'::pg_catalog.regclass
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.convalidated
  ) <> 1 THEN
    RAISE EXCEPTION 'group subscription parent cascade drifted';
  END IF;
END
$replay_and_cascade_proof$;

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.groups FORCE ROW LEVEL SECURITY;
GRANT SELECT, DELETE ON TABLE public.groups TO service_role;
CREATE POLICY service_role_deletes_groups
  ON public.groups
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

SET ROLE service_role;
INSERT INTO public.group_subscriptions (
  id, group_id, user_id, tier, status, price_paid, expires_at,
  payment_provider, payment_reference, processor_payload
) VALUES (
  '80000000-0000-4000-8000-000000000008',
  '20000000-0000-4000-8000-000000000002',
  '90000000-0000-4000-8000-000000000009',
  'yearly',
  'active',
  99.90,
  pg_catalog.clock_timestamp() + interval '1 year',
  'stripe',
  'pi_cascade',
  '{"verified":true}'::jsonb
);
DELETE FROM public.groups
WHERE id = '20000000-0000-4000-8000-000000000002';
RESET ROLE;

DO $cascade_result$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.group_subscriptions
    WHERE id = '80000000-0000-4000-8000-000000000008'
  ) THEN
    RAISE EXCEPTION 'deleting the parent group did not cascade subscriptions';
  END IF;
END
$cascade_result$;
SQL

expect_failure \
  "SET ROLE authenticated; SELECT processor_payload FROM public.group_subscriptions" \
  'authenticated future metadata SELECT after replay'
expect_failure \
  "SET ROLE authenticated; UPDATE public.group_subscriptions SET payment_reference='forged'" \
  'authenticated payment metadata UPDATE after replay'

echo "group subscription server authority PG17 proof passed"
