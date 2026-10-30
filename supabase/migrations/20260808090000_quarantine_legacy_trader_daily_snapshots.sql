-- trader_daily_snapshots is a legacy, unproven history projection. Preserve
-- its rows for operator forensics, but remove it from every browser and
-- runtime mutation authority until a provenance-attested publication path is
-- versioned and separately approved.
--
-- This migration deliberately does not rewrite, delete, truncate, or replace
-- the table. Database owners retain their normal operator authority;
-- service_role receives SELECT only.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'public.trader_daily_snapshots:legacy-quarantine-v1',
    0
  )
);

DO $preflight$
DECLARE
  v_relation regclass := pg_catalog.to_regclass(
    'public.trader_daily_snapshots'
  );
  v_missing_roles text[];
  v_unknown_policies name[];
  v_relation_owner oid;
  v_relation_kind "char";
  v_relation_is_partition boolean;
  v_role name;
  v_privilege text;
  v_column name;
  v_dependent_relation record;
  v_trigger record;
  v_rule record;
  v_foreign_key record;
  v_routine record;
BEGIN
  IF v_relation IS NULL THEN
    RAISE EXCEPTION
      'public.trader_daily_snapshots must exist before legacy quarantine';
  END IF;

  SELECT
    relation.relowner,
    relation.relkind,
    relation.relispartition
  INTO
    v_relation_owner,
    v_relation_kind,
    v_relation_is_partition
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = v_relation;

  IF v_relation_owner IS NULL OR v_relation_kind <> 'r' THEN
    RAISE EXCEPTION
      'public.trader_daily_snapshots must be an ordinary table';
  END IF;

  IF v_relation_is_partition OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = v_relation
  ) THEN
    RAISE EXCEPTION
      'public.trader_daily_snapshots must not be a partition child';
  END IF;

  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['anon', 'authenticated', 'service_role']::text[]
  ) AS required_role
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = required_role
  );

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION
      'daily snapshot quarantine roles are missing: %',
      v_missing_roles;
  END IF;

  SELECT pg_catalog.array_agg(policy.polname ORDER BY policy.polname)
  INTO v_unknown_policies
  FROM pg_catalog.pg_policy AS policy
  WHERE policy.polrelid = v_relation
    AND policy.polname <> ALL (
      ARRAY[
        'trader_daily_snapshots_select_all',
        'trader_daily_snapshots_service_role_write',
        'Service role reads quarantined daily snapshots'
      ]::name[]
    );

  IF v_unknown_policies IS NOT NULL THEN
    RAISE EXCEPTION
      'unknown trader_daily_snapshots policies require operator review: %',
      v_unknown_policies;
  END IF;

  -- ACL revocation cannot constrain a relation owner or a role that inherits
  -- owner authority. Refuse that drift instead of installing a false boundary.
  FOREACH v_role IN ARRAY ARRAY[
    'anon',
    'authenticated',
    'service_role'
  ]::name[]
  LOOP
    IF pg_catalog.pg_has_role(v_role, v_relation_owner, 'USAGE') THEN
      RAISE EXCEPTION
        '% owns or inherits owner authority on public.trader_daily_snapshots',
        v_role;
    END IF;
  END LOOP;

  -- A view normally executes with its owner privileges. An application grant
  -- on a direct or nested view can therefore bypass the base-table ACL/RLS
  -- boundary, including through an automatically updatable view. Preserve
  -- unknown operator views, but refuse to mutate anything until every
  -- effective application privilege on the dependency chain is removed.
  FOR v_dependent_relation IN
    WITH RECURSIVE dependent_relations(relation_oid) AS (
      SELECT rewrite.ev_class
      FROM pg_catalog.pg_depend AS dependency
      JOIN pg_catalog.pg_rewrite AS rewrite
        ON rewrite.oid = dependency.objid
      JOIN pg_catalog.pg_class AS dependent_relation
        ON dependent_relation.oid = rewrite.ev_class
      WHERE dependency.classid = 'pg_catalog.pg_rewrite'::regclass
        AND dependency.refclassid = 'pg_catalog.pg_class'::regclass
        AND dependency.refobjid = v_relation
        AND dependent_relation.relkind IN ('v', 'm')
        AND dependent_relation.oid <> v_relation

      UNION

      SELECT rewrite.ev_class
      FROM dependent_relations AS parent
      JOIN pg_catalog.pg_depend AS dependency
        ON dependency.refclassid = 'pg_catalog.pg_class'::regclass
       AND dependency.refobjid = parent.relation_oid
      JOIN pg_catalog.pg_rewrite AS rewrite
        ON rewrite.oid = dependency.objid
       AND dependency.classid = 'pg_catalog.pg_rewrite'::regclass
      JOIN pg_catalog.pg_class AS dependent_relation
        ON dependent_relation.oid = rewrite.ev_class
      WHERE dependent_relation.relkind IN ('v', 'm')
        AND dependent_relation.oid <> parent.relation_oid
    )
    SELECT
      dependent_relation.relation_oid,
      pg_catalog.format(
        '%I.%I',
        namespace.nspname,
        relation.relname
      ) AS identity
    FROM dependent_relations AS dependent_relation
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = dependent_relation.relation_oid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    ORDER BY identity
  LOOP
    FOREACH v_role IN ARRAY ARRAY[
      'anon',
      'authenticated',
      'service_role'
    ]::name[]
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER'
      ]::text[]
      LOOP
        IF pg_catalog.has_table_privilege(
          v_role,
          v_dependent_relation.relation_oid,
          v_privilege
        ) THEN
          RAISE EXCEPTION
            '% retains % on dependent daily snapshot relation %',
            v_role,
            v_privilege,
            v_dependent_relation.identity;
        END IF;
      END LOOP;

      FOR v_column IN
        SELECT attribute.attname
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_dependent_relation.relation_oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
        ORDER BY attribute.attnum
      LOOP
        FOREACH v_privilege IN ARRAY ARRAY[
          'SELECT',
          'INSERT',
          'UPDATE',
          'REFERENCES'
        ]::text[]
        LOOP
          IF pg_catalog.has_column_privilege(
            v_role,
            v_dependent_relation.relation_oid,
            v_column,
            v_privilege
          ) THEN
            RAISE EXCEPTION
              '% retains column % on dependent daily snapshot relation %.%',
              v_role,
              v_privilege,
              v_dependent_relation.identity,
              v_column;
          END IF;
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;

  -- Non-view rewrite rules can execute owner-authored writes when an
  -- application role mutates an otherwise unrelated table. Refuse every
  -- direct rule and every rule that reaches the base through a dependent view;
  -- rules are operator topology and are never rewritten here.
  FOR v_rule IN
    WITH RECURSIVE protected_relations(relation_oid) AS (
      SELECT v_relation::oid

      UNION

      SELECT rewrite.ev_class
      FROM protected_relations AS protected_relation
      JOIN pg_catalog.pg_depend AS dependency
        ON dependency.refclassid = 'pg_catalog.pg_class'::regclass
       AND dependency.refobjid = protected_relation.relation_oid
      JOIN pg_catalog.pg_rewrite AS rewrite
        ON rewrite.oid = dependency.objid
       AND dependency.classid = 'pg_catalog.pg_rewrite'::regclass
      JOIN pg_catalog.pg_class AS dependent_relation
        ON dependent_relation.oid = rewrite.ev_class
      WHERE dependent_relation.relkind IN ('v', 'm')
        AND dependent_relation.oid <> protected_relation.relation_oid
    )
    SELECT DISTINCT
      rewrite.oid AS rule_oid,
      rewrite.rulename AS rule_name,
      pg_catalog.format(
        '%I.%I',
        namespace.nspname,
        owning_relation.relname
      ) AS owning_relation_identity
    FROM pg_catalog.pg_rewrite AS rewrite
    JOIN pg_catalog.pg_class AS owning_relation
      ON owning_relation.oid = rewrite.ev_class
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = owning_relation.relnamespace
    WHERE rewrite.rulename <> '_RETURN'
      AND (
        pg_catalog.pg_get_ruledef(rewrite.oid)
          ILIKE '%trader_daily_snapshots%'
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_depend AS dependency
          JOIN protected_relations AS protected_relation
            ON protected_relation.relation_oid = dependency.refobjid
          WHERE dependency.classid = 'pg_catalog.pg_rewrite'::regclass
            AND dependency.objid = rewrite.oid
            AND dependency.refclassid = 'pg_catalog.pg_class'::regclass
        )
      )
    ORDER BY owning_relation_identity, rule_name
  LOOP
    RAISE EXCEPTION
      'non-view rewrite rule % on % reaches public.trader_daily_snapshots',
      v_rule.rule_name,
      v_rule.owning_relation_identity;
  END LOOP;

  -- Referential actions run with internal authority and can update/delete the
  -- child after an application role mutates only the parent. The reviewed
  -- legacy schema has no foreign key from this table, so any live FK is drift
  -- that requires operator review before quarantine.
  FOR v_foreign_key IN
    SELECT
      constraint_row.conname,
      constraint_row.confupdtype,
      constraint_row.confdeltype,
      constraint_row.confrelid
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_relation
      AND constraint_row.contype = 'f'
    ORDER BY constraint_row.conname
  LOOP
    RAISE EXCEPTION
      'unreviewed daily snapshot foreign key % references % (update %, delete %)',
      v_foreign_key.conname,
      v_foreign_key.confrelid::regclass,
      v_foreign_key.confupdtype,
      v_foreign_key.confdeltype;
  END LOOP;

  -- Trigger execution does not require EXECUTE on the trigger function. An
  -- application-writable inbox plus an owner-owned SECURITY DEFINER trigger
  -- can therefore mutate the quarantined table even when every routine ACL is
  -- revoked. Detect catalog dependencies and stored definitions across all
  -- schemas, and leave any unknown trigger topology untouched for review.
  FOR v_trigger IN
    SELECT
      trigger_row.oid AS trigger_oid,
      trigger_row.tgrelid AS trigger_relation_oid,
      trigger_row.tgname AS trigger_name,
      routine.oid AS routine_oid,
      pg_catalog.format(
        '%I.%I',
        trigger_namespace.nspname,
        trigger_relation.relname
      ) AS trigger_relation_identity,
      pg_catalog.format(
        '%I.%I(%s)',
        routine_namespace.nspname,
        routine.proname,
        pg_catalog.pg_get_function_identity_arguments(routine.oid)
      ) AS routine_identity
    FROM pg_catalog.pg_trigger AS trigger_row
    JOIN pg_catalog.pg_class AS trigger_relation
      ON trigger_relation.oid = trigger_row.tgrelid
    JOIN pg_catalog.pg_namespace AS trigger_namespace
      ON trigger_namespace.oid = trigger_relation.relnamespace
    JOIN pg_catalog.pg_proc AS routine
      ON routine.oid = trigger_row.tgfoid
    JOIN pg_catalog.pg_namespace AS routine_namespace
      ON routine_namespace.oid = routine.pronamespace
    WHERE NOT trigger_row.tgisinternal
      AND routine.prosecdef
      AND (
        pg_catalog.pg_get_functiondef(routine.oid)
          ILIKE '%trader_daily_snapshots%'
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_depend AS routine_dependency
          WHERE routine_dependency.classid = 'pg_catalog.pg_proc'::regclass
            AND routine_dependency.objid = routine.oid
            AND routine_dependency.refclassid = 'pg_catalog.pg_class'::regclass
            AND routine_dependency.refobjid = v_relation
        )
      )
    ORDER BY
      trigger_namespace.nspname,
      trigger_relation.relname,
      trigger_row.tgname
  LOOP
    FOREACH v_role IN ARRAY ARRAY[
      'anon',
      'authenticated',
      'service_role'
    ]::name[]
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE'
      ]::text[]
      LOOP
        IF pg_catalog.has_table_privilege(
          v_role,
          v_trigger.trigger_relation_oid,
          v_privilege
        ) THEN
          RAISE EXCEPTION
            '% can fire SECURITY DEFINER daily snapshot trigger % on % via %',
            v_role,
            v_trigger.trigger_name,
            v_trigger.trigger_relation_identity,
            v_trigger.routine_identity;
        END IF;
      END LOOP;

      FOR v_column IN
        SELECT attribute.attname
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_trigger.trigger_relation_oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
        ORDER BY attribute.attnum
      LOOP
        FOREACH v_privilege IN ARRAY ARRAY[
          'INSERT',
          'UPDATE'
        ]::text[]
        LOOP
          IF pg_catalog.has_column_privilege(
            v_role,
            v_trigger.trigger_relation_oid,
            v_column,
            v_privilege
          ) THEN
            RAISE EXCEPTION
              '% can fire SECURITY DEFINER daily snapshot trigger % on %.% via column %',
              v_role,
              v_trigger.trigger_name,
              v_trigger.trigger_relation_identity,
              v_column,
              v_privilege;
          END IF;
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;

  -- Unknown caller-visible SECURITY DEFINER routines are also owner paths.
  -- Scan every non-system schema, not only public: exposed-schema settings are
  -- deployment state and cannot be inferred from this repository. Known
  -- public legacy routines are excluded here because this migration revokes
  -- them by catalog identity below.
  FOR v_routine IN
    SELECT
      routine.oid,
      routine.proname,
      namespace.oid AS namespace_oid,
      namespace.nspname,
      pg_catalog.format(
        '%I.%I(%s)',
        namespace.nspname,
        routine.proname,
        pg_catalog.pg_get_function_identity_arguments(routine.oid)
      ) AS identity
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE routine.prokind IN ('f', 'p')
      AND routine.prosecdef
      AND namespace.nspname <> 'pg_catalog'
      AND namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND NOT (
        namespace.nspname = 'public'
        AND routine.proname = ANY (
          ARRAY[
            'cleanup_all_data_violations',
            'cleanup_snapshot_violations',
            'cleanup_stale_data',
            'exec_sql',
            'get_latest_prev_snapshots',
            'get_latest_snapshots_for_date'
          ]::name[]
        )
      )
      AND (
        pg_catalog.pg_get_functiondef(routine.oid)
          ILIKE '%trader_daily_snapshots%'
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_depend AS routine_dependency
          WHERE routine_dependency.classid = 'pg_catalog.pg_proc'::regclass
            AND routine_dependency.objid = routine.oid
            AND routine_dependency.refclassid = 'pg_catalog.pg_class'::regclass
            AND routine_dependency.refobjid = v_relation
        )
      )
    ORDER BY namespace.nspname, routine.proname, routine.oid
  LOOP
    FOREACH v_role IN ARRAY ARRAY[
      'anon',
      'authenticated',
      'service_role'
    ]::name[]
    LOOP
      IF pg_catalog.has_schema_privilege(
        v_role,
        v_routine.namespace_oid,
        'USAGE'
      ) AND pg_catalog.has_function_privilege(
        v_role,
        v_routine.oid,
        'EXECUTE'
      ) THEN
        RAISE EXCEPTION
          'unreviewed SECURITY DEFINER daily snapshot routine % is callable by %',
          v_routine.identity,
          v_role;
      END IF;
    END LOOP;
  END LOOP;
