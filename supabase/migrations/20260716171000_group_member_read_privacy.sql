-- Re-close the group-member read boundary after atomic_group_mute deliberately
-- converged public.group_members back to an all-column browser SELECT surface.
-- RLS filters rows; it cannot hide moderation actors, reasons or preferences
-- within rows. Browser callers therefore use three purpose-built projections.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('group-application-authority-migrations', 0)
);

DO $preflight$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_function oid := pg_catalog.to_regprocedure(
    'public.moderate_group_mute_atomic(uuid,uuid,uuid,uuid,text,timestamptz,text)'
  );
  v_view_name text;
  v_view_oid pg_catalog.regclass;
BEGIN
  IF v_postgres_oid IS NULL OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'service_role']::name[]
    ) AS required(role_name)
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.rolname = required.role_name
    WHERE role_row.oid IS NULL
  ) THEN
    RAISE EXCEPTION 'group-member privacy requires the application database roles';
  END IF;

  IF pg_catalog.to_regprocedure('auth.uid()') IS NULL OR (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = 'auth.uid()'::pg_catalog.regprocedure
  ) <> 'uuid'::pg_catalog.regtype THEN
    RAISE EXCEPTION 'group-member privacy requires auth.uid() returning uuid';
  END IF;

  IF pg_catalog.to_regclass('public.group_members') IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_members'::pg_catalog.regclass
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND NOT relation.relispartition
      AND relation.relowner = v_postgres_oid
      AND relation.relrowsecurity
      AND NOT relation.relforcerowsecurity
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = 'public.group_members'::pg_catalog.regclass
       OR inheritance.inhparent = 'public.group_members'::pg_catalog.regclass
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class = 'public.group_members'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION 'public.group_members ownership/RLS/relation shape is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('group_id', 'uuid'::pg_catalog.regtype, true),
        ('user_id', 'uuid'::pg_catalog.regtype, true),
        ('role', 'public.member_role'::pg_catalog.regtype, true),
        ('joined_at', 'timestamptz'::pg_catalog.regtype, true),
        ('notifications_muted', 'boolean'::pg_catalog.regtype, false),
        ('muted_until', 'timestamptz'::pg_catalog.regtype, false),
        ('mute_reason', 'text'::pg_catalog.regtype, false),
        ('muted_by', 'uuid'::pg_catalog.regtype, false),
        ('self_notify_muted', 'boolean'::pg_catalog.regtype, true),
        ('pinned', 'boolean'::pg_catalog.regtype, true)
    ) AS required(column_name, type_oid, required_not_null)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = 'public.group_members'::pg_catalog.regclass
     AND attribute.attname = required.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
       OR attribute.atttypid <> required.type_oid
       OR attribute.attgenerated <> ''
       OR (required.required_not_null AND NOT attribute.attnotnull)
  ) THEN
    RAISE EXCEPTION 'public.group_members privacy columns are incompatible';
  END IF;

  IF v_function IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND function_row.prokind = 'f'
      AND function_row.provolatile = 'v'
  ) THEN
    RAISE EXCEPTION 'atomic group-mute RPC is missing or incompatible';
  END IF;

  FOREACH v_view_name IN ARRAY ARRAY[
    'group_member_directory',
    'own_group_memberships',
    'group_member_moderation_directory'
  ]::text[]
  LOOP
    v_view_oid := pg_catalog.to_regclass('public.' || v_view_name);
    IF v_view_oid IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_view_oid
        AND relation.relkind = 'v'
    ) THEN
      RAISE EXCEPTION 'reserved group-member projection name is not a view: %', v_view_name;
    END IF;
  END LOOP;
END
$preflight$;

-- A view read takes its view lock before the underlying table lock. Acquire the
-- same complete order on replay; a failed NOWAIT attempt is an exception
-- subtransaction, so all partial locks from that attempt are released together.
DO $acquire_complete_ddl_lock_set$
DECLARE
  v_deadline timestamptz := pg_catalog.clock_timestamp() + interval '30 seconds';
  v_complete boolean;
  v_view_name text;
