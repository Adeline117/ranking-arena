#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for atomic Pro official-group allocation.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716177000_atomic_pro_official_groups.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ ! -f "$MIGRATION" ]]; then
  echo "Atomic Pro official-group migration is missing: $MIGRATION" >&2
  exit 1
fi
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/atomic-pro-official-groups-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55597
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_status=$?
  if (( exit_status != 0 )) && [[ -f "$LOG_FILE" ]]; then
    echo "PostgreSQL 17 integration cluster log:" >&2
    tail -200 "$LOG_FILE" >&2 || true
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
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd() {
  "$PG_BIN/psql" \
    -X \
    -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" \
    -p "$PORT" \
    -d postgres \
    "$@"
}

expect_migration_failure() {
  local needle="$1"
  local label="$2"
  local output="$TMP_ROOT/$label.log"
  if psql_cmd -f "$MIGRATION" >"$output" 2>&1; then
    echo "Migration unexpectedly accepted $label" >&2
    return 1
  fi
  if ! grep -Fq "$needle" "$output"; then
    cat "$output" >&2
    echo "Missing migration failure evidence: $needle" >&2
    return 1
  fi
}

expect_sql_failure() {
  local needle="$1"
  local label="$2"
  local statement="$3"
  local output="$TMP_ROOT/$label.log"
  if psql_cmd -c "$statement" >"$output" 2>&1; then
    echo "Statement unexpectedly succeeded: $label" >&2
    return 1
  fi
  if ! grep -Fq "$needle" "$output"; then
    cat "$output" >&2
    echo "Missing SQL failure evidence: $needle" >&2
    return 1
  fi
}

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOINHERIT NOBYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT;
CREATE ROLE hostile_role NOLOGIN;
GRANT service_role TO authenticator WITH INHERIT FALSE, SET TRUE;

ALTER SCHEMA public OWNER TO postgres;
GRANT USAGE ON SCHEMA public
  TO anon, authenticated, service_role, authenticator, hostile_role;

SET ROLE postgres;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$function$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;

CREATE TYPE public.member_role AS ENUM ('owner', 'admin', 'member');
CREATE TYPE public.group_visibility AS ENUM ('open', 'apply');

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean DEFAULT false,
  ban_expires_at timestamptz
);

CREATE TABLE public.groups (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  name text NOT NULL,
  name_en text,
  description text,
  description_en text,
  created_by uuid NOT NULL REFERENCES public.user_profiles(id),
  visibility public.group_visibility NOT NULL DEFAULT 'open',
  is_premium_only boolean DEFAULT false,
  member_count integer NOT NULL DEFAULT 0,
  dissolved_at timestamptz
);

CREATE UNIQUE INDEX groups_lower_name_unique
  ON public.groups (pg_catalog.lower(name));

