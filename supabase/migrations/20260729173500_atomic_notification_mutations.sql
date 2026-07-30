-- Migration: 20260729173500_atomic_notification_mutations.sql
-- Created: 2026-07-30T10:35:00Z
-- Description: Make notification read/delete mutations exact, actor-bound,
--   lifecycle-aware, and service-only. User SELECT remains available for
--   realtime delivery, while direct table writes are quarantined.
--
-- Forward compensation: move every HTTP writer off this RPC before restoring
-- direct grants or dropping the function in a later forward migration.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.notifications:atomic-mutations:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic notification-mutation migration lock is busy';
  END IF;
END
$migration_lock$;

DO $preflight$
DECLARE
  v_postgres_oid oid := pg_catalog.to_regrole('postgres')::oid;
  v_missing_roles text[];
  v_invalid_columns text[];
  v_mutation_function regprocedure := pg_catalog.to_regprocedure(
    'public.mutate_notifications_atomic(uuid,text,uuid[])'
  );
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['anon', 'authenticated', 'service_role', 'postgres']::text[]
  ) AS required_role
  WHERE pg_catalog.to_regrole(required_role) IS NULL;

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'notification-mutation roles are missing: %', v_missing_roles;
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
    RAISE EXCEPTION 'notification mutations require canonical permanent relations';
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
      ('public', 'notifications', 3, 'read', 'boolean'::regtype, false),
      ('public', 'notifications', 4, 'read_at', 'timestamptz'::regtype, false)
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
      'notification mutations have incompatible columns: %',
      v_invalid_columns;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'mutate_notifications_atomic'
      AND (
        v_mutation_function IS NULL
        OR function_row.oid <> v_mutation_function::oid
      )
  ) THEN
    RAISE EXCEPTION 'ambiguous atomic notification-mutation overload exists';
  END IF;
END
$preflight$;

LOCK TABLE auth.users,
  public.user_profiles,
  public.notifications
  IN SHARE MODE;

-- SELECT remains governed by the viewer RLS policy for realtime delivery.
-- All notification writes now cross one server-side authority instead of
-- letting a browser update arbitrary columns on its own rows.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON TABLE public.notifications
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.notifications
  TO service_role;

DO $drop_direct_write_policies$
DECLARE
  v_policy record;
  v_anon_oid oid := pg_catalog.to_regrole('anon')::oid;
  v_authenticated_oid oid := pg_catalog.to_regrole('authenticated')::oid;
BEGIN
  FOR v_policy IN
    SELECT policy_row.polname
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid = 'public.notifications'::regclass
      AND policy_row.polcmd IN ('*', 'a', 'w', 'd')
      AND (
        0 = ANY(policy_row.polroles)
        OR v_anon_oid = ANY(policy_row.polroles)
        OR v_authenticated_oid = ANY(policy_row.polroles)
      )
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.notifications',
      v_policy.polname
    );
  END LOOP;
END
$drop_direct_write_policies$;

