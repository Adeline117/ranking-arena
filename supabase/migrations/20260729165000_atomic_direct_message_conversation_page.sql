-- Migration: 20260729165000_atomic_direct_message_conversation_page.sql
-- Created: 2026-07-30T08:50:00Z
-- Description: Authorize a direct-message participant and return the other
--   profile, clear-history boundary, paginated live messages, live reply
--   previews, and reaction aggregates from one pair-serialized transaction.
--   Pagination uses the total (created_at, id) order so timestamp ties cannot
--   be skipped between pages.
--
-- Forward compensation: roll API readers back before removing this RPC in a
-- later forward migration. This function is read-only and creates no data.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.direct_messages:atomic-conversation-page:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic direct-message conversation-page migration lock is busy';
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
  v_pair_function regprocedure := pg_catalog.to_regprocedure(
    'public.serialize_direct_message_pair_edge()'
  );
  v_settings_function regprocedure := pg_catalog.to_regprocedure(
    'public.mutate_direct_message_conversation_settings_atomic(uuid,uuid,text,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean)'
  );
  v_send_function regprocedure := pg_catalog.to_regprocedure(
    'public.send_direct_message_atomic(uuid,uuid,text,text,text,text,uuid)'
  );
  v_delete_function regprocedure := pg_catalog.to_regprocedure(
    'public.delete_direct_message_atomic(uuid,uuid)'
  );
  v_reaction_function regprocedure := pg_catalog.to_regprocedure(
    'public.toggle_direct_message_reaction_atomic(uuid,uuid,uuid,text)'
  );
  v_page_function regprocedure := pg_catalog.to_regprocedure(
    'public.get_direct_message_conversation_page_atomic(uuid,uuid,timestamptz,uuid,integer)'
  );
  v_pair_source text;
  v_dependency regprocedure;
  v_dependency_source text;
  v_conversation_attnum smallint;
  v_member_user_attnum smallint;
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['anon', 'authenticated', 'service_role', 'postgres']::text[]
  ) AS required_role
  WHERE pg_catalog.to_regrole(required_role) IS NULL;

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION
      'direct-message conversation-page roles are missing: %',
      v_missing_roles;
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.conversations') IS NULL
     OR pg_catalog.to_regclass('public.conversation_members') IS NULL
     OR pg_catalog.to_regclass('public.direct_messages') IS NULL
     OR pg_catalog.to_regclass('public.message_reactions') IS NULL
     OR pg_catalog.to_regclass('public.blocked_users') IS NULL
     OR pg_catalog.to_regclass('public.user_follows') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.install_active_authenticated_subject_mutation_barriers()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.assert_active_authenticated_subject_mutation_barriers()'
     ) IS NULL
     OR v_pair_function IS NULL
     OR v_settings_function IS NULL
     OR v_send_function IS NULL
     OR v_delete_function IS NULL
     OR v_reaction_function IS NULL
  THEN
    RAISE EXCEPTION
      'canonical account, settings, and direct-message authorities must deploy first';
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
      'public.message_reactions'::regclass,
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
      'public.message_reactions'::regclass,
      'public.blocked_users'::regclass,
      'public.user_follows'::regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION
      'direct-message conversation-page requires canonical permanent relations';
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
      'public.message_reactions'::regclass,
      'public.blocked_users'::regclass,
      'public.user_follows'::regclass
    )
       OR inheritance.inhparent IN (
         'auth.users'::regclass,
         'public.user_profiles'::regclass,
         'public.conversations'::regclass,
         'public.conversation_members'::regclass,
         'public.direct_messages'::regclass,
         'public.message_reactions'::regclass,
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
      'public.message_reactions'::regclass,
      'public.blocked_users'::regclass,
      'public.user_follows'::regclass
    )
  ) THEN
    RAISE EXCEPTION
      'direct-message conversation-page relations cannot use inheritance or rewrite rules';
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
      ('public', 'conversation_members', 1, 'conversation_id', 'uuid'::regtype, true),
      ('public', 'conversation_members', 2, 'user_id', 'uuid'::regtype, true),
      ('public', 'conversation_members', 3, 'cleared_before', 'timestamptz'::regtype, false),
      ('public', 'direct_messages', 1, 'id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 2, 'conversation_id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 3, 'sender_id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 4, 'receiver_id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 5, 'content', 'text'::regtype, true),
      ('public', 'direct_messages', 6, 'read', 'boolean'::regtype, false),
      ('public', 'direct_messages', 7, 'read_at', 'timestamptz'::regtype, false),
      ('public', 'direct_messages', 8, 'created_at', 'timestamptz'::regtype, false),
      ('public', 'direct_messages', 9, 'deleted_at', 'timestamptz'::regtype, false),
      ('public', 'direct_messages', 10, 'media_url', 'text'::regtype, false),
      ('public', 'direct_messages', 11, 'media_type', 'text'::regtype, false),
      ('public', 'direct_messages', 12, 'media_name', 'text'::regtype, false),
      ('public', 'direct_messages', 13, 'reply_to_id', 'uuid'::regtype, false),
      ('public', 'message_reactions', 1, 'message_id', 'uuid'::regtype, true),
      ('public', 'message_reactions', 2, 'user_id', 'uuid'::regtype, true),
      ('public', 'message_reactions', 3, 'emoji', 'text'::regtype, true),
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
      'direct-message conversation-page has incompatible columns: %',
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
      'conversation page requires UNIQUE (conversation_id, user_id) settings';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.message_reactions'::regclass
      AND constraint_row.contype = 'u'
      AND constraint_row.convalidated
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.message_reactions'::regclass
            AND attribute.attname = 'message_id'
        ),
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.message_reactions'::regclass
            AND attribute.attname = 'user_id'
        ),
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.message_reactions'::regclass
            AND attribute.attname = 'emoji'
        )
      ]::smallint[]
  ) THEN
    RAISE EXCEPTION
      'conversation page requires UNIQUE (message_id, user_id, emoji) reactions';
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
    FROM public.conversation_members AS member_row
    GROUP BY member_row.conversation_id, member_row.user_id
    HAVING pg_catalog.count(*) > 1
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
    FROM public.message_reactions AS reaction
    LEFT JOIN public.direct_messages AS message_row
      ON message_row.id = reaction.message_id
    WHERE message_row.id IS NULL
       OR reaction.user_id NOT IN (
      message_row.sender_id,
      message_row.receiver_id
    )
  ) THEN
    RAISE EXCEPTION
      'direct-message conversation-page found non-canonical participant data';
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

  FOREACH v_dependency IN ARRAY ARRAY[
    v_settings_function,
    v_send_function,
    v_delete_function,
    v_reaction_function
  ]::regprocedure[] LOOP
    SELECT function_row.prosrc
    INTO STRICT v_dependency_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_dependency
      AND function_row.prokind = 'f'
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'jsonb'::regtype;

    IF pg_catalog.strpos(v_dependency_source, 'direct-message:pair:') = 0 THEN
      RAISE EXCEPTION
        'canonical direct-message writer lock contract drifted: %',
        v_dependency;
    END IF;
  END LOOP;

  SELECT function_row.prosrc
  INTO STRICT v_dependency_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_settings_function;

  IF pg_catalog.strpos(v_dependency_source, 'direct-message:settings:') = 0
     OR pg_catalog.strpos(
       v_dependency_source,
       'UPDATE public.conversation_members'
     ) = 0
     OR pg_catalog.strpos(
       v_dependency_source,
       'INSERT INTO public.conversation_members'
     ) = 0
  THEN
    RAISE EXCEPTION
      'canonical direct-message settings lock/write contract drifted';
  END IF;

  IF pg_catalog.has_table_privilege(
       'authenticated', 'public.direct_messages', 'INSERT,UPDATE,DELETE,TRUNCATE'
     ) OR pg_catalog.has_table_privilege(
       'anon', 'public.direct_messages', 'INSERT,UPDATE,DELETE,TRUNCATE'
     ) OR pg_catalog.has_table_privilege(
       'authenticated', 'public.message_reactions', 'INSERT,UPDATE,DELETE,TRUNCATE'
     ) OR pg_catalog.has_table_privilege(
       'anon', 'public.message_reactions', 'INSERT,UPDATE,DELETE,TRUNCATE'
     ) OR pg_catalog.has_table_privilege(
       'authenticated', 'public.conversation_members', 'INSERT,UPDATE,DELETE,TRUNCATE'
     ) OR pg_catalog.has_table_privilege(
       'anon', 'public.conversation_members', 'INSERT,UPDATE,DELETE,TRUNCATE'
     ) OR pg_catalog.has_table_privilege(
       'service_role', 'public.conversation_members', 'INSERT,UPDATE,DELETE,TRUNCATE'
     )
  THEN
    RAISE EXCEPTION
      'direct-message browser/settings write boundaries must remain revoked';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'get_direct_message_conversation_page_atomic'
      AND (
        v_page_function IS NULL
        OR function_row.oid <> v_page_function::oid
      )
  ) THEN
    RAISE EXCEPTION
      'ambiguous direct-message conversation-page overload exists';
  END IF;