CREATE TABLE public.group_members (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.member_role NOT NULL DEFAULT 'member',
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE public.group_bans (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE public.pro_official_groups (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  group_number integer NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  current_member_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT pro_official_groups_group_id_unique UNIQUE (group_id),
  CONSTRAINT pro_official_groups_group_number_unique UNIQUE (group_number)
);

CREATE TABLE public.pro_official_group_members (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pro_group_id uuid NOT NULL
    REFERENCES public.pro_official_groups(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT pro_official_group_members_user_unique UNIQUE (user_id)
);

CREATE TABLE public.pro_entitlements (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE FUNCTION public.has_current_global_pro_entitlement(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.pro_entitlements AS entitlement
    WHERE entitlement.user_id = p_user_id
  )
$function$;
ALTER FUNCTION public.has_current_global_pro_entitlement(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.has_current_global_pro_entitlement(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE FUNCTION public.sync_group_member_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.groups
    SET member_count = member_count + 1
    WHERE id = NEW.group_id;
    RETURN NEW;
  END IF;

  UPDATE public.groups
  SET member_count = member_count - 1
  WHERE id = OLD.group_id;
  RETURN OLD;
END
$function$;

CREATE TRIGGER trg_sync_group_member_count
  AFTER INSERT OR DELETE ON public.group_members
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_group_member_count();

CREATE FUNCTION public.serialize_group_membership_edge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_group_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.group_id ELSE NEW.group_id END;
  v_user_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-membership:' || v_group_id::text || ':' || v_user_id::text,
      0
    )
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

CREATE TRIGGER trg_group_members_05_serialize_edge
  BEFORE INSERT OR UPDATE OF group_id, user_id OR DELETE ON public.group_members
  FOR EACH ROW
  EXECUTE FUNCTION public.serialize_group_membership_edge();

CREATE FUNCTION public.generic_add_group_member(p_group_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  INSERT INTO public.group_members (group_id, user_id, role)
  VALUES (p_group_id, p_user_id, 'member'::public.member_role)
$function$;
GRANT EXECUTE ON FUNCTION public.generic_add_group_member(uuid, uuid) TO service_role;

CREATE FUNCTION public.get_user_pro_official_group(uuid)
RETURNS jsonb LANGUAGE sql AS 'SELECT ''{}''::jsonb';
CREATE FUNCTION public.join_pro_official_group(uuid)
RETURNS jsonb LANGUAGE sql AS 'SELECT ''{}''::jsonb';
CREATE FUNCTION public.leave_pro_official_group(uuid)
RETURNS boolean LANGUAGE sql AS 'SELECT false';
CREATE FUNCTION public.create_pro_official_group_atomic(uuid)
RETURNS jsonb LANGUAGE sql AS 'SELECT ''{}''::jsonb';
CREATE FUNCTION public.adjust_pro_group_member_count(uuid, integer)
RETURNS void LANGUAGE sql AS 'SELECT';

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.groups OWNER TO postgres;
ALTER TABLE public.group_members OWNER TO postgres;
ALTER TABLE public.group_bans OWNER TO postgres;
ALTER TABLE public.pro_official_groups OWNER TO postgres;
ALTER TABLE public.pro_official_group_members OWNER TO postgres;
ALTER TABLE public.pro_entitlements OWNER TO postgres;
ALTER FUNCTION public.sync_group_member_count() OWNER TO postgres;
ALTER FUNCTION public.serialize_group_membership_edge() OWNER TO postgres;
ALTER FUNCTION public.generic_add_group_member(uuid, uuid) OWNER TO postgres;

ALTER TABLE public.pro_official_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pro_official_group_members ENABLE ROW LEVEL SECURITY;
GRANT ALL PRIVILEGES ON TABLE
  public.pro_official_groups,
  public.pro_official_group_members
TO PUBLIC, anon, authenticated, service_role, hostile_role;
GRANT SELECT (group_number), UPDATE (current_member_count)
  ON TABLE public.pro_official_groups
  TO PUBLIC, anon, authenticated, service_role, hostile_role;
GRANT SELECT (user_id), INSERT (user_id), UPDATE (pro_group_id)
  ON TABLE public.pro_official_group_members
  TO PUBLIC, anon, authenticated, service_role, hostile_role;
CREATE POLICY unsafe_official_groups
  ON public.pro_official_groups FOR ALL TO PUBLIC
  USING (true) WITH CHECK (true);
CREATE POLICY unsafe_official_members
  ON public.pro_official_group_members FOR ALL TO PUBLIC
  USING (true) WITH CHECK (true);

INSERT INTO auth.users (id) VALUES
  ('10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000003'),
  ('10000000-0000-4000-8000-000000000004'),
  ('10000000-0000-4000-8000-000000000005');
INSERT INTO public.user_profiles (id, email) VALUES
  ('10000000-0000-4000-8000-000000000001', 'owner@example.com'),
  ('10000000-0000-4000-8000-000000000002', 'registry@example.com'),
  ('10000000-0000-4000-8000-000000000003', 'generic@example.com'),
  ('10000000-0000-4000-8000-000000000004', 'expired@example.com'),
  ('10000000-0000-4000-8000-000000000005', 'spare@example.com');
INSERT INTO public.pro_entitlements (user_id) VALUES
  ('10000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000003'),
  ('10000000-0000-4000-8000-000000000005');

INSERT INTO public.groups (
  id, name, created_by, visibility, is_premium_only
) VALUES (
  '20000000-0000-4000-8000-000000000001',
  'Arena Pro 会员群 #1',
  '10000000-0000-4000-8000-000000000001',
  'apply',
  true
);
INSERT INTO public.pro_official_groups (
  id, group_id, group_number, current_member_count
) VALUES (
  '30000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  1,
  499
);
INSERT INTO public.group_members (group_id, user_id, role) VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'member'
  ),
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000003',
    'admin'
  ),
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000004',
    'member'
  );
INSERT INTO public.pro_official_group_members (user_id, pro_group_id) VALUES
  (
    '10000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000001'
  ),
  (
    '10000000-0000-4000-8000-000000000004',
    '30000000-0000-4000-8000-000000000001'
  );
UPDATE public.groups
SET member_count = 777
WHERE id = '20000000-0000-4000-8000-000000000001';

RESET ROLE;
SQL

# Required keys are runtime serialization/cascade authority, not optional shape.
psql_cmd -c \
  'ALTER TABLE public.group_members DROP CONSTRAINT group_members_pkey' >/dev/null
expect_migration_failure \
  'canonical group membership edge primary key is incompatible' \
  'missing-group-member-primary-key'
psql_cmd -c \
  'ALTER TABLE public.group_members ADD PRIMARY KEY (group_id, user_id)' >/dev/null

psql_cmd -c \
  'ALTER TABLE public.pro_official_group_members DROP CONSTRAINT pro_official_group_members_pro_group_id_fkey' \
  >/dev/null
expect_migration_failure \
  'Pro official-group cascade foreign-key authority is incompatible' \
  'missing-registry-parent-cascade'
psql_cmd -c \
  'ALTER TABLE public.pro_official_group_members ADD CONSTRAINT pro_official_group_members_pro_group_id_fkey FOREIGN KEY (pro_group_id) REFERENCES public.pro_official_groups(id) ON DELETE CASCADE' \
  >/dev/null

# The entitlement helper is postgres-private; a leaked grant must fail before
# any legacy table/function authority is modified.
psql_cmd -c \
  'GRANT EXECUTE ON FUNCTION public.has_current_global_pro_entitlement(uuid) TO authenticated' \
  >/dev/null
expect_migration_failure \
  '20260716176100 global Pro entitlement helper is missing or unsafe' \
  'unsafe-helper-acl'
psql_cmd <<'SQL'
DO $rollback_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.pro_official_groups'::pg_catalog.regclass
      AND polname = 'unsafe_official_groups'
  ) OR pg_catalog.to_regprocedure(
    'public.adjust_pro_group_member_count(uuid,integer)'
  ) IS NULL THEN
    RAISE EXCEPTION 'unsafe-helper preflight failure changed legacy authority';
  END IF;
END
$rollback_proof$;
REVOKE ALL ON FUNCTION public.has_current_global_pro_entitlement(uuid)
  FROM authenticated;
SQL

psql_cmd -f "$MIGRATION" >"$TMP_ROOT/first-replay.log"

psql_cmd <<'SQL'
DO $historical_reconciliation$
BEGIN
  IF (SELECT current_member_count FROM public.pro_official_groups
      WHERE id = '30000000-0000-4000-8000-000000000001') <> 1
    OR (SELECT member_count FROM public.groups
        WHERE id = '20000000-0000-4000-8000-000000000001') <> 2
    OR NOT EXISTS (
      SELECT 1 FROM public.group_members
      WHERE group_id = '20000000-0000-4000-8000-000000000001'
        AND user_id = '10000000-0000-4000-8000-000000000001'
        AND role = 'owner'
    ) OR NOT EXISTS (
      SELECT 1 FROM public.group_members
      WHERE group_id = '20000000-0000-4000-8000-000000000001'
        AND user_id = '10000000-0000-4000-8000-000000000002'
        AND role = 'member'
    ) OR EXISTS (
      SELECT 1 FROM public.group_members
      WHERE group_id = '20000000-0000-4000-8000-000000000001'
        AND user_id IN (
          '10000000-0000-4000-8000-000000000003',
          '10000000-0000-4000-8000-000000000004'
        )
    ) OR EXISTS (
      SELECT 1 FROM public.pro_official_group_members
      WHERE user_id = '10000000-0000-4000-8000-000000000004'
    ) THEN
    RAISE EXCEPTION 'historical official membership did not reconcile';
  END IF;
END
$historical_reconciliation$;
SQL

# A name-compatible but wrong arity is not allowed to hide beside the API RPC.
psql_cmd <<'SQL'
SET ROLE postgres;
CREATE FUNCTION public.join_pro_official_group_atomic(p_actor_id uuid)
RETURNS jsonb LANGUAGE sql AS 'SELECT ''{}''::jsonb';
RESET ROLE;
SQL
expect_migration_failure \
  'incompatible Pro official-group RPC overload exists' \
  'wrong-rpc-overload'
psql_cmd -c \
  'DROP FUNCTION public.join_pro_official_group_atomic(uuid)' >/dev/null

# Inject table, policy, function, count and half-edge drift. A replay must
# converge all of it without retaining an unknown grantee.
psql_cmd <<'SQL'
SET ROLE postgres;
GRANT ALL ON TABLE public.pro_official_groups,
  public.pro_official_group_members TO hostile_role;
GRANT SELECT (group_number), UPDATE (current_member_count)
  ON TABLE public.pro_official_groups TO hostile_role;
GRANT EXECUTE ON FUNCTION public.get_pro_official_group_atomic(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.guard_pro_official_group_member_edge()
  TO hostile_role;
ALTER TABLE public.pro_official_groups DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.pro_official_group_members DISABLE ROW LEVEL SECURITY;
CREATE POLICY replay_drift_groups
  ON public.pro_official_groups FOR ALL TO hostile_role
  USING (true) WITH CHECK (true);

INSERT INTO auth.users (id) VALUES
  ('10000000-0000-4000-8000-000000000006'),
  ('10000000-0000-4000-8000-000000000007');
INSERT INTO public.user_profiles (id, email) VALUES
  ('10000000-0000-4000-8000-000000000006', 'half-registry@example.com'),
  ('10000000-0000-4000-8000-000000000007', 'half-generic@example.com');
INSERT INTO public.pro_entitlements (user_id) VALUES
  ('10000000-0000-4000-8000-000000000006'),
  ('10000000-0000-4000-8000-000000000007');
INSERT INTO public.pro_official_group_members (user_id, pro_group_id) VALUES (
  '10000000-0000-4000-8000-000000000006',
  '30000000-0000-4000-8000-000000000001'
);
ALTER TABLE public.group_members
  DISABLE TRIGGER trg_group_members_07_guard_pro_official;
INSERT INTO public.group_members (group_id, user_id, role) VALUES (
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000007',
  'member'
);
ALTER TABLE public.group_members
  ENABLE TRIGGER trg_group_members_07_guard_pro_official;
UPDATE public.pro_official_groups SET current_member_count = 400;
UPDATE public.groups SET member_count = 400
WHERE id = '20000000-0000-4000-8000-000000000001';
RESET ROLE;
SQL

psql_cmd -f "$MIGRATION" >"$TMP_ROOT/second-replay.log"

psql_cmd <<'SQL'
DO $replay_convergence$
DECLARE
  v_postgres oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres');
BEGIN
  IF (SELECT current_member_count FROM public.pro_official_groups
      WHERE id = '30000000-0000-4000-8000-000000000001') <> 2
    OR (SELECT member_count FROM public.groups
        WHERE id = '20000000-0000-4000-8000-000000000001') <> 3
    OR NOT EXISTS (
      SELECT 1 FROM public.group_members
      WHERE group_id = '20000000-0000-4000-8000-000000000001'
        AND user_id = '10000000-0000-4000-8000-000000000006'
        AND role = 'member'
    ) OR EXISTS (
      SELECT 1 FROM public.group_members
      WHERE group_id = '20000000-0000-4000-8000-000000000001'
        AND user_id = '10000000-0000-4000-8000-000000000007'
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy
      WHERE polrelid IN (
        'public.pro_official_groups'::pg_catalog.regclass,
        'public.pro_official_group_members'::pg_catalog.regclass
      )
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
      ) AS acl_entry
      WHERE relation.oid IN (
        'public.pro_official_groups'::pg_catalog.regclass,
        'public.pro_official_group_members'::pg_catalog.regclass
      )
        AND acl_entry.grantee <> v_postgres
    ) THEN
    RAISE EXCEPTION 'migration replay did not converge drift';
  END IF;
END
$replay_convergence$;
SQL

# Browser roles and even service_role have no direct table authority. The only
# service write path is the strict service-role RPC.
expect_sql_failure \
  'permission denied for table pro_official_group_members' \
  'service-direct-table-write' \
  "SET ROLE service_role; INSERT INTO public.pro_official_group_members (user_id, pro_group_id) VALUES ('10000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000001')"
expect_sql_failure \
  'permission denied for function join_pro_official_group_atomic' \
  'browser-rpc-call' \
  "SET ROLE authenticated; SELECT public.join_pro_official_group_atomic('10000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001')"
expect_sql_failure \
  'service role required' \
  'missing-service-claim' \
  "SET ROLE service_role; SELECT public.join_pro_official_group_atomic('10000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001')"

# A postgres-owned generic membership definer cannot forge the structural
# official edge, and identity UPDATE cannot be used to bypass INSERT ordering.
expect_sql_failure \
  'managed only by its atomic RPC' \
  'generic-definer-forgery' \
  "SET ROLE service_role; SELECT public.generic_add_group_member('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000005')"
psql_cmd <<'SQL'
SET ROLE postgres;
INSERT INTO public.groups (id, name, created_by) VALUES (
  '20000000-0000-4000-8000-000000000099',
  'Ordinary group',
  '10000000-0000-4000-8000-000000000001'
);
INSERT INTO public.group_members (group_id, user_id, role) VALUES (
  '20000000-0000-4000-8000-000000000099',
  '10000000-0000-4000-8000-000000000005',
  'member'
);
RESET ROLE;
SQL
expect_sql_failure \
  'new Pro official registry edge must exist before membership identity changes' \
  'identity-update-forgery' \
  "SET ROLE postgres; UPDATE public.group_members SET group_id = '20000000-0000-4000-8000-000000000001' WHERE group_id = '20000000-0000-4000-8000-000000000099' AND user_id = '10000000-0000-4000-8000-000000000005'"
expect_sql_failure \
  'Pro official registry identity is immutable' \
  'registry-identity-update-forgery' \
  "SET ROLE postgres; UPDATE public.pro_official_group_members SET user_id = '10000000-0000-4000-8000-000000000005' WHERE user_id = '10000000-0000-4000-8000-000000000002'"

# Fill the first group to exactly 500 paid slots. Its generic count must be 501
# (the 500 registry-backed subscribers plus one owner), never double-incremented.
psql_cmd <<'SQL'
SET ROLE postgres;
INSERT INTO auth.users (id)
SELECT pg_catalog.md5('official-fill-' || n::text)::uuid
FROM pg_catalog.generate_series(1, 498) AS generated(n);
INSERT INTO public.user_profiles (id, email)
SELECT
  pg_catalog.md5('official-fill-' || n::text)::uuid,
  'fill-' || n::text || '@example.com'
FROM pg_catalog.generate_series(1, 498) AS generated(n);
INSERT INTO public.pro_entitlements (user_id)
SELECT pg_catalog.md5('official-fill-' || n::text)::uuid
FROM pg_catalog.generate_series(1, 498) AS generated(n);
INSERT INTO public.pro_official_group_members (user_id, pro_group_id)
SELECT
  pg_catalog.md5('official-fill-' || n::text)::uuid,
  '30000000-0000-4000-8000-000000000001'
FROM pg_catalog.generate_series(1, 498) AS generated(n);
INSERT INTO public.group_members (group_id, user_id, role)
SELECT
  '20000000-0000-4000-8000-000000000001',
  pg_catalog.md5('official-fill-' || n::text)::uuid,
  'member'::public.member_role
FROM pg_catalog.generate_series(1, 498) AS generated(n);

INSERT INTO auth.users (id) VALUES
  ('40000000-0000-4000-8000-000000000001'),
  ('40000000-0000-4000-8000-000000000002'),
  ('40000000-0000-4000-8000-000000000003'),
  ('40000000-0000-4000-8000-000000000004'),
  ('40000000-0000-4000-8000-000000000005'),
  ('40000000-0000-4000-8000-000000000006');
INSERT INTO public.user_profiles (id, email) VALUES
  ('40000000-0000-4000-8000-000000000001', 'race-a@example.com'),
  ('40000000-0000-4000-8000-000000000002', 'race-b@example.com'),
  ('40000000-0000-4000-8000-000000000003', 'same-user@example.com'),
  ('40000000-0000-4000-8000-000000000004', 'join-fail@example.com'),
  ('40000000-0000-4000-8000-000000000005', 'purge@example.com'),
  ('40000000-0000-4000-8000-000000000006', 'rollback@example.com');
INSERT INTO public.pro_entitlements (user_id) VALUES
  ('40000000-0000-4000-8000-000000000001'),
  ('40000000-0000-4000-8000-000000000002'),
  ('40000000-0000-4000-8000-000000000003'),
  ('40000000-0000-4000-8000-000000000004'),
  ('40000000-0000-4000-8000-000000000005'),
  ('40000000-0000-4000-8000-000000000006');
RESET ROLE;

DO $full_group_attestation$
BEGIN
  IF (SELECT current_member_count FROM public.pro_official_groups
      WHERE id = '30000000-0000-4000-8000-000000000001') <> 500
    OR (SELECT member_count FROM public.groups
        WHERE id = '20000000-0000-4000-8000-000000000001') <> 501
  THEN
    RAISE EXCEPTION 'full group counters are not independently exact';
  END IF;
END
$full_group_attestation$;
SQL

# Two users racing a full group serialize allocation: one creates group #2 and
# the other joins it. No group exceeds 500.
for actor_suffix in 1 2; do
  psql_cmd -Atqc "
    SET ROLE service_role;
    SET request.jwt.claim.role = 'service_role';
    SELECT (public.join_pro_official_group_atomic(
      '40000000-0000-4000-8000-00000000000${actor_suffix}',
      '10000000-0000-4000-8000-000000000001'
    ) ->> 'status');
  " >"$TMP_ROOT/capacity-race-$actor_suffix.out" &
  eval "capacity_pid_$actor_suffix=$!"
done
wait "$capacity_pid_1"
wait "$capacity_pid_2"
grep -Fxq 'joined' "$TMP_ROOT/capacity-race-1.out"
grep -Fxq 'joined' "$TMP_ROOT/capacity-race-2.out"

psql_cmd <<'SQL'
DO $capacity_race_attestation$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.pro_official_groups) <> 2
    OR (SELECT current_member_count FROM public.pro_official_groups
        WHERE group_number = 1) <> 500
    OR (SELECT current_member_count FROM public.pro_official_groups
        WHERE group_number = 2) <> 2
    OR EXISTS (
      SELECT 1 FROM public.pro_official_groups
      WHERE current_member_count > 500
    ) OR EXISTS (
      SELECT 1
      FROM public.pro_official_groups AS official_group
      JOIN public.groups AS target_group ON target_group.id = official_group.group_id
      WHERE target_group.member_count <> official_group.current_member_count + 1
    ) THEN
    RAISE EXCEPTION 'concurrent capacity allocation drifted';
  END IF;
END
$capacity_race_attestation$;
SQL

# The same user racing itself is idempotent: exactly one joined and one
# already_member acknowledgement, with one registry and one generic edge.
for attempt in 1 2; do
  psql_cmd -Atqc "
    SET ROLE service_role;
    SET request.jwt.claim.role = 'service_role';
    SELECT (public.join_pro_official_group_atomic(
      '40000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000001'
    ) ->> 'status');
  " >"$TMP_ROOT/idempotent-$attempt.out" &
  eval "idempotent_pid_$attempt=$!"
done
wait "$idempotent_pid_1"
wait "$idempotent_pid_2"
sort "$TMP_ROOT/idempotent-1.out" "$TMP_ROOT/idempotent-2.out" \
  >"$TMP_ROOT/idempotent-sorted.out"
printf 'already_member\njoined\n' >"$TMP_ROOT/idempotent-expected.out"
cmp "$TMP_ROOT/idempotent-expected.out" "$TMP_ROOT/idempotent-sorted.out"

psql_cmd <<'SQL'
DO $idempotent_attestation$
DECLARE
  v_group_id uuid;
BEGIN
  SELECT official_group.group_id
  INTO v_group_id
  FROM public.pro_official_group_members AS official_member
  JOIN public.pro_official_groups AS official_group
    ON official_group.id = official_member.pro_group_id
  WHERE official_member.user_id = '40000000-0000-4000-8000-000000000003';

  IF (SELECT pg_catalog.count(*) FROM public.pro_official_group_members
      WHERE user_id = '40000000-0000-4000-8000-000000000003') <> 1
    OR (SELECT pg_catalog.count(*) FROM public.group_members
        WHERE group_id = v_group_id
          AND user_id = '40000000-0000-4000-8000-000000000003') <> 1
  THEN
    RAISE EXCEPTION 'same-user join was not idempotent';
  END IF;
END
$idempotent_attestation$;
SQL

# Force a failure after registry INSERT but before generic-edge INSERT. The RPC
# statement must roll back the registry row and both counters.
psql_cmd <<'SQL'
SET ROLE postgres;
CREATE FUNCTION public.test_fail_official_join_edge()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.user_id = '40000000-0000-4000-8000-000000000004'::uuid THEN
    RAISE EXCEPTION 'forced official join edge failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER trg_group_members_90_test_fail_official_join
  BEFORE INSERT ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.test_fail_official_join_edge();
RESET ROLE;
SQL
expect_sql_failure \
  'forced official join edge failure' \
  'join-half-write-rollback' \
  "SET ROLE service_role; SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false); SELECT public.join_pro_official_group_atomic('40000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001')"
psql_cmd <<'SQL'
SET ROLE postgres;
DROP TRIGGER trg_group_members_90_test_fail_official_join ON public.group_members;
DROP FUNCTION public.test_fail_official_join_edge();
DO $join_rollback_attestation$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.pro_official_group_members
    WHERE user_id = '40000000-0000-4000-8000-000000000004'
  ) OR EXISTS (
    SELECT 1 FROM public.group_members
    WHERE user_id = '40000000-0000-4000-8000-000000000004'
  ) THEN
    RAISE EXCEPTION 'failed join retained a half edge';
  END IF;
