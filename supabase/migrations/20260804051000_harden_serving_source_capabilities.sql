-- Keep the materialized capability payload for performance, but make the live
-- source lifecycle row the final public authority. A demotion must take effect
-- immediately rather than waiting for the 30-minute materialized-view refresh.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.mv_source_capabilities') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.arena_source_capabilities()'
     ) IS NULL THEN
    RAISE EXCEPTION 'source capability foundations are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'arena.sources'::pg_catalog.regclass
      AND attribute.attname = 'status'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'arena.sources'::pg_catalog.regclass
      AND attribute.attname = 'serving_mode'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'source status and serving_mode are required capability boundaries';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'capability execution roles are missing';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.arena_source_capabilities()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(
    pg_catalog.jsonb_object_agg(
      capability.slug,
      capability.cap || pg_catalog.jsonb_build_object(
        'servingMode', source_row.serving_mode
      )
    ),
    '{}'::pg_catalog.jsonb
  )
  FROM arena.mv_source_capabilities AS capability
  JOIN arena.sources AS source_row
    ON source_row.slug = capability.slug
  WHERE source_row.status = 'active'
    AND source_row.serving_mode = 'serving';
$function$;

ALTER FUNCTION public.arena_source_capabilities()
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.arena_source_capabilities()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_source_capabilities()
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.arena_source_capabilities() IS
  'Returns materialized source capabilities only after a live active-serving lifecycle check.';

DO $postflight$
DECLARE
  capability_function oid := pg_catalog.to_regprocedure(
    'public.arena_source_capabilities()'
  );
  function_row pg_catalog.pg_proc%ROWTYPE;
  function_definition text;
BEGIN
  SELECT procedure.*
  INTO STRICT function_row
  FROM pg_catalog.pg_proc AS procedure
  WHERE procedure.oid = capability_function;

  function_definition := pg_catalog.pg_get_functiondef(capability_function);

  IF function_row.proowner <> 'postgres'::pg_catalog.regrole
     OR NOT function_row.prosecdef
     OR function_row.provolatile <> 's'
     OR function_row.proconfig IS DISTINCT FROM ARRAY[
       'search_path=pg_catalog, pg_temp'
     ]::text[]
     OR pg_catalog.strpos(
       function_definition,
       'source_row.status = ''active'''
     ) = 0
     OR pg_catalog.strpos(
       function_definition,
       'source_row.serving_mode = ''serving'''
     ) = 0
     OR NOT pg_catalog.has_function_privilege(
       'anon', capability_function, 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'authenticated', capability_function, 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role', capability_function, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'active-serving capability boundary postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS privilege
    WHERE privilege.privilege_type = 'EXECUTE'
      AND (
        privilege.is_grantable
        OR privilege.grantee = 0::oid
        OR privilege.grantee <> ALL (
          ARRAY[
            function_row.proowner,
            'anon'::pg_catalog.regrole::oid,
            'authenticated'::pg_catalog.regrole::oid,
            'service_role'::pg_catalog.regrole::oid
          ]::oid[]
        )
      )
  ) THEN
    RAISE EXCEPTION 'source capability function ACL drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
