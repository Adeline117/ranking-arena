-- Notification payloads are private account data. The authenticated HTTP API
-- binds its session user before using the service client, so every historical
-- get_user_notifications overload is quarantined and only the canonical RPC
-- remains service-executable.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('notification-read-authority', 0)
);

DO $preflight$
DECLARE
  v_function pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure(
      'public.get_user_notifications(uuid,integer,integer,boolean)'
    );
  v_missing_roles text[];
  v_role_function pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure('auth.role()');
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['postgres', 'anon', 'authenticated', 'service_role']::text[]
  ) AS required_role
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = required_role
  );

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION
      'notification read authority roles are missing: %',
      v_missing_roles;
  END IF;

  IF v_function IS NULL THEN
    RAISE EXCEPTION
      'canonical get_user_notifications(uuid,integer,integer,boolean) is missing';
  END IF;

  IF v_role_function IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_role_function
      AND function_row.prokind = 'f'
      AND function_row.pronargs = 0
      AND function_row.prorettype = 'text'::pg_catalog.regtype
  ) THEN
    RAISE EXCEPTION 'auth.role() is unavailable or incompatible';
  END IF;
END
$preflight$;

-- Rebuild the canonical function so ACL drift is not the only security layer.
-- The explicit JWT-role guard remains effective if EXECUTE is accidentally
-- re-granted later, and every relation/function reference is schema-qualified.
CREATE OR REPLACE FUNCTION public.get_user_notifications(
  p_user_id uuid,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_unread_only boolean DEFAULT false
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  type text,
  title text,
  message text,
  link text,
  read boolean,
  actor_id uuid,
  reference_id text,
  created_at timestamp with time zone,
  actor_handle text,
  actor_avatar_url text,
  unread_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'notification reader requires service role'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH notification_page AS (
    SELECT
      notification.id,
      notification.user_id,
      notification.type::text,
      notification.title,
      notification.message,
      notification.link,
      notification.read,
      notification.actor_id,
      notification.reference_id,
      notification.created_at
    FROM public.notifications AS notification
    WHERE notification.user_id = p_user_id
      AND (NOT p_unread_only OR NOT notification.read)
    ORDER BY notification.created_at DESC
    LIMIT p_limit
    OFFSET p_offset
  ),
  unread AS (
    SELECT pg_catalog.count(*) AS count
    FROM public.notifications AS unread_notification
    WHERE unread_notification.user_id = p_user_id
      AND NOT unread_notification.read
  )
  SELECT
    notification_page.id,
    notification_page.user_id,
    notification_page.type,
    notification_page.title,
    notification_page.message,
    notification_page.link,
    notification_page.read,
    notification_page.actor_id,
    notification_page.reference_id,
    notification_page.created_at,
    actor.handle,
    actor.avatar_url,
    unread.count
  FROM notification_page
  LEFT JOIN public.user_profiles AS actor
    ON actor.id = notification_page.actor_id
  CROSS JOIN unread
  ORDER BY notification_page.created_at DESC;
END
$function$;

ALTER FUNCTION public.get_user_notifications(uuid, integer, integer, boolean)
  OWNER TO postgres;

-- Function privileges are per overload and may contain grants to roles that no
-- longer appear in application code. Converge every function overload by
-- catalog instead of revoking a hard-coded role list. Same-name procedures are
-- intentionally outside PostgREST's RPC surface and remain untouched.
DO $converge_overload_authority$
DECLARE
  v_function record;
  v_grantee name;
BEGIN
  FOR v_function IN
    SELECT
      function_row.oid,
      pg_catalog.format(
        '%I.%I(%s)',
        namespace_row.nspname,
        function_row.proname,
        pg_catalog.pg_get_function_identity_arguments(function_row.oid)
      ) AS signature
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname = 'get_user_notifications'
      AND function_row.prokind = 'f'
    ORDER BY function_row.oid
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER FUNCTION %s OWNER TO postgres',
      v_function.signature
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE',
      v_function.signature
    );

    FOR v_grantee IN
      SELECT DISTINCT grantee_role.rolname
      FROM pg_catalog.pg_proc AS current_function
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          current_function.proacl,
          pg_catalog.acldefault('f', current_function.proowner)
        )
      ) AS acl_entry
      JOIN pg_catalog.pg_roles AS grantee_role
        ON grantee_role.oid = acl_entry.grantee
      WHERE current_function.oid = v_function.oid
        AND acl_entry.grantee <> current_function.proowner
      ORDER BY grantee_role.rolname
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
        v_function.signature,
        v_grantee
      );
    END LOOP;
  END LOOP;
END
$converge_overload_authority$;

GRANT EXECUTE
  ON FUNCTION public.get_user_notifications(uuid, integer, integer, boolean)
  TO service_role;

COMMENT ON FUNCTION
  public.get_user_notifications(uuid, integer, integer, boolean) IS
  'Service-only notification reader with an internal JWT-role guard.';

DO $postflight$
DECLARE
  v_canonical pg_catalog.regprocedure :=
    'public.get_user_notifications(uuid,integer,integer,boolean)'
      ::pg_catalog.regprocedure;
  v_function record;
  v_owner_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_canonical
      AND function_row.proowner = v_owner_oid
      AND language_row.lanname = 'plpgsql'
      AND function_row.prokind = 'f'
      AND function_row.prosecdef
      AND function_row.provolatile = 's'
      AND function_row.proretset
      AND function_row.prorettype = 'record'::pg_catalog.regtype
      AND function_row.pronargs = 4
      AND function_row.pronargdefaults = 3
      AND pg_catalog.pg_get_expr(
        function_row.proargdefaults,
        0::oid
      ) = '50, 0, false'
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid) =
        'p_user_id uuid, p_limit integer, p_offset integer, p_unread_only boolean'
      AND pg_catalog.pg_get_function_result(function_row.oid) =
        'TABLE(id uuid, user_id uuid, type text, title text, message text, link text, read boolean, actor_id uuid, reference_id text, created_at timestamp with time zone, actor_handle text, actor_avatar_url text, unread_count bigint)'
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
      AND pg_catalog.md5(function_row.prosrc) =
        'e65cc383873adaa2dca14b0e3eb5cac6'
  ) THEN
    RAISE EXCEPTION
      'canonical get_user_notifications contract did not converge';
  END IF;

  FOR v_function IN
    SELECT
      function_row.oid,
      function_row.proowner,
      function_row.proacl,
      function_row.oid = v_canonical AS is_canonical
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname = 'get_user_notifications'
      AND function_row.prokind = 'f'
  LOOP
    IF v_function.proowner <> v_owner_oid
       OR pg_catalog.has_function_privilege(
         'anon', v_function.oid, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
         'authenticated', v_function.oid, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
         'service_role', v_function.oid, 'EXECUTE'
       ) IS DISTINCT FROM v_function.is_canonical
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.aclexplode(
           COALESCE(
             v_function.proacl,
             pg_catalog.acldefault('f', v_function.proowner)
           )
         ) AS acl_entry
         WHERE acl_entry.privilege_type <> 'EXECUTE'
            OR acl_entry.grantee NOT IN (
              v_owner_oid,
              CASE
                WHEN v_function.is_canonical THEN v_service_oid
                ELSE v_owner_oid
              END
            )
            OR (
              acl_entry.grantee = v_service_oid
              AND acl_entry.is_grantable
            )
       )
    THEN
      RAISE EXCEPTION
        'get_user_notifications overload authority did not converge: %',
        v_function.oid::pg_catalog.regprocedure;
    END IF;
  END LOOP;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
