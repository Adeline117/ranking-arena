-- Forward replacement for 20260817061000_legacy_raw_metric_publication_isolation.sql, which was never applied to
-- production and cannot apply there: its role-graph guards reject the
-- Supabase-managed memberships every hosted project carries (see
-- docs/LAUNCH_REHEARSAL_2026-11-11.md, class A). The body is that migration
-- unchanged except for the shared managed-edge preamble before the preflight
-- and the guards reading the filtered graph, plus one more change: the
-- event-trigger executor check also accepts a member of the supautils
-- privileged role, because the hosted postgres is not a superuser. Apply this
-- file instead of the original; the original stays immutable in history.
--
-- Legacy public relations below contain raw trajectories, prices, cost basis,
-- position snapshots, or derived metrics with no immutable public publication
-- contract. Application routes now return an explicit unavailable envelope;
-- direct PostgREST and public-RPC access must not bypass that boundary.
--
-- This is metadata-only. It preserves rows, schemas, indexes, constraints, and
-- the internal service CRUD contract while converging every existing attached
-- partition to a service-only surface.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL TIME ZONE 'UTC';

-- Supabase platform-managed role edges (production catalog evidence,
-- 2026-11-11). The hosted project always carries three memberships that the
-- role-graph guards below would otherwise treat as an unsafe authority path:
--   * cli_login_postgres has SET-only membership in postgres (Supabase CLI
--     login with short-lived credentials);
--   * supabase_storage_admin has SET-only membership in authenticator (the
--     Storage API's PostgREST-equivalent gateway);
--   * postgres is a member of authenticator (postgres is the trusted owner).
-- Those exact edges are removed from the graph the guards inspect. The
-- exclusion is only sound while neither managed login role can itself be
-- entered or escalated, so that is checked first and fails closed.
CREATE TEMPORARY TABLE arena_guard_auth_members ON COMMIT DROP AS
SELECT membership.*
FROM pg_catalog.pg_auth_members AS membership
WHERE NOT (
  (
    membership.roleid = pg_catalog.to_regrole('postgres')
    AND membership.member IS NOT DISTINCT FROM pg_catalog.to_regrole('cli_login_postgres')
    AND NOT membership.admin_option
    AND NOT membership.inherit_option
    AND membership.set_option
  )
  OR (
    membership.roleid IS NOT DISTINCT FROM pg_catalog.to_regrole('authenticator')
    AND membership.member IS NOT DISTINCT FROM pg_catalog.to_regrole('supabase_storage_admin')
    AND NOT membership.admin_option
    AND NOT membership.inherit_option
    AND membership.set_option
  )
  OR (
    membership.roleid IS NOT DISTINCT FROM pg_catalog.to_regrole('authenticator')
    AND membership.member = pg_catalog.to_regrole('postgres')
  )
);

DO $supabase_managed_role_edges$
BEGIN
  IF EXISTS (
       SELECT 1
       FROM pg_catalog.pg_auth_members AS membership
       WHERE membership.roleid IN (
         SELECT role_row.oid
         FROM pg_catalog.pg_roles AS role_row
         WHERE role_row.rolname IN ('cli_login_postgres', 'supabase_storage_admin')
       )
     ) OR EXISTS (
       -- Same exact role shape as the July group-entitlement guards: a
       -- NOINHERIT login bridge with no other attribute. Supabase Storage's
       -- admin carries CREATEROLE on the hosted project; under PostgreSQL 16+
       -- that only reaches roles it holds ADMIN on, and it holds none here.
       SELECT 1
       FROM pg_catalog.pg_roles AS role_row
       WHERE role_row.rolname IN ('cli_login_postgres', 'supabase_storage_admin')
         AND (
           NOT role_row.rolcanlogin
           OR role_row.rolinherit
           OR role_row.rolsuper
           OR role_row.rolcreatedb
           OR role_row.rolreplication
           OR role_row.rolbypassrls
           OR (
             role_row.rolname = 'cli_login_postgres'
             AND role_row.rolcreaterole
           )
         )
     ) OR EXISTS (
       -- Neither managed bridge may hold ADMIN, INHERIT, or SET on any other
       -- role beyond its single documented edge.
       SELECT 1
       FROM pg_catalog.pg_auth_members AS membership
       JOIN pg_catalog.pg_roles AS role_row
         ON role_row.oid = membership.member
       WHERE role_row.rolname IN ('cli_login_postgres', 'supabase_storage_admin')
         AND NOT (
           (
             role_row.rolname = 'cli_login_postgres'
             AND membership.roleid = pg_catalog.to_regrole('postgres')
           )
           OR (
             role_row.rolname = 'supabase_storage_admin'
             AND membership.roleid IS NOT DISTINCT FROM pg_catalog.to_regrole('authenticator')
           )
         )
     ) THEN
    RAISE EXCEPTION
      'Supabase-managed login roles must not be enterable or privileged';
  END IF;
END
$supabase_managed_role_edges$;

DO $preflight$
DECLARE
  v_root_name text;
  v_root oid;
  v_kind "char";
  v_service oid := pg_catalog.to_regrole('service_role');
  v_authenticator oid := pg_catalog.to_regrole('authenticator');
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_cross_schema_relations text;
BEGIN
  FOREACH v_root_name IN ARRAY ARRAY[
    'public.trader_daily_snapshots',
    'public.trader_equity_curve',
    'public.trader_timeseries',
    'public.trader_portfolio',
    'public.trader_asset_breakdown',
    'public.trader_stats_detail',
    'public.trader_roi_history',
    'public.trader_positions_live',
    'public.trader_positions_history',
    'public.trader_position_summary'
  ]::text[]
  LOOP
    v_root := pg_catalog.to_regclass(v_root_name);
    IF v_root IS NULL THEN
      RAISE EXCEPTION 'legacy raw metric isolation requires %', v_root_name;
    END IF;

    SELECT relation.relkind
    INTO STRICT v_kind
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_root;

    IF v_kind NOT IN ('r', 'p') THEN
      RAISE EXCEPTION
        'legacy raw metric isolation requires a table or partitioned table for %, got %',
        v_root_name,
        v_kind;
    END IF;
  END LOOP;

  IF pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR v_service IS NULL
     OR v_authenticator IS NULL
     OR v_postgres IS NULL THEN
    RAISE EXCEPTION 'legacy raw metric isolation requires Supabase runtime roles';
  END IF;
  -- The partition event trigger needs an executor that may create event
  -- triggers: a superuser, or (on the hosted project, where postgres is not
  -- a superuser) a member of the supautils privileged role. Under supautils
  -- the trigger is owned by postgres and fires for non-superuser DDL, which
  -- covers the postgres-run partition maintenance. The setting is only a hint:
  -- without supautils loaded, PostgreSQL itself still refuses CREATE EVENT
  -- TRIGGER to a non-superuser below, so a spoofed value cannot widen access.
  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_roles AS role_row
       WHERE role_row.rolname = current_user
         AND role_row.rolsuper
     )
     AND NOT COALESCE(
       CASE
         WHEN pg_catalog.to_regrole(
           NULLIF(pg_catalog.current_setting('supautils.privileged_role', true), '')
         ) IS NOT NULL
         THEN pg_catalog.pg_has_role(
           current_user,
           pg_catalog.to_regrole(pg_catalog.current_setting('supautils.privileged_role', true)),
           'MEMBER'
         )
       END,
       false
     ) THEN
    RAISE EXCEPTION
      'legacy raw metric isolation requires a superuser or supautils privileged migration executor for partition event triggers';
  END IF;

  -- service_role may deliberately bypass RLS for server-side ingest, but it
  -- must not be a database-login or role-administration escape hatch.
  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_roles AS role_row
       WHERE role_row.oid = v_service
         AND NOT role_row.rolcanlogin
         AND NOT role_row.rolsuper
         AND NOT role_row.rolcreaterole
         AND NOT role_row.rolcreatedb
         AND NOT role_row.rolreplication
     ) THEN
    RAISE EXCEPTION 'legacy raw metric service role posture is unsafe';
  END IF;

  -- The sole non-owner route to service_role is PostgREST's trusted gateway.
  -- Any inherited, SET, or ADMIN-capable alternate path makes a service-only
  -- relation browser-readable, so reject it before modifying an ACL.
  IF NOT EXISTS (
       SELECT 1
       FROM pg_temp.arena_guard_auth_members AS membership
       WHERE membership.roleid = v_service
         AND membership.member = v_authenticator
         AND NOT membership.admin_option
         AND NOT membership.inherit_option
         AND membership.set_option
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_roles AS role_row
       WHERE role_row.oid = v_authenticator
         AND role_row.rolcanlogin
         AND NOT role_row.rolinherit
         AND NOT role_row.rolsuper
         AND NOT role_row.rolcreaterole
         AND NOT role_row.rolcreatedb
         AND NOT role_row.rolreplication
         AND NOT role_row.rolbypassrls
     ) OR EXISTS (
       SELECT 1
       FROM pg_temp.arena_guard_auth_members AS membership
       WHERE membership.roleid = v_service
         AND membership.member NOT IN (v_authenticator, v_postgres)
     ) OR EXISTS (
       SELECT 1
       FROM pg_temp.arena_guard_auth_members AS membership
       WHERE membership.roleid = v_postgres
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_roles AS role_row
       WHERE role_row.rolname IN ('anon', 'authenticated')
         AND (role_row.rolsuper OR role_row.rolbypassrls)
     ) OR EXISTS (
       WITH RECURSIVE service_authority(member_oid, path) AS (
         SELECT membership.member, ARRAY[v_service, membership.member]::oid[]
         FROM pg_temp.arena_guard_auth_members AS membership
         WHERE membership.roleid = v_service
           AND (membership.admin_option OR membership.inherit_option OR membership.set_option)

         UNION ALL

         SELECT membership.member, authority.path || membership.member
         FROM service_authority AS authority
         JOIN pg_temp.arena_guard_auth_members AS membership
           ON membership.roleid = authority.member_oid
         WHERE (membership.admin_option OR membership.inherit_option OR membership.set_option)
           AND NOT (membership.member = ANY(authority.path))
       )
       SELECT 1
       FROM service_authority AS authority
       WHERE authority.path <> ARRAY[v_service, v_postgres]::oid[]
         AND NOT (
           authority.path = ARRAY[v_service, v_authenticator]::oid[]
           AND EXISTS (
             SELECT 1
             FROM pg_temp.arena_guard_auth_members AS membership
             WHERE membership.roleid = v_service
               AND membership.member = v_authenticator
               AND NOT membership.admin_option
               AND NOT membership.inherit_option
               AND membership.set_option
           )
         )
     ) OR EXISTS (
       WITH RECURSIVE postgres_authority(member_oid, path) AS (
         SELECT membership.member, ARRAY[v_postgres, membership.member]::oid[]
         FROM pg_temp.arena_guard_auth_members AS membership
         WHERE membership.roleid = v_postgres
           AND (membership.admin_option OR membership.inherit_option OR membership.set_option)

         UNION ALL

         SELECT membership.member, authority.path || membership.member
         FROM postgres_authority AS authority
         JOIN pg_temp.arena_guard_auth_members AS membership
           ON membership.roleid = authority.member_oid
         WHERE (membership.admin_option OR membership.inherit_option OR membership.set_option)
           AND NOT (membership.member = ANY(authority.path))
       )
       SELECT 1 FROM postgres_authority
     ) OR EXISTS (
       WITH RECURSIVE service_upstream(role_oid, path) AS (
         SELECT membership.roleid, ARRAY[v_service, membership.roleid]::oid[]
         FROM pg_temp.arena_guard_auth_members AS membership
         WHERE membership.member = v_service
           AND (membership.admin_option OR membership.inherit_option OR membership.set_option)

         UNION ALL

         SELECT membership.roleid, authority.path || membership.roleid
         FROM service_upstream AS authority
         JOIN pg_temp.arena_guard_auth_members AS membership
           ON membership.member = authority.role_oid
         WHERE (membership.admin_option OR membership.inherit_option OR membership.set_option)
           AND NOT (membership.roleid = ANY(authority.path))
       )
       SELECT 1 FROM service_upstream
     ) THEN
    RAISE EXCEPTION 'legacy raw metric service authority graph is unsafe';
  END IF;

  WITH RECURSIVE roots(root_relid, relid) AS (
    VALUES
      ('public.trader_daily_snapshots'::pg_catalog.regclass::oid, 'public.trader_daily_snapshots'::pg_catalog.regclass::oid),
      ('public.trader_equity_curve'::pg_catalog.regclass::oid, 'public.trader_equity_curve'::pg_catalog.regclass::oid),
      ('public.trader_timeseries'::pg_catalog.regclass::oid, 'public.trader_timeseries'::pg_catalog.regclass::oid),
      ('public.trader_portfolio'::pg_catalog.regclass::oid, 'public.trader_portfolio'::pg_catalog.regclass::oid),
      ('public.trader_asset_breakdown'::pg_catalog.regclass::oid, 'public.trader_asset_breakdown'::pg_catalog.regclass::oid),
      ('public.trader_stats_detail'::pg_catalog.regclass::oid, 'public.trader_stats_detail'::pg_catalog.regclass::oid),
      ('public.trader_roi_history'::pg_catalog.regclass::oid, 'public.trader_roi_history'::pg_catalog.regclass::oid),
      ('public.trader_positions_live'::pg_catalog.regclass::oid, 'public.trader_positions_live'::pg_catalog.regclass::oid),
      ('public.trader_positions_history'::pg_catalog.regclass::oid, 'public.trader_positions_history'::pg_catalog.regclass::oid),
      ('public.trader_position_summary'::pg_catalog.regclass::oid, 'public.trader_position_summary'::pg_catalog.regclass::oid)
  ), relation_tree(root_relid, relid) AS (
    SELECT root_relid, relid FROM roots
    UNION
    SELECT tree.root_relid, inheritance.inhrelid
    FROM relation_tree AS tree
    JOIN pg_catalog.pg_inherits AS inheritance
      ON inheritance.inhparent = tree.relid
  )
  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I.%I', namespace_row.nspname, relation.relname),
    ', ' ORDER BY namespace_row.nspname, relation.relname
  )
  INTO v_cross_schema_relations
  FROM relation_tree AS tree
  JOIN pg_catalog.pg_class AS relation
    ON relation.oid = tree.relid
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = relation.relnamespace
  WHERE namespace_row.nspname <> 'public';

  IF v_cross_schema_relations IS NOT NULL THEN
    RAISE EXCEPTION
      'legacy raw metric isolation refuses cross-schema attached relations: %',
      v_cross_schema_relations;
  END IF;