END
$join_rollback_attestation$;
RESET ROLE;
SQL

# Force a failure after registry DELETE but before generic-edge DELETE. Both
# rows and both counters must be restored by statement rollback.
psql_cmd <<'SQL'
SET ROLE postgres;
CREATE FUNCTION public.test_fail_official_leave_edge()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF OLD.user_id = '40000000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'forced official leave edge failure';
  END IF;
  RETURN OLD;
END
$function$;
CREATE TRIGGER trg_group_members_90_test_fail_official_leave
  BEFORE DELETE ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.test_fail_official_leave_edge();
RESET ROLE;
SQL
expect_sql_failure \
  'forced official leave edge failure' \
  'leave-half-write-rollback' \
  "SET ROLE service_role; SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false); SELECT public.leave_pro_official_group_atomic('40000000-0000-4000-8000-000000000001')"
psql_cmd <<'SQL'
SET ROLE postgres;
DROP TRIGGER trg_group_members_90_test_fail_official_leave ON public.group_members;
DROP FUNCTION public.test_fail_official_leave_edge();
DO $leave_rollback_attestation$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.pro_official_group_members
    WHERE user_id = '40000000-0000-4000-8000-000000000001'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE user_id = '40000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'failed leave did not restore both edges';
  END IF;
END
$leave_rollback_attestation$;
RESET ROLE;
SQL

