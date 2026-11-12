-- Forward replacement for 20260817060000_trader_series_publication_isolation.sql, which was never applied to
-- production and cannot apply there: its role-graph guards reject the
-- Supabase-managed memberships every hosted project carries (see
-- docs/LAUNCH_REHEARSAL_2026-11-11.md, class A). The body is that migration
-- unchanged except for the shared managed-edge preamble before the preflight
-- and the guards reading the filtered graph. Apply this file instead of the
-- original; the original stays immutable in history.
--
-- Raw trader time series and the legacy core RPC have no immutable public
-- publication chain. The ranking and profile transports must therefore not
-- obtain a trajectory, PnL calendar, or other historical metric by querying a
-- parent, an attached partition, or a SECURITY DEFINER function directly.
--
-- This is an ACL/RLS-only cutover: it preserves relation shape and rows for
-- internal ingest/service work while removing every browser-facing capability.

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
  v_daily oid := pg_catalog.to_regclass('arena.trader_series');
  v_weekly oid := pg_catalog.to_regclass('arena.trader_series_weekly');
  v_service oid := pg_catalog.to_regrole('service_role');
  v_authenticator oid := pg_catalog.to_regrole('authenticator');
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_cross_schema_children text;
BEGIN
  IF v_daily IS NULL
     OR v_weekly IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = v_daily
         AND relation.relkind = 'p'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = v_weekly
         AND relation.relkind = 'r'
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_inherits AS inheritance
       WHERE inheritance.inhparent = v_weekly
     ) THEN
    RAISE EXCEPTION
      'trader-series publication isolation requires a partitioned daily parent and unpartitioned weekly table';
  END IF;

  IF pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR v_service IS NULL
     OR v_authenticator IS NULL
     OR v_postgres IS NULL THEN
    RAISE EXCEPTION 'trader-series publication isolation requires Supabase runtime roles';
  END IF;

  IF pg_catalog.to_regprocedure(
       'public.arena_roi_sparklines(jsonb,integer,integer)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.arena_core_modules(text,text,integer)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.snapshot_score_backtest()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.evaluate_score_backtest(integer)'
     ) IS NULL THEN
    RAISE EXCEPTION 'trader-series publication isolation requires the raw-series RPCs';
  END IF;

  -- `authenticator` is the only non-owner role allowed to SET service_role
  -- after a verified service JWT. An inherited, SET-enabled, or ADMIN path to
  -- service_role would make the service-only policies below browser-readable.
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
         SELECT
           membership.member,
           ARRAY[v_service, membership.member]::oid[]
         FROM pg_temp.arena_guard_auth_members AS membership
         WHERE membership.roleid = v_service
           AND (
             membership.admin_option
             OR membership.inherit_option
             OR membership.set_option
           )

         UNION ALL

         SELECT
           membership.member,
           authority.path || membership.member
         FROM service_authority AS authority
         JOIN pg_temp.arena_guard_auth_members AS membership
           ON membership.roleid = authority.member_oid
         WHERE (
           membership.admin_option
           OR membership.inherit_option
           OR membership.set_option
         )
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
       -- Keep a recursive owner attestation even though direct postgres
       -- membership is rejected above. This catches any future weakening of
       -- that direct check before it can re-open an ADMIN/SET/INHERIT chain.
       WITH RECURSIVE postgres_authority(member_oid, path) AS (
         SELECT
           membership.member,
           ARRAY[v_postgres, membership.member]::oid[]
         FROM pg_temp.arena_guard_auth_members AS membership
         WHERE membership.roleid = v_postgres
           AND (
             membership.admin_option
             OR membership.inherit_option
             OR membership.set_option
           )

         UNION ALL

         SELECT
           membership.member,
           authority.path || membership.member
         FROM postgres_authority AS authority
         JOIN pg_temp.arena_guard_auth_members AS membership
           ON membership.roleid = authority.member_oid
         WHERE (
           membership.admin_option
           OR membership.inherit_option
           OR membership.set_option
         )
           AND NOT (membership.member = ANY(authority.path))
       )
       SELECT 1 FROM postgres_authority
     ) OR EXISTS (
       WITH RECURSIVE service_upstream(role_oid, path) AS (
         SELECT
           membership.roleid,
           ARRAY[v_service, membership.roleid]::oid[]
         FROM pg_temp.arena_guard_auth_members AS membership
         WHERE membership.member = v_service
           AND (
             membership.admin_option
             OR membership.inherit_option
             OR membership.set_option
           )

         UNION ALL

         SELECT
           membership.roleid,
           authority.path || membership.roleid
         FROM service_upstream AS authority
         JOIN pg_temp.arena_guard_auth_members AS membership
           ON membership.member = authority.role_oid
         WHERE (
           membership.admin_option
           OR membership.inherit_option
           OR membership.set_option
         )
           AND NOT (membership.roleid = ANY(authority.path))
       )
       SELECT 1 FROM service_upstream
     ) THEN
    RAISE EXCEPTION 'trader-series service authority graph is unsafe';
  END IF;

  WITH RECURSIVE roots(relid) AS (
    SELECT v_daily
    UNION ALL
    SELECT v_weekly
  ), relation_tree(relid) AS (
    SELECT relid FROM roots
    UNION
    SELECT inheritance.inhrelid
    FROM relation_tree AS tree
    JOIN pg_catalog.pg_inherits AS inheritance
      ON inheritance.inhparent = tree.relid
  )
  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I.%I', namespace_row.nspname, relation.relname),
    ', ' ORDER BY namespace_row.nspname, relation.relname
  )
  INTO v_cross_schema_children
  FROM relation_tree AS tree
  JOIN pg_catalog.pg_class AS relation
    ON relation.oid = tree.relid
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = relation.relnamespace
  WHERE namespace_row.nspname <> 'arena';

  IF v_cross_schema_children IS NOT NULL THEN
    RAISE EXCEPTION
      'trader-series publication isolation refuses cross-schema attached relations: %',
      v_cross_schema_children;
  END IF;
