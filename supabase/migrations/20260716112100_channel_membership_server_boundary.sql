-- Channel membership is application-authorized server state. Every current
-- channel route authenticates the actor and uses the service-role client, so
-- browser JWTs must not read or mutate the base membership/channel records or
-- write channel message/reaction rows directly.
--
-- Direct-message permission checks also accept an explicit sender UUID. Keep
-- that RPC behind the service boundary so a browser cannot probe another
-- user's block, follow, reply, or message-count relationship by forging the
-- sender argument.
--
-- Authenticated channel pages still consume channel message/reaction Realtime
-- events. Preserve that read path with a SECURITY DEFINER membership predicate
-- whose actor is derived only from auth.uid(); no caller-supplied user UUID can
-- influence the decision.
--
-- Rollout dependency: deploy the current server-admin channel/message routes
-- before applying this migration. Applying the ACL first fails closed but will
-- break any older browser-client build that still writes these tables or
-- invokes check_dm_permission directly.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'public.chat_channels+channel_members:server-boundary',
    0
  )
);

-- Refuse to install only part of the boundary on a drifted schema. Besides the
-- route-facing columns, require every index used by membership authorization
-- and by the DM privacy decision. A missing index here is a security/reliability
-- deployment error, not a reason to publish an unbounded SECURITY DEFINER RPC.
DO $preflight$
DECLARE
  v_relation_name text;
  v_relation regclass;
  v_invalid_columns text[];
  v_missing_roles text[];
  v_missing_indexes text[] := ARRAY[]::text[];
  v_dm_function regprocedure := pg_catalog.to_regprocedure(
    'public.check_dm_permission(uuid,uuid)'
  );
  v_function_count integer;
  v_membership_function regprocedure := pg_catalog.to_regprocedure(
    'public.is_current_user_channel_member(uuid)'
  );
  v_membership_function_count integer;
