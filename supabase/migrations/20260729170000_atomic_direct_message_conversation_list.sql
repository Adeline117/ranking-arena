-- Migration: 20260729170000_atomic_direct_message_conversation_list.sql
-- Created: 2026-07-30T10:00:00Z
-- Description: Return the authenticated actor's pinned/sorted DM inbox,
--   counterparty profiles, clear-history-safe latest previews, unread counts,
--   and member settings from one statement-level MVCC snapshot after locking
--   the actor's lifecycle admission. A cleared conversation stays hidden until
--   a newer live message exists.
--
-- Forward compensation: roll API readers back before dropping this read-only
-- RPC in a later forward migration.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.conversations:atomic-direct-message-list:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic direct-message conversation-list migration lock is busy';
  END IF;
END
$migration_lock$;

DO $preflight$
DECLARE
  v_postgres_oid oid := pg_catalog.to_regrole('postgres')::oid;
  v_missing_roles text[];
  v_invalid_columns text[];
  v_pair_function regprocedure := pg_catalog.to_regprocedure(
    'public.serialize_direct_message_pair_edge()'
  );
  v_list_function regprocedure := pg_catalog.to_regprocedure(
    'public.get_direct_message_conversation_list_atomic(uuid,integer)'
  );
  v_dependency regprocedure;
  v_dependency_source text;
  v_pair_source text;
  v_conversation_attnum smallint;
  v_member_user_attnum smallint;
  v_dependencies regprocedure[] := ARRAY[
    pg_catalog.to_regprocedure(
      'public.start_direct_message_conversation_atomic(uuid,uuid)'
    ),
    pg_catalog.to_regprocedure(
      'public.send_direct_message_atomic(uuid,uuid,text,text,text,text,uuid)'
    ),
    pg_catalog.to_regprocedure(
      'public.delete_direct_message_atomic(uuid,uuid)'
    ),
    pg_catalog.to_regprocedure(
      'public.mark_direct_message_conversation_read_atomic(uuid,uuid)'
    ),
    pg_catalog.to_regprocedure(
      'public.mutate_direct_message_conversation_settings_atomic(uuid,uuid,text,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean)'
    )
  ]::regprocedure[];
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['anon', 'authenticated', 'service_role', 'postgres']::text[]
  ) AS required_role
  WHERE pg_catalog.to_regrole(required_role) IS NULL;

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION
      'direct-message conversation-list roles are missing: %',
      v_missing_roles;
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.conversations') IS NULL
     OR pg_catalog.to_regclass('public.conversation_members') IS NULL
     OR pg_catalog.to_regclass('public.direct_messages') IS NULL
     OR pg_catalog.to_regclass('public.blocked_users') IS NULL
     OR pg_catalog.to_regclass('public.user_follows') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.install_active_authenticated_subject_mutation_barriers()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.assert_active_authenticated_subject_mutation_barriers()'
     ) IS NULL
     OR v_pair_function IS NULL
     OR pg_catalog.array_position(v_dependencies, NULL::regprocedure) IS NOT NULL
  THEN
    RAISE EXCEPTION
      'canonical account and direct-message authorities must deploy first';
  END IF;

  IF (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure('auth.role()')
  ) <> 'text'::regtype THEN
    RAISE EXCEPTION 'auth.role() returning text must exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.conversations'::regclass,
      'public.conversation_members'::regclass,
      'public.direct_messages'::regclass,
      'public.blocked_users'::regclass,
      'public.user_follows'::regclass
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
      'public.conversations'::regclass,
      'public.conversation_members'::regclass,
      'public.direct_messages'::regclass,
      'public.blocked_users'::regclass,
      'public.user_follows'::regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION
      'direct-message conversation-list requires canonical permanent relations';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.conversations'::regclass,
      'public.conversation_members'::regclass,
      'public.direct_messages'::regclass,
      'public.blocked_users'::regclass,
      'public.user_follows'::regclass
    )
       OR inheritance.inhparent IN (
         'auth.users'::regclass,
         'public.user_profiles'::regclass,
         'public.conversations'::regclass,
         'public.conversation_members'::regclass,
         'public.direct_messages'::regclass,
         'public.blocked_users'::regclass,
         'public.user_follows'::regclass
       )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.conversations'::regclass,
      'public.conversation_members'::regclass,
      'public.direct_messages'::regclass,
      'public.blocked_users'::regclass,
      'public.user_follows'::regclass
    )
  ) THEN
    RAISE EXCEPTION
      'direct-message conversation-list relations cannot use inheritance or rewrite rules';
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
      ('public', 'user_profiles', 2, 'handle', 'text'::regtype, true),
      ('public', 'user_profiles', 3, 'avatar_url', 'text'::regtype, false),
      ('public', 'user_profiles', 4, 'bio', 'text'::regtype, false),
      ('public', 'user_profiles', 5, 'deleted_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 6, 'banned_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 7, 'is_banned', 'boolean'::regtype, true),
      ('public', 'user_profiles', 8, 'ban_expires_at', 'timestamptz'::regtype, false),
      ('public', 'conversations', 1, 'id', 'uuid'::regtype, true),
      ('public', 'conversations', 2, 'user1_id', 'uuid'::regtype, true),
      ('public', 'conversations', 3, 'user2_id', 'uuid'::regtype, true),
      ('public', 'conversations', 4, 'created_at', 'timestamptz'::regtype, false),
      ('public', 'conversation_members', 1, 'id', 'uuid'::regtype, true),
      ('public', 'conversation_members', 2, 'conversation_id', 'uuid'::regtype, true),
      ('public', 'conversation_members', 3, 'user_id', 'uuid'::regtype, true),
      ('public', 'conversation_members', 4, 'remark', 'text'::regtype, false),
      ('public', 'conversation_members', 5, 'is_muted', 'boolean'::regtype, true),
      ('public', 'conversation_members', 6, 'is_pinned', 'boolean'::regtype, true),
      ('public', 'conversation_members', 7, 'is_blocked', 'boolean'::regtype, true),
      ('public', 'conversation_members', 8, 'cleared_before', 'timestamptz'::regtype, false),
      ('public', 'direct_messages', 1, 'id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 2, 'conversation_id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 3, 'sender_id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 4, 'receiver_id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 5, 'content', 'text'::regtype, true),
      ('public', 'direct_messages', 6, 'read', 'boolean'::regtype, false),
      ('public', 'direct_messages', 7, 'created_at', 'timestamptz'::regtype, false),
      ('public', 'direct_messages', 8, 'deleted_at', 'timestamptz'::regtype, false),
      ('public', 'blocked_users', 1, 'blocker_id', 'uuid'::regtype, true),
      ('public', 'blocked_users', 2, 'blocked_id', 'uuid'::regtype, true),
      ('public', 'user_follows', 1, 'follower_id', 'uuid'::regtype, true),
      ('public', 'user_follows', 2, 'following_id', 'uuid'::regtype, true)
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
      'direct-message conversation-list has incompatible columns: %',
      v_invalid_columns;
  END IF;

  SELECT attribute.attnum
  INTO STRICT v_conversation_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.conversation_members'::regclass
    AND attribute.attname = 'conversation_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_member_user_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.conversation_members'::regclass
    AND attribute.attname = 'user_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.conversation_members'::regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts = 2
      AND ARRAY(
        SELECT key_column.attnum
        FROM pg_catalog.unnest(
          index_row.indkey::smallint[]
        ) WITH ORDINALITY AS key_column(attnum, ordinality)
        WHERE key_column.ordinality <= index_row.indnkeyatts
        ORDER BY key_column.ordinality
      ) = ARRAY[v_conversation_attnum, v_member_user_attnum]::smallint[]
  ) THEN
    RAISE EXCEPTION
      'conversation list requires UNIQUE (conversation_id, user_id) settings';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.conversations AS conversation
    WHERE conversation.user1_id >= conversation.user2_id
  ) OR EXISTS (
    SELECT 1
    FROM public.conversation_members AS member_row
    LEFT JOIN public.conversations AS conversation
      ON conversation.id = member_row.conversation_id
    WHERE conversation.id IS NULL
       OR member_row.user_id NOT IN (
         conversation.user1_id,
         conversation.user2_id
       )
  ) OR EXISTS (
    SELECT 1
    FROM public.direct_messages AS message_row
    LEFT JOIN public.conversations AS conversation
      ON conversation.id = message_row.conversation_id
    WHERE conversation.id IS NULL
       OR conversation.user1_id
            IS DISTINCT FROM LEAST(message_row.sender_id, message_row.receiver_id)
       OR conversation.user2_id
            IS DISTINCT FROM GREATEST(message_row.sender_id, message_row.receiver_id)
  ) OR EXISTS (
    SELECT 1
    FROM public.conversations AS conversation
    LEFT JOIN auth.users AS user1 ON user1.id = conversation.user1_id
    LEFT JOIN auth.users AS user2 ON user2.id = conversation.user2_id
    LEFT JOIN public.user_profiles AS profile1
      ON profile1.id = conversation.user1_id
    LEFT JOIN public.user_profiles AS profile2
      ON profile2.id = conversation.user2_id
    WHERE user1.id IS NULL
       OR user2.id IS NULL
       OR profile1.id IS NULL
       OR profile2.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'direct-message conversation-list found non-canonical participant data';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_pair_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_pair_function
    AND function_row.prokind = 'f'
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v';

  IF pg_catalog.strpos(v_pair_source, 'direct-message:pair:') = 0
     OR pg_catalog.strpos(v_pair_source, $$WHEN 'direct_messages'$$) = 0
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
         AND trigger_row.tgname = 'trg_serialize_dm_message_pair'
         AND trigger_row.tgfoid = v_pair_function
         AND trigger_row.tgenabled <> 'D'
         AND NOT trigger_row.tgisinternal
     )
  THEN
    RAISE EXCEPTION
      'canonical direct-message pair serializer contract drifted';
  END IF;

  FOREACH v_dependency IN ARRAY v_dependencies LOOP
    SELECT function_row.prosrc
    INTO STRICT v_dependency_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_dependency
      AND function_row.prokind = 'f'
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'jsonb'::regtype;

    IF pg_catalog.strpos(v_dependency_source, 'direct-message:pair:') = 0
    THEN
      RAISE EXCEPTION
        'canonical direct-message list writer lock contract drifted: %',
        v_dependency;
    END IF;

    IF v_dependency IN (
         pg_catalog.to_regprocedure(
           'public.start_direct_message_conversation_atomic(uuid,uuid)'
         ),
         pg_catalog.to_regprocedure(
           'public.mark_direct_message_conversation_read_atomic(uuid,uuid)'
         ),
         pg_catalog.to_regprocedure(
           'public.mutate_direct_message_conversation_settings_atomic(uuid,uuid,text,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean)'
         )
       )
       AND pg_catalog.strpos(
         v_dependency_source,
         'account-recovery-admission:'
       ) = 0
    THEN
      RAISE EXCEPTION
        'canonical direct-message list lifecycle contract drifted: %',
        v_dependency;
    END IF;
  END LOOP;

  IF pg_catalog.has_table_privilege(
       'authenticated', 'public.direct_messages', 'INSERT,UPDATE,DELETE,TRUNCATE'
     ) OR pg_catalog.has_table_privilege(
       'anon', 'public.direct_messages', 'INSERT,UPDATE,DELETE,TRUNCATE'
     ) OR pg_catalog.has_table_privilege(
       'authenticated', 'public.conversation_members', 'INSERT,UPDATE,DELETE,TRUNCATE'
     ) OR pg_catalog.has_table_privilege(
       'anon', 'public.conversation_members', 'INSERT,UPDATE,DELETE,TRUNCATE'
     ) OR pg_catalog.has_table_privilege(
       'service_role', 'public.conversation_members', 'INSERT,UPDATE,DELETE,TRUNCATE'
     )
  THEN
    RAISE EXCEPTION
      'direct-message conversation-list write boundaries must remain revoked';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'get_direct_message_conversation_list_atomic'
      AND (
        v_list_function IS NULL
        OR function_row.oid <> v_list_function::oid
      )
  ) THEN
    RAISE EXCEPTION
      'ambiguous direct-message conversation-list overload exists';
  END IF;