END
$preflight$;

-- Hold dependency objects stable while publishing and attesting the reader.
LOCK TABLE auth.users,
  public.user_profiles,
  public.conversations,
  public.conversation_members,
  public.direct_messages,
  public.message_reactions,
  public.blocked_users,
  public.user_follows
  IN SHARE MODE;

CREATE OR REPLACE FUNCTION public.get_direct_message_conversation_page_atomic(
  p_conversation_id uuid,
  p_actor_id uuid,
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
  v_initial_user1_id uuid;
  v_initial_user2_id uuid;
  v_user1_id uuid;
  v_user2_id uuid;
  v_other_id uuid;
  v_identity_ids uuid[];
  v_locked_auth_ids uuid[] := ARRAY[]::uuid[];
  v_locked_profile_ids uuid[] := ARRAY[]::uuid[];
  v_identity_id uuid;
  v_identity record;
  v_profile record;
  v_actor_active boolean := false;
  v_participant_active boolean := false;
  v_other_handle text;
  v_other_avatar_url text;
  v_other_bio text;
  v_pair text;
  v_cleared_before timestamptz;
  v_messages jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_next_created_at timestamptz;
  v_next_id uuid;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_conversation_id IS NULL
     OR p_actor_id IS NULL
     OR p_limit IS NULL
     OR p_limit NOT BETWEEN 1 AND 100
     OR ((p_before_created_at IS NULL) <> (p_before_id IS NULL))
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  -- The first read only derives canonical lock keys. Membership and identity
  -- are revalidated after every lifecycle and pair writer is excluded.
  SELECT conversation.user1_id, conversation.user2_id
  INTO v_initial_user1_id, v_initial_user2_id
  FROM public.conversations AS conversation
  WHERE conversation.id = p_conversation_id;

  IF NOT FOUND
     OR v_initial_user1_id IS NULL
     OR v_initial_user2_id IS NULL
     OR v_initial_user1_id >= v_initial_user2_id
     OR p_actor_id NOT IN (v_initial_user1_id, v_initial_user2_id)
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'NOT_FOUND'
    );
  END IF;

  v_other_id := CASE
    WHEN p_actor_id = v_initial_user1_id THEN v_initial_user2_id
    ELSE v_initial_user1_id
  END;
  v_identity_ids := ARRAY[v_initial_user1_id, v_initial_user2_id]::uuid[];

  -- Canonical order: lifecycle admission -> auth parents -> unordered DM pair
  -- -> profiles -> conversation -> this actor's settings -> message children.
  FOREACH v_identity_id IN ARRAY v_identity_ids LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'account-recovery-admission:' || v_identity_id::text,
        0
      )
    );
  END LOOP;

  FOR v_identity IN
    SELECT auth_user.id
    FROM auth.users AS auth_user
    WHERE auth_user.id = ANY(v_identity_ids)
    ORDER BY auth_user.id
    FOR KEY SHARE
  LOOP
    v_locked_auth_ids := pg_catalog.array_append(
      v_locked_auth_ids,
      v_identity.id
    );
  END LOOP;

  IF NOT p_actor_id = ANY(v_locked_auth_ids) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;
  IF NOT v_other_id = ANY(v_locked_auth_ids) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'PARTICIPANT_UNAVAILABLE'
    );
  END IF;

  v_pair := v_initial_user1_id::text || ':' || v_initial_user2_id::text;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('direct-message:pair:' || v_pair, 0)
  );

  FOR v_profile IN
    SELECT
      profile.id,
      profile.handle,
      profile.avatar_url,
      profile.bio,
      profile.deleted_at,
      profile.banned_at,
      profile.is_banned,
      profile.ban_expires_at
    FROM public.user_profiles AS profile
    WHERE profile.id = ANY(v_identity_ids)
    ORDER BY profile.id
    FOR SHARE
  LOOP
    v_locked_profile_ids := pg_catalog.array_append(
      v_locked_profile_ids,
      v_profile.id
    );
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
      ELSIF v_profile.id = v_other_id THEN
        v_participant_active := true;
        v_other_handle := v_profile.handle;
        v_other_avatar_url := v_profile.avatar_url;
        v_other_bio := v_profile.bio;
      END IF;
    END IF;
  END LOOP;

  IF NOT p_actor_id = ANY(v_locked_profile_ids) OR NOT v_actor_active THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;
  IF NOT v_other_id = ANY(v_locked_profile_ids) OR NOT v_participant_active THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'PARTICIPANT_UNAVAILABLE'
    );
  END IF;

  SELECT conversation.user1_id, conversation.user2_id
  INTO v_user1_id, v_user2_id
  FROM public.conversations AS conversation
  WHERE conversation.id = p_conversation_id
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'NOT_FOUND'
    );
  END IF;
  IF v_user1_id IS DISTINCT FROM v_initial_user1_id
     OR v_user2_id IS DISTINCT FROM v_initial_user2_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'direct-message conversation identity changed while locking; retry';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'direct-message:settings:'
        || p_conversation_id::text || ':' || p_actor_id::text,
      0
    )
  );

  SELECT member_row.cleared_before
  INTO v_cleared_before
  FROM public.conversation_members AS member_row
  WHERE member_row.conversation_id = p_conversation_id
    AND member_row.user_id = p_actor_id
  FOR SHARE;

  WITH newest AS MATERIALIZED (
    SELECT
      message_row.id,
      message_row.sender_id,
      message_row.receiver_id,
      message_row.content,
      COALESCE(message_row.read, false) AS read,
      message_row.read_at,
      message_row.created_at,
      message_row.media_url,
      message_row.media_type,
      message_row.media_name,
      message_row.reply_to_id
    FROM public.direct_messages AS message_row
    WHERE message_row.conversation_id = p_conversation_id
      AND message_row.deleted_at IS NULL
      AND message_row.created_at IS NOT NULL
      AND (
        v_cleared_before IS NULL
        OR message_row.created_at > v_cleared_before
      )
      AND (
        p_before_created_at IS NULL
        OR message_row.created_at < p_before_created_at
        OR (
          message_row.created_at = p_before_created_at
          AND message_row.id < p_before_id
        )
      )
    ORDER BY message_row.created_at DESC, message_row.id DESC
    LIMIT p_limit + 1
  ),
  numbered AS MATERIALIZED (
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
          'sender_id', numbered.sender_id,
          'receiver_id', numbered.receiver_id,
          'content', numbered.content,
          'read', numbered.read,
          'read_at', numbered.read_at,
          'created_at', numbered.created_at,
          'media_url', numbered.media_url,
          'media_type', numbered.media_type,
          'media_name', numbered.media_name,
          'reply_to_id', numbered.reply_to_id,
          'reply_preview', reply_preview.value,
          'reactions', reaction_summary.value
        )
        ORDER BY numbered.created_at ASC, numbered.id ASC
      ) FILTER (WHERE numbered.page_position <= p_limit),
      '[]'::jsonb
    ),
    (
      pg_catalog.array_agg(
        numbered.created_at ORDER BY numbered.page_position
      ) FILTER (WHERE numbered.page_position <= p_limit)
    )[p_limit],
    (
      pg_catalog.array_agg(
        numbered.id ORDER BY numbered.page_position
      ) FILTER (WHERE numbered.page_position <= p_limit)
    )[p_limit]
  INTO STRICT
    v_has_more,
    v_messages,
    v_next_created_at,
    v_next_id
  FROM numbered
  LEFT JOIN LATERAL (
    SELECT pg_catalog.jsonb_build_object(
      'sender_id', parent_message.sender_id,
      'content', pg_catalog.left(parent_message.content, 120)
    ) AS value
    FROM public.direct_messages AS parent_message
    WHERE parent_message.id = numbered.reply_to_id
      AND parent_message.conversation_id = p_conversation_id
      AND parent_message.deleted_at IS NULL
      AND parent_message.created_at IS NOT NULL
      AND (
        v_cleared_before IS NULL
        OR parent_message.created_at > v_cleared_before
      )
  ) AS reply_preview ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'emoji', grouped_reaction.emoji,
          'count', grouped_reaction.reaction_count,
          'mine', grouped_reaction.mine
        )
        ORDER BY grouped_reaction.emoji
      ),
      '[]'::jsonb
    ) AS value
    FROM (
      SELECT
        reaction.emoji,
        pg_catalog.count(*)::integer AS reaction_count,
        pg_catalog.bool_or(reaction.user_id = p_actor_id) AS mine
      FROM public.message_reactions AS reaction
      WHERE reaction.message_id = numbered.id
        AND reaction.user_id IN (v_user1_id, v_user2_id)
      GROUP BY reaction.emoji
    ) AS grouped_reaction
  ) AS reaction_summary ON true;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'actor_id', p_actor_id,
    'conversation_id', p_conversation_id,
    'other_user', pg_catalog.jsonb_build_object(
      'id', v_other_id,
      'handle', v_other_handle,
      'avatar_url', v_other_avatar_url,
      'bio', v_other_bio
    ),
    'cleared_before', v_cleared_before,
    'messages', v_messages,
    'has_more', v_has_more,
    'next_cursor', CASE
      WHEN v_has_more THEN pg_catalog.jsonb_build_object(
        'before', v_next_created_at,
        'before_id', v_next_id
      )
      ELSE 'null'::jsonb
    END
  );
