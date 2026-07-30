-- Migration: 20260729172000_atomic_notification_page.sql
-- Created: 2026-07-30T10:20:00Z
-- Description: Read one viewer's notification page, optional type filter,
--   global unread count, actor projection, and total cursor from one snapshot.
--
-- Forward compensation: roll the HTTP reader back before dropping this
-- read-only RPC in a later forward migration.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.notifications:atomic-page:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic notification-page migration lock is busy';
  END IF;
END
$migration_lock$;

DO $preflight$
DECLARE
  v_postgres_oid oid := pg_catalog.to_regrole('postgres')::oid;
  v_missing_roles text[];
  v_invalid_columns text[];
  v_notification_id_attnum smallint;
  v_notification_type_attnum smallint;
  v_page_function regprocedure := pg_catalog.to_regprocedure(
    'public.get_notification_page_atomic(uuid,text[],timestamp with time zone,uuid,integer)'
  );
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['anon', 'authenticated', 'service_role', 'postgres']::text[]
  ) AS required_role
  WHERE pg_catalog.to_regrole(required_role) IS NULL;

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'notification-page roles are missing: %', v_missing_roles;
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.notifications') IS NULL
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
    RAISE EXCEPTION 'notification page requires canonical permanent relations';
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
      ('public', 'user_profiles', 2, 'handle', 'text'::regtype, false),
      ('public', 'user_profiles', 3, 'avatar_url', 'text'::regtype, false),
      ('public', 'user_profiles', 4, 'deleted_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 5, 'banned_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 6, 'is_banned', 'boolean'::regtype, false),
      ('public', 'user_profiles', 7, 'ban_expires_at', 'timestamptz'::regtype, false),
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
      'notification page has incompatible columns: %',
      v_invalid_columns;
  END IF;

  SELECT attribute.attnum
  INTO STRICT v_notification_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.notifications'::regclass
    AND attribute.attname = 'id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_notification_type_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.notifications'::regclass
    AND attribute.attname = 'type'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.notifications'::regclass
      AND index_row.indisprimary
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts = 1
      AND ARRAY(
        SELECT key_column.attnum
        FROM pg_catalog.unnest(
          index_row.indkey::smallint[]
        ) WITH ORDINALITY AS key_column(attnum, ordinality)
        WHERE key_column.ordinality <= index_row.indnkeyatts
        ORDER BY key_column.ordinality
      ) = ARRAY[v_notification_id_attnum]::smallint[]
  ) THEN
    RAISE EXCEPTION 'notifications requires a canonical id primary key';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.notifications'::regclass
      AND constraint_row.conname = 'notifications_type_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND constraint_row.conkey =
        ARRAY[v_notification_type_attnum]::smallint[]
      AND pg_catalog.md5(
        pg_catalog.pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid
        )
      ) = '4202c98e274ce25029f78eefd1beedcd'
  ) THEN
    RAISE EXCEPTION 'canonical notification type contract must deploy first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'get_notification_page_atomic'
      AND (
        v_page_function IS NULL
        OR function_row.oid <> v_page_function::oid
      )
  ) THEN
    RAISE EXCEPTION 'ambiguous atomic notification-page overload exists';
  END IF;
END
$preflight$;

LOCK TABLE auth.users,
  public.user_profiles,
  public.notifications
  IN SHARE MODE;

DO $data_preflight$
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
    'tip_received',
    'subscription_expiring',
    'subscription_expired',
    'nft_expired',
    'nft_pending',
    'nft_minted'
  ]::text[];
  v_unknown_types text[];
BEGIN
  SELECT pg_catalog.array_agg(
    DISTINCT notification.type
    ORDER BY notification.type
  )
  INTO v_unknown_types
  FROM public.notifications AS notification
  WHERE NOT (notification.type = ANY(v_allowed_types));

  IF v_unknown_types IS NOT NULL THEN
    RAISE EXCEPTION
      'unknown notification types require classification: %',
      v_unknown_types;
  END IF;
END
$data_preflight$;

CREATE INDEX IF NOT EXISTS notifications_user_page_cursor_idx
  ON public.notifications (
    user_id,
    created_at DESC NULLS LAST,
    id DESC
  );

