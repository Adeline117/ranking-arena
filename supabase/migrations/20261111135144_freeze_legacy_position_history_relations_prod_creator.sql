-- Forward replacement for 20260804044000_freeze_legacy_position_history_relations.sql
-- (never applied to production). The body is identical except that the legacy
-- public.create_next_tph_partition() creator may also carry production's source
-- digest f93b07ee...65a9. That body (2026-10-30 production backup) differs from
-- the reviewed 20260413175353 body (digest 2beaa5ea...b5e1) only by indentation,
-- one removed comment, and blank lines; after stripping comments and collapsing
-- whitespace both are identical. It is retired exactly like the reviewed legacy
-- body. Apply it in the original's launch slot; the original is superseded.
--
-- Freeze every surviving public.trader_position_history relation.
--
-- The 2026-04 side-by-side partition migration granted anon/authenticated
-- direct DML on each tph_* child.  Parent RLS is not consulted when a child is
-- addressed directly.  The 2026-05 production cutover was a manual rename, so
-- a ledger replay and production can legitimately expose different names for
-- the same legacy relation tree.  Discover both shapes by OID, remove every
-- non-owner authority, and make the retained data an immutable operator-only
-- archive.  Legacy rows remain untrusted and are not ranking authority.

BEGIN;

-- Each catalog phase needs a fresh snapshot after the named-root DDL barrier.
-- A transaction-wide snapshot taken before that barrier could miss a child
-- whose ATTACH/CREATE PARTITION commits while the migration is waiting.
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    '20260804-freeze-legacy-position-history-relations',
    0
  )
);

DO $role_preflight$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION
      'legacy position-history relation freeze requires PostgreSQL 14 or newer';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'Supabase runtime role topology is incomplete';
  END IF;

  -- MEMBER covers direct and transitive PG17 SET-only membership paths.  ACL
  -- convergence is not a boundary if an application role can assume the
  -- owner, a superuser, or service_role after the migration commits.
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
      'application role can assume a superuser or legacy relation owner';
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
    RAISE EXCEPTION 'public application role can assume service_role';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('service_role'::pg_catalog.regrole),
        ('anon'::pg_catalog.regrole),
        ('authenticated'::pg_catalog.regrole)
    ) AS application_role(role_oid)
    WHERE pg_catalog.has_schema_privilege(
      application_role.role_oid,
      'public'::pg_catalog.regnamespace,
      'CREATE'
    )
  ) THEN
    RAISE EXCEPTION
      'runtime application role can create in public schema';
  END IF;
END;
$role_preflight$;

DO $named_relation_preflight$
DECLARE
  v_relation record;
BEGIN
  FOR v_relation IN
    SELECT relation.oid, relation.relname, relation.relkind
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = relation.relnamespace
    WHERE namespace_row.nspname = 'public'
      AND relation.relname IN (
        'trader_position_history',
        'trader_position_history_partitioned',
        'trader_position_history_old'
      )
  LOOP
    IF v_relation.relkind NOT IN ('r', 'p') THEN
      RAISE EXCEPTION
        'legacy position-history named relation has invalid kind: % (%)',
        v_relation.relname,
        v_relation.relkind;
    END IF;
  END LOOP;

  FOR v_relation IN
    SELECT relation.oid, relation.relname, relation.relkind
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = relation.relnamespace
    WHERE namespace_row.nspname = 'public'
      AND relation.relname LIKE 'tph\_%' ESCAPE '\'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  LOOP
    IF v_relation.relkind NOT IN ('r', 'p') THEN
      RAISE EXCEPTION
        'reserved tph relation has invalid kind: % (%)',
        v_relation.relname,
        v_relation.relkind;
    END IF;
  END LOOP;
END;
$named_relation_preflight$;

CREATE TEMP TABLE legacy_position_history_named_root_lock_snapshot (
  relation_oid oid PRIMARY KEY,
  namespace_name name NOT NULL,
  relation_name name NOT NULL
) ON COMMIT DROP;

INSERT INTO pg_temp.legacy_position_history_named_root_lock_snapshot (
  relation_oid,
  namespace_name,
  relation_name
)
SELECT relation.oid, namespace_row.nspname, relation.relname
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS namespace_row
  ON namespace_row.oid = relation.relnamespace
WHERE namespace_row.nspname = 'public'
  AND relation.relname IN (
    'trader_position_history',
    'trader_position_history_partitioned',
    'trader_position_history_old'
  )
  AND relation.relkind IN ('r', 'p');