END
$preflight$;

-- Lock all existing roots and descendants. The transaction protects the
-- complete ACL/RLS convergence pass from writes or concurrent partition work.
DO $lock_relations$
DECLARE
  v_relation record;
BEGIN
  FOR v_relation IN
    WITH RECURSIVE roots(root_relid, relid) AS (
      VALUES
        ('public.trader_daily_snapshots'::pg_catalog.regclass::oid, 'public.trader_daily_snapshots'::pg_catalog.regclass::oid),
        ('public.trader_equity_curve'::pg_catalog.regclass::oid, 'public.trader_equity_curve'::pg_catalog.regclass::oid),
        ('public.trader_timeseries'::pg_catalog.regclass::oid, 'public.trader_timeseries'::pg_catalog.regclass::oid),
        ('public.trader_portfolio'::pg_catalog.regclass::oid, 'public.trader_portfolio'::pg_catalog.regclass::oid),
        ('public.trader_asset_breakdown'::pg_catalog.regclass::oid, 'public.trader_asset_breakdown'::pg_catalog.regclass::oid),
        ('public.trader_stats_detail'::pg_catalog.regclass::oid, 'public.trader_stats_detail'::pg_catalog.regclass::oid),
        ('public.trader_roi_history'::pg_catalog.regclass::oid, 'public.trader_roi_history'::pg_catalog.regclass::oid),
        ('public.trader_positions_live'::pg_catalog.regclass::oid, 'public.trader_positions_live'::pg_catalog.regclass::oid),
        ('public.trader_positions_history'::pg_catalog.regclass::oid, 'public.trader_positions_history'::pg_catalog.regclass::oid),
        ('public.trader_position_summary'::pg_catalog.regclass::oid, 'public.trader_position_summary'::pg_catalog.regclass::oid)
    ), relation_tree(root_relid, relid) AS (
      SELECT root_relid, relid FROM roots
      UNION
      SELECT tree.root_relid, inheritance.inhrelid
      FROM relation_tree AS tree
      JOIN pg_catalog.pg_inherits AS inheritance
        ON inheritance.inhparent = tree.relid
    )
    SELECT namespace_row.nspname, relation.relname
    FROM relation_tree AS tree
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = tree.relid
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = relation.relnamespace
    ORDER BY namespace_row.nspname, relation.relname
  LOOP
    EXECUTE pg_catalog.format(
      'LOCK TABLE ONLY %I.%I IN ACCESS EXCLUSIVE MODE',
      v_relation.nspname,
      v_relation.relname
    );
  END LOOP;
