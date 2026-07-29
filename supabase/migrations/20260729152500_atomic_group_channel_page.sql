-- Migration: 20260729152500_atomic_group_channel_page.sql
-- Created: 2026-07-29T22:25:00Z
-- Description: Authorize current group-channel membership and return the
--   channel, roster, paginated messages, replies, reactions, and read marker
--   from one transaction that serializes with every canonical channel writer.
--
-- Forward compensation: roll API callers back before dropping this RPC. The
-- only write is a monotonic channel read marker. Use a forward DROP FUNCTION
-- migration to retire the boundary; reserve PITR for data recovery.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.channel_messages:atomic-group-page:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic group-channel page migration lock is busy';
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
  v_dependency regprocedure;
  v_dependency_source text;
  v_dependencies regprocedure[] := ARRAY[
    pg_catalog.to_regprocedure(
      'public.mutate_channel_member_atomic(uuid,uuid,uuid,text,text)'
    ),
    pg_catalog.to_regprocedure(
      'public.update_group_channel_metadata_atomic(uuid,uuid,text,boolean,text,boolean,text,boolean)'
    ),
    pg_catalog.to_regprocedure(
      'public.send_channel_message_atomic(uuid,uuid,text,text,text,text,uuid)'
    ),
    pg_catalog.to_regprocedure(
      'public.toggle_channel_message_reaction_atomic(uuid,uuid,uuid,text)'
    ),
    pg_catalog.to_regprocedure(
      'public.dissolve_group_channel_atomic(uuid,uuid)'
    )
  ]::regprocedure[];
  v_page_function regprocedure := pg_catalog.to_regprocedure(
    'public.get_group_channel_page_atomic(uuid,uuid,timestamptz,integer)'
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
    RAISE EXCEPTION 'group-channel page roles are missing: %', v_missing_roles;
  END IF;

  IF pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.chat_channels') IS NULL
     OR pg_catalog.to_regclass('public.channel_members') IS NULL
     OR pg_catalog.to_regclass('public.channel_messages') IS NULL
     OR pg_catalog.to_regclass('public.channel_message_reactions') IS NULL
     OR pg_catalog.to_regclass('public.channel_message_reads') IS NULL
  THEN
    RAISE EXCEPTION 'canonical group-channel page relations must deploy first';
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
      'public.channel_message_reactions'::regclass,
      'public.channel_message_reads'::regclass
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
      'public.channel_message_reactions'::regclass,
      'public.channel_message_reads'::regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION
      'group-channel page requires canonical permanent relation ownership';
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
      'public.channel_message_reactions'::regclass,
      'public.channel_message_reads'::regclass
    )
       OR inheritance.inhparent IN (
         'auth.users'::regclass,
         'public.user_profiles'::regclass,
         'public.chat_channels'::regclass,
         'public.channel_members'::regclass,
         'public.channel_messages'::regclass,
         'public.channel_message_reactions'::regclass,
         'public.channel_message_reads'::regclass
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
      'public.channel_message_reactions'::regclass,
      'public.channel_message_reads'::regclass
    )
  ) THEN
    RAISE EXCEPTION
      'group-channel page relations must not use inheritance or rewrite rules';
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
      ('public', 'user_profiles', 2, 'handle', 'text'::regtype, false),
      ('public', 'user_profiles', 3, 'avatar_url', 'text'::regtype, false),
      ('public', 'user_profiles', 4, 'deleted_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 5, 'banned_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 6, 'is_banned', 'boolean'::regtype, false),
      ('public', 'user_profiles', 7, 'ban_expires_at', 'timestamptz'::regtype, false),
      ('public', 'chat_channels', 1, 'id', 'uuid'::regtype, true),
      ('public', 'chat_channels', 2, 'name', 'text'::regtype, false),
      ('public', 'chat_channels', 3, 'type', 'text'::regtype, true),
      ('public', 'chat_channels', 4, 'created_by', 'uuid'::regtype, false),
      ('public', 'chat_channels', 5, 'avatar_url', 'text'::regtype, false),
      ('public', 'chat_channels', 6, 'description', 'text'::regtype, false),
      ('public', 'chat_channels', 7, 'created_at', 'timestamptz'::regtype, false),
      ('public', 'chat_channels', 8, 'updated_at', 'timestamptz'::regtype, false),
      ('public', 'channel_members', 1, 'channel_id', 'uuid'::regtype, true),
      ('public', 'channel_members', 2, 'user_id', 'uuid'::regtype, true),
      ('public', 'channel_members', 3, 'role', 'text'::regtype, true),
      ('public', 'channel_members', 4, 'nickname', 'text'::regtype, false),
      ('public', 'channel_members', 5, 'joined_at', 'timestamptz'::regtype, false),
      ('public', 'channel_messages', 1, 'id', 'uuid'::regtype, true),
      ('public', 'channel_messages', 2, 'channel_id', 'uuid'::regtype, true),
      ('public', 'channel_messages', 3, 'sender_id', 'uuid'::regtype, true),
      ('public', 'channel_messages', 4, 'content', 'text'::regtype, true),
      ('public', 'channel_messages', 5, 'media_url', 'text'::regtype, false),
      ('public', 'channel_messages', 6, 'media_type', 'text'::regtype, false),
      ('public', 'channel_messages', 7, 'media_name', 'text'::regtype, false),
      ('public', 'channel_messages', 8, 'created_at', 'timestamptz'::regtype, false),
      ('public', 'channel_messages', 9, 'reply_to_id', 'uuid'::regtype, false),
      ('public', 'channel_message_reactions', 1, 'message_id', 'uuid'::regtype, true),
      ('public', 'channel_message_reactions', 2, 'user_id', 'uuid'::regtype, true),
      ('public', 'channel_message_reactions', 3, 'emoji', 'text'::regtype, true),
      ('public', 'channel_message_reads', 1, 'channel_id', 'uuid'::regtype, true),
      ('public', 'channel_message_reads', 2, 'user_id', 'uuid'::regtype, true),
      ('public', 'channel_message_reads', 3, 'last_read_at', 'timestamptz'::regtype, false)
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
    RAISE EXCEPTION 'group-channel page has incompatible columns: %', v_invalid_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.channel_message_reads'::regclass
      AND constraint_row.contype IN ('p', 'u')
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.channel_message_reads'::regclass
            AND attribute.attname = 'channel_id'
        ),
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.channel_message_reads'::regclass
            AND attribute.attname = 'user_id'
        )
      ]::smallint[]
  ) THEN
    RAISE EXCEPTION 'channel_message_reads requires UNIQUE (channel_id, user_id)';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL OR (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure('auth.role()')
  ) <> 'text'::regtype THEN
    RAISE EXCEPTION 'auth.role() returning text must exist';
  END IF;

  IF pg_catalog.array_position(v_dependencies, NULL::regprocedure) IS NOT NULL THEN
    RAISE EXCEPTION 'canonical channel writer authorities must deploy first';
  END IF;

  FOREACH v_dependency IN ARRAY v_dependencies
  LOOP
    SELECT function_row.prosrc
    INTO STRICT v_dependency_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_dependency
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::regtype
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef;

    IF pg_catalog.strpos(
         v_dependency_source,
         $$'group-channel-owner-invariant:v1'$$
       ) = 0
       OR pg_catalog.strpos(
         v_dependency_source,
         $$'channel-membership:channel:'$$
       ) = 0
    THEN
      RAISE EXCEPTION 'canonical channel writer lock contract drifted: %', v_dependency;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'get_group_channel_page_atomic'
      AND function_row.oid IS DISTINCT FROM v_page_function
  ) THEN
    RAISE EXCEPTION 'incompatible get_group_channel_page_atomic overload exists';
  END IF;

  IF v_page_function IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_page_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 4
      AND function_row.pronargdefaults = 0
  ) THEN
    RAISE EXCEPTION 'existing get_group_channel_page_atomic signature is incompatible';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
    'service_role', 'public.user_profiles', 'SELECT'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.chat_channels', 'SELECT'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.channel_members', 'SELECT'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.channel_messages', 'SELECT'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.channel_message_reactions', 'SELECT'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.channel_message_reads', 'SELECT'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.channel_message_reads', 'INSERT'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.channel_message_reads', 'UPDATE'
  ) THEN
    RAISE EXCEPTION 'group-channel page service authority drifted';
  END IF;
