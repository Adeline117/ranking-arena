-- Tier-A one-phase commit guard.
--
-- A deferred constraint trigger is fired by PREPARE TRANSACTION before the
-- transaction enters the prepared state.  If two-phase commit were enabled,
-- the execution fence could therefore be checked while its lease is live and
-- the prepared transaction could be committed after that lease expires.
--
-- max_prepared_transactions is a server-start setting.  This migration both
-- requires the safe value at install time and binds every execution-guard
-- INSERT to an owner-only DEFAULT that checks the live value.  The existing
-- assertion RPC has a pinned body and an explicit INSERT column list, so its
-- only write path cannot supply or bypass this new column.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
DECLARE
  v_assert_function pg_catalog.pg_proc%ROWTYPE;
  v_assert_hash text;
  v_existing_column pg_catalog.pg_attribute%ROWTYPE;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer
       NOT BETWEEN 170000 AND 179999 THEN
    RAISE EXCEPTION 'Tier-A one-phase commit guard requires PostgreSQL 17';
  END IF;

  IF pg_catalog.current_setting('max_prepared_transactions')::integer <> 0 THEN
    RAISE EXCEPTION 'Tier-A execution requires max_prepared_transactions = 0'
      USING ERRCODE = '55000';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass(
          'arena.tier_a_execution_write_guards'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.assert_tier_a_execution_write(uuid,bigint)'
        ) IS NULL THEN
    RAISE EXCEPTION 'Tier-A one-phase commit prerequisites are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS table_row
     WHERE table_row.oid =
           'arena.tier_a_execution_write_guards'::pg_catalog.regclass
       AND table_row.relowner = 'postgres'::pg_catalog.regrole
       AND table_row.relkind = 'r'
       AND table_row.relrowsecurity
       AND NOT table_row.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'Tier-A execution guard table authority is not exact';
  END IF;

  SELECT function_row.* INTO STRICT v_assert_function
    FROM pg_catalog.pg_proc AS function_row
   WHERE function_row.oid =
         'arena.assert_tier_a_execution_write(uuid,bigint)'::pg_catalog.regprocedure;

  v_assert_hash := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(v_assert_function.prosrc, 'UTF8')
    ),
    'hex'
  );

  IF v_assert_function.proowner <> 'postgres'::pg_catalog.regrole
     OR NOT v_assert_function.prosecdef
     OR v_assert_function.prokind <> 'f'
     OR v_assert_function.provolatile <> 'v'
     OR v_assert_function.prorettype <> 'jsonb'::pg_catalog.regtype
     OR v_assert_hash <>
        '09dabe40f76d4508e595c6333889a31a1310109ceebcf45522aaaf8309f8e05d'
     OR v_assert_function.prosrc ~ '\mone_phase_commit_required\M' THEN
    RAISE EXCEPTION 'Tier-A execution assertion RPC contract drifted';
  END IF;

  SELECT attribute.* INTO v_existing_column
    FROM pg_catalog.pg_attribute AS attribute
   WHERE attribute.attrelid =
         'arena.tier_a_execution_write_guards'::pg_catalog.regclass
     AND attribute.attname = 'one_phase_commit_required'
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped;

  IF FOUND AND (
    v_existing_column.atttypid <> 'boolean'::pg_catalog.regtype
    OR v_existing_column.attidentity <> ''
    OR v_existing_column.attgenerated <> ''
  ) THEN
    RAISE EXCEPTION 'Tier-A one-phase commit guard column type drifted';
  END IF;
END
$preflight$;

-- Serialize with the postdeploy claim-enforcement migration, then take the
-- same region/source order used by claimed writers.  The ACCESS EXCLUSIVE
-- table lock waits out every in-flight guard transaction before the drain
-- check and column installation.
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'arena.tier-a-execution-claim-enforcement-install',
    0
  )
);
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'arena.ingest-worker-authority:region:local',
    0
  )
);
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'arena.ingest-worker-authority:region:vps_sg',
    0
  )
);

LOCK TABLE arena.sources IN SHARE MODE;

DO $source_locks$
DECLARE
  v_source_id smallint;
BEGIN
  FOR v_source_id IN
    SELECT source.id
      FROM arena.sources AS source
     WHERE source.status = 'active'
       AND source.fetch_region IN ('local', 'vps_sg')
     ORDER BY source.id ASC
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'arena.tier-a-execution-source:' || v_source_id::text,
        0
      )
    );
  END LOOP;
END
$source_locks$;

LOCK TABLE arena.tier_a_execution_write_guards
  IN ACCESS EXCLUSIVE MODE;

DO $drain_check$
BEGIN
  IF EXISTS (
    SELECT 1 FROM arena.tier_a_execution_write_guards
  ) THEN
    RAISE EXCEPTION 'Tier-A execution writes were not fully drained'
      USING ERRCODE = '55006';
  END IF;
END
$drain_check$;

