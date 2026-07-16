-- Keep public group discovery/member lists readable while making group and
-- membership mutations server-owned. Browser JWTs must use authenticated API
-- routes instead of bypassing approval, ban, score, role and count checks.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('group-application-authority-migrations', 0)
);

DO $preflight$
DECLARE
  required_role text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = pg_catalog.to_regclass('public.groups')
      AND relation.relkind IN ('r', 'p')
      AND pg_catalog.pg_get_userbyid(relation.relowner) = 'postgres'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = pg_catalog.to_regclass('public.group_members')
      AND relation.relkind IN ('r', 'p')
      AND pg_catalog.pg_get_userbyid(relation.relowner) = 'postgres'
  )
  THEN
    RAISE EXCEPTION 'postgres-owned group tables must exist before installing their write boundary';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('groups', 'id'),
        ('groups', 'name'),
        ('groups', 'created_by'),
        ('group_members', 'group_id'),
        ('group_members', 'user_id'),
        ('group_members', 'role')
    ) AS required_column(relation_name, column_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = pg_catalog.to_regclass(
        'public.' || required_column.relation_name
      )
        AND attribute.attname = required_column.column_name
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
  ) THEN
    RAISE EXCEPTION 'required group table columns are missing';
  END IF;

  FOREACH required_role IN ARRAY ARRAY[
    'anon',
    'authenticated',
    'service_role'
  ]::text[]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles AS role_info
      WHERE role_info.rolname = required_role
    ) THEN
      RAISE EXCEPTION 'required database role is missing: %', required_role;
    END IF;
  END LOOP;
END
$preflight$;

-- Acquire both locks in one deterministic order (groups first, matching group
-- creation and membership validation) before replacing policies and ACLs. A
-- timeout rolls the entire migration back without a partial boundary.
LOCK TABLE public.groups, public.group_members IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;

DO $replace_group_authority_policies$
DECLARE
  relation_name text;
  policy_row record;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'groups',
    'group_members'
  ]::text[]
  LOOP
    FOR policy_row IN
      SELECT policy.polname
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = pg_catalog.to_regclass('public.' || relation_name)
    LOOP
      EXECUTE pg_catalog.format(
        'DROP POLICY %I ON public.%I',
        policy_row.polname,
        relation_name
      );
    END LOOP;
  END LOOP;
END
$replace_group_authority_policies$;

-- Converge historical Supabase defaults, named roles and arbitrary drifted
-- grantees. Column ACLs are also cleared so a table-level revoke cannot be
-- bypassed through INSERT/UPDATE grants on selected columns.
DO $replace_group_authority_acls$
DECLARE
  relation_name text;
  relation_oid oid;
  relation_owner oid;
  column_list text;
  grantee record;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'groups',
    'group_members'
  ]::text[]
  LOOP
    relation_oid := pg_catalog.to_regclass('public.' || relation_name);

    SELECT relation.relowner
    INTO relation_owner
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = relation_oid;

    FOR grantee IN
      SELECT DISTINCT acl.grantee, role_info.rolname
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl
      LEFT JOIN pg_catalog.pg_roles AS role_info
        ON role_info.oid = acl.grantee
      WHERE relation.oid = relation_oid
        AND acl.grantee <> relation_owner
    LOOP
      IF grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC',
          relation_name
        );
      ELSIF grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',
          relation_name,
          grantee.rolname
        );
      END IF;
    END LOOP;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.%I '
        || 'FROM PUBLIC, anon, authenticated, service_role',
      relation_name
    );

    SELECT pg_catalog.string_agg(
      pg_catalog.format('%I', attribute.attname),
      ', '
      ORDER BY attribute.attnum
    )
    INTO column_list
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = relation_oid
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF column_list IS NOT NULL THEN
      FOR grantee IN
        SELECT DISTINCT acl.grantee, role_info.rolname
        FROM pg_catalog.pg_attribute AS attribute
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl
        LEFT JOIN pg_catalog.pg_roles AS role_info
          ON role_info.oid = acl.grantee
        WHERE attribute.attrelid = relation_oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND acl.grantee <> relation_owner
      LOOP
        IF grantee.grantee = 0 THEN
          EXECUTE pg_catalog.format(
            'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
              || 'ON TABLE public.%2$I FROM PUBLIC',
            column_list,
            relation_name
          );
        ELSIF grantee.rolname IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
              || 'ON TABLE public.%2$I FROM %3$I',
            column_list,
            relation_name,
            grantee.rolname
          );
        END IF;
      END LOOP;

      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
          || 'ON TABLE public.%2$I FROM PUBLIC, anon, authenticated, service_role',
        column_list,
        relation_name
      );
    END IF;
  END LOOP;