END
$lock_relations$;

-- Remove every historical policy, table ACL, and column ACL from every
-- currently attached relation. Service CRUD is restored only on roots below;
-- children remain an implementation detail with no direct REST surface.
DO $close_relation_boundaries$
DECLARE
  v_relation record;
  v_policy_name name;
  v_grantee record;
  v_column_list text;
BEGIN
  FOR v_relation IN
    WITH RECURSIVE roots(root_relid, relid) AS (
      VALUES
        ('public.trader_daily_snapshots'::pg_catalog.regclass::oid, 'public.trader_daily_snapshots'::pg_catalog.regclass::oid),
        ('public.trader_equity_curve'::pg_catalog.regclass::oid, 'public.trader_equity_curve'::pg_catalog.regclass::oid),
        ('public.trader_timeseries'::pg_catalog.regclass::oid, 'public.trader_timeseries'::pg_catalog.regclass::oid),
        ('public.trader_portfolio'::pg_catalog.regclass::oid, 'public.trader_portfolio'::pg_catalog.regclass::oid),
        ('public.trader_asset_breakdown'::pg_catalog.regclass::oid, 'public.trader_asset_breakdown'::pg_catalog.regclass::oid),
        ('public.trader_stats_detail'::pg_catalog.regclass::oid, 'public.trader_stats_detail'::pg_catalog.regclass::oid),
        ('public.trader_roi_history'::pg_catalog.regclass::oid, 'public.trader_roi_history'::pg_catalog.regclass::oid),
        ('public.trader_positions_live'::pg_catalog.regclass::oid, 'public.trader_positions_live'::pg_catalog.regclass::oid),
        ('public.trader_positions_history'::pg_catalog.regclass::oid, 'public.trader_positions_history'::pg_catalog.regclass::oid),
        ('public.trader_position_summary'::pg_catalog.regclass::oid, 'public.trader_position_summary'::pg_catalog.regclass::oid)
    ), relation_tree(root_relid, relid) AS (
      SELECT root_relid, relid FROM roots
      UNION
      SELECT tree.root_relid, inheritance.inhrelid
      FROM relation_tree AS tree
      JOIN pg_catalog.pg_inherits AS inheritance
        ON inheritance.inhparent = tree.relid
    )
    SELECT tree.root_relid, relation.oid, namespace_row.nspname, relation.relname
    FROM relation_tree AS tree
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = tree.relid
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = relation.relnamespace
    ORDER BY tree.root_relid, relation.oid
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER TABLE %I.%I OWNER TO postgres',
      v_relation.nspname,
      v_relation.relname
    );
    EXECUTE pg_catalog.format(
      'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
      v_relation.nspname,
      v_relation.relname
    );

    FOR v_policy_name IN
      SELECT policy.polname
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_relation.oid
      ORDER BY policy.polname
    LOOP
      EXECUTE pg_catalog.format(
        'DROP POLICY %I ON %I.%I',
        v_policy_name,
        v_relation.nspname,
        v_relation.relname
      );
    END LOOP;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC CASCADE',
      v_relation.nspname,
      v_relation.relname
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM anon, authenticated, service_role CASCADE',
      v_relation.nspname,
      v_relation.relname
    );

    FOR v_grantee IN
      SELECT DISTINCT privilege.grantee, role_row.rolname
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
      ) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.oid = privilege.grantee
      WHERE relation.oid = v_relation.oid
        AND privilege.grantee <> relation.relowner
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC CASCADE',
          v_relation.nspname,
          v_relation.relname
        );
      ELSIF v_grantee.rolname IS NULL THEN
        RAISE EXCEPTION
          'legacy raw metric relation retains unresolved table ACL grantee %',
          v_grantee.grantee;
      ELSE
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I CASCADE',
          v_relation.nspname,
          v_relation.relname,
          v_grantee.rolname
        );
      END IF;
    END LOOP;

    SELECT pg_catalog.string_agg(
      pg_catalog.format('%I', attribute.attname),
      ', ' ORDER BY attribute.attnum
    )
    INTO v_column_list
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation.oid
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF v_column_list IS NOT NULL THEN
      FOR v_grantee IN
        SELECT DISTINCT privilege.grantee, role_row.rolname
        FROM pg_catalog.pg_attribute AS attribute
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
        LEFT JOIN pg_catalog.pg_roles AS role_row
          ON role_row.oid = privilege.grantee
        WHERE attribute.attrelid = v_relation.oid
          AND attribute.attacl IS NOT NULL
      LOOP
        IF v_grantee.grantee = 0 THEN
          EXECUTE pg_catalog.format(
            'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
              || 'ON TABLE %2$I.%3$I FROM PUBLIC CASCADE',
            v_column_list,
            v_relation.nspname,
            v_relation.relname
          );
        ELSIF v_grantee.rolname IS NULL THEN
          RAISE EXCEPTION
            'legacy raw metric relation retains unresolved column ACL grantee %',
            v_grantee.grantee;
        ELSIF v_grantee.rolname <> 'postgres' THEN
          EXECUTE pg_catalog.format(
            'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
              || 'ON TABLE %2$I.%3$I FROM %4$I CASCADE',
            v_column_list,
            v_relation.nspname,
            v_relation.relname,
            v_grantee.rolname
          );
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END
$close_relation_boundaries$;

