-- Publish a single-transaction direct-message send contract while preserving
-- the existing API until a later application cutover. The RPC returns the
-- complete inserted message row plus conversation_id, matching POST
-- /api/messages. Existing AFTER INSERT triggers remain the sole owners of the
-- conversation preview update and message notification side effects.
--
-- Rollout order: 20260716112100 must deploy first because this function calls
-- its canonical service-only check_dm_permission contract. Deploy this SQL,
-- verify it, and only then switch the API route in a separate change.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Migration coordination is deliberately non-blocking. A concurrent rollout
-- must retry instead of leaving application writes queued indefinitely.
DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.direct_messages:atomic-send-boundary',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic direct-message migration lock is busy';
  END IF;
END
$migration_lock$;

DO $preflight$
DECLARE
  v_relation_name text;
  v_relation regclass;
  v_invalid_columns text[];
  v_missing_roles text[];
  v_invalid_rows bigint;
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_permission_function regprocedure := pg_catalog.to_regprocedure(
    'public.check_dm_permission(uuid,uuid)'
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
    RAISE EXCEPTION 'direct-message ACL roles are missing: %', v_missing_roles;
  END IF;

  FOREACH v_relation_name IN ARRAY ARRAY[
    'blocked_users',
    'conversations',
    'direct_messages',
    'notifications',
    'user_follows',
    'user_profiles'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('public.%I', v_relation_name)
    );

    IF v_relation IS NULL THEN
      RAISE EXCEPTION
        'public.% must exist before atomic direct-message hardening',
        v_relation_name;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
        AND relation.relkind IN ('r', 'p')
        AND relation.relowner = v_postgres_oid
    ) THEN
      RAISE EXCEPTION
        'public.% must be a postgres-owned table or partitioned table',
        v_relation_name;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL OR (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure('auth.role()')
  ) <> 'text'::regtype THEN
    RAISE EXCEPTION 'auth.role() returning text must exist';
  END IF;

  -- This deliberately fails before changing ACLs if the earlier channel/DM
  -- migration has not installed its fixed-path, service-only permission RPC.
  IF v_permission_function IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_permission_function
      AND function_row.prokind = 'f'
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'jsonb'::regtype
      AND function_row.pronargs = 2
      AND function_row.pronargdefaults = 0
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
  ) THEN
    RAISE EXCEPTION
      'canonical 20260716112100 check_dm_permission contract is required';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    v_permission_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    v_permission_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    v_permission_function,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'check_dm_permission must be executable only by service_role';
  END IF;

  SELECT pg_catalog.array_agg(
    pg_catalog.format(
      'public.%I.%I (expected %s%s)',
      required_column.table_name,
      required_column.column_name,
      required_column.type_name,
      CASE WHEN required_column.required_not_null THEN ' NOT NULL' ELSE '' END
    )
    ORDER BY required_column.table_name, required_column.ordinality
  )
  INTO v_invalid_columns
  FROM (
    VALUES
      ('blocked_users', 1, 'blocker_id', 'uuid', true),
      ('blocked_users', 2, 'blocked_id', 'uuid', true),
      ('conversations', 1, 'id', 'uuid', true),
      ('conversations', 2, 'user1_id', 'uuid', true),
      ('conversations', 3, 'user2_id', 'uuid', true),
      ('conversations', 4, 'last_message_at', 'timestamp with time zone', false),
      ('conversations', 5, 'last_message_preview', 'text', false),
      ('conversations', 6, 'created_at', 'timestamp with time zone', false),
      ('direct_messages', 1, 'id', 'uuid', true),
      ('direct_messages', 2, 'conversation_id', 'uuid', true),
      ('direct_messages', 3, 'sender_id', 'uuid', true),
      ('direct_messages', 4, 'receiver_id', 'uuid', true),
      ('direct_messages', 5, 'content', 'text', true),
      ('direct_messages', 6, 'read', 'boolean', false),
      ('direct_messages', 7, 'created_at', 'timestamp with time zone', false),
      ('direct_messages', 8, 'media_url', 'text', false),
      ('direct_messages', 9, 'media_type', 'text', false),
      ('direct_messages', 10, 'media_name', 'text', false),
      ('direct_messages', 11, 'read_at', 'timestamp with time zone', false),
      ('direct_messages', 12, 'deleted_at', 'timestamp with time zone', false),
      ('direct_messages', 13, 'reply_to_id', 'uuid', false),
      ('notifications', 1, 'user_id', 'uuid', true),
      ('notifications', 2, 'type', 'text', true),
      ('notifications', 3, 'title', 'text', true),
      ('notifications', 4, 'message', 'text', true),
      ('notifications', 5, 'link', 'text', false),
      ('notifications', 6, 'actor_id', 'uuid', false),
      ('notifications', 7, 'reference_id', 'uuid', false),
      ('user_follows', 1, 'follower_id', 'uuid', true),
      ('user_follows', 2, 'following_id', 'uuid', true),
      ('user_profiles', 1, 'id', 'uuid', true),
      ('user_profiles', 2, 'dm_permission', 'text', false),
      ('user_profiles', 3, 'deleted_at', 'timestamp with time zone', false),
      ('user_profiles', 4, 'banned_at', 'timestamp with time zone', false),
      ('user_profiles', 5, 'handle', 'text', false),
      ('user_profiles', 6, 'notify_message', 'boolean', false)
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
     OR (required_column.required_not_null AND NOT attribute.attnotnull);

  IF v_invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'direct-message boundary has missing or incompatible columns: %',
      v_invalid_columns;
  END IF;

  -- Inserts depend on database-owned IDs/timestamps and the unread default.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS column_default
      ON column_default.adrelid = attribute.attrelid
     AND column_default.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.conversations'::regclass
      AND attribute.attname = 'id'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS column_default
      ON column_default.adrelid = attribute.attrelid
     AND column_default.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.direct_messages'::regclass
      AND attribute.attname IN ('id', 'created_at')
    GROUP BY attribute.attrelid
    HAVING pg_catalog.count(*) = 2
  ) OR (
    SELECT pg_catalog.pg_get_expr(
      column_default.adbin,
      column_default.adrelid,
      true
    )
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS column_default
      ON column_default.adrelid = attribute.attrelid
     AND column_default.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.direct_messages'::regclass
      AND attribute.attname = 'read'
  ) IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION
      'conversation/message ID, timestamp, or unread defaults are incompatible';
  END IF;

  -- Canonical ordered-pair uniqueness is required both for ON CONFLICT and to
  -- guarantee that concurrent first sends cannot create duplicate threads.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = 'public.conversations'::regclass
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND NOT index_metadata.indisexclusion
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 2
      AND index_metadata.indnatts = 2
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['user1_id', 'user2_id']::name[]
  ) THEN
    RAISE EXCEPTION
      'conversations requires a valid unique (user1_id, user2_id) key';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.conversations'::regclass
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND pg_catalog.regexp_replace(
        pg_catalog.pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid,
          true
        ),
        '[()[:space:]]',
        '',
        'g'
      ) = 'user1_id<user2_id'
  ) THEN
    RAISE EXCEPTION
      'conversations requires the canonical user1_id < user2_id check';
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
          attribute.attname ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.ordinality <= 2
      ) = ARRAY['sender_id', 'receiver_id']::name[]
  ) THEN
    RAISE EXCEPTION
      'direct_messages requires a (sender_id, receiver_id, ...) index';
  END IF;

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
          attribute.attname ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['blocker_id', 'blocked_id']::name[]
  ) OR NOT EXISTS (
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
    RAISE EXCEPTION 'blocked_users supporting keys are incompatible';
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
          attribute.attname ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['follower_id', 'following_id']::name[]
  ) THEN
    RAISE EXCEPTION
      'user_follows requires a valid unique (follower_id, following_id) key';
  END IF;

  -- The RPC intentionally relies on these existing triggers and must never
  -- duplicate their side effects in its own body.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'on_dm_sent'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled <> 'D'
      AND trigger_row.tgtype = 5
      AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
        'public.update_conversation_on_message()'
      )
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'on_dm_received'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled <> 'D'
      AND trigger_row.tgtype = 5
      AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
        'public.create_message_notification()'
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled <> 'D'
      AND trigger_row.tgtype = 5
      AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
        'public.update_conversation_on_message()'
      )
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled <> 'D'
      AND trigger_row.tgtype = 5
      AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
        'public.create_message_notification()'
      )
  ) <> 1 THEN
    RAISE EXCEPTION
      'exactly one canonical direct-message summary/notification trigger is required';
  END IF;

  -- Production is currently clean. Refuse to hide or rewrite any historical
  -- corruption if a different environment has drifted from the 1:1 contract.
  SELECT pg_catalog.count(*)
  INTO v_invalid_rows
  FROM public.direct_messages AS message_row
  JOIN public.conversations AS conversation
    ON conversation.id = message_row.conversation_id
  WHERE message_row.sender_id = message_row.receiver_id
     OR conversation.user1_id <> LEAST(
       message_row.sender_id,
       message_row.receiver_id
     )
     OR conversation.user2_id <> GREATEST(
       message_row.sender_id,
       message_row.receiver_id
     );

  IF v_invalid_rows > 0 THEN
    RAISE EXCEPTION
      'direct_messages has % rows outside their canonical participant pair',
      v_invalid_rows;
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_invalid_rows
  FROM public.direct_messages AS message_row
  WHERE pg_catalog.char_length(pg_catalog.btrim(message_row.content))
          NOT BETWEEN 1 AND 2000
     OR (
       message_row.media_url IS NULL
       AND (
         message_row.media_type IS NOT NULL
         OR message_row.media_name IS NOT NULL
       )
     )
     OR (
       message_row.media_url IS NOT NULL
       AND (
         pg_catalog.char_length(pg_catalog.btrim(message_row.media_url))
           NOT BETWEEN 1 AND 2000
         OR pg_catalog.btrim(message_row.media_url)
              !~ '^https://[^[:space:]]+$'
         OR message_row.media_type IS NULL
         OR pg_catalog.lower(pg_catalog.btrim(message_row.media_type))
              NOT IN ('image', 'video', 'file')
         OR (
           message_row.media_name IS NOT NULL
           AND pg_catalog.char_length(
             pg_catalog.btrim(message_row.media_name)
           ) NOT BETWEEN 1 AND 255
         )
       )
     );

  IF v_invalid_rows > 0 THEN
    RAISE EXCEPTION
      'direct_messages has % rows with invalid content/media shape',
      v_invalid_rows;
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_invalid_rows
  FROM public.direct_messages AS message_row
  JOIN public.direct_messages AS parent_message
    ON parent_message.id = message_row.reply_to_id
  WHERE message_row.reply_to_id IS NOT NULL
    AND (
      message_row.conversation_id <> parent_message.conversation_id
      OR LEAST(message_row.sender_id, message_row.receiver_id)
           <> LEAST(parent_message.sender_id, parent_message.receiver_id)
      OR GREATEST(message_row.sender_id, message_row.receiver_id)
           <> GREATEST(parent_message.sender_id, parent_message.receiver_id)
    );

  IF v_invalid_rows > 0 THEN
    RAISE EXCEPTION
      'direct_messages has % cross-thread reply edges',
      v_invalid_rows;
  END IF;