-- Establish the partition-topology barrier before taking the recursive
-- discovery snapshot.  ACCESS EXCLUSIVE conflicts with CREATE/ATTACH/DETACH
-- partition DDL.  Under READ COMMITTED, a DDL transaction that already owns a
-- parent lock finishes first and its committed child is visible to the later
-- recursive scan.  DDL queued behind this barrier linearizes after the freeze
-- and therefore belongs to the trusted-owner boundary: post-commit owner DDL is
-- an explicit administrative bypass (like disabling a guard trigger).  Every
-- runtime role is proven unable to assume postgres or CREATE in public, and the
-- only legacy partition creator is retired below.
DO $lock_named_roots$
DECLARE
  v_relation record;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_temp.legacy_position_history_named_root_lock_snapshot AS root
    WHERE root.relation_name IN (
      'trader_position_history',
      'trader_position_history_partitioned'
    )
  ) THEN
    RAISE EXCEPTION
      'legacy position-history canonical or side-by-side parent is missing';
  END IF;

  FOR v_relation IN
    SELECT root.relation_oid, root.namespace_name, root.relation_name
    FROM pg_temp.legacy_position_history_named_root_lock_snapshot AS root
    ORDER BY root.relation_oid
  LOOP
    EXECUTE pg_catalog.format(
      'LOCK TABLE ONLY %I.%I IN ACCESS EXCLUSIVE MODE',
      v_relation.namespace_name,
      v_relation.relation_name
    );

    IF pg_catalog.to_regclass(
         pg_catalog.format(
           '%I.%I',
           v_relation.namespace_name,
           v_relation.relation_name
         )
       ) IS DISTINCT FROM v_relation.relation_oid THEN
      RAISE EXCEPTION
        'legacy position-history named root identity changed while locking: %.%',
        v_relation.namespace_name,
        v_relation.relation_name;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT relation.oid
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = relation.relnamespace
    WHERE namespace_row.nspname = 'public'
      AND relation.relname IN (
        'trader_position_history',
        'trader_position_history_partitioned',
        'trader_position_history_old'
      )
      AND relation.relkind IN ('r', 'p')
    EXCEPT
    SELECT root.relation_oid
    FROM pg_temp.legacy_position_history_named_root_lock_snapshot AS root
  )
  OR EXISTS (
    SELECT root.relation_oid
    FROM pg_temp.legacy_position_history_named_root_lock_snapshot AS root
    EXCEPT
    SELECT relation.oid
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = relation.relnamespace
    WHERE namespace_row.nspname = 'public'
      AND relation.relname IN (
        'trader_position_history',
        'trader_position_history_partitioned',
        'trader_position_history_old'
      )
      AND relation.relkind IN ('r', 'p')
  ) THEN
    RAISE EXCEPTION
      'legacy position-history named root set changed while locking';
  END IF;
END
$lock_named_roots$;

CREATE TEMP TABLE legacy_position_history_freeze_relations (
  relation_oid oid PRIMARY KEY,
  parent_relation_oid oid,
  namespace_name name NOT NULL,
  relation_name name NOT NULL,
  relation_kind "char" NOT NULL,
  relation_owner oid NOT NULL,
  is_partition boolean NOT NULL,
  is_named_root boolean NOT NULL,
  is_reserved_tph boolean NOT NULL,
  already_frozen boolean NOT NULL DEFAULT false
) ON COMMIT DROP;

INSERT INTO pg_temp.legacy_position_history_freeze_relations (
  relation_oid,
  parent_relation_oid,
  namespace_name,
  relation_name,
  relation_kind,
  relation_owner,
  is_partition,
  is_named_root,
  is_reserved_tph
)
WITH RECURSIVE named_root(root_oid) AS (
  SELECT relation.oid
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = relation.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND relation.relname IN (
      'trader_position_history',
      'trader_position_history_partitioned',
      'trader_position_history_old'
    )
    AND relation.relkind IN ('r', 'p')
), relation_tree(root_oid, relation_oid) AS (
  SELECT named_root.root_oid, named_root.root_oid
  FROM named_root
  UNION
  SELECT relation_tree.root_oid, inheritance.inhrelid
  FROM relation_tree
  JOIN pg_catalog.pg_inherits AS inheritance
    ON inheritance.inhparent = relation_tree.relation_oid
), candidate_oid(relation_oid) AS (
  SELECT relation_tree.relation_oid
  FROM relation_tree
  UNION
  SELECT relation.oid
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = relation.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND relation.relname LIKE 'tph\_%' ESCAPE '\'
    AND relation.relkind IN ('r', 'p')
)
SELECT
  relation.oid,
  (
    SELECT pg_catalog.min(inheritance.inhparent)
    FROM pg_catalog.pg_inherits AS inheritance
    JOIN candidate_oid AS parent_candidate
      ON parent_candidate.relation_oid = inheritance.inhparent
    WHERE inheritance.inhrelid = relation.oid
  ),
  namespace_row.nspname,
  relation.relname,
  relation.relkind,
  relation.relowner,
  relation.relispartition,
  relation.relname IN (
    'trader_position_history',
    'trader_position_history_partitioned',
    'trader_position_history_old'
  ),
  namespace_row.nspname = 'public'
    AND relation.relname LIKE 'tph\_%' ESCAPE '\'
FROM candidate_oid
JOIN pg_catalog.pg_class AS relation
  ON relation.oid = candidate_oid.relation_oid
JOIN pg_catalog.pg_namespace AS namespace_row
  ON namespace_row.oid = relation.relnamespace;