DO $restore_root_capabilities$
DECLARE
  v_relation record;
BEGIN
  FOR v_relation IN
    SELECT *
    FROM (VALUES
      ('public', 'trader_daily_snapshots'),
      ('public', 'trader_equity_curve'),
      ('public', 'trader_timeseries'),
      ('public', 'trader_portfolio'),
      ('public', 'trader_asset_breakdown'),
      ('public', 'trader_stats_detail'),
      ('public', 'trader_roi_history'),
      ('public', 'trader_positions_live'),
      ('public', 'trader_positions_history'),
      ('public', 'trader_position_summary')
    ) AS roots(nspname, relname)
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO service_role',
      v_relation.nspname,
      v_relation.relname
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY raw_legacy_metric_service_only ON %I.%I '
        || 'AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true)',
      v_relation.nspname,
      v_relation.relname
    );
  END LOOP;
END
$restore_root_capabilities$;

-- Close every public function whose definition directly touches one of these
-- retained raw relations. This includes historical/phantom overloads and
-- maintenance helpers; all retain only service execution. The existing
-- 20260817060000 migration independently closes arena_core_modules and
-- arena_roi_sparklines, which read arena.trader_series rather than these
-- public relations.
DO $close_raw_functions$
DECLARE
  v_function record;
  v_grantee record;
