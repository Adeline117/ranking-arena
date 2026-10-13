-- Retire direct PostgREST execution of the legacy platform-statistics RPC.
--
-- get_platform_stats is a production-only legacy object: the current migration
-- history contains no definition for it, while its results are derived from raw
-- leaderboard state rather than an immutable public publication cohort. The
-- public route therefore fails closed until a separately reviewed publisher is
-- available. Do not recreate the function here; only remove every browser and
-- service-facing EXECUTE path from every live overload.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL TIME ZONE 'UTC';

DO $quarantine_legacy_platform_stats_rpc$
DECLARE
  function_row record;
BEGIN
  -- A missing function means this migration cannot attest the production
  -- surface it was written to close. Abort rather than recording a false-safe
  -- migration ledger entry.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = procedure.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND procedure.proname = 'get_platform_stats'
      AND procedure.prokind = 'f'
  ) THEN
    RAISE EXCEPTION
      'legacy platform statistics RPC quarantine requires at least one public.get_platform_stats function overload';
  END IF;

  IF pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
  THEN
    RAISE EXCEPTION
      'legacy platform statistics RPC quarantine requires Supabase API roles';
  END IF;

  -- Resolve from pg_proc instead of assuming the repository's old text
  -- signature. This covers every live overload without touching a same-named
  -- procedure or attempting to recreate the legacy implementation.
  FOR function_row IN
    SELECT procedure.oid::pg_catalog.regprocedure AS signature
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = procedure.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND procedure.proname = 'get_platform_stats'
      AND procedure.prokind = 'f'
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',
      function_row.signature
    );
  END LOOP;

  -- Check the direct PUBLIC ACL separately so a future role-name or
  -- membership change cannot hide a default EXECUTE grant. Then check each
  -- application role effectively, which also catches inherited grants.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = procedure.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS privilege
    WHERE namespace_row.nspname = 'public'
      AND procedure.proname = 'get_platform_stats'
      AND procedure.prokind = 'f'
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'legacy platform statistics RPC remains executable by PUBLIC';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = procedure.pronamespace
    CROSS JOIN (
      VALUES ('anon'::name), ('authenticated'::name), ('service_role'::name)
    ) AS application_role(role_name)
    WHERE namespace_row.nspname = 'public'
      AND procedure.proname = 'get_platform_stats'
      AND procedure.prokind = 'f'
      AND pg_catalog.has_function_privilege(
        application_role.role_name,
        procedure.oid,
        'EXECUTE'
      )
  ) THEN
    RAISE EXCEPTION
      'legacy platform statistics RPC remains executable by an application role';
  END IF;
END;
$quarantine_legacy_platform_stats_rpc$;

NOTIFY pgrst, 'reload schema';

COMMIT;
