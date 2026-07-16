-- Make group dissolution a one-way, audited database transaction.  Browser
-- and service clients may still read groups, but dissolved_at is no longer a
-- service-writable column and can change only inside the canonical RPC.

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
  v_auth_id_attnum smallint;
  v_groups_id_attnum smallint;
  v_audit_id_attnum smallint;
  v_audit_group_attnum smallint;
  v_audit_actor_attnum smallint;
  v_audit_target_attnum smallint;
  v_existing pg_catalog.regprocedure;
BEGIN
  IF v_postgres_oid IS NULL
    OR v_service_oid IS NULL
    OR v_authenticator_oid IS NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(ARRAY['anon', 'authenticated']::name[])
        AS required(role_name)
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.rolname = required.role_name
      WHERE role_row.oid IS NULL
    )
  THEN
    RAISE EXCEPTION 'atomic group dissolution requires the application database roles';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL OR (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = 'auth.role()'::pg_catalog.regprocedure
  ) <> 'text'::pg_catalog.regtype THEN
    RAISE EXCEPTION 'atomic group dissolution requires auth.role() returning text';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY[
      'auth.users',
      'public.user_profiles',
      'public.groups',
      'public.group_audit_log'
    ]::text[]) AS required(relation_name)
    LEFT JOIN pg_catalog.pg_class AS relation
      ON relation.oid = pg_catalog.to_regclass(required.relation_name)
     AND relation.relkind = 'r'
     AND relation.relpersistence = 'p'
     AND NOT relation.relispartition
    WHERE relation.oid IS NULL
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_inherits AS inheritance
         WHERE inheritance.inhrelid = relation.oid
            OR inheritance.inhparent = relation.oid
       )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_rewrite AS rewrite_rule
         WHERE rewrite_rule.ev_class = relation.oid
       )
  ) THEN
    RAISE EXCEPTION 'atomic group dissolution dependency relation shape is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.user_profiles'::pg_catalog.regclass,
      'public.groups'::pg_catalog.regclass,
      'public.group_audit_log'::pg_catalog.regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.groups'::pg_catalog.regclass
      AND relation.relrowsecurity
      AND NOT relation.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_audit_log'::pg_catalog.regclass
      AND relation.relrowsecurity
      AND NOT relation.relforcerowsecurity
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_audit_log'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION 'atomic group dissolution ownership/RLS contract is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('auth', 'users', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'user_profiles', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'user_profiles', 'banned_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'user_profiles', 'is_banned', 'boolean'::pg_catalog.regtype, false),
        ('public', 'user_profiles', 'ban_expires_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'groups', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'groups', 'name', 'text'::pg_catalog.regtype, true),
        ('public', 'groups', 'created_by', 'uuid'::pg_catalog.regtype, true),
        ('public', 'groups', 'updated_at', 'timestamptz'::pg_catalog.regtype, true),
        ('public', 'groups', 'dissolved_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'group_audit_log', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'group_audit_log', 'group_id', 'uuid'::pg_catalog.regtype, false),
        ('public', 'group_audit_log', 'actor_id', 'uuid'::pg_catalog.regtype, false),
        ('public', 'group_audit_log', 'action', 'text'::pg_catalog.regtype, true),
        ('public', 'group_audit_log', 'target_id', 'uuid'::pg_catalog.regtype, false),
        ('public', 'group_audit_log', 'details', 'jsonb'::pg_catalog.regtype, false),
        ('public', 'group_audit_log', 'created_at', 'timestamptz'::pg_catalog.regtype, false)
    ) AS required_column(
      schema_name,
      relation_name,
      column_name,
      type_oid,
      required_not_null
    )
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = pg_catalog.to_regclass(
        pg_catalog.format(
          '%I.%I',
          required_column.schema_name,
          required_column.relation_name
        )
      )
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
  ) THEN
    RAISE EXCEPTION 'atomic group dissolution dependency columns are incompatible';
  END IF;

  SELECT attribute.attnum
  INTO STRICT v_auth_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'auth.users'::pg_catalog.regclass
    AND attribute.attname = 'id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_groups_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.groups'::pg_catalog.regclass
    AND attribute.attname = 'id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_audit_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.group_audit_log'::pg_catalog.regclass
    AND attribute.attname = 'id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_audit_group_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.group_audit_log'::pg_catalog.regclass
    AND attribute.attname = 'group_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_audit_actor_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.group_audit_log'::pg_catalog.regclass
    AND attribute.attname = 'actor_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_audit_target_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.group_audit_log'::pg_catalog.regclass
    AND attribute.attname = 'target_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_row.contype = 'p'
      AND constraint_row.conkey = ARRAY[v_auth_id_attnum]::smallint[]
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.groups'::pg_catalog.regclass
      AND constraint_row.contype = 'p'
      AND constraint_row.conkey = ARRAY[v_groups_id_attnum]::smallint[]
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.group_audit_log'::pg_catalog.regclass
      AND constraint_row.contype = 'p'
      AND constraint_row.conkey = ARRAY[v_audit_id_attnum]::smallint[]
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.group_audit_log'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.conkey = ARRAY[v_audit_group_attnum]::smallint[]
      AND constraint_row.confrelid = 'public.groups'::pg_catalog.regclass
      AND constraint_row.confkey = ARRAY[v_groups_id_attnum]::smallint[]
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.group_audit_log'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.conkey = ARRAY[v_audit_actor_attnum]::smallint[]
      AND constraint_row.confrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_row.confkey = ARRAY[v_auth_id_attnum]::smallint[]
      AND constraint_row.confdeltype = 'n'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) <> 1 OR EXISTS (
    -- Dissolution audit targets the group itself.  The production audit
    -- contract intentionally leaves target_id polymorphic; a user-only FK
    -- would make that evidence insert invalid and must fail preflight.
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.group_audit_log'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND v_audit_target_attnum = ANY(constraint_row.conkey)
  ) THEN
    RAISE EXCEPTION 'atomic group dissolution key/FK contract is incompatible';
  END IF;

  IF pg_catalog.to_regprocedure(
    'public.purge_deleted_account_group_edges(uuid)'
  ) IS NULL OR (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
      'public.purge_deleted_account_group_edges(uuid)'::pg_catalog.regprocedure
  ) <> 'jsonb'::pg_catalog.regtype THEN
    RAISE EXCEPTION 'deleted-account group purge boundary must be installed first';
  END IF;

  -- Supabase's gateway must be able to SET ROLE service_role without
  -- inheriting it.  Every other untrusted direct or recursive path is unsafe.
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
    WITH RECURSIVE browser_authority(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_roles AS browser_role
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = browser_role.oid
       AND (membership.inherit_option OR membership.set_option)
      WHERE browser_role.rolname IN ('anon', 'authenticated')
      UNION
      SELECT membership.roleid
      FROM browser_authority AS inherited
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = inherited.role_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1
    FROM browser_authority AS inherited
    WHERE inherited.role_oid IN (v_service_oid, v_postgres_oid)
  ) THEN
    RAISE EXCEPTION 'service_role has an unsafe effective authority edge';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname = 'dissolve_group_atomic'
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid) <>
        'p_actor_id uuid, p_group_id uuid'
  ) THEN
    RAISE EXCEPTION 'incompatible dissolve_group_atomic overload exists';
  END IF;

  v_existing := pg_catalog.to_regprocedure(
    'public.dissolve_group_atomic(uuid,uuid)'
  );
  IF v_existing IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_existing
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND function_row.prokind = 'f'
  ) THEN
    RAISE EXCEPTION 'existing dissolve_group_atomic has an incompatible contract';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname = 'enforce_group_dissolution_write'
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid) <> ''
  ) THEN
    RAISE EXCEPTION 'incompatible group dissolution guard overload exists';
  END IF;

  v_existing := pg_catalog.to_regprocedure(
    'public.enforce_group_dissolution_write()'
  );
  IF v_existing IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_existing
      AND function_row.prorettype = 'trigger'::pg_catalog.regtype
      AND function_row.prokind = 'f'
  ) THEN
    RAISE EXCEPTION 'existing group dissolution guard has an incompatible contract';
  END IF;