END
$preflight$;

LOCK TABLE auth.users,
  public.user_profiles,
  public.chat_channels,
  public.channel_members,
  public.channel_messages,
  public.channel_message_reactions,
  public.channel_message_reads
  IN SHARE MODE;

CREATE OR REPLACE FUNCTION public.get_group_channel_page_atomic(
  p_actor_id uuid,
  p_channel_id uuid,
  p_before timestamptz,
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
  v_observed_channel record;
  v_channel record;
  v_observed_channel_found boolean := false;
  v_channel_found boolean := false;
  v_auth_ids uuid[] := ARRAY[]::uuid[];
  v_locked_auth_ids uuid[] := ARRAY[]::uuid[];
  v_user_id uuid;
  v_member record;
  v_actor_role text;
  v_actor_profile public.user_profiles%ROWTYPE;
  v_actor_profile_found boolean := false;
  v_channel_json jsonb;
  v_members jsonb := '[]'::jsonb;
  v_messages jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_requested_read_at timestamptz := pg_catalog.statement_timestamp();
  v_read_at timestamptz;
  v_read_count integer := 0;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_actor_id IS NULL
     OR p_channel_id IS NULL
     OR p_limit IS NULL
     OR p_limit NOT BETWEEN 1 AND 50
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  -- Every canonical mutation takes these locks in this order. The shared
  -- membership side makes the complete page linearize either before or after
  -- removal, dissolution, metadata changes, sends, and reaction toggles.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('group-channel-owner-invariant:v1', 0)
  );

  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'channel-membership:channel:' || p_channel_id::text,
      0
    )
  );

  SELECT
    channel_row.type,
    channel_row.created_by,
    channel_row.xmin::text || ':' || channel_row.ctid::text AS row_token
  INTO v_observed_channel
  FROM public.chat_channels AS channel_row
  WHERE channel_row.id = p_channel_id;
  v_observed_channel_found := FOUND;

  SELECT pg_catalog.array_agg(identity_id ORDER BY identity_id)
  INTO STRICT v_auth_ids
  FROM (
    SELECT p_actor_id AS identity_id
    UNION
    SELECT v_observed_channel.created_by
    WHERE v_observed_channel.created_by IS NOT NULL
  ) AS identity;

  FOR v_user_id IN
    SELECT auth_user.id
    FROM auth.users AS auth_user
    WHERE auth_user.id = ANY(v_auth_ids)
    ORDER BY auth_user.id
    FOR SHARE
  LOOP
    v_locked_auth_ids := pg_catalog.array_append(v_locked_auth_ids, v_user_id);
  END LOOP;

  IF NOT p_actor_id = ANY(v_locked_auth_ids) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;

  SELECT
    channel_row.*,
    channel_row.xmin::text || ':' || channel_row.ctid::text AS row_token
  INTO v_channel
  FROM public.chat_channels AS channel_row
  WHERE channel_row.id = p_channel_id
  FOR SHARE;
  v_channel_found := FOUND;

  IF NOT v_observed_channel_found THEN
    IF v_channel_found THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'channel identity appeared while locking; retry';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'CHANNEL_NOT_FOUND'
    );
  END IF;

  IF NOT v_channel_found
     OR v_channel.type IS DISTINCT FROM v_observed_channel.type
     OR v_channel.created_by IS DISTINCT FROM v_observed_channel.created_by
     OR v_channel.row_token IS DISTINCT FROM v_observed_channel.row_token
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'channel identity changed while locking; retry';
  END IF;

  IF v_channel.type IS DISTINCT FROM 'group' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'CHANNEL_NOT_GROUP'
    );
  END IF;

  -- Lock the full roster in canonical UUID order and derive access only from
  -- those locked rows. A committed removal therefore cannot leave stale read
  -- authority behind this point.
  FOR v_member IN
    SELECT membership.user_id, membership.role
    FROM public.channel_members AS membership
    WHERE membership.channel_id = p_channel_id
    ORDER BY membership.user_id
    FOR SHARE
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

  v_channel_json := pg_catalog.jsonb_build_object(
    'id', v_channel.id,
    'name', v_channel.name,
    'avatar_url', v_channel.avatar_url,
    'description', v_channel.description,
    'type', v_channel.type,
    'created_by', v_channel.created_by,
    'created_at', v_channel.created_at,
    'updated_at', v_channel.updated_at
  );

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'user_id', membership.user_id,
        'role', membership.role,
        'nickname', membership.nickname,
        'joined_at', membership.joined_at,
        'handle', profile.handle,
        'avatar_url', profile.avatar_url
      )
      ORDER BY membership.user_id
    ),
    '[]'::jsonb
  )
  INTO STRICT v_members
  FROM public.channel_members AS membership
  LEFT JOIN public.user_profiles AS profile
    ON profile.id = membership.user_id
  WHERE membership.channel_id = p_channel_id;

  WITH newest AS (
    SELECT
      message_row.id,
      message_row.sender_id,
      message_row.content,
      message_row.media_url,
      message_row.media_type,
      message_row.media_name,
      message_row.created_at,
      message_row.reply_to_id
    FROM public.channel_messages AS message_row
    WHERE message_row.channel_id = p_channel_id
      AND (p_before IS NULL OR message_row.created_at < p_before)
    ORDER BY message_row.created_at DESC NULLS LAST, message_row.id DESC
    LIMIT p_limit + 1
  ),
  numbered AS (
    SELECT
      newest.*,
      pg_catalog.row_number() OVER (
        ORDER BY newest.created_at DESC NULLS LAST, newest.id DESC
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
          'content', numbered.content,
          'media_url', numbered.media_url,
          'media_type', numbered.media_type,
          'media_name', numbered.media_name,
          'created_at', numbered.created_at,
          'reply_to_id', numbered.reply_to_id,
          'reply_preview', reply_preview.value,
          'reactions', reaction_summary.value
        )
        ORDER BY numbered.created_at ASC NULLS FIRST, numbered.id ASC
      ) FILTER (WHERE numbered.page_position <= p_limit),
      '[]'::jsonb
    )
  INTO STRICT v_has_more, v_messages
  FROM numbered
  LEFT JOIN LATERAL (
    SELECT pg_catalog.jsonb_build_object(
      'sender_id', parent_message.sender_id,
      'content', pg_catalog.left(parent_message.content, 120)
    ) AS value
    FROM public.channel_messages AS parent_message
    WHERE parent_message.id = numbered.reply_to_id
      AND parent_message.channel_id = p_channel_id
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
      FROM public.channel_message_reactions AS reaction
      WHERE reaction.message_id = numbered.id
      GROUP BY reaction.emoji
    ) AS grouped_reaction
  ) AS reaction_summary ON true;

  INSERT INTO public.channel_message_reads AS read_marker (
    channel_id,
    user_id,
    last_read_at
  ) VALUES (
    p_channel_id,
    p_actor_id,
    v_requested_read_at
  )
  ON CONFLICT (channel_id, user_id) DO UPDATE
  SET last_read_at = CASE
    WHEN read_marker.last_read_at IS NULL
      OR read_marker.last_read_at < EXCLUDED.last_read_at
    THEN EXCLUDED.last_read_at
    ELSE read_marker.last_read_at
  END
  RETURNING read_marker.last_read_at INTO v_read_at;
  GET DIAGNOSTICS v_read_count = ROW_COUNT;

  IF v_read_count <> 1
     OR v_read_at IS NULL
     OR v_read_at < v_requested_read_at
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'group-channel read-marker acknowledgement is incomplete';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'actor_id', p_actor_id,
    'channel_id', p_channel_id,
    'channel', v_channel_json,
    'members', v_members,
    'messages', v_messages,
    'has_more', v_has_more,
    'my_role', v_actor_role,
    'read_at', v_read_at
  );
