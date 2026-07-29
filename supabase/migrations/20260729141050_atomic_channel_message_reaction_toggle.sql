-- Migration: 20260729141050_atomic_channel_message_reaction_toggle.sql
-- Created: 2026-07-29T21:10:50Z
-- Description: Authorize current channel membership, bind the parent message,
--   and toggle one reaction with an exact aggregate acknowledgement atomically.
--
-- Forward compensation: roll API callers back before dropping this RPC. This
-- migration changes no reaction data. Use a forward DROP FUNCTION migration
-- to retire the boundary; reserve PITR for data recovery.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.channel_message_reactions:atomic-toggle:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic channel-reaction migration lock is busy';
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
  v_member_function regprocedure := pg_catalog.to_regprocedure(
    'public.mutate_channel_member_atomic(uuid,uuid,uuid,text,text)'
  );
  v_member_source text;
  v_toggle_function regprocedure := pg_catalog.to_regprocedure(
    'public.toggle_channel_message_reaction_atomic(uuid,uuid,uuid,text)'
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
    RAISE EXCEPTION 'channel-reaction roles are missing: %', v_missing_roles;
  END IF;

  IF pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.chat_channels') IS NULL
     OR pg_catalog.to_regclass('public.channel_members') IS NULL
     OR pg_catalog.to_regclass('public.channel_messages') IS NULL
     OR pg_catalog.to_regclass('public.channel_message_reactions') IS NULL
  THEN
    RAISE EXCEPTION 'canonical channel-reaction relations must deploy first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass,
      'public.channel_messages'::regclass,
      'public.channel_message_reactions'::regclass
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
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass,
      'public.channel_messages'::regclass,
      'public.channel_message_reactions'::regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION
      'channel-reaction toggle requires canonical permanent relation ownership';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass,
      'public.channel_messages'::regclass,
      'public.channel_message_reactions'::regclass
    )
       OR inheritance.inhparent IN (
         'auth.users'::regclass,
         'public.user_profiles'::regclass,
         'public.chat_channels'::regclass,
         'public.channel_members'::regclass,
         'public.channel_messages'::regclass,
         'public.channel_message_reactions'::regclass
       )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass,
      'public.channel_messages'::regclass,
      'public.channel_message_reactions'::regclass
    )
  ) THEN
    RAISE EXCEPTION
      'channel-reaction relations must not use inheritance or rewrite rules';
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
      ('public', 'chat_channels', 1, 'id', 'uuid'::regtype, true),
      ('public', 'chat_channels', 2, 'type', 'text'::regtype, true),
      ('public', 'chat_channels', 3, 'created_by', 'uuid'::regtype, false),
      ('public', 'channel_members', 1, 'channel_id', 'uuid'::regtype, true),
      ('public', 'channel_members', 2, 'user_id', 'uuid'::regtype, true),
      ('public', 'channel_members', 3, 'role', 'text'::regtype, true),
      ('public', 'channel_messages', 1, 'id', 'uuid'::regtype, true),
      ('public', 'channel_messages', 2, 'channel_id', 'uuid'::regtype, true),
      ('public', 'channel_messages', 3, 'sender_id', 'uuid'::regtype, true),
      ('public', 'channel_messages', 4, 'content', 'text'::regtype, true),
      ('public', 'channel_message_reactions', 1, 'id', 'uuid'::regtype, true),
      ('public', 'channel_message_reactions', 2, 'message_id', 'uuid'::regtype, true),
      ('public', 'channel_message_reactions', 3, 'user_id', 'uuid'::regtype, true),
      ('public', 'channel_message_reactions', 4, 'emoji', 'text'::regtype, true),
      ('public', 'channel_message_reactions', 5, 'created_at', 'timestamptz'::regtype, false)
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
    RAISE EXCEPTION 'channel-reaction toggle has incompatible columns: %', v_invalid_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.channel_message_reactions'::regclass
      AND constraint_row.contype = 'u'
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.channel_message_reactions'::regclass
            AND attribute.attname = 'message_id'
        ),
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.channel_message_reactions'::regclass
            AND attribute.attname = 'user_id'
        ),
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.channel_message_reactions'::regclass
            AND attribute.attname = 'emoji'
        )
      ]::smallint[]
  ) THEN
    RAISE EXCEPTION
      'channel_message_reactions requires UNIQUE (message_id, user_id, emoji)';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL OR (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure('auth.role()')
  ) <> 'text'::regtype THEN
    RAISE EXCEPTION 'auth.role() returning text must exist';
  END IF;

  IF v_member_function IS NULL OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'mutate_channel_member_atomic'
  ) <> 1 THEN
    RAISE EXCEPTION 'atomic channel-member mutation authority must deploy first';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_member_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_member_function
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'jsonb'::regtype
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF pg_catalog.strpos(
       v_member_source,
       $$'group-channel-owner-invariant:v1'$$
     ) = 0
     OR pg_catalog.strpos(
       v_member_source,
       $$'channel-membership:channel:'$$
     ) = 0
     OR pg_catalog.strpos(v_member_source, 'FROM auth.users') = 0
     OR pg_catalog.strpos(v_member_source, 'FROM public.channel_members') = 0
  THEN
    RAISE EXCEPTION 'atomic channel-member lock contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'toggle_channel_message_reaction_atomic'
      AND function_row.oid IS DISTINCT FROM v_toggle_function
  ) THEN
    RAISE EXCEPTION 'incompatible toggle_channel_message_reaction_atomic overload exists';
  END IF;

  IF v_toggle_function IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_toggle_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 4
  ) THEN
    RAISE EXCEPTION
      'existing toggle_channel_message_reaction_atomic signature is incompatible';
  END IF;

  IF pg_catalog.has_table_privilege(
    'anon', 'public.channel_message_reactions', 'INSERT'
  ) OR pg_catalog.has_table_privilege(
    'authenticated', 'public.channel_message_reactions', 'INSERT'
  ) OR pg_catalog.has_table_privilege(
    'anon', 'public.channel_message_reactions', 'DELETE'
  ) OR pg_catalog.has_table_privilege(
    'authenticated', 'public.channel_message_reactions', 'DELETE'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.channel_message_reactions', 'SELECT'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.channel_message_reactions', 'INSERT'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.channel_message_reactions', 'DELETE'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.channel_members', 'SELECT'
  ) THEN
    RAISE EXCEPTION 'channel-reaction service-only write boundary drifted';
  END IF;