DO $relation_preflight$
DECLARE
  v_count bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_temp.legacy_position_history_freeze_relations AS guarded_relation
    WHERE guarded_relation.relation_name IN (
      'trader_position_history',
      'trader_position_history_partitioned'
    )
  ) THEN
    RAISE EXCEPTION
      'legacy position-history canonical or side-by-side parent is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_temp.legacy_position_history_freeze_relations AS guarded_relation
    WHERE guarded_relation.namespace_name <> 'public'
       OR guarded_relation.relation_kind NOT IN ('r', 'p')
       OR guarded_relation.relation_owner <>
            'postgres'::pg_catalog.regrole
  ) THEN
    RAISE EXCEPTION
      'legacy position-history relation namespace, kind, or owner drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_temp.legacy_position_history_freeze_relations AS guarded_relation
    WHERE guarded_relation.is_named_root
      AND guarded_relation.is_partition
  ) THEN
    RAISE EXCEPTION 'legacy position-history named root cannot be a partition';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_temp.legacy_position_history_freeze_relations AS guarded_relation
    WHERE (
        guarded_relation.parent_relation_oid IS NULL
        AND guarded_relation.is_partition
      )
       OR (
        guarded_relation.parent_relation_oid IS NOT NULL
        AND NOT guarded_relation.is_partition
      )
  ) THEN
    RAISE EXCEPTION
      'legacy position-history partition ancestry escaped the guarded set';
  END IF;

  SELECT pg_catalog.count(*)
  INTO STRICT v_count
  FROM pg_temp.legacy_position_history_freeze_relations AS guarded_relation
  WHERE (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = guarded_relation.relation_oid
      AND inheritance.inhparent IN (
        SELECT parent_relation.relation_oid
        FROM pg_temp.legacy_position_history_freeze_relations AS parent_relation
      )
  ) > 1;
  IF v_count <> 0 THEN
    RAISE EXCEPTION
      'legacy position-history relation retained multiple guarded parents';
  END IF;
END
$relation_preflight$;

-- Named roots already carry ACCESS EXCLUSIVE.  Lock every discovered descendant
-- and reserved orphan in deterministic OID order so direct mutations drain
-- before triggers and ACLs change.
DO $lock_relations$
DECLARE
  v_relation record;
BEGIN
  FOR v_relation IN
    SELECT guarded_relation.namespace_name, guarded_relation.relation_name
    FROM pg_temp.legacy_position_history_freeze_relations AS guarded_relation
    WHERE NOT guarded_relation.is_named_root
    ORDER BY guarded_relation.relation_oid
  LOOP
    EXECUTE pg_catalog.format(
      'LOCK TABLE ONLY %I.%I IN SHARE ROW EXCLUSIVE MODE',
      v_relation.namespace_name,
      v_relation.relation_name
    );
  END LOOP;
END
$lock_relations$;

CREATE TEMP TABLE legacy_position_history_partition_creator_snapshot
ON COMMIT DROP
AS
SELECT
  function_row.oid,
  function_row.prosrc,
  function_row.proacl,
  pg_catalog.pg_get_functiondef(function_row.oid) AS function_definition
FROM pg_catalog.pg_proc AS function_row
JOIN pg_catalog.pg_namespace AS namespace_row
  ON namespace_row.oid = function_row.pronamespace
WHERE namespace_row.nspname = 'public'
  AND function_row.proname = 'create_next_tph_partition';

DO $function_preflight$
DECLARE
  v_creator oid := pg_catalog.to_regprocedure(
    'public.create_next_tph_partition()'
  );
  v_guard oid := pg_catalog.to_regprocedure(
    'public.reject_legacy_position_history_mutation()'
  );
  v_creator_count bigint;
  v_creator_hash text;
  v_guard_hash text;
