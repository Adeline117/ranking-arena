-- Retire the legacy @1 position-history publication writer.
--
-- The retained writer proves terminal acquisition evidence only. It cannot
-- prove parser/source-fact conservation, so no application role may execute
-- it after the @2 acquisition substrate exists. Keep its OID/signature and
-- receipt chain for audit, while replacing the callable body with an
-- unconditional retired stub. The original body remains immutable in the
-- preceding migration. Reject every typed INSERT/UPDATE until the versioned
-- parser writer exists, while preserving cleanup of existing legacy rows.
-- Keep the independently attested checkpoint reader available to service_role.
-- This migration
-- converges arbitrary delegated function ACLs instead of assuming that only
-- the four standard roles exist.
--
-- Operators must deploy the RAW-only worker and drain legacy calls before this
-- cutover. REVOKE prevents new calls; it cannot cancel a transaction that has
-- already entered the function.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    '20260804-retire-legacy-position-history-publisher',
    0
  )
);

-- Drain every current parent/partition writer before attesting and replacing
-- the trigger function. Without the recursive lock, a direct child-table write
-- could still enter the old guard during the cutover transaction.
LOCK TABLE arena.position_history IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_writer pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'arena.publish_verified_position_history(bigint,bigint,timestamp with time zone,jsonb,text,text)'
  );
  v_checkpoint pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'arena.get_position_history_publication_checkpoint(smallint,bigint)'
  );
  v_chain pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'arena.position_history_publication_chain_healthy(bigint,smallint,bigint)'
  );
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR v_writer IS NULL
     OR v_checkpoint IS NULL
     OR v_chain IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.protect_verified_position_history_row()'
        ) IS NULL THEN
    RAISE EXCEPTION
      'legacy position-history publisher retirement prerequisites are missing';
  END IF;

  IF (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_namespace AS namespace_row
         ON namespace_row.oid = function_row.pronamespace
       WHERE namespace_row.nspname = 'arena'
         AND function_row.proname = 'publish_verified_position_history'
     ) <> 1 THEN
    RAISE EXCEPTION
      'legacy position-history writer overload set is not exact';
  END IF;

  IF (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_namespace AS namespace_row
         ON namespace_row.oid = function_row.pronamespace
       WHERE namespace_row.nspname = 'arena'
         AND function_row.proname =
             'get_position_history_publication_checkpoint'
     ) <> 1 THEN
    RAISE EXCEPTION
      'position-history checkpoint overload set is not exact';
  END IF;

  IF (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_namespace AS namespace_row
         ON namespace_row.oid = function_row.pronamespace
       WHERE namespace_row.nspname = 'arena'
         AND function_row.proname =
             'position_history_publication_chain_healthy'
     ) <> 1 THEN
    RAISE EXCEPTION
      'position-history chain guard overload set is not exact';
  END IF;

  -- has_function_privilege does not expose PG17 SET-only membership paths.
  -- Reject every direct or transitive application-role membership in any
  -- superuser role before relying on an owner-only postflight.
  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('service_role'::pg_catalog.regrole),
        ('anon'::pg_catalog.regrole),
        ('authenticated'::pg_catalog.regrole)
    ) AS application_role(role_oid)
    CROSS JOIN pg_catalog.pg_roles AS privileged_role
    WHERE (
        privileged_role.rolsuper
        OR privileged_role.oid = 'postgres'::pg_catalog.regrole
      )
      AND pg_catalog.pg_has_role(
        application_role.role_oid,
        privileged_role.oid,
        'MEMBER'
      )
  ) THEN
    RAISE EXCEPTION
      'application role can assume a superuser or owner role';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('anon'::pg_catalog.regrole),
        ('authenticated'::pg_catalog.regrole)
    ) AS public_role(role_oid)
    WHERE pg_catalog.pg_has_role(
      public_role.role_oid,
      'service_role'::pg_catalog.regrole,
      'MEMBER'
    )
  ) THEN
    RAISE EXCEPTION
      'public application role can assume service_role';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = v_writer
         AND function_row.prokind = 'f'
         AND function_row.proowner = 'postgres'::pg_catalog.regrole
         AND NOT function_row.proretset
         AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
         AND function_row.pronargdefaults = 0
         AND function_row.proargnames = ARRAY[
           'p_raw_object_id',
           'p_previous_publication_id',
           'p_effective_cursor_after',
           'p_rows',
           'p_lane',
           'p_publisher_contract'
         ]::text[]
     ) THEN
    RAISE EXCEPTION
      'legacy position-history writer metadata drifted before retirement';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid =
             'arena.protect_verified_position_history_row()'::pg_catalog.regprocedure
         AND function_row.prokind = 'f'
         AND function_row.proowner = 'postgres'::pg_catalog.regrole
         AND function_row.prolang = (
           SELECT language_row.oid
           FROM pg_catalog.pg_language AS language_row
           WHERE language_row.lanname = 'plpgsql'
         )
         AND NOT function_row.prosecdef
         AND NOT function_row.proleakproof
         AND NOT function_row.proretset
         AND NOT function_row.proisstrict
         AND function_row.provolatile = 'v'
         AND function_row.proparallel = 'u'
         AND function_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
         AND function_row.pronargdefaults = 0
         AND pg_catalog.array_length(function_row.proconfig, 1) = 1
         AND function_row.proconfig @>
             ARRAY['search_path=pg_catalog, pg_temp']::text[]
         AND pg_catalog.encode(
           pg_catalog.sha256(
             pg_catalog.convert_to(function_row.prosrc, 'UTF8')
           ),
           'hex'
         ) IN (
           '59b3e439b972265f4a3c13951f6592db50d9a3411fc2fe63f1968b56292d6576',
           '727b58f09c7eb9bb241c39720e011fcfb1a1b2805aca5b8d75575c2380aebc36'
         )
     ) THEN
    RAISE EXCEPTION
      'position-history row guard identity drifted before retirement';
  END IF;

  IF EXISTS (
    WITH RECURSIVE guarded_relation(
      relation_oid,
      parent_relation_oid
    ) AS (
      SELECT
        'arena.position_history'::pg_catalog.regclass,
        NULL::oid
      UNION ALL
      SELECT
        inheritance.inhrelid,
        inheritance.inhparent
      FROM pg_catalog.pg_inherits AS inheritance
      JOIN guarded_relation AS parent_relation
        ON parent_relation.relation_oid = inheritance.inhparent
    ),
    expected_trigger AS (
      SELECT
        guarded_relation.relation_oid,
        guarded_relation.parent_relation_oid,
        'protect_verified_position_history_before_write'::text AS trigger_name,
        31::smallint AS trigger_type
      FROM guarded_relation
      UNION ALL
      SELECT
        guarded_relation.relation_oid,
        guarded_relation.parent_relation_oid,
        'protect_verified_position_history_before_truncate'::text,
        34::smallint
      FROM guarded_relation
      WHERE guarded_relation.parent_relation_oid IS NULL
    )
    SELECT 1
    FROM expected_trigger
    LEFT JOIN pg_catalog.pg_trigger AS trigger_row
      ON trigger_row.tgrelid = expected_trigger.relation_oid
     AND trigger_row.tgname = expected_trigger.trigger_name
    LEFT JOIN pg_catalog.pg_trigger AS parent_trigger
      ON parent_trigger.tgrelid = expected_trigger.parent_relation_oid
     AND parent_trigger.tgname = expected_trigger.trigger_name
    WHERE trigger_row.oid IS NULL
       OR trigger_row.tgisinternal
       OR trigger_row.tgfoid <>
            'arena.protect_verified_position_history_row()'::pg_catalog.regprocedure
       OR trigger_row.tgenabled <> 'O'
       OR trigger_row.tgtype <> expected_trigger.trigger_type
       OR (
         expected_trigger.parent_relation_oid IS NULL
         AND trigger_row.tgparentid <> 0
       )
       OR (
         expected_trigger.parent_relation_oid IS NOT NULL
         AND trigger_row.tgparentid IS DISTINCT FROM parent_trigger.oid
       )
  ) THEN
    RAISE EXCEPTION
      'position-history guard trigger identity drifted before retirement';
  END IF;

  -- The checkpoint delegates chain validation to this invoker function. Its
  -- exact body is part of the trusted reader boundary; preserving an already
  -- drifted definition would otherwise bless a `SELECT true` chain bypass.
  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = v_chain
         AND function_row.prokind = 'f'
         AND function_row.proowner = 'postgres'::pg_catalog.regrole
         AND function_row.prolang = (
           SELECT language_row.oid
           FROM pg_catalog.pg_language AS language_row
           WHERE language_row.lanname = 'sql'
         )
         AND NOT function_row.prosecdef
         AND NOT function_row.proleakproof
         AND NOT function_row.proretset
         AND NOT function_row.proisstrict
         AND function_row.provolatile = 's'
         AND function_row.proparallel = 'u'
         AND function_row.prorettype = 'pg_catalog.bool'::pg_catalog.regtype
         AND function_row.pronargdefaults = 0
         AND function_row.proargnames = ARRAY[
           'p_root_publication_id',
           'p_source_id',
           'p_trader_id'
         ]::text[]
         AND pg_catalog.array_length(function_row.proconfig, 1) = 3
         AND function_row.proconfig @> ARRAY[
           'search_path=pg_catalog, pg_temp',
           'statement_timeout=10s',
           'TimeZone=UTC'
         ]::text[]
         AND pg_catalog.encode(
           pg_catalog.sha256(
             pg_catalog.convert_to(function_row.prosrc, 'UTF8')
           ),
           'hex'
         ) = 'ca6613267ec9e4b6fe8dbc579e2f49bc24e6918181fc9a844658882963383d67'
         AND pg_catalog.strpos(
           function_row.prosrc,
           'WITH RECURSIVE publication_chain AS'
         ) > 0
         AND pg_catalog.strpos(
           function_row.prosrc,
           'LEFT JOIN arena.raw_objects AS raw_object'
         ) > 0
     ) THEN
    RAISE EXCEPTION
      'position-history chain guard identity drifted before checkpoint grant';
  END IF;

  -- Re-granting a SECURITY DEFINER checkpoint is safe only when its exact
  -- trusted body and dependency are still installed. Unlike the writer,
  -- reader drift must block the migration rather than be blessed by ACL
  -- normalization.
  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = v_checkpoint
         AND function_row.prokind = 'f'
         AND function_row.proowner = 'postgres'::pg_catalog.regrole
         AND function_row.prolang = (
           SELECT language_row.oid
           FROM pg_catalog.pg_language AS language_row
           WHERE language_row.lanname = 'plpgsql'
         )
         AND function_row.prosecdef
         AND NOT function_row.proleakproof
         AND NOT function_row.proretset
         AND NOT function_row.proisstrict
         AND function_row.provolatile = 's'
         AND function_row.proparallel = 'u'
         AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
         AND function_row.pronargdefaults = 0
         AND function_row.proargnames = ARRAY[
           'p_source_id',
           'p_trader_id'
         ]::text[]
         AND pg_catalog.array_length(function_row.proconfig, 1) = 3
         AND function_row.proconfig @> ARRAY[
           'search_path=pg_catalog, pg_temp',
           'statement_timeout=10s',
           'TimeZone=UTC'
         ]::text[]
         AND pg_catalog.encode(
           pg_catalog.sha256(
             pg_catalog.convert_to(function_row.prosrc, 'UTF8')
           ),
           'hex'
         ) = '440b079edbb8e8c45b60fc9032eec54cd6a3a220f2fa1847ae222c4844250ff0'
         AND pg_catalog.strpos(
           function_row.prosrc,
           'FROM arena.record_surface_publications AS publication'
         ) > 0
         AND pg_catalog.strpos(
           function_row.prosrc,
           'arena.position_history_publication_chain_healthy('
         ) > 0
         AND pg_catalog.strpos(function_row.prosrc, 'arena.ingest_cursors') = 0
     ) THEN
    RAISE EXCEPTION
      'position-history checkpoint identity drifted before ACL normalization';
  END IF;

