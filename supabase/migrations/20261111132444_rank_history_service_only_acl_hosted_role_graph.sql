-- Forward replacement for 20260817020000_rank_history_service_only_acl.sql, which was never applied to
-- production and cannot apply there: its role-graph guards reject the
-- Supabase-managed memberships every hosted project carries (see
-- docs/LAUNCH_REHEARSAL_2026-11-11.md, class A). The body is that migration
-- unchanged except for the shared managed-edge preamble before the preflight
-- and the guards reading the filtered graph. Apply this file instead of the
-- original; the original stays immutable in history.
--
-- `rank_history` is an internal, mutable raw-snapshot ledger. Public product
-- readers now fail closed until an immutable historical publication chain
-- exists, so direct Data API access must not bypass that application boundary.
--
-- This migration changes only ACL/RLS metadata. It deliberately preserves the
-- v1 relation, rows, constraints, indexes, and the service-role CRUD contract
-- used by snapshot-ranks plus internal rank-change notifications.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
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
  v_relation oid := pg_catalog.to_regclass('public.rank_history');
  v_kind text;
  v_owner oid;
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_service oid := pg_catalog.to_regrole('service_role');
  v_authenticator oid := pg_catalog.to_regrole('authenticator');
BEGIN
  IF v_relation IS NULL THEN
    RAISE EXCEPTION
      'rank_history service-only ACL cutover requires public.rank_history';
  END IF;

  IF pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL THEN
    RAISE EXCEPTION
      'rank_history service-only ACL cutover requires Supabase runtime roles';
  END IF;

  SELECT relation.relkind::text, relation.relowner
  INTO STRICT v_kind, v_owner
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = v_relation;

  IF v_kind <> 'r'
     OR v_owner <> 'postgres'::pg_catalog.regrole THEN
    RAISE EXCEPTION
      'rank_history service-only ACL cutover requires the postgres-owned v1 table';
  END IF;

  -- `authenticator` is Supabase/PostgREST's trusted LOGIN gateway: a verified
  -- service JWT is implemented as SET ROLE service_role. It is the sole
  -- non-owner admission edge and must remain exactly SET-only/NOINHERIT. The
  -- recursive checks intentionally cover every role, not just anon and
  -- authenticated, because an arbitrary inherited or SET ROLE member would
  -- receive this table's service CRUD and RLS policy as well.
  IF (
       v_authenticator IS NOT NULL
       AND (
         NOT EXISTS (
           SELECT 1
           FROM pg_temp.arena_guard_auth_members AS membership
           WHERE membership.roleid = v_service
             AND membership.member = v_authenticator
             AND NOT membership.admin_option
             AND NOT membership.inherit_option
             AND membership.set_option
         )
         OR NOT EXISTS (
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
         )
       )
     ) OR EXISTS (
       -- postgres is the trusted table owner. No custom role may be a direct
       -- service_role member, even if a currently dormant membership edge has
       -- both INHERIT and SET disabled.
       SELECT 1
       FROM pg_temp.arena_guard_auth_members AS membership
       WHERE membership.roleid = v_service
         AND membership.member <> v_postgres
         AND (
           v_authenticator IS NULL
           OR membership.member <> v_authenticator
         )
     ) OR EXISTS (
       -- No non-owner role may enter postgres. This is deliberately stricter
       -- than browser-only checks: raw rank_history is postgres-owned, so any
       -- active owner path is a direct raw-read bypass.
       SELECT 1
       FROM pg_temp.arena_guard_auth_members AS membership
       WHERE membership.roleid = v_postgres
     ) OR EXISTS (
       -- Follow every capability-bearing downstream edge from service_role.
       -- This catches direct inherited readers, SET-only readers, ADMIN-only
       -- delegators, and multi-hop paths such as setter_reader -> bridge ->
       -- authenticator -> service_role. Only the direct trusted owner and
       -- canonical gateway edges may terminate here.
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
           v_authenticator IS NOT NULL
           AND authority.path = ARRAY[v_service, v_authenticator]::oid[]
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
       -- Retain a separate recursive owner attestation so a future narrowing
       -- of the direct-membership check cannot silently re-open an ADMIN,
       -- SET, or INHERIT chain into postgres.
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
       -- service_role must not itself inherit, SET, or ADMIN-delegate into a
       -- custom upstream role, which could make the service-only policy an
       -- unintended bridge.
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
    RAISE EXCEPTION 'rank_history internal role authority graph is unsafe';
  END IF;
END
$preflight$;

-- Serialize ACL/policy replacement with the small daily cron writer. The
-- transaction makes the cutover atomic; the explicit lock also keeps an
-- in-flight upsert from spanning the capability transition.
LOCK TABLE ONLY public.rank_history IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.rank_history ENABLE ROW LEVEL SECURITY;

-- Delete every historical policy, including the original unscoped
-- `rank_history_select USING (true)` policy and any production-only policy
-- name. Recreate exactly one service-role policy below rather than attempting
-- to enumerate policy names from old deployments.
DO $drop_rank_history_policies$
DECLARE
  v_policy_name name;
BEGIN
  FOR v_policy_name IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.rank_history'::pg_catalog.regclass
    ORDER BY policy.polname
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.rank_history',
      v_policy_name
    );
  END LOOP;