CREATE OR REPLACE FUNCTION public.get_notification_page_atomic(
  p_actor_id uuid,
  p_types text[],
  p_before_created_at timestamptz,
  p_before_id uuid,
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
    'tip_received',
    'subscription_expiring',
    'subscription_expired',
    'nft_expired',
    'nft_pending',
    'nft_minted'
  ]::text[];
  v_auth_id uuid;
  v_profile_id uuid;
  v_actor_active boolean := false;
  v_types text[];
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_actor_id IS NULL
     OR p_limit IS NULL
     OR p_limit NOT BETWEEN 1 AND 50
     OR ((p_before_created_at IS NULL) <> (p_before_id IS NULL))
     OR (
       p_types IS NOT NULL
       AND (
         pg_catalog.cardinality(p_types) >
           pg_catalog.cardinality(v_allowed_types)
         OR EXISTS (
           SELECT 1
           FROM pg_catalog.unnest(p_types) AS requested_type
           WHERE requested_type IS NULL
              OR NOT (requested_type = ANY(v_allowed_types))
         )
         OR pg_catalog.cardinality(p_types) <> (
           SELECT pg_catalog.count(DISTINCT requested_type)
           FROM pg_catalog.unnest(p_types) AS requested_type
         )
       )
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  IF p_types IS NULL THEN
    v_types := NULL;
  ELSE
    SELECT COALESCE(
      pg_catalog.array_agg(requested_type ORDER BY requested_type),
      ARRAY[]::text[]
    )
    INTO STRICT v_types
    FROM pg_catalog.unnest(p_types) AS requested_type;
  END IF;

  -- Hold the viewer lifecycle stable through the response. Page rows, actor
  -- projections, global unread count, and the total cursor are then read by
  -- one content statement and therefore exactly one MVCC snapshot.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_actor_id::text,
      0
    )
  );

  SELECT auth_user.id
  INTO v_auth_id
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_actor_id
  FOR KEY SHARE;

  IF v_auth_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
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
          OR profile.ban_expires_at > pg_catalog.statement_timestamp()
        )
      )
  INTO v_profile_id, v_actor_active
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
  FOR SHARE;

  IF v_profile_id IS NULL OR NOT v_actor_active THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;

  WITH integrity AS MATERIALIZED (
    SELECT NOT EXISTS (
      SELECT 1
      FROM public.notifications AS invalid_notification
      WHERE invalid_notification.user_id = p_actor_id
        AND (
          invalid_notification.read IS NULL
          OR invalid_notification.created_at IS NULL
        )
    ) AS valid
  ),
  candidates AS MATERIALIZED (
    SELECT
      notification.id,
      notification.user_id,
      notification.type,
      notification.title,
      notification.message,
      notification.link,
      notification.read,
      notification.actor_id,
      notification.reference_id,
      notification.created_at,
      CASE
        WHEN actor.id IS NOT NULL
         AND actor.deleted_at IS NULL
         AND actor.banned_at IS NULL
         AND NOT (
           actor.is_banned IS TRUE
           AND (
             actor.ban_expires_at IS NULL
             OR actor.ban_expires_at > pg_catalog.statement_timestamp()
           )
         )
        THEN actor.handle
        ELSE NULL
      END AS actor_handle,
      CASE
        WHEN actor.id IS NOT NULL
         AND actor.deleted_at IS NULL
         AND actor.banned_at IS NULL
         AND NOT (
           actor.is_banned IS TRUE
           AND (
             actor.ban_expires_at IS NULL
             OR actor.ban_expires_at > pg_catalog.statement_timestamp()
           )
         )
        THEN actor.avatar_url
        ELSE NULL
      END AS actor_avatar_url
    FROM public.notifications AS notification
    LEFT JOIN public.user_profiles AS actor
      ON actor.id = notification.actor_id
    WHERE notification.user_id = p_actor_id
      AND notification.created_at IS NOT NULL
      AND (
        v_types IS NULL
        OR notification.type = ANY(v_types)
      )
      AND (
        p_before_created_at IS NULL
        OR notification.created_at < p_before_created_at
        OR (
          notification.created_at = p_before_created_at
          AND notification.id < p_before_id
        )
      )
    ORDER BY notification.created_at DESC NULLS LAST, notification.id DESC
    LIMIT p_limit + 1
  ),
  page AS MATERIALIZED (
    SELECT candidate.*
    FROM candidates AS candidate
    ORDER BY candidate.created_at DESC NULLS LAST, candidate.id DESC
    LIMIT p_limit
  ),
  unread AS MATERIALIZED (
    SELECT pg_catalog.count(*) AS unread_count
    FROM public.notifications AS unread_notification
    WHERE unread_notification.user_id = p_actor_id
      AND unread_notification.read IS FALSE
  )
  SELECT CASE
    WHEN NOT (SELECT integrity.valid FROM integrity) THEN
      pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'DATA_INTEGRITY'
      )
    ELSE
      pg_catalog.jsonb_build_object(
        'success', true,
        'actor_id', p_actor_id,
        'types', pg_catalog.to_jsonb(v_types),
        'notifications', COALESCE(
          (
            SELECT pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'id', page.id,
                'user_id', page.user_id,
                'type', page.type,
                'title', page.title,
                'message', page.message,
                'link', page.link,
                'read', page.read,
                'actor_id', page.actor_id,
                'reference_id', page.reference_id,
                'created_at', page.created_at,
                'actor_handle', page.actor_handle,
                'actor_avatar_url', page.actor_avatar_url
              )
              ORDER BY page.created_at DESC NULLS LAST, page.id DESC
            )
            FROM page
          ),
          '[]'::jsonb
        ),
        'unread_count', (SELECT unread.unread_count FROM unread),
        'has_more', (
          SELECT pg_catalog.count(*) > p_limit
          FROM candidates
        ),
        'next_cursor', CASE
          WHEN (
            SELECT pg_catalog.count(*) > p_limit
            FROM candidates
          ) THEN (
            SELECT pg_catalog.jsonb_build_object(
              'before', page.created_at,
              'before_id', page.id
            )
            FROM page
            ORDER BY page.created_at, page.id
            LIMIT 1
          )
          ELSE 'null'::jsonb
        END
      )
  END
  INTO STRICT v_result;

  RETURN v_result;
