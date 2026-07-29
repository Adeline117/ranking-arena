-- Migration: 20260729158000_atomic_direct_message_reaction_toggle.sql
-- Created: 2026-07-30T02:00:00Z
-- Description: Make a direct-message emoji toggle, its canonical aggregates,
--   replay acknowledgement, and reaction notification one transaction. The
--   operation ledger prevents an uncertain transport retry from toggling the
--   reaction back, while the existing direct-message pair serializer keeps
--   block, account, conversation, message-delete, and reaction state ordered.
--
-- Forward compensation: roll API callers back before dropping this function
-- and its private replay ledger in a later forward migration.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.message_reactions:atomic-toggle:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic direct-message reaction migration lock is busy';
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
  v_pair_function regprocedure :=
    pg_catalog.to_regprocedure('public.serialize_direct_message_pair_edge()');
  v_pair_source text;
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['anon', 'authenticated', 'service_role', 'postgres']::text[]
  ) AS required_role
  WHERE pg_catalog.to_regrole(required_role) IS NULL;

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION
      'direct-message reaction roles are missing: %',
      v_missing_roles;
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.conversations') IS NULL
     OR pg_catalog.to_regclass('public.direct_messages') IS NULL
     OR pg_catalog.to_regclass('public.message_reactions') IS NULL
     OR pg_catalog.to_regclass('public.blocked_users') IS NULL
     OR pg_catalog.to_regclass('public.notifications') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.install_active_authenticated_subject_mutation_barriers()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.assert_active_authenticated_subject_mutation_barriers()'
     ) IS NULL
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
      'public.direct_messages'::regclass,
      'public.message_reactions'::regclass,
      'public.blocked_users'::regclass,
      'public.notifications'::regclass
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
      'public.direct_messages'::regclass,
      'public.message_reactions'::regclass,
      'public.blocked_users'::regclass,
      'public.notifications'::regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION
      'direct-message reaction requires canonical permanent relation ownership';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.conversations'::regclass,
      'public.direct_messages'::regclass,
      'public.message_reactions'::regclass,
      'public.blocked_users'::regclass,
      'public.notifications'::regclass
    )
       OR inheritance.inhparent IN (
         'auth.users'::regclass,
         'public.user_profiles'::regclass,
         'public.conversations'::regclass,
         'public.direct_messages'::regclass,
         'public.message_reactions'::regclass,
         'public.blocked_users'::regclass,
         'public.notifications'::regclass
       )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.conversations'::regclass,
      'public.direct_messages'::regclass,
      'public.message_reactions'::regclass,
      'public.blocked_users'::regclass,
      'public.notifications'::regclass
    )
  ) THEN
    RAISE EXCEPTION
      'direct-message reaction relations must not use inheritance or rewrite rules';
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
      ('public', 'user_profiles', 3, 'deleted_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 4, 'banned_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 5, 'is_banned', 'boolean'::regtype, false),
      ('public', 'user_profiles', 6, 'ban_expires_at', 'timestamptz'::regtype, false),
      ('public', 'conversations', 1, 'id', 'uuid'::regtype, true),
      ('public', 'conversations', 2, 'user1_id', 'uuid'::regtype, true),
      ('public', 'conversations', 3, 'user2_id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 1, 'id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 2, 'conversation_id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 3, 'sender_id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 4, 'receiver_id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 5, 'content', 'text'::regtype, true),
      ('public', 'direct_messages', 6, 'deleted_at', 'timestamptz'::regtype, false),
      ('public', 'message_reactions', 1, 'id', 'uuid'::regtype, true),
      ('public', 'message_reactions', 2, 'message_id', 'uuid'::regtype, true),
      ('public', 'message_reactions', 3, 'user_id', 'uuid'::regtype, true),
      ('public', 'message_reactions', 4, 'emoji', 'text'::regtype, true),
      ('public', 'message_reactions', 5, 'created_at', 'timestamptz'::regtype, false),
      ('public', 'blocked_users', 1, 'blocker_id', 'uuid'::regtype, true),
      ('public', 'blocked_users', 2, 'blocked_id', 'uuid'::regtype, true),
      ('public', 'notifications', 1, 'id', 'uuid'::regtype, true),
      ('public', 'notifications', 2, 'user_id', 'uuid'::regtype, true),
      ('public', 'notifications', 3, 'type', 'text'::regtype, true),
      ('public', 'notifications', 4, 'title', 'text'::regtype, false),
      ('public', 'notifications', 5, 'message', 'text'::regtype, false),
      ('public', 'notifications', 6, 'link', 'text'::regtype, false),
      ('public', 'notifications', 7, 'actor_id', 'uuid'::regtype, false),
      ('public', 'notifications', 8, 'reference_id', 'text'::regtype, false),
      ('public', 'notifications', 9, 'read', 'boolean'::regtype, false),
      ('public', 'notifications', 10, 'created_at', 'timestamptz'::regtype, false)
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
      'direct-message reaction has incompatible columns: %',
      v_invalid_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.message_reactions'::regclass
      AND constraint_row.contype = 'u'
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
      AND constraint_row.convalidated
  ) THEN
    RAISE EXCEPTION
      'message_reactions requires UNIQUE (message_id, user_id, emoji)';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_pair_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_pair_function;

  IF pg_catalog.strpos(v_pair_source, 'direct-message:pair:') = 0
     OR pg_catalog.strpos(v_pair_source, $$WHEN 'blocked_users'$$) = 0
     OR pg_catalog.strpos(v_pair_source, $$WHEN 'direct_messages'$$) = 0
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'public.blocked_users'::regclass
         AND trigger_row.tgname = 'trg_serialize_dm_block_pair'
         AND trigger_row.tgfoid = v_pair_function
         AND trigger_row.tgenabled <> 'D'
         AND NOT trigger_row.tgisinternal
     )
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

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'toggle_direct_message_reaction_atomic'
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid)
        <> 'p_operation_id uuid, p_message_id uuid, p_actor_id uuid, p_emoji text'
  ) THEN
    RAISE EXCEPTION
      'incompatible toggle_direct_message_reaction_atomic overload exists';
  END IF;
