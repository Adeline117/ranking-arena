-- Keep paid-group entitlements server-owned while allowing the postgres-owned
-- SECURITY DEFINER expiry job to update them. FORCE RLS applies to a
-- NOBYPASSRLS table owner and therefore breaks that scheduled owner-side job.

BEGIN;

SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'public.group_subscriptions:server-authority:v1',
    0
  )
);

DO $preflight$
DECLARE
  v_relation pg_catalog.regclass :=
    pg_catalog.to_regclass('public.group_subscriptions');
  v_groups pg_catalog.regclass := pg_catalog.to_regclass('public.groups');
  v_expiry pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure('public.expire_group_subscriptions()');
  v_postgres oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_authenticator oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticator'
  );
BEGIN
  IF v_postgres IS NULL
    OR v_service IS NULL
    OR v_authenticator IS NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(
        ARRAY['anon', 'authenticated']::name[]
      ) AS required_role(role_name)
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.rolname = required_role.role_name
      WHERE role_row.oid IS NULL
    )
  THEN
    RAISE EXCEPTION 'group subscription owner compatibility requires standard Supabase roles';
  END IF;

  IF v_relation IS NULL OR v_groups IS NULL THEN
    RAISE EXCEPTION 'public.groups and public.group_subscriptions must exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND NOT relation.relispartition
      AND relation.relowner = v_postgres
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = v_relation
       OR inheritance.inhparent = v_relation
  ) THEN
    RAISE EXCEPTION 'public.group_subscriptions must be an ordinary postgres-owned table';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_relation
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = v_groups
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_relation
          AND attribute.attname = 'group_id'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )]::smallint[]
      AND constraint_row.confkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_groups
          AND attribute.attname = 'id'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )]::smallint[]
  ) <> 1 THEN
    RAISE EXCEPTION 'group_subscriptions requires the validated groups(id) ON DELETE CASCADE foreign key';
  END IF;

  IF v_expiry IS NOT NULL AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure_row
    WHERE procedure_row.oid = v_expiry
      AND (
        procedure_row.prokind <> 'f'
        OR NOT procedure_row.prosecdef
        OR procedure_row.proowner <> v_postgres
      )
  ) THEN
    RAISE EXCEPTION 'public.expire_group_subscriptions() must be a postgres-owned SECURITY DEFINER function';
  END IF;

  -- The gateway may SET ROLE service_role for a service JWT, but may not
  -- inherit it. No other unprivileged role may gain the service or table-owner
  -- authority through an active INHERIT/SET membership path.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service
      AND membership.member = v_authenticator
      AND NOT membership.admin_option
      AND NOT membership.inherit_option
      AND membership.set_option
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service
      AND membership.member NOT IN (v_authenticator, v_postgres)
  ) OR EXISTS (
    WITH RECURSIVE service_inherits(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.member = v_service
        AND (membership.inherit_option OR membership.set_option)
      UNION
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inherits AS inherited
        ON membership.member = inherited.role_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1 FROM service_inherits
  ) OR EXISTS (
    WITH RECURSIVE owner_authority(member_oid) AS (
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.roleid = v_postgres
        AND (membership.inherit_option OR membership.set_option)
      UNION
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      JOIN owner_authority AS inherited
        ON membership.roleid = inherited.member_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1
    FROM owner_authority AS inherited
    JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = inherited.member_oid
    WHERE NOT role_row.rolsuper
      AND NOT role_row.rolbypassrls
      AND NOT (
        -- Supabase keeps one managed, NOINHERIT login bridge that may SET
        -- ROLE postgres for CLI migrations. It is not browser/runtime
        -- authority and is safe only with this exact direct edge and role
        -- shape; any descendant or differently privileged bridge still fails.
        role_row.rolname = 'cli_login_postgres'
        AND role_row.rolcanlogin
        AND NOT role_row.rolinherit
        AND NOT role_row.rolcreaterole
        AND NOT role_row.rolcreatedb
        AND NOT role_row.rolreplication
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_auth_members AS managed_membership
          WHERE managed_membership.roleid = v_postgres
            AND managed_membership.member = role_row.oid
            AND NOT managed_membership.admin_option
            AND NOT managed_membership.inherit_option
            AND managed_membership.set_option
        )
      )
  ) OR EXISTS (
    WITH RECURSIVE browser_authority(root_oid, role_oid) AS (
      SELECT browser_role.oid, membership.roleid
      FROM pg_catalog.pg_roles AS browser_role
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = browser_role.oid
       AND (membership.inherit_option OR membership.set_option)
      WHERE browser_role.rolname IN ('anon', 'authenticated')
      UNION
      SELECT inherited.root_oid, membership.roleid
      FROM browser_authority AS inherited
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = inherited.role_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1
    FROM browser_authority AS inherited
    WHERE inherited.role_oid IN (v_service, v_postgres)
  ) THEN
    RAISE EXCEPTION 'group subscription owner or service-role inheritance graph is unsafe';
  END IF;
END
$preflight$;

LOCK TABLE public.group_subscriptions IN ACCESS EXCLUSIVE MODE;

DO $locked_recheck$
DECLARE
  v_postgres oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_subscriptions'::pg_catalog.regclass
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND NOT relation.relispartition
      AND relation.relowner = v_postgres
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid =
        'public.group_subscriptions'::pg_catalog.regclass
       OR inheritance.inhparent =
        'public.group_subscriptions'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION 'public.group_subscriptions drifted while acquiring the authority lock';
  END IF;
END
$locked_recheck$;

-- Discover and remove every non-owner table/column ACL and every policy. This
-- also converges out-of-band roles and columns introduced after the prior seal.
DO $converge_table_authority$
DECLARE
  v_relation pg_catalog.regclass :=
    'public.group_subscriptions'::pg_catalog.regclass;
  v_owner oid;
  v_grantee oid;
  v_grantee_name name;
  v_grantee_sql text;
  v_grantees oid[];
  v_columns text;
  v_policy name;
BEGIN
  SELECT relation.relowner
  INTO STRICT v_owner
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = v_relation;

  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', '
    ORDER BY attribute.attnum
  )
  INTO STRICT v_columns
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = v_relation
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT pg_catalog.array_agg(DISTINCT discovered.grantee)
  INTO v_grantees
  FROM (
    SELECT acl_entry.grantee
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = v_relation
    UNION
    SELECT acl_entry.grantee
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) AS discovered
  WHERE discovered.grantee <> v_owner;

  FOREACH v_grantee IN ARRAY COALESCE(v_grantees, ARRAY[]::oid[])
  LOOP
    IF v_grantee = 0::oid THEN
      v_grantee_sql := 'PUBLIC';
    ELSE
      SELECT role_row.rolname
      INTO v_grantee_name
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_grantee;

      IF v_grantee_name IS NULL THEN
        RAISE EXCEPTION 'dangling group subscription ACL grantee oid: %', v_grantee;
      END IF;
      v_grantee_sql := pg_catalog.format('%I', v_grantee_name);
    END IF;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.group_subscriptions FROM %s CASCADE',
      v_grantee_sql
    );
    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
        || 'ON TABLE public.group_subscriptions FROM %2$s CASCADE',
      v_columns,
      v_grantee_sql
    );
  END LOOP;

  FOR v_policy IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_relation
    ORDER BY policy.polname
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.group_subscriptions',
      v_policy
    );
  END LOOP;
