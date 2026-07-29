-- Migration: 20260729150500_atomic_group_post_moderation.sql
-- Created: 2026-07-29T22:05:00Z
-- Description: Bind current group-manager authority, post ownership by the
--   requested group, soft deletion, and audit evidence in one transaction.
--
-- Forward compensation: roll API callers back before dropping this RPC. This
-- migration changes no post data. A committed moderation can be compensated by
-- a reviewed forward restore because posts are soft-deleted.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.posts:atomic-group-moderation:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic group post moderation migration lock is busy';
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
  v_role_authority regprocedure := pg_catalog.to_regprocedure(
    'public.set_group_member_role_atomic(uuid,uuid,uuid,text)'
  );
  v_role_source text;
  v_group_comment_authority regprocedure := pg_catalog.to_regprocedure(
    'public.moderate_group_comment_atomic(uuid,uuid,uuid,text)'
  );
  v_group_comment_source text;
  v_group_post_authority regprocedure := pg_catalog.to_regprocedure(
    'public.moderate_group_post_atomic(uuid,uuid,uuid,text)'
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
    RAISE EXCEPTION 'group post moderation roles are missing: %', v_missing_roles;
  END IF;

  IF pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.posts') IS NULL
     OR pg_catalog.to_regclass('public.groups') IS NULL
     OR pg_catalog.to_regclass('public.group_members') IS NULL
     OR pg_catalog.to_regclass('public.group_audit_log') IS NULL
     OR pg_catalog.to_regtype('public.member_role') IS NULL
  THEN
    RAISE EXCEPTION 'canonical group post moderation objects must deploy first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.posts'::regclass,
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
      'public.posts'::regclass,
      'public.groups'::regclass,
      'public.group_members'::regclass,
      'public.group_audit_log'::regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION
      'group post moderation requires canonical permanent relation ownership';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.posts'::regclass,
      'public.groups'::regclass,
      'public.group_members'::regclass,
      'public.group_audit_log'::regclass
    )
       OR inheritance.inhparent IN (
         'auth.users'::regclass,
         'public.user_profiles'::regclass,
         'public.posts'::regclass,
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
      'public.posts'::regclass,
      'public.groups'::regclass,
      'public.group_members'::regclass,
      'public.group_audit_log'::regclass
    )
  ) THEN
    RAISE EXCEPTION
      'group post moderation relations must not use inheritance or rewrite rules';
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
      ('public', 'posts', 1, 'id', 'uuid'::regtype, true),
      ('public', 'posts', 2, 'group_id', 'uuid'::regtype, false),
      ('public', 'posts', 3, 'author_id', 'uuid'::regtype, false),
      ('public', 'posts', 4, 'title', 'text'::regtype, false),
      ('public', 'posts', 5, 'deleted_at', 'timestamptz'::regtype, false),
      ('public', 'posts', 6, 'deleted_by', 'uuid'::regtype, false),
      ('public', 'posts', 7, 'delete_reason', 'text'::regtype, false),
      ('public', 'groups', 1, 'id', 'uuid'::regtype, true),
      ('public', 'groups', 2, 'dissolved_at', 'timestamptz'::regtype, false),
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
    RAISE EXCEPTION
      'group post moderation has incompatible columns: %',
      v_invalid_columns;
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

  IF v_role_authority IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_role_authority
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::regtype
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
  ) THEN
    RAISE EXCEPTION 'atomic group role authority must deploy first';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_role_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_role_authority;

  IF pg_catalog.strpos(v_role_source, 'FROM auth.users') = 0
     OR pg_catalog.strpos(v_role_source, $$'group-membership:'$$) = 0
     OR pg_catalog.strpos(v_role_source, 'FROM public.user_profiles') = 0
     OR pg_catalog.strpos(v_role_source, 'FROM public.groups') = 0
     OR pg_catalog.strpos(v_role_source, 'FROM public.group_members') = 0
  THEN
    RAISE EXCEPTION 'atomic group role lock contract drifted';
  END IF;

  IF v_group_comment_authority IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_group_comment_authority
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::regtype
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
  ) THEN
    RAISE EXCEPTION 'atomic group comment authority must deploy first';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_group_comment_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_group_comment_authority;

  IF pg_catalog.strpos(v_group_comment_source, 'FROM public.posts') = 0
     OR pg_catalog.strpos(v_group_comment_source, 'FROM public.groups') = 0
     OR pg_catalog.strpos(v_group_comment_source, 'FROM public.group_members') = 0
     OR pg_catalog.strpos(v_group_comment_source, 'FOR UPDATE') = 0
  THEN
    RAISE EXCEPTION 'atomic group content lock contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'moderate_group_post_atomic'
      AND function_row.oid IS DISTINCT FROM v_group_post_authority
  ) THEN
    RAISE EXCEPTION 'incompatible moderate_group_post_atomic overload exists';
  END IF;

  IF v_group_post_authority IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_group_post_authority
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 4
  ) THEN
    RAISE EXCEPTION 'existing moderate_group_post_atomic signature is incompatible';
  END IF;
END
$preflight$;

LOCK TABLE auth.users,
  public.user_profiles,
  public.posts,
  public.groups,
  public.group_members,
  public.group_audit_log
  IN SHARE MODE;