END
$preflight$;

-- Audit inserts lock the audit table before checking their group FK, while the
-- runtime RPC locks a group row before inserting audit evidence.  A bounded
-- NOWAIT retry acquires the complete DDL set or releases every partial lock,
-- avoiding either lock-order cycle during migration replay.
DO $acquire_complete_ddl_lock_set$
DECLARE
  v_deadline timestamptz := pg_catalog.clock_timestamp() + interval '30 seconds';
  v_complete boolean;
BEGIN
  LOOP
    v_complete := false;
    BEGIN
      LOCK TABLE public.group_audit_log IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE public.groups IN ACCESS EXCLUSIVE MODE NOWAIT;
      v_complete := true;
    EXCEPTION
      WHEN lock_not_available THEN
        NULL;
    END;

    EXIT WHEN v_complete;
    IF pg_catalog.clock_timestamp() >= v_deadline THEN
      RAISE EXCEPTION USING
        ERRCODE = '55P03',
        MESSAGE = 'timed out acquiring the atomic group dissolution DDL lock set';
    END IF;
    PERFORM pg_catalog.pg_sleep(0.05);
  END LOOP;
END
$acquire_complete_ddl_lock_set$;

DO $locked_recheck$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.groups'::pg_catalog.regclass
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND NOT relation.relispartition
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_audit_log'::pg_catalog.regclass
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND NOT relation.relispartition
  ) THEN
    RAISE EXCEPTION 'locked group dissolution relations drifted';
  END IF;