END
$converge_table_authority$;

ALTER TABLE public.group_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_subscriptions NO FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.group_subscriptions
  TO service_role;

CREATE POLICY service_role_manages_group_subscriptions
  ON public.group_subscriptions
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Harden the scheduled no-argument expiry entry point when it is present.
-- Fresh databases that do not install the optional scheduled function still
-- receive the table compatibility repair.
DO $converge_expiry_function$
DECLARE
  v_expiry pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure('public.expire_group_subscriptions()');
  v_owner oid;
  v_grantee oid;
  v_grantee_name name;
  v_grantee_sql text;
  v_grantees oid[];
BEGIN
  IF v_expiry IS NULL THEN
    RETURN;
  END IF;

  SELECT procedure_row.proowner
  INTO STRICT v_owner
  FROM pg_catalog.pg_proc AS procedure_row
  WHERE procedure_row.oid = v_expiry;

  SELECT pg_catalog.array_agg(DISTINCT acl_entry.grantee)
  INTO v_grantees
  FROM pg_catalog.pg_proc AS procedure_row
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(
      procedure_row.proacl,
      pg_catalog.acldefault('f', procedure_row.proowner)
    )
  ) AS acl_entry
  WHERE procedure_row.oid = v_expiry
    AND acl_entry.grantee <> v_owner;

  FOREACH v_grantee IN ARRAY COALESCE(v_grantees, ARRAY[]::oid[])
  LOOP
    IF v_grantee = 0::oid THEN
      v_grantee_sql := 'PUBLIC';
    ELSE
      SELECT role_row.rolname
      INTO v_grantee_name
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_grantee;

      IF v_grantee_name IS NULL THEN
        RAISE EXCEPTION 'dangling expiry-function ACL grantee oid: %', v_grantee;
      END IF;
      v_grantee_sql := pg_catalog.format('%I', v_grantee_name);
    END IF;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s CASCADE',
      v_expiry,
      v_grantee_sql
    );
  END LOOP;

  EXECUTE
    'GRANT EXECUTE ON FUNCTION public.expire_group_subscriptions() TO service_role';
