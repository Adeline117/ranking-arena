-- Migration: 20260729174500_atomic_notification_create.sql
-- Created: 2026-07-30T10:45:00Z
-- Description: Create one lifecycle-safe notification or atomically reuse an
--   existing notification inside a caller-selected deduplication window.
--
-- Forward compensation: move all RPC consumers back to service-only inserts
-- before dropping this function in a later forward migration.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.notifications:atomic-create:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic notification-create migration lock is busy';
  END IF;
END
$migration_lock$;

DO $preflight$
DECLARE
  v_postgres_oid oid := pg_catalog.to_regrole('postgres')::oid;
  v_missing_roles text[];
  v_invalid_columns text[];
  v_create_function regprocedure := pg_catalog.to_regprocedure(
    'public.create_notification_atomic(uuid,text,text,text,text,uuid,text,boolean,integer)'
  );
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['anon', 'authenticated', 'service_role', 'postgres']::text[]
  ) AS required_role
  WHERE pg_catalog.to_regrole(required_role) IS NULL;

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'notification-create roles are missing: %', v_missing_roles;
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.notifications') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.mutate_notifications_atomic(uuid,text,uuid[])'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.install_active_authenticated_subject_mutation_barriers()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.assert_active_authenticated_subject_mutation_barriers()'
     ) IS NULL
  THEN
    RAISE EXCEPTION
      'canonical account and notification authorities must deploy first';
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
      'public.notifications'::regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.notifications'::regclass
    )
       OR inheritance.inhparent IN (
         'auth.users'::regclass,
         'public.user_profiles'::regclass,
         'public.notifications'::regclass
       )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.notifications'::regclass
    )
  ) THEN
    RAISE EXCEPTION 'notification creation requires canonical permanent relations';
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
    ORDER BY required.schema_name,
      required.relation_name,
      required.ordinality
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
      ('public', 'notifications', 1, 'id', 'uuid'::regtype, true),
      ('public', 'notifications', 2, 'user_id', 'uuid'::regtype, true),
      ('public', 'notifications', 3, 'type', 'text'::regtype, true),
      ('public', 'notifications', 4, 'title', 'text'::regtype, true),
      ('public', 'notifications', 5, 'message', 'text'::regtype, true),
      ('public', 'notifications', 6, 'link', 'text'::regtype, false),
      ('public', 'notifications', 7, 'read', 'boolean'::regtype, false),
      ('public', 'notifications', 8, 'actor_id', 'uuid'::regtype, false),
      ('public', 'notifications', 9, 'reference_id', 'text'::regtype, false),
      ('public', 'notifications', 10, 'created_at', 'timestamptz'::regtype, false)
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
      'notification creation has incompatible columns: %',
      v_invalid_columns;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'create_notification_atomic'
      AND (
        v_create_function IS NULL
        OR function_row.oid <> v_create_function::oid
      )
  ) THEN
    RAISE EXCEPTION 'ambiguous atomic notification-create overload exists';
  END IF;
END
$preflight$;

LOCK TABLE auth.users,
  public.user_profiles,
  public.notifications
  IN SHARE MODE;

CREATE INDEX IF NOT EXISTS notifications_atomic_create_dedup_idx
  ON public.notifications (
    user_id,
    type,
    actor_id,
    reference_id,
    created_at DESC,
    id DESC
  );