BEGIN
  FOREACH v_relation_name IN ARRAY ARRAY[
    'chat_channels',
    'channel_members',
    'channel_messages',
    'channel_message_reactions',
    'user_profiles',
    'blocked_users',
    'user_follows',
    'direct_messages'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('public.%I', v_relation_name)
    );

    IF v_relation IS NULL THEN
      RAISE EXCEPTION
        'public.% must exist before channel boundary hardening',
        v_relation_name;
    END IF;

    IF (
      SELECT relation.relkind
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
    ) NOT IN ('r', 'p') THEN
      RAISE EXCEPTION
        'public.% must be a table or partitioned table',
        v_relation_name;
    END IF;
  END LOOP;

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
    RAISE EXCEPTION
      'channel boundary roles are missing: %',
      v_missing_roles;
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
    OR pg_catalog.to_regprocedure('auth.uid()') IS NULL
  THEN
    RAISE EXCEPTION
      'auth.role() and auth.uid() must exist before installing the channel boundary';
  END IF;

  IF (
    SELECT procedure.prorettype
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = pg_catalog.to_regprocedure('auth.role()')
  ) <> 'text'::regtype THEN
    RAISE EXCEPTION 'auth.role() must return text';
  END IF;

  IF (
    SELECT procedure.prorettype
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = pg_catalog.to_regprocedure('auth.uid()')
  ) <> 'uuid'::regtype THEN
    RAISE EXCEPTION 'auth.uid() must return uuid';
  END IF;

  SELECT pg_catalog.array_agg(
    pg_catalog.format(
      'public.%I.%I (expected %s%s)',
      required_column.table_name,
      required_column.column_name,
      required_column.type_name,
      CASE
        WHEN required_column.required_not_null THEN ' NOT NULL'
        ELSE ''
      END
    )
    ORDER BY required_column.table_name, required_column.ordinality
  )
  INTO v_invalid_columns
  FROM (
    VALUES
      ('chat_channels', 1, 'id', 'uuid', true),
      ('chat_channels', 2, 'name', 'text', false),
      ('chat_channels', 3, 'type', 'text', true),
      ('chat_channels', 4, 'created_by', 'uuid', false),
      ('chat_channels', 5, 'avatar_url', 'text', false),
      ('chat_channels', 6, 'description', 'text', false),
      ('chat_channels', 7, 'conversation_id', 'uuid', false),
      ('chat_channels', 8, 'last_message_at', 'timestamp with time zone', false),
      ('chat_channels', 9, 'last_message_preview', 'text', false),
      ('chat_channels', 10, 'created_at', 'timestamp with time zone', false),
      ('chat_channels', 11, 'updated_at', 'timestamp with time zone', false),
      ('channel_members', 1, 'id', 'uuid', true),
      ('channel_members', 2, 'channel_id', 'uuid', true),
      ('channel_members', 3, 'user_id', 'uuid', true),
      ('channel_members', 4, 'role', 'text', true),
      ('channel_members', 5, 'nickname', 'text', false),
      ('channel_members', 6, 'is_muted', 'boolean', false),
      ('channel_members', 7, 'is_pinned', 'boolean', false),
      ('channel_members', 8, 'cleared_before', 'timestamp with time zone', false),
      ('channel_members', 9, 'joined_at', 'timestamp with time zone', false),
      ('channel_messages', 1, 'id', 'uuid', true),
      ('channel_messages', 2, 'channel_id', 'uuid', true),
      ('channel_messages', 3, 'sender_id', 'uuid', true),
      ('channel_messages', 4, 'content', 'text', true),
      ('channel_messages', 5, 'media_url', 'text', false),
      ('channel_messages', 6, 'media_type', 'text', false),
      ('channel_messages', 7, 'media_name', 'text', false),
      ('channel_messages', 8, 'created_at', 'timestamp with time zone', false),
      ('channel_messages', 9, 'reply_to_id', 'uuid', false),
      ('channel_message_reactions', 1, 'id', 'uuid', true),
      ('channel_message_reactions', 2, 'message_id', 'uuid', true),
      ('channel_message_reactions', 3, 'user_id', 'uuid', true),
      ('channel_message_reactions', 4, 'emoji', 'text', true),
      ('channel_message_reactions', 5, 'created_at', 'timestamp with time zone', false),
      ('user_profiles', 1, 'id', 'uuid', true),
      ('user_profiles', 2, 'dm_permission', 'text', false),
      ('user_profiles', 3, 'deleted_at', 'timestamp with time zone', false),
      ('user_profiles', 4, 'banned_at', 'timestamp with time zone', false),
      ('blocked_users', 1, 'blocker_id', 'uuid', true),
      ('blocked_users', 2, 'blocked_id', 'uuid', true),
      ('user_follows', 1, 'follower_id', 'uuid', true),
      ('user_follows', 2, 'following_id', 'uuid', true),
      ('direct_messages', 1, 'sender_id', 'uuid', true),
      ('direct_messages', 2, 'receiver_id', 'uuid', true)
  ) AS required_column(
    table_name,
    ordinality,
    column_name,
    type_name,
    required_not_null
  )
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = pg_catalog.to_regclass(
      pg_catalog.format('public.%I', required_column.table_name)
    )
   AND attribute.attname = required_column.column_name
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  WHERE attribute.attname IS NULL
     OR pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
          <> required_column.type_name
     OR (
       required_column.required_not_null
       AND NOT attribute.attnotnull
     );

  IF v_invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'channel boundary has missing or incompatible columns: %',
      v_invalid_columns;
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_function_count
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'public'
    AND procedure.proname = 'check_dm_permission';

  IF v_dm_function IS NULL OR v_function_count <> 1 THEN
    RAISE EXCEPTION
      'exactly one public.check_dm_permission(uuid, uuid) function is required';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_dm_function
      AND (
        procedure.prokind <> 'f'
        OR procedure.prorettype <> 'jsonb'::regtype
        OR procedure.proretset
        OR procedure.proargnames IS DISTINCT FROM
          ARRAY['p_sender_id', 'p_receiver_id']::text[]
      )
  ) THEN
    RAISE EXCEPTION
      'public.check_dm_permission has an incompatible parameter or return contract';
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_membership_function_count
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'public'
    AND procedure.proname = 'is_current_user_channel_member';

  IF v_membership_function_count > 1 OR (
    v_membership_function_count = 1
    AND v_membership_function IS NULL
  ) THEN
    RAISE EXCEPTION
      'public.is_current_user_channel_member must be absent or have only the canonical uuid signature';
  END IF;

  IF v_membership_function IS NOT NULL AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_membership_function
      AND (
        procedure.prokind <> 'f'
        OR procedure.prorettype <> 'boolean'::regtype
        OR procedure.proretset
        OR procedure.proargnames IS DISTINCT FROM
          ARRAY['p_channel_id']::text[]
      )
  ) THEN
    RAISE EXCEPTION
      'public.is_current_user_channel_member has an incompatible parameter or return contract';
  END IF;

  -- Primary/owner lookup keys.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = 'public.chat_channels'::regclass
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 1
      AND index_metadata.indnatts = 1
      AND (
        SELECT attribute.attname
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.ordinality = 1
      ) = 'id'
  ) THEN
    v_missing_indexes := pg_catalog.array_append(
      v_missing_indexes,
      'chat_channels UNIQUE (id)'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = 'public.user_profiles'::regclass
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 1
      AND index_metadata.indnatts = 1
      AND (
        SELECT attribute.attname
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.ordinality = 1
      ) = 'id'
  ) THEN
    v_missing_indexes := pg_catalog.array_append(
      v_missing_indexes,
      'user_profiles UNIQUE (id)'
    );
  END IF;

  -- Channel routes use both user-first discovery and channel-first membership
  -- authorization, while member upserts require the exact unique owner pair.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = 'public.channel_members'::regclass
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 2
      AND index_metadata.indnatts = 2
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname
          ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['channel_id', 'user_id']::name[]
  ) THEN
    v_missing_indexes := pg_catalog.array_append(
      v_missing_indexes,
      'channel_members UNIQUE (channel_id, user_id)'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = 'public.channel_members'::regclass
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts >= 1
      AND (
        SELECT attribute.attname
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.ordinality = 1
      ) = 'user_id'
  ) THEN
    v_missing_indexes := pg_catalog.array_append(
      v_missing_indexes,
      'channel_members (user_id, ...)'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = 'public.channel_members'::regclass
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts >= 1
      AND (
        SELECT attribute.attname
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.ordinality = 1
      ) = 'channel_id'
  ) THEN
    v_missing_indexes := pg_catalog.array_append(
      v_missing_indexes,
      'channel_members (channel_id, ...)'
    );
  END IF;

  -- Block lookup must be bounded in either direction.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = 'public.blocked_users'::regclass
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 2
      AND index_metadata.indnatts = 2
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname
          ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['blocker_id', 'blocked_id']::name[]
  ) THEN
    v_missing_indexes := pg_catalog.array_append(
      v_missing_indexes,
      'blocked_users UNIQUE (blocker_id, blocked_id)'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = 'public.blocked_users'::regclass
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts >= 1
      AND (
        SELECT attribute.attname
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.ordinality = 1
      ) = 'blocked_id'
  ) THEN
    v_missing_indexes := pg_catalog.array_append(
      v_missing_indexes,
      'blocked_users (blocked_id, ...)'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = 'public.user_follows'::regclass
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 2
      AND index_metadata.indnatts = 2
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname
          ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['follower_id', 'following_id']::name[]
  ) THEN
    v_missing_indexes := pg_catalog.array_append(
      v_missing_indexes,
      'user_follows UNIQUE (follower_id, following_id)'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = 'public.direct_messages'::regclass
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts >= 2
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname
          ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.ordinality <= 2
      ) = ARRAY['sender_id', 'receiver_id']::name[]
  ) THEN
    v_missing_indexes := pg_catalog.array_append(
      v_missing_indexes,
      'direct_messages (sender_id, receiver_id, ...)'
    );
  END IF;

  -- Realtime RLS resolves a message by id and membership by channel. Keep both
  -- paths bounded, including the reaction-to-parent-message lookup.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = 'public.channel_messages'::regclass
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 1
      AND index_metadata.indnatts = 1
      AND (
        SELECT attribute.attname
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.ordinality = 1
      ) = 'id'
  ) THEN
    v_missing_indexes := pg_catalog.array_append(
      v_missing_indexes,
      'channel_messages UNIQUE (id)'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = 'public.channel_messages'::regclass
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts >= 1
      AND (
        SELECT attribute.attname
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.ordinality = 1
      ) = 'channel_id'
  ) THEN
    v_missing_indexes := pg_catalog.array_append(
      v_missing_indexes,
      'channel_messages (channel_id, ...)'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = 'public.channel_message_reactions'::regclass
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 1
      AND index_metadata.indnatts = 1
      AND (
        SELECT attribute.attname
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.ordinality = 1
      ) = 'id'
  ) THEN
    v_missing_indexes := pg_catalog.array_append(
      v_missing_indexes,
      'channel_message_reactions UNIQUE (id)'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = 'public.channel_message_reactions'::regclass
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts >= 1
      AND (
        SELECT attribute.attname
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.ordinality = 1
      ) = 'message_id'
  ) THEN
    v_missing_indexes := pg_catalog.array_append(
      v_missing_indexes,
      'channel_message_reactions (message_id, ...)'
    );
  END IF;

  IF pg_catalog.cardinality(v_missing_indexes) > 0 THEN
    RAISE EXCEPTION
      'channel boundary requires valid supporting indexes: %',
      v_missing_indexes;
  END IF;