END
$preflight$;

LOCK TABLE public.trader_daily_snapshots IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.trader_daily_snapshots ENABLE ROW LEVEL SECURITY;

-- Limit the ACL mutation to known application roles. Unknown operator/backup
-- grants remain intact; inherited application access is detected below and
-- causes the entire transaction to roll back for explicit operator review.
REVOKE ALL PRIVILEGES
  ON TABLE public.trader_daily_snapshots
  FROM PUBLIC, anon, authenticated, service_role;

-- Column ACLs are independent from table ACLs. Remove every non-owner column
-- grant held by a known application role. Do not mutate third-party roles.
DO $revoke_application_column_acl$
DECLARE
  v_relation regclass := 'public.trader_daily_snapshots'::regclass;
  v_column_list text;
BEGIN
  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', '
    ORDER BY attribute.attnum
  )
  INTO v_column_list
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = v_relation
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF v_column_list IS NULL THEN
    RAISE EXCEPTION 'public.trader_daily_snapshots has no columns to secure';
  END IF;

  EXECUTE pg_catalog.format(
    'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), '
      || 'REFERENCES (%1$s) ON TABLE public.trader_daily_snapshots '
      || 'FROM PUBLIC, anon, authenticated, service_role',
    v_column_list
  );
END
$revoke_application_column_acl$;