END
$preflight$;

-- Bound every DDL lock. Lock order is stable across replays.
LOCK TABLE public.blocked_users,
  public.conversations,
  public.direct_messages,
  public.user_follows
  IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.notifications,
  public.user_profiles
  IN ACCESS SHARE MODE;

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.direct_messages ENABLE ROW LEVEL SECURITY;

-- Remove every non-owner table ACL, including manual/dashboard roles unknown
-- to the repository.
DO $revoke_nonowner_table_access$
DECLARE
  v_relation_name text;
  v_relation regclass;
  v_grantee record;
BEGIN
  FOREACH v_relation_name IN ARRAY ARRAY[
    'conversations',
    'direct_messages'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('public.%I', v_relation_name)
    );

    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee, role_row.rolname
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.oid = acl_entry.grantee
      WHERE relation.oid = v_relation
        AND acl_entry.grantee <> relation.relowner
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC',
          v_relation_name
        );
      ELSIF v_grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',
          v_relation_name,
          v_grantee.rolname
        );
      END IF;
    END LOOP;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.%I '
        || 'FROM PUBLIC, anon, authenticated, service_role',
      v_relation_name
    );
  END LOOP;
END
$revoke_nonowner_table_access$;

DO $revoke_nonowner_column_access$
DECLARE
  v_relation_name text;
  v_relation regclass;
  v_column_list text;
  v_grantee record;