END
$replace_group_authority_acls$;

GRANT SELECT ON TABLE public.groups TO anon, authenticated;
GRANT SELECT ON TABLE public.group_members TO anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.groups TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.group_members TO service_role;

CREATE POLICY browser_read
  ON public.groups
  AS PERMISSIVE
  FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY server_role_mutation
  ON public.groups
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY browser_read
  ON public.group_members
  AS PERMISSIVE
  FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY server_role_mutation
  ON public.group_members
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DO $postflight$
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

  FOREACH relation_name IN ARRAY ARRAY[
    'groups',
    'group_members'
  ]::text[]
  LOOP
    relation_oid := pg_catalog.to_regclass('public.' || relation_name);

    SELECT relation.relowner
    INTO relation_owner
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = relation_oid;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = relation_oid
        AND relation.relrowsecurity
        AND relation.relkind IN ('r', 'p')
        AND pg_catalog.pg_get_userbyid(relation.relowner) = 'postgres'
    ) THEN
      RAISE EXCEPTION 'group relation kind, owner or RLS drifted on public.%', relation_name;
    END IF;

    IF NOT pg_catalog.has_table_privilege(
      'anon',
      relation_oid,
      'SELECT'
    ) OR NOT pg_catalog.has_table_privilege(
      'authenticated',
      relation_oid,
      'SELECT'
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(
        ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']::text[]
      ) AS privilege(privilege_type)
      WHERE pg_catalog.has_table_privilege(
        'anon',
        relation_oid,
        privilege.privilege_type
      )
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(
        ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']::text[]
      ) AS privilege(privilege_type)
      WHERE pg_catalog.has_table_privilege(
        'authenticated',
        relation_oid,
        privilege.privilege_type
      )
    ) OR NOT pg_catalog.has_table_privilege(
      'service_role',
      relation_oid,
      'SELECT,INSERT,UPDATE,DELETE'
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(
        ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']::text[]
      ) AS privilege(privilege_type)
      WHERE pg_catalog.has_table_privilege(
        'service_role',
        relation_oid,
        privilege.privilege_type
      )
    ) THEN
      RAISE EXCEPTION 'effective group table ACL is not browser-read/server-write on public.%',
        relation_name;
    END IF;

    IF (
      SELECT pg_catalog.array_agg(
        DISTINCT acl.privilege_type
        ORDER BY acl.privilege_type
      )
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl
      WHERE relation.oid = relation_oid
        AND acl.grantee = anon_role_oid
    ) IS DISTINCT FROM ARRAY['SELECT']::text[] OR (
      SELECT pg_catalog.array_agg(
        DISTINCT acl.privilege_type
        ORDER BY acl.privilege_type
      )
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl
      WHERE relation.oid = relation_oid
        AND acl.grantee = authenticated_role_oid
    ) IS DISTINCT FROM ARRAY['SELECT']::text[] OR (
      SELECT pg_catalog.array_agg(
        DISTINCT acl.privilege_type
        ORDER BY acl.privilege_type
      )
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl
      WHERE relation.oid = relation_oid
        AND acl.grantee = service_role_oid
    ) IS DISTINCT FROM ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[] THEN
      RAISE EXCEPTION 'direct group table ACL is not exact on public.%', relation_name;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
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
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS acl
      WHERE relation.oid = relation_oid
        AND acl.grantee IN (
          anon_role_oid,
          authenticated_role_oid,
          service_role_oid
        )
        AND acl.is_grantable
    ) THEN
      RAISE EXCEPTION 'unexpected or grantable group table ACL remains on public.%',
        relation_name;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl
      WHERE attribute.attrelid = relation_oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl.grantee <> relation_owner
    ) THEN
      RAISE EXCEPTION 'nonowner group column ACL remains on public.%', relation_name;
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
    ) THEN
      RAISE EXCEPTION 'group policy boundary is not exact on public.%', relation_name;
    END IF;
  END LOOP;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
