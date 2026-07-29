-- Migration: 20260729153000_atomic_group_audit_log_page.sql
-- Created: 2026-07-29T22:30:00Z
-- Description: Authorize a current active group owner/admin and return one
--   bounded audit-log page from the same transaction. Membership, group, and
--   account row locks keep evidence private across concurrent revocation.
--
-- Forward compensation: roll API callers back before dropping this RPC. This
-- boundary is read-only; use a forward DROP FUNCTION migration to retire it.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.group_audit_log:atomic-page:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic group audit-log page migration lock is busy';
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
  v_page_function regprocedure := pg_catalog.to_regprocedure(
    'public.get_group_audit_log_page_atomic(uuid,uuid,timestamptz,uuid,integer)'
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
    RAISE EXCEPTION 'group audit-log page roles are missing: %', v_missing_roles;
  END IF;

  IF pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.groups') IS NULL
     OR pg_catalog.to_regclass('public.group_members') IS NULL
     OR pg_catalog.to_regclass('public.group_audit_log') IS NULL
     OR pg_catalog.to_regtype('public.member_role') IS NULL
  THEN
    RAISE EXCEPTION 'canonical group audit-log relations must deploy first';
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
      'group audit-log page requires canonical permanent relation ownership';
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
      AND rewrite_rule.rulename <> '_RETURN'
  ) THEN
    RAISE EXCEPTION
      'group audit-log page relations must not use inheritance or rewrite rules';
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
      ('public', 'groups', 2, 'dissolved_at', 'timestamptz'::regtype, false),
      ('public', 'group_members', 1, 'group_id', 'uuid'::regtype, true),
      ('public', 'group_members', 2, 'user_id', 'uuid'::regtype, true),
      ('public', 'group_audit_log', 1, 'id', 'uuid'::regtype, true),
      ('public', 'group_audit_log', 2, 'group_id', 'uuid'::regtype, false),
      ('public', 'group_audit_log', 3, 'actor_id', 'uuid'::regtype, false),
      ('public', 'group_audit_log', 4, 'action', 'text'::regtype, true),
      ('public', 'group_audit_log', 5, 'target_id', 'uuid'::regtype, false),
      ('public', 'group_audit_log', 6, 'created_at', 'timestamptz'::regtype, false)
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
    RAISE EXCEPTION
      'group audit-log page has incompatible columns: %',
      v_invalid_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.group_members'::regclass
      AND attribute.attname = 'role'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attnotnull
      AND attribute.atttypid = 'public.member_role'::regtype
  ) THEN
    RAISE EXCEPTION 'group_members.role contract drifted';
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

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'get_group_audit_log_page_atomic'
      AND function_row.oid IS DISTINCT FROM v_page_function
  ) THEN
    RAISE EXCEPTION
      'incompatible get_group_audit_log_page_atomic overload exists';
  END IF;

  IF v_page_function IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_page_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 5
      AND function_row.pronargdefaults = 0
  ) THEN
    RAISE EXCEPTION
      'existing get_group_audit_log_page_atomic signature is incompatible';
  END IF;
END
$preflight$;

LOCK TABLE auth.users,
  public.user_profiles,
  public.groups,
  public.group_members,
  public.group_audit_log
  IN SHARE MODE;