BEGIN
  FOREACH v_relation_name IN ARRAY ARRAY[
    'conversations',
    'direct_messages'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('public.%I', v_relation_name)
    );

    SELECT pg_catalog.string_agg(
      pg_catalog.format('%I', attribute.attname),
      ', ' ORDER BY attribute.attnum
    )
    INTO v_column_list
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF v_column_list IS NULL THEN
      RAISE EXCEPTION 'public.% has no columns to secure', v_relation_name;
    END IF;

    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee, role_row.rolname
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.oid = acl_entry.grantee
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee <> (
          SELECT relation.relowner
          FROM pg_catalog.pg_class AS relation
          WHERE relation.oid = v_relation
        )
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
            || 'ON TABLE public.%2$I FROM PUBLIC',
          v_column_list,
          v_relation_name
        );
      ELSIF v_grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
            || 'ON TABLE public.%2$I FROM %3$I',
          v_column_list,
          v_relation_name,
          v_grantee.rolname
        );
      END IF;
    END LOOP;

    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
        || 'ON TABLE public.%2$I '
        || 'FROM PUBLIC, anon, authenticated, service_role',
      v_column_list,
      v_relation_name
    );
  END LOOP;
END
$revoke_nonowner_column_access$;

DO $drop_message_policies$
DECLARE
  v_relation_name text;
  v_policy_name name;
BEGIN
  FOREACH v_relation_name IN ARRAY ARRAY[
    'conversations',
    'direct_messages'
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
$drop_message_policies$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.conversations, public.direct_messages
  TO service_role;
GRANT SELECT
  ON TABLE public.conversations, public.direct_messages
  TO authenticated;

-- Realtime queries bypass every API auth helper, so RLS must independently
-- reject stale JWTs belonging to a deleted or banned profile. Keep the actor
-- implicit: a browser can only ask about the identity signed into its JWT.
DO $drop_legacy_dm_reader_functions$
DECLARE
  v_signature regprocedure;
  v_canonical regprocedure := pg_catalog.to_regprocedure(
    'public.is_current_user_active_for_direct_messages()'
  );
BEGIN
  FOR v_signature IN
    SELECT function_row.oid::regprocedure
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname =
        'is_current_user_active_for_direct_messages'
      AND function_row.prokind = 'f'
      AND function_row.oid IS DISTINCT FROM v_canonical::oid
  LOOP
    EXECUTE pg_catalog.format('DROP FUNCTION %s', v_signature);
  END LOOP;
END
$drop_legacy_dm_reader_functions$;

CREATE OR REPLACE FUNCTION public.is_current_user_active_for_direct_messages()
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
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'active direct-message reader requires an application role';
  END IF;

  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.user_profiles AS actor_profile
    WHERE actor_profile.id = v_actor_id
      AND actor_profile.deleted_at IS NULL
      AND actor_profile.banned_at IS NULL
  );
END
$function$;

ALTER FUNCTION public.is_current_user_active_for_direct_messages()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_current_user_active_for_direct_messages()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_current_user_active_for_direct_messages()
  TO authenticated, service_role;

CREATE POLICY "Authenticated participants read conversations"
  ON public.conversations
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_current_user_active_for_direct_messages())
    AND (SELECT auth.uid()) IN (user1_id, user2_id)
  );