END
$preflight$;

CREATE TEMP TABLE legacy_position_history_retirement_functions
ON COMMIT DROP
AS
SELECT
  function_row.oid,
  CASE
    WHEN function_row.oid IN (
      'arena.publish_verified_position_history(bigint,bigint,timestamp with time zone,jsonb,text,text)'::pg_catalog.regprocedure,
      'arena.protect_verified_position_history_row()'::pg_catalog.regprocedure
    )
      THEN NULL::text
    ELSE pg_catalog.pg_get_functiondef(function_row.oid)
  END AS preserved_definition
FROM pg_catalog.pg_proc AS function_row
WHERE function_row.oid IN (
  'arena.publish_verified_position_history(bigint,bigint,timestamp with time zone,jsonb,text,text)'::pg_catalog.regprocedure,
  'arena.get_position_history_publication_checkpoint(smallint,bigint)'::pg_catalog.regprocedure,
  'arena.position_history_publication_chain_healthy(bigint,smallint,bigint)'::pg_catalog.regprocedure,
  'arena.protect_verified_position_history_row()'::pg_catalog.regprocedure
);

CREATE TEMP TABLE legacy_position_history_retirement_relations
ON COMMIT DROP
AS
WITH RECURSIVE guarded_relation(
  relation_oid,
  parent_relation_oid
) AS (
  SELECT
    'arena.position_history'::pg_catalog.regclass,
    NULL::oid
  UNION ALL
  SELECT
    inheritance.inhrelid,
    inheritance.inhparent
  FROM pg_catalog.pg_inherits AS inheritance
  JOIN guarded_relation AS parent_relation
    ON parent_relation.relation_oid = inheritance.inhparent
)
SELECT relation_oid, parent_relation_oid
FROM guarded_relation;