BEGIN
  FOR v_function IN
    SELECT
      procedure.oid,
      pg_catalog.format(
        '%I.%I(%s)',
        namespace_row.nspname,
        procedure.proname,
        pg_catalog.pg_get_function_identity_arguments(procedure.oid)
      ) AS signature
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = procedure.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND procedure.prokind = 'f'
      AND procedure.prorettype <> 'pg_catalog.event_trigger'::pg_catalog.regtype
      AND (
        pg_catalog.pg_get_functiondef(procedure.oid) ~* '\m(trader_daily_snapshots|trader_equity_curve|trader_timeseries|trader_portfolio|trader_asset_breakdown|trader_stats_detail|trader_roi_history|trader_positions_live|trader_positions_history|trader_position_summary)\M'
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_depend AS dependency
          WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
            AND dependency.objid = procedure.oid
            AND dependency.refobjid IN (
              'public.trader_daily_snapshots'::pg_catalog.regclass::oid,
              'public.trader_equity_curve'::pg_catalog.regclass::oid,
              'public.trader_timeseries'::pg_catalog.regclass::oid,
              'public.trader_portfolio'::pg_catalog.regclass::oid,
              'public.trader_asset_breakdown'::pg_catalog.regclass::oid,
              'public.trader_stats_detail'::pg_catalog.regclass::oid,
              'public.trader_roi_history'::pg_catalog.regclass::oid,
              'public.trader_positions_live'::pg_catalog.regclass::oid,
              'public.trader_positions_history'::pg_catalog.regclass::oid,
              'public.trader_position_summary'::pg_catalog.regclass::oid
            )
        )
      )
    ORDER BY procedure.oid
  LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO postgres', v_function.signature);
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE',
      v_function.signature
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM anon, authenticated, service_role CASCADE',
      v_function.signature
    );

    FOR v_grantee IN
      SELECT DISTINCT privilege.grantee, role_row.rolname
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
      ) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.oid = privilege.grantee
      WHERE procedure.oid = v_function.oid
        AND privilege.grantee <> procedure.proowner
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE',
          v_function.signature
        );
      ELSIF v_grantee.rolname IS NULL THEN
        RAISE EXCEPTION
          'legacy raw metric function retains unresolved ACL grantee %',
          v_grantee.grantee;
      ELSE
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
          v_function.signature,
          v_grantee.rolname
        );
      END IF;
    END LOOP;

    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %s TO service_role',
      v_function.signature
    );
  END LOOP;
END
$close_raw_functions$;

-- A partition can be created or attached after this migration. Parent ACLs do
-- not constrain direct reads of that child, and hostile default privileges are
-- applied at CREATE TABLE time. Re-converge every attached descendant at the
-- end of CREATE/ALTER TABLE, before the DDL transaction becomes visible.
CREATE OR REPLACE FUNCTION public.converge_legacy_raw_metric_partition_children()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_relation record;
  v_policy_name name;
  v_grantee record;
  v_column_list text;
