-- Suppress legacy ranking-change notification payloads until both sides of a
-- historical event have an immutable publication provenance contract. The
-- rows remain retained for audit/cleanup; this migration changes only reader
-- visibility (the service page/count RPC and authenticated browser RLS).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL TIME ZONE 'UTC';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('notification-ranking-change-reader-fence', 0)
);

DO $preflight$
DECLARE
  v_reader pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.get_user_notifications(uuid,integer,integer,boolean)'
  );
  v_relation oid := pg_catalog.to_regclass('public.notifications');
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_service oid := pg_catalog.to_regrole('service_role');
  v_authenticator oid := pg_catalog.to_regrole('authenticator');
  v_anon oid := 'anon'::pg_catalog.regrole;
  v_authenticated oid := 'authenticated'::pg_catalog.regrole;
  v_relation_kind text;
  v_relation_owner oid;
BEGIN
  IF pg_catalog.to_regclass('public.notifications') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL THEN
    RAISE EXCEPTION 'notification reader relations are required';
  END IF;

  IF v_reader IS NULL THEN
    RAISE EXCEPTION 'canonical get_user_notifications reader is required';
  END IF;

  IF v_postgres IS NULL
     OR v_anon IS NULL
     OR v_authenticated IS NULL
     OR v_service IS NULL
     OR v_authenticator IS NULL THEN
    RAISE EXCEPTION 'notification reader roles are required';
  END IF;

  SELECT relation_row.relkind::text, relation_row.relowner
  INTO STRICT v_relation_kind, v_relation_owner
  FROM pg_catalog.pg_class AS relation_row
  WHERE relation_row.oid = v_relation;

  -- RLS does not constrain a table owner unless FORCE ROW LEVEL SECURITY is
  -- enabled. This fence intentionally preserves the existing service policy,
  -- so fail closed rather than accepting a browser-capable owner drift.
  IF v_relation_kind <> 'r'
     OR v_relation_owner <> v_postgres THEN
    RAISE EXCEPTION
      'notification reader fence requires the postgres-owned table';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL THEN
    RAISE EXCEPTION 'auth.role() is required by the service notification reader';
  END IF;

  IF pg_catalog.to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'auth.uid() is required by the direct notification reader fence';
  END IF;

  IF EXISTS (
    SELECT required_column.name
    FROM pg_catalog.unnest(
      ARRAY['id', 'user_id', 'type', 'title', 'message', 'link', 'read',
        'actor_id', 'reference_id', 'created_at']::text[]
    ) AS required_column(name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute_row
      WHERE attribute_row.attrelid = 'public.notifications'::pg_catalog.regclass
        AND attribute_row.attname = required_column.name
        AND attribute_row.attnum > 0
        AND NOT attribute_row.attisdropped
    )
  ) THEN
    RAISE EXCEPTION 'notification reader column contract is incomplete';
  END IF;

  -- The inbox badge uses the authenticated table path. Refuse to make the
  -- canonical API safe while an unreviewed browser SELECT policy can still
  -- return the same legacy row directly.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid = 'public.notifications'::pg_catalog.regclass
      AND policy_row.polcmd IN ('r', '*')
      AND (
        0::oid = ANY(policy_row.polroles)
        OR v_anon = ANY(policy_row.polroles)
        OR v_authenticated = ANY(policy_row.polroles)
      )
      AND policy_row.polname <> 'Users can read own notifications'
  ) THEN
    RAISE EXCEPTION 'unreviewed browser notification SELECT policy blocks ranking-change fence';
  END IF;

  -- `authenticator` is the sole PostgREST gateway that may SET ROLE
  -- service_role after a service JWT is verified. The service ALL policy is
  -- permissive, so an inherited, SET, or ADMIN path from a browser role would
  -- otherwise OR around the type predicate in the browser policy.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.oid IN (v_anon, v_authenticated)
      AND (role_row.rolsuper OR role_row.rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'notification reader browser role posture is unsafe';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_auth_members AS membership
       WHERE membership.roleid = v_service
         AND membership.member = v_authenticator
         AND NOT membership.admin_option
         AND NOT membership.inherit_option
         AND membership.set_option
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_roles AS role_row
       WHERE role_row.oid = v_authenticator
         AND role_row.rolcanlogin
         AND NOT role_row.rolinherit
         AND NOT role_row.rolsuper
         AND NOT role_row.rolcreaterole
         AND NOT role_row.rolcreatedb
         AND NOT role_row.rolreplication
         AND NOT role_row.rolbypassrls
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_auth_members AS membership
       WHERE membership.roleid = v_service
         AND membership.member NOT IN (v_postgres, v_authenticator)
     ) OR EXISTS (
       -- The postgres-owned table would bypass RLS for any member path.
       SELECT 1
       FROM pg_catalog.pg_auth_members AS membership
       WHERE membership.roleid = v_postgres
     ) OR EXISTS (
       -- Follow every authority-bearing downstream edge from service_role.
       -- The only non-owner terminus is the exact SET-only gateway edge.
       WITH RECURSIVE service_authority(member_oid, path) AS (
         SELECT
           membership.member,
           ARRAY[v_service, membership.member]::oid[]
         FROM pg_catalog.pg_auth_members AS membership
         WHERE membership.roleid = v_service
           AND (
             membership.admin_option
             OR membership.inherit_option
             OR membership.set_option
           )

         UNION ALL

         SELECT
           membership.member,
           authority.path || membership.member
         FROM service_authority AS authority
         JOIN pg_catalog.pg_auth_members AS membership
           ON membership.roleid = authority.member_oid
         WHERE (
           membership.admin_option
           OR membership.inherit_option
           OR membership.set_option
         )
           AND NOT (membership.member = ANY(authority.path))
       )
       SELECT 1
       FROM service_authority AS authority
       WHERE authority.path <> ARRAY[v_service, v_postgres]::oid[]
         AND NOT (
           authority.path = ARRAY[v_service, v_authenticator]::oid[]
           AND EXISTS (
             SELECT 1
             FROM pg_catalog.pg_auth_members AS membership
             WHERE membership.roleid = v_service
               AND membership.member = v_authenticator
               AND NOT membership.admin_option
               AND NOT membership.inherit_option
               AND membership.set_option
           )
         )
     ) OR EXISTS (
       -- A recursive owner attestation catches ADMIN/SET/INHERIT paths into
       -- postgres even if a later edit narrows a direct-membership predicate.
       WITH RECURSIVE postgres_authority(member_oid, path) AS (
         SELECT
           membership.member,
           ARRAY[v_postgres, membership.member]::oid[]
         FROM pg_catalog.pg_auth_members AS membership
         WHERE membership.roleid = v_postgres
           AND (
             membership.admin_option
             OR membership.inherit_option
             OR membership.set_option
           )

         UNION ALL

         SELECT
           membership.member,
           authority.path || membership.member
         FROM postgres_authority AS authority
         JOIN pg_catalog.pg_auth_members AS membership
           ON membership.roleid = authority.member_oid
         WHERE (
           membership.admin_option
           OR membership.inherit_option
           OR membership.set_option
         )
           AND NOT (membership.member = ANY(authority.path))
       )
       SELECT 1 FROM postgres_authority
     ) OR EXISTS (
       -- service_role itself must not inherit, SET, or ADMIN-delegate into an
       -- unrelated upstream authority.
       WITH RECURSIVE service_upstream(role_oid, path) AS (
         SELECT
           membership.roleid,
           ARRAY[v_service, membership.roleid]::oid[]
         FROM pg_catalog.pg_auth_members AS membership
         WHERE membership.member = v_service
           AND (
             membership.admin_option
             OR membership.inherit_option
             OR membership.set_option
           )

         UNION ALL

         SELECT
           membership.roleid,
           authority.path || membership.roleid
         FROM service_upstream AS authority
         JOIN pg_catalog.pg_auth_members AS membership
           ON membership.member = authority.role_oid
         WHERE (
           membership.admin_option
           OR membership.inherit_option
           OR membership.set_option
         )
           AND NOT (membership.roleid = ANY(authority.path))
       )
       SELECT 1 FROM service_upstream
     ) OR EXISTS (
       -- Keep a browser-rooted proof as well: it makes direct and indirect
       -- auth/anon routes to the gateway, service, or owner explicit.
       WITH RECURSIVE browser_authority(root_oid, role_oid, path) AS (
         SELECT
           browser_role.oid,
           membership.roleid,
           ARRAY[browser_role.oid, membership.roleid]::oid[]
         FROM pg_catalog.pg_roles AS browser_role
         JOIN pg_catalog.pg_auth_members AS membership
           ON membership.member = browser_role.oid
         WHERE browser_role.oid IN (v_anon, v_authenticated)
           AND (
             membership.admin_option
             OR membership.inherit_option
             OR membership.set_option
           )

         UNION ALL

         SELECT
           authority.root_oid,
           membership.roleid,
           authority.path || membership.roleid
         FROM browser_authority AS authority
         JOIN pg_catalog.pg_auth_members AS membership
           ON membership.member = authority.role_oid
         WHERE (
           membership.admin_option
           OR membership.inherit_option
           OR membership.set_option
         )
           AND NOT (membership.roleid = ANY(authority.path))
       )
       SELECT 1
       FROM browser_authority AS authority
       WHERE authority.role_oid IN (v_authenticator, v_service, v_postgres)
     ) OR pg_catalog.pg_has_role('anon', 'service_role', 'MEMBER')
       OR pg_catalog.pg_has_role('authenticated', 'service_role', 'MEMBER')
       OR pg_catalog.pg_has_role('anon', 'postgres', 'MEMBER')
       OR pg_catalog.pg_has_role('authenticated', 'postgres', 'MEMBER') THEN
    RAISE EXCEPTION 'notification reader internal role authority graph is unsafe';
  END IF;
