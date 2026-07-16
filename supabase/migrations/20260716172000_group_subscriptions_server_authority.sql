-- Paid group entitlements and their payment metadata are server authority.
-- Browser roles must use /api/groups/subscribe; they must never manufacture
-- an active entitlement or read/write provider references through PostgREST.

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
  v_subscription pg_catalog.regclass :=
    pg_catalog.to_regclass('public.group_subscriptions');
  v_groups pg_catalog.regclass := pg_catalog.to_regclass('public.groups');
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_authenticator_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticator'
  );
BEGIN
  IF v_postgres_oid IS NULL
    OR v_service_oid IS NULL
    OR v_authenticator_oid IS NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(ARRAY['anon', 'authenticated']::name[])
        AS required_role(role_name)
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.rolname = required_role.role_name
      WHERE role_row.oid IS NULL
    )
  THEN
    RAISE EXCEPTION 'required Supabase application role is missing';
  END IF;

  IF v_subscription IS NULL OR v_groups IS NULL THEN
    RAISE EXCEPTION
      'public.groups and public.group_subscriptions must exist before authority hardening';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (v_subscription, v_groups)
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
        OR relation.relowner <> v_postgres_oid
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (v_subscription, v_groups)
       OR inheritance.inhparent IN (v_subscription, v_groups)
  ) THEN
    RAISE EXCEPTION
      'group subscription authority requires ordinary permanent postgres-owned tables';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('id', 'uuid'::pg_catalog.regtype, true, true),
        ('group_id', 'uuid'::pg_catalog.regtype, true, false),
        ('user_id', 'uuid'::pg_catalog.regtype, true, false),
        ('tier', 'text'::pg_catalog.regtype, true, false),
        ('status', 'text'::pg_catalog.regtype, true, false),
        ('price_paid', 'numeric'::pg_catalog.regtype, false, false),
        ('starts_at', 'timestamptz'::pg_catalog.regtype, true, false),
        ('expires_at', 'timestamptz'::pg_catalog.regtype, true, false),
        ('cancelled_at', 'timestamptz'::pg_catalog.regtype, false, false),
        ('payment_provider', 'text'::pg_catalog.regtype, false, false),
        ('payment_reference', 'text'::pg_catalog.regtype, false, false),
        ('created_at', 'timestamptz'::pg_catalog.regtype, false, false),
        ('updated_at', 'timestamptz'::pg_catalog.regtype, false, false)
    ) AS required_column(
      column_name,
      type_oid,
      required_not_null,
      required_default
    )
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = v_subscription
     AND attribute.attname = required_column.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
       OR attribute.atttypid <> required_column.type_oid
       OR attribute.attgenerated <> ''
       OR (
         required_column.required_not_null
         AND NOT attribute.attnotnull
       )
       OR (
         required_column.required_default
         AND NOT attribute.atthasdef
       )
  ) THEN
    RAISE EXCEPTION
      'public.group_subscriptions has missing or incompatible route columns';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_groups
      AND attribute.attname = 'id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.atttypid = 'uuid'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.attgenerated = ''
  ) THEN
    RAISE EXCEPTION 'public.groups.id must be a non-generated NOT NULL uuid';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_subscription
      AND constraint_row.contype = 'p'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_subscription
          AND attribute.attname = 'id'
      )]::smallint[]
  ) <> 1 THEN
    RAISE EXCEPTION
      'public.group_subscriptions requires an immediate validated id primary key';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_subscription
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = v_groups
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_subscription
          AND attribute.attname = 'group_id'
      )]::smallint[]
      AND constraint_row.confkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_groups
          AND attribute.attname = 'id'
      )]::smallint[]
  ) <> 1 THEN
    RAISE EXCEPTION
      'public.group_subscriptions requires the validated groups(id) ON DELETE CASCADE foreign key';
  END IF;

  -- The gateway may SET ROLE service_role for a service JWT, but it must not
  -- inherit that role. No other non-superuser role may hold the service role.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service_oid
      AND membership.member = v_authenticator_oid
      AND NOT membership.admin_option
      AND NOT membership.inherit_option
      AND membership.set_option
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service_oid
      AND membership.member NOT IN (v_authenticator_oid, v_postgres_oid)
  ) OR EXISTS (
    WITH RECURSIVE service_inheritors(member_oid) AS (
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.roleid = v_service_oid
        AND membership.inherit_option
      UNION
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inheritors AS inherited
        ON membership.roleid = inherited.member_oid
      WHERE membership.inherit_option
    )
    SELECT 1
    FROM service_inheritors AS inherited
    WHERE inherited.member_oid <> v_postgres_oid
  ) OR EXISTS (
    WITH RECURSIVE service_inherits(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.member = v_service_oid
        AND membership.inherit_option
      UNION
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inherits AS inherited
        ON membership.member = inherited.role_oid
      WHERE membership.inherit_option
    )
    SELECT 1 FROM service_inherits
  ) OR EXISTS (
    WITH RECURSIVE jwt_inherits(root_oid, role_oid) AS (
      SELECT jwt_role.oid, membership.roleid
      FROM pg_catalog.pg_roles AS jwt_role
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = jwt_role.oid
       AND membership.inherit_option
      WHERE jwt_role.rolname IN ('anon', 'authenticated')
      UNION
      SELECT inherited.root_oid, membership.roleid
      FROM jwt_inherits AS inherited
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = inherited.role_oid
       AND membership.inherit_option
    )
    SELECT 1
    FROM jwt_inherits AS inherited
    WHERE inherited.role_oid IN (v_service_oid, v_postgres_oid)
  ) THEN
    RAISE EXCEPTION 'service_role membership or inheritance graph is unsafe';
  END IF;