END
$preflight$;

LOCK TABLE public.chat_channels,
  public.channel_members,
  public.channel_messages,
  public.channel_message_reactions
  IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.user_profiles,
  public.blocked_users,
  public.user_follows,
  public.direct_messages
  IN ACCESS SHARE MODE;

ALTER TABLE public.chat_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_message_reactions ENABLE ROW LEVEL SECURITY;

-- Remove table privileges including TRUNCATE, REFERENCES, and TRIGGER. Column
-- ACLs are independent in PostgreSQL, so revoke those explicitly on every live
-- column (including columns added outside the repository migrations).
REVOKE ALL PRIVILEGES ON TABLE public.chat_channels
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public.channel_members
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public.channel_messages
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public.channel_message_reactions
  FROM PUBLIC, anon, authenticated, service_role;

DO $revoke_channel_column_privileges$
DECLARE
  v_relation_name text;
  v_column_list text;
BEGIN
  FOREACH v_relation_name IN ARRAY ARRAY[
    'chat_channels',
    'channel_members',
    'channel_messages',
    'channel_message_reactions'
  ]::text[]
  LOOP
    SELECT pg_catalog.string_agg(
      pg_catalog.format('%I', attribute.attname),
      ', '
      ORDER BY attribute.attnum
    )
    INTO v_column_list
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = pg_catalog.to_regclass(
        pg_catalog.format('public.%I', v_relation_name)
      )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF v_column_list IS NULL THEN
      RAISE EXCEPTION 'public.% has no columns to secure', v_relation_name;
    END IF;

    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
        || 'ON TABLE public.%2$I '
        || 'FROM PUBLIC, anon, authenticated, service_role',
      v_column_list,
      v_relation_name
    );
  END LOOP;
