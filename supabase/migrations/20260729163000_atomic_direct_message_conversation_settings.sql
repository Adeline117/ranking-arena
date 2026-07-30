-- Migration: 20260729163000_atomic_direct_message_conversation_settings.sql
-- Created: 2026-07-30T06:30:00Z
-- Description: Make per-user direct-message settings, clear-history state,
--   and the chat-drawer block action one participant-bound transaction.
--   The canonical user-block authority remains responsible for the actual
--   blocked_users edge, follow cleanup, and counter repair; is_blocked in
--   conversation_members is only its synchronized UI projection.
--
-- Forward compensation: deploy the previous API writer before removing this
-- RPC in a later forward migration. Existing settings remain readable.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.conversation_members:atomic-settings:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic direct-message settings migration lock is busy';
  END IF;
END
$migration_lock$;

-- Freeze the legacy write surface while its exact uniqueness and membership
-- invariants are checked and the service-only boundary is installed.
LOCK TABLE public.conversation_members IN SHARE ROW EXCLUSIVE MODE;

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
  v_block_function regprocedure := pg_catalog.to_regprocedure(
    'public.mutate_user_block_atomic(uuid,uuid,text)'
  );
  v_settings_function regprocedure := pg_catalog.to_regprocedure(
    'public.mutate_direct_message_conversation_settings_atomic(uuid,uuid,text,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean)'
  );
  v_pair_source text;
  v_block_source text;
  v_conversation_attnum smallint;
  v_user_attnum smallint;
  v_named_unique_index regclass := pg_catalog.to_regclass(
    'public.conversation_members_conversation_user_unique'
  );
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['anon', 'authenticated', 'service_role', 'postgres']::text[]
  ) AS required_role
  WHERE pg_catalog.to_regrole(required_role) IS NULL;

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION
      'direct-message settings roles are missing: %',
      v_missing_roles;
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.conversations') IS NULL
     OR pg_catalog.to_regclass('public.conversation_members') IS NULL
     OR pg_catalog.to_regclass('public.blocked_users') IS NULL
     OR pg_catalog.to_regclass('public.user_follows') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.install_active_authenticated_subject_mutation_barriers()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.assert_active_authenticated_subject_mutation_barriers()'
     ) IS NULL
     OR v_pair_function IS NULL
     OR v_block_function IS NULL
  THEN
    RAISE EXCEPTION
      'canonical account, social-edge, and direct-message authorities must deploy first';
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
      'public.blocked_users'::regclass,
      'public.user_follows'::regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION
      'direct-message settings requires canonical permanent relations';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.conversations'::regclass,
      'public.conversation_members'::regclass,
      'public.blocked_users'::regclass,
      'public.user_follows'::regclass
    )
       OR inheritance.inhparent IN (
         'auth.users'::regclass,
         'public.user_profiles'::regclass,
         'public.conversations'::regclass,
         'public.conversation_members'::regclass,
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
      'public.blocked_users'::regclass,
      'public.user_follows'::regclass
    )
  ) THEN
    RAISE EXCEPTION
      'direct-message settings relations cannot use inheritance or rewrite rules';
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
      ('public', 'conversation_members', 1, 'id', 'uuid'::regtype, true),
      ('public', 'conversation_members', 2, 'conversation_id', 'uuid'::regtype, true),
      ('public', 'conversation_members', 3, 'user_id', 'uuid'::regtype, true),
      ('public', 'conversation_members', 4, 'remark', 'text'::regtype, false),
      ('public', 'conversation_members', 5, 'is_muted', 'boolean'::regtype, true),
      ('public', 'conversation_members', 6, 'is_pinned', 'boolean'::regtype, true),
      ('public', 'conversation_members', 7, 'is_blocked', 'boolean'::regtype, true),
      ('public', 'conversation_members', 8, 'cleared_before', 'timestamptz'::regtype, false),
      ('public', 'conversation_members', 9, 'created_at', 'timestamptz'::regtype, true),
      ('public', 'conversation_members', 10, 'updated_at', 'timestamptz'::regtype, true),
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
      'direct-message settings has incompatible columns: %',
      v_invalid_columns;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.conversation_members AS member_row
    LEFT JOIN public.conversations AS conversation
      ON conversation.id = member_row.conversation_id
    WHERE conversation.id IS NULL
       OR member_row.user_id NOT IN (
         conversation.user1_id,
         conversation.user2_id
       )
       OR member_row.remark IS NOT NULL
          AND pg_catalog.char_length(member_row.remark) > 50
  ) OR EXISTS (
    SELECT 1
    FROM public.conversation_members AS member_row
    GROUP BY member_row.conversation_id, member_row.user_id
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'direct-message settings found invalid, non-member, or duplicate rows';
  END IF;

  SELECT attribute.attnum
  INTO STRICT v_conversation_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.conversation_members'::regclass
    AND attribute.attname = 'conversation_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_user_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.conversation_members'::regclass
    AND attribute.attname = 'user_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF v_named_unique_index IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_index AS index_row
       WHERE index_row.indexrelid = v_named_unique_index
         AND index_row.indrelid = 'public.conversation_members'::regclass
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
         ) = ARRAY[v_conversation_attnum, v_user_attnum]::smallint[]
     )
  THEN
    RAISE EXCEPTION
      'conversation settings unique-index name is occupied incompatibly';
  END IF;

  SELECT function_row.prosrc
  INTO v_pair_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_pair_function
    AND function_row.prokind = 'f'
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v';

  SELECT function_row.prosrc
  INTO v_block_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_block_function
    AND function_row.prokind = 'f'
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prorettype = 'jsonb'::regtype;

  IF v_pair_source IS NULL
     OR pg_catalog.strpos(v_pair_source, 'direct-message:pair:') = 0
     OR pg_catalog.strpos(v_pair_source, 'blocked_users') = 0
     OR pg_catalog.strpos(v_pair_source, 'user_follows') = 0
     OR v_block_source IS NULL
     OR pg_catalog.strpos(v_block_source, 'direct-message:pair:') = 0
     OR pg_catalog.strpos(v_block_source, 'INSERT INTO public.blocked_users') = 0
     OR pg_catalog.strpos(v_block_source, 'DELETE FROM public.user_follows') = 0
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_block_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_block_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_block_function, 'EXECUTE'
     )
  THEN
    RAISE EXCEPTION
      'canonical user-block authority is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname =
        'mutate_direct_message_conversation_settings_atomic'
      AND (
        v_settings_function IS NULL
        OR function_row.oid <> v_settings_function::oid
      )
  ) THEN
    RAISE EXCEPTION
      'ambiguous direct-message settings overload exists';
  END IF;
