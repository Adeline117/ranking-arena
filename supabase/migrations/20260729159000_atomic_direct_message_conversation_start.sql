-- Migration: 20260729159000_atomic_direct_message_conversation_start.sql
-- Created: 2026-07-30T03:00:00Z
-- Description: Linearize direct-message admission and canonical conversation
--   creation. Permission, privacy, block/follow/message-limit state, account
--   lifecycle, receiver identity, and the returned conversation now belong to
--   one service-only transaction.
--
-- Forward compensation: switch the API back before removing this RPC in a
-- later forward migration. Existing canonical conversation rows remain valid.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.conversations:atomic-direct-message-start:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic direct-message conversation-start migration lock is busy';
  END IF;
END
$migration_lock$;

DO $preflight$
DECLARE
  v_missing_roles text[];
  v_invalid_columns text[];
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_permission_function regprocedure := pg_catalog.to_regprocedure(
    'public.check_dm_permission(uuid,uuid)'
  );
  v_pair_function regprocedure := pg_catalog.to_regprocedure(
    'public.serialize_direct_message_pair_edge()'
  );
  v_start_function regprocedure := pg_catalog.to_regprocedure(
    'public.start_direct_message_conversation_atomic(uuid,uuid)'
  );
  v_permission_source text;
  v_pair_source text;
  v_user1_attnum smallint;
  v_user2_attnum smallint;
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['anon', 'authenticated', 'service_role', 'postgres']::text[]
  ) AS required_role
  WHERE pg_catalog.to_regrole(required_role) IS NULL;

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION
      'direct-message conversation-start roles are missing: %',
      v_missing_roles;
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.conversations') IS NULL
     OR pg_catalog.to_regclass('public.blocked_users') IS NULL
     OR pg_catalog.to_regclass('public.user_follows') IS NULL
     OR pg_catalog.to_regclass('public.direct_messages') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.install_active_authenticated_subject_mutation_barriers()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.assert_active_authenticated_subject_mutation_barriers()'
     ) IS NULL
     OR v_permission_function IS NULL
     OR v_pair_function IS NULL
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
      'public.blocked_users'::regclass,
      'public.user_follows'::regclass,
      'public.direct_messages'::regclass
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
      'public.blocked_users'::regclass,
      'public.user_follows'::regclass,
      'public.direct_messages'::regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION
      'direct-message conversation-start requires canonical permanent relations';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.conversations'::regclass,
      'public.blocked_users'::regclass,
      'public.user_follows'::regclass,
      'public.direct_messages'::regclass
    )
       OR inheritance.inhparent IN (
         'auth.users'::regclass,
         'public.user_profiles'::regclass,
         'public.conversations'::regclass,
         'public.blocked_users'::regclass,
         'public.user_follows'::regclass,
         'public.direct_messages'::regclass
       )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.conversations'::regclass,
      'public.blocked_users'::regclass,
      'public.user_follows'::regclass,
      'public.direct_messages'::regclass
    )
  ) THEN
    RAISE EXCEPTION
      'direct-message conversation-start relations cannot use inheritance or rewrite rules';
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
      ('public', 'user_profiles', 3, 'dm_permission', 'text'::regtype, false),
      ('public', 'user_profiles', 4, 'deleted_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 5, 'banned_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 6, 'is_banned', 'boolean'::regtype, true),
      ('public', 'user_profiles', 7, 'ban_expires_at', 'timestamptz'::regtype, false),
      ('public', 'conversations', 1, 'id', 'uuid'::regtype, true),
      ('public', 'conversations', 2, 'user1_id', 'uuid'::regtype, true),
      ('public', 'conversations', 3, 'user2_id', 'uuid'::regtype, true),
      ('public', 'blocked_users', 1, 'blocker_id', 'uuid'::regtype, true),
      ('public', 'blocked_users', 2, 'blocked_id', 'uuid'::regtype, true),
      ('public', 'user_follows', 1, 'follower_id', 'uuid'::regtype, true),
      ('public', 'user_follows', 2, 'following_id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 1, 'id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 2, 'conversation_id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 3, 'sender_id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 4, 'receiver_id', 'uuid'::regtype, true)
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
      'direct-message conversation-start has incompatible columns: %',
      v_invalid_columns;
  END IF;

  SELECT attribute.attnum
  INTO STRICT v_user1_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.conversations'::regclass
    AND attribute.attname = 'user1_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_user2_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.conversations'::regclass
    AND attribute.attname = 'user2_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.conversations'::regclass
      AND constraint_row.contype = 'u'
      AND constraint_row.conkey = ARRAY[
        v_user1_attnum,
        v_user2_attnum
      ]::smallint[]
      AND NOT constraint_row.condeferrable
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.conversations'::regclass
      AND constraint_row.contype = 'c'
      AND pg_catalog.pg_get_constraintdef(
        constraint_row.oid,
        true
      ) ~ 'user1_id < user2_id'
  ) THEN
    RAISE EXCEPTION
      'conversations requires canonical non-deferrable ordered-pair uniqueness';
  END IF;

  SELECT function_row.prosrc
  INTO v_permission_source
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
    ]::text[];

  IF v_permission_source IS NULL
     OR pg_catalog.strpos(v_permission_source, 'FROM public.user_profiles') = 0
     OR pg_catalog.strpos(v_permission_source, 'FROM public.blocked_users') = 0
     OR pg_catalog.strpos(v_permission_source, 'dm_permission') = 0
     OR pg_catalog.strpos(v_permission_source, 'FROM public.user_follows') = 0
     OR pg_catalog.strpos(v_permission_source, 'FROM public.direct_messages') = 0
     OR pg_catalog.strpos(v_permission_source, 'LIMIT_REACHED') = 0
     OR pg_catalog.strpos(v_permission_source, 'BLOCKED') = 0
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_permission_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_permission_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_permission_function, 'EXECUTE'
     )
  THEN
    RAISE EXCEPTION
      'canonical service-only check_dm_permission authority is required';
  END IF;

  SELECT function_row.prosrc
  INTO v_pair_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_pair_function
    AND function_row.prokind = 'f'
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v';

  IF v_pair_source IS NULL
     OR pg_catalog.strpos(v_pair_source, 'direct-message:pair:') = 0
     OR pg_catalog.strpos(v_pair_source, 'blocked_users') = 0
     OR pg_catalog.strpos(v_pair_source, 'user_follows') = 0
     OR pg_catalog.strpos(v_pair_source, 'direct_messages') = 0
     OR EXISTS (
       SELECT 1
       FROM (
         VALUES
           ('public.blocked_users'::regclass, 'trg_serialize_dm_block_pair'),
           ('public.user_follows'::regclass, 'trg_serialize_dm_follow_pair'),
           ('public.direct_messages'::regclass, 'trg_serialize_dm_message_pair')
       ) AS required_trigger(relation_oid, trigger_name)
       WHERE NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_trigger AS trigger_row
         WHERE trigger_row.tgrelid = required_trigger.relation_oid
           AND trigger_row.tgname = required_trigger.trigger_name
           AND trigger_row.tgfoid = v_pair_function::oid
           AND NOT trigger_row.tgisinternal
           AND trigger_row.tgenabled <> 'D'
       )
     )
  THEN
    RAISE EXCEPTION
      'canonical direct-message pair serializer authority is required';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'start_direct_message_conversation_atomic'
      AND (
        v_start_function IS NULL
        OR function_row.oid <> v_start_function::oid
      )
  ) THEN
    RAISE EXCEPTION
      'ambiguous direct-message conversation-start overload exists';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.start_direct_message_conversation_atomic(
  p_sender_id uuid,
  p_receiver_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_user1_id uuid;
  v_user2_id uuid;
  v_identity_ids uuid[];
  v_locked_auth_ids uuid[] := ARRAY[]::uuid[];
  v_identity_id uuid;
  v_identity record;
  v_profile record;
  v_sender_active boolean := false;
  v_receiver_active boolean := false;
  v_receiver_handle text;
  v_pair text;
  v_permission jsonb;
  v_allowed boolean;
  v_reason text;
  v_is_mutual boolean := false;
  v_sent_count bigint;
  v_message_limit jsonb := 'null'::jsonb;
  v_conversation_id uuid;
  v_created boolean := false;
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

  v_user1_id := LEAST(p_sender_id, p_receiver_id);
  v_user2_id := GREATEST(p_sender_id, p_receiver_id);
  v_identity_ids := ARRAY[v_user1_id, v_user2_id]::uuid[];
  v_pair := v_user1_id::text || ':' || v_user2_id::text;

  -- Lifecycle writers and the global inactive-subject barrier take these
  -- admission locks first. UUID ordering gives every two-account operation a
  -- single deadlock-free parent order.
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

  IF NOT p_sender_id = ANY(v_locked_auth_ids) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'SENDER_UNAVAILABLE'
    );
  END IF;
  IF NOT p_receiver_id = ANY(v_locked_auth_ids) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'USER_NOT_FOUND'
    );
  END IF;

  -- Block, follow, and message-limit mutations share this unordered-pair key.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('direct-message:pair:' || v_pair, 0)
  );

  -- Privacy and lifecycle fields are re-read only after all parent locks.
  FOR v_profile IN
    SELECT
      profile.id,
      profile.handle,
      profile.deleted_at,
      profile.banned_at,
      profile.is_banned,
      profile.ban_expires_at
    FROM public.user_profiles AS profile
    WHERE profile.id = ANY(v_identity_ids)
    ORDER BY profile.id
    FOR SHARE
  LOOP
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
      IF v_profile.id = p_sender_id THEN
        v_sender_active := true;
      END IF;
      IF v_profile.id = p_receiver_id THEN
        v_receiver_active := true;
        v_receiver_handle := v_profile.handle;
      END IF;
    END IF;
  END LOOP;

  IF NOT v_sender_active THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'SENDER_UNAVAILABLE'
    );
  END IF;
  IF NOT v_receiver_active THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'USER_NOT_FOUND'
    );
  END IF;

  v_permission := public.check_dm_permission(p_sender_id, p_receiver_id);

  -- The dependency has a deliberately small union contract. Reject extra
  -- keys, wrong JSON types, mixed success/denial fields, and fractional counts
  -- before using its decision or creating any relationship row.
  IF pg_catalog.jsonb_typeof(v_permission) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_permission -> 'allowed')
          IS DISTINCT FROM 'boolean'
     OR v_permission - ARRAY[
       'allowed',
       'reason',
       'is_mutual',
       'receiver_replied',
       'sent_count'
     ]::text[] <> '{}'::jsonb
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'check_dm_permission returned an invalid contract';
  END IF;

  v_allowed := (v_permission ->> 'allowed')::boolean;
  v_reason := v_permission ->> 'reason';

  IF v_permission = pg_catalog.jsonb_build_object('allowed', true) THEN
    NULL;
  ELSIF v_permission = pg_catalog.jsonb_build_object(
    'allowed', true,
    'is_mutual', true
  ) THEN
    v_is_mutual := true;
  ELSIF v_permission = pg_catalog.jsonb_build_object(
    'allowed', true,
    'receiver_replied', true
  ) THEN
    NULL;
  ELSIF v_allowed
     AND pg_catalog.jsonb_typeof(v_permission -> 'sent_count') = 'number'
     AND (v_permission ->> 'sent_count') ~ '^[0-9]+$'
     AND (v_permission ->> 'sent_count')::bigint BETWEEN 0 AND 2
     AND v_permission ? 'reason'
     AND v_permission -> 'reason' = 'null'::jsonb
     AND NOT v_permission ? 'is_mutual'
     AND NOT v_permission ? 'receiver_replied'
  THEN
    v_sent_count := (v_permission ->> 'sent_count')::bigint;
    v_message_limit := pg_catalog.jsonb_build_object(
      'reached', false,
      'sent', v_sent_count,
      'max', 3
    );
  ELSIF NOT v_allowed
     AND v_reason IN (
       'BLOCKED',
       'DM_DISABLED',
       'SENDER_UNAVAILABLE',
       'USER_NOT_FOUND'
     )
     AND v_permission = pg_catalog.jsonb_build_object(
       'allowed', false,
       'reason', v_reason
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', v_reason
    );
  ELSIF NOT v_allowed
     AND v_reason = 'LIMIT_REACHED'
     AND pg_catalog.jsonb_typeof(v_permission -> 'sent_count') = 'number'
     AND (v_permission ->> 'sent_count') ~ '^[0-9]+$'
     AND (v_permission ->> 'sent_count')::bigint >= 3
     AND NOT v_permission ? 'is_mutual'
     AND NOT v_permission ? 'receiver_replied'
  THEN
    v_sent_count := (v_permission ->> 'sent_count')::bigint;
    v_message_limit := pg_catalog.jsonb_build_object(
      'reached', true,
      'sent', v_sent_count,
      'max', 3
    );
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'check_dm_permission returned an invalid contract';
  END IF;

  -- A reached limit proves prior messages and therefore a canonical parent.
  -- Never manufacture an empty relationship merely to report a denial.
  IF v_reason = 'LIMIT_REACHED' THEN
    SELECT conversation.id
    INTO v_conversation_id
    FROM public.conversations AS conversation
    WHERE conversation.user1_id = LEAST(p_sender_id, p_receiver_id)
      AND conversation.user2_id = GREATEST(p_sender_id, p_receiver_id)
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'message limit has no canonical conversation';
    END IF;
  ELSE
    INSERT INTO public.conversations (user1_id, user2_id)
    VALUES (
      LEAST(p_sender_id, p_receiver_id),
      GREATEST(p_sender_id, p_receiver_id)
    )
    ON CONFLICT (user1_id, user2_id) DO NOTHING
    RETURNING id INTO v_conversation_id;

    v_created := v_conversation_id IS NOT NULL;

    SELECT conversation.id
    INTO STRICT v_conversation_id
    FROM public.conversations AS conversation
    WHERE conversation.user1_id = LEAST(p_sender_id, p_receiver_id)
      AND conversation.user2_id = GREATEST(p_sender_id, p_receiver_id)
    FOR SHARE;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'sender_id', p_sender_id,
    'receiver_id', p_receiver_id,
    'conversation_id', v_conversation_id,
    'receiver_handle', v_receiver_handle,
    'can_message', v_allowed,
    'is_mutual_follow', v_is_mutual,
    'message_limit', v_message_limit,
    'created', v_created
  );