END
$preflight$;

DO $create_private_replay_ledger$
BEGIN
  IF pg_catalog.to_regclass(
    'public.direct_message_reaction_operations'
  ) IS NULL THEN
    CREATE TABLE public.direct_message_reaction_operations (
      operation_id uuid NOT NULL,
      actor_id uuid NOT NULL,
      message_id uuid NOT NULL,
      intent_fingerprint text NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
      CONSTRAINT direct_message_reaction_operations_pkey
        PRIMARY KEY (operation_id),
      CONSTRAINT direct_message_reaction_fingerprint_check
        CHECK (intent_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT direct_message_reaction_result_check CHECK (
        pg_catalog.jsonb_typeof(result) = 'object'
        AND NOT result ? 'applied'
        AND result ?& ARRAY[
          'success',
          'operation_id',
          'actor_id',
          'message_id',
          'conversation_id',
          'reaction_id',
          'emoji',
          'action',
          'changed',
          'counts',
          'user_emojis',
          'notification_id',
          'notification_created'
        ]
        AND result ->> 'success' = 'true'
        AND result ->> 'operation_id' = operation_id::text
        AND result ->> 'actor_id' = actor_id::text
        AND result ->> 'message_id' = message_id::text
        AND result ->> 'action' IN ('added', 'removed')
        AND result ->> 'changed' = 'true'
        AND pg_catalog.jsonb_typeof(result -> 'counts') = 'object'
        AND pg_catalog.jsonb_typeof(result -> 'user_emojis') = 'array'
        AND pg_catalog.jsonb_typeof(result -> 'notification_created') = 'boolean'
        AND (
          result -> 'notification_id' = 'null'::jsonb
          OR pg_catalog.jsonb_typeof(result -> 'notification_id') = 'string'
        )
      )
    );
  END IF;
END
$create_private_replay_ledger$;

-- The ledger is both the idempotency record and the runtime/deployment
-- barrier. Dependency locks make catalog attestation, writer revocation, and
-- function publication one indivisible deployment.
LOCK TABLE public.direct_message_reaction_operations
  IN ACCESS EXCLUSIVE MODE;
LOCK TABLE auth.users,
  public.user_profiles,
  public.conversations,
  public.direct_messages,
  public.message_reactions,
  public.blocked_users,
  public.notifications
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.direct_message_reaction_operations OWNER TO postgres;
ALTER TABLE public.direct_message_reaction_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES
  ON TABLE public.direct_message_reaction_operations
  FROM PUBLIC, anon, authenticated, service_role;

-- Authenticated clients retain private realtime reads through the existing RLS
-- policy, but every reaction write now goes through the service-only RPC.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON TABLE public.message_reactions
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE
  ON TABLE public.message_reactions
  TO service_role;

DO $ledger_attestation$
DECLARE
  v_ledger regclass :=
    'public.direct_message_reaction_operations'::regclass;
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_invalid_columns text[];
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_ledger
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
        OR relation.relowner <> v_postgres_oid
        OR NOT relation.relrowsecurity
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = v_ledger
       OR inheritance.inhparent = v_ledger
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid = v_ledger
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_ledger
      AND constraint_row.contype = 'f'
  ) THEN
    RAISE EXCEPTION
      'direct-message reaction replay ledger catalog drifted';
  END IF;

  SELECT pg_catalog.array_agg(
    pg_catalog.format(
      '%I expected %s%s',
      required.name,
      required.type_oid::regtype,
      CASE WHEN required.not_null THEN ' NOT NULL' ELSE '' END
    )
    ORDER BY required.ordinality
  )
  INTO v_invalid_columns
  FROM (
    VALUES
      (1, 'operation_id', 'uuid'::regtype, true),
      (2, 'actor_id', 'uuid'::regtype, true),
      (3, 'message_id', 'uuid'::regtype, true),
      (4, 'intent_fingerprint', 'text'::regtype, true),
      (5, 'result', 'jsonb'::regtype, true),
      (6, 'created_at', 'timestamptz'::regtype, true)
  ) AS required(ordinality, name, type_oid, not_null)
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = v_ledger
   AND attribute.attname = required.name
   AND attribute.attnum = required.ordinality
   AND NOT attribute.attisdropped
  WHERE attribute.attname IS NULL
     OR attribute.atttypid <> required.type_oid
     OR (required.not_null AND NOT attribute.attnotnull);

  IF v_invalid_columns IS NOT NULL OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_ledger
      AND attribute.attnum > 6
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION
      'direct-message reaction replay ledger columns drifted: %',
      v_invalid_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_ledger
      AND constraint_row.conname = 'direct_message_reaction_operations_pkey'
      AND constraint_row.contype = 'p'
      AND constraint_row.convalidated
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_ledger
      AND constraint_row.conname = 'direct_message_reaction_fingerprint_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_ledger
      AND constraint_row.conname = 'direct_message_reaction_result_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  ) THEN
    RAISE EXCEPTION
      'direct-message reaction replay ledger constraints drifted';
  END IF;