END
$preflight$;

LOCK TABLE public.group_subscriptions IN ACCESS EXCLUSIVE MODE;

DO $locked_recheck$
DECLARE
  v_subscription pg_catalog.regclass :=
    'public.group_subscriptions'::pg_catalog.regclass;
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_subscription
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
        OR relation.relowner <> v_postgres_oid
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = v_subscription
       OR inheritance.inhparent = v_subscription
  ) THEN
    RAISE EXCEPTION
      'public.group_subscriptions drifted while acquiring the authority lock';
  END IF;
END
$locked_recheck$;

ALTER TABLE public.group_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_subscriptions FORCE ROW LEVEL SECURITY;

-- Revoke every direct table and column ACL held by a non-owner role. This is
-- intentionally catalog-driven so dashboard/manual roles and future columns
-- cannot retain a path that a fixed role/column list would miss.
DO $revoke_nonowner_acl$
DECLARE
  v_relation pg_catalog.regclass :=
    'public.group_subscriptions'::pg_catalog.regclass;
  v_owner_oid oid := (
    SELECT relation.relowner
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_subscriptions'::pg_catalog.regclass
  );
  v_grantee_oid oid;
  v_grantee_name name;
  v_grantee_sql text;
  v_grantee_oids oid[];
  v_column_list text;
BEGIN
  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', '
    ORDER BY attribute.attnum
  )
  INTO v_column_list
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = v_relation
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF v_column_list IS NULL THEN
    RAISE EXCEPTION 'public.group_subscriptions has no columns to secure';
  END IF;

  SELECT pg_catalog.array_agg(DISTINCT discovered.grantee)
  INTO v_grantee_oids
  FROM (
    SELECT table_acl.grantee
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS table_acl
    WHERE relation.oid = v_relation
    UNION
    SELECT column_acl.grantee
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS column_acl
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) AS discovered
  WHERE discovered.grantee <> v_owner_oid;

  FOREACH v_grantee_oid IN ARRAY COALESCE(v_grantee_oids, ARRAY[]::oid[])
  LOOP
    IF v_grantee_oid = 0::oid THEN
      v_grantee_sql := 'PUBLIC';
    ELSE
      SELECT role_row.rolname
      INTO v_grantee_name
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_grantee_oid;

      IF v_grantee_name IS NULL THEN
        RAISE EXCEPTION
          'dangling group subscription ACL grantee oid: %',
          v_grantee_oid;
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
      v_column_list,
      v_grantee_sql
    );
  END LOOP;
END
$revoke_nonowner_acl$;

DO $drop_all_subscription_policies$
DECLARE
  v_policy_name name;
BEGIN
  FOR v_policy_name IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid =
      'public.group_subscriptions'::pg_catalog.regclass
    ORDER BY policy.polname
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.group_subscriptions',
      v_policy_name
    );
  END LOOP;
END
$drop_all_subscription_policies$;

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