-- Drop only the two checked-in legacy policies plus our replay-safe policy.
-- The preflight above rejects unknown policies without mutating them.
DROP POLICY IF EXISTS "trader_daily_snapshots_select_all"
  ON public.trader_daily_snapshots;
DROP POLICY IF EXISTS "trader_daily_snapshots_service_role_write"
  ON public.trader_daily_snapshots;
DROP POLICY IF EXISTS "Service role reads quarantined daily snapshots"
  ON public.trader_daily_snapshots;

GRANT SELECT
  ON TABLE public.trader_daily_snapshots
  TO service_role;

CREATE POLICY "Service role reads quarantined daily snapshots"
  ON public.trader_daily_snapshots
  AS PERMISSIVE
  FOR SELECT
  TO service_role
  USING (true);

COMMENT ON POLICY "Service role reads quarantined daily snapshots"
  ON public.trader_daily_snapshots IS
  'Legacy forensic rows are service-readable but have no runtime writer authority.';

-- Function EXECUTE defaults to PUBLIC and can bypass table ACLs when an old
-- helper is SECURITY DEFINER. Resolve every live overload from pg_proc so the
-- migration does not guess signatures or return types. The two get_latest_*
-- helpers belonged to the retired aggregation path; the cleanup helpers are
-- retired mutation paths. exec_sql is an unversioned generic SQL executor and
-- cannot coexist with a service_role write freeze. Function owners retain
-- operator-only authority; unrelated operator/backup grants are not mutated.
DO $revoke_retired_daily_snapshot_routines$
DECLARE
  v_routine record;