CREATE OR REPLACE FUNCTION public.moderate_group_post_atomic(
  p_actor_id uuid,
  p_group_id uuid,
  p_post_id uuid,
  p_reason text
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
  v_post public.posts%ROWTYPE;
  v_post_found boolean := false;
  v_group public.groups%ROWTYPE;
  v_group_found boolean := false;
  v_actor_role text;
  v_actor_is_member boolean := false;
  v_affected_count integer := 0;
  v_audit_id uuid;
  v_now timestamptz;
  v_normalized_reason text := NULLIF(pg_catalog.btrim(COALESCE(p_reason, '')), '');
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_actor_id IS NULL
     OR p_group_id IS NULL
     OR p_post_id IS NULL
     OR v_normalized_reason IS NULL
     OR pg_catalog.char_length(COALESCE(p_reason, '')) > 500
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

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

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-membership:' || p_group_id::text || ':' || p_actor_id::text,
      0
    )
  );

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
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;

  -- Every group content transaction takes post -> group -> membership after
  -- the actor edge/profile locks. Post interaction readers take a shared post
  -- lock, so this exclusive lock also closes reaction-vs-delete races.
  SELECT target_post.*
  INTO v_post
  FROM public.posts AS target_post
  WHERE target_post.id = p_post_id
  FOR UPDATE;
  v_post_found := FOUND;

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

  SELECT member.role::text
  INTO v_actor_role
  FROM public.group_members AS member
  WHERE member.group_id = p_group_id
    AND member.user_id = p_actor_id
  FOR UPDATE;
  v_actor_is_member := FOUND;

  IF NOT v_actor_is_member OR v_actor_role NOT IN ('owner', 'admin') THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'PERMISSION_DENIED'
    );
  END IF;

  IF NOT v_post_found THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'POST_NOT_FOUND'
    );
  END IF;
  IF v_post.group_id IS DISTINCT FROM p_group_id THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'POST_NOT_IN_GROUP'
    );
  END IF;
  IF v_post.deleted_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'POST_ALREADY_DELETED'
    );
  END IF;

  v_now := pg_catalog.clock_timestamp();
  UPDATE public.posts AS moderated_post
  SET deleted_at = v_now,
      deleted_by = p_actor_id,
      delete_reason = v_normalized_reason
  WHERE moderated_post.id = p_post_id
    AND moderated_post.group_id = p_group_id
    AND moderated_post.deleted_at IS NULL;
  GET DIAGNOSTICS v_affected_count = ROW_COUNT;

  IF v_affected_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'active group post soft-delete acknowledgement is invalid';
  END IF;

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
    'delete_post',
    p_post_id,
    pg_catalog.jsonb_build_object(
      'reason', v_normalized_reason,
      'author_id', v_post.author_id,
      'title', v_post.title,
      'deleted_at', v_now
    ),
    v_now
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.posts AS acknowledged_post
    WHERE acknowledged_post.id = p_post_id
      AND acknowledged_post.group_id = p_group_id
      AND acknowledged_post.deleted_at = v_now
      AND acknowledged_post.deleted_by = p_actor_id
      AND acknowledged_post.delete_reason = v_normalized_reason
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.group_audit_log AS audit_row
    WHERE audit_row.id = v_audit_id
      AND audit_row.group_id = p_group_id
      AND audit_row.actor_id = p_actor_id
      AND audit_row.action = 'delete_post'
      AND audit_row.target_id = p_post_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'group post moderation evidence is incomplete';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'actor_id', p_actor_id,
    'audit_id', v_audit_id,
    'author_id', v_post.author_id,
    'deleted_at', v_now,
    'group_id', p_group_id,
    'post_id', p_post_id,
    'title', v_post.title
  );
END
$function$;

ALTER FUNCTION public.moderate_group_post_atomic(
  uuid, uuid, uuid, text
) OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.moderate_group_post_atomic(uuid,uuid,uuid,text)'::regprocedure;
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
    ON FUNCTION public.moderate_group_post_atomic(uuid, uuid, uuid, text)
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.moderate_group_post_atomic(uuid, uuid, uuid, text)
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-group-post-moderation:v1:' || pg_catalog.md5(v_source)
  );
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.moderate_group_post_atomic(uuid,uuid,uuid,text)'::regprocedure;
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
  v_post_position integer;
  v_group_position integer;
  v_member_position integer;
  v_update_position integer;
  v_audit_position integer;
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

  v_post_position := pg_catalog.strpos(v_source, 'FROM public.posts AS target_post');
  v_group_position := pg_catalog.strpos(v_source, 'FROM public.groups AS target_group');
  v_member_position := pg_catalog.strpos(v_source, 'FROM public.group_members AS member');
  v_update_position := pg_catalog.strpos(v_source, 'UPDATE public.posts AS moderated_post');
  v_audit_position := pg_catalog.strpos(v_source, 'INSERT INTO public.group_audit_log');

  IF pg_catalog.obj_description(v_function, 'pg_proc') IS DISTINCT FROM
       'atomic-group-post-moderation:v1:' || pg_catalog.md5(v_source)
     OR pg_catalog.strpos(v_source, 'FROM auth.users') = 0
     OR pg_catalog.strpos(v_source, $$'group-membership:'$$) = 0
     OR pg_catalog.strpos(v_source, 'FROM public.user_profiles') = 0
     OR v_post_position = 0
     OR v_group_position <= v_post_position
     OR v_member_position <= v_group_position
     OR v_update_position <= v_member_position
     OR v_audit_position <= v_update_position
  THEN
    RAISE EXCEPTION 'atomic group post moderation body attestation failed';
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
    RAISE EXCEPTION 'atomic group post moderation ACL attestation failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