CREATE OR REPLACE FUNCTION arena.require_tier_a_one_phase_commit()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '5s'
AS $function$
BEGIN
  IF pg_catalog.current_setting('max_prepared_transactions')::integer <> 0 THEN
    RAISE EXCEPTION 'Tier-A execution requires max_prepared_transactions = 0'
      USING ERRCODE = '55000';
  END IF;

  RETURN true;
END
$function$;

ALTER FUNCTION arena.require_tier_a_one_phase_commit()
  OWNER TO postgres;

ALTER TABLE arena.tier_a_execution_write_guards
  ADD COLUMN IF NOT EXISTS one_phase_commit_required boolean
  NOT NULL DEFAULT arena.require_tier_a_one_phase_commit();
ALTER TABLE arena.tier_a_execution_write_guards
  ALTER COLUMN one_phase_commit_required
    SET DEFAULT arena.require_tier_a_one_phase_commit(),
  ALTER COLUMN one_phase_commit_required SET NOT NULL;

-- The fixed assertion RPC is the only allowed guard writer.  Close both
-- table- and column-level grants so no runtime role can explicitly supply the
-- attestation column and bypass its DEFAULT expression.
DO $closed_guard_table_acl$
DECLARE
  v_grantee oid;
  v_role_name text;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT expanded.grantee
      FROM pg_catalog.pg_class AS table_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          table_row.relacl,
          pg_catalog.acldefault('r', table_row.relowner)
        )
      ) AS expanded
     WHERE table_row.oid =
           'arena.tier_a_execution_write_guards'::pg_catalog.regclass
       AND expanded.grantee <> table_row.relowner
  LOOP
    IF v_grantee = 0 THEN
      EXECUTE
        'REVOKE ALL PRIVILEGES ON TABLE arena.tier_a_execution_write_guards FROM PUBLIC CASCADE';
    ELSE
      SELECT role_row.rolname INTO STRICT v_role_name
        FROM pg_catalog.pg_roles AS role_row
       WHERE role_row.oid = v_grantee;
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE arena.tier_a_execution_write_guards FROM %I CASCADE',
        v_role_name
      );
    END IF;
  END LOOP;
END
$closed_guard_table_acl$;

DO $closed_guard_column_acl$
DECLARE
  v_column record;
  v_grantee oid;
  v_role_name text;
BEGIN
  FOR v_column IN
    SELECT attribute.attname, attribute.attacl
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid =
           'arena.tier_a_execution_write_guards'::pg_catalog.regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND attribute.attacl IS NOT NULL
  LOOP
    FOR v_grantee IN
      SELECT DISTINCT expanded.grantee
        FROM pg_catalog.aclexplode(v_column.attacl) AS expanded
       WHERE expanded.grantee <>
             'postgres'::pg_catalog.regrole
    LOOP
      IF v_grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES (%I) ON TABLE arena.tier_a_execution_write_guards FROM PUBLIC CASCADE',
          v_column.attname
        );
      ELSE
        SELECT role_row.rolname INTO STRICT v_role_name
          FROM pg_catalog.pg_roles AS role_row
         WHERE role_row.oid = v_grantee;
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES (%I) ON TABLE arena.tier_a_execution_write_guards FROM %I CASCADE',
          v_column.attname,
          v_role_name
        );
      END IF;
    END LOOP;
  END LOOP;
END
$closed_guard_column_acl$;

-- CREATE FUNCTION inherits ALTER DEFAULT PRIVILEGES.  Remove every actual
-- non-owner grant rather than assuming that revoking PUBLIC is sufficient.
DO $closed_helper_acl$
DECLARE
  v_grantee oid;
  v_role_name text;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT expanded.grantee
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS expanded
     WHERE function_row.oid =
           'arena.require_tier_a_one_phase_commit()'::pg_catalog.regprocedure
       AND expanded.grantee <> function_row.proowner
  LOOP
    IF v_grantee = 0 THEN
      EXECUTE
        'REVOKE ALL PRIVILEGES ON FUNCTION arena.require_tier_a_one_phase_commit() FROM PUBLIC CASCADE';
    ELSE
      SELECT role_row.rolname INTO STRICT v_role_name
        FROM pg_catalog.pg_roles AS role_row
       WHERE role_row.oid = v_grantee;
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION arena.require_tier_a_one_phase_commit() FROM %I CASCADE',
        v_role_name
      );
    END IF;
  END LOOP;
END
$closed_helper_acl$;

COMMENT ON FUNCTION arena.require_tier_a_one_phase_commit() IS
  'Owner-only DEFAULT helper that rejects every Tier-A execution guard when PostgreSQL two-phase commit is enabled.';
COMMENT ON COLUMN arena.tier_a_execution_write_guards.one_phase_commit_required IS
  'Must be populated only by the owner-only live max_prepared_transactions guard DEFAULT.';

DO $postflight$
DECLARE
  v_assert_function pg_catalog.pg_proc%ROWTYPE;
  v_assert_hash text;
