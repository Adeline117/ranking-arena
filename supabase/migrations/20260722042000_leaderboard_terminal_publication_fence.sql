-- Migration: 20260722042000_leaderboard_terminal_publication_fence.sql
-- Created: 2026-07-22T04:20:00Z
-- Description: Serialize every newly committed leaderboard acquisition
--   terminal with the publisher for the same source/window. The publisher
--   takes the same advisory transaction lock before deciding which terminal
--   is authoritative; therefore an older complete outcome cannot race past a
--   newer partial, unknown, failed, or abandoned outcome.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
DECLARE
  v_start regprocedure := pg_catalog.to_regprocedure(
    'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'
  );
  v_reject regprocedure := pg_catalog.to_regprocedure(
    'arena.reject_direct_leaderboard_acquisition_mutation()'
  );
BEGIN
  IF pg_catalog.to_regclass('arena.leaderboard_acquisition_attempts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_outcomes') IS NULL
     OR v_start IS NULL
     OR v_reject IS NULL THEN
    RAISE EXCEPTION 'leaderboard terminal publication fence foundations are missing';
  END IF;

  IF pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL THEN
    RAISE EXCEPTION 'PostgREST API roles are missing';
  END IF;

  IF pg_catalog.to_regprocedure(
       'arena.serialize_leaderboard_terminal_publication()'
     ) IS NOT NULL
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid =
              'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
          AND trigger_row.tgname =
              'leaderboard_acquisition_outcomes_serialize_terminal_publication'
          AND NOT trigger_row.tgisinternal
     ) THEN
    RAISE EXCEPTION 'leaderboard terminal publication fence already exists';
  END IF;

  -- PostgreSQL fires same-kind triggers in name order. The direct-mutation
  -- guard must reject an unauthorized insert before the serializer can wait
  -- on a lock chosen by attacker-controlled NEW values.
  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid =
              'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
          AND trigger_row.tgname =
              'leaderboard_acquisition_outcomes_reject_direct_row_mutation'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgenabled = 'O'
          AND trigger_row.tgtype = 31
          AND trigger_row.tgfoid = v_reject
     )
     OR 'leaderboard_acquisition_outcomes_reject_direct_row_mutation'
        >= 'leaderboard_acquisition_outcomes_serialize_terminal_publication' THEN
    RAISE EXCEPTION 'leaderboard outcome direct-mutation guard is missing or unordered';
  END IF;

  IF pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(v_start),
       '''arena.leaderboard-acquisition-source:'''
     ) = 0
     OR pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(v_start),
       'p_source_id::text || '':'' || p_timeframe::text'
     ) = 0 THEN
    RAISE EXCEPTION 'leaderboard acquisition begin lock contract drifted';
  END IF;
END
$preflight$;

CREATE FUNCTION arena.serialize_leaderboard_terminal_publication()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_source_id smallint;
  v_timeframe smallint;
BEGIN
  SELECT attempt.source_id, attempt.timeframe
    INTO STRICT v_source_id, v_timeframe
    FROM arena.leaderboard_acquisition_attempts AS attempt
   WHERE attempt.attempt_seq = NEW.attempt_seq;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena.leaderboard-acquisition-source:'
      || v_source_id::text || ':' || v_timeframe::text,
      0
    )
  );

  RETURN NEW;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'leaderboard acquisition parent attempt does not exist'
      USING ERRCODE = '23503';
END
$function$;

ALTER FUNCTION arena.serialize_leaderboard_terminal_publication()
  OWNER TO postgres;

REVOKE ALL
  ON FUNCTION arena.serialize_leaderboard_terminal_publication()
  FROM PUBLIC, anon, authenticated, service_role;

-- Remove hostile ALTER DEFAULT PRIVILEGES grants as well. A trigger does not
-- need caller EXECUTE privilege, so the function remains owner-only.
DO $owner_only_acl$
DECLARE
  v_role record;