END
$revoke_channel_column_privileges$;

-- Historical policy names changed. Remove every policy, including unknown
-- dashboard/manual drift. Message/reaction browser writes are already routed
-- through authenticated admin-client APIs; only their authenticated Realtime
-- SELECT path is rebuilt below.
DO $drop_channel_policies$
DECLARE
  v_relation_name text;
  v_policy_name name;
BEGIN
  FOREACH v_relation_name IN ARRAY ARRAY[
    'chat_channels',
    'channel_members',
    'channel_messages',
    'channel_message_reactions'
  ]::text[]
  LOOP
    FOR v_policy_name IN
      SELECT policy.polname
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = pg_catalog.to_regclass(
        pg_catalog.format('public.%I', v_relation_name)
      )
      ORDER BY policy.polname
    LOOP
      EXECUTE pg_catalog.format(
        'DROP POLICY %I ON public.%I',
        v_policy_name,
        v_relation_name
      );
    END LOOP;
  END LOOP;
END
$drop_channel_policies$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.chat_channels
  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.channel_members
  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.channel_messages
  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.channel_message_reactions
  TO service_role;

-- Realtime needs SELECT as the subscriber's authenticated role. It does not
-- need direct browser writes; every current message/reaction mutation goes
-- through a service-role API route.
GRANT SELECT ON TABLE public.channel_messages TO authenticated;
GRANT SELECT ON TABLE public.channel_message_reactions TO authenticated;

-- The only caller input is the channel id. Actor identity is always sourced
-- from the signed JWT through auth.uid(), so callers cannot inspect another
-- user's memberships by supplying a forged user UUID.
CREATE OR REPLACE FUNCTION public.is_current_user_channel_member(
  p_channel_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_actor_id uuid;
  v_actor_role text;
BEGIN
  v_actor_role := auth.role();
  IF v_actor_role IS DISTINCT FROM 'authenticated'
    AND v_actor_role IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION
      'is_current_user_channel_member requires an authenticated application role'
      USING ERRCODE = '42501';
  END IF;

  IF p_channel_id IS NULL THEN
    RAISE EXCEPTION 'channel ID is required'
      USING ERRCODE = '22023';
  END IF;

  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.channel_members AS membership
    JOIN public.user_profiles AS actor_profile
      ON actor_profile.id = membership.user_id
    WHERE membership.channel_id = p_channel_id
      AND membership.user_id = v_actor_id
      AND actor_profile.deleted_at IS NULL
      AND actor_profile.banned_at IS NULL
  );
