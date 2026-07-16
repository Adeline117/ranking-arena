#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for public group reads and server-owned writes.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716111800_group_creation_membership_write_boundary.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ ! -f "$MIGRATION" ]]; then
  echo "Group write-boundary migration is missing: $MIGRATION" >&2
  exit 1
fi
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/group-write-boundary-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55462
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

PSQL=(
  "$PG_BIN/psql"
  -X
  -v ON_ERROR_STOP=1
  -h "$SOCKET_DIR"
  -p "$PORT"
  -d postgres
)

"${PSQL[@]}" <<'SQL'
CREATE ROLE postgres NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE legacy_group_writer NOLOGIN;

CREATE SCHEMA auth;
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid
$function$;

CREATE TYPE public.member_role AS ENUM ('owner', 'admin', 'member');

CREATE TABLE public.groups (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_by uuid NOT NULL,
  member_count integer NOT NULL DEFAULT 0,
  visibility text NOT NULL DEFAULT 'open',
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp()
);

CREATE TABLE public.group_members (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role public.member_role NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  PRIMARY KEY (group_id, user_id)
);

ALTER TABLE public.groups OWNER TO postgres;
ALTER TABLE public.group_members OWNER TO postgres;

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA public, auth
  TO anon, authenticated, service_role, legacy_group_writer;
GRANT EXECUTE ON FUNCTION auth.uid()
  TO anon, authenticated, service_role, legacy_group_writer;
GRANT ALL PRIVILEGES ON TABLE public.groups, public.group_members
  TO PUBLIC, anon, authenticated, service_role, legacy_group_writer;
GRANT SELECT (id), INSERT (name), UPDATE (name), REFERENCES (id)
  ON TABLE public.groups
  TO PUBLIC, anon, authenticated, service_role, legacy_group_writer;
GRANT SELECT (group_id), INSERT (user_id), UPDATE (role), REFERENCES (group_id)
  ON TABLE public.group_members
  TO PUBLIC, anon, authenticated, service_role, legacy_group_writer;

CREATE POLICY "Groups are viewable by everyone"
  ON public.groups
  FOR SELECT
  TO PUBLIC
  USING (true);
CREATE POLICY groups_insert_auth
  ON public.groups
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT auth.uid()) = created_by);
CREATE POLICY group_creator_all
  ON public.groups
  FOR ALL
  TO authenticated
  USING ((SELECT auth.uid()) = created_by)
  WITH CHECK ((SELECT auth.uid()) = created_by);

CREATE POLICY "Group members are viewable by everyone"
  ON public.group_members
  FOR SELECT
  TO PUBLIC
  USING (true);
CREATE POLICY "Users can join groups"
  ON public.group_members
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can leave groups"
  ON public.group_members
  FOR DELETE
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY unsafe_member_all
  ON public.group_members
  FOR ALL
  TO PUBLIC
  USING (true)
  WITH CHECK (true);

INSERT INTO public.groups (id, name, created_by, member_count)
VALUES (
  '10000000-0000-4000-8000-000000000001',
  'Existing group',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  1
);
INSERT INTO public.group_members (group_id, user_id, role)
VALUES (
  '10000000-0000-4000-8000-000000000001',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'owner'
);