CREATE POLICY "Service role manages conversations"
  ON public.conversations
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated participants read direct messages"
  ON public.direct_messages
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_current_user_active_for_direct_messages())
    AND direct_messages.deleted_at IS NULL
    AND (SELECT auth.uid()) IN (sender_id, receiver_id)
    AND EXISTS (
      SELECT 1
      FROM public.conversations AS conversation
      WHERE conversation.id = direct_messages.conversation_id
        AND conversation.user1_id = LEAST(sender_id, receiver_id)
        AND conversation.user2_id = GREATEST(sender_id, receiver_id)
        AND (SELECT auth.uid()) IN (
          conversation.user1_id,
          conversation.user2_id
        )
    )
  );

CREATE POLICY "Service role manages direct messages"
  ON public.direct_messages
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Preserve the two historical AFTER INSERT effects exactly once, while
-- removing their old search_path=public SECURITY DEFINER exposure. The RPC
-- never updates the conversation or notifications directly.
CREATE OR REPLACE FUNCTION public.update_conversation_on_message()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  UPDATE public.conversations AS conversation
  SET last_message_at = NEW.created_at,
      last_message_preview = pg_catalog.left(NEW.content, 100)
  WHERE conversation.id = NEW.conversation_id;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.update_conversation_on_message() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.update_conversation_on_message()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_message_notification()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_sender_handle text;
  v_receiver_notify_message boolean;
BEGIN
  SELECT sender_profile.handle
  INTO v_sender_handle
  FROM public.user_profiles AS sender_profile
  WHERE sender_profile.id = NEW.sender_id;

  SELECT COALESCE(receiver_profile.notify_message, true)
  INTO v_receiver_notify_message
  FROM public.user_profiles AS receiver_profile
  WHERE receiver_profile.id = NEW.receiver_id;

  IF v_receiver_notify_message THEN
    INSERT INTO public.notifications (
      user_id,
      type,
      title,
      message,
      link,
      actor_id,
      reference_id
    ) VALUES (
      NEW.receiver_id,
      'message',
      '新私信',
      COALESCE(v_sender_handle, '有人') || ' 给你发送了一条私信',
      '/messages/' || NEW.conversation_id::text,
      NEW.sender_id,
      NEW.conversation_id
    );
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.create_message_notification() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_message_notification()
  FROM PUBLIC, anon, authenticated, service_role;

-- Serialize every permission-relevant edge and every direct-message row on
-- one unordered user-pair key. This closes the gap where a block/follow flip
-- could commit between permission evaluation and INSERT.
CREATE OR REPLACE FUNCTION public.serialize_direct_message_pair_edge()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_pairs text[] := ARRAY[]::text[];
  v_pair text;
  v_old_left uuid;
  v_old_right uuid;
  v_new_left uuid;
  v_new_right uuid;
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'direct-message pair serializer attached outside public';
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'blocked_users' THEN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        v_old_left := OLD.blocker_id;
        v_old_right := OLD.blocked_id;
      END IF;
      IF TG_OP IN ('INSERT', 'UPDATE') THEN
        v_new_left := NEW.blocker_id;
        v_new_right := NEW.blocked_id;
      END IF;
    WHEN 'user_follows' THEN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        v_old_left := OLD.follower_id;
        v_old_right := OLD.following_id;
      END IF;
      IF TG_OP IN ('INSERT', 'UPDATE') THEN
        v_new_left := NEW.follower_id;
        v_new_right := NEW.following_id;
      END IF;
    WHEN 'direct_messages' THEN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        v_old_left := OLD.sender_id;
        v_old_right := OLD.receiver_id;
      END IF;
      IF TG_OP IN ('INSERT', 'UPDATE') THEN
        v_new_left := NEW.sender_id;
        v_new_right := NEW.receiver_id;
      END IF;
    ELSE
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'direct-message pair serializer attached to unsupported table';
  END CASE;

  IF v_old_left IS NOT NULL AND v_old_right IS NOT NULL THEN
    v_pairs := pg_catalog.array_append(
      v_pairs,
      LEAST(v_old_left::text, v_old_right::text)
        || ':' || GREATEST(v_old_left::text, v_old_right::text)
    );
  END IF;

  IF v_new_left IS NOT NULL AND v_new_right IS NOT NULL THEN
    v_pairs := pg_catalog.array_append(
      v_pairs,
      LEAST(v_new_left::text, v_new_right::text)
        || ':' || GREATEST(v_new_left::text, v_new_right::text)
    );
  END IF;

  FOR v_pair IN
    SELECT DISTINCT affected_pair
    FROM pg_catalog.unnest(v_pairs) AS affected(affected_pair)
    ORDER BY affected_pair
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('direct-message:pair:' || v_pair, 0)
    );
  END LOOP;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

ALTER FUNCTION public.serialize_direct_message_pair_edge() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.serialize_direct_message_pair_edge()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_serialize_dm_block_pair ON public.blocked_users;
CREATE TRIGGER trg_serialize_dm_block_pair
BEFORE INSERT OR DELETE OR UPDATE OF blocker_id, blocked_id
ON public.blocked_users
FOR EACH ROW
EXECUTE FUNCTION public.serialize_direct_message_pair_edge();

DROP TRIGGER IF EXISTS trg_serialize_dm_follow_pair ON public.user_follows;
CREATE TRIGGER trg_serialize_dm_follow_pair
BEFORE INSERT OR DELETE OR UPDATE OF follower_id, following_id
ON public.user_follows
FOR EACH ROW
EXECUTE FUNCTION public.serialize_direct_message_pair_edge();