CREATE OR REPLACE FUNCTION public.create_notification_atomic(
  p_recipient_id uuid,
  p_type text,
  p_title text,
  p_message text,
  p_link text,
  p_actor_id uuid,
  p_reference_id text,
  p_deduplicate boolean,
  p_dedup_window_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_allowed_types constant text[] := ARRAY[
    'follow',
    'like',
    'reaction',
    'comment',
    'system',
    'mention',
    'copy_trade',
    'message',
    'trader_alert',
    'trader_alert_roi',
    'trader_alert_drawdown',
    'trader_alert_score',
    'trader_alert_pnl',
    'trader_alert_rank',
    'post_reply',
    'new_follower',
    'group_update',
    'ranking_change',
    'referral_reward',
    -- tip_received is emitted only by the durable tip-completion authority.
    'subscription_expiring',
    'subscription_expired',
    'nft_expired',
    'nft_pending',
    'nft_minted'
  ]::text[];
  v_subject_ids uuid[];
  v_subject_id uuid;
  v_auth_id uuid;
  v_profile_id uuid;
  v_subject_active boolean := false;
  v_notification_id uuid;
  v_created_at timestamptz;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_recipient_id IS NULL
     OR p_type IS NULL
     OR NOT (p_type = ANY(v_allowed_types))
     OR p_title IS NULL
     OR pg_catalog.btrim(p_title) = ''
     OR pg_catalog.char_length(p_title) > 200
     OR p_message IS NULL
     OR pg_catalog.btrim(p_message) = ''
     OR pg_catalog.char_length(p_message) > 1000
     OR (
       p_link IS NOT NULL
       AND (
         pg_catalog.char_length(p_link) > 500
         OR pg_catalog.left(p_link, 1) <> '/'
         OR pg_catalog.left(p_link, 2) = '//'
         OR pg_catalog.strpos(p_link, E'\\') > 0
         OR p_link OPERATOR(pg_catalog.~) '[[:cntrl:]]'
       )
     )
     OR (
       p_reference_id IS NOT NULL
       AND (
         pg_catalog.btrim(p_reference_id) = ''
         OR pg_catalog.char_length(p_reference_id) > 500
       )
     )
     OR p_deduplicate IS NULL
     OR p_dedup_window_seconds IS NULL
     OR (
       p_deduplicate
       AND (
         p_reference_id IS NULL
         OR p_dedup_window_seconds NOT BETWEEN 1 AND 604800
       )
     )
     OR (
       NOT p_deduplicate
       AND p_dedup_window_seconds <> 0
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  SELECT pg_catalog.array_agg(subject.subject_id ORDER BY subject.subject_id::text)
  INTO STRICT v_subject_ids
  FROM (
    SELECT DISTINCT requested_subject.subject_id
    FROM pg_catalog.unnest(ARRAY[p_recipient_id, p_actor_id]) AS requested_subject(subject_id)
    WHERE requested_subject.subject_id IS NOT NULL
  ) AS subject;

  -- Always acquire account admission locks in UUID order. Reciprocal events
  -- (A notifies B while B notifies A) therefore cannot deadlock each other.
  FOREACH v_subject_id IN ARRAY v_subject_ids
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'account-recovery-admission:' || v_subject_id::text,
        0
      )
    );

    SELECT auth_user.id
    INTO v_auth_id
    FROM auth.users AS auth_user
    WHERE auth_user.id = v_subject_id
    FOR KEY SHARE;

    IF v_auth_id IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', CASE
          WHEN v_subject_id = p_recipient_id THEN 'RECIPIENT_UNAVAILABLE'
          ELSE 'ACTOR_UNAVAILABLE'
        END
      );
    END IF;

    SELECT
      profile.id,
      profile.deleted_at IS NULL
        AND profile.banned_at IS NULL
        AND NOT (
          profile.is_banned IS TRUE
          AND (
            profile.ban_expires_at IS NULL
            OR profile.ban_expires_at > v_now
          )
        )
    INTO v_profile_id, v_subject_active
    FROM public.user_profiles AS profile
    WHERE profile.id = v_subject_id
    FOR SHARE;

    IF v_profile_id IS NULL OR NOT v_subject_active THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', CASE
          WHEN v_subject_id = p_recipient_id THEN 'RECIPIENT_UNAVAILABLE'
          ELSE 'ACTOR_UNAVAILABLE'
        END
      );
    END IF;
  END LOOP;

  IF p_actor_id = p_recipient_id THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'outcome', 'SKIPPED_SELF',
      'recipient_id', p_recipient_id,
      'type', p_type,
      'title', p_title,
      'message', p_message,
      'link', pg_catalog.to_jsonb(p_link),
      'actor_id', pg_catalog.to_jsonb(p_actor_id),
      'reference_id', pg_catalog.to_jsonb(p_reference_id),
      'deduplicate', p_deduplicate,
      'dedup_window_seconds', p_dedup_window_seconds,
      'notification_id', 'null'::jsonb,
      'created_at', 'null'::jsonb
    );
  END IF;

  IF p_deduplicate THEN
    -- The transaction-scoped identity lock closes the SELECT/INSERT race. It
    -- also keeps callers with NULL system actors on the same dedup authority.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'notification-create:' || pg_catalog.jsonb_build_array(
          p_recipient_id,
          p_type,
          p_actor_id,
          p_reference_id
        )::text,
        0
      )
    );

    SELECT notification.id, notification.created_at
    INTO v_notification_id, v_created_at
    FROM public.notifications AS notification
    WHERE notification.user_id = p_recipient_id
      AND notification.type = p_type
      AND notification.actor_id IS NOT DISTINCT FROM p_actor_id
      AND notification.reference_id = p_reference_id
      AND notification.created_at >= v_now - pg_catalog.make_interval(
        secs => p_dedup_window_seconds
      )
      AND notification.created_at <= v_now
    ORDER BY notification.created_at DESC NULLS LAST, notification.id DESC
    LIMIT 1
    FOR UPDATE;

    IF v_notification_id IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', true,
        'outcome', 'DEDUPLICATED',
        'recipient_id', p_recipient_id,
        'type', p_type,
        'title', p_title,
        'message', p_message,
        'link', pg_catalog.to_jsonb(p_link),
        'actor_id', pg_catalog.to_jsonb(p_actor_id),
        'reference_id', pg_catalog.to_jsonb(p_reference_id),
        'deduplicate', p_deduplicate,
        'dedup_window_seconds', p_dedup_window_seconds,
        'notification_id', v_notification_id,
        'created_at', v_created_at
      );
    END IF;
  END IF;

  INSERT INTO public.notifications (
    user_id,
    type,
    title,
    message,
    link,
    read,
    actor_id,
    reference_id,
    created_at
  ) VALUES (
    p_recipient_id,
    p_type,
    p_title,
    p_message,
    p_link,
    false,
    p_actor_id,
    p_reference_id,
    v_now
  )
  RETURNING id, created_at
  INTO STRICT v_notification_id, v_created_at;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'outcome', 'CREATED',
    'recipient_id', p_recipient_id,
    'type', p_type,
    'title', p_title,
    'message', p_message,
    'link', pg_catalog.to_jsonb(p_link),
    'actor_id', pg_catalog.to_jsonb(p_actor_id),
    'reference_id', pg_catalog.to_jsonb(p_reference_id),
    'deduplicate', p_deduplicate,
    'dedup_window_seconds', p_dedup_window_seconds,
    'notification_id', v_notification_id,
    'created_at', v_created_at
  );
