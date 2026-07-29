-- Migration: 20260729135645_atomic_channel_message_send.sql
-- Created: 2026-07-29T20:56:45Z
-- Description: Authorize channel membership, validate an optional reply,
--   insert the message, and advance the sender read marker atomically.
--
-- Forward compensation: roll API callers back before dropping this RPC. This
-- migration changes no message data. Use a forward DROP FUNCTION migration to
-- retire the boundary; reserve PITR for data recovery.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.channel_messages:atomic-send:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic channel-message send migration lock is busy';
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
  v_summary_function regprocedure := pg_catalog.to_regprocedure(
    'public.update_channel_last_message()'
  );
  v_send_function regprocedure := pg_catalog.to_regprocedure(
    'public.send_channel_message_atomic(uuid,uuid,text,text,text,text,uuid)'
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
    RAISE EXCEPTION 'channel-message roles are missing: %', v_missing_roles;
  END IF;

  IF pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.chat_channels') IS NULL
     OR pg_catalog.to_regclass('public.channel_members') IS NULL
     OR pg_catalog.to_regclass('public.channel_messages') IS NULL
     OR pg_catalog.to_regclass('public.channel_message_reads') IS NULL
  THEN
    RAISE EXCEPTION 'canonical channel-message relations must deploy first';
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
      'public.channel_message_reads'::regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION
      'channel-message send requires canonical permanent relation ownership';
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
      'public.channel_message_reads'::regclass
    )
       OR inheritance.inhparent IN (
         'auth.users'::regclass,
         'public.user_profiles'::regclass,
         'public.chat_channels'::regclass,
         'public.channel_members'::regclass,
         'public.channel_messages'::regclass,
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
      'public.channel_message_reads'::regclass
    )
  ) THEN
    RAISE EXCEPTION
      'channel-message relations must not use inheritance or rewrite rules';
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
      ('public', 'chat_channels', 4, 'last_message_at', 'timestamptz'::regtype, false),
      ('public', 'chat_channels', 5, 'last_message_preview', 'text'::regtype, false),
      ('public', 'chat_channels', 6, 'updated_at', 'timestamptz'::regtype, false),
      ('public', 'channel_members', 1, 'channel_id', 'uuid'::regtype, true),
      ('public', 'channel_members', 2, 'user_id', 'uuid'::regtype, true),
      ('public', 'channel_members', 3, 'role', 'text'::regtype, true),
      ('public', 'channel_messages', 1, 'id', 'uuid'::regtype, true),
      ('public', 'channel_messages', 2, 'channel_id', 'uuid'::regtype, true),
      ('public', 'channel_messages', 3, 'sender_id', 'uuid'::regtype, true),
      ('public', 'channel_messages', 4, 'content', 'text'::regtype, true),
      ('public', 'channel_messages', 5, 'media_url', 'text'::regtype, false),
      ('public', 'channel_messages', 6, 'media_type', 'text'::regtype, false),
      ('public', 'channel_messages', 7, 'media_name', 'text'::regtype, false),
      ('public', 'channel_messages', 8, 'created_at', 'timestamptz'::regtype, false),
      ('public', 'channel_messages', 9, 'reply_to_id', 'uuid'::regtype, false),
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
    RAISE EXCEPTION 'channel-message send has incompatible columns: %', v_invalid_columns;
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.channel_messages'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 9 THEN
    RAISE EXCEPTION 'channel_messages row shape drifted';
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

  IF v_summary_function IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_summary_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'trigger'::regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 0
  ) THEN
    RAISE EXCEPTION 'channel last-message trigger function must deploy first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'update_channel_last_message'
      AND function_row.oid IS DISTINCT FROM v_summary_function
  ) THEN
    RAISE EXCEPTION 'incompatible update_channel_last_message overload exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'send_channel_message_atomic'
      AND function_row.oid IS DISTINCT FROM v_send_function
  ) THEN
    RAISE EXCEPTION 'incompatible send_channel_message_atomic overload exists';
  END IF;

  IF v_send_function IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_send_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 7
  ) THEN
    RAISE EXCEPTION 'existing send_channel_message_atomic signature is incompatible';
  END IF;

  IF pg_catalog.has_table_privilege(
    'anon', 'public.channel_messages', 'INSERT'
  ) OR pg_catalog.has_table_privilege(
    'authenticated', 'public.channel_messages', 'INSERT'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.channel_messages', 'SELECT'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.channel_messages', 'INSERT'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.channel_members', 'SELECT'
  ) THEN
    RAISE EXCEPTION 'channel-message service-only write boundary drifted';
  END IF;