DROP TRIGGER IF EXISTS trg_serialize_dm_message_pair ON public.direct_messages;
CREATE TRIGGER trg_serialize_dm_message_pair
BEFORE INSERT OR DELETE OR UPDATE OF sender_id, receiver_id
ON public.direct_messages
FOR EACH ROW
EXECUTE FUNCTION public.serialize_direct_message_pair_edge();

-- Keep the base table structurally safe for trusted legacy service writers
-- during the database-first rollout. Permission/rate decisions belong to the
-- atomic RPC, but no writer may create a cross-thread message/reply or bypass
-- the canonical content/media shape.
CREATE OR REPLACE FUNCTION public.validate_direct_message_integrity()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  IF NEW.sender_id IS NULL
     OR NEW.receiver_id IS NULL
     OR NEW.sender_id = NEW.receiver_id
     OR NEW.conversation_id IS NULL
     OR pg_catalog.char_length(pg_catalog.btrim(NEW.content))
          NOT BETWEEN 1 AND 2000
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'invalid direct-message participant/content shape';
  END IF;

  IF NEW.media_url IS NULL THEN
    IF NEW.media_type IS NOT NULL OR NEW.media_name IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'direct-message media metadata requires a URL';
    END IF;
  ELSIF pg_catalog.char_length(pg_catalog.btrim(NEW.media_url))
            NOT BETWEEN 1 AND 2000
     OR pg_catalog.btrim(NEW.media_url) !~ '^https://[^[:space:]]+$'
     OR NEW.media_type IS NULL
     OR pg_catalog.lower(pg_catalog.btrim(NEW.media_type))
          NOT IN ('image', 'video', 'file')
     OR (
       NEW.media_name IS NOT NULL
       AND pg_catalog.char_length(pg_catalog.btrim(NEW.media_name))
            NOT BETWEEN 1 AND 255
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'invalid direct-message media shape';
  END IF;

  PERFORM 1
  FROM public.conversations AS conversation
  WHERE conversation.id = NEW.conversation_id
    AND conversation.user1_id = LEAST(NEW.sender_id, NEW.receiver_id)
    AND conversation.user2_id = GREATEST(NEW.sender_id, NEW.receiver_id)
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'direct message must use its participants canonical conversation';
  END IF;

  IF NEW.reply_to_id IS NOT NULL THEN
    PERFORM 1
    FROM public.direct_messages AS parent_message
    WHERE parent_message.id = NEW.reply_to_id
      AND parent_message.conversation_id = NEW.conversation_id
      AND parent_message.deleted_at IS NULL
      AND LEAST(parent_message.sender_id, parent_message.receiver_id)
            = LEAST(NEW.sender_id, NEW.receiver_id)
      AND GREATEST(parent_message.sender_id, parent_message.receiver_id)
            = GREATEST(NEW.sender_id, NEW.receiver_id)
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'reply target is not visible in this direct-message thread';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.validate_direct_message_integrity() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.validate_direct_message_integrity()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_validate_direct_message_integrity
  ON public.direct_messages;
CREATE TRIGGER trg_validate_direct_message_integrity
BEFORE INSERT OR UPDATE OF
  conversation_id,
  sender_id,
  receiver_id,
  content,
  media_url,
  media_type,
  media_name,
  reply_to_id
ON public.direct_messages
FOR EACH ROW
EXECUTE FUNCTION public.validate_direct_message_integrity();

-- Remove every historical overload before publishing the one route-facing
-- signature. A dependent legacy overload fails the transaction rather than
-- leaving an ambiguous PostgREST contract.
DO $drop_legacy_atomic_dm_functions$
DECLARE
  v_signature regprocedure;
BEGIN
  FOR v_signature IN
    SELECT function_row.oid::regprocedure
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'send_direct_message_atomic'
      AND function_row.prokind = 'f'
  LOOP
    EXECUTE pg_catalog.format('DROP FUNCTION %s', v_signature);
  END LOOP;
END
$drop_legacy_atomic_dm_functions$;

CREATE FUNCTION public.send_direct_message_atomic(
  p_sender_id uuid,
  p_receiver_id uuid,
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
  v_content text;
  v_media_url text;
  v_media_type text;
  v_media_name text;
  v_user1_id uuid;
  v_user2_id uuid;
  v_pair text;
  v_permission jsonb;
  v_reply_conversation_id uuid;
  v_conversation_id uuid;
  v_message public.direct_messages%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_sender_id IS NULL
     OR p_receiver_id IS NULL
     OR p_sender_id = p_receiver_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'distinct sender and receiver IDs are required';
  END IF;

  v_content := pg_catalog.btrim(p_content);
  IF v_content IS NULL
     OR pg_catalog.char_length(v_content) NOT BETWEEN 1 AND 2000
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'message content must contain 1 to 2000 characters';
  END IF;

  v_media_url := NULLIF(pg_catalog.btrim(p_media_url), '');
  v_media_type := NULLIF(
    pg_catalog.lower(pg_catalog.btrim(p_media_type)),
    ''
  );
  v_media_name := NULLIF(pg_catalog.btrim(p_media_name), '');

  IF p_media_url IS NOT NULL AND v_media_url IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'media URL cannot be blank';
  END IF;

  IF v_media_url IS NULL THEN
    IF p_media_type IS NOT NULL OR p_media_name IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'media metadata requires a media URL';
    END IF;
  ELSE
    v_media_type := COALESCE(v_media_type, 'file');
    IF pg_catalog.char_length(v_media_url) > 2000
       OR v_media_url !~ '^https://[^[:space:]]+$'
       OR v_media_type NOT IN ('image', 'video', 'file')
       OR (
         v_media_name IS NOT NULL
         AND pg_catalog.char_length(v_media_name) > 255
       )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'invalid direct-message media metadata';
    END IF;
  END IF;

  v_user1_id := LEAST(p_sender_id, p_receiver_id);
  v_user2_id := GREATEST(p_sender_id, p_receiver_id);
  v_pair := v_user1_id::text || ':' || v_user2_id::text;

  -- Every send, message endpoint rewrite, follow edge, and block edge uses
  -- this same unordered-pair transaction lock.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('direct-message:pair:' || v_pair, 0)
  );

  -- Hold both profile rows against preference, ban, deletion, or ID changes
  -- until the message transaction commits. Missing profiles are handled by
  -- check_dm_permission's stable denial response.
  PERFORM profile.id
  FROM public.user_profiles AS profile
  WHERE profile.id IN (p_sender_id, p_receiver_id)
  ORDER BY profile.id
  FOR SHARE;

  v_permission := public.check_dm_permission(
    p_sender_id,
    p_receiver_id
  );

  IF pg_catalog.jsonb_typeof(v_permission) IS DISTINCT FROM 'object'
     OR v_permission ->> 'allowed' IS NULL
     OR v_permission ->> 'allowed' NOT IN ('true', 'false')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'check_dm_permission returned an invalid contract';
  END IF;

  IF (v_permission ->> 'allowed')::boolean IS NOT TRUE THEN
    RETURN v_permission || pg_catalog.jsonb_build_object('success', false);
  END IF;

  -- Validate the reply before creating a conversation so an invalid reply
  -- can never leave an empty thread behind. Both directions are visible in a
  -- 1:1 thread, but the parent must be live and exactly this participant pair.
  IF p_reply_to_id IS NOT NULL THEN
    SELECT parent_message.conversation_id
    INTO v_reply_conversation_id
    FROM public.direct_messages AS parent_message
    JOIN public.conversations AS parent_conversation
      ON parent_conversation.id = parent_message.conversation_id
    WHERE parent_message.id = p_reply_to_id
      AND parent_message.deleted_at IS NULL
      AND (
        (
          parent_message.sender_id = p_sender_id
          AND parent_message.receiver_id = p_receiver_id
        ) OR (
          parent_message.sender_id = p_receiver_id
          AND parent_message.receiver_id = p_sender_id
        )
      )
      AND parent_conversation.user1_id = v_user1_id
      AND parent_conversation.user2_id = v_user2_id
    FOR SHARE OF parent_message, parent_conversation;

    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'allowed', false,
        'reason', 'INVALID_REPLY_TARGET'
      );
    END IF;
  END IF;

  INSERT INTO public.conversations (user1_id, user2_id)
  VALUES (v_user1_id, v_user2_id)
  ON CONFLICT (user1_id, user2_id) DO NOTHING
  RETURNING id INTO v_conversation_id;

  IF v_conversation_id IS NULL THEN
    SELECT conversation.id
    INTO STRICT v_conversation_id
    FROM public.conversations AS conversation
    WHERE conversation.user1_id = v_user1_id
      AND conversation.user2_id = v_user2_id
    FOR SHARE;
  END IF;

  IF v_reply_conversation_id IS NOT NULL
     AND v_reply_conversation_id <> v_conversation_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'reply target conversation violates ordered-pair uniqueness';
  END IF;

  INSERT INTO public.direct_messages (
    conversation_id,
    sender_id,
    receiver_id,
    content,
    media_url,
    media_type,
    media_name,
    reply_to_id
  ) VALUES (
    v_conversation_id,
    p_sender_id,
    p_receiver_id,
    v_content,
    v_media_url,
    v_media_type,
    v_media_name,
    p_reply_to_id
  )
  RETURNING * INTO v_message;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'allowed', true,
    'message', pg_catalog.to_jsonb(v_message),
    'conversation_id', v_conversation_id
  );