END
$function$;

ALTER FUNCTION public.is_current_user_channel_member(uuid) OWNER TO postgres;

REVOKE ALL PRIVILEGES
  ON FUNCTION public.is_current_user_channel_member(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE
  ON FUNCTION public.is_current_user_channel_member(uuid)
  TO authenticated, service_role;

-- Supabase service_role normally has BYPASSRLS. Keep explicit policies so the
-- contract remains functional if that role property is tightened later.
CREATE POLICY "Service role manages chat channels"
  ON public.chat_channels
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role manages channel members"
  ON public.channel_members
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated members read channel messages"
  ON public.channel_messages
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    public.is_current_user_channel_member(channel_id)
  );

CREATE POLICY "Service role manages channel messages"
  ON public.channel_messages
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated members read channel message reactions"
  ON public.channel_message_reactions
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.channel_messages AS parent_message
      WHERE parent_message.id = channel_message_reactions.message_id
        AND public.is_current_user_channel_member(parent_message.channel_id)
    )
  );

CREATE POLICY "Service role manages channel message reactions"
  ON public.channel_message_reactions
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Canonical DM decision. The server derives p_sender_id from the authenticated
-- session. The explicit auth.role() guard provides a second boundary even if a
-- future grant accidentally exposes this SECURITY DEFINER function again.
CREATE OR REPLACE FUNCTION public.check_dm_permission(
  p_sender_id uuid,
  p_receiver_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_dm_permission text;
  v_is_mutual boolean := false;
  v_receiver_replied boolean := false;
  v_sent_count bigint := 0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'check_dm_permission is restricted to service_role'
      USING ERRCODE = '42501';
  END IF;

  IF p_sender_id IS NULL OR p_receiver_id IS NULL THEN
    RAISE EXCEPTION 'sender and receiver IDs are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_sender_id = p_receiver_id THEN
    RAISE EXCEPTION 'sender and receiver IDs must differ'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_profiles AS sender_profile
    WHERE sender_profile.id = p_sender_id
      AND sender_profile.deleted_at IS NULL
      AND sender_profile.banned_at IS NULL
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false,
      'reason', 'SENDER_UNAVAILABLE'
    );
  END IF;

  SELECT profile.dm_permission
  INTO v_dm_permission
  FROM public.user_profiles AS profile
  WHERE profile.id = p_receiver_id
    AND profile.deleted_at IS NULL
    AND profile.banned_at IS NULL;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false,
      'reason', 'USER_NOT_FOUND'
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.blocked_users AS block_edge
    WHERE (
      block_edge.blocker_id = p_sender_id
      AND block_edge.blocked_id = p_receiver_id
    ) OR (
      block_edge.blocker_id = p_receiver_id
      AND block_edge.blocked_id = p_sender_id
    )
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false,
      'reason', 'BLOCKED'
    );
  END IF;

  -- NULL or unexpected legacy values fail closed. The production constraint
  -- permits only all/mutual/none, but this prevents partial drift from opening
  -- a message path.
  IF v_dm_permission IS NULL OR v_dm_permission = 'none' THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false,
      'reason', 'DM_DISABLED'
    );
  END IF;

  -- The historical function checked the unreachable literal "everyone" even
  -- though the persisted/UI contract is "all".
  IF v_dm_permission = 'all' THEN
    RETURN pg_catalog.jsonb_build_object('allowed', true);
  END IF;

  IF v_dm_permission <> 'mutual' THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false,
      'reason', 'DM_DISABLED'
    );
  END IF;

  SELECT
    EXISTS (
      SELECT 1
      FROM public.user_follows AS sender_follow
      WHERE sender_follow.follower_id = p_sender_id
        AND sender_follow.following_id = p_receiver_id
    )
    AND EXISTS (
      SELECT 1
      FROM public.user_follows AS receiver_follow
      WHERE receiver_follow.follower_id = p_receiver_id
        AND receiver_follow.following_id = p_sender_id
    )
  INTO v_is_mutual;

  IF v_is_mutual THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', true,
      'is_mutual', true
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.direct_messages AS receiver_message
    WHERE receiver_message.sender_id = p_receiver_id
      AND receiver_message.receiver_id = p_sender_id
  )
  INTO v_receiver_replied;

  IF v_receiver_replied THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', true,
      'receiver_replied', true
    );
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_sent_count
  FROM public.direct_messages AS sender_message
  WHERE sender_message.sender_id = p_sender_id
    AND sender_message.receiver_id = p_receiver_id;

  -- Preserve the existing non-mutual contract and response fields exactly:
  -- fewer than three messages are allowed; at three the limit is reached.
  RETURN pg_catalog.jsonb_build_object(
    'allowed', v_sent_count < 3,
    'sent_count', v_sent_count,
    'reason', CASE
      WHEN v_sent_count >= 3 THEN 'LIMIT_REACHED'
      ELSE NULL
    END
  );