END
$preflight$;

-- Serialize the policy/ACL cutover with direct ingest writes and partition
-- attach operations. Every existing descendant is locked as well: locking only
-- the parents would still let an owner change a child ACL while the recursive
-- convergence pass is in progress.
LOCK TABLE ONLY arena.trader_series IN ACCESS EXCLUSIVE MODE;
LOCK TABLE ONLY arena.trader_series_weekly IN ACCESS EXCLUSIVE MODE;

DO $lock_attached_relations$
DECLARE
  v_relation record;
BEGIN
  FOR v_relation IN
    WITH RECURSIVE roots(relid) AS (
      SELECT 'arena.trader_series'::pg_catalog.regclass::oid
      UNION ALL
      SELECT 'arena.trader_series_weekly'::pg_catalog.regclass::oid
    ), relation_tree(relid) AS (
      SELECT relid FROM roots
      UNION
      SELECT inheritance.inhrelid
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
$lock_attached_relations$;

DO $close_relation_boundaries$
DECLARE
  v_relation record;
  v_policy_name name;
  v_grantee record;
  v_column_list text;
BEGIN
  FOR v_relation IN
    WITH RECURSIVE roots(relid) AS (
      SELECT 'arena.trader_series'::pg_catalog.regclass::oid
      UNION ALL
      SELECT 'arena.trader_series_weekly'::pg_catalog.regclass::oid
    ), relation_tree(relid) AS (
      SELECT relid FROM roots
      UNION
      SELECT inheritance.inhrelid
      FROM relation_tree AS tree
      JOIN pg_catalog.pg_inherits AS inheritance
        ON inheritance.inhparent = tree.relid
    )
    SELECT
      relation.oid,
      namespace_row.nspname,
      relation.relname
    FROM relation_tree AS tree
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = tree.relid
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = relation.relnamespace
    ORDER BY relation.oid
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

    -- PUBLIC must be removed separately from named browser roles. Then collapse
    -- production-only delegated grants before restoring the minimal parent CRUD.
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
          'trader-series relation retains unresolved table ACL grantee %',
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

    -- Table-level revocation does not remove independent column grants. A
    -- partial-column REST query must not remain a raw historical read path.
    SELECT pg_catalog.string_agg(
      pg_catalog.format('%I', attribute.attname),
      ', ' ORDER BY attribute.attnum
    )
    INTO STRICT v_column_list
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation.oid
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

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
          'trader-series relation retains unresolved column ACL grantee %',
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
  END LOOP;
END
$close_relation_boundaries$;

-- Ingest publishes/replaces/rolls up the raw series through the two parents.
-- Keep exactly the needed service CRUD there; attached partitions remain an
-- implementation detail with no direct service or browser access.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE arena.trader_series TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE arena.trader_series_weekly TO service_role;

CREATE POLICY trader_series_service_role_only
  ON arena.trader_series
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY trader_series_weekly_service_role_only
  ON arena.trader_series_weekly
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- These SECURITY DEFINER functions were direct public raw-series bypasses.
-- Close *every* public overload, not just the signatures used by the current
-- routes: an obsolete overload can otherwise remain an executable phantom
-- endpoint in PostgREST. The known core reader remains service-only for the
-- on-chain enrichment dedupe. The score-backtest jobs are cron-only service
-- callers. Ranking sparklines have no internal caller.
ALTER FUNCTION public.arena_roi_sparklines(jsonb, integer, integer) OWNER TO postgres;
ALTER FUNCTION public.arena_core_modules(text, text, integer) OWNER TO postgres;
ALTER FUNCTION public.snapshot_score_backtest() OWNER TO postgres;
ALTER FUNCTION public.evaluate_score_backtest(integer) OWNER TO postgres;

REVOKE ALL PRIVILEGES ON FUNCTION public.arena_roi_sparklines(jsonb, integer, integer)
  FROM PUBLIC CASCADE;
REVOKE ALL PRIVILEGES ON FUNCTION public.arena_roi_sparklines(jsonb, integer, integer)
  FROM anon, authenticated, service_role CASCADE;
REVOKE ALL PRIVILEGES ON FUNCTION public.arena_core_modules(text, text, integer)
  FROM PUBLIC CASCADE;
REVOKE ALL PRIVILEGES ON FUNCTION public.arena_core_modules(text, text, integer)
  FROM anon, authenticated, service_role CASCADE;
REVOKE ALL PRIVILEGES ON FUNCTION public.snapshot_score_backtest()
  FROM PUBLIC CASCADE;
REVOKE ALL PRIVILEGES ON FUNCTION public.snapshot_score_backtest()
  FROM anon, authenticated, service_role CASCADE;
REVOKE ALL PRIVILEGES ON FUNCTION public.evaluate_score_backtest(integer)
  FROM PUBLIC CASCADE;
REVOKE ALL PRIVILEGES ON FUNCTION public.evaluate_score_backtest(integer)
  FROM anon, authenticated, service_role CASCADE;

DO $close_function_boundaries$
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
      AND procedure.proname IN (
        'arena_roi_sparklines',
        'arena_core_modules',
        'snapshot_score_backtest',
        'evaluate_score_backtest'
      )
    ORDER BY procedure.proname, procedure.oid
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER FUNCTION %s OWNER TO postgres',
      v_function.signature
    );
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
          'trader-series function retains unresolved ACL grantee %',
          v_grantee.grantee;
      ELSE
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
          v_function.signature,
          v_grantee.rolname
        );
      END IF;
    END LOOP;
  END LOOP;
