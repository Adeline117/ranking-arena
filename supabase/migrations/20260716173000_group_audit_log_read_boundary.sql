-- The group audit log is server-owned evidence. Browser clients must not read
-- its unfiltered details directly; the bounded API exposes a smaller allowlist.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('group-application-authority-migrations', 0)
);

DO $preflight$
DECLARE
  v_postgres oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
BEGIN
  IF v_postgres IS NULL OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'service_role']::name[]
    ) AS required(role_name)
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.rolname = required.role_name
    WHERE role_row.oid IS NULL
  ) THEN
    RAISE EXCEPTION 'group audit-log boundary requires standard Supabase roles';
  END IF;

  IF pg_catalog.to_regclass('public.group_audit_log') IS NULL THEN
    RAISE EXCEPTION 'public.group_audit_log is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_audit_log'::pg_catalog.regclass
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND NOT relation.relispartition
      AND relation.relowner = v_postgres
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = 'public.group_audit_log'::pg_catalog.regclass
       OR inheritance.inhparent = 'public.group_audit_log'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION 'public.group_audit_log ownership or relation shape drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.group_audit_log'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND (attribute.attname, attribute.atttypid) IN (
        ('id', 'uuid'::pg_catalog.regtype),
        ('group_id', 'uuid'::pg_catalog.regtype),
        ('actor_id', 'uuid'::pg_catalog.regtype),
        ('action', 'text'::pg_catalog.regtype),
        ('target_id', 'uuid'::pg_catalog.regtype),
        ('details', 'jsonb'::pg_catalog.regtype),
        ('created_at', 'timestamptz'::pg_catalog.regtype)
      )
  ) <> 7 THEN
    RAISE EXCEPTION 'public.group_audit_log required columns drifted';
  END IF;
END
$preflight$;

LOCK TABLE public.group_audit_log IN ACCESS EXCLUSIVE MODE;

-- Converge every table/column grantee and policy discovered in the catalogs,
-- including out-of-band roles and columns unknown to this migration.
DO $converge_authority$
DECLARE
  v_relation_oid pg_catalog.regclass :=
    'public.group_audit_log'::pg_catalog.regclass;
  v_relation_owner oid;
  v_column_list text;
  grantee_row record;
  policy_row record;
BEGIN
  SELECT relation.relowner
  INTO STRICT v_relation_owner
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = v_relation_oid;

  FOR grantee_row IN
    SELECT DISTINCT acl_entry.grantee, role_row.rolname
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl_entry
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = acl_entry.grantee
    WHERE relation.oid = v_relation_oid
      AND acl_entry.grantee <> v_relation_owner
  LOOP
    IF grantee_row.grantee = 0 THEN
      REVOKE ALL PRIVILEGES ON TABLE public.group_audit_log FROM PUBLIC CASCADE;
    ELSIF grantee_row.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.group_audit_log FROM %I CASCADE',
        grantee_row.rolname
      );
    END IF;
  END LOOP;

  REVOKE ALL PRIVILEGES ON TABLE public.group_audit_log
    FROM PUBLIC, anon, authenticated, service_role CASCADE;

  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', '
    ORDER BY attribute.attnum
  )
  INTO STRICT v_column_list
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = v_relation_oid
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  FOR grantee_row IN
    SELECT DISTINCT acl_entry.grantee, role_row.rolname
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = acl_entry.grantee
    WHERE attribute.attrelid = v_relation_oid
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  LOOP
    IF grantee_row.grantee = 0 THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
          || 'ON TABLE public.group_audit_log FROM PUBLIC CASCADE',
        v_column_list
      );
    ELSIF grantee_row.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
          || 'ON TABLE public.group_audit_log FROM %2$I CASCADE',
        v_column_list,
        grantee_row.rolname
      );
    END IF;
  END LOOP;

  FOR policy_row IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_relation_oid
    ORDER BY policy.polname
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.group_audit_log',
      policy_row.polname
    );
  END LOOP;
END
$converge_authority$;

ALTER TABLE public.group_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_audit_log NO FORCE ROW LEVEL SECURITY;

-- Current server callers only list evidence and append legacy evidence. Atomic
-- security-definer writers continue to execute as the postgres table owner.
GRANT SELECT, INSERT ON TABLE public.group_audit_log TO service_role;

DO $postflight$
DECLARE
  v_postgres oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_anon oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'anon'
  );
  v_authenticated oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticated'
  );
  v_service oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_audit_log'::pg_catalog.regclass
      AND (
        relation.relowner <> v_postgres
        OR NOT relation.relrowsecurity
        OR relation.relforcerowsecurity
      )
  ) THEN
    RAISE EXCEPTION 'public.group_audit_log RLS boundary drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.oid = v_service
      AND role_row.rolbypassrls
  ) THEN
    RAISE EXCEPTION 'service_role must bypass zero-policy audit-log RLS';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_audit_log'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION 'public.group_audit_log policies were not converged';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = 'public.group_audit_log'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> v_postgres
  ) THEN
    RAISE EXCEPTION 'public.group_audit_log column ACLs were not converged';
  END IF;

  IF EXISTS (
    WITH expected(grantee, grantor, privilege_type, is_grantable) AS (
      VALUES
        (v_service, v_postgres, 'SELECT'::text, false),
        (v_service, v_postgres, 'INSERT'::text, false)
    ),
    actual AS (
      SELECT
        acl_entry.grantee,
        acl_entry.grantor,
        acl_entry.privilege_type::text,
        acl_entry.is_grantable
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
      ) AS acl_entry
      WHERE relation.oid = 'public.group_audit_log'::pg_catalog.regclass
        AND acl_entry.grantee <> relation.relowner
    )
    SELECT 1
    FROM expected
    FULL JOIN actual
      USING (grantee, grantor, privilege_type, is_grantable)
    WHERE expected.grantee IS NULL OR actual.grantee IS NULL
  ) THEN
    RAISE EXCEPTION 'public.group_audit_log table ACLs were not converged';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
    'service_role', 'public.group_audit_log', 'SELECT'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.group_audit_log', 'INSERT'
  ) OR pg_catalog.has_table_privilege(
    'service_role', 'public.group_audit_log', 'UPDATE'
  ) OR pg_catalog.has_table_privilege(
    'service_role', 'public.group_audit_log', 'DELETE'
  ) OR pg_catalog.has_table_privilege(
    'anon', 'public.group_audit_log', 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'authenticated', 'public.group_audit_log', 'SELECT'
  ) THEN
    RAISE EXCEPTION 'public.group_audit_log effective privileges drifted';
  END IF;

  IF EXISTS (
    WITH RECURSIVE inherited(role_oid, member_oid) AS (
      SELECT membership.roleid, membership.member
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.member IN (v_anon, v_authenticated)
        AND membership.inherit_option
      UNION
      SELECT membership.roleid, inherited.member_oid
      FROM pg_catalog.pg_auth_members AS membership
      JOIN inherited
        ON membership.member = inherited.role_oid
      WHERE membership.inherit_option
    )
    SELECT 1
    FROM inherited
    WHERE inherited.role_oid IN (v_postgres, v_service)
  ) THEN
    RAISE EXCEPTION 'browser roles inherit privileged audit-log authority';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