BEGIN
  LOOP
    v_complete := false;
    BEGIN
      FOREACH v_view_name IN ARRAY ARRAY[
        'group_member_directory',
        'own_group_memberships',
        'group_member_moderation_directory'
      ]::text[]
      LOOP
        IF pg_catalog.to_regclass('public.' || v_view_name) IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE NOWAIT',
            v_view_name
          );
        END IF;
      END LOOP;

      LOCK TABLE public.group_members IN ACCESS EXCLUSIVE MODE NOWAIT;
      v_complete := true;
    EXCEPTION
      WHEN lock_not_available THEN
        NULL;
    END;

    EXIT WHEN v_complete;
    IF pg_catalog.clock_timestamp() >= v_deadline THEN
      RAISE EXCEPTION USING
        ERRCODE = '55P03',
        MESSAGE = 'timed out acquiring the group-member privacy migration lock set';
    END IF;
    PERFORM pg_catalog.pg_sleep(0.05);
  END LOOP;
END
$acquire_complete_ddl_lock_set$;

DO $locked_recheck$
DECLARE
  v_view_name text;
  v_view_oid pg_catalog.regclass;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_members'::pg_catalog.regclass
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND NOT relation.relispartition
  ) THEN
    RAISE EXCEPTION 'locked public.group_members relation shape drifted';
  END IF;

  FOREACH v_view_name IN ARRAY ARRAY[
    'group_member_directory',
    'own_group_memberships',
    'group_member_moderation_directory'
  ]::text[]
  LOOP
    v_view_oid := pg_catalog.to_regclass('public.' || v_view_name);
    IF v_view_oid IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_view_oid
        AND relation.relkind = 'v'
    ) THEN
      RAISE EXCEPTION 'locked group-member projection name is not a view: %', v_view_name;
    END IF;
  END LOOP;
END
$locked_recheck$;

DROP VIEW IF EXISTS public.group_member_moderation_directory;
DROP VIEW IF EXISTS public.own_group_memberships;
DROP VIEW IF EXISTS public.group_member_directory;

DO $converge_base_authority$
DECLARE
  v_relation_oid pg_catalog.regclass := 'public.group_members'::pg_catalog.regclass;
  v_relation_owner oid;
  v_column_list text;
  v_grantee record;
  v_policy record;
BEGIN
  SELECT relation.relowner
  INTO STRICT v_relation_owner
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = v_relation_oid;

  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee, role_row.rolname
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = acl_entry.grantee
    WHERE relation.oid = v_relation_oid
      AND acl_entry.grantee <> v_relation_owner
  LOOP
    IF v_grantee.grantee = 0 THEN
      REVOKE ALL PRIVILEGES ON TABLE public.group_members FROM PUBLIC;
    ELSIF v_grantee.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.group_members FROM %I',
        v_grantee.rolname
      );
    END IF;
  END LOOP;

  REVOKE ALL PRIVILEGES ON TABLE public.group_members
    FROM PUBLIC, anon, authenticated, service_role;

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

  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee, role_row.rolname
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = acl_entry.grantee
    WHERE attribute.attrelid = v_relation_oid
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  LOOP
    IF v_grantee.grantee = 0 THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
          || 'ON TABLE public.group_members FROM PUBLIC',
        v_column_list
      );
    ELSIF v_grantee.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
          || 'ON TABLE public.group_members FROM %2$I',
        v_column_list,
        v_grantee.rolname
      );
    END IF;
  END LOOP;

  FOR v_policy IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_relation_oid
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.group_members',
      v_policy.polname
    );
  END LOOP;
END
$converge_base_authority$;

ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_members NO FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.group_members TO service_role;

-- These four columns are intentionally retained because existing posts,
-- comments, invitations and moderation RLS policies evaluate membership as
-- the caller. No moderation or preference column is directly JWT-readable.
GRANT SELECT (group_id, user_id, role, joined_at)
  ON TABLE public.group_members TO anon, authenticated;