BEGIN
  IF pg_catalog.current_setting('arena.legacy_raw_metric_partition_converging', true) = 'on' THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('arena.legacy_raw_metric_partition_converging', 'on', true);

  FOR v_relation IN
    WITH RECURSIVE roots(root_relid, relid) AS (
      VALUES
        ('public.trader_daily_snapshots'::pg_catalog.regclass::oid, 'public.trader_daily_snapshots'::pg_catalog.regclass::oid),
        ('public.trader_equity_curve'::pg_catalog.regclass::oid, 'public.trader_equity_curve'::pg_catalog.regclass::oid),
        ('public.trader_timeseries'::pg_catalog.regclass::oid, 'public.trader_timeseries'::pg_catalog.regclass::oid),
        ('public.trader_portfolio'::pg_catalog.regclass::oid, 'public.trader_portfolio'::pg_catalog.regclass::oid),
        ('public.trader_asset_breakdown'::pg_catalog.regclass::oid, 'public.trader_asset_breakdown'::pg_catalog.regclass::oid),
        ('public.trader_stats_detail'::pg_catalog.regclass::oid, 'public.trader_stats_detail'::pg_catalog.regclass::oid),
        ('public.trader_roi_history'::pg_catalog.regclass::oid, 'public.trader_roi_history'::pg_catalog.regclass::oid),
        ('public.trader_positions_live'::pg_catalog.regclass::oid, 'public.trader_positions_live'::pg_catalog.regclass::oid),
        ('public.trader_positions_history'::pg_catalog.regclass::oid, 'public.trader_positions_history'::pg_catalog.regclass::oid),
        ('public.trader_position_summary'::pg_catalog.regclass::oid, 'public.trader_position_summary'::pg_catalog.regclass::oid)
    ), relation_tree(root_relid, relid) AS (
      SELECT root_relid, relid FROM roots
      UNION
      SELECT tree.root_relid, inheritance.inhrelid
      FROM relation_tree AS tree
      JOIN pg_catalog.pg_inherits AS inheritance ON inheritance.inhparent = tree.relid
    )
    SELECT relation.oid, namespace_row.nspname, relation.relname
    FROM relation_tree AS tree
    JOIN pg_catalog.pg_class AS relation ON relation.oid = tree.relid
    JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = relation.relnamespace
    WHERE tree.root_relid <> tree.relid
    ORDER BY relation.oid
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %I.%I OWNER TO postgres', v_relation.nspname, v_relation.relname);
    EXECUTE pg_catalog.format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', v_relation.nspname, v_relation.relname);
    FOR v_policy_name IN
      SELECT policy.polname FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_relation.oid
    LOOP
      EXECUTE pg_catalog.format('DROP POLICY %I ON %I.%I', v_policy_name, v_relation.nspname, v_relation.relname);
    END LOOP;
    EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC CASCADE', v_relation.nspname, v_relation.relname);
    FOR v_grantee IN
      SELECT DISTINCT privilege.grantee, role_row.rolname
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS role_row ON role_row.oid = privilege.grantee
      WHERE relation.oid = v_relation.oid AND privilege.grantee <> relation.relowner
    LOOP
      IF v_grantee.rolname IS NULL AND v_grantee.grantee <> 0 THEN
        RAISE EXCEPTION 'legacy raw metric future child has unresolved ACL grantee %', v_grantee.grantee;
      END IF;
      EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %s CASCADE',
        v_relation.nspname, v_relation.relname,
        CASE WHEN v_grantee.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(v_grantee.rolname) END);
    END LOOP;
    SELECT pg_catalog.string_agg(pg_catalog.format('%I', attribute.attname), ', ' ORDER BY attribute.attnum)
    INTO v_column_list
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped;
    IF v_column_list IS NOT NULL THEN
      FOR v_grantee IN
        SELECT DISTINCT privilege.grantee, role_row.rolname
        FROM pg_catalog.pg_attribute AS attribute
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
        LEFT JOIN pg_catalog.pg_roles AS role_row ON role_row.oid = privilege.grantee
        WHERE attribute.attrelid = v_relation.oid AND attribute.attacl IS NOT NULL
      LOOP
        IF v_grantee.rolname IS NULL AND v_grantee.grantee <> 0 THEN
          RAISE EXCEPTION 'legacy raw metric future child has unresolved column ACL grantee %', v_grantee.grantee;
        END IF;
        EXECUTE pg_catalog.format(
          'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) ON TABLE %2$I.%3$I FROM %4$s CASCADE',
          v_column_list, v_relation.nspname, v_relation.relname,
          CASE WHEN v_grantee.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(v_grantee.rolname) END
        );
      END LOOP;
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('arena.legacy_raw_metric_partition_converging', 'off', true);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('arena.legacy_raw_metric_partition_converging', 'off', true);
  RAISE;
END
$function$;

ALTER FUNCTION public.converge_legacy_raw_metric_partition_children() OWNER TO postgres;
REVOKE ALL PRIVILEGES ON FUNCTION public.converge_legacy_raw_metric_partition_children()
  FROM PUBLIC, anon, authenticated, service_role;

DO $partition_event_trigger$
DECLARE
  v_trigger oid;
BEGIN
  SELECT event_trigger.oid
  INTO v_trigger
  FROM pg_catalog.pg_event_trigger AS event_trigger
  WHERE event_trigger.evtname = 'legacy_raw_metric_partition_child_convergence';

  IF v_trigger IS NULL THEN
    CREATE EVENT TRIGGER legacy_raw_metric_partition_child_convergence
      ON ddl_command_end
      WHEN TAG IN ('CREATE TABLE', 'ALTER TABLE')
      EXECUTE FUNCTION public.converge_legacy_raw_metric_partition_children();
  ELSIF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_event_trigger AS event_trigger
    WHERE event_trigger.oid = v_trigger
      AND event_trigger.evtevent = 'ddl_command_end'
      AND event_trigger.evtenabled = 'O'
      AND event_trigger.evtowner = 'postgres'::pg_catalog.regrole
      AND event_trigger.evtfoid = 'public.converge_legacy_raw_metric_partition_children()'::pg_catalog.regprocedure
      AND event_trigger.evttags @> ARRAY['CREATE TABLE', 'ALTER TABLE']::text[]
  ) THEN
    RAISE EXCEPTION 'legacy raw metric partition convergence trigger is unsafe';
  END IF;
END
$partition_event_trigger$;