END
$locked_recheck$;

-- Converge every historical/custom table and column grant.  Service code keeps
-- its existing group write surface except for dissolved_at, which becomes an
-- RPC-only column.  New columns fail closed until a later migration grants them.
DO $converge_group_authority$
DECLARE
  v_relation_oid pg_catalog.regclass := 'public.groups'::pg_catalog.regclass;
  v_relation_owner oid;
  v_column_list text;
  v_update_column_list text;
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
      EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.groups FROM PUBLIC CASCADE';
    ELSIF v_grantee.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.groups FROM %I CASCADE',
        v_grantee.rolname
      );
    END IF;
  END LOOP;

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
      AND acl_entry.grantee <> v_relation_owner
  LOOP
    IF v_grantee.grantee = 0 THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
          || 'ON TABLE public.groups FROM PUBLIC CASCADE',
        v_column_list
      );
    ELSIF v_grantee.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
          || 'ON TABLE public.groups FROM %2$I CASCADE',
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
      'DROP POLICY %I ON public.groups',
      v_policy.polname
    );
  END LOOP;

  ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.groups NO FORCE ROW LEVEL SECURITY;

  GRANT SELECT ON TABLE public.groups TO anon, authenticated;
  GRANT SELECT, INSERT ON TABLE public.groups TO service_role;

  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', '
    ORDER BY attribute.attnum
  )
  INTO STRICT v_update_column_list
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = v_relation_oid
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
    AND attribute.attname <> 'dissolved_at';

  EXECUTE pg_catalog.format(
    'GRANT UPDATE (%s) ON TABLE public.groups TO service_role',
    v_update_column_list
  );

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
END
$converge_group_authority$;

