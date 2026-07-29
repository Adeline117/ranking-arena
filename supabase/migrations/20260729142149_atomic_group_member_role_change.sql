-- Migration: 20260729142149_atomic_group_member_role_change.sql
-- Created: 2026-07-29T21:21:49Z
-- Description: Authorize an owner and update a non-owner group membership role
--   in one transaction, with exact audit evidence and membership-edge locks.
--
-- Forward compensation: roll API callers back before dropping this RPC. This
-- migration changes no membership data. Use a forward DROP FUNCTION migration
-- to retire the boundary; reserve PITR for data recovery.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.group_members:atomic-role-change:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic group member-role migration lock is busy';
  END IF;
END
$migration_lock$;

DO $preflight$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_missing_roles text[];
  v_invalid_columns text[];
  v_serializer regprocedure := pg_catalog.to_regprocedure(
    'public.serialize_group_membership_edge()'
  );
  v_serializer_source text;
  v_moderation_function regprocedure := pg_catalog.to_regprocedure(
    'public.moderate_group_member_atomic(uuid,uuid,uuid,text,text)'
  );
  v_moderation_source text;
  v_role_function regprocedure := pg_catalog.to_regprocedure(
    'public.set_group_member_role_atomic(uuid,uuid,uuid,text)'
  );
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['anon', 'authenticated', 'service_role', 'postgres']::text[]
  ) AS required_role
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = required_role
  );

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'group member-role roles are missing: %', v_missing_roles;
  END IF;

  IF pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.groups') IS NULL
     OR pg_catalog.to_regclass('public.group_members') IS NULL
     OR pg_catalog.to_regclass('public.group_audit_log') IS NULL
     OR pg_catalog.to_regtype('public.member_role') IS NULL
  THEN
    RAISE EXCEPTION 'canonical group member-role objects must deploy first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.groups'::regclass,
      'public.group_members'::regclass,
      'public.group_audit_log'::regclass
    )
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.user_profiles'::regclass,
      'public.groups'::regclass,
      'public.group_members'::regclass,
      'public.group_audit_log'::regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION
      'group member-role change requires canonical permanent relation ownership';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.groups'::regclass,
      'public.group_members'::regclass,
      'public.group_audit_log'::regclass
    )
       OR inheritance.inhparent IN (
         'auth.users'::regclass,
         'public.user_profiles'::regclass,
         'public.groups'::regclass,
         'public.group_members'::regclass,
         'public.group_audit_log'::regclass
       )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.groups'::regclass,
      'public.group_members'::regclass,
      'public.group_audit_log'::regclass
    )
  ) THEN
    RAISE EXCEPTION
      'group member-role relations must not use inheritance or rewrite rules';
  END IF;

  SELECT pg_catalog.array_agg(
    pg_catalog.format(
      '%I.%I.%I expected %s%s',
      required_column.schema_name,
      required_column.relation_name,
      required_column.column_name,
      required_column.type_oid::regtype,
      CASE WHEN required_column.required_not_null THEN ' NOT NULL' ELSE '' END
    )
    ORDER BY required_column.schema_name,
      required_column.relation_name,
      required_column.ordinality
  )
  INTO v_invalid_columns
  FROM (
    VALUES
      ('auth', 'users', 1, 'id', 'uuid'::regtype, true),
      ('public', 'user_profiles', 1, 'id', 'uuid'::regtype, true),
      ('public', 'user_profiles', 2, 'deleted_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 3, 'banned_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 4, 'is_banned', 'boolean'::regtype, false),
      ('public', 'user_profiles', 5, 'ban_expires_at', 'timestamptz'::regtype, false),
      ('public', 'groups', 1, 'id', 'uuid'::regtype, true),
      ('public', 'groups', 2, 'created_by', 'uuid'::regtype, true),
      ('public', 'groups', 3, 'dissolved_at', 'timestamptz'::regtype, false),
      ('public', 'group_members', 1, 'group_id', 'uuid'::regtype, true),
      ('public', 'group_members', 2, 'user_id', 'uuid'::regtype, true),
      (
        'public', 'group_members', 3, 'role',
        'public.member_role'::regtype, true
      ),
      ('public', 'group_audit_log', 1, 'id', 'uuid'::regtype, true),
      ('public', 'group_audit_log', 2, 'group_id', 'uuid'::regtype, false),
      ('public', 'group_audit_log', 3, 'actor_id', 'uuid'::regtype, false),
      ('public', 'group_audit_log', 4, 'action', 'text'::regtype, true),
      ('public', 'group_audit_log', 5, 'target_id', 'uuid'::regtype, false),
      ('public', 'group_audit_log', 6, 'details', 'jsonb'::regtype, false),
      ('public', 'group_audit_log', 7, 'created_at', 'timestamptz'::regtype, false)
  ) AS required_column(
    schema_name,
    relation_name,
    ordinality,
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
  WHERE attribute.attname IS NULL
     OR attribute.atttypid <> required_column.type_oid
     OR (required_column.required_not_null AND NOT attribute.attnotnull);

  IF v_invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION 'group member-role change has incompatible columns: %', v_invalid_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_enum AS enum_value
    WHERE enum_value.enumtypid = 'public.member_role'::regtype
    GROUP BY enum_value.enumtypid
    HAVING pg_catalog.array_agg(
      enum_value.enumlabel::text ORDER BY enum_value.enumsortorder
    ) = ARRAY['owner', 'admin', 'member']::text[]
  ) THEN
    RAISE EXCEPTION 'member_role enum contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.group_members'::regclass
      AND constraint_row.contype IN ('p', 'u')
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.group_members'::regclass
            AND attribute.attname = 'group_id'
        ),
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.group_members'::regclass
            AND attribute.attname = 'user_id'
        )
      ]::smallint[]
  ) THEN
    RAISE EXCEPTION 'group_members requires UNIQUE (group_id, user_id)';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL OR (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure('auth.role()')
  ) <> 'text'::regtype THEN
    RAISE EXCEPTION 'auth.role() returning text must exist';
  END IF;

  IF v_serializer IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_serializer
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'trigger'::regtype
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
  ) THEN
    RAISE EXCEPTION 'group membership edge serializer must deploy first';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_serializer_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_serializer;

  IF pg_catalog.strpos(v_serializer_source, $$'group-membership:'$$) = 0
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'public.group_members'::regclass
         AND trigger_row.tgname = 'trg_group_members_05_serialize_edge'
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         AND trigger_row.tgfoid = v_serializer
     )
  THEN
    RAISE EXCEPTION 'group membership edge serializer contract drifted';
  END IF;

  IF v_moderation_function IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_moderation_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::regtype
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
  ) THEN
    RAISE EXCEPTION 'atomic group moderation authority must deploy first';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_moderation_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_moderation_function;

  IF pg_catalog.strpos(v_moderation_source, $$'group-membership:'$$) = 0
     OR pg_catalog.strpos(v_moderation_source, 'FROM public.user_profiles') = 0
     OR pg_catalog.strpos(v_moderation_source, 'FROM public.groups') = 0
     OR pg_catalog.strpos(v_moderation_source, 'FROM public.group_members') = 0
  THEN
    RAISE EXCEPTION 'atomic group moderation lock contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'set_group_member_role_atomic'
      AND function_row.oid IS DISTINCT FROM v_role_function
  ) THEN
    RAISE EXCEPTION 'incompatible set_group_member_role_atomic overload exists';
  END IF;

  IF v_role_function IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_role_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 4
  ) THEN
    RAISE EXCEPTION 'existing set_group_member_role_atomic signature is incompatible';
  END IF;

  IF pg_catalog.has_table_privilege(
    'anon', 'public.group_members', 'UPDATE'
  ) OR pg_catalog.has_table_privilege(
    'authenticated', 'public.group_members', 'UPDATE'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.group_members', 'SELECT'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.group_members', 'UPDATE'
  ) THEN
    RAISE EXCEPTION 'group member-role service-only write boundary drifted';
  END IF;