END
$ledger_attestation$;

CREATE OR REPLACE FUNCTION public.toggle_direct_message_reaction_atomic(
  p_operation_id uuid,
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
  v_emoji text;
  v_intent_fingerprint text;
  v_existing public.direct_message_reaction_operations%ROWTYPE;
  v_initial_conversation_id uuid;
  v_initial_sender_id uuid;
  v_initial_receiver_id uuid;
  v_conversation_id uuid;
  v_sender_id uuid;
  v_receiver_id uuid;
  v_message_content text;
  v_deleted_at timestamptz;
  v_user1_id uuid;
  v_user2_id uuid;
  v_pair text;
  v_identity_ids uuid[];
  v_locked_auth_ids uuid[] := ARRAY[]::uuid[];
  v_actor_active boolean := false;
  v_sender_active boolean := false;
  v_receiver_active boolean := false;
  v_actor_handle text;
  v_identity record;
  v_profile record;
  v_other_id uuid;
  v_reaction_id uuid;
  v_action text;
  v_changed_count integer := 0;
  v_counts jsonb := '{}'::jsonb;
  v_user_emojis text[] := ARRAY[]::text[];
  v_notification_id uuid;
  v_notification_created boolean := false;
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  -- Deployment replay takes ACCESS EXCLUSIVE on this relation before touching
  -- dependencies. Every runtime takes the weaker barrier first.
  LOCK TABLE public.direct_message_reaction_operations
    IN ROW EXCLUSIVE MODE;

  IF p_operation_id IS NULL
     OR p_message_id IS NULL
     OR p_actor_id IS NULL
     OR p_emoji IS NULL
     OR pg_catalog.octet_length(p_emoji) > 40
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  v_emoji := normalize(p_emoji, NFC);
  IF p_emoji IS DISTINCT FROM v_emoji
     OR v_emoji NOT IN (
       '👍', '🔥', '💎', '🚀', '❤️', '👀',
       '🎯', '💰', '📈', '📉', '🤔', '😂'
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  v_intent_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        'direct-message-reaction:v1',
        p_message_id,
        v_emoji
      )::text,
      'UTF8'
    )),
    'hex'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'direct-message-reaction-operation:' || p_operation_id::text,
      0
    )
  );

  SELECT operation_row.*
  INTO v_existing
  FROM public.direct_message_reaction_operations AS operation_row
  WHERE operation_row.operation_id = p_operation_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.actor_id IS DISTINCT FROM p_actor_id
       OR v_existing.message_id IS DISTINCT FROM p_message_id
       OR v_existing.intent_fingerprint IS DISTINCT FROM v_intent_fingerprint
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'OPERATION_CONFLICT'
      );
    END IF;

    RETURN v_existing.result
      || pg_catalog.jsonb_build_object('applied', false);
  END IF;

  -- This first snapshot only derives canonical lock keys. Every security
  -- relevant field is read again after account, pair, parent, and child locks.
  SELECT
    message_row.conversation_id,
    message_row.sender_id,
    message_row.receiver_id
  INTO
    v_initial_conversation_id,
    v_initial_sender_id,
    v_initial_receiver_id
  FROM public.direct_messages AS message_row
  WHERE message_row.id = p_message_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'MESSAGE_NOT_FOUND'
    );
  END IF;

  IF v_initial_conversation_id IS NULL
     OR v_initial_sender_id IS NULL
     OR v_initial_receiver_id IS NULL
     OR v_initial_sender_id = v_initial_receiver_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'direct message has an invalid canonical identity';
  END IF;

  SELECT pg_catalog.array_agg(identity_id ORDER BY identity_id)
  INTO STRICT v_identity_ids
  FROM (
    SELECT DISTINCT candidate.identity_id
    FROM pg_catalog.unnest(ARRAY[
      p_actor_id,
      v_initial_sender_id,
      v_initial_receiver_id
    ]::uuid[]) AS candidate(identity_id)
  ) AS identity;

  -- The global inactive-subject barrier and lifecycle mutations use these
  -- account admission keys. Taking them before auth/profile rows prevents a
  -- stale service request from crossing a soft-delete, ban, recovery, or hard
  -- deletion boundary.
  FOREACH v_other_id IN ARRAY v_identity_ids LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'account-recovery-admission:' || v_other_id::text,
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
  IF NOT v_initial_sender_id = ANY(v_locked_auth_ids)
     OR NOT v_initial_receiver_id = ANY(v_locked_auth_ids)
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'PARTICIPANT_UNAVAILABLE'
    );
  END IF;

  v_pair := LEAST(
    v_initial_sender_id::text,
    v_initial_receiver_id::text
  ) || ':' || GREATEST(
    v_initial_sender_id::text,
    v_initial_receiver_id::text
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('direct-message:pair:' || v_pair, 0)
  );

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
      IF v_profile.id = p_actor_id THEN
        v_actor_active := true;
        v_actor_handle := v_profile.handle;
      END IF;
      IF v_profile.id = v_initial_sender_id THEN
        v_sender_active := true;
      END IF;
      IF v_profile.id = v_initial_receiver_id THEN
        v_receiver_active := true;
      END IF;
    END IF;
  END LOOP;

  IF NOT v_actor_active THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;
  IF NOT v_sender_active OR NOT v_receiver_active THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'PARTICIPANT_UNAVAILABLE'
    );
  END IF;

  SELECT conversation.user1_id, conversation.user2_id
  INTO v_user1_id, v_user2_id
  FROM public.conversations AS conversation
  WHERE conversation.id = v_initial_conversation_id
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'MESSAGE_NOT_FOUND'
    );
  END IF;

  SELECT
    message_row.conversation_id,
    message_row.sender_id,
    message_row.receiver_id,
    message_row.content,
    message_row.deleted_at
  INTO
    v_conversation_id,
    v_sender_id,
    v_receiver_id,
    v_message_content,
    v_deleted_at
  FROM public.direct_messages AS message_row
  WHERE message_row.id = p_message_id
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'MESSAGE_NOT_FOUND'
    );
  END IF;

  IF v_conversation_id IS DISTINCT FROM v_initial_conversation_id
     OR v_sender_id IS DISTINCT FROM v_initial_sender_id
     OR v_receiver_id IS DISTINCT FROM v_initial_receiver_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'direct-message identity changed while locking; retry';
  END IF;

  IF v_user1_id IS DISTINCT FROM LEAST(v_sender_id, v_receiver_id)
     OR v_user2_id IS DISTINCT FROM GREATEST(v_sender_id, v_receiver_id)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'direct message is outside its canonical conversation pair';
  END IF;

  IF p_actor_id <> v_sender_id AND p_actor_id <> v_receiver_id THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'FORBIDDEN'
    );
  END IF;

  IF v_deleted_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'MESSAGE_NOT_FOUND'
    );
  END IF;

  v_other_id := CASE
    WHEN p_actor_id = v_sender_id THEN v_receiver_id
    ELSE v_sender_id
  END;

  IF EXISTS (
    SELECT 1
    FROM public.blocked_users AS block_edge
    WHERE (
      block_edge.blocker_id = p_actor_id
      AND block_edge.blocked_id = v_other_id
    ) OR (
      block_edge.blocker_id = v_other_id
      AND block_edge.blocked_id = p_actor_id
    )
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'BLOCKED'
    );
  END IF;

  SELECT reaction.id
  INTO v_reaction_id
  FROM public.message_reactions AS reaction
  WHERE reaction.message_id = p_message_id
    AND reaction.user_id = p_actor_id
    AND reaction.emoji = v_emoji
  FOR UPDATE;

  IF FOUND THEN
    DELETE FROM public.message_reactions AS reaction
    WHERE reaction.id = v_reaction_id
      AND reaction.message_id = p_message_id
      AND reaction.user_id = p_actor_id
      AND reaction.emoji = v_emoji;
    GET DIAGNOSTICS v_changed_count = ROW_COUNT;
    v_action := 'removed';
  ELSE
    INSERT INTO public.message_reactions (
      message_id,
      user_id,
      emoji
    ) VALUES (
      p_message_id,
      p_actor_id,
      v_emoji
    )
    ON CONFLICT (message_id, user_id, emoji) DO NOTHING
    RETURNING id INTO v_reaction_id;
    GET DIAGNOSTICS v_changed_count = ROW_COUNT;
    v_action := 'added';
  END IF;

  IF v_changed_count <> 1 OR v_reaction_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'direct-message reaction changed concurrently; retry';
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_object_agg(reaction_count.emoji, reaction_count.total),
    '{}'::jsonb
  )
  INTO STRICT v_counts
  FROM (
    SELECT reaction.emoji, pg_catalog.count(*) AS total
    FROM public.message_reactions AS reaction
    WHERE reaction.message_id = p_message_id
      AND reaction.emoji IN (
        '👍', '🔥', '💎', '🚀', '❤️', '👀',
        '🎯', '💰', '📈', '📉', '🤔', '😂'
      )
    GROUP BY reaction.emoji
    ORDER BY reaction.emoji
  ) AS reaction_count;

  SELECT COALESCE(
    pg_catalog.array_agg(reaction.emoji ORDER BY reaction.emoji),
    ARRAY[]::text[]
  )
  INTO STRICT v_user_emojis
  FROM public.message_reactions AS reaction
  WHERE reaction.message_id = p_message_id
    AND reaction.user_id = p_actor_id
    AND reaction.emoji IN (
      '👍', '🔥', '💎', '🚀', '❤️', '👀',
      '🎯', '💰', '📈', '📉', '🤔', '😂'
    );

  IF (v_action = 'added' AND NOT v_emoji = ANY(v_user_emojis))
     OR (v_action = 'removed' AND v_emoji = ANY(v_user_emojis))
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'direct-message reaction aggregate acknowledgement is incomplete';
  END IF;

  -- Preserve the prior one-hour notification dedup contract, but make both the
  -- lookup and insert part of this transaction. A failed notification insert
  -- therefore rolls the reaction and ledger back as one unit.
  IF v_action = 'added' AND v_sender_id <> p_actor_id THEN
    SELECT notification.id
    INTO v_notification_id
    FROM public.notifications AS notification
    WHERE notification.user_id = v_sender_id
      AND notification.type = 'reaction'
      AND notification.actor_id = p_actor_id
      AND notification.reference_id = p_message_id::text
      AND notification.created_at >=
        pg_catalog.statement_timestamp() - INTERVAL '1 hour'
    ORDER BY notification.created_at DESC, notification.id DESC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.notifications (
        user_id,
        type,
        title,
        message,
        actor_id,
        link,
        reference_id,
        read,
        created_at
      ) VALUES (
        v_sender_id,
        'reaction',
        v_actor_handle || ' reacted ' || v_emoji || ' to your message',
        COALESCE(NULLIF(pg_catalog.left(v_message_content, 100), ''), 'your message'),
        p_actor_id,
        '/messages/' || v_conversation_id::text,
        p_message_id::text,
        false,
        pg_catalog.clock_timestamp()
      )
      RETURNING id INTO v_notification_id;
      v_notification_created := true;
    END IF;
  END IF;

  v_result := pg_catalog.jsonb_build_object(
    'success', true,
    'operation_id', p_operation_id,
    'actor_id', p_actor_id,
    'message_id', p_message_id,
    'conversation_id', v_conversation_id,
    'reaction_id', v_reaction_id,
    'emoji', v_emoji,
    'action', v_action,
    'changed', true,
    'counts', v_counts,
    'user_emojis', pg_catalog.to_jsonb(v_user_emojis),
    'notification_id', pg_catalog.to_jsonb(v_notification_id),
    'notification_created', v_notification_created
  );

  INSERT INTO public.direct_message_reaction_operations (
    operation_id,
    actor_id,
    message_id,
    intent_fingerprint,
    result
  ) VALUES (
    p_operation_id,
    p_actor_id,
    p_message_id,
    v_intent_fingerprint,
    v_result
  );

  RETURN v_result || pg_catalog.jsonb_build_object('applied', true);