END
$function$;

ALTER FUNCTION public.create_notification_atomic(
  uuid, text, text, text, text, uuid, text, boolean, integer
) OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.create_notification_atomic(uuid,text,text,text,text,uuid,text,boolean,integer)'::regprocedure;
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
    ON FUNCTION public.create_notification_atomic(
      uuid, text, text, text, text, uuid, text, boolean, integer
    )
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.create_notification_atomic(
      uuid, text, text, text, text, uuid, text, boolean, integer
    )
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-notification-create:v1:' || pg_catalog.md5(v_source)
  );

  IF pg_catalog.strpos(v_source, 'account-recovery-admission:') = 0
     OR pg_catalog.strpos(v_source, 'notification-create:') = 0
     OR pg_catalog.strpos(v_source, 'IS NOT DISTINCT FROM p_actor_id') = 0
     OR pg_catalog.strpos(v_source, 'FOR UPDATE') = 0
     OR pg_catalog.strpos(v_source, '''DEDUPLICATED''') = 0
     OR pg_catalog.strpos(v_source, '''SKIPPED_SELF''') = 0
  THEN
    RAISE EXCEPTION 'atomic notification-create function contract drifted';
  END IF;
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.create_notification_atomic(uuid,text,text,text,text,uuid,text,boolean,integer)'::regprocedure;
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
    AND function_row.pronargs = 9
    AND function_row.pronargdefaults = 0
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF pg_catalog.obj_description(v_function, 'pg_proc') IS DISTINCT FROM
       'atomic-notification-create:v1:' || pg_catalog.md5(v_source)
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
         AND function_row.proname = 'create_notification_atomic'
         AND function_row.oid <> v_function
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_index AS index_row
       WHERE index_row.indexrelid =
         'public.notifications_atomic_create_dedup_idx'::regclass
         AND index_row.indrelid = 'public.notifications'::regclass
         AND index_row.indisvalid
         AND index_row.indisready
         AND index_row.indnkeyatts = 6
         AND index_row.indpred IS NULL
         AND index_row.indexprs IS NULL
     )
  THEN
    RAISE EXCEPTION 'atomic notification-create authority drifted';
  END IF;
END
$postflight$;

SELECT public.install_active_authenticated_subject_mutation_barriers();
SELECT public.assert_active_authenticated_subject_mutation_barriers();

NOTIFY pgrst, 'reload schema';

COMMIT;