CREATE POLICY jwt_safe_directory_read
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

CREATE VIEW public.group_member_directory
WITH (security_barrier = true, security_invoker = false)
AS
SELECT member.group_id,
       member.user_id,
       member.role,
       member.joined_at
FROM public.group_members AS member;

CREATE VIEW public.own_group_memberships
WITH (security_barrier = true, security_invoker = false)
AS
SELECT member.group_id,
       member.user_id,
       member.role,
       member.joined_at,
       member.muted_until,
       member.pinned
FROM public.group_members AS member
WHERE member.user_id = (SELECT auth.uid());

CREATE VIEW public.group_member_moderation_directory
WITH (security_barrier = true, security_invoker = false)
AS
SELECT member.group_id,
       member.user_id,
       member.role,
       member.joined_at,
       member.muted_until,
       member.mute_reason
FROM public.group_members AS member
WHERE EXISTS (
  SELECT 1
  FROM public.group_members AS actor_member
  WHERE actor_member.group_id = member.group_id
    AND actor_member.user_id = (SELECT auth.uid())
    AND actor_member.role::text IN ('owner', 'admin')
);

ALTER VIEW public.group_member_directory OWNER TO postgres;
ALTER VIEW public.own_group_memberships OWNER TO postgres;
ALTER VIEW public.group_member_moderation_directory OWNER TO postgres;

DO $converge_projection_authority$
DECLARE
  v_view_name text;
  v_view_oid pg_catalog.regclass;
  v_view_owner oid;
  v_grantee record;
BEGIN
  FOREACH v_view_name IN ARRAY ARRAY[
    'group_member_directory',
    'own_group_memberships',
    'group_member_moderation_directory'
  ]::text[]
  LOOP
    v_view_oid := ('public.' || v_view_name)::pg_catalog.regclass;
    SELECT relation.relowner
    INTO STRICT v_view_owner
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_view_oid;

    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee, role_row.rolname
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.oid = acl_entry.grantee
      WHERE relation.oid = v_view_oid
        AND acl_entry.grantee <> v_view_owner
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC',
          v_view_name
        );
      ELSIF v_grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',
          v_view_name,
          v_grantee.rolname
        );
      END IF;
    END LOOP;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.%I '
        || 'FROM PUBLIC, anon, authenticated, service_role',
      v_view_name
    );
  END LOOP;
END
$converge_projection_authority$;

GRANT SELECT ON TABLE public.group_member_directory TO anon, authenticated;
GRANT SELECT ON TABLE public.own_group_memberships TO authenticated;
GRANT SELECT ON TABLE public.group_member_moderation_directory TO authenticated;