BEGIN
  IF pg_catalog.current_setting('max_prepared_transactions')::integer <> 0 THEN
    RAISE EXCEPTION 'Tier-A execution requires max_prepared_transactions = 0'
      USING ERRCODE = '55000';
  END IF;

  SELECT function_row.* INTO STRICT v_assert_function
    FROM pg_catalog.pg_proc AS function_row
   WHERE function_row.oid =
         'arena.assert_tier_a_execution_write(uuid,bigint)'::pg_catalog.regprocedure;

  v_assert_hash := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(v_assert_function.prosrc, 'UTF8')
    ),
    'hex'
  );

  IF v_assert_function.proowner <> 'postgres'::pg_catalog.regrole
     OR NOT v_assert_function.prosecdef
     OR v_assert_function.prokind <> 'f'
     OR v_assert_function.provolatile <> 'v'
     OR v_assert_function.prorettype <> 'jsonb'::pg_catalog.regtype
     OR v_assert_hash <>
       '09dabe40f76d4508e595c6333889a31a1310109ceebcf45522aaaf8309f8e05d'
     OR v_assert_function.prosrc ~ '\mone_phase_commit_required\M' THEN
    RAISE EXCEPTION 'Tier-A execution assertion RPC contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS table_row
     WHERE table_row.oid =
           'arena.tier_a_execution_write_guards'::pg_catalog.regclass
       AND table_row.relowner = 'postgres'::pg_catalog.regrole
       AND table_row.relkind = 'r'
       AND table_row.relrowsecurity
       AND NOT table_row.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'Tier-A execution guard table authority is not exact';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      JOIN pg_catalog.pg_language AS language_row
        ON language_row.oid = function_row.prolang
     WHERE function_row.oid =
           'arena.require_tier_a_one_phase_commit()'::pg_catalog.regprocedure
       AND function_row.prokind = 'f'
       AND function_row.proowner = 'postgres'::pg_catalog.regrole
       AND function_row.prosecdef
       AND function_row.provolatile = 's'
       AND NOT function_row.proretset
       AND NOT function_row.proisstrict
       AND NOT function_row.proleakproof
       AND function_row.proparallel = 'u'
       AND function_row.pronargs = 0
       AND function_row.proargmodes IS NULL
       AND function_row.prorettype = 'boolean'::pg_catalog.regtype
       AND language_row.lanname = 'plpgsql'
       AND function_row.proconfig = ARRAY[
             'search_path=pg_catalog, pg_temp',
             'statement_timeout=5s'
           ]::pg_catalog.text[]
       AND pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(function_row.prosrc, 'UTF8')
             ),
             'hex'
           ) = 'd06a19a74542804b5a56ba6ecbece173e2b3c651aaca480a38abbada7945a431'
       AND NOT EXISTS (
         SELECT 1
           FROM pg_catalog.aclexplode(
             COALESCE(
               function_row.proacl,
               pg_catalog.acldefault('f', function_row.proowner)
             )
           ) AS acl_row
          WHERE acl_row.privilege_type = 'EXECUTE'
            AND acl_row.grantee <> function_row.proowner
       )
  ) THEN
    RAISE EXCEPTION 'Tier-A one-phase commit helper contract drifted';
  END IF;

  IF pg_catalog.has_function_privilege(
       'service_role',
       'arena.require_tier_a_one_phase_commit()',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon',
       'arena.require_tier_a_one_phase_commit()',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'arena.require_tier_a_one_phase_commit()',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Tier-A one-phase commit helper ACL is not owner-only';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS table_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          table_row.relacl,
          pg_catalog.acldefault('r', table_row.relowner)
        )
      ) AS acl_row
     WHERE table_row.oid =
           'arena.tier_a_execution_write_guards'::pg_catalog.regclass
       AND acl_row.grantee <> table_row.relowner
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_row
     WHERE attribute.attrelid =
           'arena.tier_a_execution_write_guards'::pg_catalog.regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND attribute.attacl IS NOT NULL
       AND acl_row.grantee <> 'postgres'::pg_catalog.regrole
  ) THEN
    RAISE EXCEPTION 'Tier-A one-phase commit guard ACL is not owner-only';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_attrdef AS default_row
        ON default_row.adrelid = attribute.attrelid
       AND default_row.adnum = attribute.attnum
     WHERE attribute.attrelid =
           'arena.tier_a_execution_write_guards'::pg_catalog.regclass
       AND attribute.attname = 'one_phase_commit_required'
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND attribute.atttypid = 'boolean'::pg_catalog.regtype
       AND attribute.attnotnull
       AND attribute.attidentity = ''
       AND attribute.attgenerated = ''
       AND pg_catalog.pg_get_expr(
             default_row.adbin,
             default_row.adrelid,
             true
           ) = 'arena.require_tier_a_one_phase_commit()'
  ) THEN
    RAISE EXCEPTION 'Tier-A one-phase commit guard column contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1 FROM arena.tier_a_execution_write_guards
  ) THEN
    RAISE EXCEPTION 'Tier-A execution guard survived one-phase installation';
  END IF;
END
$postflight$;

COMMIT;
