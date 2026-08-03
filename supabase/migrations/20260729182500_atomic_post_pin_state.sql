-- Migration: 20260729182500_atomic_post_pin_state.sql
-- Created: 2026-07-30T01:25:00Z
-- Description: Make post pin state an explicit, idempotent, scope-serialized
--   transaction. A group has at most one pinned post; a personal author feed
--   has at most one pinned non-group post.
--
-- Forward compensation: deploy callers that stop using this RPC before
-- revoking it. The migration does not rewrite existing data; the first
-- successful pin in a scope heals any legacy duplicate pins atomically.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.posts:atomic-post-pin-state:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic post pin state migration lock is busy';
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
  v_audience_function regprocedure := pg_catalog.to_regprocedure(
    'public.lock_actor_can_interact_with_post(uuid,uuid)'
  );
  v_audience_source text;
  v_existing_function regprocedure := pg_catalog.to_regprocedure(
    'public.set_post_pin_state_atomic(uuid,uuid,boolean)'
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
    RAISE EXCEPTION 'post pin state roles are missing: %', v_missing_roles;
  END IF;

  IF pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.posts') IS NULL
     OR pg_catalog.to_regclass('public.groups') IS NULL
     OR pg_catalog.to_regclass('public.group_members') IS NULL
     OR pg_catalog.to_regtype('public.member_role') IS NULL
  THEN
    RAISE EXCEPTION 'canonical post pin state objects must deploy first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.posts'::regclass,
      'public.groups'::regclass,
      'public.group_members'::regclass
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
      'public.group_members'::regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION 'post pin state requires canonical permanent relation ownership';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.posts'::regclass,
      'public.groups'::regclass,
      'public.group_members'::regclass
    )
       OR inheritance.inhparent IN (
         'auth.users'::regclass,
         'public.user_profiles'::regclass,
         'public.posts'::regclass,
         'public.groups'::regclass,
         'public.group_members'::regclass
       )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.posts'::regclass,
      'public.groups'::regclass,
      'public.group_members'::regclass
    )
  ) THEN
    RAISE EXCEPTION 'post pin state relations must not use inheritance or rewrite rules';
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
      ('public', 'user_profiles', 4, 'is_banned', 'boolean'::regtype, true),
      ('public', 'user_profiles', 5, 'ban_expires_at', 'timestamptz'::regtype, false),
      ('public', 'posts', 1, 'id', 'uuid'::regtype, true),
      ('public', 'posts', 2, 'author_id', 'uuid'::regtype, true),
      ('public', 'posts', 3, 'group_id', 'uuid'::regtype, false),
      ('public', 'posts', 4, 'is_pinned', 'boolean'::regtype, false),
      ('public', 'groups', 1, 'id', 'uuid'::regtype, true),
      ('public', 'groups', 2, 'dissolved_at', 'timestamptz'::regtype, false),
      ('public', 'group_members', 1, 'group_id', 'uuid'::regtype, true),
      ('public', 'group_members', 2, 'user_id', 'uuid'::regtype, true),
      (
        'public', 'group_members', 3, 'role',
        'public.member_role'::regtype, true
      )
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
    RAISE EXCEPTION 'post pin state has incompatible columns: %', v_invalid_columns;
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

  IF v_audience_function IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_audience_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'boolean'::regtype
      AND NOT function_row.proretset
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
  ) THEN
    RAISE EXCEPTION 'canonical locked post audience authority must deploy first';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_audience_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_audience_function;

  IF pg_catalog.strpos(
       v_audience_source,
       'lock_post_interaction_block_edges'
     ) = 0
     OR pg_catalog.strpos(
       v_audience_source,
       'lock_actor_can_interact_with_post_locked_impl'
     ) = 0
  THEN
    RAISE EXCEPTION 'locked post audience authority contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'set_post_pin_state_atomic'
      AND function_row.oid IS DISTINCT FROM v_existing_function
  ) THEN
    RAISE EXCEPTION 'incompatible set_post_pin_state_atomic overload exists';
  END IF;

  IF v_existing_function IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_existing_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 3
      AND function_row.pronargdefaults = 0
  ) THEN
    RAISE EXCEPTION 'existing set_post_pin_state_atomic signature is incompatible';
  END IF;
END
$preflight$;

LOCK TABLE auth.users,
  public.user_profiles,
  public.posts,
  public.groups,
  public.group_members
  IN SHARE MODE;