BEGIN
  FOR v_routine IN
    SELECT
      routine.oid,
      routine.proowner,
      pg_catalog.format(
        '%I.%I(%s)',
        namespace.nspname,
        routine.proname,
        pg_catalog.pg_get_function_identity_arguments(routine.oid)
      ) AS identity
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'public'
      AND routine.prokind = 'f'
      AND routine.proname = ANY (
        ARRAY[
          'cleanup_all_data_violations',
          'cleanup_snapshot_violations',
          'cleanup_stale_data',
          'exec_sql',
          'get_latest_prev_snapshots',
          'get_latest_snapshots_for_date'
        ]::name[]
      )
    ORDER BY routine.proname, routine.oid
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s '
        || 'FROM PUBLIC, anon, authenticated, service_role',
      v_routine.identity
    );
  END LOOP;
END
$revoke_retired_daily_snapshot_routines$;

COMMENT ON TABLE public.trader_daily_snapshots IS
  'QUARANTINED legacy daily snapshot projection: rows preserved for operator forensics; service_role SELECT only; not a published product-data authority.';

DO $postflight$
DECLARE
  v_relation regclass := 'public.trader_daily_snapshots'::regclass;
  v_anon_role_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'anon'
  );
  v_authenticated_role_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticated'
  );
  v_service_role_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_role name;
  v_privilege text;
  v_column name;
  v_routine record;
