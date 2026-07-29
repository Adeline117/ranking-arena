-- Migration: 20260729156000_atomic_group_notification_broadcast.sql
-- Created: 2026-07-29T23:00:00Z
-- Description: Replace the authorize-then-batch group notification route with
--   one idempotent transaction. Current actor, group and recipient state stay
--   locked while the canonical direct-message authority and system
--   notifications are applied. Unexpected failures roll the whole broadcast
--   back, including direct-message trigger side effects.
--
-- Forward compensation: roll API callers back before retiring this RPC, then
--   drop it and its private replay ledger in a later forward migration.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.group_notification_broadcast:atomic:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic group notification broadcast migration lock is busy';
  END IF;
END
$migration_lock$;

DO $preflight$
DECLARE
  v_missing_roles text[];
  v_invalid_columns text[];
  v_send_function regprocedure := pg_catalog.to_regprocedure(
    'public.send_direct_message_atomic(uuid,uuid,text,text,text,text,uuid)'
  );
  v_send record;
  v_send_source text;
  v_role_values text[];
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
    RAISE EXCEPTION
      'group notification broadcast roles are missing: %',
      v_missing_roles;
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.groups') IS NULL
     OR pg_catalog.to_regclass('public.group_members') IS NULL
     OR pg_catalog.to_regclass('public.notifications') IS NULL
     OR pg_catalog.to_regclass('public.conversations') IS NULL
     OR pg_catalog.to_regclass('public.direct_messages') IS NULL
     OR pg_catalog.to_regclass('public.blocked_users') IS NULL
     OR pg_catalog.to_regclass('public.user_follows') IS NULL
     OR pg_catalog.to_regtype('public.member_role') IS NULL
     OR v_send_function IS NULL
  THEN
    RAISE EXCEPTION
      'canonical group, notification and direct-message authorities must deploy first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.groups'::regclass,
      'public.group_members'::regclass,
      'public.notifications'::regclass,
      'public.conversations'::regclass,
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
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.groups'::regclass,
      'public.group_members'::regclass,
      'public.notifications'::regclass,
      'public.conversations'::regclass,
      'public.direct_messages'::regclass,
      'public.blocked_users'::regclass,
      'public.user_follows'::regclass
    )
       OR inheritance.inhparent IN (
         'auth.users'::regclass,
         'public.user_profiles'::regclass,
         'public.groups'::regclass,
         'public.group_members'::regclass,
         'public.notifications'::regclass,
         'public.conversations'::regclass,
         'public.direct_messages'::regclass,
         'public.blocked_users'::regclass,
         'public.user_follows'::regclass
       )
  ) THEN
    RAISE EXCEPTION
      'group notification dependencies must be canonical permanent tables';
  END IF;

  SELECT pg_catalog.array_agg(
    pg_catalog.format(
      '%I.%I.%I expected %s%s',
      required.schema_name,
      required.relation_name,
      required.column_name,
      required.type_oid::regtype,
      CASE WHEN required.required_not_null THEN ' NOT NULL' ELSE '' END
    )
    ORDER BY required.schema_name, required.relation_name, required.ordinality
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
      ('public', 'groups', 1, 'id', 'uuid'::regtype, true),
      ('public', 'groups', 2, 'name', 'text'::regtype, true),
      ('public', 'groups', 3, 'dissolved_at', 'timestamptz'::regtype, false),
      ('public', 'group_members', 1, 'group_id', 'uuid'::regtype, true),
      ('public', 'group_members', 2, 'user_id', 'uuid'::regtype, true),
      ('public', 'group_members', 3, 'role', 'public.member_role'::regtype, true),
      ('public', 'group_members', 4, 'self_notify_muted', 'boolean'::regtype, true),
      ('public', 'notifications', 1, 'id', 'uuid'::regtype, true),
      ('public', 'notifications', 2, 'user_id', 'uuid'::regtype, true),
      ('public', 'notifications', 3, 'type', 'text'::regtype, true),
      ('public', 'notifications', 4, 'title', 'text'::regtype, true),
      ('public', 'notifications', 5, 'message', 'text'::regtype, true),
      ('public', 'notifications', 6, 'link', 'text'::regtype, false),
      ('public', 'notifications', 7, 'actor_id', 'uuid'::regtype, false),
      ('public', 'notifications', 8, 'reference_id', 'text'::regtype, false),
      ('public', 'notifications', 9, 'created_at', 'timestamptz'::regtype, false)
  ) AS required(
    schema_name,
    relation_name,
    ordinality,
    column_name,
    type_oid,
    required_not_null
  )
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = pg_catalog.to_regclass(
      pg_catalog.format('%I.%I', required.schema_name, required.relation_name)
    )
   AND attribute.attname = required.column_name
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  WHERE attribute.attname IS NULL
     OR attribute.atttypid <> required.type_oid
     OR (required.required_not_null AND NOT attribute.attnotnull);

  IF v_invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'group notification broadcast has incompatible columns: %',
      v_invalid_columns;
  END IF;

  SELECT pg_catalog.array_agg(enum_row.enumlabel ORDER BY enum_row.enumsortorder)
  INTO v_role_values
  FROM pg_catalog.pg_enum AS enum_row
  WHERE enum_row.enumtypid = 'public.member_role'::regtype;
  IF v_role_values IS DISTINCT FROM ARRAY['owner', 'admin', 'member']::text[] THEN
    RAISE EXCEPTION 'member_role contract drifted: %', v_role_values;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.group_members'::regclass
      AND constraint_row.contype IN ('p', 'u')
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.group_members'::regclass
            AND attribute.attname = 'group_id'
        ),
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.group_members'::regclass
            AND attribute.attname = 'user_id'
        )
      ]::smallint[]
  ) THEN
    RAISE EXCEPTION 'group_members requires UNIQUE (group_id, user_id)';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.notifications'::regclass
      AND constraint_row.contype = 'c'
      AND pg_catalog.pg_get_expr(
        constraint_row.conbin,
        constraint_row.conrelid,
        false
      ) ~ $$'system'$$
  ) THEN
    RAISE EXCEPTION 'notifications.type must permit system broadcasts';
  END IF;

  SELECT function_row.proowner,
    function_row.prosecdef,
    function_row.provolatile,
    function_row.prorettype,
    function_row.proconfig,
    function_row.proacl
  INTO STRICT v_send
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_send_function;
  v_send_source := pg_catalog.pg_get_functiondef(v_send_function);

  IF v_send.proowner <> (
       SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
       WHERE role_row.rolname = 'postgres'
     )
     OR NOT v_send.prosecdef
     OR v_send.provolatile <> 'v'
     OR v_send.prorettype <> 'jsonb'::regtype
     OR NOT ('search_path=pg_catalog, pg_temp' = ANY(v_send.proconfig))
     OR NOT ('lock_timeout=5s' = ANY(v_send.proconfig))
     OR pg_catalog.strpos(v_send_source, 'public.check_dm_permission') = 0
     OR pg_catalog.strpos(v_send_source, 'direct-message:pair:') = 0
     OR pg_catalog.strpos(v_send_source, 'INSERT INTO public.direct_messages') = 0
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_send_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_send_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_send_function, 'EXECUTE'
     )
  THEN
    RAISE EXCEPTION 'canonical direct-message send authority drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'broadcast_group_notification_atomic'
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid)
        <> 'p_operation_id uuid, p_actor_id uuid, p_group_id uuid, p_title text, p_message text, p_target_user_ids uuid[]'
  ) THEN
    RAISE EXCEPTION
      'incompatible broadcast_group_notification_atomic overload exists';
  END IF;