END
$preflight$;

LOCK TABLE auth.users,
  public.user_profiles,
  public.chat_channels,
  public.channel_members,
  public.channel_messages,
  public.channel_message_reads
  IN SHARE MODE;

-- The legacy trigger used unqualified relations and inherited the caller's
-- search_path. Atomic RPCs deliberately remove public from search_path, so the
-- trigger must be fixed-path and fully qualified before the first RPC insert.
CREATE OR REPLACE FUNCTION public.update_channel_last_message()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
     OR TG_TABLE_NAME IS DISTINCT FROM 'channel_messages'
     OR TG_OP IS DISTINCT FROM 'INSERT'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'channel last-message summary trigger is misattached';
  END IF;

  UPDATE public.chat_channels AS channel_row
  SET last_message_at = NEW.created_at,
      last_message_preview = pg_catalog.left(NEW.content, 100),
      updated_at = pg_catalog.clock_timestamp()
  WHERE channel_row.id = NEW.channel_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'channel last-message parent is unavailable';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.update_channel_last_message() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_channel_message_update
  ON public.channel_messages;
CREATE TRIGGER trg_channel_message_update
AFTER INSERT
ON public.channel_messages
FOR EACH ROW
EXECUTE FUNCTION public.update_channel_last_message();

CREATE OR REPLACE FUNCTION public.send_channel_message_atomic(
  p_channel_id uuid,
  p_sender_id uuid,
  p_content text,
  p_media_url text DEFAULT NULL,
  p_media_type text DEFAULT NULL,
  p_media_name text DEFAULT NULL,
  p_reply_to_id uuid DEFAULT NULL
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
  v_reply_author_id uuid;
  v_message public.channel_messages%ROWTYPE;
  v_message_count integer := 0;
  v_read_at timestamptz;
  v_read_count integer := 0;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_channel_id IS NULL
     OR p_sender_id IS NULL
     OR p_content IS NULL
     OR p_content IS DISTINCT FROM pg_catalog.btrim(p_content)
     OR pg_catalog.char_length(p_content) > 2000
     OR (p_content = '' AND p_media_url IS NULL)
     OR (
       p_media_url IS NULL
       AND (p_media_type IS NOT NULL OR p_media_name IS NOT NULL)
     )
     OR (
       p_media_url IS NOT NULL
       AND (
         p_media_url IS DISTINCT FROM pg_catalog.btrim(p_media_url)
         OR pg_catalog.char_length(p_media_url) > 2000
         OR p_media_url !~ '^https://[^[:space:]]+$'
         OR p_media_type IS NULL
         OR p_media_type NOT IN ('image', 'video', 'file')
         OR (
           p_media_name IS NOT NULL
           AND (
             p_media_name IS DISTINCT FROM pg_catalog.btrim(p_media_name)
             OR pg_catalog.char_length(p_media_name) NOT BETWEEN 1 AND 255
           )
         )
       )
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
    SELECT p_sender_id AS identity_id
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

  IF NOT p_sender_id = ANY(v_locked_auth_ids) THEN
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
  FOR UPDATE;
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
    IF v_member.user_id = p_sender_id THEN
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
  WHERE profile.id = p_sender_id
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

  IF p_reply_to_id IS NOT NULL THEN
    SELECT parent_message.sender_id
    INTO v_reply_author_id
    FROM public.channel_messages AS parent_message
    WHERE parent_message.id = p_reply_to_id
      AND parent_message.channel_id = p_channel_id
    FOR SHARE;

    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'INVALID_REPLY_TARGET'
      );
    END IF;
  END IF;

  INSERT INTO public.channel_messages (
    channel_id,
    sender_id,
    content,
    media_url,
    media_type,
    media_name,
    reply_to_id
  ) VALUES (
    p_channel_id,
    p_sender_id,
    p_content,
    p_media_url,
    p_media_type,
    p_media_name,
    p_reply_to_id
  )
  RETURNING * INTO v_message;
  GET DIAGNOSTICS v_message_count = ROW_COUNT;

  IF v_message_count <> 1
     OR v_message.id IS NULL
     OR v_message.channel_id IS DISTINCT FROM p_channel_id
     OR v_message.sender_id IS DISTINCT FROM p_sender_id
     OR v_message.content IS DISTINCT FROM p_content
     OR v_message.media_url IS DISTINCT FROM p_media_url
     OR v_message.media_type IS DISTINCT FROM p_media_type
     OR v_message.media_name IS DISTINCT FROM p_media_name
     OR v_message.reply_to_id IS DISTINCT FROM p_reply_to_id
     OR v_message.created_at IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'channel message insert acknowledgement is incomplete';
  END IF;

  INSERT INTO public.channel_message_reads AS read_marker (
    channel_id,
    user_id,
    last_read_at
  ) VALUES (
    p_channel_id,
    p_sender_id,
    v_message.created_at
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
     OR v_read_at < v_message.created_at
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'channel read-marker acknowledgement is incomplete';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'actor_id', p_sender_id,
    'channel_id', p_channel_id,
    'message', pg_catalog.to_jsonb(v_message),
    'reply_author_id', v_reply_author_id,
    'read_at', v_read_at
  );
END
$function$;

ALTER FUNCTION public.send_channel_message_atomic(
  uuid, uuid, text, text, text, text, uuid
) OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_send_function regprocedure :=
    'public.send_channel_message_atomic(uuid,uuid,text,text,text,text,uuid)'::regprocedure;
  v_summary_function regprocedure :=
    'public.update_channel_last_message()'::regprocedure;
  v_function regprocedure;
  v_owner oid;
  v_grantee record;
  v_source text;
  v_contract text;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[v_send_function, v_summary_function]::regprocedure[]
  LOOP
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

    v_contract := CASE v_function
      WHEN v_send_function THEN 'atomic-channel-message-send:v1:'
      ELSE 'channel-last-message-summary:v1:'
    END;
    EXECUTE pg_catalog.format(
      'COMMENT ON FUNCTION %s IS %L',
      v_function,
      v_contract || pg_catalog.md5(v_source)
    );
  END LOOP;

  REVOKE ALL PRIVILEGES
    ON FUNCTION public.send_channel_message_atomic(
      uuid, uuid, text, text, text, text, uuid
    )
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.send_channel_message_atomic(
      uuid, uuid, text, text, text, text, uuid
    )
    TO service_role;

  REVOKE ALL PRIVILEGES
    ON FUNCTION public.update_channel_last_message()
    FROM PUBLIC, anon, authenticated, service_role;
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_send_function regprocedure :=
    'public.send_channel_message_atomic(uuid,uuid,text,text,text,text,uuid)'::regprocedure;
  v_summary_function regprocedure :=
    'public.update_channel_last_message()'::regprocedure;
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
  v_send_source text;
  v_summary_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_send_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_send_function
    AND function_row.prokind = 'f'
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prorettype = 'jsonb'::regtype
    AND NOT function_row.proretset
    AND function_row.pronargs = 7
    AND function_row.pronargdefaults = 4
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  SELECT function_row.prosrc
  INTO STRICT v_summary_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_summary_function
    AND function_row.prokind = 'f'
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prorettype = 'trigger'::regtype
    AND NOT function_row.proretset
    AND function_row.pronargs = 0
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF pg_catalog.obj_description(v_send_function, 'pg_proc') IS DISTINCT FROM
       'atomic-channel-message-send:v1:' || pg_catalog.md5(v_send_source)
     OR pg_catalog.strpos(v_send_source, $$'group-channel-owner-invariant:v1'$$) = 0
     OR pg_catalog.strpos(v_send_source, $$'channel-membership:channel:'$$) = 0
     OR pg_catalog.strpos(v_send_source, 'FROM auth.users') = 0
     OR pg_catalog.strpos(v_send_source, 'FROM public.channel_members') = 0
     OR pg_catalog.strpos(v_send_source, 'INSERT INTO public.channel_messages') = 0
     OR pg_catalog.strpos(v_send_source, 'INSERT INTO public.channel_message_reads') = 0
     OR pg_catalog.obj_description(v_summary_function, 'pg_proc') IS DISTINCT FROM
       'channel-last-message-summary:v1:' || pg_catalog.md5(v_summary_source)
     OR pg_catalog.strpos(v_summary_source, 'UPDATE public.chat_channels') = 0
  THEN
    RAISE EXCEPTION 'atomic channel-message body attestation failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.channel_messages'::regclass
      AND trigger_row.tgname = 'trg_channel_message_update'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgfoid = v_summary_function
  ) THEN
    RAISE EXCEPTION 'channel last-message trigger attestation failed';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    'service_role', v_send_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', v_send_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_send_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role', v_summary_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', v_summary_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_summary_function, 'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid IN (v_send_function, v_summary_function)
      AND acl_entry.grantee <> function_row.proowner
      AND NOT (
        function_row.oid = v_send_function
        AND acl_entry.grantee = v_service_oid
        AND acl_entry.privilege_type = 'EXECUTE'
        AND NOT acl_entry.is_grantable
      )
  ) THEN
    RAISE EXCEPTION 'atomic channel-message ACL attestation failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