END
$converge_expiry_function$;

DO $postflight$
DECLARE
  v_relation pg_catalog.regclass :=
    'public.group_subscriptions'::pg_catalog.regclass;
  v_groups pg_catalog.regclass := 'public.groups'::pg_catalog.regclass;
  v_expiry pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure('public.expire_group_subscriptions()');
  v_postgres oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_authenticator oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticator'
  );
  v_role name;
  v_privilege text;
  v_column name;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND NOT relation.relispartition
      AND relation.relowner = v_postgres
      AND relation.relrowsecurity
      AND NOT relation.relforcerowsecurity
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = v_relation
       OR inheritance.inhparent = v_relation
  ) THEN
    RAISE EXCEPTION 'group subscription owner-compatible RLS seal is incomplete';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_relation
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = v_groups
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_relation
          AND attribute.attname = 'group_id'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )]::smallint[]
      AND constraint_row.confkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_groups
          AND attribute.attname = 'id'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )]::smallint[]
  ) <> 1 THEN
    RAISE EXCEPTION 'group subscription parent cascade drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> v_postgres
  ) THEN
    RAISE EXCEPTION 'group subscription column ACLs did not converge';
  END IF;

  IF EXISTS (
    WITH expected(grantee, grantor, privilege_type, is_grantable) AS (
      VALUES
        (v_service, v_postgres, 'DELETE'::text, false),
        (v_service, v_postgres, 'INSERT'::text, false),
        (v_service, v_postgres, 'SELECT'::text, false),
        (v_service, v_postgres, 'UPDATE'::text, false)
    ),
    actual AS (
      SELECT
        acl_entry.grantee,
        acl_entry.grantor,
        acl_entry.privilege_type::text,
        acl_entry.is_grantable
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      WHERE relation.oid = v_relation
        AND acl_entry.grantee <> relation.relowner
    )
    SELECT 1
    FROM expected
    FULL JOIN actual
      USING (grantee, grantor, privilege_type, is_grantable)
    WHERE expected.grantee IS NULL OR actual.grantee IS NULL
  ) THEN
    RAISE EXCEPTION 'group subscription table ACLs did not converge to exact service CRUD';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_relation
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_relation
      AND policy.polname = 'service_role_manages_group_subscriptions'
      AND policy.polpermissive
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[v_service]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
  ) THEN
    RAISE EXCEPTION 'group subscription policies did not converge to service-only ALL';
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
      IF pg_catalog.has_table_privilege(v_role, v_relation, v_privilege) THEN
        RAISE EXCEPTION '% still has % on public.group_subscriptions',
          v_role, v_privilege;
      END IF;
    END LOOP;

    FOR v_column IN
      SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attnum
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
      ]::text[]
      LOOP
        IF pg_catalog.has_column_privilege(
          v_role,
          v_relation,
          v_column,
          v_privilege
        ) THEN
          RAISE EXCEPTION '% still has column % on public.group_subscriptions.%',
            v_role, v_privilege, v_column;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  IF v_expiry IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure_row
      WHERE procedure_row.oid = v_expiry
        AND procedure_row.prokind = 'f'
        AND procedure_row.prosecdef
        AND procedure_row.proowner = v_postgres
    ) OR EXISTS (
      WITH expected(grantee, grantor, privilege_type, is_grantable) AS (
        VALUES (v_service, v_postgres, 'EXECUTE'::text, false)
      ),
      actual AS (
        SELECT
          acl_entry.grantee,
          acl_entry.grantor,
          acl_entry.privilege_type::text,
          acl_entry.is_grantable
        FROM pg_catalog.pg_proc AS procedure_row
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            procedure_row.proacl,
            pg_catalog.acldefault('f', procedure_row.proowner)
          )
        ) AS acl_entry
        WHERE procedure_row.oid = v_expiry
          AND acl_entry.grantee <> procedure_row.proowner
      )
      SELECT 1
      FROM expected
      FULL JOIN actual
        USING (grantee, grantor, privilege_type, is_grantable)
      WHERE expected.grantee IS NULL OR actual.grantee IS NULL
    ) OR NOT pg_catalog.has_function_privilege(
      'service_role', v_expiry, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'anon', v_expiry, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticated', v_expiry, 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'expiry function authority did not converge to exact service execution';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service
      AND membership.member = v_authenticator
      AND NOT membership.admin_option
      AND NOT membership.inherit_option
      AND membership.set_option
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service
      AND membership.member NOT IN (v_authenticator, v_postgres)
  ) OR EXISTS (
    WITH RECURSIVE service_inherits(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.member = v_service
        AND (membership.inherit_option OR membership.set_option)
      UNION
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inherits AS inherited
        ON membership.member = inherited.role_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1 FROM service_inherits
  ) OR EXISTS (
    WITH RECURSIVE owner_authority(member_oid) AS (
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.roleid = v_postgres
        AND (membership.inherit_option OR membership.set_option)
      UNION
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      JOIN owner_authority AS inherited
        ON membership.roleid = inherited.member_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1
    FROM owner_authority AS inherited
    JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = inherited.member_oid
    WHERE NOT role_row.rolsuper
      AND NOT role_row.rolbypassrls
      AND NOT (
        role_row.rolname = 'cli_login_postgres'
        AND role_row.rolcanlogin
        AND NOT role_row.rolinherit
        AND NOT role_row.rolcreaterole
        AND NOT role_row.rolcreatedb
        AND NOT role_row.rolreplication
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_auth_members AS managed_membership
          WHERE managed_membership.roleid = v_postgres
            AND managed_membership.member = role_row.oid
            AND NOT managed_membership.admin_option
            AND NOT managed_membership.inherit_option
            AND managed_membership.set_option
        )
      )
  ) OR EXISTS (
    WITH RECURSIVE browser_authority(root_oid, role_oid) AS (
      SELECT browser_role.oid, membership.roleid
      FROM pg_catalog.pg_roles AS browser_role
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = browser_role.oid
       AND (membership.inherit_option OR membership.set_option)
      WHERE browser_role.rolname IN ('anon', 'authenticated')
      UNION
      SELECT inherited.root_oid, membership.roleid
      FROM browser_authority AS inherited
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = inherited.role_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1
    FROM browser_authority AS inherited
    WHERE inherited.role_oid IN (v_service, v_postgres)
  ) THEN
    RAISE EXCEPTION 'group subscription owner or service-role authority seal drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