END
$preflight$;

LOCK TABLE auth.users,
  public.user_profiles,
  public.groups,
  public.group_members,
  public.group_audit_log
  IN SHARE MODE;

CREATE OR REPLACE FUNCTION public.set_group_member_role_atomic(
  p_actor_id uuid,
  p_group_id uuid,
  p_target_id uuid,
  p_role text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_auth_ids uuid[] := ARRAY[]::uuid[];
  v_locked_auth_ids uuid[] := ARRAY[]::uuid[];
  v_first_edge text;
  v_second_edge text;
  v_profile record;
  v_actor_active boolean := false;
  v_target_active boolean := false;
  v_group public.groups%ROWTYPE;
  v_group_found boolean := false;
  v_member record;
  v_actor_role text;
  v_target_role text;
  v_changed_count integer := 0;
  v_audit_id uuid;
  v_now timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_actor_id IS NULL
     OR p_group_id IS NULL
     OR p_target_id IS NULL
     OR p_actor_id = p_target_id
     OR p_role IS NULL
     OR p_role NOT IN ('admin', 'member')
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  v_auth_ids := ARRAY[
    LEAST(p_actor_id, p_target_id),
    GREATEST(p_actor_id, p_target_id)
  ]::uuid[];

  -- Auth parents are locked before membership edges so an account-deletion
  -- cascade that already owns an Auth row can finish its membership trigger
  -- without waiting behind this role change.
  FOR v_member IN
    SELECT auth_user.id
    FROM auth.users AS auth_user
    WHERE auth_user.id = ANY(v_auth_ids)
    ORDER BY auth_user.id
    FOR SHARE
  LOOP
    v_locked_auth_ids := pg_catalog.array_append(v_locked_auth_ids, v_member.id);
  END LOOP;

  IF NOT p_actor_id = ANY(v_locked_auth_ids) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;
  IF NOT p_target_id = ANY(v_locked_auth_ids) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'TARGET_UNAVAILABLE'
    );
  END IF;

  v_first_edge := 'group-membership:' || p_group_id::text || ':'
    || LEAST(p_actor_id::text, p_target_id::text);
  v_second_edge := 'group-membership:' || p_group_id::text || ':'
    || GREATEST(p_actor_id::text, p_target_id::text);

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_first_edge, 0)
  );
  IF v_second_edge <> v_first_edge THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_second_edge, 0)
    );
  END IF;

  FOR v_profile IN
    SELECT profile.*
    FROM public.user_profiles AS profile
    WHERE profile.id = ANY(v_auth_ids)
    ORDER BY profile.id
    FOR UPDATE
  LOOP
    IF v_profile.deleted_at IS NULL
       AND v_profile.banned_at IS NULL
       AND NOT (
         v_profile.is_banned IS TRUE
         AND (
           v_profile.ban_expires_at IS NULL
           OR v_profile.ban_expires_at > pg_catalog.statement_timestamp()
         )
       )
    THEN
      IF v_profile.id = p_actor_id THEN
        v_actor_active := true;
      END IF;
      IF v_profile.id = p_target_id THEN
        v_target_active := true;
      END IF;
    END IF;
  END LOOP;

  IF NOT v_actor_active THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;
  IF NOT v_target_active THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'TARGET_UNAVAILABLE'
    );
  END IF;

  SELECT target_group.*
  INTO v_group
  FROM public.groups AS target_group
  WHERE target_group.id = p_group_id
  FOR UPDATE;
  v_group_found := FOUND;

  IF NOT v_group_found THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'GROUP_NOT_FOUND'
    );
  END IF;
  IF v_group.dissolved_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'GROUP_DISSOLVED'
    );
  END IF;

  FOR v_member IN
    SELECT member.user_id, member.role::text AS role
    FROM public.group_members AS member
    WHERE member.group_id = p_group_id
      AND member.user_id = ANY(v_auth_ids)
    ORDER BY member.user_id
    FOR UPDATE
  LOOP
    IF v_member.user_id = p_actor_id THEN
      v_actor_role := v_member.role;
    END IF;
    IF v_member.user_id = p_target_id THEN
      v_target_role := v_member.role;
    END IF;
  END LOOP;

  IF v_actor_role IS DISTINCT FROM 'owner'
     OR v_group.created_by IS DISTINCT FROM p_actor_id
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'PERMISSION_DENIED'
    );
  END IF;

  IF v_target_role IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'TARGET_NOT_MEMBER'
    );
  END IF;

  IF v_target_role = 'owner'
     OR v_group.created_by = p_target_id
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'OWNER_FORBIDDEN'
    );
  END IF;

  IF v_target_role = p_role THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'actor_id', p_actor_id,
      'group_id', p_group_id,
      'target_id', p_target_id,
      'previous_role', v_target_role,
      'role', p_role,
      'changed', false,
      'audit_id', NULL
    );
  END IF;

  UPDATE public.group_members AS member
  SET role = p_role::public.member_role
  WHERE member.group_id = p_group_id
    AND member.user_id = p_target_id
    AND member.role::text = v_target_role;
  GET DIAGNOSTICS v_changed_count = ROW_COUNT;

  IF v_changed_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'group member role changed concurrently; retry';
  END IF;

  v_audit_id := pg_catalog.gen_random_uuid();
  v_now := pg_catalog.clock_timestamp();
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
    CASE WHEN p_role = 'admin' THEN 'promote' ELSE 'demote' END,
    p_target_id,
    pg_catalog.jsonb_build_object(
      'old_role', v_target_role,
      'new_role', p_role
    ),
    v_now
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.group_audit_log AS audit_row
    WHERE audit_row.id = v_audit_id
      AND audit_row.group_id = p_group_id
      AND audit_row.actor_id = p_actor_id
      AND audit_row.target_id = p_target_id
      AND audit_row.action = CASE
        WHEN p_role = 'admin' THEN 'promote'
        ELSE 'demote'
      END
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'group member-role audit acknowledgement is incomplete';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'actor_id', p_actor_id,
    'group_id', p_group_id,
    'target_id', p_target_id,
    'previous_role', v_target_role,
    'role', p_role,
    'changed', true,
    'audit_id', v_audit_id
  );