CREATE OR REPLACE FUNCTION public.enforce_group_dissolution_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_dissolution_path text := pg_catalog.current_setting(
    'arena.group_dissolution_path',
    true
  );
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.dissolved_at IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'new groups must start active';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.dissolved_at IS NOT DISTINCT FROM OLD.dissolved_at THEN
    RETURN NEW;
  END IF;

  IF OLD.dissolved_at IS NOT NULL OR NEW.dissolved_at IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'group dissolution is irreversible';
  END IF;

  IF v_dissolution_path IS DISTINCT FROM 'dissolve_group_atomic' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'group dissolution requires its atomic RPC';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.enforce_group_dissolution_write() OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.dissolve_group_atomic(
  p_actor_id uuid,
  p_group_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_profile public.user_profiles%ROWTYPE;
  v_group public.groups%ROWTYPE;
  v_now timestamptz;
  v_previous_path text;
  v_audit_id uuid;
  v_affected integer := 0;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_actor_id IS NULL OR p_group_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  -- Serialize retries without depending on mutable audit rows.  The group row
  -- remains the durable one-way idempotency record.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-dissolution:' || p_group_id::text,
      0
    )
  );

  -- Auth -> profile -> group matches account-deletion and current group
  -- mutation lock order, avoiding group -> audit-actor FK deletion cycles.
  PERFORM auth_user.id
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_actor_id
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'actor_unavailable');
  END IF;

  SELECT profile.*
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_profile.deleted_at IS NOT NULL
     OR v_profile.banned_at IS NOT NULL
     OR (
       COALESCE(v_profile.is_banned, false)
       AND (
         v_profile.ban_expires_at IS NULL
         OR v_profile.ban_expires_at > pg_catalog.clock_timestamp()
       )
     )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'actor_unavailable');
  END IF;

  SELECT target_group.*
  INTO v_group
  FROM public.groups AS target_group
  WHERE target_group.id = p_group_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_group.created_by IS DISTINCT FROM p_actor_id THEN
    RETURN pg_catalog.jsonb_build_object('status', 'forbidden');
  END IF;

  IF v_group.dissolved_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_dissolved',
      'dissolved_at', v_group.dissolved_at
    );
  END IF;

  v_now := pg_catalog.clock_timestamp();
  v_previous_path := pg_catalog.current_setting(
    'arena.group_dissolution_path',
    true
  );
  PERFORM pg_catalog.set_config(
    'arena.group_dissolution_path',
    'dissolve_group_atomic',
    true
  );

  UPDATE public.groups AS target_group
  SET dissolved_at = v_now,
      updated_at = v_now
  WHERE target_group.id = p_group_id
    AND target_group.dissolved_at IS NULL;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'group dissolution state changed unexpectedly';
  END IF;

  PERFORM pg_catalog.set_config(
    'arena.group_dissolution_path',
    COALESCE(v_previous_path, ''),
    true
  );

  v_audit_id := pg_catalog.gen_random_uuid();
  INSERT INTO public.group_audit_log (
    id,
    group_id,
    actor_id,
    action,
    target_id,
    details,
    created_at
  ) VALUES (
    v_audit_id,
    p_group_id,
    p_actor_id,
    'dissolve',
    p_group_id,
    pg_catalog.jsonb_build_object(
      'group_name', v_group.name,
      'dissolved_at', v_now
    ),
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'dissolved',
    'dissolved_at', v_now,
    'audit_log_id', v_audit_id
  );
END
$function$;

ALTER FUNCTION public.dissolve_group_atomic(uuid, uuid) OWNER TO postgres;

-- Drop every legacy trigger wired to the guard before installing one canonical
-- last-running edge alongside the current profile-edit guard.
DO $replace_guard_trigger$
DECLARE
  v_trigger record;
  v_guard pg_catalog.regprocedure :=
    'public.enforce_group_dissolution_write()'::pg_catalog.regprocedure;
BEGIN
  FOR v_trigger IN
    SELECT trigger_row.tgname
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.groups'::pg_catalog.regclass
      AND trigger_row.tgfoid = v_guard
      AND NOT trigger_row.tgisinternal
  LOOP
    EXECUTE pg_catalog.format(
      'DROP TRIGGER %I ON public.groups',
      v_trigger.tgname
    );
  END LOOP;