END
$preflight$;

DO $ensure_exact_unique_key$
DECLARE
  v_conversation_attnum smallint;
  v_user_attnum smallint;
BEGIN
  SELECT attribute.attnum
  INTO STRICT v_conversation_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.conversation_members'::regclass
    AND attribute.attname = 'conversation_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_user_attnum
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
      ) = ARRAY[v_conversation_attnum, v_user_attnum]::smallint[]
  ) THEN
    CREATE UNIQUE INDEX conversation_members_conversation_user_unique
      ON public.conversation_members (conversation_id, user_id);
  END IF;
END
$ensure_exact_unique_key$;

CREATE OR REPLACE FUNCTION public.mutate_direct_message_conversation_settings_atomic(
  p_conversation_id uuid,
  p_actor_id uuid,
  p_remark text,
  p_remark_present boolean,
  p_is_muted boolean,
  p_is_muted_present boolean,
  p_is_pinned boolean,
  p_is_pinned_present boolean,
  p_is_blocked boolean,
  p_is_blocked_present boolean,
  p_clear_history boolean
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
  v_pair text;
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_remark text;
  v_applied_fields text[] := ARRAY[]::text[];
  v_block_result jsonb;
  v_block_status text;
  v_effective_is_blocked boolean;
  v_existing public.conversation_members%ROWTYPE;
  v_result public.conversation_members%ROWTYPE;
  v_created boolean := false;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_conversation_id IS NULL
     OR p_actor_id IS NULL
     OR p_remark_present IS NULL
     OR p_is_muted_present IS NULL
     OR p_is_pinned_present IS NULL
     OR p_is_blocked_present IS NULL
     OR p_clear_history IS NULL
     OR (p_remark_present IS FALSE AND p_remark IS NOT NULL)
     OR (p_is_muted_present IS DISTINCT FROM (p_is_muted IS NOT NULL))
     OR (p_is_pinned_present IS DISTINCT FROM (p_is_pinned IS NOT NULL))
     OR (p_is_blocked_present IS DISTINCT FROM (p_is_blocked IS NOT NULL))
     OR NOT (
       p_remark_present
       OR p_is_muted_present
       OR p_is_pinned_present
       OR p_is_blocked_present
       OR p_clear_history
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  IF p_remark_present THEN
    v_remark := CASE
      WHEN p_remark IS NULL THEN NULL
      ELSE NULLIF(pg_catalog.btrim(p_remark), '')
    END;
    IF v_remark IS NOT NULL
       AND pg_catalog.char_length(v_remark) > 50
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'INVALID'
      );
    END IF;
    v_applied_fields := pg_catalog.array_append(v_applied_fields, 'remark');
  END IF;
  IF p_is_muted_present THEN
    v_applied_fields := pg_catalog.array_append(v_applied_fields, 'is_muted');
  END IF;
  IF p_is_pinned_present THEN
    v_applied_fields := pg_catalog.array_append(v_applied_fields, 'is_pinned');
  END IF;
  IF p_is_blocked_present THEN
    v_applied_fields := pg_catalog.array_append(v_applied_fields, 'is_blocked');
  END IF;
  IF p_clear_history THEN
    v_applied_fields := pg_catalog.array_append(v_applied_fields, 'clear_history');
  END IF;

  -- This first snapshot derives lock keys only. Membership and participant
  -- identity are revalidated after the canonical account and DM locks.
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
  -- -> profiles -> conversation -> this actor's settings row.
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

  -- The nested canonical block authority updates follow counters, so settings
  -- takes both profiles in deterministic UPDATE order before the conversation.
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
    FOR UPDATE
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
           OR v_profile.ban_expires_at > v_now
         )
       )
    THEN
      IF v_profile.id = p_actor_id THEN
        v_actor_active := true;
      ELSIF v_profile.id = v_other_id THEN
        v_participant_active := true;
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

  IF p_is_blocked_present THEN
    v_block_result := public.mutate_user_block_atomic(
      p_actor_id,
      v_other_id,
      CASE WHEN p_is_blocked THEN 'block' ELSE 'unblock' END
    );
    v_block_status := v_block_result ->> 'status';

    IF v_block_status NOT IN (
         'blocked',
         'already_blocked',
         'unblocked',
         'already_unblocked'
       )
       OR (
         p_is_blocked
         AND v_block_status NOT IN ('blocked', 'already_blocked')
       )
       OR (
         NOT p_is_blocked
         AND v_block_status NOT IN ('unblocked', 'already_unblocked')
       )
       OR (v_block_result ->> 'actor_id')::uuid IS DISTINCT FROM p_actor_id
       OR (v_block_result ->> 'target_id')::uuid IS DISTINCT FROM v_other_id
       OR (v_block_result ->> 'action') IS DISTINCT FROM (
         CASE WHEN p_is_blocked THEN 'block' ELSE 'unblock' END
       )
       OR (v_block_result ->> 'blocked')::boolean IS DISTINCT FROM p_is_blocked
       OR (v_block_result ->> 'changed')::boolean IS DISTINCT FROM
          (v_block_status IN ('blocked', 'unblocked'))
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'canonical user-block authority returned inconsistent evidence';
    END IF;
  END IF;

  SELECT EXISTS(
    SELECT 1
    FROM public.blocked_users AS block_edge
    WHERE block_edge.blocker_id = p_actor_id
      AND block_edge.blocked_id = v_other_id
  )
  INTO v_effective_is_blocked;

  IF p_is_blocked_present
     AND v_effective_is_blocked IS DISTINCT FROM p_is_blocked
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'canonical user-block edge disagrees with acknowledgement';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'direct-message:settings:'
        || p_conversation_id::text || ':' || p_actor_id::text,
      0
    )
  );

  SELECT member_row.*
  INTO v_existing
  FROM public.conversation_members AS member_row
  WHERE member_row.conversation_id = p_conversation_id
    AND member_row.user_id = p_actor_id
  FOR UPDATE;

  IF FOUND THEN
    UPDATE public.conversation_members AS member_row
    SET
      remark = CASE
        WHEN p_remark_present THEN v_remark
        ELSE member_row.remark
      END,
      is_muted = CASE
        WHEN p_is_muted_present THEN p_is_muted
        ELSE member_row.is_muted
      END,
      is_pinned = CASE
        WHEN p_is_pinned_present THEN p_is_pinned
        ELSE member_row.is_pinned
      END,
      is_blocked = v_effective_is_blocked,
      cleared_before = CASE
        WHEN p_clear_history
          AND (
            member_row.cleared_before IS NULL
            OR member_row.cleared_before < v_now
          )
          THEN v_now
        ELSE member_row.cleared_before
      END,
      updated_at = v_now
    WHERE member_row.id = v_existing.id
    RETURNING member_row.* INTO STRICT v_result;
  ELSE
    v_created := true;
    INSERT INTO public.conversation_members (
      id,
      conversation_id,
      user_id,
      remark,
      is_muted,
      is_pinned,
      is_blocked,
      cleared_before,
      created_at,
      updated_at
    )
    VALUES (
      pg_catalog.gen_random_uuid(),
      p_conversation_id,
      p_actor_id,
      CASE WHEN p_remark_present THEN v_remark ELSE NULL END,
      CASE WHEN p_is_muted_present THEN p_is_muted ELSE false END,
      CASE WHEN p_is_pinned_present THEN p_is_pinned ELSE false END,
      v_effective_is_blocked,
      CASE WHEN p_clear_history THEN v_now ELSE NULL END,
      v_now,
      v_now
    )
    RETURNING * INTO STRICT v_result;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'actor_id', p_actor_id,
    'target_id', v_other_id,
    'conversation_id', p_conversation_id,
    'created', v_created,
    'applied_fields', pg_catalog.to_jsonb(v_applied_fields),
    'block_status', v_block_status,
    'settings', pg_catalog.jsonb_build_object(
      'remark', v_result.remark,
      'is_muted', v_result.is_muted,
      'is_pinned', v_result.is_pinned,
      'is_blocked', v_result.is_blocked,
      'cleared_before', v_result.cleared_before,
      'updated_at', v_result.updated_at
    )
  );