END
$function$;

ALTER FUNCTION public.set_group_member_role_atomic(
  uuid, uuid, uuid, text
) OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.set_group_member_role_atomic(uuid,uuid,uuid,text)'::regprocedure;
  v_owner oid;
  v_grantee record;
  v_source text;
BEGIN
  SELECT function_row.proowner, function_row.prosrc
  INTO STRICT v_owner, v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

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
    WHERE function_row.oid = v_function
      AND acl_entry.grantee <> v_owner
  LOOP
    IF v_grantee.grantee = 0 THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC',
        v_function
      );
    ELSIF v_grantee.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I',
        v_function,
        v_grantee.rolname
      );
    END IF;
  END LOOP;

  REVOKE ALL PRIVILEGES
    ON FUNCTION public.set_group_member_role_atomic(uuid, uuid, uuid, text)
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.set_group_member_role_atomic(uuid, uuid, uuid, text)
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-group-member-role-change:v1:' || pg_catalog.md5(v_source)
  );
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.set_group_member_role_atomic(uuid,uuid,uuid,text)'::regprocedure;
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
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function
    AND function_row.prokind = 'f'
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prorettype = 'jsonb'::regtype
    AND NOT function_row.proretset
    AND function_row.pronargs = 4
    AND function_row.pronargdefaults = 0
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF pg_catalog.obj_description(v_function, 'pg_proc') IS DISTINCT FROM
       'atomic-group-member-role-change:v1:' || pg_catalog.md5(v_source)
     OR pg_catalog.strpos(v_source, 'FROM auth.users') = 0
     OR pg_catalog.strpos(v_source, $$'group-membership:'$$) = 0
     OR pg_catalog.strpos(v_source, 'FROM public.user_profiles') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.groups') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.group_members') = 0
     OR pg_catalog.strpos(v_source, 'UPDATE public.group_members') = 0
     OR pg_catalog.strpos(v_source, 'INSERT INTO public.group_audit_log') = 0
  THEN
    RAISE EXCEPTION 'atomic group member-role body attestation failed';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    'service_role', v_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', v_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_function, 'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid = v_function
      AND acl_entry.grantee <> function_row.proowner
      AND NOT (
        acl_entry.grantee = v_service_oid
        AND acl_entry.privilege_type = 'EXECUTE'
        AND NOT acl_entry.is_grantable
      )
  ) THEN
    RAISE EXCEPTION 'atomic group member-role ACL attestation failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