END
$function$;

ALTER FUNCTION public.toggle_direct_message_reaction_atomic(
  uuid, uuid, uuid, text
) OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.toggle_direct_message_reaction_atomic(uuid,uuid,uuid,text)'::regprocedure;
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
    ON FUNCTION public.toggle_direct_message_reaction_atomic(
      uuid, uuid, uuid, text
    )
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.toggle_direct_message_reaction_atomic(
      uuid, uuid, uuid, text
    )
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-direct-message-reaction-toggle:v1:' || pg_catalog.md5(v_source)
  );

  IF pg_catalog.strpos(v_source, 'direct-message-reaction-operation:') = 0
     OR pg_catalog.strpos(v_source, 'account-recovery-admission:') = 0
     OR pg_catalog.strpos(v_source, 'direct-message:pair:') = 0
     OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.conversations AS conversation') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.direct_messages AS message_row') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.blocked_users AS block_edge') = 0
     OR pg_catalog.strpos(v_source, 'INSERT INTO public.message_reactions') = 0
     OR pg_catalog.strpos(v_source, 'DELETE FROM public.message_reactions') = 0
     OR pg_catalog.strpos(v_source, 'INSERT INTO public.notifications') = 0
     OR pg_catalog.strpos(
       v_source,
       'INSERT INTO public.direct_message_reaction_operations'
     ) = 0
  THEN
    RAISE EXCEPTION
      'atomic direct-message reaction function contract drifted';
  END IF;
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_ledger regclass :=
    'public.direct_message_reaction_operations'::regclass;
  v_function regprocedure :=
    'public.toggle_direct_message_reaction_atomic(uuid,uuid,uuid,text)'::regprocedure;