BEGIN
  SELECT pg_catalog.count(*)
  INTO STRICT v_creator_count
  FROM pg_temp.legacy_position_history_partition_creator_snapshot;

  -- The optional legacy callable is either wholly absent or exactly the
  -- expected zero-argument function.  A lone wrong-signature overload must not
  -- make the zero-argument lookup NULL and silently bypass retirement.
  IF v_creator_count > 1
     OR (
       v_creator_count = 1
       AND (
         v_creator IS NULL
         OR NOT EXISTS (
           SELECT 1
           FROM pg_temp.legacy_position_history_partition_creator_snapshot AS snapshot
           WHERE snapshot.oid = v_creator
         )
       )
     ) THEN
    RAISE EXCEPTION
      'legacy position-history partition creator overload set drifted';
  END IF;

  IF EXISTS (
    SELECT function_row.oid
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname = 'create_next_tph_partition'
    EXCEPT
    SELECT snapshot.oid
    FROM pg_temp.legacy_position_history_partition_creator_snapshot AS snapshot
  )
  OR EXISTS (
    SELECT snapshot.oid
    FROM pg_temp.legacy_position_history_partition_creator_snapshot AS snapshot
    EXCEPT
    SELECT function_row.oid
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname = 'create_next_tph_partition'
  ) THEN
    RAISE EXCEPTION
      'legacy partition creator overload set changed during retirement';
  END IF;

  IF v_creator IS NOT NULL THEN
    SELECT pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
      'hex'
    )
    INTO STRICT v_creator_hash
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_creator;

    IF NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         WHERE function_row.oid = v_creator
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
           AND function_row.prorettype = 'pg_catalog.void'::pg_catalog.regtype
           AND function_row.pronargdefaults = 0
       )
       OR v_creator_hash NOT IN (
         '2beaa5eae7722d0325de97c0bcbe4fa37fb124a26074325dd81c39fafebcb5e1',
         -- Production's whitespace/comment-only variant of the legacy body.
         'f93b07eee3660ec36a20c590ad25d0257327338408807eedbfdabf4e346d65a9',
         '59aa806f207b9c6c68ab9aaf61cb5c7340fe6e6fe5345186cb319d7abc7fb999'
       ) THEN
      RAISE EXCEPTION
        'legacy position-history partition creator drifted: %',
        v_creator_hash;
    END IF;
  END IF;

  IF v_guard IS NOT NULL THEN
    SELECT pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
      'hex'
    )
    INTO STRICT v_guard_hash
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_guard;

    IF NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         WHERE function_row.oid = v_guard
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
           AND function_row.prorettype =
                 'pg_catalog.trigger'::pg_catalog.regtype
           AND function_row.pronargdefaults = 0
           AND function_row.proconfig IS NOT DISTINCT FROM
                 ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
       )
       OR v_guard_hash <> '52a394d55deb0f1d92143e252ac0a2dcdcc22c3a2985863a9ec296199dfc0a58' THEN
      RAISE EXCEPTION
        'legacy position-history mutation guard drifted: %',
        v_guard_hash;
    END IF;
  ELSIF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    JOIN pg_temp.legacy_position_history_freeze_relations AS guarded_relation
      ON guarded_relation.relation_oid = trigger_row.tgrelid
    WHERE trigger_row.tgname IN (
      'reject_legacy_position_history_before_write',
      'reject_legacy_position_history_before_truncate'
    )
  ) THEN
    RAISE EXCEPTION
      'legacy position-history guard trigger exists without its function';
  END IF;
END
$function_preflight$;

-- A relation is either wholly fresh or already carries both exact guards.
-- Same-name partial, disabled, or re-bound triggers are hostile drift.
DO $trigger_preflight$
DECLARE
  v_guard oid := pg_catalog.to_regprocedure(
    'public.reject_legacy_position_history_mutation()'
  );
  v_relation record;
  v_row_trigger oid;
  v_truncate_trigger oid;
  v_parent_row_trigger oid;
BEGIN
  FOR v_relation IN
    SELECT *
    FROM pg_temp.legacy_position_history_freeze_relations
    ORDER BY relation_oid
  LOOP
    SELECT trigger_row.oid
    INTO v_row_trigger
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = v_relation.relation_oid
      AND trigger_row.tgname =
          'reject_legacy_position_history_before_write';

    SELECT trigger_row.oid
    INTO v_truncate_trigger
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = v_relation.relation_oid
      AND trigger_row.tgname =
          'reject_legacy_position_history_before_truncate';

    IF v_row_trigger IS NULL AND v_truncate_trigger IS NULL THEN
      CONTINUE;
    END IF;
    IF v_guard IS NULL OR v_row_trigger IS NULL THEN
      RAISE EXCEPTION
        'legacy position-history relation retained a partial guard: %.%',
        v_relation.namespace_name,
        v_relation.relation_name;
    END IF;

    v_parent_row_trigger := NULL;
    IF v_relation.parent_relation_oid IS NOT NULL THEN
      SELECT trigger_row.oid
      INTO v_parent_row_trigger
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_relation.parent_relation_oid
        AND trigger_row.tgname =
            'reject_legacy_position_history_before_write';
    END IF;

    IF NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_trigger AS trigger_row
         WHERE trigger_row.oid = v_row_trigger
           AND NOT trigger_row.tgisinternal
           AND trigger_row.tgfoid = v_guard
           AND trigger_row.tgenabled = 'O'
           AND trigger_row.tgtype = 31::smallint
           AND (
             (
               v_relation.parent_relation_oid IS NULL
               AND trigger_row.tgparentid = 0
             )
             OR (
               v_relation.parent_relation_oid IS NOT NULL
               AND v_parent_row_trigger IS NOT NULL
               AND trigger_row.tgparentid = v_parent_row_trigger
             )
           )
       ) THEN
      RAISE EXCEPTION
        'legacy position-history row guard identity drifted: %.%',
        v_relation.namespace_name,
        v_relation.relation_name;
    END IF;

    -- A child attached after the first freeze inherits the exact row guard,
    -- but PostgreSQL does not clone the statement-level TRUNCATE guard.  Treat
    -- that one exact shape as a fresh child and converge it below.  A root or
    -- detached relation with only one guard is hostile partial drift.
    IF v_truncate_trigger IS NULL THEN
      IF v_relation.parent_relation_oid IS NOT NULL THEN
        CONTINUE;
      END IF;
      RAISE EXCEPTION
        'legacy position-history relation retained a partial guard: %.%',
        v_relation.namespace_name,
        v_relation.relation_name;
    END IF;

    IF NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_trigger AS trigger_row
         WHERE trigger_row.oid = v_truncate_trigger
           AND NOT trigger_row.tgisinternal
           AND trigger_row.tgfoid = v_guard
           AND trigger_row.tgenabled = 'O'
           AND trigger_row.tgtype = 34::smallint
           AND trigger_row.tgparentid = 0
       ) THEN
      RAISE EXCEPTION
        'legacy position-history truncate guard identity drifted: %.%',
        v_relation.namespace_name,
        v_relation.relation_name;
    END IF;

    UPDATE pg_temp.legacy_position_history_freeze_relations
    SET already_frozen = true
    WHERE relation_oid = v_relation.relation_oid;
  END LOOP;