END
$function$;

ALTER FUNCTION public.start_direct_message_conversation_atomic(uuid, uuid)
  OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.start_direct_message_conversation_atomic(uuid,uuid)'::regprocedure;
  v_function_oid oid := v_function::oid;
  v_owner_oid oid;
  v_source text;
  v_grantee record;
BEGIN
  SELECT function_row.proowner, function_row.prosrc
  INTO STRICT v_owner_oid, v_source
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
      AND acl_entry.privilege_type = 'EXECUTE'
      AND acl_entry.grantee NOT IN (
        v_owner_oid,
        pg_catalog.to_regrole('service_role')::oid
      )
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
    ON FUNCTION public.start_direct_message_conversation_atomic(uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.start_direct_message_conversation_atomic(uuid, uuid)
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-direct-message-conversation-start:v1:'
      || pg_catalog.md5(v_source)
  );

  IF pg_catalog.strpos(v_source, 'account-recovery-admission:') = 0
     OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') = 0
     OR pg_catalog.strpos(v_source, 'direct-message:pair:') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') = 0
     OR pg_catalog.strpos(v_source, 'public.check_dm_permission') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.conversations AS conversation') = 0
     OR pg_catalog.strpos(v_source, 'INSERT INTO public.conversations') = 0
  THEN
    RAISE EXCEPTION
      'atomic direct-message conversation-start function contract drifted';
  END IF;
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.start_direct_message_conversation_atomic(uuid,uuid)'::regprocedure;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.prokind = 'f'
      AND function_row.proowner = pg_catalog.to_regrole('postgres')::oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'jsonb'::regtype
      AND function_row.pronargs = 2
      AND function_row.pronargdefaults = 0
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
  )
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
       JOIN pg_catalog.pg_namespace AS function_schema
         ON function_schema.oid = function_row.pronamespace
       WHERE function_schema.nspname = 'public'
         AND function_row.proname = 'start_direct_message_conversation_atomic'
         AND function_row.oid <> v_function
     )
  THEN
    RAISE EXCEPTION
      'direct-message conversation-start service-only RPC drifted';
  END IF;
END
$postflight$;

-- Even though this migration adds no relation, running both deployment-window
-- hooks proves that no pre-existing public mutation surface drifted while the
-- new service authority was installed.
SELECT public.install_active_authenticated_subject_mutation_barriers();
SELECT public.assert_active_authenticated_subject_mutation_barriers();

NOTIFY pgrst, 'reload schema';

COMMIT;