CREATE OR REPLACE FUNCTION public.expect_denied(p_statement text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  EXECUTE p_statement;
  RAISE EXCEPTION 'statement unexpectedly succeeded: %', p_statement;
EXCEPTION
  WHEN insufficient_privilege OR check_violation OR unique_violation
    OR not_null_violation OR foreign_key_violation
  THEN
    RETURN;
END
$function$;
GRANT EXECUTE ON FUNCTION public.expect_denied(text)
  TO anon, authenticated, service_role;
SQL

# A missing required table must fail before changing the other table's ACL or
# policies; the transaction is discarded when this psql session exits.
"${PSQL[@]}" -c \
  'ALTER TABLE public.group_members RENAME TO group_members_missing' >/dev/null
if "${PSQL[@]}" -f "$MIGRATION" >"$LOG_DIR/missing-table.log" 2>&1; then
  echo "Migration unexpectedly accepted a missing group_members table" >&2
  exit 1
fi
grep -Fq \
  'postgres-owned group tables must exist before installing their write boundary' \
  "$LOG_DIR/missing-table.log"

"${PSQL[@]}" <<'SQL'
DO $missing_table_rollback$
BEGIN
  IF NOT pg_catalog.has_table_privilege(
    'authenticated',
    'public.groups',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.groups'::regclass
      AND policy.polname = 'groups_insert_auth'
  ) THEN
    RAISE EXCEPTION 'missing-table preflight failure changed groups authority';
  END IF;
END
$missing_table_rollback$;

ALTER TABLE public.group_members_missing RENAME TO group_members;
SQL

"${PSQL[@]}" -f "$MIGRATION" >"$LOG_DIR/first-replay.log"

# Inject policy, RLS, table ACL and column ACL drift for every relevant role.
"${PSQL[@]}" <<'SQL'
ALTER TABLE public.groups DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_members DISABLE ROW LEVEL SECURITY;

GRANT ALL PRIVILEGES ON TABLE public.groups, public.group_members
  TO PUBLIC, anon, authenticated, service_role, legacy_group_writer;
GRANT SELECT (id), INSERT (name), UPDATE (name), REFERENCES (id)
  ON TABLE public.groups
  TO PUBLIC, anon, authenticated, service_role, legacy_group_writer;
GRANT SELECT (group_id), INSERT (user_id), UPDATE (role), REFERENCES (group_id)
  ON TABLE public.group_members
  TO PUBLIC, anon, authenticated, service_role, legacy_group_writer;

CREATE POLICY unexpected_group_all
  ON public.groups
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
CREATE POLICY unexpected_member_insert
  ON public.group_members
  FOR INSERT
  TO PUBLIC
  WITH CHECK (true);

DO $drift_fixture$
BEGIN
  IF NOT pg_catalog.has_table_privilege(
    'authenticated',
    'public.groups',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR NOT pg_catalog.has_table_privilege(
    'legacy_group_writer',
    'public.group_members',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR NOT pg_catalog.has_column_privilege(
    'legacy_group_writer',
    'public.groups',
    'name',
    'UPDATE'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl
    WHERE attribute.attrelid IN (
      'public.groups'::regclass,
      'public.group_members'::regclass
    )
      AND acl.grantee IN (
        0,
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'),
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role'),
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'legacy_group_writer')
      )
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.groups'::regclass
      AND policy.polname = 'unexpected_group_all'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_members'::regclass
      AND policy.polname = 'unexpected_member_insert'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.groups'::regclass,
      'public.group_members'::regclass
    )
      AND relation.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'group write-boundary drift fixture did not take effect';
  END IF;
END
$drift_fixture$;
SQL

"${PSQL[@]}" -f "$MIGRATION" >"$LOG_DIR/second-replay.log"

"${PSQL[@]}" <<'SQL'
SET ROLE anon;

DO $anonymous_read_contract$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.groups) <> 1
    OR (SELECT pg_catalog.count(*) FROM public.group_members) <> 1
  THEN
    RAISE EXCEPTION 'anonymous group discovery/member reads were lost';
  END IF;
END
$anonymous_read_contract$;

SELECT public.expect_denied($statement$
  INSERT INTO public.groups (id, name, created_by)
  VALUES (
    '20000000-0000-4000-8000-000000000001',
    'Anonymous forged group',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  )
$statement$);
SELECT public.expect_denied($statement$
  INSERT INTO public.group_members (group_id, user_id, role)
  VALUES (
    '10000000-0000-4000-8000-000000000001',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'owner'
  )
$statement$);

RESET ROLE;
SET ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  false
);

DO $authenticated_read_contract$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.groups) <> 1
    OR (SELECT pg_catalog.count(*) FROM public.group_members) <> 1
  THEN
    RAISE EXCEPTION 'authenticated group discovery/member reads were lost';
  END IF;
END
$authenticated_read_contract$;

SELECT public.expect_denied($statement$
  INSERT INTO public.groups (id, name, created_by)
  VALUES (
    '20000000-0000-4000-8000-000000000002',
    'Browser forged group',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  )
$statement$);
SELECT public.expect_denied($statement$
  UPDATE public.groups
  SET name = 'Browser takeover'
  WHERE id = '10000000-0000-4000-8000-000000000001'
$statement$);
SELECT public.expect_denied($statement$
  DELETE FROM public.groups
  WHERE id = '10000000-0000-4000-8000-000000000001'
$statement$);
SELECT public.expect_denied($statement$
  INSERT INTO public.group_members (group_id, user_id, role)
  VALUES (
    '10000000-0000-4000-8000-000000000001',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'owner'
  )
$statement$);
SELECT public.expect_denied($statement$
  UPDATE public.group_members
  SET role = 'owner'
  WHERE group_id = '10000000-0000-4000-8000-000000000001'
    AND user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$statement$);