END
$trigger_preflight$;

DO $frozen_policy_preflight$
DECLARE
  v_relation record;
BEGIN
  FOR v_relation IN
    SELECT *
    FROM pg_temp.legacy_position_history_freeze_relations
    WHERE already_frozen
    ORDER BY relation_oid
  LOOP
    IF NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_class AS relation
         WHERE relation.oid = v_relation.relation_oid
           AND relation.relrowsecurity
           AND relation.relforcerowsecurity
       )
       OR (
         SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_policy AS policy
         WHERE policy.polrelid = v_relation.relation_oid
       ) <> 1
       OR NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_policy AS policy
         WHERE policy.polrelid = v_relation.relation_oid
           AND policy.polname =
               'legacy_position_history_operator_read'
           AND policy.polpermissive
           AND policy.polcmd = 'r'
           AND pg_catalog.cardinality(policy.polroles) = 2
           AND policy.polroles @> ARRAY[
             'postgres'::pg_catalog.regrole::oid,
             'service_role'::pg_catalog.regrole::oid
           ]::oid[]
           AND pg_catalog.pg_get_expr(
                 policy.polqual,
                 policy.polrelid
               ) = 'true'
           AND policy.polwithcheck IS NULL
       ) THEN
      RAISE EXCEPTION
        'frozen legacy position-history RLS policy drifted: %.%',
        v_relation.namespace_name,
        v_relation.relation_name;
    END IF;
  END LOOP;
END
$frozen_policy_preflight$;

DO $install_mutation_guard$
BEGIN
  IF pg_catalog.to_regprocedure(
       'public.reject_legacy_position_history_mutation()'
     ) IS NULL THEN
    EXECUTE $definition$
CREATE FUNCTION public.reject_legacy_position_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION
    'legacy trader position history is frozen; parser-conservation projection required'
    USING ERRCODE = '55000';
END
$function$
$definition$;

    ALTER FUNCTION public.reject_legacy_position_history_mutation()
      OWNER TO postgres;
    COMMENT ON FUNCTION public.reject_legacy_position_history_mutation() IS
      'Unconditional mutation guard for every surviving legacy trader_position_history relation.';
  END IF;
END
$install_mutation_guard$;

DO $guard_acl$
DECLARE
  v_guard oid := 'public.reject_legacy_position_history_mutation()'::pg_catalog.regprocedure;
  v_grantee record;
BEGIN
  EXECUTE pg_catalog.format(
    'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE',
    v_guard::pg_catalog.regprocedure
  );

  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee, grantee_role.rolname
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    LEFT JOIN pg_catalog.pg_roles AS grantee_role
      ON grantee_role.oid = acl_entry.grantee
    WHERE function_row.oid = v_guard
      AND acl_entry.grantee <> function_row.proowner
  LOOP
    IF v_grantee.grantee = 0 THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE',
        v_guard::pg_catalog.regprocedure
      );
    ELSIF v_grantee.rolname IS NULL THEN
      RAISE EXCEPTION
        'mutation guard retained unresolved grantee %',
        v_grantee.grantee;
    ELSE
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
        v_guard::pg_catalog.regprocedure,
        v_grantee.rolname
      );
    END IF;
  END LOOP;
END
$guard_acl$;

DO $install_relation_guards$
DECLARE
  v_relation record;
BEGIN
  -- Roots first: a row trigger on a partitioned parent clones recursively to
  -- every attached child with an exact tgparentid chain.
  FOR v_relation IN
    SELECT *
    FROM pg_temp.legacy_position_history_freeze_relations
    ORDER BY
      (parent_relation_oid IS NOT NULL),
      relation_oid
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_relation.relation_oid
        AND trigger_row.tgname =
            'reject_legacy_position_history_before_write'
    ) THEN
      EXECUTE pg_catalog.format(
        'CREATE TRIGGER reject_legacy_position_history_before_write '
          || 'BEFORE INSERT OR UPDATE OR DELETE ON %I.%I '
          || 'FOR EACH ROW EXECUTE FUNCTION '
          || 'public.reject_legacy_position_history_mutation()',
        v_relation.namespace_name,
        v_relation.relation_name
      );
    END IF;
  END LOOP;

  -- Statement-level TRUNCATE triggers are not cloned to partitions.
  FOR v_relation IN
    SELECT *
    FROM pg_temp.legacy_position_history_freeze_relations
    ORDER BY relation_oid
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_relation.relation_oid
        AND trigger_row.tgname =
            'reject_legacy_position_history_before_truncate'
    ) THEN
      EXECUTE pg_catalog.format(
        'CREATE TRIGGER reject_legacy_position_history_before_truncate '
          || 'BEFORE TRUNCATE ON %I.%I '
          || 'FOR EACH STATEMENT EXECUTE FUNCTION '
          || 'public.reject_legacy_position_history_mutation()',
        v_relation.namespace_name,
        v_relation.relation_name
      );
    END IF;
  END LOOP;