BEGIN
  IF NOT (
    SELECT relation.relrowsecurity
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation
  ) THEN
    RAISE EXCEPTION
      'row level security is not enabled on public.trader_daily_snapshots';
  END IF;

  -- Unknown operator/backup ACLs are intentionally preserved. The known
  -- application ACLs must converge to only service_role SELECT.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = v_relation
      AND (
        acl_entry.grantee IN (
          0::oid,
          v_anon_role_oid,
          v_authenticated_role_oid
        )
        OR (
          acl_entry.grantee = v_service_role_oid
          AND NOT (
            acl_entry.privilege_type = 'SELECT'
            AND NOT acl_entry.is_grantable
          )
        )
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = v_relation
      AND acl_entry.grantee = v_service_role_oid
      AND acl_entry.privilege_type = 'SELECT'
      AND NOT acl_entry.is_grantable
  ) <> 1 THEN
    RAISE EXCEPTION
      'application table ACL is not service_role SELECT-only';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee IN (
        0::oid,
        v_anon_role_oid,
        v_authenticated_role_oid,
        v_service_role_oid
      )
  ) THEN
    RAISE EXCEPTION
      'application-role column ACL remains on public.trader_daily_snapshots';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
  LOOP
    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(
        v_role,
        v_relation,
        v_privilege
      ) THEN
        RAISE EXCEPTION
          '% still has % on public.trader_daily_snapshots',
          v_role,
          v_privilege;
      END IF;
    END LOOP;

    FOR v_column IN
      SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attnum
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'SELECT',
        'INSERT',
        'UPDATE',
        'REFERENCES'
      ]::text[]
      LOOP
        IF pg_catalog.has_column_privilege(
          v_role,
          v_relation,
          v_column,
          v_privilege
        ) THEN
          RAISE EXCEPTION
            '% still has column % on public.trader_daily_snapshots.%',
            v_role,
            v_privilege,
            v_column;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  IF NOT pg_catalog.has_table_privilege(
    'service_role',
    v_relation,
    'SELECT'
  ) THEN
    RAISE EXCEPTION
      'service_role is missing SELECT on public.trader_daily_snapshots';
  END IF;

  IF pg_catalog.has_table_privilege(
    'service_role',
    v_relation,
    'SELECT WITH GRANT OPTION'
  ) THEN
    RAISE EXCEPTION
      'service_role can delegate SELECT on public.trader_daily_snapshots';
  END IF;

  FOREACH v_privilege IN ARRAY ARRAY[
    'INSERT',
    'UPDATE',
    'DELETE',
    'TRUNCATE',
    'REFERENCES',
    'TRIGGER'
  ]::text[]
  LOOP
    IF pg_catalog.has_table_privilege(
      'service_role',
      v_relation,
      v_privilege
    ) THEN
      RAISE EXCEPTION
        'service_role still has % on public.trader_daily_snapshots',
        v_privilege;
    END IF;
  END LOOP;

  -- Table-level checks do not expose privileges inherited from a role that
  -- holds column-only grants. Reject every effective service write grant and
  -- any delegable column SELECT before claiming the table is read-only.
  FOR v_column IN
    SELECT attribute.attname
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    ORDER BY attribute.attnum
  LOOP
    FOREACH v_privilege IN ARRAY ARRAY[
      'INSERT',
      'UPDATE',
      'REFERENCES',
      'SELECT WITH GRANT OPTION'
    ]::text[]
    LOOP
      IF pg_catalog.has_column_privilege(
        'service_role',
        v_relation,
        v_column,
        v_privilege
      ) THEN
        RAISE EXCEPTION
          'service_role still has column % on public.trader_daily_snapshots.%',
          v_privilege,
          v_column;
      END IF;
    END LOOP;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_relation
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_relation
      AND policy.polname = 'Service role reads quarantined daily snapshots'
      AND policy.polpermissive
      AND policy.polcmd = 'r'
      AND policy.polroles = ARRAY[v_service_role_oid]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND policy.polwithcheck IS NULL
  ) THEN
    RAISE EXCEPTION
      'trader_daily_snapshots RLS policies are not exact service read-only';
  END IF;

  FOR v_routine IN
    SELECT routine.oid, routine.proowner, routine.proname
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'public'
      AND routine.prokind = 'f'
      AND routine.proname = ANY (
        ARRAY[
          'cleanup_all_data_violations',
          'cleanup_snapshot_violations',
          'cleanup_stale_data',
          'exec_sql',
          'get_latest_prev_snapshots',
          'get_latest_snapshots_for_date'
        ]::name[]
      )
    ORDER BY routine.proname, routine.oid
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          routine.proacl,
          pg_catalog.acldefault('f', routine.proowner)
        )
      ) AS acl_entry
      WHERE routine.oid = v_routine.oid
        AND acl_entry.grantee IN (
          0::oid,
          v_anon_role_oid,
          v_authenticated_role_oid,
          v_service_role_oid
        )
    ) THEN
      RAISE EXCEPTION
        'application EXECUTE ACL remains on retired routine % (oid %)',
        v_routine.proname,
        v_routine.oid;
    END IF;

    FOREACH v_role IN ARRAY ARRAY[
      'anon',
      'authenticated',
      'service_role'
    ]::name[]
    LOOP
      IF pg_catalog.has_function_privilege(
        v_role,
        v_routine.oid,
        'EXECUTE'
      ) THEN
        RAISE EXCEPTION
          '% still has EXECUTE on retired routine % (oid %)',
          v_role,
          v_routine.proname,
          v_routine.oid;
      END IF;
    END LOOP;
  END LOOP;

  -- Recheck caller-visible SECURITY DEFINER paths after the known public
  -- routine revocations. Unknown routines are never mutated here.
  FOR v_routine IN
    SELECT
      routine.oid,
      routine.proname,
      namespace.oid AS namespace_oid,
      pg_catalog.format(
        '%I.%I(%s)',
        namespace.nspname,
        routine.proname,
        pg_catalog.pg_get_function_identity_arguments(routine.oid)
      ) AS identity
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE routine.prokind IN ('f', 'p')
      AND routine.prosecdef
      AND namespace.nspname <> 'pg_catalog'
      AND namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND (
        pg_catalog.pg_get_functiondef(routine.oid)
          ILIKE '%trader_daily_snapshots%'
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_depend AS routine_dependency
          WHERE routine_dependency.classid = 'pg_catalog.pg_proc'::regclass
            AND routine_dependency.objid = routine.oid
            AND routine_dependency.refclassid = 'pg_catalog.pg_class'::regclass
            AND routine_dependency.refobjid = v_relation
        )
      )
    ORDER BY namespace.nspname, routine.proname, routine.oid
  LOOP
    FOREACH v_role IN ARRAY ARRAY[
      'anon',
      'authenticated',
      'service_role'
    ]::name[]
    LOOP
      IF pg_catalog.has_schema_privilege(
        v_role,
        v_routine.namespace_oid,
        'USAGE'
      ) AND pg_catalog.has_function_privilege(
        v_role,
        v_routine.oid,
        'EXECUTE'
      ) THEN
        RAISE EXCEPTION
          'unreviewed SECURITY DEFINER daily snapshot routine % is callable by %',
          v_routine.identity,
          v_role;
      END IF;
    END LOOP;
  END LOOP;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
