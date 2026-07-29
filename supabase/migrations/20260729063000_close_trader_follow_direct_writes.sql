-- Postdeploy cutover: every application writer now uses
-- mutate_trader_follow_atomic. Close browser and service-role table DML so the
-- serialized Free/Pro limit cannot be bypassed by an old direct client.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('atomic-trader-follow-limit-migration', 0)
);

DO $preflight$
DECLARE
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_function oid := pg_catalog.to_regprocedure(
    'public.mutate_trader_follow_atomic(uuid,text,text,text,boolean,integer,integer)'
  );
BEGIN
  IF v_postgres IS NULL
    OR pg_catalog.to_regrole('service_role') IS NULL
    OR pg_catalog.to_regrole('anon') IS NULL
    OR pg_catalog.to_regrole('authenticated') IS NULL
    OR pg_catalog.to_regrole('authenticator') IS NULL
    OR pg_catalog.to_regclass('public.trader_follows') IS NULL
    OR v_function IS NULL
  THEN
    RAISE EXCEPTION 'trader follow direct-write cutover dependencies are unavailable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_function
      AND procedure.proowner = v_postgres
      AND procedure.prosecdef
      AND procedure.provolatile = 'v'
      AND procedure.prokind = 'f'
      AND procedure.prorettype = 'jsonb'::pg_catalog.regtype
      AND procedure.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'row_security=off',
        'lock_timeout=5s'
      ]::text[]
  ) THEN
    RAISE EXCEPTION 'atomic trader follow authority metadata is incompatible';
  END IF;
END
$preflight$;

LOCK TABLE public.trader_follows IN ACCESS EXCLUSIVE MODE;

DROP POLICY IF EXISTS "Service manage trader_follows"
  ON public.trader_follows;
DROP POLICY IF EXISTS "Users can follow traders"
  ON public.trader_follows;
DROP POLICY IF EXISTS "Users can unfollow traders"
  ON public.trader_follows;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON TABLE public.trader_follows
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

DO $postflight$
DECLARE
  v_role name;
BEGIN
  FOREACH v_role IN ARRAY ARRAY[
    'anon'::name,
    'authenticated'::name,
    'authenticator'::name,
    'service_role'::name
  ]
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(
        ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']::text[]
      ) AS privilege_name(value)
      WHERE pg_catalog.has_table_privilege(
        v_role,
        'public.trader_follows',
        privilege_name.value
      )
    ) THEN
      RAISE EXCEPTION
        'trader follow direct table mutation remains open to %',
        v_role;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.trader_follows'::pg_catalog.regclass
      AND policy.polcmd IN ('*', 'a', 'w', 'd')
  ) THEN
    RAISE EXCEPTION 'trader follow write policy survived authority cutover';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.mutate_trader_follow_atomic(uuid,text,text,text,boolean,integer,integer)',
    'EXECUTE'
  )
    OR pg_catalog.has_function_privilege(
      'authenticated',
      'public.mutate_trader_follow_atomic(uuid,text,text,text,boolean,integer,integer)',
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION 'atomic trader follow EXECUTE boundary drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