END
$function$;

ALTER FUNCTION public.get_group_channel_page_atomic(
  uuid, uuid, timestamptz, integer
) OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.get_group_channel_page_atomic(uuid,uuid,timestamptz,integer)'::regprocedure;
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
    ON FUNCTION public.get_group_channel_page_atomic(
      uuid, uuid, timestamptz, integer
    )
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.get_group_channel_page_atomic(
      uuid, uuid, timestamptz, integer
    )
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-group-channel-page:v1:' || pg_catalog.md5(v_source)
  );
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.get_group_channel_page_atomic(uuid,uuid,timestamptz,integer)'::regprocedure;
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
       'atomic-group-channel-page:v1:' || pg_catalog.md5(v_source)
     OR pg_catalog.strpos(v_source, $$'group-channel-owner-invariant:v1'$$) = 0
     OR pg_catalog.strpos(v_source, $$'channel-membership:channel:'$$) = 0
     OR pg_catalog.strpos(v_source, 'pg_advisory_xact_lock_shared') = 0
     OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.channel_members AS membership') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.channel_messages AS message_row') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.channel_message_reactions AS reaction') = 0
     OR pg_catalog.strpos(v_source, 'INSERT INTO public.channel_message_reads') = 0
  THEN
    RAISE EXCEPTION 'atomic group-channel page body attestation failed';
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
    RAISE EXCEPTION 'atomic group-channel page ACL attestation failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
