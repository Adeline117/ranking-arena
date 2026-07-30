-- Primary selection writes the same ownership/profile projections as claim
-- activation and revocation. It must enter through the shared account
-- lifecycle lock before taking the linked-trader namespace, otherwise a
-- concurrent activation can form a profile <-> linked advisory deadlock.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('primary-trader-account-lifecycle-authority@1', 0)
);

DO $preflight$
DECLARE
  v_role text;
  v_function_definition text;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.to_regprocedure('auth.role()') IS NULL THEN
    RAISE EXCEPTION
      'primary trader account lifecycle authority requires PostgreSQL 17 and auth.role()';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'postgres',
    'anon',
    'authenticated',
    'service_role',
    'authenticator'
  ]::text[]
  LOOP
    IF pg_catalog.to_regrole(v_role) IS NULL THEN
      RAISE EXCEPTION 'required primary-trader role is unavailable: %', v_role;
    END IF;
  END LOOP;

  IF pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.user_linked_traders') IS NULL
     OR pg_catalog.to_regclass('public.verified_traders') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.set_primary_linked_trader(uuid,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.lock_trader_claim_principals_internal(uuid[],boolean)'
     ) IS NULL THEN
    RAISE EXCEPTION 'primary trader account lifecycle foundations are incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('user_profiles', 'id', 'uuid'::pg_catalog.regtype, true),
        ('user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype, false),
        ('user_profiles', 'banned_at', 'timestamptz'::pg_catalog.regtype, false),
        ('user_profiles', 'is_banned', 'boolean'::pg_catalog.regtype, true),
        ('user_profiles', 'ban_expires_at', 'timestamptz'::pg_catalog.regtype, false),
        ('user_linked_traders', 'id', 'uuid'::pg_catalog.regtype, true),
        ('user_linked_traders', 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('verified_traders', 'user_id', 'uuid'::pg_catalog.regtype, true)
    ) AS required_column(relation_name, column_name, type_oid, required_not_null)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = pg_catalog.to_regclass(
        'public.' || required_column.relation_name
      )
     AND attribute.attname = required_column.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
       OR attribute.atttypid <> required_column.type_oid
       OR (
         required_column.required_not_null
         AND NOT attribute.attnotnull
       )
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'auth.users'::pg_catalog.regclass
      AND attribute.attname = 'id'
      AND attribute.atttypid = 'uuid'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'primary trader account lifecycle column contract drifted';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(
           pg_catalog.to_regprocedure(
             'public.set_primary_linked_trader(uuid,uuid)'
           )
         )
  INTO v_function_definition;

  IF pg_catalog.strpos(v_function_definition, 'linked-trader:') = 0
     OR pg_catalog.strpos(v_function_definition, 'FOR UPDATE') = 0
     OR pg_catalog.strpos(v_function_definition, 'UPDATE public.user_profiles') = 0
     OR pg_catalog.strpos(v_function_definition, 'linked-trader:')
          > pg_catalog.strpos(v_function_definition, 'FOR UPDATE')
     OR pg_catalog.strpos(v_function_definition, 'FOR UPDATE')
          > pg_catalog.strpos(v_function_definition, 'UPDATE public.user_profiles') THEN
    RAISE EXCEPTION 'primary trader linked/profile lock foundation drifted';
  END IF;

  IF pg_catalog.to_regprocedure(
       'public.set_primary_linked_trader_without_account_lifecycle_internal(uuid,uuid)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected pre-existing primary trader lifecycle internal';
  END IF;
END
$preflight$;

ALTER FUNCTION public.set_primary_linked_trader(uuid, uuid)
  RENAME TO set_primary_linked_trader_without_account_lifecycle_internal;
ALTER FUNCTION
  public.set_primary_linked_trader_without_account_lifecycle_internal(uuid, uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.set_primary_linked_trader_without_account_lifecycle_internal(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE FUNCTION public.set_primary_linked_trader(
  p_user_id uuid,
  p_link_id uuid
)
RETURNS public.user_linked_traders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '20s'
AS $function$
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_user_id IS NULL OR p_link_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'user id and linked trader id are required';
  END IF;

  -- Selecting a primary is an authority-increasing mutation. Require the
  -- authenticated owner to remain active after waiting on any delete/ban.
  PERFORM public.lock_trader_claim_principals_internal(
    ARRAY[p_user_id]::uuid[],
    true
  );

  RETURN public.set_primary_linked_trader_without_account_lifecycle_internal(
    p_user_id,
    p_link_id
  );
END
$function$;

ALTER FUNCTION public.set_primary_linked_trader(uuid, uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_primary_linked_trader(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.set_primary_linked_trader(uuid, uuid)
  TO service_role;

COMMENT ON FUNCTION public.set_primary_linked_trader(uuid, uuid) IS
  'Service-only active-account primary switch. Locks account admission, Auth, and profile before the canonical linked-trader projection transaction.';
COMMENT ON FUNCTION
  public.set_primary_linked_trader_without_account_lifecycle_internal(uuid, uuid)
  IS 'Non-executable internal canonical primary projection implementation; invoked only while its public wrapper holds account lifecycle locks.';

DO $postflight$
DECLARE
  v_public_function oid := pg_catalog.to_regprocedure(
    'public.set_primary_linked_trader(uuid,uuid)'
  );
  v_internal_function oid := pg_catalog.to_regprocedure(
    'public.set_primary_linked_trader_without_account_lifecycle_internal(uuid,uuid)'
  );
BEGIN
  IF v_public_function IS NULL
     OR v_internal_function IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = v_public_function
         AND function_row.proowner = pg_catalog.to_regrole('postgres')
         AND function_row.prosecdef
         AND function_row.provolatile = 'v'
         AND function_row.prorettype =
               'public.user_linked_traders'::pg_catalog.regtype
         AND function_row.proconfig @> ARRAY[
           'search_path=pg_catalog, pg_temp',
           'row_security=off',
           'lock_timeout=5s',
           'statement_timeout=20s'
         ]::text[]
     ) THEN
    RAISE EXCEPTION 'primary trader public boundary contract drifted';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role', v_public_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_public_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_public_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticator', v_public_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role', v_internal_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_internal_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_internal_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticator', v_internal_function, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'primary trader lifecycle ACL contract drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