END
$preflight$;

DO $create_private_replay_ledger$
BEGIN
  IF pg_catalog.to_regclass(
    'public.group_notification_broadcast_operations'
  ) IS NULL THEN
    CREATE TABLE public.group_notification_broadcast_operations (
      operation_id uuid NOT NULL,
      actor_id uuid NOT NULL,
      group_id uuid NOT NULL,
      intent_fingerprint text NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
      CONSTRAINT group_notification_broadcast_operations_pkey
        PRIMARY KEY (operation_id),
      CONSTRAINT group_notification_broadcast_fingerprint_check
        CHECK (intent_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT group_notification_broadcast_result_check CHECK (
        pg_catalog.jsonb_typeof(result) = 'object'
        AND NOT result ? 'applied'
        AND result ->> 'success' = 'true'
        AND result ->> 'operation_id' = operation_id::text
        AND result ->> 'actor_id' = actor_id::text
        AND result ->> 'group_id' = group_id::text
        AND pg_catalog.jsonb_typeof(result -> 'notified') = 'number'
        AND pg_catalog.jsonb_typeof(result -> 'dm_delivered') = 'number'
        AND pg_catalog.jsonb_typeof(result -> 'dm_skipped') = 'number'
        AND (result ->> 'notified')::integer BETWEEN 1 AND 500
        AND (result ->> 'dm_delivered')::integer >= 0
        AND (result ->> 'dm_skipped')::integer >= 0
        AND (result ->> 'dm_delivered')::integer
          + (result ->> 'dm_skipped')::integer
          = (result ->> 'notified')::integer
      )
    );
  END IF;
END
$create_private_replay_ledger$;

-- The ledger is the runtime/deployment barrier. Dependency locks make the
-- catalog attestation and function publication one indivisible deployment.
LOCK TABLE public.group_notification_broadcast_operations
  IN ACCESS EXCLUSIVE MODE;
LOCK TABLE auth.users,
  public.user_profiles,
  public.groups,
  public.group_members,
  public.notifications,
  public.conversations,
  public.direct_messages,
  public.blocked_users,
  public.user_follows
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.group_notification_broadcast_operations OWNER TO postgres;
ALTER TABLE public.group_notification_broadcast_operations
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES
  ON TABLE public.group_notification_broadcast_operations
  FROM PUBLIC, anon, authenticated, service_role;

DO $ledger_attestation$
DECLARE
  v_ledger regclass :=
    'public.group_notification_broadcast_operations'::regclass;
  v_postgres_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
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
    SELECT 1 FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = v_ledger OR inheritance.inhparent = v_ledger
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid = v_ledger
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = v_ledger AND NOT trigger_row.tgisinternal
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_ledger
      AND constraint_row.contype = 'f'
  ) THEN
    RAISE EXCEPTION 'group notification replay ledger catalog drifted';
  END IF;

  SELECT pg_catalog.array_agg(
    pg_catalog.format('%I expected %s%s', required.name,
      required.type_oid::regtype,
      CASE WHEN required.not_null THEN ' NOT NULL' ELSE '' END)
    ORDER BY required.ordinality
  )
  INTO v_invalid_columns
  FROM (
    VALUES
      (1, 'operation_id', 'uuid'::regtype, true),
      (2, 'actor_id', 'uuid'::regtype, true),
      (3, 'group_id', 'uuid'::regtype, true),
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
    SELECT 1 FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_ledger
      AND attribute.attnum > 6
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION
      'group notification replay ledger columns drifted: %',
      v_invalid_columns;
  END IF;
END
$ledger_attestation$;

CREATE OR REPLACE FUNCTION public.broadcast_group_notification_atomic(
  p_operation_id uuid,
  p_actor_id uuid,
  p_group_id uuid,
  p_title text,
  p_message text,
  p_target_user_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_input_title text := NULLIF(
    normalize(pg_catalog.btrim(COALESCE(p_title, '')), NFC),
    ''
  );
  v_message text := normalize(
    pg_catalog.btrim(COALESCE(p_message, '')),
    NFC
  );
  v_title text;
  v_intent_fingerprint text;
  v_existing public.group_notification_broadcast_operations%ROWTYPE;
  v_target_ids uuid[];
  v_candidate_ids uuid[] := ARRAY[]::uuid[];
  v_lock_ids uuid[] := ARRAY[]::uuid[];
  v_locked_auth_ids uuid[] := ARRAY[]::uuid[];
  v_active_profile_ids uuid[] := ARRAY[]::uuid[];
  v_recipient_ids uuid[] := ARRAY[]::uuid[];
  v_actor_profile_active boolean := false;
  v_group public.groups%ROWTYPE;
  v_actor_role text;
  v_member record;
  v_profile record;
  v_id uuid;
  v_pair text;
  v_dm_content text;
  v_dm_result jsonb;
  v_dm_delivered integer := 0;
  v_dm_skipped integer := 0;
  v_dm_skip_reasons jsonb := '{}'::jsonb;
  v_reason text;
  v_notified integer := 0;
  v_now timestamptz;
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  -- Deployment replay takes ACCESS EXCLUSIVE on this table before touching
  -- dependencies. Every runtime takes the weaker barrier first.
  LOCK TABLE public.group_notification_broadcast_operations
    IN ROW EXCLUSIVE MODE;

  IF p_operation_id IS NULL
     OR p_actor_id IS NULL
     OR p_group_id IS NULL
     OR pg_catalog.char_length(v_message) NOT BETWEEN 1 AND 500
     OR pg_catalog.char_length(COALESCE(v_input_title, '')) > 50
     OR pg_catalog.octet_length(COALESCE(p_title, '')) > 400
     OR pg_catalog.octet_length(COALESCE(p_message, '')) > 4000
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  IF p_target_user_ids IS NOT NULL THEN
    IF pg_catalog.cardinality(p_target_user_ids) NOT BETWEEN 1 AND 500
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(p_target_user_ids) AS target(target_id)
         WHERE target.target_id IS NULL OR target.target_id = p_actor_id
       )
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'INVALID_TARGETS'
      );
    END IF;

    SELECT pg_catalog.array_agg(target.target_id ORDER BY target.target_id)
    INTO v_target_ids
    FROM pg_catalog.unnest(p_target_user_ids) AS target(target_id);

    IF pg_catalog.cardinality(v_target_ids) IS DISTINCT FROM (
      SELECT pg_catalog.count(DISTINCT target.target_id)::integer
      FROM pg_catalog.unnest(p_target_user_ids) AS target(target_id)
    ) THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'INVALID_TARGETS'
      );
    END IF;
  END IF;

  v_intent_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        'group-notification-broadcast:v1',
        p_group_id,
        v_input_title,
        v_message,
        v_target_ids
      )::text,
      'UTF8'
    )),
    'hex'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-notification-operation:' || p_operation_id::text,
      0
    )
  );

  SELECT operation_row.*
  INTO v_existing
  FROM public.group_notification_broadcast_operations AS operation_row
  WHERE operation_row.operation_id = p_operation_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.actor_id IS DISTINCT FROM p_actor_id
       OR v_existing.group_id IS DISTINCT FROM p_group_id
       OR v_existing.intent_fingerprint IS DISTINCT FROM v_intent_fingerprint
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'OPERATION_CONFLICT'
      );
    END IF;

    RETURN v_existing.result || pg_catalog.jsonb_build_object('applied', false);
  END IF;

  IF v_target_ids IS NOT NULL THEN
    v_candidate_ids := v_target_ids;
  ELSE
    -- This bounded discovery snapshot defines which current unmuted members
    -- this all-member operation attempts. Every discovered row is revalidated
    -- after its membership edge lock below.
    SELECT COALESCE(
      pg_catalog.array_agg(candidate.user_id ORDER BY candidate.user_id),
      ARRAY[]::uuid[]
    )
    INTO v_candidate_ids
    FROM (
      SELECT member.user_id
      FROM public.group_members AS member
      WHERE member.group_id = p_group_id
        AND member.user_id <> p_actor_id
        AND member.self_notify_muted IS NOT TRUE
      ORDER BY member.user_id
      LIMIT 501
    ) AS candidate;

    IF pg_catalog.cardinality(v_candidate_ids) > 500 THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'TOO_MANY_RECIPIENTS'
      );
    END IF;
  END IF;

  SELECT pg_catalog.array_agg(identity_id ORDER BY identity_id)
  INTO v_lock_ids
  FROM (
    SELECT DISTINCT identity.identity_id
    FROM pg_catalog.unnest(
      pg_catalog.array_prepend(p_actor_id, v_candidate_ids)
    ) AS identity(identity_id)
  ) AS lock_identity;

  -- Auth parents always precede advisory and child-row locks. Account deletion
  -- takes the same parents before FK cascades reach memberships or messages.
  FOR v_id IN
    SELECT auth_user.id
    FROM auth.users AS auth_user
    WHERE auth_user.id = ANY(v_lock_ids)
    ORDER BY auth_user.id
    FOR KEY SHARE
  LOOP
    v_locked_auth_ids := pg_catalog.array_append(v_locked_auth_ids, v_id);
  END LOOP;

  IF NOT p_actor_id = ANY(v_locked_auth_ids) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;

  -- Join/leave, kick and role mutations all use these membership edge keys.
  FOREACH v_id IN ARRAY v_lock_ids LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'group-membership:' || p_group_id::text || ':' || v_id::text,
        0
      )
    );
  END LOOP;

  -- Block/follow/privacy mutations use the canonical direct-message pair lock
  -- before profile rows. Acquire every pair in C order, then profiles in UUID
  -- order, before asking the canonical sender to re-enter those same locks.
  FOR v_pair IN
    SELECT pair_key
    FROM (
      SELECT LEAST(p_actor_id::text, candidate.candidate_id::text)
        || ':' || GREATEST(p_actor_id::text, candidate.candidate_id::text)
        AS pair_key
      FROM pg_catalog.unnest(v_candidate_ids) AS candidate(candidate_id)
    ) AS pairs
    ORDER BY pair_key COLLATE pg_catalog."C"
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('direct-message:pair:' || v_pair, 0)
    );
  END LOOP;

  FOR v_profile IN
    SELECT profile.id,
      profile.deleted_at,
      profile.banned_at,
      profile.is_banned,
      profile.ban_expires_at
    FROM public.user_profiles AS profile
    WHERE profile.id = ANY(v_lock_ids)
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
      v_active_profile_ids := pg_catalog.array_append(
        v_active_profile_ids,
        v_profile.id
      );
      IF v_profile.id = p_actor_id THEN
        v_actor_profile_active := true;
      END IF;
    END IF;
  END LOOP;

  IF NOT v_actor_profile_active THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;

  SELECT target_group.*
  INTO v_group
  FROM public.groups AS target_group
  WHERE target_group.id = p_group_id
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'GROUP_NOT_FOUND'
    );
  END IF;
  IF v_group.dissolved_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'GROUP_DISSOLVED'
    );
  END IF;

  FOR v_member IN
    SELECT member.user_id,
      member.role::text AS role,
      member.self_notify_muted
    FROM public.group_members AS member
    WHERE member.group_id = p_group_id
      AND member.user_id = ANY(v_lock_ids)
    ORDER BY member.user_id
    FOR SHARE
  LOOP
    IF v_member.user_id = p_actor_id THEN
      v_actor_role := v_member.role;
    ELSIF v_member.user_id = ANY(v_candidate_ids)
       AND v_member.user_id = ANY(v_active_profile_ids)
       AND v_member.self_notify_muted IS NOT TRUE
    THEN
      v_recipient_ids := pg_catalog.array_append(
        v_recipient_ids,
        v_member.user_id
      );
    END IF;
  END LOOP;

  IF v_actor_role IS NULL OR v_actor_role NOT IN ('owner', 'admin') THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'PERMISSION_DENIED'
    );
  END IF;

  IF pg_catalog.cardinality(v_recipient_ids) = 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'NO_RECIPIENTS'
    );
  END IF;
  IF pg_catalog.cardinality(v_recipient_ids) > 500 THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'TOO_MANY_RECIPIENTS'
    );
  END IF;

  v_title := COALESCE(
    v_input_title,
    normalize(v_group.name, NFC) || ' admin notification'
  );
  IF pg_catalog.char_length(v_title) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'resolved group notification title is invalid';
  END IF;

  v_dm_content := '[' || v_title || '] ' || v_message;
  IF pg_catalog.char_length(v_dm_content) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'resolved group direct-message content is invalid';
  END IF;

  FOREACH v_id IN ARRAY v_recipient_ids LOOP
    v_dm_result := public.send_direct_message_atomic(
      p_actor_id,
      v_id,
      v_dm_content,
      NULL,
      NULL,
      NULL,
      NULL
    );

    IF pg_catalog.jsonb_typeof(v_dm_result) IS DISTINCT FROM 'object'
       OR v_dm_result ->> 'success' NOT IN ('true', 'false')
       OR v_dm_result ->> 'allowed' NOT IN ('true', 'false')
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'canonical direct-message sender returned an invalid contract';
    END IF;

    IF (v_dm_result ->> 'success')::boolean THEN
      IF (v_dm_result ->> 'allowed')::boolean IS NOT TRUE
         OR pg_catalog.jsonb_typeof(v_dm_result -> 'message') <> 'object'
         OR v_dm_result -> 'message' ->> 'sender_id' <> p_actor_id::text
         OR v_dm_result -> 'message' ->> 'receiver_id' <> v_id::text
         OR v_dm_result -> 'message' ->> 'content' <> v_dm_content
         OR v_dm_result ->> 'conversation_id' IS NULL
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'canonical direct-message success acknowledgement drifted';
      END IF;
      v_dm_delivered := v_dm_delivered + 1;
    ELSE
      IF (v_dm_result ->> 'allowed')::boolean IS NOT FALSE THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'canonical direct-message denial acknowledgement drifted';
      END IF;
      v_reason := COALESCE(NULLIF(v_dm_result ->> 'reason', ''), 'DENIED');
      IF pg_catalog.char_length(v_reason) > 64 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'canonical direct-message denial reason drifted';
      END IF;
      v_dm_skipped := v_dm_skipped + 1;
      v_dm_skip_reasons := pg_catalog.jsonb_set(
        v_dm_skip_reasons,
        ARRAY[v_reason],
        pg_catalog.to_jsonb(
          COALESCE((v_dm_skip_reasons ->> v_reason)::integer, 0) + 1
        ),
        true
      );
    END IF;
  END LOOP;

  v_now := pg_catalog.clock_timestamp();
  INSERT INTO public.notifications (
    user_id,
    type,
    title,
    message,
    link,
    actor_id,
    reference_id,
    created_at
  )
  SELECT recipient.recipient_id,
    'system',
    v_title,
    v_message,
    '/groups/' || p_group_id::text,
    p_actor_id,
    p_group_id::text,
    v_now
  FROM pg_catalog.unnest(v_recipient_ids) AS recipient(recipient_id)
  ORDER BY recipient.recipient_id;
  GET DIAGNOSTICS v_notified = ROW_COUNT;

  IF v_notified <> pg_catalog.cardinality(v_recipient_ids)
     OR v_dm_delivered + v_dm_skipped <> v_notified
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'group notification broadcast acknowledgement is incomplete';
  END IF;

  v_result := pg_catalog.jsonb_build_object(
    'success', true,
    'operation_id', p_operation_id,
    'actor_id', p_actor_id,
    'group_id', p_group_id,
    'target_scope', CASE
      WHEN v_target_ids IS NULL THEN 'all'
      ELSE 'explicit'
    END,
    'notified', v_notified,
    'total', v_notified,
    'failed', 0,
    'dm_delivered', v_dm_delivered,
    'dm_skipped', v_dm_skipped,
    'dm_skip_reasons', v_dm_skip_reasons
  );

  INSERT INTO public.group_notification_broadcast_operations (
    operation_id,
    actor_id,
    group_id,
    intent_fingerprint,
    result
  ) VALUES (
    p_operation_id,
    p_actor_id,
    p_group_id,
    v_intent_fingerprint,
    v_result
  );

  RETURN v_result || pg_catalog.jsonb_build_object('applied', true);