END
$install_relation_guards$;

DO $converge_relation_authority$
DECLARE
  v_relation record;
  v_policy_name name;
  v_grantee record;
  v_column_list text;
BEGIN
  FOR v_relation IN
    SELECT *
    FROM pg_temp.legacy_position_history_freeze_relations
    ORDER BY relation_oid
  LOOP
    IF NOT v_relation.already_frozen THEN
      EXECUTE pg_catalog.format(
        'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
        v_relation.namespace_name,
        v_relation.relation_name
      );
      EXECUTE pg_catalog.format(
        'ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',
        v_relation.namespace_name,
        v_relation.relation_name
      );

      FOR v_policy_name IN
        SELECT policy.polname
        FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid = v_relation.relation_oid
        ORDER BY policy.polname
      LOOP
        EXECUTE pg_catalog.format(
          'DROP POLICY %I ON %I.%I',
          v_policy_name,
          v_relation.namespace_name,
          v_relation.relation_name
        );
      END LOOP;

      EXECUTE pg_catalog.format(
        'CREATE POLICY legacy_position_history_operator_read '
          || 'ON %I.%I AS PERMISSIVE FOR SELECT '
          || 'TO postgres, service_role USING (true)',
        v_relation.namespace_name,
        v_relation.relation_name
      );
    END IF;

    -- Collapse PUBLIC, delegated grants, grant options, and every named
    -- non-owner table ACL before granting the sole operator read capability.
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC CASCADE',
      v_relation.namespace_name,
      v_relation.relation_name
    );

    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee, grantee_role.rolname
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      LEFT JOIN pg_catalog.pg_roles AS grantee_role
        ON grantee_role.oid = acl_entry.grantee
      WHERE relation.oid = v_relation.relation_oid
        AND acl_entry.grantee <> relation.relowner
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC CASCADE',
          v_relation.namespace_name,
          v_relation.relation_name
        );
      ELSIF v_grantee.rolname IS NULL THEN
        RAISE EXCEPTION
          'legacy position-history relation retained unresolved grantee %',
          v_grantee.grantee;
      ELSE
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I CASCADE',
          v_relation.namespace_name,
          v_relation.relation_name,
          v_grantee.rolname
        );
      END IF;
    END LOOP;

    -- Table-level REVOKE does not remove independently granted column ACLs.
    SELECT pg_catalog.string_agg(
      pg_catalog.format('%I', attribute.attname),
      ', '
      ORDER BY attribute.attnum
    )
    INTO v_column_list
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation.relation_oid
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee, grantee_role.rolname
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      LEFT JOIN pg_catalog.pg_roles AS grantee_role
        ON grantee_role.oid = acl_entry.grantee
      WHERE attribute.attrelid = v_relation.relation_oid
        AND attribute.attacl IS NOT NULL
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), '
            || 'REFERENCES (%1$s) ON TABLE %2$I.%3$I FROM PUBLIC CASCADE',
          v_column_list,
          v_relation.namespace_name,
          v_relation.relation_name
        );
      ELSIF v_grantee.rolname IS NULL THEN
        RAISE EXCEPTION
          'legacy position-history column retained unresolved grantee %',
          v_grantee.grantee;
      ELSIF v_grantee.grantee <> v_relation.relation_owner THEN
        EXECUTE pg_catalog.format(
          'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), '
            || 'REFERENCES (%1$s) ON TABLE %2$I.%3$I FROM %4$I CASCADE',
          v_column_list,
          v_relation.namespace_name,
          v_relation.relation_name,
          v_grantee.rolname
        );
      END IF;
    END LOOP;

    EXECUTE pg_catalog.format(
      'GRANT SELECT ON TABLE %I.%I TO service_role',
      v_relation.namespace_name,
      v_relation.relation_name
    );
  END LOOP;
END
$converge_relation_authority$;

DO $retire_partition_creator$
DECLARE
  v_creator oid := pg_catalog.to_regprocedure(
    'public.create_next_tph_partition()'
  );
  v_creator_hash text;
BEGIN
  IF v_creator IS NULL THEN
    RETURN;
  END IF;

  SELECT pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
    'hex'
  )
  INTO STRICT v_creator_hash
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_creator;

  IF v_creator_hash IN (
       '2beaa5eae7722d0325de97c0bcbe4fa37fb124a26074325dd81c39fafebcb5e1',
       -- Production's whitespace/comment-only variant of the legacy body.
       'f93b07eee3660ec36a20c590ad25d0257327338408807eedbfdabf4e346d65a9'
     ) THEN
    EXECUTE $definition$
CREATE OR REPLACE FUNCTION public.create_next_tph_partition()
RETURNS void
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION
    'legacy trader position-history partition creator is retired'
    USING ERRCODE = '55000';