END
$preflight$;

LOCK TABLE auth.users,
  public.user_profiles,
  public.chat_channels,
  public.channel_members,
  public.channel_messages,
  public.channel_message_reactions
  IN SHARE MODE;

CREATE OR REPLACE FUNCTION public.toggle_channel_message_reaction_atomic(
  p_channel_id uuid,
  p_message_id uuid,
  p_actor_id uuid,
  p_emoji text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_observed_channel_exists boolean := false;
  v_channel_exists boolean := false;
  v_observed_channel_type text;
  v_channel_type text;
  v_observed_created_by uuid;
  v_created_by uuid;
  v_observed_row_token text;
  v_row_token text;
  v_auth_ids uuid[] := ARRAY[]::uuid[];
  v_locked_auth_ids uuid[] := ARRAY[]::uuid[];
  v_member record;
  v_actor_role text;
  v_actor_profile public.user_profiles%ROWTYPE;
  v_actor_profile_found boolean := false;
  v_message_author_id uuid;
  v_message_content text;
  v_reaction_id uuid;
  v_action text;
  v_changed_count integer := 0;
  v_counts jsonb := '{}'::jsonb;
  v_user_emojis text[] := ARRAY[]::text[];
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_channel_id IS NULL
     OR p_message_id IS NULL
     OR p_actor_id IS NULL
     OR p_emoji IS NULL
     OR p_emoji NOT IN (
       '👍', '🔥', '💎', '🚀', '❤️', '👀',
       '🎯', '💰', '📈', '📉', '🤔', '😂'
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('group-channel-owner-invariant:v1', 0)
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'channel-membership:channel:' || p_channel_id::text,
      0
    )
  );

  SELECT
    channel_row.type,
    channel_row.created_by,
    channel_row.xmin::text || ':' || channel_row.ctid::text
  INTO
    v_observed_channel_type,
    v_observed_created_by,
    v_observed_row_token
  FROM public.chat_channels AS channel_row
  WHERE channel_row.id = p_channel_id;
  v_observed_channel_exists := FOUND;

  SELECT pg_catalog.array_agg(identity_id ORDER BY identity_id)
  INTO STRICT v_auth_ids
  FROM (
    SELECT p_actor_id AS identity_id
    UNION
    SELECT v_observed_created_by
    WHERE v_observed_created_by IS NOT NULL
  ) AS identity;

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

  SELECT
    channel_row.type,
    channel_row.created_by,
    channel_row.xmin::text || ':' || channel_row.ctid::text
  INTO
    v_channel_type,
    v_created_by,
    v_row_token
  FROM public.chat_channels AS channel_row
  WHERE channel_row.id = p_channel_id
  FOR SHARE;
  v_channel_exists := FOUND;

  IF NOT v_observed_channel_exists THEN
    IF v_channel_exists THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'channel identity appeared while locking; retry';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'CHANNEL_NOT_FOUND'
    );
  END IF;

  IF NOT v_channel_exists
     OR v_channel_type IS DISTINCT FROM v_observed_channel_type
     OR v_created_by IS DISTINCT FROM v_observed_created_by
     OR v_row_token IS DISTINCT FROM v_observed_row_token
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'channel identity changed while locking; retry';
  END IF;

  IF v_channel_type IS DISTINCT FROM 'group' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'CHANNEL_NOT_GROUP'
    );
  END IF;

  FOR v_member IN
    SELECT membership.user_id, membership.role
    FROM public.channel_members AS membership
    WHERE membership.channel_id = p_channel_id
    ORDER BY membership.user_id
    FOR UPDATE
  LOOP
    IF v_member.user_id = p_actor_id THEN
      v_actor_role := v_member.role;
    END IF;
  END LOOP;

  IF v_actor_role IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'MEMBERSHIP_NOT_FOUND'
    );
  END IF;

  SELECT profile.*
  INTO v_actor_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
  FOR SHARE;
  v_actor_profile_found := FOUND;

  IF NOT v_actor_profile_found
     OR v_actor_profile.deleted_at IS NOT NULL
     OR v_actor_profile.banned_at IS NOT NULL
     OR (
       v_actor_profile.is_banned IS TRUE
       AND (
         v_actor_profile.ban_expires_at IS NULL
         OR v_actor_profile.ban_expires_at > pg_catalog.statement_timestamp()
       )
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;

  SELECT parent_message.sender_id, parent_message.content
  INTO v_message_author_id, v_message_content
  FROM public.channel_messages AS parent_message
  WHERE parent_message.id = p_message_id
    AND parent_message.channel_id = p_channel_id
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'MESSAGE_NOT_FOUND'
    );
  END IF;

  SELECT reaction.id
  INTO v_reaction_id
  FROM public.channel_message_reactions AS reaction
  WHERE reaction.message_id = p_message_id
    AND reaction.user_id = p_actor_id
    AND reaction.emoji = p_emoji
  FOR UPDATE;

  IF FOUND THEN
    DELETE FROM public.channel_message_reactions AS reaction
    WHERE reaction.id = v_reaction_id
      AND reaction.message_id = p_message_id
      AND reaction.user_id = p_actor_id
      AND reaction.emoji = p_emoji;
    GET DIAGNOSTICS v_changed_count = ROW_COUNT;
    v_action := 'removed';
  ELSE
    INSERT INTO public.channel_message_reactions (
      message_id,
      user_id,
      emoji
    ) VALUES (
      p_message_id,
      p_actor_id,
      p_emoji
    )
    ON CONFLICT (message_id, user_id, emoji) DO NOTHING
    RETURNING id INTO v_reaction_id;
    GET DIAGNOSTICS v_changed_count = ROW_COUNT;
    v_action := 'added';
  END IF;

  IF v_changed_count <> 1 OR v_reaction_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'channel reaction changed concurrently; retry';
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_object_agg(reaction_count.emoji, reaction_count.total),
    '{}'::jsonb
  )
  INTO STRICT v_counts
  FROM (
    SELECT reaction.emoji, pg_catalog.count(*) AS total
    FROM public.channel_message_reactions AS reaction
    WHERE reaction.message_id = p_message_id
    GROUP BY reaction.emoji
    ORDER BY reaction.emoji
  ) AS reaction_count;

  SELECT COALESCE(
    pg_catalog.array_agg(reaction.emoji ORDER BY reaction.emoji),
    ARRAY[]::text[]
  )
  INTO STRICT v_user_emojis
  FROM public.channel_message_reactions AS reaction
  WHERE reaction.message_id = p_message_id
    AND reaction.user_id = p_actor_id;

  IF (v_action = 'added' AND NOT p_emoji = ANY(v_user_emojis))
     OR (v_action = 'removed' AND p_emoji = ANY(v_user_emojis))
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'channel reaction aggregate acknowledgement is incomplete';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'actor_id', p_actor_id,
    'channel_id', p_channel_id,
    'message_id', p_message_id,
    'reaction_id', v_reaction_id,
    'emoji', p_emoji,
    'action', v_action,
    'changed', true,
    'counts', v_counts,
    'user_emojis', pg_catalog.to_jsonb(v_user_emojis),
    'message_author_id', v_message_author_id,
    'message_preview', pg_catalog.left(v_message_content, 100)
  );