CREATE OR REPLACE FUNCTION public.mutate_notifications_atomic(
  p_actor_id uuid,
  p_action text,
  p_notification_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_auth_id uuid;
  v_profile_id uuid;
  v_actor_active boolean := false;
  v_requested_ids uuid[];
  v_owned_ids uuid[];
  v_changed_count bigint := 0;
  v_mutation_at timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_actor_id IS NULL
     OR p_action IS NULL
     OR p_action NOT IN ('MARK_READ', 'MARK_ALL_READ', 'DELETE')
     OR (
       p_action = 'MARK_ALL_READ'
       AND p_notification_ids IS NOT NULL
     )
     OR (
       p_action = 'MARK_READ'
       AND (
         p_notification_ids IS NULL
         OR pg_catalog.cardinality(p_notification_ids) NOT BETWEEN 1 AND 100
       )
     )
     OR (
       p_action = 'DELETE'
       AND (
         p_notification_ids IS NULL
         OR pg_catalog.cardinality(p_notification_ids) <> 1
       )
     )
     OR (
       p_notification_ids IS NOT NULL
       AND (
         EXISTS (
           SELECT 1
           FROM pg_catalog.unnest(p_notification_ids) AS requested_id
           WHERE requested_id IS NULL
         )
         OR pg_catalog.cardinality(p_notification_ids) <> (
           SELECT pg_catalog.count(DISTINCT requested_id)
           FROM pg_catalog.unnest(p_notification_ids) AS requested_id
         )
       )
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  IF p_notification_ids IS NOT NULL THEN
    SELECT pg_catalog.array_agg(requested_id ORDER BY requested_id)
    INTO STRICT v_requested_ids
    FROM pg_catalog.unnest(p_notification_ids) AS requested_id;
  END IF;

  -- Lock ordering is shared with account deletion/recovery. Keeping admission
  -- stable prevents a write acknowledgement for a deleted or banned viewer.
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
          OR profile.ban_expires_at > v_mutation_at
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

  -- Serialize every notification mutation for this viewer. Target rows are
  -- additionally locked before a set-bound mutation so a requested batch is
  -- applied wholly or not at all.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'notification-mutation:' || p_actor_id::text,
      0
    )
  );

  IF p_action IN ('MARK_READ', 'DELETE') THEN
    SELECT COALESCE(
      pg_catalog.array_agg(owned.id ORDER BY owned.id),
      ARRAY[]::uuid[]
    )
    INTO STRICT v_owned_ids
    FROM (
      SELECT notification.id
      FROM public.notifications AS notification
      WHERE notification.user_id = p_actor_id
        AND notification.id = ANY(v_requested_ids)
      ORDER BY notification.id
      FOR UPDATE
    ) AS owned;

    IF v_owned_ids IS DISTINCT FROM v_requested_ids THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'NOT_FOUND'
      );
    END IF;
  END IF;

  IF p_action = 'MARK_READ' THEN
    UPDATE public.notifications AS notification
    SET
      read = true,
      read_at = v_mutation_at
    WHERE notification.user_id = p_actor_id
      AND notification.id = ANY(v_requested_ids)
      AND notification.read IS DISTINCT FROM true;

    GET DIAGNOSTICS v_changed_count = ROW_COUNT;
  ELSIF p_action = 'MARK_ALL_READ' THEN
    UPDATE public.notifications AS notification
    SET
      read = true,
      read_at = v_mutation_at
    WHERE notification.user_id = p_actor_id
      AND notification.read IS DISTINCT FROM true;

    GET DIAGNOSTICS v_changed_count = ROW_COUNT;
  ELSE
    DELETE FROM public.notifications AS notification
    WHERE notification.user_id = p_actor_id
      AND notification.id = v_requested_ids[1];

    GET DIAGNOSTICS v_changed_count = ROW_COUNT;
    IF v_changed_count <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'locked notification target changed unexpectedly';
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'actor_id', p_actor_id,
    'action', p_action,
    'notification_ids', CASE
      WHEN p_notification_ids IS NULL THEN 'null'::jsonb
      ELSE pg_catalog.to_jsonb(p_notification_ids)
    END,
    'changed_count', v_changed_count,
    'mutation_at', v_mutation_at
  );
END
$function$;

ALTER FUNCTION public.mutate_notifications_atomic(uuid, text, uuid[])
  OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.mutate_notifications_atomic(uuid,text,uuid[])'::regprocedure;
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
    ON FUNCTION public.mutate_notifications_atomic(uuid, text, uuid[])
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.mutate_notifications_atomic(uuid, text, uuid[])
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-notification-mutations:v1:' || pg_catalog.md5(v_source)
  );

  IF pg_catalog.strpos(v_source, 'account-recovery-admission:') = 0
     OR pg_catalog.strpos(v_source, 'notification-mutation:') = 0
     OR pg_catalog.strpos(v_source, 'FOR UPDATE') = 0
     OR pg_catalog.strpos(v_source, 'v_owned_ids IS DISTINCT FROM v_requested_ids') = 0
     OR pg_catalog.strpos(v_source, 'GET DIAGNOSTICS v_changed_count = ROW_COUNT') = 0
  THEN
    RAISE EXCEPTION 'atomic notification-mutation function contract drifted';
  END IF;
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.mutate_notifications_atomic(uuid,text,uuid[])'::regprocedure;
  v_service_oid oid := pg_catalog.to_regrole('service_role')::oid;
  v_anon_oid oid := pg_catalog.to_regrole('anon')::oid;
  v_authenticated_oid oid := pg_catalog.to_regrole('authenticated')::oid;
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
    AND function_row.pronargs = 3
    AND function_row.pronargdefaults = 0
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF pg_catalog.obj_description(v_function, 'pg_proc') IS DISTINCT FROM
       'atomic-notification-mutations:v1:' || pg_catalog.md5(v_source)
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
         AND function_row.proname = 'mutate_notifications_atomic'
         AND function_row.oid <> v_function
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'public.notifications', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'public.notifications', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'public.notifications', 'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'public.notifications', 'TRUNCATE'
     )
     OR pg_catalog.has_table_privilege(
       'anon', 'public.notifications', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'anon', 'public.notifications', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'anon', 'public.notifications', 'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'anon', 'public.notifications', 'TRUNCATE'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'public.notifications', 'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'public.notifications', 'INSERT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'public.notifications', 'UPDATE'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'public.notifications', 'DELETE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy_row
       WHERE policy_row.polrelid = 'public.notifications'::regclass
         AND policy_row.polcmd IN ('*', 'a', 'w', 'd')
         AND (
           0 = ANY(policy_row.polroles)
           OR v_anon_oid = ANY(policy_row.polroles)
           OR v_authenticated_oid = ANY(policy_row.polroles)
         )
     )
  THEN
    RAISE EXCEPTION 'atomic notification-mutation authority drifted';
  END IF;
END
$postflight$;

SELECT public.install_active_authenticated_subject_mutation_barriers();
SELECT public.assert_active_authenticated_subject_mutation_barriers();

NOTIFY pgrst, 'reload schema';

COMMIT;