DO $postflight$
DECLARE
  v_relation pg_catalog.regclass :=
    'public.group_subscriptions'::pg_catalog.regclass;
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_authenticator_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticator'
  );
  v_role name;
  v_privilege text;
  v_column name;
  v_service_privileges text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND NOT relation.relispartition
      AND relation.relowner = v_postgres_oid
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = v_relation
       OR inheritance.inhparent = v_relation
  ) THEN
    RAISE EXCEPTION
      'group subscription owner/table/RLS authority seal is incomplete';
  END IF;

  -- No direct non-owner ACL is allowed except the exact service table grant.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = v_relation
      AND acl_entry.grantee NOT IN (relation.relowner, v_service_oid)
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION
      'non-owner or direct column ACL remains on public.group_subscriptions';
  END IF;

  SELECT pg_catalog.array_agg(
    acl_entry.privilege_type
    ORDER BY acl_entry.privilege_type
  )
  INTO v_service_privileges
  FROM pg_catalog.pg_class AS relation
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(
      relation.relacl,
      pg_catalog.acldefault('r', relation.relowner)
    )
  ) AS acl_entry
  WHERE relation.oid = v_relation
    AND acl_entry.grantee = v_service_oid
    AND NOT acl_entry.is_grantable;

  IF v_service_privileges IS DISTINCT FROM
    ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      WHERE relation.oid = v_relation
        AND acl_entry.grantee = v_service_oid
        AND (
          acl_entry.is_grantable
          OR acl_entry.grantor <> v_postgres_oid
        )
    )
  THEN
    RAISE EXCEPTION
      'service_role group subscription ACL is not exact CRUD';
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
        RAISE EXCEPTION
          '% still has % on public.group_subscriptions',
          v_role,
          v_privilege;
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
        'SELECT',
        'INSERT',
        'UPDATE',
        'REFERENCES'
      ]::text[]
      LOOP
        IF pg_catalog.has_column_privilege(
          v_role,
          v_relation,
          v_column,
          v_privilege
        ) THEN
          RAISE EXCEPTION
            '% still has column % on public.group_subscriptions.%',
            v_role,
            v_privilege,
            v_column;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  IF pg_catalog.has_column_privilege(
    'anon',
    v_relation,
    'payment_provider',
    'SELECT'
  ) OR pg_catalog.has_column_privilege(
    'anon',
    v_relation,
    'payment_reference',
    'SELECT'
  ) OR pg_catalog.has_column_privilege(
    'authenticated',
    v_relation,
    'payment_provider',
    'SELECT'
  ) OR pg_catalog.has_column_privilege(
    'authenticated',
    v_relation,
    'payment_reference',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'payment metadata remains browser-readable';
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
      AND policy.polroles = ARRAY[v_service_oid]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
  ) THEN
    RAISE EXCEPTION
      'group subscription policies did not converge to service-only ALL';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service_oid
      AND membership.member = v_authenticator_oid
      AND NOT membership.admin_option
      AND NOT membership.inherit_option
      AND membership.set_option
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service_oid
      AND membership.member NOT IN (v_authenticator_oid, v_postgres_oid)
  ) OR EXISTS (
    WITH RECURSIVE service_inheritors(member_oid) AS (
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.roleid = v_service_oid
        AND membership.inherit_option
      UNION
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inheritors AS inherited
        ON membership.roleid = inherited.member_oid
      WHERE membership.inherit_option
    )
    SELECT 1
    FROM service_inheritors AS inherited
    WHERE inherited.member_oid <> v_postgres_oid
  ) OR EXISTS (
    WITH RECURSIVE service_inherits(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.member = v_service_oid
        AND membership.inherit_option
      UNION
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inherits AS inherited
        ON membership.member = inherited.role_oid
      WHERE membership.inherit_option
    )
    SELECT 1 FROM service_inherits
  ) OR EXISTS (
    WITH RECURSIVE jwt_inherits(root_oid, role_oid) AS (
      SELECT jwt_role.oid, membership.roleid
      FROM pg_catalog.pg_roles AS jwt_role
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = jwt_role.oid
       AND membership.inherit_option
      WHERE jwt_role.rolname IN ('anon', 'authenticated')
      UNION
      SELECT inherited.root_oid, membership.roleid
      FROM jwt_inherits AS inherited
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = inherited.role_oid
       AND membership.inherit_option
    )
    SELECT 1
    FROM jwt_inherits AS inherited
    WHERE inherited.role_oid IN (v_service_oid, v_postgres_oid)
  ) THEN
    RAISE EXCEPTION 'service_role authority inheritance seal drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