END
$preflight$;

LOCK TABLE auth.users,
  public.user_profiles,
  public.conversations,
  public.conversation_members,
  public.direct_messages,
  public.blocked_users,
  public.user_follows
  IN SHARE MODE;

CREATE OR REPLACE FUNCTION public.get_direct_message_conversation_list_atomic(
  p_actor_id uuid,
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
  v_auth_id uuid;
  v_profile_id uuid;
  v_actor_active boolean := false;
  v_conversations jsonb := '[]'::jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_actor_id IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  -- Hold the actor's lifecycle stable through the response. Counterparty and
  -- message mutations remain non-blocking: the single content SELECT below
  -- gives every candidate, setting, preview, and unread lateral read exactly
  -- one MVCC snapshot, so a writer is observed wholly before or wholly after.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_actor_id::text,
      0
    )
  );

  SELECT auth_user.id
  INTO v_auth_id
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_actor_id
  FOR KEY SHARE;

  IF v_auth_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;

  SELECT
    profile.id,
    profile.deleted_at IS NULL
      AND profile.banned_at IS NULL
      AND NOT (
        profile.is_banned IS TRUE
        AND (
          profile.ban_expires_at IS NULL
          OR profile.ban_expires_at > pg_catalog.statement_timestamp()
        )
      )
  INTO v_profile_id, v_actor_active
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
  FOR SHARE;

  IF v_profile_id IS NULL OR NOT v_actor_active THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', page_row.id,
        'other_user', CASE
          WHEN page_row.profile_active THEN pg_catalog.jsonb_build_object(
            'id', page_row.other_user_id,
            'handle', page_row.handle,
            'avatar_url', page_row.avatar_url,
            'bio', page_row.bio
          )
          ELSE pg_catalog.jsonb_build_object(
            'id', page_row.other_user_id,
            'handle', NULL,
            'avatar_url', NULL,
            'bio', NULL
          )
        END,
        'last_message_at', page_row.sort_at,
        'last_message_preview', page_row.last_message_preview,
        'unread_count', page_row.unread_count,
        'created_at', page_row.created_at,
        'member_settings', CASE
          WHEN page_row.member_id IS NULL THEN 'null'::jsonb
          ELSE pg_catalog.jsonb_build_object(
            'remark', page_row.remark,
            'is_muted', page_row.is_muted,
            'is_pinned', page_row.is_pinned,
            'is_blocked', page_row.is_blocked
          )
        END
      )
      ORDER BY page_row.is_pinned DESC, page_row.sort_at DESC, page_row.id
    ),
    '[]'::jsonb
  )
  INTO STRICT v_conversations
  FROM (
    SELECT
      conversation.id,
      conversation.created_at,
      CASE
        WHEN p_actor_id = conversation.user1_id THEN conversation.user2_id
        ELSE conversation.user1_id
      END AS other_user_id,
      profile.handle,
      profile.avatar_url,
      profile.bio,
      profile.deleted_at IS NULL
        AND profile.banned_at IS NULL
        AND NOT (
          profile.is_banned IS TRUE
          AND (
            profile.ban_expires_at IS NULL
            OR profile.ban_expires_at > pg_catalog.statement_timestamp()
          )
        ) AS profile_active,
      member_row.id AS member_id,
      member_row.remark,
      COALESCE(member_row.is_muted, false) AS is_muted,
      COALESCE(member_row.is_pinned, false) AS is_pinned,
      COALESCE(member_row.is_blocked, false) AS is_blocked,
      COALESCE(
        latest_message.created_at,
        conversation.created_at,
        '1970-01-01 00:00:00+00'::timestamptz
      ) AS sort_at,
      CASE
        WHEN latest_message.id IS NULL THEN NULL
        ELSE pg_catalog.left(latest_message.content, 100)
      END AS last_message_preview,
      unread_summary.unread_count
    FROM public.conversations AS conversation
    LEFT JOIN public.conversation_members AS member_row
      ON member_row.conversation_id = conversation.id
     AND member_row.user_id = p_actor_id
    JOIN public.user_profiles AS profile
      ON profile.id = CASE
        WHEN p_actor_id = conversation.user1_id THEN conversation.user2_id
        ELSE conversation.user1_id
      END
    LEFT JOIN LATERAL (
      SELECT message_row.id, message_row.created_at, message_row.content
      FROM public.direct_messages AS message_row
      WHERE message_row.conversation_id = conversation.id
        AND message_row.deleted_at IS NULL
        AND message_row.created_at IS NOT NULL
        AND (
          member_row.cleared_before IS NULL
          OR message_row.created_at > member_row.cleared_before
        )
      ORDER BY message_row.created_at DESC, message_row.id DESC
      LIMIT 1
    ) AS latest_message ON true
    CROSS JOIN LATERAL (
      SELECT pg_catalog.count(*)::integer AS unread_count
      FROM public.direct_messages AS unread_message
      WHERE unread_message.conversation_id = conversation.id
        AND unread_message.receiver_id = p_actor_id
        AND unread_message.deleted_at IS NULL
        AND unread_message.created_at IS NOT NULL
        AND unread_message.read IS DISTINCT FROM true
        AND (
          member_row.cleared_before IS NULL
          OR unread_message.created_at > member_row.cleared_before
        )
    ) AS unread_summary
    WHERE p_actor_id IN (conversation.user1_id, conversation.user2_id)
      AND (
        member_row.cleared_before IS NULL
        OR latest_message.id IS NOT NULL
      )
    ORDER BY is_pinned DESC, sort_at DESC, conversation.id
    LIMIT p_limit
  ) AS page_row;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'actor_id', p_actor_id,
    'limit', p_limit,
    'conversations', v_conversations
  );