END
$function$;

ALTER FUNCTION public.broadcast_group_notification_atomic(
  uuid, uuid, uuid, text, text, uuid[]
) OWNER TO postgres;

REVOKE ALL PRIVILEGES
  ON FUNCTION public.broadcast_group_notification_atomic(
    uuid, uuid, uuid, text, text, uuid[]
  )
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE
  ON FUNCTION public.broadcast_group_notification_atomic(
    uuid, uuid, uuid, text, text, uuid[]
  )
  TO service_role;

COMMENT ON FUNCTION public.broadcast_group_notification_atomic(
  uuid, uuid, uuid, text, text, uuid[]
) IS
  'Service-only idempotent group broadcast boundary. Locks current manager and recipient eligibility, delegates DMs to send_direct_message_atomic, and rolls back all notification effects on error.';

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.broadcast_group_notification_atomic(uuid,uuid,uuid,text,text,uuid[])'::regprocedure;
  v_postgres_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_function_row record;
  v_source text;
BEGIN
  SELECT function_row.proowner,
    function_row.prosecdef,
    function_row.provolatile,
    function_row.prorettype,
    function_row.proconfig,
    function_row.proacl
  INTO STRICT v_function_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;
  v_source := pg_catalog.pg_get_functiondef(v_function);

  IF v_function_row.proowner <> v_postgres_oid
     OR NOT v_function_row.prosecdef
     OR v_function_row.provolatile <> 'v'
     OR v_function_row.prorettype <> 'jsonb'::regtype
     OR NOT ('search_path=pg_catalog, pg_temp' = ANY(v_function_row.proconfig))
     OR NOT ('lock_timeout=5s' = ANY(v_function_row.proconfig))
     OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') = 0
     OR pg_catalog.strpos(v_source, 'group-membership:') = 0
     OR pg_catalog.strpos(v_source, 'direct-message:pair:') = 0
     OR pg_catalog.strpos(v_source, 'public.send_direct_message_atomic') = 0
     OR pg_catalog.strpos(v_source, 'INSERT INTO public.notifications') = 0
     OR pg_catalog.strpos(
       v_source,
       'INSERT INTO public.group_notification_broadcast_operations'
     ) = 0
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.aclexplode(
         COALESCE(v_function_row.proacl, '{}'::aclitem[])
       ) AS acl_entry
       WHERE acl_entry.grantee = 0
          OR (
            acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
            OR acl_entry.privilege_type <> 'EXECUTE'
            OR acl_entry.is_grantable
          )
     )
  THEN
    RAISE EXCEPTION 'atomic group notification function contract drifted';
  END IF;
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_ledger regclass :=
    'public.group_notification_broadcast_operations'::regclass;
BEGIN
  IF pg_catalog.has_table_privilege('anon', v_ledger, 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', v_ledger, 'SELECT')
     OR pg_catalog.has_table_privilege('service_role', v_ledger, 'SELECT')
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.aclexplode(
         COALESCE(
           (SELECT relation.relacl FROM pg_catalog.pg_class AS relation
            WHERE relation.oid = v_ledger),
           '{}'::aclitem[]
         )
       ) AS acl_entry
       WHERE acl_entry.grantee = 0
     )
  THEN
    RAISE EXCEPTION 'group notification replay ledger privacy drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'broadcast_group_notification_atomic'
      AND function_row.oid <>
        'public.broadcast_group_notification_atomic(uuid,uuid,uuid,text,text,uuid[])'::regprocedure
  ) THEN
    RAISE EXCEPTION 'ambiguous group notification broadcast overload remains';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