END
$preflight$;

-- Policy DDL takes an ACCESS EXCLUSIVE metadata lock; take it explicitly so
-- the bounded lock timeout covers the full reader cutover rather than a later
-- implicit lock upgrade.
LOCK TABLE ONLY public.notifications IN ACCESS EXCLUSIVE MODE;

-- Policies remain inert while RLS is disabled. Converge the table state before
-- replacing the browser reader policy so a historical DISABLE RLS drift cannot
-- leave ranking_change rows directly readable after this migration commits.
ALTER TABLE ONLY public.notifications ENABLE ROW LEVEL SECURITY;

DO $rls_enabled_preflight$
BEGIN
  IF NOT COALESCE((
    SELECT relation_row.relrowsecurity
    FROM pg_catalog.pg_class AS relation_row
    WHERE relation_row.oid = 'public.notifications'::pg_catalog.regclass
  ), false) THEN
    RAISE EXCEPTION 'notification reader RLS did not enable before policy cutover';
  END IF;
END
$rls_enabled_preflight$;

-- The authenticated browser client has a count-only inbox badge path. Apply
-- the same type fence at RLS so it cannot be widened by a missed query filter
-- or a direct PostgREST table request. The service-role ALL policy remains the
-- internal writer/reader authority.
DROP POLICY IF EXISTS "Users can read own notifications" ON public.notifications;
CREATE POLICY "Users can read own notifications"
  ON public.notifications
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
    AND type IS DISTINCT FROM 'ranking_change'
  );

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
      AND notification.type IS DISTINCT FROM 'ranking_change'
      AND (NOT p_unread_only OR NOT notification.read)
    ORDER BY notification.created_at DESC
    LIMIT p_limit
    OFFSET p_offset
  ),
  unread AS (
    SELECT pg_catalog.count(*) AS count
    FROM public.notifications AS unread_notification
    WHERE unread_notification.user_id = p_user_id
      AND unread_notification.type IS DISTINCT FROM 'ranking_change'
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

-- A same-name overload can also be selected by an RPC caller with a smaller
-- argument set. Keep the prior service-only boundary converged for every
-- overload, rather than assuming the canonical function is the only legacy
-- entry point. The canonical function's JWT-role guard is a second boundary.
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
      SELECT DISTINCT role_row.rolname
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_entry
      JOIN pg_catalog.pg_roles AS role_row
        ON role_row.oid = acl_entry.grantee
      WHERE function_row.oid = v_function.oid
        AND acl_entry.grantee <> function_row.proowner
      ORDER BY role_row.rolname
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

COMMENT ON FUNCTION public.get_user_notifications(uuid, integer, integer, boolean) IS
  'Service-only notification reader. Legacy ranking_change rows are suppressed until immutable historical evidence exists.';

DO $postflight$
DECLARE
  v_reader constant pg_catalog.regprocedure :=
    'public.get_user_notifications(uuid,integer,integer,boolean)'::pg_catalog.regprocedure;
  v_postgres oid := 'postgres'::pg_catalog.regrole;
  v_service oid := 'service_role'::pg_catalog.regrole;
  v_authenticator oid := 'authenticator'::pg_catalog.regrole;
  v_anon oid := 'anon'::pg_catalog.regrole;
  v_authenticated oid := 'authenticated'::pg_catalog.regrole;
  v_function record;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation_row
    WHERE relation_row.oid = 'public.notifications'::pg_catalog.regclass
      AND relation_row.relkind = 'r'
      AND relation_row.relowner = v_postgres
  ) THEN
    RAISE EXCEPTION
      'notification reader fence no longer has the postgres-owned table';
  END IF;

  IF NOT COALESCE((
    SELECT relation_row.relrowsecurity
    FROM pg_catalog.pg_class AS relation_row
    WHERE relation_row.oid = 'public.notifications'::pg_catalog.regclass
  ), false) THEN
    RAISE EXCEPTION 'notification reader RLS did not remain enabled';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid = 'public.notifications'::pg_catalog.regclass
      AND policy_row.polname = 'Users can read own notifications'
      AND policy_row.polcmd = 'r'
      AND policy_row.polpermissive
      AND policy_row.polroles = ARRAY[0]::oid[]
      AND pg_catalog.strpos(
        pg_catalog.pg_get_expr(policy_row.polqual, policy_row.polrelid),
        'auth.uid'
      ) > 0
      AND pg_catalog.strpos(
        pg_catalog.pg_get_expr(policy_row.polqual, policy_row.polrelid),
        'IS DISTINCT FROM'
      ) > 0
      AND pg_catalog.strpos(
        pg_catalog.pg_get_expr(policy_row.polqual, policy_row.polrelid),
        'ranking_change'
      ) > 0
  ) THEN
    RAISE EXCEPTION 'authenticated notification RLS reader fence did not converge';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid = 'public.notifications'::pg_catalog.regclass
      AND policy_row.polcmd IN ('r', '*')
      AND (
        0::oid = ANY(policy_row.polroles)
        OR v_anon = ANY(policy_row.polroles)
        OR v_authenticated = ANY(policy_row.polroles)
      )
      AND policy_row.polname <> 'Users can read own notifications'
  ) THEN
    RAISE EXCEPTION 'unsafe browser notification SELECT policy survived reader fence';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_reader
      AND function_row.proowner = v_postgres
      AND function_row.prokind = 'f'
      AND language_row.lanname = 'plpgsql'
      AND function_row.provolatile = 's'
      AND function_row.prosecdef
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
      AND pg_catalog.strpos(
        function_row.prosrc,
        'notification.type IS DISTINCT FROM ''ranking_change'''
      ) > 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        'unread_notification.type IS DISTINCT FROM ''ranking_change'''
      ) > 0
  ) THEN
    RAISE EXCEPTION 'notification ranking-change reader fence did not converge';
  END IF;

  FOR v_function IN
    SELECT
      function_row.oid,
      function_row.proowner,
      function_row.proacl,
      function_row.oid = v_reader AS is_canonical
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname = 'get_user_notifications'
      AND function_row.prokind = 'f'
  LOOP
    IF v_function.proowner <> v_postgres
       OR pg_catalog.has_function_privilege('anon', v_function.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_function.oid, 'EXECUTE')
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
              v_postgres,
              CASE
                WHEN v_function.is_canonical THEN v_service
                ELSE v_postgres
              END
            )
            OR (
              acl_entry.grantee = v_service
              AND acl_entry.is_grantable
            )
       )
    THEN
      RAISE EXCEPTION
        'notification reader overload authority did not converge: %',
        v_function.oid::pg_catalog.regprocedure;
    END IF;
  END LOOP;

  -- Role membership is independent of the table lock. Re-attest both the
  -- browser posture and the complete authority graph immediately before
  -- commit so a concurrent GRANT cannot turn the preserved service ALL policy
  -- into a browser ranking_change bypass.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.oid IN (v_anon, v_authenticated)
      AND (role_row.rolsuper OR role_row.rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'notification reader browser role posture drifted after cutover';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_auth_members AS membership
       WHERE membership.roleid = v_service
         AND membership.member = v_authenticator
         AND NOT membership.admin_option
         AND NOT membership.inherit_option
         AND membership.set_option
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_roles AS role_row
       WHERE role_row.oid = v_authenticator
         AND role_row.rolcanlogin
         AND NOT role_row.rolinherit
         AND NOT role_row.rolsuper
         AND NOT role_row.rolcreaterole
         AND NOT role_row.rolcreatedb
         AND NOT role_row.rolreplication
         AND NOT role_row.rolbypassrls
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_auth_members AS membership
       WHERE membership.roleid = v_service
         AND membership.member NOT IN (v_postgres, v_authenticator)
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_auth_members AS membership
       WHERE membership.roleid = v_postgres
     ) OR EXISTS (
       WITH RECURSIVE service_authority(member_oid, path) AS (
         SELECT
           membership.member,
           ARRAY[v_service, membership.member]::oid[]
         FROM pg_catalog.pg_auth_members AS membership
         WHERE membership.roleid = v_service
           AND (
             membership.admin_option
             OR membership.inherit_option
             OR membership.set_option
           )

         UNION ALL

         SELECT
           membership.member,
           authority.path || membership.member
         FROM service_authority AS authority
         JOIN pg_catalog.pg_auth_members AS membership
           ON membership.roleid = authority.member_oid
         WHERE (
           membership.admin_option
           OR membership.inherit_option
           OR membership.set_option
         )
           AND NOT (membership.member = ANY(authority.path))
       )
       SELECT 1
       FROM service_authority AS authority
       WHERE authority.path <> ARRAY[v_service, v_postgres]::oid[]
         AND NOT (
           authority.path = ARRAY[v_service, v_authenticator]::oid[]
           AND EXISTS (
             SELECT 1
             FROM pg_catalog.pg_auth_members AS membership
             WHERE membership.roleid = v_service
               AND membership.member = v_authenticator
               AND NOT membership.admin_option
               AND NOT membership.inherit_option
               AND membership.set_option
           )
         )
     ) OR EXISTS (
       WITH RECURSIVE postgres_authority(member_oid, path) AS (
         SELECT
           membership.member,
           ARRAY[v_postgres, membership.member]::oid[]
         FROM pg_catalog.pg_auth_members AS membership
         WHERE membership.roleid = v_postgres
           AND (
             membership.admin_option
             OR membership.inherit_option
             OR membership.set_option
           )

         UNION ALL

         SELECT
           membership.member,
           authority.path || membership.member
         FROM postgres_authority AS authority
         JOIN pg_catalog.pg_auth_members AS membership
           ON membership.roleid = authority.member_oid
         WHERE (
           membership.admin_option
           OR membership.inherit_option
           OR membership.set_option
         )
           AND NOT (membership.member = ANY(authority.path))
       )
       SELECT 1 FROM postgres_authority
     ) OR EXISTS (
       WITH RECURSIVE service_upstream(role_oid, path) AS (
         SELECT
           membership.roleid,
           ARRAY[v_service, membership.roleid]::oid[]
         FROM pg_catalog.pg_auth_members AS membership
         WHERE membership.member = v_service
           AND (
             membership.admin_option
             OR membership.inherit_option
             OR membership.set_option
           )

         UNION ALL

         SELECT
           membership.roleid,
           authority.path || membership.roleid
         FROM service_upstream AS authority
         JOIN pg_catalog.pg_auth_members AS membership
           ON membership.member = authority.role_oid
         WHERE (
           membership.admin_option
           OR membership.inherit_option
           OR membership.set_option
         )
           AND NOT (membership.roleid = ANY(authority.path))
       )
       SELECT 1 FROM service_upstream
     ) OR EXISTS (
       WITH RECURSIVE browser_authority(root_oid, role_oid, path) AS (
         SELECT
           browser_role.oid,
           membership.roleid,
           ARRAY[browser_role.oid, membership.roleid]::oid[]
         FROM pg_catalog.pg_roles AS browser_role
         JOIN pg_catalog.pg_auth_members AS membership
           ON membership.member = browser_role.oid
         WHERE browser_role.oid IN (v_anon, v_authenticated)
           AND (
             membership.admin_option
             OR membership.inherit_option
             OR membership.set_option
           )

         UNION ALL

         SELECT
           authority.root_oid,
           membership.roleid,
           authority.path || membership.roleid
         FROM browser_authority AS authority
         JOIN pg_catalog.pg_auth_members AS membership
           ON membership.member = authority.role_oid
         WHERE (
           membership.admin_option
           OR membership.inherit_option
           OR membership.set_option
         )
           AND NOT (membership.roleid = ANY(authority.path))
       )
       SELECT 1
       FROM browser_authority AS authority
       WHERE authority.role_oid IN (v_authenticator, v_service, v_postgres)
     ) OR pg_catalog.pg_has_role('anon', 'service_role', 'MEMBER')
       OR pg_catalog.pg_has_role('authenticated', 'service_role', 'MEMBER')
       OR pg_catalog.pg_has_role('anon', 'postgres', 'MEMBER')
       OR pg_catalog.pg_has_role('authenticated', 'postgres', 'MEMBER') THEN
    RAISE EXCEPTION 'notification reader internal role authority graph drifted after cutover';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