# An active subscriber cannot delete the generic edge before its registry.
expect_sql_failure \
  'registry must be removed before its group edge' \
  'wrong-leave-order' \
  "SET ROLE postgres; DELETE FROM public.group_members WHERE user_id = '40000000-0000-4000-8000-000000000002'"

# Deleted-account cleanup is the structural exception: the guard removes the
# registry inside the same transaction, then lets the generic purge continue.
psql_cmd <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $join_purge_actor$
BEGIN
  IF public.join_pro_official_group_atomic(
    '40000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000001'
  ) ->> 'status' <> 'joined' THEN
    RAISE EXCEPTION 'purge fixture could not join';
  END IF;
END
$join_purge_actor$;
RESET ROLE;
SET ROLE postgres;
UPDATE public.user_profiles
SET deleted_at = pg_catalog.clock_timestamp()
WHERE id = '40000000-0000-4000-8000-000000000005';
DELETE FROM public.group_members
WHERE user_id = '40000000-0000-4000-8000-000000000005';
DO $inactive_purge_attestation$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.pro_official_group_members
    WHERE user_id = '40000000-0000-4000-8000-000000000005'
  ) OR EXISTS (
    SELECT 1 FROM public.group_members
    WHERE user_id = '40000000-0000-4000-8000-000000000005'
  ) THEN
    RAISE EXCEPTION 'inactive account purge retained an official edge';
  END IF;
