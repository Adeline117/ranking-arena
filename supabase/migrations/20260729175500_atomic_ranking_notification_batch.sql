-- Migration: 20260729175500_atomic_ranking_notification_batch.sql
-- Created: 2026-07-30T10:55:00Z
-- Description: Give ranking-notification cron jobs one lifecycle-safe,
--   retry-safe batch authority. A stable recipient/reference identity is
--   created at most once and the acknowledgement identifies exactly which
--   rows were created, deduplicated, or skipped because the account is no
--   longer active.
--
-- Forward compensation: move both ranking notification jobs back to the
-- service-only single-create authority before dropping this RPC and index in
-- a later forward migration.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.notifications:atomic-ranking-batch:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic ranking-notification batch migration lock is busy';
  END IF;
END
$migration_lock$;

DO $preflight$
DECLARE
  v_postgres_oid oid := pg_catalog.to_regrole('postgres')::oid;
  v_missing_roles text[];
  v_invalid_columns text[];
  v_batch_function regprocedure := pg_catalog.to_regprocedure(
    'public.create_ranking_notifications_batch_atomic(jsonb)'
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
      'ranking-notification batch roles are missing: %',
      v_missing_roles;
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.notifications') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.create_notification_atomic(uuid,text,text,text,text,uuid,text,boolean,integer)'
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
    RAISE EXCEPTION
      'ranking notification batching requires canonical permanent relations';
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
      'ranking notification batching has incompatible columns: %',
      v_invalid_columns;
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
      ) ~ $$'ranking_change'$$
  ) THEN
    RAISE EXCEPTION 'notifications.type must permit ranking_change';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'create_ranking_notifications_batch_atomic'
      AND (
        v_batch_function IS NULL
        OR function_row.oid <> v_batch_function::oid
      )
  ) THEN
    RAISE EXCEPTION
      'ambiguous atomic ranking-notification batch overload exists';
  END IF;
END
$preflight$;

LOCK TABLE auth.users,
  public.user_profiles
  IN SHARE MODE;
LOCK TABLE public.notifications
  IN SHARE ROW EXCLUSIVE MODE;

-- Historical callers used an unbounded stable reference and could create the
-- same logical event repeatedly. Keep the latest visible copy before making
-- that identity unique. NULL references remain intentionally outside the new
-- authority.
WITH duplicate_rows AS (
  SELECT ranked.id
  FROM (
    SELECT
      notification.id,
      pg_catalog.row_number() OVER (
        PARTITION BY
          notification.user_id,
          notification.type,
          notification.reference_id
        ORDER BY
          notification.created_at DESC NULLS LAST,
          notification.id DESC
      ) AS duplicate_ordinal
    FROM public.notifications AS notification
    WHERE notification.type = 'ranking_change'
      AND notification.reference_id IS NOT NULL
  ) AS ranked
  WHERE ranked.duplicate_ordinal > 1
)
DELETE FROM public.notifications AS notification
USING duplicate_rows
WHERE notification.id = duplicate_rows.id;