SELECT public.expect_denied($statement$
  DELETE FROM public.group_members
  WHERE group_id = '10000000-0000-4000-8000-000000000001'
    AND user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$statement$);
SELECT public.expect_denied($statement$
  TRUNCATE public.group_members, public.groups
$statement$);

RESET ROLE;
SET ROLE service_role;

INSERT INTO public.groups (id, name, created_by, member_count)
VALUES (
  '30000000-0000-4000-8000-000000000001',
  'Service-created group',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  1
);
INSERT INTO public.group_members (group_id, user_id, role)
VALUES (
  '30000000-0000-4000-8000-000000000001',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'owner'
);
UPDATE public.groups
SET name = 'Service-updated group'
WHERE id = '30000000-0000-4000-8000-000000000001';
UPDATE public.group_members
SET role = 'admin'
WHERE group_id = '30000000-0000-4000-8000-000000000001'
  AND user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
DELETE FROM public.group_members
WHERE group_id = '30000000-0000-4000-8000-000000000001'
  AND user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
DELETE FROM public.groups
WHERE id = '30000000-0000-4000-8000-000000000001';

RESET ROLE;

DO $catalog_contract$
DECLARE
  relation_name text;
  relation_oid oid;
  relation_owner oid;
  anon_role_oid oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'anon'
  );
  authenticated_role_oid oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'
  );
  service_role_oid oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role'
  );
  browser_role_oids oid[];
BEGIN
  browser_role_oids := ARRAY[anon_role_oid, authenticated_role_oid]::oid[];

  FOREACH relation_name IN ARRAY ARRAY['groups', 'group_members']::text[]
  LOOP
    relation_oid := pg_catalog.to_regclass('public.' || relation_name);
    SELECT relation.relowner
    INTO relation_owner
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = relation_oid;

    IF NOT pg_catalog.has_table_privilege('anon', relation_oid, 'SELECT')
      OR NOT pg_catalog.has_table_privilege('authenticated', relation_oid, 'SELECT')
      OR pg_catalog.has_table_privilege(
        'authenticated',
        relation_oid,
        'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
      OR NOT pg_catalog.has_table_privilege(
        'service_role',
        relation_oid,
        'SELECT,INSERT,UPDATE,DELETE'
      )
      OR pg_catalog.has_table_privilege(
        'service_role',
        relation_oid,
        'TRUNCATE,REFERENCES,TRIGGER'
      )
      OR pg_catalog.has_table_privilege(
        'legacy_group_writer',
        relation_oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
      OR pg_catalog.has_any_column_privilege(
        'legacy_group_writer',
        relation_oid,
        'SELECT,INSERT,UPDATE,REFERENCES'
      )
    THEN
      RAISE EXCEPTION 'effective ACL drifted on public.%', relation_name;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
      ) AS acl
      WHERE relation.oid = relation_oid
        AND acl.grantee NOT IN (
          relation_owner,
          anon_role_oid,
          authenticated_role_oid,
          service_role_oid
        )
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl
      WHERE attribute.attrelid = relation_oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl.grantee <> relation_owner
    ) THEN
      RAISE EXCEPTION 'raw ACL drifted on public.%', relation_name;
    END IF;

    IF (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = relation_oid
    ) <> 2 OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = relation_oid
        AND policy.polname = 'browser_read'
        AND policy.polcmd = 'r'
        AND policy.polpermissive
        AND pg_catalog.array_length(policy.polroles, 1) = 2
        AND policy.polroles @> browser_role_oids
        AND policy.polroles <@ browser_role_oids
        AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true) = 'true'
        AND policy.polwithcheck IS NULL
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = relation_oid
        AND policy.polname = 'server_role_mutation'
        AND policy.polcmd = '*'
        AND policy.polpermissive
        AND policy.polroles = ARRAY[service_role_oid]::oid[]
        AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true) = 'true'
        AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, true) = 'true'
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = relation_oid
        AND relation.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'policy/RLS drifted on public.%', relation_name;
    END IF;
  END LOOP;
END
$catalog_contract$;
SQL

echo "group creation and membership write boundary PG17 integration proof passed"