CREATE TEMP TABLE legacy_position_history_retirement_triggers
ON COMMIT DROP
AS
SELECT
  trigger_row.oid,
  trigger_row.tgname,
  trigger_row.tgfoid,
  trigger_row.tgrelid,
  trigger_row.tgtype,
  trigger_row.tgenabled,
  trigger_row.tgparentid
FROM pg_catalog.pg_trigger AS trigger_row
JOIN pg_temp.legacy_position_history_retirement_relations AS guarded_relation
  ON guarded_relation.relation_oid = trigger_row.tgrelid
WHERE trigger_row.tgname IN (
    'protect_verified_position_history_before_write',
    'protect_verified_position_history_before_truncate'
  )
  AND NOT trigger_row.tgisinternal;

DO $snapshot_preflight$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_temp.legacy_position_history_retirement_functions) <> 4
     OR (SELECT pg_catalog.count(*) FROM pg_temp.legacy_position_history_retirement_relations) < 1
     OR (SELECT pg_catalog.count(*) FROM pg_temp.legacy_position_history_retirement_triggers) <>
          1 + (
            SELECT pg_catalog.count(*)
            FROM pg_temp.legacy_position_history_retirement_relations
          ) THEN
    RAISE EXCEPTION
      'legacy position-history dependency snapshot is incomplete';
  END IF;