END
$inactive_purge_attestation$;
RESET ROLE;
SQL

# Strict read/join/leave acknowledgements are determined by current database
# entitlement and membership evidence.
psql_cmd <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $rpc_ack_contract$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.get_pro_official_group_atomic(
    '40000000-0000-4000-8000-000000000002'
  );
  IF v_result ->> 'status' <> 'found' THEN
    RAISE EXCEPTION 'GET did not acknowledge found membership: %', v_result;
  END IF;

  v_result := public.leave_pro_official_group_atomic(
    '40000000-0000-4000-8000-000000000002'
  );
  IF v_result ->> 'status' <> 'left' THEN
    RAISE EXCEPTION 'leave did not acknowledge removal: %', v_result;
  END IF;

  v_result := public.leave_pro_official_group_atomic(
    '40000000-0000-4000-8000-000000000002'
  );
  IF v_result ->> 'status' <> 'not_member' THEN
    RAISE EXCEPTION 'idempotent leave acknowledgement drifted: %', v_result;
  END IF;

  v_result := public.get_pro_official_group_atomic(
    '40000000-0000-4000-8000-000000000002'
  );
  IF v_result ->> 'status' <> 'not_member' THEN
    RAISE EXCEPTION 'GET did not acknowledge removed membership: %', v_result;
  END IF;

  v_result := public.join_pro_official_group_atomic(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001'
  );
  IF v_result ->> 'status' <> 'pro_required' THEN
    RAISE EXCEPTION 'join did not enforce current global Pro: %', v_result;
  END IF;