DO $postflight$
DECLARE
  v_relation record;
  v_function record;
  v_owner oid;
  v_role name;
  v_privilege text;
  v_service oid := 'service_role'::pg_catalog.regrole;
  v_authenticator oid := 'authenticator'::pg_catalog.regrole;
  v_postgres oid := 'postgres'::pg_catalog.regrole;
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_roles AS role_row
       WHERE role_row.oid = v_service
         AND NOT role_row.rolcanlogin
         AND NOT role_row.rolsuper
         AND NOT role_row.rolcreaterole
         AND NOT role_row.rolcreatedb
         AND NOT role_row.rolreplication
     ) THEN
    RAISE EXCEPTION 'legacy raw metric service role posture drifted after cutover';
  END IF;
  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_event_trigger AS event_trigger
       WHERE event_trigger.evtname = 'legacy_raw_metric_partition_child_convergence'
         AND event_trigger.evtevent = 'ddl_command_end'
         AND event_trigger.evtenabled = 'O'
         AND event_trigger.evtowner = v_postgres
         AND event_trigger.evtfoid =
           'public.converge_legacy_raw_metric_partition_children()'::pg_catalog.regprocedure
         AND event_trigger.evttags @> ARRAY['CREATE TABLE', 'ALTER TABLE']::text[]
     ) THEN
    RAISE EXCEPTION 'legacy raw metric partition convergence trigger drifted after cutover';
  END IF;

  FOR v_relation IN
    WITH RECURSIVE roots(root_relid, relid) AS (
      VALUES
        ('public.trader_daily_snapshots'::pg_catalog.regclass::oid, 'public.trader_daily_snapshots'::pg_catalog.regclass::oid),
        ('public.trader_equity_curve'::pg_catalog.regclass::oid, 'public.trader_equity_curve'::pg_catalog.regclass::oid),
        ('public.trader_timeseries'::pg_catalog.regclass::oid, 'public.trader_timeseries'::pg_catalog.regclass::oid),
        ('public.trader_portfolio'::pg_catalog.regclass::oid, 'public.trader_portfolio'::pg_catalog.regclass::oid),
        ('public.trader_asset_breakdown'::pg_catalog.regclass::oid, 'public.trader_asset_breakdown'::pg_catalog.regclass::oid),
        ('public.trader_stats_detail'::pg_catalog.regclass::oid, 'public.trader_stats_detail'::pg_catalog.regclass::oid),
        ('public.trader_roi_history'::pg_catalog.regclass::oid, 'public.trader_roi_history'::pg_catalog.regclass::oid),
        ('public.trader_positions_live'::pg_catalog.regclass::oid, 'public.trader_positions_live'::pg_catalog.regclass::oid),
        ('public.trader_positions_history'::pg_catalog.regclass::oid, 'public.trader_positions_history'::pg_catalog.regclass::oid),
        ('public.trader_position_summary'::pg_catalog.regclass::oid, 'public.trader_position_summary'::pg_catalog.regclass::oid)
    ), relation_tree(root_relid, relid) AS (
      SELECT root_relid, relid FROM roots
      UNION
      SELECT tree.root_relid, inheritance.inhrelid
      FROM relation_tree AS tree
      JOIN pg_catalog.pg_inherits AS inheritance
        ON inheritance.inhparent = tree.relid
    )
    SELECT tree.root_relid, tree.relid, tree.root_relid = tree.relid AS is_root
    FROM relation_tree AS tree
    ORDER BY tree.root_relid, tree.relid
  LOOP
    SELECT relation.relowner
    INTO STRICT v_owner
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation.relid;

    IF v_owner <> v_postgres
       OR NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_class AS relation
         WHERE relation.oid = v_relation.relid
           AND relation.relrowsecurity
       ) THEN
      RAISE EXCEPTION 'legacy raw metric relation ownership/RLS did not converge';
    END IF;

    IF EXISTS (
         SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
         CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
         WHERE attribute.attrelid = v_relation.relid
           AND attribute.attacl IS NOT NULL
           AND privilege.grantee <> v_owner
       ) THEN
      RAISE EXCEPTION 'legacy raw metric relation retains a non-owner column ACL';
    END IF;

    IF v_relation.is_root THEN
      IF (
           SELECT pg_catalog.count(*)
           FROM pg_catalog.pg_policy AS policy
           WHERE policy.polrelid = v_relation.relid
         ) <> 1 OR NOT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_policy AS policy
           WHERE policy.polrelid = v_relation.relid
             AND policy.polname = 'raw_legacy_metric_service_only'
             AND policy.polpermissive
             AND policy.polcmd = '*'
             AND policy.polroles = ARRAY[v_service]::oid[]
             AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
             AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
         ) THEN
        RAISE EXCEPTION 'legacy raw metric root service-only RLS policy drifted';
      END IF;

      IF EXISTS (
           SELECT 1
           FROM pg_catalog.pg_class AS relation
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
           ) AS privilege
           WHERE relation.oid = v_relation.relid
             AND privilege.grantee <> relation.relowner
             AND (
               privilege.grantee <> v_service
               OR privilege.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
               OR privilege.is_grantable
             )
         ) OR (
           SELECT pg_catalog.count(*)
           FROM pg_catalog.pg_class AS relation
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
           ) AS privilege
           WHERE relation.oid = v_relation.relid
             AND privilege.grantee = v_service
             AND privilege.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
             AND NOT privilege.is_grantable
         ) <> 4 THEN
        RAISE EXCEPTION 'legacy raw metric root retains an unsafe table ACL';
      END IF;

      FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[]
      LOOP
        IF NOT pg_catalog.has_table_privilege('service_role', v_relation.relid, v_privilege) THEN
          RAISE EXCEPTION 'legacy raw metric service role is missing root % capability', v_privilege;
        END IF;
      END LOOP;
    ELSE
      IF EXISTS (
           SELECT 1 FROM pg_catalog.pg_policy AS policy
           WHERE policy.polrelid = v_relation.relid
         ) OR EXISTS (
           SELECT 1
           FROM pg_catalog.pg_class AS relation
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
           ) AS privilege
           WHERE relation.oid = v_relation.relid
             AND privilege.grantee <> relation.relowner
         ) THEN
        RAISE EXCEPTION 'legacy raw metric attached relation retained a direct policy or ACL';
      END IF;

      IF pg_catalog.has_table_privilege('service_role', v_relation.relid, 'SELECT') THEN
        RAISE EXCEPTION 'legacy raw metric child retains direct service access';
      END IF;
    END IF;

    FOREACH v_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name]
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE',
        'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
      ]::text[]
      LOOP
        IF pg_catalog.has_table_privilege(v_role, v_relation.relid, v_privilege) THEN
          RAISE EXCEPTION
            'legacy raw metric relation remains directly reachable by % via %',
            v_role,
            v_privilege;
        END IF;
      END LOOP;

      FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']::text[]
      LOOP
        IF pg_catalog.has_any_column_privilege(v_role, v_relation.relid, v_privilege) THEN
          RAISE EXCEPTION
            'legacy raw metric relation remains column-reachable by % via %',
            v_role,
            v_privilege;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  FOR v_function IN
    SELECT procedure.oid
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = procedure.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND procedure.prokind = 'f'
      AND procedure.prorettype <> 'pg_catalog.event_trigger'::pg_catalog.regtype
      AND (
        pg_catalog.pg_get_functiondef(procedure.oid) ~* '\m(trader_daily_snapshots|trader_equity_curve|trader_timeseries|trader_portfolio|trader_asset_breakdown|trader_stats_detail|trader_roi_history|trader_positions_live|trader_positions_history|trader_position_summary)\M'
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_depend AS dependency
          WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
            AND dependency.objid = procedure.oid
            AND dependency.refobjid IN (
              'public.trader_daily_snapshots'::pg_catalog.regclass::oid,
              'public.trader_equity_curve'::pg_catalog.regclass::oid,
              'public.trader_timeseries'::pg_catalog.regclass::oid,
              'public.trader_portfolio'::pg_catalog.regclass::oid,
              'public.trader_asset_breakdown'::pg_catalog.regclass::oid,
              'public.trader_stats_detail'::pg_catalog.regclass::oid,
              'public.trader_roi_history'::pg_catalog.regclass::oid,
              'public.trader_positions_live'::pg_catalog.regclass::oid,
              'public.trader_positions_history'::pg_catalog.regclass::oid,
              'public.trader_position_summary'::pg_catalog.regclass::oid
            )
        )
      )
  LOOP
    IF pg_catalog.has_function_privilege('anon', v_function.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_function.oid, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_function.oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS procedure
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
         ) AS privilege
         WHERE procedure.oid = v_function.oid
           AND privilege.grantee <> procedure.proowner
           AND (
             privilege.grantee <> v_service
             OR privilege.privilege_type <> 'EXECUTE'
             OR privilege.is_grantable
           )
       ) THEN
      RAISE EXCEPTION 'legacy raw metric public function ACL did not converge';
    END IF;
  END LOOP;

  -- Re-attest role capability paths after locking and ACL writes, so a
  -- concurrent membership grant cannot turn these service-only relations into
  -- an untrusted browser surface before COMMIT.
  IF NOT EXISTS (
       SELECT 1
       FROM pg_temp.arena_guard_auth_members AS membership
       WHERE membership.roleid = v_service
         AND membership.member = v_authenticator
         AND NOT membership.admin_option
         AND NOT membership.inherit_option
         AND membership.set_option
     ) OR EXISTS (
       SELECT 1
       FROM pg_temp.arena_guard_auth_members AS membership
       WHERE membership.roleid = v_service
         AND membership.member NOT IN (v_authenticator, v_postgres)
     ) OR EXISTS (
       SELECT 1
       FROM pg_temp.arena_guard_auth_members AS membership
       WHERE membership.roleid = v_postgres
     ) OR pg_catalog.pg_has_role('anon', 'service_role', 'MEMBER')
       OR pg_catalog.pg_has_role('authenticated', 'service_role', 'MEMBER')
       OR pg_catalog.pg_has_role('anon', 'postgres', 'MEMBER')
       OR pg_catalog.pg_has_role('authenticated', 'postgres', 'MEMBER')
       OR EXISTS (
         WITH RECURSIVE service_authority(member_oid, path) AS (
           SELECT membership.member, ARRAY[v_service, membership.member]::oid[]
           FROM pg_temp.arena_guard_auth_members AS membership
           WHERE membership.roleid = v_service
             AND (membership.admin_option OR membership.inherit_option OR membership.set_option)

           UNION ALL

           SELECT membership.member, authority.path || membership.member
           FROM service_authority AS authority
           JOIN pg_temp.arena_guard_auth_members AS membership
             ON membership.roleid = authority.member_oid
           WHERE (membership.admin_option OR membership.inherit_option OR membership.set_option)
             AND NOT (membership.member = ANY(authority.path))
         )
         SELECT 1
         FROM service_authority AS authority
         WHERE authority.path <> ARRAY[v_service, v_postgres]::oid[]
           AND NOT (
             authority.path = ARRAY[v_service, v_authenticator]::oid[]
             AND EXISTS (
               SELECT 1
               FROM pg_temp.arena_guard_auth_members AS membership
               WHERE membership.roleid = v_service
                 AND membership.member = v_authenticator
                 AND NOT membership.admin_option
                 AND NOT membership.inherit_option
                 AND membership.set_option
             )
           )
       ) OR EXISTS (
         WITH RECURSIVE postgres_authority(member_oid, path) AS (
           SELECT membership.member, ARRAY[v_postgres, membership.member]::oid[]
           FROM pg_temp.arena_guard_auth_members AS membership
           WHERE membership.roleid = v_postgres
             AND (membership.admin_option OR membership.inherit_option OR membership.set_option)

           UNION ALL

           SELECT membership.member, authority.path || membership.member
           FROM postgres_authority AS authority
           JOIN pg_temp.arena_guard_auth_members AS membership
             ON membership.roleid = authority.member_oid
           WHERE (membership.admin_option OR membership.inherit_option OR membership.set_option)
             AND NOT (membership.member = ANY(authority.path))
         )
         SELECT 1 FROM postgres_authority
       ) OR EXISTS (
         WITH RECURSIVE service_upstream(role_oid, path) AS (
           SELECT membership.roleid, ARRAY[v_service, membership.roleid]::oid[]
           FROM pg_temp.arena_guard_auth_members AS membership
           WHERE membership.member = v_service
             AND (membership.admin_option OR membership.inherit_option OR membership.set_option)

           UNION ALL

           SELECT membership.roleid, authority.path || membership.roleid
           FROM service_upstream AS authority
           JOIN pg_temp.arena_guard_auth_members AS membership
             ON membership.member = authority.role_oid
           WHERE (membership.admin_option OR membership.inherit_option OR membership.set_option)
             AND NOT (membership.roleid = ANY(authority.path))
         )
         SELECT 1 FROM service_upstream
       ) THEN
    RAISE EXCEPTION 'legacy raw metric service authority graph drifted after cutover';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