END
$replace_guard_trigger$;

CREATE TRIGGER trg_groups_99_guard_dissolution
  BEFORE INSERT OR UPDATE OF dissolved_at ON public.groups
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_group_dissolution_write();

DO $converge_function_acls$
DECLARE
  v_signature pg_catalog.regprocedure;
  v_function_owner oid;
  v_grantee record;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.enforce_group_dissolution_write()'::pg_catalog.regprocedure,
    'public.dissolve_group_atomic(uuid,uuid)'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT function_row.proowner
    INTO STRICT v_function_owner
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_signature;

    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee, role_row.rolname
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_entry
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.oid = acl_entry.grantee
      WHERE function_row.oid = v_signature
        AND acl_entry.grantee <> v_function_owner
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE',
          v_signature
        );
      ELSIF v_grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
          v_signature,
          v_grantee.rolname
        );
      END IF;
    END LOOP;
  END LOOP;

  GRANT EXECUTE ON FUNCTION public.dissolve_group_atomic(uuid, uuid)
    TO service_role;
END
$converge_function_acls$;

COMMENT ON FUNCTION public.dissolve_group_atomic(uuid, uuid) IS
  'Irreversibly dissolves one owner-controlled group and appends its audit evidence in the same locked transaction.';

DO $postflight$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_anon_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'anon'
  );
  v_authenticated_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticated'
  );
  v_service_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_authenticator_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticator'
  );
  v_guard pg_catalog.regprocedure :=
    'public.enforce_group_dissolution_write()'::pg_catalog.regprocedure;
  v_dissolve pg_catalog.regprocedure :=
    'public.dissolve_group_atomic(uuid,uuid)'::pg_catalog.regprocedure;
  v_dissolved_attnum smallint;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_guard
      AND function_row.proowner = v_postgres_oid
      AND function_row.prorettype = 'trigger'::pg_catalog.regtype
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND function_row.prokind = 'f'
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid = v_guard
      AND acl_entry.privilege_type = 'EXECUTE'
      AND acl_entry.grantee <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION 'group dissolution guard security contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_dissolve
      AND function_row.proowner = v_postgres_oid
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND function_row.prokind = 'f'
      AND function_row.pronargs = 2
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid = v_dissolve
      AND acl_entry.privilege_type = 'EXECUTE'
      AND acl_entry.grantee = v_service_oid
      AND acl_entry.grantor = v_postgres_oid
      AND NOT acl_entry.is_grantable
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid = v_dissolve
      AND acl_entry.privilege_type = 'EXECUTE'
      AND acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
  ) THEN
    RAISE EXCEPTION 'atomic group dissolution function security contract drifted';
  END IF;

  SELECT attribute.attnum
  INTO STRICT v_dissolved_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.groups'::pg_catalog.regclass
    AND attribute.attname = 'dissolved_at'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.groups'::pg_catalog.regclass
      AND trigger_row.tgfoid = v_guard
      AND NOT trigger_row.tgisinternal
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.groups'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_groups_99_guard_dissolution'
      AND trigger_row.tgfoid = v_guard
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 23
      AND trigger_row.tgqual IS NULL
      AND (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.unnest(trigger_row.tgattr::smallint[]) AS trigger_column(attnum)
      ) = 1
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(trigger_row.tgattr::smallint[]) AS trigger_column(attnum)
        WHERE trigger_column.attnum <> v_dissolved_attnum
      )
  ) THEN
    RAISE EXCEPTION 'canonical group dissolution trigger contract drifted';
  END IF;

  IF EXISTS (
    WITH expected(grantee, privilege_type) AS (
      VALUES
        (v_anon_oid, 'SELECT'::text),
        (v_authenticated_oid, 'SELECT'::text),
        (v_service_oid, 'SELECT'::text),
        (v_service_oid, 'INSERT'::text)
    ),
    actual AS (
      SELECT acl_entry.grantee, acl_entry.privilege_type
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      WHERE relation.oid = 'public.groups'::pg_catalog.regclass
        AND acl_entry.grantee <> relation.relowner
    )
    SELECT 1
    FROM expected
    FULL JOIN actual USING (grantee, privilege_type)
    WHERE expected.grantee IS NULL OR actual.grantee IS NULL
  ) THEN
    RAISE EXCEPTION 'group dissolution table ACL did not converge exactly';
  END IF;

  IF EXISTS (
    WITH expected(column_name, grantee, privilege_type) AS (
      SELECT
        attribute.attname,
        v_service_oid,
        'UPDATE'::text
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = 'public.groups'::pg_catalog.regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND attribute.attname <> 'dissolved_at'
    ),
    actual(column_name, grantee, privilege_type) AS (
      SELECT
        attribute.attname,
        acl_entry.grantee,
        acl_entry.privilege_type
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid = 'public.groups'::pg_catalog.regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee <> v_postgres_oid
    )
    SELECT 1
    FROM expected
    FULL JOIN actual USING (column_name, grantee, privilege_type)
    WHERE expected.column_name IS NULL OR actual.column_name IS NULL
  ) THEN
    RAISE EXCEPTION 'group dissolution column ACL did not converge exactly';
  END IF;

  IF pg_catalog.has_column_privilege(
    'service_role',
    'public.groups',
    'dissolved_at',
    'UPDATE'
  ) OR pg_catalog.has_table_privilege(
    'service_role',
    'public.groups',
    'DELETE'
  ) OR pg_catalog.has_table_privilege(
    'anon',
    'public.groups',
    'INSERT,UPDATE,DELETE'
  ) OR pg_catalog.has_table_privilege(
    'authenticated',
    'public.groups',
    'INSERT,UPDATE,DELETE'
  ) THEN
    RAISE EXCEPTION 'group dissolution mutation boundary remains directly writable';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.groups'::pg_catalog.regclass
  ) <> 2 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.groups'::pg_catalog.regclass
      AND policy.polname = 'browser_read'
      AND policy.polpermissive
      AND policy.polcmd = 'r'
      AND (
        SELECT pg_catalog.array_agg(role_oid ORDER BY role_oid)
        FROM pg_catalog.unnest(policy.polroles) AS role_oid
      ) = ARRAY[
        LEAST(v_anon_oid, v_authenticated_oid),
        GREATEST(v_anon_oid, v_authenticated_oid)
      ]::oid[]
      AND pg_catalog.pg_get_expr(
        policy.polqual,
        policy.polrelid,
        true
      ) = 'true'
      AND policy.polwithcheck IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.groups'::pg_catalog.regclass
      AND policy.polname = 'server_role_mutation'
      AND policy.polpermissive
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[v_service_oid]::oid[]
      AND pg_catalog.pg_get_expr(
        policy.polqual,
        policy.polrelid,
        true
      ) = 'true'
      AND pg_catalog.pg_get_expr(
        policy.polwithcheck,
        policy.polrelid,
        true
      ) = 'true'
  ) THEN
    RAISE EXCEPTION 'group dissolution RLS policy contract drifted';
  END IF;

  -- Re-attest the complete role graph after all migration writes.  The same
  -- fail-closed contract runs in preflight so a concurrent GRANT cannot land
  -- during the DDL window without being detected before commit.
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
    WITH RECURSIVE browser_authority(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_roles AS browser_role
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = browser_role.oid
       AND (membership.inherit_option OR membership.set_option)
      WHERE browser_role.rolname IN ('anon', 'authenticated')
      UNION
      SELECT membership.roleid
      FROM browser_authority AS inherited
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = inherited.role_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1
    FROM browser_authority AS inherited
    WHERE inherited.role_oid IN (v_service_oid, v_postgres_oid)
  ) THEN
    RAISE EXCEPTION 'service_role has an unsafe effective authority edge';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