DO $postflight$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_anon_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'anon'
  );
  v_authenticated_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticated'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_directory_definition text;
  v_own_definition text;
  v_moderation_definition text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_members'::pg_catalog.regclass
      AND relation.relowner = v_postgres_oid
      AND relation.relrowsecurity
      AND NOT relation.relforcerowsecurity
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_members'::pg_catalog.regclass
  ) <> 2 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_members'::pg_catalog.regclass
      AND policy.polname = 'jwt_safe_directory_read'
      AND policy.polpermissive
      AND policy.polcmd = 'r'
      AND pg_catalog.cardinality(policy.polroles) = 2
      AND v_anon_oid = ANY(policy.polroles)
      AND v_authenticated_oid = ANY(policy.polroles)
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND policy.polwithcheck IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_members'::pg_catalog.regclass
      AND policy.polname = 'server_role_mutation'
      AND policy.polpermissive
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[v_service_oid]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
  ) THEN
    RAISE EXCEPTION 'group-member RLS policy boundary drifted';
  END IF;

  IF EXISTS (
    WITH expected(grantee, privilege_type) AS (
      VALUES
        (v_service_oid, 'SELECT'::text),
        (v_service_oid, 'INSERT'::text),
        (v_service_oid, 'UPDATE'::text),
        (v_service_oid, 'DELETE'::text)
    ),
    actual AS (
      SELECT acl_entry.grantee, acl_entry.privilege_type::text
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS acl_entry
      WHERE relation.oid = 'public.group_members'::pg_catalog.regclass
        AND acl_entry.grantee <> relation.relowner
    )
    SELECT 1
    FROM expected
    FULL JOIN actual USING (grantee, privilege_type)
    WHERE expected.grantee IS NULL OR actual.grantee IS NULL
  ) THEN
    RAISE EXCEPTION 'group-member table ACL did not converge exactly';
  END IF;

  IF EXISTS (
    WITH expected(column_name, grantee, privilege_type) AS (
      SELECT safe_column.column_name, browser_role.role_oid, 'SELECT'::text
      FROM pg_catalog.unnest(
        ARRAY['group_id', 'user_id', 'role', 'joined_at']::text[]
      ) AS safe_column(column_name)
      CROSS JOIN pg_catalog.unnest(
        ARRAY[v_anon_oid, v_authenticated_oid]::oid[]
      ) AS browser_role(role_oid)
    ),
    actual AS (
      SELECT
        attribute.attname::text AS column_name,
        acl_entry.grantee,
        acl_entry.privilege_type::text
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid = 'public.group_members'::pg_catalog.regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
    SELECT 1
    FROM expected
    FULL JOIN actual USING (column_name, grantee, privilege_type)
    WHERE expected.column_name IS NULL OR actual.column_name IS NULL
  ) THEN
    RAISE EXCEPTION 'group-member column ACL did not converge exactly';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.group_members'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attname <> ALL (
        ARRAY['group_id', 'user_id', 'role', 'joined_at']::text[]
      )
      AND (
        pg_catalog.has_column_privilege(
          'anon', 'public.group_members', attribute.attname, 'SELECT'
        )
        OR pg_catalog.has_column_privilege(
          'authenticated', 'public.group_members', attribute.attname, 'SELECT'
        )
      )
  ) THEN
    RAISE EXCEPTION 'restricted group-member column remains JWT-readable';
  END IF;

  IF EXISTS (
    WITH RECURSIVE inherited(role_oid, member_oid) AS (
      SELECT membership.roleid, membership.member
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.member IN (v_anon_oid, v_authenticated_oid)
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
    WHERE inherited.role_oid IN (v_postgres_oid, v_service_oid)
  ) THEN
    RAISE EXCEPTION 'JWT roles inherit a privileged group-member authority role';
  END IF;

  IF EXISTS (
    WITH expected(view_name, ordinal_position, column_name, type_oid) AS (
      VALUES
        ('group_member_directory', 1, 'group_id', 'uuid'::pg_catalog.regtype),
        ('group_member_directory', 2, 'user_id', 'uuid'::pg_catalog.regtype),
        ('group_member_directory', 3, 'role', 'public.member_role'::pg_catalog.regtype),
        ('group_member_directory', 4, 'joined_at', 'timestamptz'::pg_catalog.regtype),
        ('own_group_memberships', 1, 'group_id', 'uuid'::pg_catalog.regtype),
        ('own_group_memberships', 2, 'user_id', 'uuid'::pg_catalog.regtype),
        ('own_group_memberships', 3, 'role', 'public.member_role'::pg_catalog.regtype),
        ('own_group_memberships', 4, 'joined_at', 'timestamptz'::pg_catalog.regtype),
        ('own_group_memberships', 5, 'muted_until', 'timestamptz'::pg_catalog.regtype),
        ('own_group_memberships', 6, 'pinned', 'boolean'::pg_catalog.regtype),
        ('group_member_moderation_directory', 1, 'group_id', 'uuid'::pg_catalog.regtype),
        ('group_member_moderation_directory', 2, 'user_id', 'uuid'::pg_catalog.regtype),
        ('group_member_moderation_directory', 3, 'role', 'public.member_role'::pg_catalog.regtype),
        ('group_member_moderation_directory', 4, 'joined_at', 'timestamptz'::pg_catalog.regtype),
        ('group_member_moderation_directory', 5, 'muted_until', 'timestamptz'::pg_catalog.regtype),
        ('group_member_moderation_directory', 6, 'mute_reason', 'text'::pg_catalog.regtype)
    ),
    actual AS (
      SELECT
        relation.relname::text AS view_name,
        attribute.attnum::integer AS ordinal_position,
        attribute.attname::text AS column_name,
        attribute.atttypid AS type_oid
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
      WHERE relation.oid IN (
        'public.group_member_directory'::pg_catalog.regclass,
        'public.own_group_memberships'::pg_catalog.regclass,
        'public.group_member_moderation_directory'::pg_catalog.regclass
      )
    )
    SELECT 1
    FROM expected
    FULL JOIN actual USING (view_name, ordinal_position, column_name, type_oid)
    WHERE expected.view_name IS NULL OR actual.view_name IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.group_member_directory'::pg_catalog.regclass,
      'public.own_group_memberships'::pg_catalog.regclass,
      'public.group_member_moderation_directory'::pg_catalog.regclass
    )
      AND (
        relation.relkind <> 'v'
        OR relation.relowner <> v_postgres_oid
        OR NOT relation.reloptions @> ARRAY[
          'security_barrier=true',
          'security_invoker=false'
        ]::text[]
      )
  ) THEN
    RAISE EXCEPTION 'group-member projection schema/options drifted';
  END IF;

  IF EXISTS (
    WITH expected(view_name, grantee, privilege_type) AS (
      VALUES
        ('group_member_directory', v_anon_oid, 'SELECT'::text),
        ('group_member_directory', v_authenticated_oid, 'SELECT'::text),
        ('own_group_memberships', v_authenticated_oid, 'SELECT'::text),
        ('group_member_moderation_directory', v_authenticated_oid, 'SELECT'::text)
    ),
    actual AS (
      SELECT
        relation.relname::text AS view_name,
        acl_entry.grantee,
        acl_entry.privilege_type::text
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS acl_entry
      WHERE relation.oid IN (
        'public.group_member_directory'::pg_catalog.regclass,
        'public.own_group_memberships'::pg_catalog.regclass,
        'public.group_member_moderation_directory'::pg_catalog.regclass
      )
        AND acl_entry.grantee <> relation.relowner
    )
    SELECT 1
    FROM expected
    FULL JOIN actual USING (view_name, grantee, privilege_type)
    WHERE expected.view_name IS NULL OR actual.view_name IS NULL
  ) THEN
    RAISE EXCEPTION 'group-member projection ACL did not converge exactly';
  END IF;

  SELECT pg_catalog.pg_get_viewdef(
    'public.group_member_directory'::pg_catalog.regclass,
    false
  ) INTO STRICT v_directory_definition;
  SELECT pg_catalog.pg_get_viewdef(
    'public.own_group_memberships'::pg_catalog.regclass,
    false
  ) INTO STRICT v_own_definition;
  SELECT pg_catalog.pg_get_viewdef(
    'public.group_member_moderation_directory'::pg_catalog.regclass,
    false
  ) INTO STRICT v_moderation_definition;

  IF v_directory_definition ~ '(muted_|mute_reason|muted_by|notifications_muted|self_notify_muted|pinned)'
    OR v_own_definition ~ '(mute_reason|muted_by|notifications_muted|self_notify_muted)'
    OR v_own_definition !~ 'auth.uid\(\)'
    OR v_moderation_definition ~ '(muted_by|notifications_muted|self_notify_muted|pinned)'
    OR v_moderation_definition !~ 'auth.uid\(\)'
    OR v_moderation_definition !~ '(owner|admin)'
  THEN
    RAISE EXCEPTION 'group-member projection definition is unsafe';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
      'public.moderate_group_mute_atomic(uuid,uuid,uuid,uuid,text,timestamptz,text)'::pg_catalog.regprocedure
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.moderate_group_mute_atomic(uuid,uuid,uuid,uuid,text,timestamptz,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'atomic group-mute RPC lost its service boundary';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