END
$function$;

ALTER FUNCTION public.get_direct_message_conversation_page_atomic(
  uuid, uuid, timestamptz, uuid, integer
) OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.get_direct_message_conversation_page_atomic(uuid,uuid,timestamptz,uuid,integer)'::regprocedure;
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
    ON FUNCTION public.get_direct_message_conversation_page_atomic(
      uuid, uuid, timestamptz, uuid, integer
    )
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.get_direct_message_conversation_page_atomic(
      uuid, uuid, timestamptz, uuid, integer
    )
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-direct-message-conversation-page:v1:'
      || pg_catalog.md5(v_source)
  );

  IF pg_catalog.strpos(v_source, 'account-recovery-admission:') = 0
     OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') = 0
     OR pg_catalog.strpos(v_source, 'direct-message:pair:') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.conversations AS conversation') = 0
     OR pg_catalog.strpos(v_source, 'direct-message:settings:') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.conversation_members AS member_row') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.direct_messages AS message_row') = 0
     OR pg_catalog.strpos(v_source, 'message_row.created_at = p_before_created_at') = 0
     OR pg_catalog.strpos(v_source, 'message_row.created_at > v_cleared_before') = 0
     OR pg_catalog.strpos(v_source, 'parent_message.deleted_at IS NULL') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.message_reactions AS reaction') = 0
  THEN
    RAISE EXCEPTION
      'atomic direct-message conversation-page function contract drifted';
  END IF;
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.get_direct_message_conversation_page_atomic(uuid,uuid,timestamptz,uuid,integer)'::regprocedure;
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
    AND function_row.pronargs = 5
    AND function_row.pronargdefaults = 0
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF pg_catalog.obj_description(v_function, 'pg_proc') IS DISTINCT FROM
       'atomic-direct-message-conversation-page:v1:'
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
           'get_direct_message_conversation_page_atomic'
         AND function_row.oid <> v_function
     )
  THEN
    RAISE EXCEPTION
      'direct-message conversation-page service-only RPC drifted';
  END IF;
END
$postflight$;

SELECT public.install_active_authenticated_subject_mutation_barriers();
SELECT public.assert_active_authenticated_subject_mutation_barriers();

NOTIFY pgrst, 'reload schema';

COMMIT;