CREATE UNIQUE INDEX IF NOT EXISTS
  notifications_ranking_change_identity_unique
  ON public.notifications (user_id, type, reference_id)
  WHERE type = 'ranking_change' AND reference_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.create_ranking_notifications_batch_atomic(
  p_rows jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_requested_count integer;
  v_created_count integer := 0;
  v_skipped_count integer := 0;
  v_deduplicated_count integer := 0;
  v_active_recipient_ids uuid[] := ARRAY[]::uuid[];
  v_unavailable_recipient_ids uuid[] := ARRAY[]::uuid[];
  v_recipient_id uuid;
  v_auth_id uuid;
  v_profile_id uuid;
  v_recipient_active boolean := false;
  v_identity record;
  v_conflict_request_id uuid;
  v_created_rows jsonb := '[]'::jsonb;
  v_results jsonb := '[]'::jsonb;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_rows IS NULL
     OR pg_catalog.jsonb_typeof(p_rows) IS DISTINCT FROM 'array'
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  v_requested_count := pg_catalog.jsonb_array_length(p_rows);
  IF v_requested_count NOT BETWEEN 1 AND 500
     OR pg_catalog.octet_length(p_rows::text) > 4194304
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_rows) AS input(row_data)
    WHERE pg_catalog.jsonb_typeof(input.row_data) IS DISTINCT FROM 'object'
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_rows) AS input(row_data)
    WHERE (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.jsonb_object_keys(input.row_data)
    ) <> 6
       OR NOT input.row_data ?& ARRAY[
         'request_id',
         'recipient_id',
         'title',
         'message',
         'link',
         'reference_id'
       ]::text[]
       OR pg_catalog.jsonb_typeof(input.row_data -> 'request_id')
         IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(input.row_data -> 'recipient_id')
         IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(input.row_data -> 'title')
         IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(input.row_data -> 'message')
         IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(input.row_data -> 'reference_id')
         IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(input.row_data -> 'link')
         NOT IN ('string', 'null')
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_rows) AS input(row_data)
    WHERE (input.row_data ->> 'request_id')
      !~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
       OR (input.row_data ->> 'recipient_id')
      !~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
       OR pg_catalog.char_length(input.row_data ->> 'title') NOT BETWEEN 1 AND 200
       OR pg_catalog.btrim(input.row_data ->> 'title') = ''
       OR pg_catalog.char_length(input.row_data ->> 'message') NOT BETWEEN 1 AND 1000
       OR pg_catalog.btrim(input.row_data ->> 'message') = ''
       OR pg_catalog.char_length(input.row_data ->> 'reference_id') NOT BETWEEN 1 AND 500
       OR pg_catalog.btrim(input.row_data ->> 'reference_id')
         IS DISTINCT FROM input.row_data ->> 'reference_id'
       OR (input.row_data ->> 'reference_id') ~ '[[:cntrl:]]'
       OR (
         pg_catalog.jsonb_typeof(input.row_data -> 'link') = 'string'
         AND (
           pg_catalog.char_length(input.row_data ->> 'link') NOT BETWEEN 1 AND 500
           OR pg_catalog.left(input.row_data ->> 'link', 1) <> '/'
           OR pg_catalog.left(input.row_data ->> 'link', 2) = '//'
           OR pg_catalog.strpos(input.row_data ->> 'link', E'\\') > 0
           OR (input.row_data ->> 'link') ~ '[[:cntrl:]]'
         )
       )
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_rows) AS input(row_data)
    GROUP BY (input.row_data ->> 'request_id')::uuid
    HAVING pg_catalog.count(*) > 1
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_rows) AS input(row_data)
    GROUP BY
      (input.row_data ->> 'recipient_id')::uuid,
      input.row_data ->> 'reference_id'
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'DUPLICATE_INPUT'
    );
  END IF;

  -- The same account admission lock is used by notification creation and the
  -- account recovery/deletion authorities. UUID order prevents batch-to-batch
  -- deadlocks while account parents and profile state remain locked.
  FOR v_recipient_id IN
    SELECT DISTINCT (input.row_data ->> 'recipient_id')::uuid
    FROM pg_catalog.jsonb_array_elements(p_rows) AS input(row_data)
    ORDER BY 1
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'account-recovery-admission:' || v_recipient_id::text,
        0
      )
    );

    v_auth_id := NULL;
    SELECT auth_user.id
    INTO v_auth_id
    FROM auth.users AS auth_user
    WHERE auth_user.id = v_recipient_id
    FOR KEY SHARE;

    v_profile_id := NULL;
    v_recipient_active := false;
    IF v_auth_id IS NOT NULL THEN
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
      INTO v_profile_id, v_recipient_active
      FROM public.user_profiles AS profile
      WHERE profile.id = v_recipient_id
      FOR SHARE;
    END IF;

    IF v_auth_id IS NOT NULL
       AND v_profile_id IS NOT NULL
       AND v_recipient_active
    THEN
      v_active_recipient_ids := pg_catalog.array_append(
        v_active_recipient_ids,
        v_recipient_id
      );
    ELSE
      v_unavailable_recipient_ids := pg_catalog.array_append(
        v_unavailable_recipient_ids,
        v_recipient_id
      );
    END IF;
  END LOOP;

  -- Match the single-create authority's advisory identity, including its NULL
  -- system actor, so both authorities serialize on the same logical row.
  FOR v_identity IN
    SELECT
      (input.row_data ->> 'recipient_id')::uuid AS recipient_id,
      input.row_data ->> 'reference_id' AS reference_id
    FROM pg_catalog.jsonb_array_elements(p_rows) AS input(row_data)
    WHERE (input.row_data ->> 'recipient_id')::uuid
      = ANY(v_active_recipient_ids)
    ORDER BY 1, 2
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'notification-create:' || pg_catalog.jsonb_build_array(
          v_identity.recipient_id,
          'ranking_change',
          NULL,
          v_identity.reference_id
        )::text,
        0
      )
    );
  END LOOP;

  -- A reference is immutable. Reusing it with different visible content is a
  -- caller bug, not a successful replay.
  SELECT (input.row_data ->> 'request_id')::uuid
  INTO v_conflict_request_id
  FROM pg_catalog.jsonb_array_elements(p_rows)
    WITH ORDINALITY AS input(row_data, ordinal)
  JOIN public.notifications AS notification
    ON notification.user_id = (input.row_data ->> 'recipient_id')::uuid
   AND notification.type = 'ranking_change'
   AND notification.reference_id = input.row_data ->> 'reference_id'
  WHERE notification.user_id = ANY(v_active_recipient_ids)
    AND (
      notification.title IS DISTINCT FROM input.row_data ->> 'title'
      OR notification.message IS DISTINCT FROM input.row_data ->> 'message'
      OR notification.link IS DISTINCT FROM CASE
        WHEN pg_catalog.jsonb_typeof(input.row_data -> 'link') = 'null'
          THEN NULL
        ELSE input.row_data ->> 'link'
      END
    )
  ORDER BY input.ordinal
  LIMIT 1
  FOR UPDATE OF notification;

  IF v_conflict_request_id IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'IDENTITY_CONFLICT',
      'request_id', v_conflict_request_id,
      'requested_count', v_requested_count
    );
  END IF;

  WITH input_rows AS (
    SELECT
      (input.row_data ->> 'recipient_id')::uuid AS recipient_id,
      input.row_data ->> 'title' AS title,
      input.row_data ->> 'message' AS message,
      CASE
        WHEN pg_catalog.jsonb_typeof(input.row_data -> 'link') = 'null'
          THEN NULL
        ELSE input.row_data ->> 'link'
      END AS link,
      input.row_data ->> 'reference_id' AS reference_id
    FROM pg_catalog.jsonb_array_elements(p_rows) AS input(row_data)
  ),
  inserted AS (
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
    )
    SELECT
      input.recipient_id,
      'ranking_change',
      input.title,
      input.message,
      input.link,
      false,
      NULL,
      input.reference_id,
      v_now
    FROM input_rows AS input
    WHERE input.recipient_id = ANY(v_active_recipient_ids)
    ORDER BY input.recipient_id, input.reference_id
    ON CONFLICT (user_id, type, reference_id)
      WHERE type = 'ranking_change' AND reference_id IS NOT NULL
      DO NOTHING
    RETURNING id, user_id, reference_id, created_at
  )
  SELECT
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'notification_id', inserted.id,
          'recipient_id', inserted.user_id,
          'reference_id', inserted.reference_id,
          'created_at', inserted.created_at
        )
        ORDER BY inserted.user_id, inserted.reference_id
      ),
      '[]'::jsonb
    ),
    pg_catalog.count(*)::integer
  INTO v_created_rows, v_created_count
  FROM inserted;

  -- This can only be reached if an uncooperative writer raced the advisory
  -- protocol. Raising (instead of returning) rolls back every row this batch
  -- may already have inserted.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_rows) AS input(row_data)
    JOIN public.notifications AS notification
      ON notification.user_id = (input.row_data ->> 'recipient_id')::uuid
     AND notification.type = 'ranking_change'
     AND notification.reference_id = input.row_data ->> 'reference_id'
    WHERE notification.user_id = ANY(v_active_recipient_ids)
      AND (
        notification.title IS DISTINCT FROM input.row_data ->> 'title'
        OR notification.message IS DISTINCT FROM input.row_data ->> 'message'
        OR notification.link IS DISTINCT FROM CASE
          WHEN pg_catalog.jsonb_typeof(input.row_data -> 'link') = 'null'
            THEN NULL
          ELSE input.row_data ->> 'link'
        END
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'ranking notification identity changed during batch creation';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_skipped_count
  FROM pg_catalog.jsonb_array_elements(p_rows) AS input(row_data)
  WHERE (input.row_data ->> 'recipient_id')::uuid
    = ANY(v_unavailable_recipient_ids);

  v_deduplicated_count :=
    v_requested_count - v_created_count - v_skipped_count;

  WITH input_rows AS (
    SELECT
      input.ordinal,
      (input.row_data ->> 'request_id')::uuid AS request_id,
      (input.row_data ->> 'recipient_id')::uuid AS recipient_id,
      input.row_data ->> 'title' AS title,
      input.row_data ->> 'message' AS message,
      CASE
        WHEN pg_catalog.jsonb_typeof(input.row_data -> 'link') = 'null'
          THEN NULL
        ELSE input.row_data ->> 'link'
      END AS link,
      input.row_data ->> 'reference_id' AS reference_id
    FROM pg_catalog.jsonb_array_elements(p_rows)
      WITH ORDINALITY AS input(row_data, ordinal)
  ),
  created_rows AS (
    SELECT
      (created.row_data ->> 'notification_id')::uuid AS notification_id
    FROM pg_catalog.jsonb_array_elements(v_created_rows) AS created(row_data)
  )
  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'request_id', input.request_id,
      'recipient_id', input.recipient_id,
      'type', 'ranking_change',
      'title', input.title,
      'message', input.message,
      'link', pg_catalog.to_jsonb(input.link),
      'reference_id', input.reference_id,
      'outcome', CASE
        WHEN input.recipient_id = ANY(v_unavailable_recipient_ids)
          THEN 'RECIPIENT_UNAVAILABLE'
        WHEN created.notification_id IS NOT NULL THEN 'CREATED'
        ELSE 'DEDUPLICATED'
      END,
      'notification_id', CASE
        WHEN input.recipient_id = ANY(v_unavailable_recipient_ids) THEN NULL
        ELSE notification.id
      END,
      'created_at', CASE
        WHEN input.recipient_id = ANY(v_unavailable_recipient_ids) THEN NULL
        ELSE notification.created_at
      END
    )
    ORDER BY input.ordinal
  )
  INTO STRICT v_results
  FROM input_rows AS input
  LEFT JOIN public.notifications AS notification
    ON notification.user_id = input.recipient_id
   AND notification.type = 'ranking_change'
   AND notification.reference_id = input.reference_id
  LEFT JOIN created_rows AS created
    ON created.notification_id = notification.id;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'type', 'ranking_change',
    'requested_count', v_requested_count,
    'created_count', v_created_count,
    'deduplicated_count', v_deduplicated_count,
    'skipped_count', v_skipped_count,
    'results', v_results
  );