END
$function$;

ALTER FUNCTION public.toggle_channel_message_reaction_atomic(
  uuid, uuid, uuid, text
) OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.toggle_channel_message_reaction_atomic(uuid,uuid,uuid,text)'::regprocedure;
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
    ON FUNCTION public.toggle_channel_message_reaction_atomic(
      uuid, uuid, uuid, text
    )
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.toggle_channel_message_reaction_atomic(
      uuid, uuid, uuid, text
    )
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-channel-message-reaction-toggle:v1:' || pg_catalog.md5(v_source)
  );
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.toggle_channel_message_reaction_atomic(uuid,uuid,uuid,text)'::regprocedure;
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
       'atomic-channel-message-reaction-toggle:v1:' || pg_catalog.md5(v_source)
     OR pg_catalog.strpos(v_source, $$'group-channel-owner-invariant:v1'$$) = 0
     OR pg_catalog.strpos(v_source, $$'channel-membership:channel:'$$) = 0
     OR pg_catalog.strpos(v_source, 'FROM auth.users') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.channel_members') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.channel_messages') = 0
     OR pg_catalog.strpos(v_source, 'INSERT INTO public.channel_message_reactions') = 0
     OR pg_catalog.strpos(v_source, 'DELETE FROM public.channel_message_reactions') = 0
  THEN
    RAISE EXCEPTION 'atomic channel-reaction body attestation failed';
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
    RAISE EXCEPTION 'atomic channel-reaction ACL attestation failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