END
$function$;

ALTER FUNCTION public.send_direct_message_atomic(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  uuid
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.send_direct_message_atomic(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.send_direct_message_atomic(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  uuid
) TO service_role;

DO $revoke_unknown_function_access$
DECLARE
  v_function regprocedure;
  v_function_oid oid;
  v_function_owner oid;
  v_grantee record;
  v_send_function regprocedure :=
    'public.send_direct_message_atomic(uuid,uuid,text,text,text,text,uuid)'::regprocedure;
  v_permission_function regprocedure :=
    'public.check_dm_permission(uuid,uuid)'::regprocedure;
  v_reader_function regprocedure :=
    'public.is_current_user_active_for_direct_messages()'::regprocedure;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.send_direct_message_atomic(uuid,uuid,text,text,text,text,uuid)'::regprocedure,
    'public.check_dm_permission(uuid,uuid)'::regprocedure,
    'public.is_current_user_active_for_direct_messages()'::regprocedure,
    'public.serialize_direct_message_pair_edge()'::regprocedure,
    'public.validate_direct_message_integrity()'::regprocedure,
    'public.update_conversation_on_message()'::regprocedure,
    'public.create_message_notification()'::regprocedure
  ]::regprocedure[]
  LOOP
    v_function_oid := v_function::oid;
    SELECT function_row.proowner
    INTO v_function_owner
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function_oid;

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
      WHERE function_row.oid = v_function_oid
        AND acl_entry.grantee <> v_function_owner
        AND NOT (
          (
            v_function IN (v_send_function, v_permission_function)
            AND role_row.rolname = 'service_role'
          ) OR (
            v_function = v_reader_function
            AND role_row.rolname IN ('authenticated', 'service_role')
          )
        )
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION %s FROM PUBLIC',
          v_function
        );
      ELSIF v_grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION %s FROM %I',
          v_function,
          v_grantee.rolname
        );
      END IF;
    END LOOP;
  END LOOP;