END
$function$;

ALTER FUNCTION public.create_ranking_notifications_batch_atomic(jsonb)
  OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.create_ranking_notifications_batch_atomic(jsonb)'::regprocedure;
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
    ON FUNCTION public.create_ranking_notifications_batch_atomic(jsonb)
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.create_ranking_notifications_batch_atomic(jsonb)
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-ranking-notification-batch:v1:' || pg_catalog.md5(v_source)
  );

  IF pg_catalog.strpos(v_source, 'account-recovery-admission:') = 0
     OR pg_catalog.strpos(v_source, 'notification-create:') = 0
     OR pg_catalog.strpos(v_source, '''IDENTITY_CONFLICT''') = 0
     OR pg_catalog.strpos(v_source, '''RECIPIENT_UNAVAILABLE''') = 0
     OR pg_catalog.strpos(v_source, 'ON CONFLICT (user_id, type, reference_id)') = 0
  THEN
    RAISE EXCEPTION
      'atomic ranking-notification batch function contract drifted';
  END IF;
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.create_ranking_notifications_batch_atomic(jsonb)'::regprocedure;
  v_service_oid oid := pg_catalog.to_regrole('service_role')::oid;
  v_source text;
  v_index_expression text;
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
    AND function_row.pronargs = 1
    AND function_row.pronargdefaults = 0
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  SELECT pg_catalog.pg_get_expr(
    index_row.indpred,
    index_row.indrelid,
    false
  )
  INTO v_index_expression
  FROM pg_catalog.pg_index AS index_row
  WHERE index_row.indexrelid =
    'public.notifications_ranking_change_identity_unique'::regclass
    AND index_row.indrelid = 'public.notifications'::regclass
    AND index_row.indisvalid
    AND index_row.indisready
    AND index_row.indisunique
    AND index_row.indnkeyatts = 3
    AND index_row.indexprs IS NULL
    AND index_row.indkey[0] = (
      SELECT attribute.attnum
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = 'public.notifications'::regclass
        AND attribute.attname = 'user_id'
    )
    AND index_row.indkey[1] = (
      SELECT attribute.attnum
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = 'public.notifications'::regclass
        AND attribute.attname = 'type'
    )
    AND index_row.indkey[2] = (
      SELECT attribute.attnum
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = 'public.notifications'::regclass
        AND attribute.attname = 'reference_id'
    );

  IF v_index_expression IS NULL
     OR pg_catalog.strpos(v_index_expression, 'ranking_change') = 0
     OR pg_catalog.strpos(v_index_expression, 'reference_id IS NOT NULL') = 0
     OR pg_catalog.obj_description(v_function, 'pg_proc') IS DISTINCT FROM
       'atomic-ranking-notification-batch:v1:' || pg_catalog.md5(v_source)
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
         AND function_row.proname =
           'create_ranking_notifications_batch_atomic'
         AND function_row.oid <> v_function
     )
  THEN
    RAISE EXCEPTION
      'atomic ranking-notification batch authority drifted';
  END IF;
END
$postflight$;

SELECT public.install_active_authenticated_subject_mutation_barriers();
SELECT public.assert_active_authenticated_subject_mutation_barriers();

NOTIFY pgrst, 'reload schema';

COMMIT;