END
$drop_rank_history_policies$;

-- Supabase's historical public-schema defaults grant browser roles direct DML
-- capabilities. PUBLIC must be revoked separately because revoking `anon`
-- alone does not remove privileges inherited from PUBLIC. CASCADE also removes
-- grants delegated with GRANT OPTION before the service capability is restored.
REVOKE ALL PRIVILEGES ON TABLE public.rank_history FROM PUBLIC CASCADE;
REVOKE ALL PRIVILEGES ON TABLE public.rank_history
  FROM anon, authenticated, service_role CASCADE;

-- Collapse any non-standard direct table grant as well. A production-only
-- role must not retain a second raw-read path merely because it was absent
-- from repository migrations.
DO $collapse_rank_history_table_acl$
DECLARE
  v_grantee record;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT privilege.grantee, grantee_role.rolname
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS privilege
    LEFT JOIN pg_catalog.pg_roles AS grantee_role
      ON grantee_role.oid = privilege.grantee
    WHERE relation.oid = 'public.rank_history'::pg_catalog.regclass
      AND privilege.grantee <> relation.relowner
  LOOP
    IF v_grantee.grantee = 0 THEN
      EXECUTE
        'REVOKE ALL PRIVILEGES ON TABLE public.rank_history FROM PUBLIC CASCADE';
    ELSIF v_grantee.rolname IS NULL THEN
      RAISE EXCEPTION
        'rank_history retains an unresolved table ACL grantee %',
        v_grantee.grantee;
    ELSE
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.rank_history FROM %I CASCADE',
        v_grantee.rolname
      );
    END IF;
  END LOOP;
END
$collapse_rank_history_table_acl$;

-- Table-level REVOKE does not remove independently delegated column ACLs.
-- Remove those for every non-owner role before using one table-level service
-- grant, so a partial-column direct REST query cannot survive the cutover.
DO $collapse_rank_history_column_acl$
DECLARE
  v_column_list text;
  v_grantee record;
BEGIN
  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', ' ORDER BY attribute.attnum
  )
  INTO STRICT v_column_list
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.rank_history'::pg_catalog.regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  FOR v_grantee IN
    SELECT DISTINCT privilege.grantee, grantee_role.rolname
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
    LEFT JOIN pg_catalog.pg_roles AS grantee_role
      ON grantee_role.oid = privilege.grantee
    WHERE attribute.attrelid = 'public.rank_history'::pg_catalog.regclass
      AND attribute.attacl IS NOT NULL
  LOOP
    IF v_grantee.grantee = 0 THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), '
          || 'REFERENCES (%1$s) ON TABLE public.rank_history FROM PUBLIC CASCADE',
        v_column_list
      );
    ELSIF v_grantee.rolname IS NULL THEN
      RAISE EXCEPTION
        'rank_history retains an unresolved column ACL grantee %',
        v_grantee.grantee;
    ELSIF v_grantee.rolname <> 'postgres' THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), '
          || 'REFERENCES (%1$s) ON TABLE public.rank_history FROM %2$I CASCADE',
        v_column_list,
        v_grantee.rolname
      );
    END IF;
  END LOOP;
END
$collapse_rank_history_column_acl$;

-- `snapshot-ranks` upserts and deletes old points; internal notification jobs
-- also select historical points. Keep exactly that CRUD surface for the admin
-- client and no browser-facing table privilege.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rank_history
  TO service_role;