CREATE OR REPLACE FUNCTION public.get_group_audit_log_page_atomic(
  p_actor_id uuid,
  p_group_id uuid,
  p_before_created_at timestamptz,
  p_before_id uuid,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_profile public.user_profiles%ROWTYPE;
  v_group public.groups%ROWTYPE;
  v_actor_role text;
  v_profile_found boolean := false;
  v_group_found boolean := false;
  v_membership_found boolean := false;
  v_logs jsonb := '[]'::jsonb;
  v_has_more boolean := false;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_actor_id IS NULL
     OR p_group_id IS NULL
     OR p_limit IS NULL
     OR p_limit NOT BETWEEN 1 AND 100
     OR (p_before_created_at IS NULL) <> (p_before_id IS NULL)
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  -- Lock identity parents first so account deletion cannot commit and cascade
  -- the viewer's membership while this private evidence page is being read.
  PERFORM auth_user.id
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_actor_id
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;

  SELECT profile.*
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
  FOR SHARE;
  v_profile_found := FOUND;

  IF NOT v_profile_found
     OR v_profile.deleted_at IS NOT NULL
     OR v_profile.banned_at IS NOT NULL
     OR (
       v_profile.is_banned IS TRUE
       AND (
         v_profile.ban_expires_at IS NULL
         OR v_profile.ban_expires_at > pg_catalog.statement_timestamp()
       )
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;

  SELECT target_group.*
  INTO v_group
  FROM public.groups AS target_group
  WHERE target_group.id = p_group_id
  FOR SHARE;
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

  -- The lock is held through the evidence query. Any role change or removal
  -- therefore completes wholly before or wholly after this page is authorized.
  SELECT member.role::text
  INTO v_actor_role
  FROM public.group_members AS member
  WHERE member.group_id = p_group_id
    AND member.user_id = p_actor_id
  FOR SHARE;
  v_membership_found := FOUND;

  IF NOT v_membership_found OR v_actor_role NOT IN ('owner', 'admin') THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'PERMISSION_DENIED'
    );
  END IF;

  WITH newest AS (
    SELECT
      audit_row.id,
      audit_row.action,
      audit_row.actor_id,
      audit_row.target_id,
      audit_row.created_at
    FROM public.group_audit_log AS audit_row
    WHERE audit_row.group_id = p_group_id
      AND audit_row.created_at IS NOT NULL
      AND (
        p_before_created_at IS NULL
        OR audit_row.created_at < p_before_created_at
        OR (
          audit_row.created_at = p_before_created_at
          AND audit_row.id < p_before_id
        )
      )
    ORDER BY audit_row.created_at DESC, audit_row.id DESC
    LIMIT p_limit + 1
  ),
  numbered AS (
    SELECT
      newest.*,
      pg_catalog.row_number() OVER (
        ORDER BY newest.created_at DESC, newest.id DESC
      ) AS page_position
    FROM newest
  )
  SELECT
    pg_catalog.count(*) > p_limit,
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', numbered.id,
          'action', numbered.action,
          'actor_id', numbered.actor_id,
          'target_id', numbered.target_id,
          'created_at', numbered.created_at
        )
        ORDER BY numbered.created_at DESC, numbered.id DESC
      ) FILTER (WHERE numbered.page_position <= p_limit),
      '[]'::jsonb
    )
  INTO STRICT v_has_more, v_logs
  FROM numbered;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'actor_id', p_actor_id,
    'group_id', p_group_id,
    'logs', v_logs,
    'has_more', v_has_more
  );
END
$function$;

ALTER FUNCTION public.get_group_audit_log_page_atomic(
  uuid, uuid, timestamptz, uuid, integer
) OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.get_group_audit_log_page_atomic(uuid,uuid,timestamptz,uuid,integer)'::regprocedure;
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
    ON FUNCTION public.get_group_audit_log_page_atomic(
      uuid, uuid, timestamptz, uuid, integer
    )
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.get_group_audit_log_page_atomic(
      uuid, uuid, timestamptz, uuid, integer
    )
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-group-audit-log-page:v1:' || pg_catalog.md5(v_source)
  );
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.get_group_audit_log_page_atomic(uuid,uuid,timestamptz,uuid,integer)'::regprocedure;
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
    AND function_row.pronargs = 5
    AND function_row.pronargdefaults = 0
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF pg_catalog.obj_description(v_function, 'pg_proc') IS DISTINCT FROM
       'atomic-group-audit-log-page:v1:' || pg_catalog.md5(v_source)
     OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.groups AS target_group') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.group_members AS member') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.group_audit_log AS audit_row') = 0
     OR pg_catalog.strpos(v_source, 'FOR SHARE') = 0
  THEN
    RAISE EXCEPTION 'atomic group audit-log page body attestation failed';
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
    RAISE EXCEPTION 'atomic group audit-log page ACL attestation failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