CREATE OR REPLACE FUNCTION public.set_post_pin_state_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_is_pinned boolean
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
  v_observed_author_id uuid;
  v_observed_group_id uuid;
  v_observed_xmin text;
  v_observed_ctid text;
  v_post public.posts%ROWTYPE;
  v_locked_xmin text;
  v_locked_ctid text;
  v_group public.groups%ROWTYPE;
  v_actor_role text;
  v_actor_is_member boolean := false;
  v_scope_type text;
  v_scope_id uuid;
  v_other_pinned_count integer := 0;
  v_unpinned_count integer := 0;
  v_target_update_count integer := 0;
  v_already_set boolean := false;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_actor_id IS NULL OR p_post_id IS NULL OR p_is_pinned IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  -- Resolve only scope identity before the scope advisory. The audience lock
  -- below freezes and re-attests this row before any permission decision.
  SELECT target.author_id,
         target.group_id,
         target.xmin::text,
         target.ctid::text
  INTO v_observed_author_id,
       v_observed_group_id,
       v_observed_xmin,
       v_observed_ctid
  FROM public.posts AS target
  WHERE target.id = p_post_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'POST_NOT_FOUND'
    );
  END IF;

  IF v_observed_group_id IS NULL THEN
    v_scope_type := 'author';
    v_scope_id := v_observed_author_id;
  ELSE
    v_scope_type := 'group';
    v_scope_id := v_observed_group_id;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-pin:' || v_scope_type || ':' || v_scope_id::text,
      0
    )
  );

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

  IF v_observed_group_id IS NOT NULL THEN
    -- Membership writers use the same edge serializer. Take it before the
    -- audience helper locks the group/member rows.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'group-membership:' || v_observed_group_id::text || ':' || p_actor_id::text,
        0
      )
    );
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
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;

  -- This canonical helper locks the actor/post/root, sorted block edges,
  -- groups, membership/ban rows and follower edges before deciding audience.
  IF NOT public.lock_actor_can_interact_with_post(p_post_id, p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'POST_NOT_FOUND'
    );
  END IF;

  SELECT target.*
  INTO v_post
  FROM public.posts AS target
  WHERE target.id = p_post_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'post disappeared after its audience lock';
  END IF;

  SELECT target.xmin::text, target.ctid::text
  INTO v_locked_xmin, v_locked_ctid
  FROM public.posts AS target
  WHERE target.id = p_post_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'post disappeared after its canonical lock';
  END IF;

  IF v_post.author_id IS DISTINCT FROM v_observed_author_id
     OR v_post.group_id IS DISTINCT FROM v_observed_group_id
     OR v_locked_xmin IS DISTINCT FROM v_observed_xmin
     OR v_locked_ctid IS DISTINCT FROM v_observed_ctid
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'post pin scope changed before its canonical lock';
  END IF;

  IF v_post.group_id IS NULL THEN
    IF v_post.author_id IS DISTINCT FROM p_actor_id THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'PERMISSION_DENIED'
      );
    END IF;
  ELSE
    SELECT target_group.*
    INTO v_group
    FROM public.groups AS target_group
    WHERE target_group.id = v_post.group_id
    FOR UPDATE;

    IF NOT FOUND OR v_group.dissolved_at IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'POST_NOT_FOUND'
      );
    END IF;

    SELECT member.role::text
    INTO v_actor_role
    FROM public.group_members AS member
    WHERE member.group_id = v_post.group_id
      AND member.user_id = p_actor_id
    FOR UPDATE;
    v_actor_is_member := FOUND;

    IF v_post.author_id IS DISTINCT FROM p_actor_id
       AND (
         NOT v_actor_is_member
         OR v_actor_role NOT IN ('owner', 'admin')
       )
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'PERMISSION_DENIED'
      );
    END IF;
  END IF;

  -- Freeze every row in the logical scope in deterministic id order. The
  -- advisory serializes new RPC callers; these row locks also close the
  -- transaction against already-running legacy writers during rollout.
  IF v_post.group_id IS NULL THEN
    PERFORM scoped_post.id
    FROM public.posts AS scoped_post
    WHERE scoped_post.group_id IS NULL
      AND scoped_post.author_id = v_post.author_id
    ORDER BY scoped_post.id
    FOR UPDATE;

    SELECT pg_catalog.count(*)::integer
    INTO v_other_pinned_count
    FROM public.posts AS pinned_post
    WHERE pinned_post.group_id IS NULL
      AND pinned_post.author_id = v_post.author_id
      AND pinned_post.id <> p_post_id
      AND COALESCE(pinned_post.is_pinned, false);
  ELSE
    PERFORM scoped_post.id
    FROM public.posts AS scoped_post
    WHERE scoped_post.group_id = v_post.group_id
    ORDER BY scoped_post.id
    FOR UPDATE;

    SELECT pg_catalog.count(*)::integer
    INTO v_other_pinned_count
    FROM public.posts AS pinned_post
    WHERE pinned_post.group_id = v_post.group_id
      AND pinned_post.id <> p_post_id
      AND COALESCE(pinned_post.is_pinned, false);
  END IF;

  v_already_set := v_post.is_pinned IS NOT DISTINCT FROM p_is_pinned
    AND (NOT p_is_pinned OR v_other_pinned_count = 0);

  IF p_is_pinned THEN
    IF v_post.group_id IS NULL THEN
      UPDATE public.posts AS other_post
      SET is_pinned = false
      WHERE other_post.group_id IS NULL
        AND other_post.author_id = v_post.author_id
        AND other_post.id <> p_post_id
        AND COALESCE(other_post.is_pinned, false);
    ELSE
      UPDATE public.posts AS other_post
      SET is_pinned = false
      WHERE other_post.group_id = v_post.group_id
        AND other_post.id <> p_post_id
        AND COALESCE(other_post.is_pinned, false);
    END IF;
    GET DIAGNOSTICS v_unpinned_count = ROW_COUNT;

    UPDATE public.posts AS target_post
    SET is_pinned = true
    WHERE target_post.id = p_post_id
      AND target_post.author_id = v_post.author_id
      AND target_post.group_id IS NOT DISTINCT FROM v_post.group_id
      AND target_post.is_pinned IS DISTINCT FROM true;
    GET DIAGNOSTICS v_target_update_count = ROW_COUNT;
  ELSE
    UPDATE public.posts AS target_post
    SET is_pinned = false
    WHERE target_post.id = p_post_id
      AND target_post.author_id = v_post.author_id
      AND target_post.group_id IS NOT DISTINCT FROM v_post.group_id
      AND target_post.is_pinned IS DISTINCT FROM false;
    GET DIAGNOSTICS v_target_update_count = ROW_COUNT;
    IF COALESCE(v_post.is_pinned, false) THEN
      v_unpinned_count := v_target_update_count;
    END IF;
  END IF;

  IF v_target_update_count NOT IN (0, 1)
     OR NOT EXISTS (
       SELECT 1
       FROM public.posts AS acknowledged_post
       WHERE acknowledged_post.id = p_post_id
         AND acknowledged_post.author_id = v_post.author_id
         AND acknowledged_post.group_id IS NOT DISTINCT FROM v_post.group_id
         AND acknowledged_post.is_pinned IS NOT DISTINCT FROM p_is_pinned
     )
     OR (
       p_is_pinned
       AND EXISTS (
         SELECT 1
         FROM public.posts AS duplicate_post
         WHERE duplicate_post.id <> p_post_id
           AND COALESCE(duplicate_post.is_pinned, false)
           AND (
             (
               v_post.group_id IS NULL
               AND duplicate_post.group_id IS NULL
               AND duplicate_post.author_id = v_post.author_id
             )
             OR (
               v_post.group_id IS NOT NULL
               AND duplicate_post.group_id = v_post.group_id
             )
           )
       )
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'post pin state acknowledgement is invalid';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'actor_id', p_actor_id,
    'post_id', p_post_id,
    'author_id', v_post.author_id,
    'group_id', v_post.group_id,
    'scope_type', v_scope_type,
    'scope_id', v_scope_id,
    'is_pinned', p_is_pinned,
    'already_set', v_already_set,
    'unpinned_count', v_unpinned_count
  );