END
$function$;

ALTER FUNCTION public.get_notification_page_atomic(
  uuid,
  text[],
  timestamptz,
  uuid,
  integer
) OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.get_notification_page_atomic(uuid,text[],timestamp with time zone,uuid,integer)'::regprocedure;
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
    ON FUNCTION public.get_notification_page_atomic(
      uuid, text[], timestamptz, uuid, integer
    )
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.get_notification_page_atomic(
      uuid, text[], timestamptz, uuid, integer
    )
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-notification-page:v1:' || pg_catalog.md5(v_source)
  );

  IF pg_catalog.strpos(v_source, 'account-recovery-admission:') = 0
     OR pg_catalog.strpos(v_source, 'exactly one MVCC snapshot') = 0
     OR pg_catalog.strpos(v_source, 'WITH integrity AS MATERIALIZED') = 0
     OR pg_catalog.strpos(v_source, 'candidates AS MATERIALIZED') = 0
     OR pg_catalog.strpos(v_source, 'unread AS MATERIALIZED') = 0
     OR pg_catalog.strpos(v_source, 'notification.id < p_before_id') = 0
     OR pg_catalog.strpos(v_source, 'notification.type = ANY(v_types)') = 0
     OR pg_catalog.strpos(v_source, 'LIMIT p_limit + 1') = 0
  THEN
    RAISE EXCEPTION 'atomic notification-page function contract drifted';
  END IF;
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.get_notification_page_atomic(uuid,text[],timestamp with time zone,uuid,integer)'::regprocedure;
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
    AND function_row.pronargs = 5
    AND function_row.pronargdefaults = 0
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF pg_catalog.obj_description(v_function, 'pg_proc') IS DISTINCT FROM
       'atomic-notification-page:v1:' || pg_catalog.md5(v_source)
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
         AND function_row.proname = 'get_notification_page_atomic'
         AND function_row.oid <> v_function
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_index AS index_row
       WHERE index_row.indexrelid =
         'public.notifications_user_page_cursor_idx'::regclass
         AND index_row.indrelid = 'public.notifications'::regclass
         AND index_row.indisvalid
         AND index_row.indisready
         AND index_row.indnkeyatts = 3
         AND index_row.indpred IS NULL
         AND index_row.indexprs IS NULL
     )
  THEN
    RAISE EXCEPTION 'atomic notification-page authority drifted';
  END IF;
END
$postflight$;

SELECT public.install_active_authenticated_subject_mutation_barriers();
SELECT public.assert_active_authenticated_subject_mutation_barriers();

NOTIFY pgrst, 'reload schema';

COMMIT;