END
$function$;

ALTER FUNCTION public.check_dm_permission(uuid, uuid) OWNER TO postgres;

REVOKE ALL PRIVILEGES
  ON FUNCTION public.check_dm_permission(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE
  ON FUNCTION public.check_dm_permission(uuid, uuid)
  TO service_role;

-- Abort if any browser table/column path remains, if service_role acquired
-- powers beyond CRUD, if policy drift survived, or if the RPC is not exactly
-- the intended SECURITY DEFINER/service-only signature.
DO $postflight$
DECLARE
  v_relation_name text;
  v_relation regclass;
  v_role name;
  v_privilege text;
  v_column name;
  v_expected_policy name;
  v_expected_read_policy name;
  v_expected_read_expression text;
  v_expected_service_policy name;
  v_service_role_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_anon_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'anon'
  );
  v_authenticated_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticated'
  );
  v_dm_function regprocedure := pg_catalog.to_regprocedure(
    'public.check_dm_permission(uuid,uuid)'
  );
  v_membership_function regprocedure := pg_catalog.to_regprocedure(
    'public.is_current_user_channel_member(uuid)'
  );
BEGIN
  FOREACH v_relation_name IN ARRAY ARRAY[
    'chat_channels',
    'channel_members'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('public.%I', v_relation_name)
    );
    v_expected_policy := CASE v_relation_name
      WHEN 'chat_channels' THEN 'Service role manages chat channels'
      ELSE 'Service role manages channel members'
    END;

    IF NOT (
      SELECT relation.relrowsecurity
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
    ) THEN
      RAISE EXCEPTION 'RLS is not enabled on public.%', v_relation_name;
    END IF;

    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER'
      ]::text[]
      LOOP
        IF pg_catalog.has_table_privilege(
          v_role,
          v_relation,
          v_privilege
        ) THEN
          RAISE EXCEPTION
            '% still has % on public.%',
            v_role,
            v_privilege,
            v_relation_name;
        END IF;
      END LOOP;

      FOR v_column IN
        SELECT attribute.attname
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_relation
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
        ORDER BY attribute.attnum
      LOOP
        FOREACH v_privilege IN ARRAY ARRAY[
          'SELECT',
          'INSERT',
          'UPDATE',
          'REFERENCES'
        ]::text[]
        LOOP
          IF pg_catalog.has_column_privilege(
            v_role,
            v_relation,
            v_column,
            v_privilege
          ) THEN
            RAISE EXCEPTION
              '% still has column % on public.%.%',
              v_role,
              v_privilege,
              v_relation_name,
              v_column;
          END IF;
        END LOOP;
      END LOOP;
    END LOOP;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      WHERE relation.oid = v_relation
        AND acl_entry.grantee = 0::oid
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee = 0::oid
    ) THEN
      RAISE EXCEPTION 'PUBLIC privileges remain on public.%', v_relation_name;
    END IF;

    -- No application-role column ACL should remain. service_role receives
    -- table-level CRUD only, keeping the permission surface auditable.
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee IN (
          0::oid,
          v_anon_oid,
          v_authenticated_oid,
          v_service_role_oid
        )
    ) THEN
      RAISE EXCEPTION
        'application-role column ACL remains on public.%',
        v_relation_name;
    END IF;

    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE'
    ]::text[]
    LOOP
      IF NOT pg_catalog.has_table_privilege(
        'service_role',
        v_relation,
        v_privilege
      ) THEN
        RAISE EXCEPTION
          'service_role is missing % on public.%',
          v_privilege,
          v_relation_name;
      END IF;
    END LOOP;

    FOREACH v_privilege IN ARRAY ARRAY[
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(
        'service_role',
        v_relation,
        v_privilege
      ) THEN
        RAISE EXCEPTION
          'service_role still has excess % on public.%',
          v_privilege,
          v_relation_name;
      END IF;
    END LOOP;

    IF (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_relation
    ) <> 1 OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_relation
        AND policy.polname = v_expected_policy
        AND policy.polcmd = '*'
        AND policy.polpermissive
        AND policy.polroles = ARRAY[v_service_role_oid]::oid[]
        AND pg_catalog.pg_get_expr(
          policy.polqual,
          policy.polrelid
        ) = 'true'
        AND pg_catalog.pg_get_expr(
          policy.polwithcheck,
          policy.polrelid
        ) = 'true'
    ) THEN
      RAISE EXCEPTION
        'service-only policy contract failed on public.%',
        v_relation_name;
    END IF;
  END LOOP;

  -- Message and reaction rows remain SELECTable only to authenticated members
  -- for Realtime. All browser mutations are server-routed and therefore have
  -- neither a table privilege nor a write policy.
  FOREACH v_relation_name IN ARRAY ARRAY[
    'channel_messages',
    'channel_message_reactions'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('public.%I', v_relation_name)
    );
    v_expected_read_policy := CASE v_relation_name
      WHEN 'channel_messages' THEN 'Authenticated members read channel messages'
      ELSE 'Authenticated members read channel message reactions'
    END;
    v_expected_read_expression := CASE v_relation_name
      WHEN 'channel_messages' THEN
        'public.is_current_user_channel_member(channel_id)'
      ELSE
        '(EXISTS ( SELECT 1 FROM public.channel_messages parent_message '
          || 'WHERE ((parent_message.id = channel_message_reactions.message_id) '
          || 'AND public.is_current_user_channel_member(parent_message.channel_id))))'
    END;
    v_expected_service_policy := CASE v_relation_name
      WHEN 'channel_messages' THEN 'Service role manages channel messages'
      ELSE 'Service role manages channel message reactions'
    END;

    IF NOT (
      SELECT relation.relrowsecurity
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
    ) THEN
      RAISE EXCEPTION 'RLS is not enabled on public.%', v_relation_name;
    END IF;

    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(
        'anon',
        v_relation,
        v_privilege
      ) THEN
        RAISE EXCEPTION
          'anon still has % on public.%',
          v_privilege,
          v_relation_name;
      END IF;

      IF pg_catalog.has_table_privilege(
        'authenticated',
        v_relation,
        v_privilege
      ) IS DISTINCT FROM (v_privilege = 'SELECT') THEN
        RAISE EXCEPTION
          'authenticated % privilege has the wrong state on public.%',
          v_privilege,
          v_relation_name;
      END IF;
    END LOOP;

    FOR v_column IN
      SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attnum
    LOOP
      FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
      LOOP
        FOREACH v_privilege IN ARRAY ARRAY[
          'INSERT',
          'UPDATE',
          'REFERENCES'
        ]::text[]
        LOOP
          IF pg_catalog.has_column_privilege(
            v_role,
            v_relation,
            v_column,
            v_privilege
          ) THEN
            RAISE EXCEPTION
              '% still has column % on public.%.%',
              v_role,
              v_privilege,
              v_relation_name,
              v_column;
          END IF;
        END LOOP;
      END LOOP;
    END LOOP;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      WHERE relation.oid = v_relation
        AND acl_entry.grantee = 0::oid
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee = 0::oid
    ) THEN
      RAISE EXCEPTION 'PUBLIC privileges remain on public.%', v_relation_name;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee IN (
          0::oid,
          v_anon_oid,
          v_authenticated_oid,
          v_service_role_oid
        )
    ) THEN
      RAISE EXCEPTION
        'application-role column ACL remains on public.%',
        v_relation_name;
    END IF;

    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE'
    ]::text[]
    LOOP
      IF NOT pg_catalog.has_table_privilege(
        'service_role',
        v_relation,
        v_privilege
      ) THEN
        RAISE EXCEPTION
          'service_role is missing % on public.%',
          v_privilege,
          v_relation_name;
      END IF;
    END LOOP;

    FOREACH v_privilege IN ARRAY ARRAY[
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(
        'service_role',
        v_relation,
        v_privilege
      ) THEN
        RAISE EXCEPTION
          'service_role still has excess % on public.%',
          v_privilege,
          v_relation_name;
      END IF;
    END LOOP;

    IF (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_relation
    ) <> 2 OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_relation
        AND policy.polname = v_expected_read_policy
        AND policy.polcmd = 'r'
        AND policy.polpermissive
        AND policy.polroles = ARRAY[v_authenticated_oid]::oid[]
        AND pg_catalog.regexp_replace(
          pg_catalog.pg_get_expr(policy.polqual, policy.polrelid),
          '[[:space:]]+',
          ' ',
          'g'
        ) = v_expected_read_expression
        AND policy.polwithcheck IS NULL
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_relation
        AND policy.polname = v_expected_service_policy
        AND policy.polcmd = '*'
        AND policy.polpermissive
        AND policy.polroles = ARRAY[v_service_role_oid]::oid[]
        AND pg_catalog.pg_get_expr(
          policy.polqual,
          policy.polrelid
        ) = 'true'
        AND pg_catalog.pg_get_expr(
          policy.polwithcheck,
          policy.polrelid
        ) = 'true'
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_relation
        AND policy.polcmd IN ('*', 'a', 'w', 'd')
        AND policy.polroles && ARRAY[
          0::oid,
          v_anon_oid,
          v_authenticated_oid
        ]::oid[]
    ) THEN
      RAISE EXCEPTION
        'Realtime read/server-write policy contract failed on public.%',
        v_relation_name;
    END IF;
  END LOOP;

  IF v_membership_function IS NULL OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'is_current_user_channel_member'
  ) <> 1 THEN
    RAISE EXCEPTION
      'canonical is_current_user_channel_member function is missing or overloaded';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_language AS language
      ON language.oid = procedure.prolang
    WHERE procedure.oid = v_membership_function
      AND (
        procedure.prokind <> 'f'
        OR procedure.prorettype <> 'boolean'::regtype
        OR procedure.proretset
        OR procedure.proargnames IS DISTINCT FROM
          ARRAY['p_channel_id']::text[]
        OR NOT procedure.prosecdef
        OR procedure.proowner <> (
          SELECT role_row.oid
          FROM pg_catalog.pg_roles AS role_row
          WHERE role_row.rolname = 'postgres'
        )
        OR language.lanname <> 'plpgsql'
        OR procedure.provolatile <> 's'
        OR procedure.proconfig IS DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
      )
  ) THEN
    RAISE EXCEPTION
      'canonical is_current_user_channel_member catalog contract failed';
  END IF;

  IF pg_catalog.has_function_privilege(
    'anon',
    v_membership_function,
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'authenticated',
    v_membership_function,
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    v_membership_function,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'is_current_user_channel_member EXECUTE boundary failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS acl_entry
    WHERE procedure.oid = v_membership_function
      AND acl_entry.grantee IN (0::oid, v_anon_oid)
  ) THEN
    RAISE EXCEPTION
      'anon or PUBLIC function ACL remains on is_current_user_channel_member';
  END IF;

  IF v_dm_function IS NULL OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'check_dm_permission'
  ) <> 1 THEN
    RAISE EXCEPTION 'canonical check_dm_permission function is missing or overloaded';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_language AS language
      ON language.oid = procedure.prolang
    WHERE procedure.oid = v_dm_function
      AND (
        procedure.prokind <> 'f'
        OR procedure.prorettype <> 'jsonb'::regtype
        OR procedure.proretset
        OR procedure.proargnames IS DISTINCT FROM
          ARRAY['p_sender_id', 'p_receiver_id']::text[]
        OR NOT procedure.prosecdef
        OR procedure.proowner <> (
          SELECT role_row.oid
          FROM pg_catalog.pg_roles AS role_row
          WHERE role_row.rolname = 'postgres'
        )
        OR language.lanname <> 'plpgsql'
        OR procedure.provolatile <> 'v'
        OR procedure.proconfig IS DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
      )
  ) THEN
    RAISE EXCEPTION 'canonical check_dm_permission catalog contract failed';
  END IF;

  IF pg_catalog.has_function_privilege(
    'anon',
    v_dm_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    v_dm_function,
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    v_dm_function,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'check_dm_permission EXECUTE boundary failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS acl_entry
    WHERE procedure.oid = v_dm_function
      AND acl_entry.grantee IN (0::oid, v_anon_oid, v_authenticated_oid)
  ) THEN
    RAISE EXCEPTION 'browser or PUBLIC function ACL remains on check_dm_permission';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