END
$function$
$definition$;

    ALTER FUNCTION public.create_next_tph_partition() OWNER TO postgres;
    COMMENT ON FUNCTION public.create_next_tph_partition() IS
      'Retired legacy partition creator. Unified verified history must use arena authority.';
  ELSIF v_creator_hash <> '59aa806f207b9c6c68ab9aaf61cb5c7340fe6e6fe5345186cb319d7abc7fb999' THEN
    RAISE EXCEPTION
      'legacy partition creator changed during freeze: %',
      v_creator_hash;
  END IF;
END
$retire_partition_creator$;

DO $partition_creator_acl$
DECLARE
  v_creator oid := pg_catalog.to_regprocedure(
    'public.create_next_tph_partition()'
  );
  v_grantee record;
BEGIN
  IF v_creator IS NULL THEN
    RETURN;
  END IF;

  EXECUTE pg_catalog.format(
    'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE',
    v_creator::pg_catalog.regprocedure
  );

  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee, grantee_role.rolname
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    LEFT JOIN pg_catalog.pg_roles AS grantee_role
      ON grantee_role.oid = acl_entry.grantee
    WHERE function_row.oid = v_creator
      AND acl_entry.grantee <> function_row.proowner
  LOOP
    IF v_grantee.grantee = 0 THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE',
        v_creator::pg_catalog.regprocedure
      );
    ELSIF v_grantee.rolname IS NULL THEN
      RAISE EXCEPTION
        'legacy partition creator retained unresolved grantee %',
        v_grantee.grantee;
    ELSE
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
        v_creator::pg_catalog.regprocedure,
        v_grantee.rolname
      );
    END IF;
  END LOOP;
END
$partition_creator_acl$;

DO $postflight$
DECLARE
  v_guard oid := 'public.reject_legacy_position_history_mutation()'::pg_catalog.regprocedure;
  v_creator oid := pg_catalog.to_regprocedure(
    'public.create_next_tph_partition()'
  );
  v_guard_hash text;
  v_creator_hash text;