END
$function$;

ALTER FUNCTION public.get_direct_message_conversation_list_atomic(uuid, integer)
  OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.get_direct_message_conversation_list_atomic(uuid,integer)'::regprocedure;
  v_owner oid;
  v_source text;
  v_grantee record;
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
    ON FUNCTION public.get_direct_message_conversation_list_atomic(uuid, integer)
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.get_direct_message_conversation_list_atomic(uuid, integer)
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-direct-message-conversation-list:v1:'
      || pg_catalog.md5(v_source)
  );

  IF pg_catalog.strpos(v_source, 'account-recovery-admission:') = 0
     OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.conversations AS conversation') = 0
     OR pg_catalog.strpos(v_source, 'JOIN public.conversation_members AS member_row') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.direct_messages AS message_row') = 0
     OR pg_catalog.strpos(v_source, 'one MVCC snapshot') = 0
     OR pg_catalog.strpos(v_source, 'message_row.deleted_at IS NULL') = 0
     OR pg_catalog.strpos(
       v_source,
       'message_row.created_at > member_row.cleared_before'
     ) = 0
     OR pg_catalog.strpos(v_source, 'unread_message.read IS DISTINCT FROM true') = 0
     OR pg_catalog.strpos(
       v_source,
       'ORDER BY is_pinned DESC, sort_at DESC'
     ) = 0
     OR pg_catalog.strpos(v_source, 'LIMIT p_limit') = 0
  THEN
    RAISE EXCEPTION
      'atomic direct-message conversation-list function contract drifted';
  END IF;
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.get_direct_message_conversation_list_atomic(uuid,integer)'::regprocedure;
  v_service_oid oid := pg_catalog.to_regrole('service_role')::oid;
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function
    AND function_row.prokind = 'f'
    AND function_row.proowner = pg_catalog.to_regrole('postgres')::oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prorettype = 'jsonb'::regtype
    AND NOT function_row.proretset
    AND function_row.pronargs = 2
    AND function_row.pronargdefaults = 0
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF pg_catalog.obj_description(v_function, 'pg_proc') IS DISTINCT FROM
       'atomic-direct-message-conversation-list:v1:'
         || pg_catalog.md5(v_source)
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_function, 'EXECUTE'
     )
     OR EXISTS (
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
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_namespace AS function_schema
         ON function_schema.oid = function_row.pronamespace
       WHERE function_schema.nspname = 'public'
         AND function_row.proname =
           'get_direct_message_conversation_list_atomic'
         AND function_row.oid <> v_function
     )
  THEN
    RAISE EXCEPTION
      'direct-message conversation-list service-only RPC drifted';
  END IF;
END
$postflight$;

SELECT public.install_active_authenticated_subject_mutation_barriers();
SELECT public.assert_active_authenticated_subject_mutation_barriers();

NOTIFY pgrst, 'reload schema';

COMMIT;