END
$snapshot_preflight$;

-- First collapse every direct and delegated writer grant, including PUBLIC and
-- roles unknown to this repository. CASCADE removes grants issued through a
-- grant option instead of leaving a delegated application path behind.
REVOKE ALL PRIVILEGES ON FUNCTION arena.publish_verified_position_history(
  bigint,
  bigint,
  timestamptz,
  jsonb,
  text,
  text
) FROM PUBLIC CASCADE;

DO $close_writer_acl$
DECLARE
  v_grantee oid;
  v_grantee_name text;
  v_writer pg_catalog.regprocedure :=
    'arena.publish_verified_position_history(bigint,bigint,timestamp with time zone,jsonb,text,text)'::pg_catalog.regprocedure;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT privilege.grantee
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS privilege
    WHERE function_row.oid = v_writer
      AND privilege.grantee <> 0
      AND privilege.grantee <> function_row.proowner
  LOOP
    SELECT role_row.rolname
    INTO STRICT v_grantee_name
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.oid = v_grantee;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION '
      'arena.publish_verified_position_history(bigint,bigint,timestamptz,jsonb,text,text) '
      'FROM %I CASCADE',
      v_grantee_name
    );
  END LOOP;
END
$close_writer_acl$;

REVOKE ALL PRIVILEGES ON FUNCTION arena.publish_verified_position_history(
  bigint,
  bigint,
  timestamptz,
  jsonb,
  text,
  text
) FROM anon, authenticated, service_role CASCADE;