-- service_role normally has BYPASSRLS in Supabase. Retain an explicit policy
-- as a second boundary so the internal path remains valid if that role's
-- BYPASSRLS attribute changes, while no anon/authenticated policy can expose
-- rows after a future accidental table grant.
CREATE POLICY rank_history_service_only
  ON public.rank_history
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DO $postflight$
DECLARE
  v_relation oid := 'public.rank_history'::pg_catalog.regclass;
  v_role name;
  v_privilege text;
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_service oid := pg_catalog.to_regrole('service_role');
  v_authenticator oid := pg_catalog.to_regrole('authenticator');
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = v_relation
         AND relation.relrowsecurity
     ) THEN
    RAISE EXCEPTION 'rank_history RLS is not enabled after ACL cutover';
  END IF;

  IF (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_policy AS policy
       WHERE policy.polrelid = v_relation
     ) <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy
       WHERE policy.polrelid = v_relation
         AND policy.polname = 'rank_history_service_only'
         AND policy.polpermissive
         AND policy.polcmd = '*'
         AND policy.polroles = ARRAY[
           'service_role'::pg_catalog.regrole::oid
         ]::oid[]
         AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
         AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
     ) THEN
    RAISE EXCEPTION 'rank_history service-only RLS policy drifted';
  END IF;

  -- Direct ACL inspection catches PUBLIC and grant-option entries; effective
  -- checks below also catch privileges inherited through an unexpected role.
  IF EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           relation.relacl,
           pg_catalog.acldefault('r', relation.relowner)
         )
       ) AS privilege
       WHERE relation.oid = v_relation
         AND privilege.grantee <> relation.relowner
         AND (
           privilege.grantee <> 'service_role'::pg_catalog.regrole
           OR privilege.privilege_type NOT IN (
             'SELECT', 'INSERT', 'UPDATE', 'DELETE'
           )
           OR privilege.is_grantable
         )
     ) THEN
    RAISE EXCEPTION 'rank_history retains an unsafe direct table ACL';
  END IF;

  IF (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_class AS relation
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           relation.relacl,
           pg_catalog.acldefault('r', relation.relowner)
         )
       ) AS privilege
       WHERE relation.oid = v_relation
         AND privilege.grantee = 'service_role'::pg_catalog.regrole
         AND privilege.privilege_type IN (
           'SELECT', 'INSERT', 'UPDATE', 'DELETE'
         )
         AND NOT privilege.is_grantable
     ) <> 4 THEN
    RAISE EXCEPTION 'rank_history service role CRUD ACL is incomplete';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
       WHERE attribute.attrelid = v_relation
         AND attribute.attacl IS NOT NULL
         AND privilege.grantee <> (
           SELECT relation.relowner
           FROM pg_catalog.pg_class AS relation
           WHERE relation.oid = v_relation
         )
     ) THEN
    RAISE EXCEPTION 'rank_history retains a delegated column ACL';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name]
  LOOP
    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE',
      'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(v_role, v_relation, v_privilege) THEN
        RAISE EXCEPTION
          'rank_history remains directly reachable by % via %',
          v_role,
          v_privilege;
      END IF;
    END LOOP;

    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
    ]::text[]
    LOOP
      IF pg_catalog.has_any_column_privilege(
           v_role,
           v_relation,
           v_privilege
         ) THEN
        RAISE EXCEPTION
          'rank_history remains column-reachable by % via %',
          v_role,
          v_privilege;
      END IF;
    END LOOP;
  END LOOP;

  FOREACH v_privilege IN ARRAY ARRAY[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE'
  ]::text[]
  LOOP
    IF NOT pg_catalog.has_table_privilege(
      'service_role',
      v_relation,
      v_privilege
    ) THEN
      RAISE EXCEPTION
        'rank_history service role is missing % capability',
        v_privilege;
    END IF;
  END LOOP;

  FOREACH v_privilege IN ARRAY ARRAY[
    'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
  ]::text[]
  LOOP
    IF pg_catalog.has_table_privilege(
      'service_role',
      v_relation,
      v_privilege
    ) THEN
      RAISE EXCEPTION
        'rank_history service role retained unnecessary % capability',
        v_privilege;
    END IF;
  END LOOP;

  -- Re-attest the complete role graph after the table lock and ACL rewrite.
  -- This catches a concurrent membership GRANT before COMMIT and keeps the
  -- canonical PostgREST gateway edge precise on every replay.
  IF (
       v_authenticator IS NOT NULL
       AND (
         NOT EXISTS (
           SELECT 1
           FROM pg_temp.arena_guard_auth_members AS membership
           WHERE membership.roleid = v_service
             AND membership.member = v_authenticator
             AND NOT membership.admin_option
             AND NOT membership.inherit_option
             AND membership.set_option
         )
         OR NOT EXISTS (
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
         )
       )
     ) OR EXISTS (
       SELECT 1
       FROM pg_temp.arena_guard_auth_members AS membership
       WHERE membership.roleid = v_service
         AND membership.member <> v_postgres
         AND (
           v_authenticator IS NULL
           OR membership.member <> v_authenticator
         )
     ) OR EXISTS (
       SELECT 1
       FROM pg_temp.arena_guard_auth_members AS membership
       WHERE membership.roleid = v_postgres
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
           v_authenticator IS NOT NULL
           AND authority.path = ARRAY[v_service, v_authenticator]::oid[]
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
    RAISE EXCEPTION 'rank_history internal role authority graph is unsafe';
  END IF;

  IF pg_catalog.pg_has_role('anon', 'service_role', 'MEMBER')
     OR pg_catalog.pg_has_role('authenticated', 'service_role', 'MEMBER')
     OR pg_catalog.pg_has_role('anon', 'postgres', 'MEMBER')
     OR pg_catalog.pg_has_role('authenticated', 'postgres', 'MEMBER') THEN
    RAISE EXCEPTION 'rank_history browser role topology drifted after ACL cutover';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