END
$revoke_unknown_function_access$;

DO $postflight$
DECLARE
  v_relation_name text;
  v_relation regclass;
  v_role name;
  v_privilege text;
  v_column name;
  v_service_role_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_authenticated_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticated'
  );
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_send_function regprocedure :=
    'public.send_direct_message_atomic(uuid,uuid,text,text,text,text,uuid)'::regprocedure;
  v_permission_function regprocedure :=
    'public.check_dm_permission(uuid,uuid)'::regprocedure;
  v_reader_function regprocedure :=
    'public.is_current_user_active_for_direct_messages()'::regprocedure;
  v_edge_function regprocedure :=
    'public.serialize_direct_message_pair_edge()'::regprocedure;
  v_integrity_function regprocedure :=
    'public.validate_direct_message_integrity()'::regprocedure;
  v_update_function regprocedure :=
    'public.update_conversation_on_message()'::regprocedure;
  v_notification_function regprocedure :=
    'public.create_message_notification()'::regprocedure;
BEGIN
  FOREACH v_relation_name IN ARRAY ARRAY[
    'conversations',
    'direct_messages'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('public.%I', v_relation_name)
    );

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
        AND relation.relowner = v_postgres_oid
        AND relation.relrowsecurity
    ) THEN
      RAISE EXCEPTION
        'public.% owner/RLS postflight failed',
        v_relation_name;
    END IF;

    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ]::text[]
      LOOP
        IF pg_catalog.has_table_privilege(v_role, v_relation, v_privilege) THEN
          RAISE EXCEPTION
            '% still has % on public.%',
            v_role,
            v_privilege,
            v_relation_name;
        END IF;
      END LOOP;
    END LOOP;

    IF pg_catalog.has_table_privilege('anon', v_relation, 'SELECT')
       OR NOT pg_catalog.has_table_privilege(
         'authenticated',
         v_relation,
         'SELECT'
       )
    THEN
      RAISE EXCEPTION
        'public.% browser read ACL is incompatible',
        v_relation_name;
    END IF;

    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE'
    ]::text[]
    LOOP
      IF NOT pg_catalog.has_table_privilege(
        'service_role',
        v_relation,
        v_privilege
      ) THEN
        RAISE EXCEPTION
          'service_role lacks % on public.%',
          v_privilege,
          v_relation_name;
      END IF;
    END LOOP;

    FOREACH v_privilege IN ARRAY ARRAY[
      'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(
        'service_role',
        v_relation,
        v_privilege
      ) THEN
        RAISE EXCEPTION
          'service_role has excess % on public.%',
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
      FOREACH v_role IN ARRAY ARRAY[
        'anon', 'authenticated', 'service_role'
      ]::name[]
      LOOP
        FOREACH v_privilege IN ARRAY ARRAY[
          'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
        ]::text[]
        LOOP
          IF EXISTS (
            SELECT 1
            FROM pg_catalog.pg_attribute AS attribute
            CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
            JOIN pg_catalog.pg_roles AS role_row
              ON role_row.oid = acl_entry.grantee
            WHERE attribute.attrelid = v_relation
              AND attribute.attname = v_column
              AND role_row.rolname = v_role
              AND acl_entry.privilege_type = v_privilege
          ) THEN
            RAISE EXCEPTION
              '% has direct column % on public.%.%',
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
        AND acl_entry.grantee NOT IN (
          relation.relowner,
          v_authenticated_oid,
          v_service_role_oid
        )
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee <> v_postgres_oid
    ) THEN
      RAISE EXCEPTION
        'public.% retains arbitrary table/column ACLs',
        v_relation_name;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid IN (
      'public.conversations'::regclass,
      'public.direct_messages'::regclass
    )
  ) <> 4 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.conversations'::regclass
      AND policy.polname = 'Authenticated participants read conversations'
      AND policy.polcmd = 'r'
      AND policy.polpermissive
      AND policy.polroles = ARRAY[v_authenticated_oid]::oid[]
      AND pg_catalog.strpos(
        pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true),
        'auth.uid()'
      ) > 0
      AND pg_catalog.strpos(
        pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true),
        'is_current_user_active_for_direct_messages()'
      ) > 0
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.direct_messages'::regclass
      AND policy.polname = 'Authenticated participants read direct messages'
      AND policy.polcmd = 'r'
      AND policy.polpermissive
      AND policy.polroles = ARRAY[v_authenticated_oid]::oid[]
      AND pg_catalog.strpos(
        pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true),
        'conversation_id'
      ) > 0
      AND pg_catalog.strpos(
        pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true),
        'is_current_user_active_for_direct_messages()'
      ) > 0
      AND pg_catalog.strpos(
        pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true),
        'deleted_at IS NULL'
      ) > 0
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid IN (
      'public.conversations'::regclass,
      'public.direct_messages'::regclass
    )
      AND policy.polcmd = '*'
      AND policy.polpermissive
      AND policy.polroles = ARRAY[v_service_role_oid]::oid[]
      AND pg_catalog.pg_get_expr(
        policy.polqual,
        policy.polrelid,
        true
      ) = 'true'
      AND pg_catalog.pg_get_expr(
        policy.polwithcheck,
        policy.polrelid,
        true
      ) = 'true'
  ) <> 2 THEN
    RAISE EXCEPTION 'direct-message policy convergence failed';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'send_direct_message_atomic'
      AND function_row.prokind = 'f'
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_send_function
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'jsonb'::regtype
      AND function_row.pronargs = 7
      AND function_row.pronargdefaults = 4
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.cardinality(function_row.proconfig) = 2
  ) THEN
    RAISE EXCEPTION 'atomic direct-message RPC catalog contract failed';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname =
        'is_current_user_active_for_direct_messages'
      AND function_row.prokind = 'f'
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_reader_function
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 's'
      AND function_row.prorettype = 'boolean'::regtype
      AND function_row.pronargs = 0
      AND function_row.pronargdefaults = 0
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
  ) THEN
    RAISE EXCEPTION 'active direct-message reader contract failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_edge_function
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'trigger'::regtype
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.cardinality(function_row.proconfig) = 2
  ) THEN
    RAISE EXCEPTION 'direct-message pair serializer contract failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_integrity_function
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'trigger'::regtype
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.cardinality(function_row.proconfig) = 2
  ) THEN
    RAISE EXCEPTION 'direct-message integrity trigger contract failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid IN (v_update_function, v_notification_function)
      AND (
        function_row.proowner <> v_postgres_oid
        OR NOT function_row.prosecdef
        OR function_row.provolatile <> 'v'
        OR function_row.prorettype <> 'trigger'::regtype
        OR NOT function_row.proconfig @> ARRAY[
          'search_path=pg_catalog, pg_temp',
          'lock_timeout=5s'
        ]::text[]
        OR pg_catalog.cardinality(function_row.proconfig) <> 2
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid IN (v_update_function, v_notification_function)
  ) <> 2 THEN
    RAISE EXCEPTION
      'direct-message side-effect function hardening failed';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
  LOOP
    IF pg_catalog.has_function_privilege(v_role, v_send_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege(
         v_role,
         v_permission_function,
         'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(v_role, v_edge_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege(
         v_role,
         v_integrity_function,
         'EXECUTE'
       )
       OR (
         v_role = 'anon'
         AND pg_catalog.has_function_privilege(
           v_role,
           v_reader_function,
           'EXECUTE'
         )
       )
    THEN
      RAISE EXCEPTION '% retains direct-message function EXECUTE', v_role;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    v_send_function,
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    v_permission_function,
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    v_reader_function,
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'authenticated',
    v_reader_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    v_edge_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    v_integrity_function,
    'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid IN (
      v_send_function,
      v_permission_function,
      v_reader_function,
      v_edge_function,
      v_integrity_function
    )
      AND acl_entry.grantee <> function_row.proowner
      AND NOT (
        (
          function_row.oid IN (
            v_send_function::oid,
            v_permission_function::oid
          )
          AND acl_entry.grantee = v_service_role_oid
        ) OR (
          function_row.oid = v_reader_function::oid
          AND acl_entry.grantee IN (
            v_authenticated_oid,
            v_service_role_oid
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'direct-message function ACL convergence failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid IN (
      v_update_function,
      v_notification_function
    )
      AND acl_entry.grantee <> function_row.proowner
  ) THEN
    RAISE EXCEPTION
      'DM side-effect trigger functions retain a nonowner ACL';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'anon', 'authenticated', 'service_role'
  ]::name[]
  LOOP
    IF pg_catalog.has_function_privilege(
      v_role,
      v_update_function,
      'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      v_role,
      v_notification_function,
      'EXECUTE'
    ) THEN
      RAISE EXCEPTION
        '% retains direct EXECUTE on a DM side-effect trigger function',
        v_role;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgfoid = v_edge_function
      AND trigger_row.tgname IN (
        'trg_serialize_dm_block_pair',
        'trg_serialize_dm_follow_pair',
        'trg_serialize_dm_message_pair'
      )
      AND trigger_row.tgrelid IN (
        'public.blocked_users'::regclass,
        'public.user_follows'::regclass,
        'public.direct_messages'::regclass
      )
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 31
  ) <> 3 THEN
    RAISE EXCEPTION 'direct-message pair serializer triggers are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'trg_validate_direct_message_integrity'
      AND trigger_row.tgfoid = v_integrity_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 23
  ) THEN
    RAISE EXCEPTION 'direct-message integrity trigger is incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'on_dm_sent'
      AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
        'public.update_conversation_on_message()'
      )
      AND trigger_row.tgtype = 5
      AND trigger_row.tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'on_dm_received'
      AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
        'public.create_message_notification()'
      )
      AND trigger_row.tgtype = 5
      AND trigger_row.tgenabled <> 'D'
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled <> 'D'
      AND trigger_row.tgtype = 5
      AND trigger_row.tgfoid = v_update_function
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled <> 'D'
      AND trigger_row.tgtype = 5
      AND trigger_row.tgfoid = v_notification_function
  ) <> 1
  THEN
    RAISE EXCEPTION
      'direct-message side-effect triggers are not exactly once';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