END
$rpc_ack_contract$;
RESET ROLE;
SQL

# Explicit transaction rollback cannot retain either half of a successful RPC.
psql_cmd <<'SQL'
BEGIN;
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
DO $rollback_join$
BEGIN
  IF public.join_pro_official_group_atomic(
    '40000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000001'
  ) ->> 'status' <> 'joined' THEN
    RAISE EXCEPTION 'rollback fixture could not join';
  END IF;
END
$rollback_join$;
ROLLBACK;

DO $transaction_rollback_attestation$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.pro_official_group_members
    WHERE user_id = '40000000-0000-4000-8000-000000000006'
  ) OR EXISTS (
    SELECT 1 FROM public.group_members
    WHERE user_id = '40000000-0000-4000-8000-000000000006'
  ) THEN
    RAISE EXCEPTION 'transaction rollback retained an official half-edge';
  END IF;
END
$transaction_rollback_attestation$;
SQL

# Final replay proves idempotency after high-volume and concurrent traffic.
psql_cmd -f "$MIGRATION" >"$TMP_ROOT/final-replay.log"

psql_cmd <<'SQL'
DO $final_attestation$
DECLARE
  v_postgres oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres');
  v_service oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role');
  v_signature pg_catalog.regprocedure;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.pro_official_groups AS official_group
    JOIN public.groups AS target_group ON target_group.id = official_group.group_id
    WHERE official_group.current_member_count <> (
      SELECT pg_catalog.count(*)::integer
      FROM public.pro_official_group_members AS official_member
      WHERE official_member.pro_group_id = official_group.id
    )
       OR target_group.member_count <> (
         SELECT pg_catalog.count(*)::integer
         FROM public.group_members AS member
         WHERE member.group_id = target_group.id
       )
       OR target_group.member_count <> official_group.current_member_count + 1
       OR official_group.current_member_count > 500
  ) THEN
    RAISE EXCEPTION 'final independent counters drifted';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.get_pro_official_group_atomic(uuid)'::pg_catalog.regprocedure,
    'public.join_pro_official_group_atomic(uuid,uuid)'::pg_catalog.regprocedure,
    'public.leave_pro_official_group_atomic(uuid)'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(function_row.proacl, pg_catalog.acldefault('f', function_row.proowner))
      ) AS acl_entry
      WHERE function_row.oid = v_signature
        AND acl_entry.grantee = v_service
        AND acl_entry.grantor = v_postgres
        AND acl_entry.privilege_type = 'EXECUTE'
        AND NOT acl_entry.is_grantable
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(function_row.proacl, pg_catalog.acldefault('f', function_row.proowner))
      ) AS acl_entry
      WHERE function_row.oid = v_signature
        AND acl_entry.privilege_type = 'EXECUTE'
        AND acl_entry.grantee NOT IN (v_postgres, v_service)
    ) THEN
      RAISE EXCEPTION 'final RPC authority drifted: %', v_signature;
    END IF;
  END LOOP;
END
$final_attestation$;
SQL

echo "PostgreSQL 17 atomic Pro official-group checks passed"