-- ACLs alone cannot block a postgres-owned SECURITY DEFINER wrapper: the
-- wrapper executes as the owner, and PostgreSQL records no dependable
-- pg_depend edge for string-body SQL or PL/pgSQL calls. Preserve the old OID
-- and signature but make every direct, owner, and indirect call fail closed.
CREATE OR REPLACE FUNCTION arena.publish_verified_position_history(
  p_raw_object_id bigint,
  p_previous_publication_id bigint,
  p_effective_cursor_after timestamptz,
  p_rows jsonb,
  p_lane text,
  p_publisher_contract text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '10s'
SET statement_timeout = '2min'
SET TimeZone = 'UTC'
AS $function$
BEGIN
  RAISE EXCEPTION
    'legacy position-history publisher is retired; parser-conservation receipt required'
    USING ERRCODE = '55000';
END
$function$;

-- The previous guard accepted owner-controlled session state, so a postgres
-- session could forge a receipt binding. Until the versioned parser-projection
-- writer exists, there is no legitimate typed write: reject every INSERT and
-- UPDATE unconditionally. Existing NULL rows remain deletable for controlled
-- cleanup; receipt-bound rows remain immutable.
CREATE OR REPLACE FUNCTION arena.protect_verified_position_history_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'verified position-history rows cannot be truncated'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.verified_publication_id IS NOT NULL THEN
      RAISE EXCEPTION 'verified position-history rows are immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION
      'position-history insert requires parser-conservation publication authority'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'verified position-history row content is immutable'
      USING ERRCODE = '55000';
  END IF;

  RAISE EXCEPTION 'unsupported position-history write operation: %', TG_OP
    USING ERRCODE = '55000';
END
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION arena.protect_verified_position_history_row()
  FROM PUBLIC CASCADE;

DO $close_row_guard_acl$
DECLARE
  v_grantee oid;
  v_grantee_name text;
  v_row_guard pg_catalog.regprocedure :=
    'arena.protect_verified_position_history_row()'::pg_catalog.regprocedure;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT privilege.grantee
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS privilege
    WHERE function_row.oid = v_row_guard
      AND privilege.grantee <> 0
      AND privilege.grantee <> function_row.proowner
  LOOP
    SELECT role_row.rolname
    INTO STRICT v_grantee_name
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.oid = v_grantee;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION '
      'arena.protect_verified_position_history_row() FROM %I CASCADE',
      v_grantee_name
    );
  END LOOP;
END
$close_row_guard_acl$;

-- Normalize checkpoint ACLs too: this removes rogue grant options and their
-- delegates, then restores one direct, non-grantable service_role grant.
REVOKE ALL PRIVILEGES ON FUNCTION arena.get_position_history_publication_checkpoint(
  smallint,
  bigint
) FROM PUBLIC CASCADE;

DO $normalize_checkpoint_acl$
DECLARE
  v_grantee oid;
  v_grantee_name text;
  v_checkpoint pg_catalog.regprocedure :=
    'arena.get_position_history_publication_checkpoint(smallint,bigint)'::pg_catalog.regprocedure;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT privilege.grantee
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS privilege
    WHERE function_row.oid = v_checkpoint
      AND privilege.grantee <> 0
      AND privilege.grantee <> function_row.proowner
  LOOP
    SELECT role_row.rolname
    INTO STRICT v_grantee_name
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.oid = v_grantee;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION '
      'arena.get_position_history_publication_checkpoint(smallint,bigint) '
      'FROM %I CASCADE',
      v_grantee_name
    );
  END LOOP;