END
$function$;

ALTER FUNCTION public.mutate_direct_message_conversation_settings_atomic(
  uuid,
  uuid,
  text,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean
) OWNER TO postgres;

-- conversation_members is now an RPC-owned write model. Preserve every read
-- policy, but remove legacy browser/service mutations and their RLS policies.
ALTER TABLE public.conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_members NO FORCE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.conversation_members
  FROM PUBLIC, anon, authenticated, service_role;

DO $revoke_column_mutations$
DECLARE
  v_column_list text;
BEGIN
  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', ' ORDER BY attribute.attnum
  )
  INTO STRICT v_column_list
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.conversation_members'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  EXECUTE pg_catalog.format(
    'REVOKE INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
      || 'ON TABLE public.conversation_members '
      || 'FROM PUBLIC, anon, authenticated, service_role',
    v_column_list
  );
END
$revoke_column_mutations$;

DO $drop_direct_mutation_policies$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.conversation_members'::regclass
      AND policy.polcmd IN ('*', 'a', 'w', 'd')
    ORDER BY policy.polname
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.conversation_members',
      v_policy.polname
    );
  END LOOP;
END
$drop_direct_mutation_policies$;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.mutate_direct_message_conversation_settings_atomic(uuid,uuid,text,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean)'::regprocedure;
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
    ON FUNCTION public.mutate_direct_message_conversation_settings_atomic(
      uuid,
      uuid,
      text,
      boolean,
      boolean,
      boolean,
      boolean,
      boolean,
      boolean,
      boolean,
      boolean
    )
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.mutate_direct_message_conversation_settings_atomic(
      uuid,
      uuid,
      text,
      boolean,
      boolean,
      boolean,
      boolean,
      boolean,
      boolean,
      boolean,
      boolean
    )
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-direct-message-conversation-settings:v1:'
      || pg_catalog.md5(v_source)
  );

  IF pg_catalog.strpos(v_source, 'account-recovery-admission:') = 0
     OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') = 0
     OR pg_catalog.strpos(v_source, 'direct-message:pair:') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.conversations AS conversation') = 0
     OR pg_catalog.strpos(v_source, 'public.mutate_user_block_atomic') = 0
     OR pg_catalog.strpos(v_source, 'direct-message:settings:') = 0
     OR pg_catalog.strpos(v_source, 'UPDATE public.conversation_members') = 0
     OR pg_catalog.strpos(v_source, 'INSERT INTO public.conversation_members') = 0
  THEN
    RAISE EXCEPTION
      'atomic direct-message settings function contract drifted';
  END IF;
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.mutate_direct_message_conversation_settings_atomic(uuid,uuid,text,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean)'::regprocedure;
  v_conversation_attnum smallint;
  v_user_attnum smallint;
  v_role text;
  v_privilege text;
  v_column record;
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
      AND function_row.pronargs = 11
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
         AND function_row.proname =
           'mutate_direct_message_conversation_settings_atomic'
         AND function_row.oid <> v_function
     )
  THEN
    RAISE EXCEPTION
      'direct-message settings service-only RPC drifted';
  END IF;

  SELECT attribute.attnum
  INTO STRICT v_conversation_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.conversation_members'::regclass
    AND attribute.attname = 'conversation_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_user_attnum
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
      ) = ARRAY[v_conversation_attnum, v_user_attnum]::smallint[]
  ) THEN
    RAISE EXCEPTION 'conversation settings exact unique key drifted';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'anon', 'authenticated', 'service_role'
  ]::text[] LOOP
    FOREACH v_privilege IN ARRAY ARRAY[
      'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]::text[] LOOP
      IF pg_catalog.has_table_privilege(
        v_role,
        'public.conversation_members',
        v_privilege
      ) THEN
        RAISE EXCEPTION
          '% retains direct % on conversation_members',
          v_role,
          v_privilege;
      END IF;
    END LOOP;

    FOR v_column IN
      SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = 'public.conversation_members'::regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attnum
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'INSERT', 'UPDATE', 'REFERENCES'
      ]::text[] LOOP
        IF pg_catalog.has_column_privilege(
          v_role,
          'public.conversation_members',
          v_column.attname,
          v_privilege
        ) THEN
          RAISE EXCEPTION
            '% retains column % on conversation_members.%',
            v_role,
            v_privilege,
            v_column.attname;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.conversation_members'::regclass
      AND policy.polcmd IN ('*', 'a', 'w', 'd')
  ) THEN
    RAISE EXCEPTION
      'conversation_members retains a direct mutation policy';
  END IF;
END
$postflight$;

SELECT public.install_active_authenticated_subject_mutation_barriers();
SELECT public.assert_active_authenticated_subject_mutation_barriers();

NOTIFY pgrst, 'reload schema';

COMMIT;
