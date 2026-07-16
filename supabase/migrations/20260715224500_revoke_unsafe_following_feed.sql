-- Retire browser access to the legacy following-feed SECURITY DEFINER RPC.
--
-- The legacy function accepts an arbitrary user UUID and returns SETOF posts,
-- so callers can impersonate another viewer and bypass the canonical post read
-- boundary.  The web client now uses GET /api/posts?sort_by=following, whose
-- viewer is derived from the verified bearer token.

BEGIN;

DO $revoke_legacy_following_feed$
DECLARE
  function_row record;
BEGIN
  -- Revoke every overload, including any production-only overload that is not
  -- represented in the repository schema.  PUBLIC must be revoked explicitly:
  -- revoking anon alone does not remove privileges inherited from PUBLIC.
  FOR function_row IN
    SELECT procedure.oid::regprocedure AS signature
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'get_following_feed'
      AND procedure.prokind = 'f'
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',
      function_row.signature
    );
  END LOOP;

  -- Assert PUBLIC directly as well as the application roles' effective
  -- privileges. This proves both the ACL shape and inherited access are closed.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) AS privilege
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'get_following_feed'
      AND procedure.prokind = 'f'
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'get_following_feed remains executable by PUBLIC';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
    CROSS JOIN (
      VALUES ('anon'::name), ('authenticated'::name), ('service_role'::name)
    ) AS application_role(role_name)
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'get_following_feed'
      AND procedure.prokind = 'f'
      AND pg_catalog.has_function_privilege(
        application_role.role_name,
        procedure.oid,
        'EXECUTE'
      )
  ) THEN
    RAISE EXCEPTION
      'get_following_feed remains executable by an application role';
  END IF;
END;
$revoke_legacy_following_feed$;

NOTIFY pgrst, 'reload schema';

COMMIT;