END
$normalize_checkpoint_acl$;

GRANT EXECUTE ON FUNCTION arena.get_position_history_publication_checkpoint(
  smallint,
  bigint
) TO service_role;

COMMENT ON FUNCTION arena.publish_verified_position_history(
  bigint,
  bigint,
  timestamptz,
  jsonb,
  text,
  text
) IS 'Retired fail-closed @1 signature retained for audit compatibility. The historical body did not prove parser/source-fact conservation.';

DO $postflight$
DECLARE
  v_writer pg_catalog.regprocedure :=
    'arena.publish_verified_position_history(bigint,bigint,timestamp with time zone,jsonb,text,text)'::pg_catalog.regprocedure;
  v_checkpoint pg_catalog.regprocedure :=
    'arena.get_position_history_publication_checkpoint(smallint,bigint)'::pg_catalog.regprocedure;
  v_chain pg_catalog.regprocedure :=
    'arena.position_history_publication_chain_healthy(bigint,smallint,bigint)'::pg_catalog.regprocedure;
  v_row_guard pg_catalog.regprocedure :=
    'arena.protect_verified_position_history_row()'::pg_catalog.regprocedure;
  v_service_role oid := 'service_role'::pg_catalog.regrole;
BEGIN
  IF (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_namespace AS namespace_row
         ON namespace_row.oid = function_row.pronamespace
       WHERE namespace_row.nspname = 'arena'
         AND function_row.proname = 'publish_verified_position_history'
     ) <> 1
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_namespace AS namespace_row
         ON namespace_row.oid = function_row.pronamespace
       WHERE namespace_row.nspname = 'arena'
         AND function_row.proname =
             'get_position_history_publication_checkpoint'
     ) <> 1
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_namespace AS namespace_row
         ON namespace_row.oid = function_row.pronamespace
       WHERE namespace_row.nspname = 'arena'
         AND function_row.proname =
             'position_history_publication_chain_healthy'
     ) <> 1
     OR EXISTS (
       SELECT 1
       FROM (
         VALUES
           ('service_role'::pg_catalog.regrole),
           ('anon'::pg_catalog.regrole),
           ('authenticated'::pg_catalog.regrole)
       ) AS application_role(role_oid)
       CROSS JOIN pg_catalog.pg_roles AS privileged_role
       WHERE (
           privileged_role.rolsuper
           OR privileged_role.oid = 'postgres'::pg_catalog.regrole
         )
         AND pg_catalog.pg_has_role(
           application_role.role_oid,
           privileged_role.oid,
           'MEMBER'
         )
     )
     OR EXISTS (
       SELECT 1
       FROM (
         VALUES
           ('anon'::pg_catalog.regrole),
           ('authenticated'::pg_catalog.regrole)
       ) AS public_role(role_oid)
       WHERE pg_catalog.pg_has_role(
         public_role.role_oid,
         v_service_role,
         'MEMBER'
       )
     )
     OR EXISTS (
       SELECT 1
       FROM pg_temp.legacy_position_history_retirement_functions AS snapshot
       LEFT JOIN pg_catalog.pg_proc AS function_row
         ON function_row.oid = snapshot.oid
       WHERE function_row.oid IS NULL
          OR (
            snapshot.preserved_definition IS NOT NULL
            AND pg_catalog.pg_get_functiondef(function_row.oid) IS DISTINCT FROM
                  snapshot.preserved_definition
          )
     )
     OR EXISTS (
       SELECT 1
       FROM pg_temp.legacy_position_history_retirement_triggers AS snapshot
       LEFT JOIN pg_catalog.pg_trigger AS trigger_row
         ON trigger_row.oid = snapshot.oid
       WHERE trigger_row.oid IS NULL
          OR trigger_row.tgname IS DISTINCT FROM snapshot.tgname
          OR trigger_row.tgfoid IS DISTINCT FROM snapshot.tgfoid
          OR trigger_row.tgrelid IS DISTINCT FROM snapshot.tgrelid
          OR trigger_row.tgtype IS DISTINCT FROM snapshot.tgtype
          OR trigger_row.tgenabled IS DISTINCT FROM snapshot.tgenabled
          OR trigger_row.tgparentid IS DISTINCT FROM snapshot.tgparentid
     )
     OR EXISTS (
       SELECT 1
       FROM (
         SELECT
           guarded_relation.relation_oid,
           guarded_relation.parent_relation_oid,
           'protect_verified_position_history_before_write'::text AS trigger_name,
           31::smallint AS trigger_type
         FROM pg_temp.legacy_position_history_retirement_relations AS guarded_relation
         UNION ALL
         SELECT
           guarded_relation.relation_oid,
           guarded_relation.parent_relation_oid,
           'protect_verified_position_history_before_truncate'::text,
           34::smallint
         FROM pg_temp.legacy_position_history_retirement_relations AS guarded_relation
         WHERE guarded_relation.parent_relation_oid IS NULL
       ) AS expected_trigger
       LEFT JOIN pg_catalog.pg_trigger AS trigger_row
         ON trigger_row.tgrelid = expected_trigger.relation_oid
        AND trigger_row.tgname = expected_trigger.trigger_name
       LEFT JOIN pg_catalog.pg_trigger AS parent_trigger
         ON parent_trigger.tgrelid = expected_trigger.parent_relation_oid
        AND parent_trigger.tgname = expected_trigger.trigger_name
       WHERE trigger_row.oid IS NULL
          OR trigger_row.tgisinternal
          OR trigger_row.tgfoid <> v_row_guard
          OR trigger_row.tgenabled <> 'O'
          OR trigger_row.tgtype <> expected_trigger.trigger_type
          OR (
            expected_trigger.parent_relation_oid IS NULL
            AND trigger_row.tgparentid <> 0
          )
          OR (
            expected_trigger.parent_relation_oid IS NOT NULL
            AND trigger_row.tgparentid IS DISTINCT FROM parent_trigger.oid
          )
     )
     OR pg_catalog.has_function_privilege(
       'service_role', v_writer, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('anon', v_writer, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', v_writer, 'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS privilege
       WHERE function_row.oid = v_writer
         AND privilege.grantee <> function_row.proowner
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = v_writer
         AND function_row.prokind = 'f'
         AND function_row.proowner = 'postgres'::pg_catalog.regrole
         AND function_row.prolang = (
           SELECT language_row.oid
           FROM pg_catalog.pg_language AS language_row
           WHERE language_row.lanname = 'plpgsql'
         )
         AND function_row.prosecdef
         AND NOT function_row.proleakproof
         AND NOT function_row.proretset
         AND NOT function_row.proisstrict
         AND function_row.provolatile = 'v'
         AND function_row.proparallel = 'u'
         AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
         AND function_row.pronargdefaults = 0
         AND function_row.proargnames = ARRAY[
           'p_raw_object_id',
           'p_previous_publication_id',
           'p_effective_cursor_after',
           'p_rows',
           'p_lane',
           'p_publisher_contract'
         ]::text[]
         AND pg_catalog.array_length(function_row.proconfig, 1) = 4
         AND function_row.proconfig @> ARRAY[
           'search_path=pg_catalog, pg_temp',
           'lock_timeout=10s',
           'statement_timeout=2min',
           'TimeZone=UTC'
         ]::text[]
         AND pg_catalog.encode(
           pg_catalog.sha256(
             pg_catalog.convert_to(function_row.prosrc, 'UTF8')
           ),
           'hex'
         ) = 'c6b9a4e5240227e308e25d2f83e08a89f2dc8c36c443ad54117aae052ab8e6a2'
         AND pg_catalog.strpos(
           function_row.prosrc,
           'legacy position-history publisher is retired; parser-conservation receipt required'
         ) > 0
         AND pg_catalog.strpos(function_row.prosrc, 'arena.raw_objects') = 0
         AND pg_catalog.strpos(function_row.prosrc, 'arena.position_history') = 0
         AND pg_catalog.strpos(function_row.prosrc, 'arena.ingest_cursors') = 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = v_chain
         AND function_row.prokind = 'f'
         AND function_row.proowner = 'postgres'::pg_catalog.regrole
         AND function_row.prolang = (
           SELECT language_row.oid
           FROM pg_catalog.pg_language AS language_row
           WHERE language_row.lanname = 'sql'
         )
         AND NOT function_row.prosecdef
         AND NOT function_row.proleakproof
         AND NOT function_row.proretset
         AND NOT function_row.proisstrict
         AND function_row.provolatile = 's'
         AND function_row.proparallel = 'u'
         AND function_row.prorettype = 'pg_catalog.bool'::pg_catalog.regtype
         AND function_row.pronargdefaults = 0
         AND function_row.proargnames = ARRAY[
           'p_root_publication_id',
           'p_source_id',
           'p_trader_id'
         ]::text[]
         AND pg_catalog.array_length(function_row.proconfig, 1) = 3
         AND function_row.proconfig @> ARRAY[
           'search_path=pg_catalog, pg_temp',
           'statement_timeout=10s',
           'TimeZone=UTC'
         ]::text[]
         AND pg_catalog.encode(
           pg_catalog.sha256(
             pg_catalog.convert_to(function_row.prosrc, 'UTF8')
           ),
           'hex'
         ) = 'ca6613267ec9e4b6fe8dbc579e2f49bc24e6918181fc9a844658882963383d67'
         AND pg_catalog.strpos(
           function_row.prosrc,
           'WITH RECURSIVE publication_chain AS'
         ) > 0
         AND pg_catalog.strpos(
           function_row.prosrc,
           'LEFT JOIN arena.raw_objects AS raw_object'
         ) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = v_row_guard
         AND function_row.prokind = 'f'
         AND function_row.proowner = 'postgres'::pg_catalog.regrole
         AND function_row.prolang = (
           SELECT language_row.oid
           FROM pg_catalog.pg_language AS language_row
           WHERE language_row.lanname = 'plpgsql'
         )
         AND NOT function_row.prosecdef
         AND NOT function_row.proleakproof
         AND NOT function_row.proretset
         AND NOT function_row.proisstrict
         AND function_row.provolatile = 'v'
         AND function_row.proparallel = 'u'
         AND function_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
         AND function_row.pronargdefaults = 0
         AND pg_catalog.array_length(function_row.proconfig, 1) = 1
         AND function_row.proconfig @>
             ARRAY['search_path=pg_catalog, pg_temp']::text[]
         AND pg_catalog.encode(
           pg_catalog.sha256(
             pg_catalog.convert_to(function_row.prosrc, 'UTF8')
           ),
           'hex'
         ) = '727b58f09c7eb9bb241c39720e011fcfb1a1b2805aca5b8d75575c2380aebc36'
         AND pg_catalog.strpos(
           function_row.prosrc,
           'position-history insert requires parser-conservation publication authority'
         ) > 0
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS privilege
       WHERE function_row.oid = v_row_guard
         AND privilege.grantee <> function_row.proowner
     )
     OR NOT pg_catalog.has_schema_privilege(
       'service_role', 'arena', 'USAGE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_checkpoint, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('anon', v_checkpoint, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', v_checkpoint, 'EXECUTE'
     )
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS privilege
       WHERE function_row.oid = v_checkpoint
         AND privilege.grantee = v_service_role
         AND privilege.grantor = function_row.proowner
         AND privilege.privilege_type = 'EXECUTE'
         AND NOT privilege.is_grantable
     ) <> 1
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS privilege
       WHERE function_row.oid = v_checkpoint
         AND privilege.grantee <> function_row.proowner
         AND (
           privilege.grantee <> v_service_role
           OR privilege.grantor <> function_row.proowner
           OR privilege.privilege_type <> 'EXECUTE'
           OR privilege.is_grantable
         )
     ) THEN
    RAISE EXCEPTION
      'legacy position-history publisher retirement postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
