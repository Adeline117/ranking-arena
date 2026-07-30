-- Migration: 20260729161500_atomic_direct_message_conversation_read.sql
-- Created: 2026-07-30T05:00:00Z
-- Description: Make direct-message conversation membership, active-reader
--   admission, live inbound-message updates, and read acknowledgement one
--   service-only transaction. The update is naturally idempotent because read
--   state is monotonic; no operation ledger is required.
--
-- Forward compensation: switch the API route back before removing this RPC in
-- a later forward migration. Existing read/read_at values remain canonical.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.direct_messages:atomic-conversation-read:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic direct-message conversation-read migration lock is busy';
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
  v_pair_function regprocedure := pg_catalog.to_regprocedure(
    'public.serialize_direct_message_pair_edge()'
  );
  v_immutable_function regprocedure := pg_catalog.to_regprocedure(
    'public.guard_direct_message_immutable_fields()'
  );
  v_read_function regprocedure := pg_catalog.to_regprocedure(
    'public.mark_direct_message_conversation_read_atomic(uuid,uuid)'
  );
  v_pair_source text;
  v_immutable_source text;
  v_pair_trigger_definition text;
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['anon', 'authenticated', 'service_role', 'postgres']::text[]
  ) AS required_role
  WHERE pg_catalog.to_regrole(required_role) IS NULL;

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION
      'direct-message conversation-read roles are missing: %',
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
     OR v_pair_function IS NULL
     OR v_immutable_function IS NULL
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
      'direct-message conversation-read requires canonical permanent relations';
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
      'direct-message conversation-read relations cannot use inheritance or rewrite rules';
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
      ('public', 'direct_messages', 4, 'receiver_id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 5, 'read', 'boolean'::regtype, false),
      ('public', 'direct_messages', 6, 'read_at', 'timestamptz'::regtype, false),
      ('public', 'direct_messages', 7, 'deleted_at', 'timestamptz'::regtype, false)
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
      'direct-message conversation-read has incompatible columns: %',
      v_invalid_columns;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.conversations AS conversation
    WHERE conversation.user1_id >= conversation.user2_id
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
  ) THEN
    RAISE EXCEPTION
      'direct-message conversation-read found non-canonical participant data';
  END IF;

  SELECT function_row.prosrc
  INTO v_pair_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_pair_function
    AND function_row.prokind = 'f'
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  SELECT pg_catalog.pg_get_triggerdef(trigger_row.oid, true)
  INTO v_pair_trigger_definition
  FROM pg_catalog.pg_trigger AS trigger_row
  WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
    AND trigger_row.tgname = 'trg_serialize_dm_message_pair'
    AND trigger_row.tgfoid = v_pair_function::oid
    AND NOT trigger_row.tgisinternal
    AND trigger_row.tgenabled <> 'D';

  IF v_pair_source IS NULL
     OR pg_catalog.strpos(v_pair_source, 'direct-message:pair:') = 0
     OR pg_catalog.strpos(v_pair_source, 'blocked_users') = 0
     OR pg_catalog.strpos(v_pair_source, 'user_follows') = 0
     OR pg_catalog.strpos(v_pair_source, 'direct_messages') = 0
     OR v_pair_trigger_definition IS NULL
     OR pg_catalog.strpos(v_pair_trigger_definition, 'deleted_at') = 0
  THEN
    RAISE EXCEPTION
      'canonical direct-message pair serializer authority is required';
  END IF;

  SELECT function_row.prosrc
  INTO v_immutable_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_immutable_function
    AND function_row.prokind = 'f'
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF v_immutable_source IS NULL
     OR pg_catalog.strpos(
       v_immutable_source,
       'ARRAY[''read'', ''read_at'', ''deleted_at'']'
     ) = 0
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
         AND trigger_row.tgname = 'trg_guard_dm_immutable_fields'
         AND trigger_row.tgfoid = v_immutable_function::oid
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled <> 'D'
     )
  THEN
    RAISE EXCEPTION
      'canonical direct-message immutable-field guard is required';
  END IF;

  IF pg_catalog.has_table_privilege(
       'authenticated', 'public.direct_messages', 'INSERT,UPDATE,DELETE,TRUNCATE'
     ) OR pg_catalog.has_table_privilege(
       'anon', 'public.direct_messages', 'INSERT,UPDATE,DELETE,TRUNCATE'
     )
  THEN
    RAISE EXCEPTION
      'browser direct-message writes must remain revoked';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'mark_direct_message_conversation_read_atomic'
      AND (
        v_read_function IS NULL
        OR function_row.oid <> v_read_function::oid
      )
  ) THEN
    RAISE EXCEPTION
      'ambiguous direct-message conversation-read overload exists';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.mark_direct_message_conversation_read_atomic(
  p_conversation_id uuid,
  p_actor_id uuid
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
  v_identity_ids uuid[];
  v_locked_auth_ids uuid[] := ARRAY[]::uuid[];
  v_locked_profile_ids uuid[] := ARRAY[]::uuid[];
  v_identity_id uuid;
  v_identity record;
  v_profile record;
  v_actor_active boolean := false;
  v_pair text;
  v_read_at timestamptz := pg_catalog.statement_timestamp();
  v_marked_count bigint := 0;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_conversation_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'conversation and actor IDs are required';
  END IF;

  -- This first snapshot derives lock keys only. Participant identity and
  -- membership are revalidated under the canonical locks before any update.
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

  v_identity_ids := ARRAY[v_initial_user1_id, v_initial_user2_id]::uuid[];

  -- Account lifecycle admission precedes auth parents, the unordered DM pair,
  -- profiles, the conversation parent, and finally its message children.
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
  IF NOT v_initial_user1_id = ANY(v_locked_auth_ids)
     OR NOT v_initial_user2_id = ANY(v_locked_auth_ids)
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'NOT_FOUND'
    );
  END IF;

  v_pair := v_initial_user1_id::text || ':' || v_initial_user2_id::text;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('direct-message:pair:' || v_pair, 0)
  );

  FOR v_profile IN
    SELECT
      profile.id,
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
    IF v_profile.id = p_actor_id
       AND v_profile.deleted_at IS NULL
       AND v_profile.banned_at IS NULL
       AND NOT (
         v_profile.is_banned IS TRUE
         AND (
           v_profile.ban_expires_at IS NULL
           OR v_profile.ban_expires_at > pg_catalog.statement_timestamp()
         )
       )
    THEN
      v_actor_active := true;
    END IF;
  END LOOP;

  IF NOT v_actor_active THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;
  IF NOT v_initial_user1_id = ANY(v_locked_profile_ids)
     OR NOT v_initial_user2_id = ANY(v_locked_profile_ids)
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'NOT_FOUND'
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

  UPDATE public.direct_messages AS message_row
  SET read = true,
      read_at = v_read_at
  WHERE message_row.conversation_id = p_conversation_id
    AND message_row.receiver_id = p_actor_id
    AND message_row.deleted_at IS NULL
    AND (
      message_row.read IS DISTINCT FROM true
      OR message_row.read_at IS NULL
    );

  GET DIAGNOSTICS v_marked_count = ROW_COUNT;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'actor_id', p_actor_id,
    'conversation_id', p_conversation_id,
    'marked_count', v_marked_count,
    'read_at', v_read_at
  );