BEGIN
  SELECT pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
    'hex'
  )
  INTO STRICT v_guard_hash
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_guard;

  IF v_guard_hash <> '52a394d55deb0f1d92143e252ac0a2dcdcc22c3a2985863a9ec296199dfc0a58'
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = v_guard
         AND function_row.proowner = 'postgres'::pg_catalog.regrole
         AND NOT function_row.prosecdef
         AND function_row.provolatile = 'v'
         AND function_row.proparallel = 'u'
         AND function_row.prorettype =
               'pg_catalog.trigger'::pg_catalog.regtype
         AND function_row.proconfig IS NOT DISTINCT FROM
               ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS acl_entry
       WHERE function_row.oid = v_guard
         AND acl_entry.privilege_type = 'EXECUTE'
         AND acl_entry.grantee <> function_row.proowner
     ) THEN
    RAISE EXCEPTION 'legacy position-history mutation guard postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_temp.legacy_position_history_freeze_relations AS guarded_relation
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = guarded_relation.relation_oid
    WHERE relation.relowner <> 'postgres'::pg_catalog.regrole
       OR relation.relkind NOT IN ('r', 'p')
       OR NOT relation.relrowsecurity
       OR NOT relation.relforcerowsecurity
       OR NOT pg_catalog.has_table_privilege(
         'service_role',
         relation.oid,
         'SELECT'
       )
       OR pg_catalog.has_table_privilege(
         'service_role',
         relation.oid,
         'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR pg_catalog.has_table_privilege(
         'anon',
         relation.oid,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR pg_catalog.has_table_privilege(
         'authenticated',
         relation.oid,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
  ) THEN
    RAISE EXCEPTION 'legacy position-history effective ACL postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_temp.legacy_position_history_freeze_relations AS guarded_relation
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = guarded_relation.relation_oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE acl_entry.grantee <> relation.relowner
      AND (
        acl_entry.grantee <> 'service_role'::pg_catalog.regrole
        OR acl_entry.privilege_type <> 'SELECT'
        OR acl_entry.is_grantable
      )
  )
  OR EXISTS (
    SELECT 1
    FROM pg_temp.legacy_position_history_freeze_relations AS guarded_relation
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = guarded_relation.relation_oid
    WHERE attribute.attacl IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(attribute.attacl) AS acl_entry
        WHERE acl_entry.grantee <> guarded_relation.relation_owner
      )
  ) THEN
    RAISE EXCEPTION 'legacy position-history explicit ACL postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_temp.legacy_position_history_freeze_relations AS guarded_relation
    WHERE (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = guarded_relation.relation_oid
    ) <> 1
       OR NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_policy AS policy
         WHERE policy.polrelid = guarded_relation.relation_oid
           AND policy.polname =
               'legacy_position_history_operator_read'
           AND policy.polpermissive
           AND policy.polcmd = 'r'
           AND pg_catalog.cardinality(policy.polroles) = 2
           AND policy.polroles @> ARRAY[
             'postgres'::pg_catalog.regrole::oid,
             'service_role'::pg_catalog.regrole::oid
           ]::oid[]
           AND pg_catalog.pg_get_expr(
                 policy.polqual,
                 policy.polrelid
               ) = 'true'
           AND policy.polwithcheck IS NULL
       )
  ) THEN
    RAISE EXCEPTION 'legacy position-history policy postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_temp.legacy_position_history_freeze_relations AS guarded_relation
    LEFT JOIN pg_catalog.pg_trigger AS row_trigger
      ON row_trigger.tgrelid = guarded_relation.relation_oid
     AND row_trigger.tgname =
         'reject_legacy_position_history_before_write'
    LEFT JOIN pg_catalog.pg_trigger AS truncate_trigger
      ON truncate_trigger.tgrelid = guarded_relation.relation_oid
     AND truncate_trigger.tgname =
         'reject_legacy_position_history_before_truncate'
    LEFT JOIN pg_catalog.pg_trigger AS parent_row_trigger
      ON parent_row_trigger.tgrelid = guarded_relation.parent_relation_oid
     AND parent_row_trigger.tgname =
         'reject_legacy_position_history_before_write'
    WHERE row_trigger.oid IS NULL
       OR row_trigger.tgisinternal
       OR row_trigger.tgfoid <> v_guard
       OR row_trigger.tgenabled <> 'O'
       OR row_trigger.tgtype <> 31::smallint
       OR truncate_trigger.oid IS NULL
       OR truncate_trigger.tgisinternal
       OR truncate_trigger.tgfoid <> v_guard
       OR truncate_trigger.tgenabled <> 'O'
       OR truncate_trigger.tgtype <> 34::smallint
       OR truncate_trigger.tgparentid <> 0
       OR (
         guarded_relation.parent_relation_oid IS NULL
         AND row_trigger.tgparentid <> 0
       )
       OR (
         guarded_relation.parent_relation_oid IS NOT NULL
         AND (
           parent_row_trigger.oid IS NULL
           OR row_trigger.tgparentid <> parent_row_trigger.oid
         )
       )
  ) THEN
    RAISE EXCEPTION 'legacy position-history trigger postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    JOIN pg_temp.legacy_position_history_freeze_relations AS guarded_relation
      ON guarded_relation.relation_oid = trigger_row.tgrelid
    WHERE trigger_row.tgname IN (
      'reject_legacy_position_history_before_write',
      'reject_legacy_position_history_before_truncate'
    )
    GROUP BY trigger_row.tgrelid
    HAVING pg_catalog.count(*) <> 2
  ) THEN
    RAISE EXCEPTION 'legacy position-history trigger count postflight failed';
  END IF;

  IF EXISTS (
    SELECT function_row.oid
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname = 'create_next_tph_partition'
    EXCEPT
    SELECT snapshot.oid
    FROM pg_temp.legacy_position_history_partition_creator_snapshot AS snapshot
  )
  OR EXISTS (
    SELECT snapshot.oid
    FROM pg_temp.legacy_position_history_partition_creator_snapshot AS snapshot
    EXCEPT
    SELECT function_row.oid
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname = 'create_next_tph_partition'
  ) THEN
    RAISE EXCEPTION
      'legacy partition creator overload set changed during retirement';
  END IF;

  IF v_creator IS NOT NULL THEN
    SELECT pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
      'hex'
    )
    INTO STRICT v_creator_hash
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_creator;

    IF v_creator_hash <> '59aa806f207b9c6c68ab9aaf61cb5c7340fe6e6fe5345186cb319d7abc7fb999'
       OR NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         WHERE function_row.oid = v_creator
           AND function_row.proowner = 'postgres'::pg_catalog.regrole
           AND NOT function_row.prosecdef
           AND function_row.provolatile = 'v'
           AND function_row.proparallel = 'u'
           AND function_row.prorettype = 'pg_catalog.void'::pg_catalog.regtype
           AND function_row.proconfig IS NOT DISTINCT FROM
                 ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
       )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             function_row.proacl,
             pg_catalog.acldefault('f', function_row.proowner)
           )
         ) AS acl_entry
         WHERE function_row.oid = v_creator
           AND acl_entry.privilege_type = 'EXECUTE'
           AND acl_entry.grantee <> function_row.proowner
       ) THEN
      RAISE EXCEPTION
        'legacy position-history partition creator retirement failed';
    END IF;

    IF (
         SELECT snapshot.oid
         FROM pg_temp.legacy_position_history_partition_creator_snapshot AS snapshot
       ) IS DISTINCT FROM v_creator THEN
      RAISE EXCEPTION 'legacy partition creator OID changed during retirement';
    END IF;
  ELSIF EXISTS (
    SELECT 1
    FROM pg_temp.legacy_position_history_partition_creator_snapshot
  ) THEN
    RAISE EXCEPTION 'legacy partition creator disappeared during retirement';
  END IF;

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
      'service_role'::pg_catalog.regrole,
      'MEMBER'
    )
  )
  OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('service_role'::pg_catalog.regrole),
        ('anon'::pg_catalog.regrole),
        ('authenticated'::pg_catalog.regrole)
    ) AS application_role(role_oid)
    WHERE pg_catalog.has_schema_privilege(
      application_role.role_oid,
      'public'::pg_catalog.regnamespace,
      'CREATE'
    )
  ) THEN
    RAISE EXCEPTION 'legacy position-history role topology changed during freeze';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