BEGIN
  IF pg_catalog.has_table_privilege('anon', v_ledger, 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', v_ledger, 'SELECT')
     OR pg_catalog.has_table_privilege('service_role', v_ledger, 'SELECT')
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.aclexplode(
         COALESCE(
           (
             SELECT relation.relacl
             FROM pg_catalog.pg_class AS relation
             WHERE relation.oid = v_ledger
           ),
           '{}'::aclitem[]
         )
       ) AS acl_entry
       WHERE acl_entry.grantee = 0
     )
  THEN
    RAISE EXCEPTION
      'direct-message reaction replay ledger privacy drifted';
  END IF;

  IF pg_catalog.has_table_privilege(
       'anon', 'public.message_reactions', 'INSERT,UPDATE,DELETE,TRUNCATE'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated',
       'public.message_reactions',
       'INSERT,UPDATE,DELETE,TRUNCATE'
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
  THEN
    RAISE EXCEPTION
      'direct-message reaction service-only write boundary drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'toggle_direct_message_reaction_atomic'
      AND function_row.oid <> v_function
  ) THEN
    RAISE EXCEPTION
      'ambiguous direct-message reaction overload remains';
  END IF;
END
$postflight$;

-- This migration creates a public relation after the global inactive-user
-- mutation barrier. Converge and attest its statement guard in the same
-- transaction, before PostgREST can observe the new RPC.
SELECT public.install_active_authenticated_subject_mutation_barriers();
SELECT public.assert_active_authenticated_subject_mutation_barriers();

NOTIFY pgrst, 'reload schema';

COMMIT;