END
$function$;

ALTER FUNCTION public.mark_direct_message_conversation_read_atomic(uuid, uuid)
  OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.mark_direct_message_conversation_read_atomic(uuid,uuid)'::regprocedure;
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
    ON FUNCTION public.mark_direct_message_conversation_read_atomic(uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.mark_direct_message_conversation_read_atomic(uuid, uuid)
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-direct-message-conversation-read:v1:'
      || pg_catalog.md5(v_source)
  );

  IF pg_catalog.strpos(v_source, 'account-recovery-admission:') = 0
     OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') = 0
     OR pg_catalog.strpos(v_source, 'direct-message:pair:') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.conversations AS conversation') = 0
     OR pg_catalog.strpos(v_source, 'UPDATE public.direct_messages AS message_row') = 0
     OR pg_catalog.strpos(v_source, 'GET DIAGNOSTICS v_marked_count = ROW_COUNT') = 0
  THEN
    RAISE EXCEPTION
      'atomic direct-message conversation-read function contract drifted';
  END IF;
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.mark_direct_message_conversation_read_atomic(uuid,uuid)'::regprocedure;
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
         AND function_row.proname = 'mark_direct_message_conversation_read_atomic'
         AND function_row.oid <> v_function
     )
  THEN
    RAISE EXCEPTION
      'direct-message conversation-read service-only RPC drifted';
  END IF;
END
$postflight$;

SELECT public.install_active_authenticated_subject_mutation_barriers();
SELECT public.assert_active_authenticated_subject_mutation_barriers();

NOTIFY pgrst, 'reload schema';

COMMIT;