END
$function$;

ALTER FUNCTION public.set_post_pin_state_atomic(uuid, uuid, boolean)
  OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.set_post_pin_state_atomic(uuid,uuid,boolean)'::regprocedure;
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
    ON FUNCTION public.set_post_pin_state_atomic(uuid, uuid, boolean)
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.set_post_pin_state_atomic(uuid, uuid, boolean)
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-post-pin-state:v1:' || pg_catalog.md5(v_source)
  );
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.set_post_pin_state_atomic(uuid,uuid,boolean)'::regprocedure;
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
  v_scope_lock_position integer;
  v_audience_position integer;
  v_target_lock_position integer;
  v_scope_rows_position integer;
  v_unpin_position integer;
  v_pin_position integer;
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
    AND function_row.pronargs = 3
    AND function_row.pronargdefaults = 0
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  v_scope_lock_position := pg_catalog.strpos(v_source, $$'post-pin:'$$);
  v_audience_position := pg_catalog.strpos(
    v_source,
    'lock_actor_can_interact_with_post'
  );
  v_target_lock_position := pg_catalog.strpos(
    v_source,
    'FROM public.posts AS target'
  );
  v_scope_rows_position := pg_catalog.strpos(
    v_source,
    'FROM public.posts AS scoped_post'
  );
  v_unpin_position := pg_catalog.strpos(
    v_source,
    'UPDATE public.posts AS other_post'
  );
  v_pin_position := pg_catalog.strpos(
    v_source,
    'UPDATE public.posts AS target_post'
  );

  IF pg_catalog.obj_description(v_function, 'pg_proc') IS DISTINCT FROM
       'atomic-post-pin-state:v1:' || pg_catalog.md5(v_source)
     OR pg_catalog.strpos(v_source, 'FROM auth.users') = 0
     OR pg_catalog.strpos(v_source, $$'group-membership:'$$) = 0
     OR pg_catalog.strpos(v_source, 'FROM public.user_profiles') = 0
     OR v_scope_lock_position = 0
     OR v_audience_position <= v_scope_lock_position
     OR v_target_lock_position = 0
     OR v_scope_rows_position <= v_audience_position
     OR v_unpin_position <= v_scope_rows_position
     OR v_pin_position <= v_scope_rows_position
     OR pg_catalog.strpos(v_source, $$'already_set'$$) = 0
     OR pg_catalog.strpos(v_source, $$'unpinned_count'$$) = 0
  THEN
    RAISE EXCEPTION 'atomic post pin state body attestation failed';
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
    RAISE EXCEPTION 'atomic post pin state ACL attestation failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