BEGIN
  FOR v_role IN
    SELECT DISTINCT pg_catalog.pg_get_userbyid(privilege_row.grantee) AS role_name
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS privilege_row
     WHERE function_row.oid = pg_catalog.to_regprocedure(
             'arena.serialize_leaderboard_terminal_publication()'
           )
       AND privilege_row.privilege_type = 'EXECUTE'
       AND privilege_row.grantee NOT IN (0, function_row.proowner)
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION arena.serialize_leaderboard_terminal_publication() FROM %I',
      v_role.role_name
    );
  END LOOP;
END
$owner_only_acl$;

CREATE TRIGGER leaderboard_acquisition_outcomes_serialize_terminal_publication
BEFORE INSERT ON arena.leaderboard_acquisition_outcomes
FOR EACH ROW
EXECUTE FUNCTION arena.serialize_leaderboard_terminal_publication();

COMMENT ON FUNCTION arena.serialize_leaderboard_terminal_publication() IS
  'Private BEFORE INSERT serializer. It derives source/window from the immutable parent attempt and takes the same transaction lock as acquisition begin and trusted publication.';

DO $postflight$
DECLARE
  v_function oid := pg_catalog.to_regprocedure(
    'arena.serialize_leaderboard_terminal_publication()'
  );
  v_postgres oid := pg_catalog.to_regrole('postgres');
BEGIN
  IF v_function IS NULL THEN
    RAISE EXCEPTION 'leaderboard terminal publication serializer is missing';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid = v_function
          AND function_row.proowner = v_postgres
          AND function_row.prosecdef
          AND function_row.provolatile = 'v'
          AND function_row.prorettype = 'trigger'::pg_catalog.regtype
          AND function_row.proconfig @> ARRAY[
                'search_path=pg_catalog, pg_temp'
              ]::text[]
          AND pg_catalog.strpos(
                function_row.prosrc,
                'FROM arena.leaderboard_acquisition_attempts AS attempt'
              ) > 0
          AND pg_catalog.strpos(
                function_row.prosrc,
                '''arena.leaderboard-acquisition-source:'''
              ) > 0
          AND pg_catalog.strpos(
                function_row.prosrc,
                'pg_catalog.pg_advisory_xact_lock'
              ) > 0
     ) THEN
    RAISE EXCEPTION 'leaderboard terminal publication function contract drifted';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid =
              'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
          AND trigger_row.tgname =
              'leaderboard_acquisition_outcomes_serialize_terminal_publication'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgenabled = 'O'
          AND trigger_row.tgtype = 7
          AND trigger_row.tgattr = ''::pg_catalog.int2vector
          AND trigger_row.tgqual IS NULL
          AND trigger_row.tgconstraint = 0
          AND NOT trigger_row.tgdeferrable
          AND NOT trigger_row.tginitdeferred
          AND trigger_row.tgnargs = 0
          AND pg_catalog.octet_length(trigger_row.tgargs) = 0
          AND trigger_row.tgfoid = v_function
     ) THEN
    RAISE EXCEPTION 'leaderboard terminal publication trigger contract drifted';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger AS reject_trigger
         JOIN pg_catalog.pg_trigger AS serialize_trigger
           ON serialize_trigger.tgrelid = reject_trigger.tgrelid
        WHERE reject_trigger.tgrelid =
              'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
          AND reject_trigger.tgname =
              'leaderboard_acquisition_outcomes_reject_direct_row_mutation'
          AND serialize_trigger.tgname =
              'leaderboard_acquisition_outcomes_serialize_terminal_publication'
          AND reject_trigger.tgname < serialize_trigger.tgname
     ) THEN
    RAISE EXCEPTION 'leaderboard outcome triggers are not ordered fail-closed';
  END IF;

  IF pg_catalog.has_function_privilege(
       'anon',
       'arena.serialize_leaderboard_terminal_publication()',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'arena.serialize_leaderboard_terminal_publication()',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       'arena.serialize_leaderboard_terminal_publication()',
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             function_row.proacl,
             pg_catalog.acldefault('f', function_row.proowner)
           )
         ) AS privilege_row
        WHERE function_row.oid = v_function
          AND privilege_row.privilege_type = 'EXECUTE'
          AND privilege_row.grantee <> function_row.proowner
     ) THEN
    RAISE EXCEPTION 'leaderboard terminal publication function ACL is unsafe';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