END
$close_function_boundaries$;

GRANT EXECUTE ON FUNCTION public.arena_core_modules(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.snapshot_score_backtest() TO service_role;
GRANT EXECUTE ON FUNCTION public.evaluate_score_backtest(integer) TO service_role;

DO $postflight$
DECLARE
  v_relation record;
  v_policy_name name;
  v_service oid := 'service_role'::pg_catalog.regrole;
  v_authenticator oid := 'authenticator'::pg_catalog.regrole;
  v_postgres oid := 'postgres'::pg_catalog.regrole;
  v_role name;
  v_privilege text;
  v_function record;
BEGIN
  FOR v_relation IN
    WITH RECURSIVE roots(relid, expected_policy) AS (
      SELECT
        'arena.trader_series'::pg_catalog.regclass::oid,
        'trader_series_service_role_only'::name
      UNION ALL
      SELECT
        'arena.trader_series_weekly'::pg_catalog.regclass::oid,
        'trader_series_weekly_service_role_only'::name
    ), relation_tree(relid, root_relid, expected_policy) AS (
      SELECT relid, relid, expected_policy FROM roots
      UNION
      SELECT inheritance.inhrelid, tree.root_relid, tree.expected_policy
      FROM relation_tree AS tree
      JOIN pg_catalog.pg_inherits AS inheritance
        ON inheritance.inhparent = tree.relid
    )
    SELECT
      relation.oid,
      relation.relname,
      relation.relowner,
      relation.relrowsecurity,
      tree.relid = tree.root_relid AS is_parent,
      tree.expected_policy
    FROM relation_tree AS tree
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = tree.relid
    ORDER BY relation.oid
  LOOP
    IF v_relation.relowner <> 'postgres'::pg_catalog.regrole
       OR NOT v_relation.relrowsecurity THEN
      RAISE EXCEPTION
        'trader-series relation did not converge to postgres ownership and enabled RLS: %',
        v_relation.relname;
    END IF;

    IF v_relation.is_parent THEN
      IF (
           SELECT pg_catalog.count(*)
           FROM pg_catalog.pg_policy AS policy
           WHERE policy.polrelid = v_relation.oid
         ) <> 1
         OR NOT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_policy AS policy
           WHERE policy.polrelid = v_relation.oid
             AND policy.polname = v_relation.expected_policy
             AND policy.polpermissive
             AND policy.polcmd = '*'
             AND policy.polroles = ARRAY[v_service]::oid[]
             AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
             AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
         ) THEN
        RAISE EXCEPTION 'trader-series parent policy drifted: %', v_relation.relname;
      END IF;

      IF EXISTS (
           SELECT 1
           FROM pg_catalog.pg_class AS relation
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
           ) AS privilege
           WHERE relation.oid = v_relation.oid
             AND privilege.grantee <> relation.relowner
             AND (
               privilege.grantee <> v_service
               OR privilege.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
               OR privilege.is_grantable
             )
         ) THEN
        RAISE EXCEPTION 'trader-series parent retained an unsafe table ACL: %', v_relation.relname;
      END IF;

      FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[]
      LOOP
        IF NOT pg_catalog.has_table_privilege(v_service, v_relation.oid, v_privilege) THEN
          RAISE EXCEPTION 'service_role is missing % on trader-series parent %', v_privilege, v_relation.relname;
        END IF;
      END LOOP;
    ELSE
      IF EXISTS (
           SELECT 1
           FROM pg_catalog.pg_policy AS policy
           WHERE policy.polrelid = v_relation.oid
         ) OR EXISTS (
           SELECT 1
           FROM pg_catalog.pg_class AS relation
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
           ) AS privilege
           WHERE relation.oid = v_relation.oid
             AND privilege.grantee <> relation.relowner
         ) THEN
        RAISE EXCEPTION 'trader-series attached relation retained a direct policy or ACL: %', v_relation.relname;
      END IF;
    END IF;

    IF EXISTS (
         SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
         CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
         WHERE attribute.attrelid = v_relation.oid
           AND attribute.attacl IS NOT NULL
           AND privilege.grantee <> 'postgres'::pg_catalog.regrole
       ) THEN
      RAISE EXCEPTION 'trader-series relation retained a non-owner column ACL: %', v_relation.relname;
    END IF;

    FOREACH v_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name]
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
      ]::text[]
      LOOP
        IF pg_catalog.has_table_privilege(v_role, v_relation.oid, v_privilege) THEN
          RAISE EXCEPTION '% retains trader-series % on %', v_role, v_privilege, v_relation.relname;
        END IF;
      END LOOP;
      FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']::text[]
      LOOP
        IF pg_catalog.has_any_column_privilege(v_role, v_relation.oid, v_privilege) THEN
          RAISE EXCEPTION '% retains trader-series column % on %', v_role, v_privilege, v_relation.relname;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  FOR v_function IN
    SELECT
      procedure.oid,
      procedure.proname,
      procedure.proowner,
      procedure.prosecdef,
      procedure.oid = ANY (
        ARRAY[
          'public.arena_core_modules(text,text,integer)'::pg_catalog.regprocedure::oid,
          'public.snapshot_score_backtest()'::pg_catalog.regprocedure::oid,
          'public.evaluate_score_backtest(integer)'::pg_catalog.regprocedure::oid
        ]::oid[]
      ) AS is_service_only
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = procedure.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND procedure.prokind = 'f'
      AND procedure.proname IN (
        'arena_roi_sparklines',
        'arena_core_modules',
        'snapshot_score_backtest',
        'evaluate_score_backtest'
      )
    ORDER BY procedure.proname, procedure.oid
  LOOP
    IF v_function.proowner <> 'postgres'::pg_catalog.regrole
       OR (v_function.is_service_only AND NOT v_function.prosecdef) THEN
      RAISE EXCEPTION 'trader-series legacy function ownership/security drifted: %', v_function.proname;
    END IF;
    IF EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS procedure
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
         ) AS privilege
         WHERE procedure.oid = v_function.oid
           AND privilege.grantee <> procedure.proowner
           AND NOT (
             v_function.is_service_only
             AND privilege.grantee = v_service
             AND privilege.privilege_type = 'EXECUTE'
             AND NOT privilege.is_grantable
           )
       ) OR pg_catalog.has_function_privilege('anon', v_function.oid, 'EXECUTE')
         OR pg_catalog.has_function_privilege('authenticated', v_function.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'trader-series legacy function retained an unsafe ACL: %', v_function.proname;
    END IF;
    IF v_function.is_service_only THEN
      IF NOT pg_catalog.has_function_privilege('service_role', v_function.oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'service_role lost a required raw-series internal RPC: %', v_function.proname;
      END IF;
    ELSIF pg_catalog.has_function_privilege('service_role', v_function.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'retired raw-series RPC remains executable by service_role: %', v_function.proname;
    END IF;
  END LOOP;

  -- Re-attest the entire role graph after the table lock and ACL rewrite. Role
  -- membership is outside those relation locks, so a concurrent/replayed
  -- GRANT must not turn this completed-looking cutover back into a raw-reader
  -- capability through service_role or postgres.
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
         SELECT
           membership.member,
           ARRAY[v_service, membership.member]::oid[]
         FROM pg_temp.arena_guard_auth_members AS membership
         WHERE membership.roleid = v_service
           AND (
             membership.admin_option
             OR membership.inherit_option
             OR membership.set_option
           )

         UNION ALL

         SELECT
           membership.member,
           authority.path || membership.member
         FROM service_authority AS authority
         JOIN pg_temp.arena_guard_auth_members AS membership
           ON membership.roleid = authority.member_oid
         WHERE (
           membership.admin_option
           OR membership.inherit_option
           OR membership.set_option
         )
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
         SELECT
           membership.member,
           ARRAY[v_postgres, membership.member]::oid[]
         FROM pg_temp.arena_guard_auth_members AS membership
         WHERE membership.roleid = v_postgres
           AND (
             membership.admin_option
             OR membership.inherit_option
             OR membership.set_option
           )

         UNION ALL

         SELECT
           membership.member,
           authority.path || membership.member
         FROM postgres_authority AS authority
         JOIN pg_temp.arena_guard_auth_members AS membership
           ON membership.roleid = authority.member_oid
         WHERE (
           membership.admin_option
           OR membership.inherit_option
           OR membership.set_option
         )
           AND NOT (membership.member = ANY(authority.path))
       )
       SELECT 1 FROM postgres_authority
     ) OR EXISTS (
       WITH RECURSIVE service_upstream(role_oid, path) AS (
         SELECT
           membership.roleid,
           ARRAY[v_service, membership.roleid]::oid[]
         FROM pg_temp.arena_guard_auth_members AS membership
         WHERE membership.member = v_service
           AND (
             membership.admin_option
             OR membership.inherit_option
             OR membership.set_option
           )

         UNION ALL

         SELECT
           membership.roleid,
           authority.path || membership.roleid
         FROM service_upstream AS authority
         JOIN pg_temp.arena_guard_auth_members AS membership
           ON membership.member = authority.role_oid
         WHERE (
           membership.admin_option
           OR membership.inherit_option
           OR membership.set_option
         )
           AND NOT (membership.roleid = ANY(authority.path))
       )
       SELECT 1 FROM service_upstream
     ) THEN
    RAISE EXCEPTION 'trader-series service authority graph drifted after cutover';
  END IF;

  IF pg_catalog.pg_has_role('anon', 'service_role', 'MEMBER')
     OR pg_catalog.pg_has_role('authenticated', 'service_role', 'MEMBER')
     OR pg_catalog.pg_has_role('anon', 'postgres', 'MEMBER')
     OR pg_catalog.pg_has_role('authenticated', 'postgres', 'MEMBER') THEN
    RAISE EXCEPTION 'trader-series browser role topology drifted after cutover';
  END IF;
END
$postflight$;

COMMENT ON TABLE arena.trader_series IS
  'Raw historical metric series; service-only until an immutable public publication projection exists.';
COMMENT ON TABLE arena.trader_series_weekly IS
  'Raw historical metric downsample; service-only until an immutable public publication projection exists.';
COMMENT ON FUNCTION public.arena_roi_sparklines(jsonb, integer, integer) IS
  'Retired raw historical sparkline reader. No role may execute it pending public evidence.';
COMMENT ON FUNCTION public.arena_core_modules(text, text, integer) IS
  'Internal raw core reader. Service-only; public transports must use an empty projection pending evidence.';
COMMENT ON FUNCTION public.snapshot_score_backtest() IS
  'Internal raw-series score-backtest writer. Service-only.';
COMMENT ON FUNCTION public.evaluate_score_backtest(integer) IS
  'Internal raw-series score-backtest evaluator. Service-only.';

NOTIFY pgrst, 'reload schema';

COMMIT;
