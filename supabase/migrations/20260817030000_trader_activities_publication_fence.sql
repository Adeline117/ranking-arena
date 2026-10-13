-- `trader_activities` is a legacy free-form event ledger. Its ranking and
-- purportedly non-ranking rows have no immutable event-time receipt binding
-- displayed text/metrics to source evidence. Public readers therefore fail
-- closed; this metadata-only cutover removes every direct Data API path while
-- retaining the service-role CRUD used by server readers and cron retention.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL TIME ZONE 'UTC';

DO $preflight$
DECLARE
  v_relation oid := pg_catalog.to_regclass('public.trader_activities');
  v_kind text;
  v_owner oid;
  v_service oid := pg_catalog.to_regrole('service_role');
  v_authenticator oid := pg_catalog.to_regrole('authenticator');
  v_postgres oid := pg_catalog.to_regrole('postgres');
BEGIN
  IF v_relation IS NULL THEN
    RAISE EXCEPTION
      'trader_activities publication fence requires public.trader_activities';
  END IF;

  IF pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR v_service IS NULL
     OR v_authenticator IS NULL
     OR v_postgres IS NULL THEN
    RAISE EXCEPTION
      'trader_activities publication fence requires Supabase runtime roles';
  END IF;

  SELECT relation.relkind::text, relation.relowner
  INTO STRICT v_kind, v_owner
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = v_relation;

  IF v_kind <> 'r'
     OR v_owner <> v_postgres THEN
    RAISE EXCEPTION
      'trader_activities publication fence requires the postgres-owned v1 table';
  END IF;

  -- The PostgREST gateway may SET ROLE service_role for a service JWT, but it
  -- must not inherit it. The exact edge below is the normal Supabase shape.
  -- `postgres` is tolerated as the cluster superuser/owner; all other direct
  -- service-role membership is rejected, even if its current flags are false.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service
      AND membership.member = v_authenticator
      AND NOT membership.admin_option
      AND NOT membership.inherit_option
      AND membership.set_option
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service
      AND membership.member NOT IN (v_authenticator, v_postgres)
  ) OR EXISTS (
    -- A role that can INHERIT, SET, or administer any intermediate gateway
    -- role can reach (or grant another role a path to) service_role. Only the
    -- direct authenticator bridge (and postgres) is necessary; recurse so a
    -- hidden SET or ADMIN OPTION chain cannot bypass this fence.
    WITH RECURSIVE service_reachers(role_oid) AS (
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.roleid = v_service
        AND (membership.inherit_option OR membership.set_option OR membership.admin_option)
      UNION
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_reachers AS reachable
        ON membership.roleid = reachable.role_oid
      WHERE membership.inherit_option OR membership.set_option OR membership.admin_option
    )
    SELECT 1
    FROM service_reachers AS reachable
    WHERE reachable.role_oid NOT IN (v_authenticator, v_postgres)
  ) OR EXISTS (
    -- service_role itself must not be able to climb to, or delegate, another
    -- authority via an inherited, SET-enabled, or ADMIN OPTION role chain.
    WITH RECURSIVE service_outbound(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.member = v_service
        AND (membership.inherit_option OR membership.set_option OR membership.admin_option)
      UNION
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_outbound AS reachable
        ON membership.member = reachable.role_oid
      WHERE membership.inherit_option OR membership.set_option OR membership.admin_option
    )
    SELECT 1 FROM service_outbound
  ) OR EXISTS (
    -- Explicitly deny browser-role routes to the gateway, service, or owner,
    -- including recursive SET/ADMIN paths that table ACL checks cannot see.
    WITH RECURSIVE browser_authority(root_oid, role_oid) AS (
      SELECT browser_role.oid, membership.roleid
      FROM pg_catalog.pg_roles AS browser_role
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = browser_role.oid
       AND (membership.inherit_option OR membership.set_option OR membership.admin_option)
      WHERE browser_role.rolname IN ('anon', 'authenticated')
      UNION
      SELECT inherited.root_oid, membership.roleid
      FROM browser_authority AS inherited
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = inherited.role_oid
      WHERE membership.inherit_option OR membership.set_option OR membership.admin_option
    )
    SELECT 1
    FROM browser_authority AS inherited
    WHERE inherited.role_oid IN (v_authenticator, v_service, v_postgres)
  ) THEN
    RAISE EXCEPTION
      'trader_activities service_role membership or SET graph is unsafe';
  END IF;
END
$preflight$;

-- Serialize policy/ACL replacement with cron retention writes. The transaction
-- is atomic; the explicit lock prevents an in-flight write spanning the
-- capability transition.
LOCK TABLE ONLY public.trader_activities IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.trader_activities ENABLE ROW LEVEL SECURITY;

-- Converge every historical policy, including production-only drifted names,
-- to the one service-role contract installed below.
DO $drop_legacy_policies$
DECLARE
  v_policy_name name;
BEGIN
  FOR v_policy_name IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.trader_activities'::pg_catalog.regclass
    ORDER BY policy.polname
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.trader_activities',
      v_policy_name
    );
  END LOOP;
END
$drop_legacy_policies$;

-- Clear PUBLIC first: revoking named browser roles does not remove PUBLIC's
-- capability. CASCADE also removes grants that legacy roles delegated with
-- GRANT OPTION before the exact service CRUD capability is restored.
REVOKE ALL PRIVILEGES ON TABLE public.trader_activities FROM PUBLIC CASCADE;
REVOKE ALL PRIVILEGES ON TABLE public.trader_activities
  FROM anon, authenticated, service_role CASCADE;

-- Collapse any production-only direct table ACL absent from repository
-- migrations. Unknown grantee OIDs fail closed rather than being ignored.
DO $collapse_trader_activities_table_acl$
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
    WHERE relation.oid = 'public.trader_activities'::pg_catalog.regclass
      AND privilege.grantee <> relation.relowner
  LOOP
    IF v_grantee.grantee = 0 THEN
      EXECUTE
        'REVOKE ALL PRIVILEGES ON TABLE public.trader_activities FROM PUBLIC CASCADE';
    ELSIF v_grantee.rolname IS NULL THEN
      RAISE EXCEPTION
        'trader_activities retains an unresolved table ACL grantee %',
        v_grantee.grantee;
    ELSE
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.trader_activities FROM %I CASCADE',
        v_grantee.rolname
      );
    END IF;
  END LOOP;
END
$collapse_trader_activities_table_acl$;

-- A table-level REVOKE does not remove independently delegated column ACLs.
-- Remove all non-owner column capabilities so a partial-column REST query
-- cannot survive the cutover.
DO $collapse_trader_activities_column_acl$
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
  WHERE attribute.attrelid = 'public.trader_activities'::pg_catalog.regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  FOR v_grantee IN
    SELECT DISTINCT privilege.grantee, grantee_role.rolname
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
    LEFT JOIN pg_catalog.pg_roles AS grantee_role
      ON grantee_role.oid = privilege.grantee
    WHERE attribute.attrelid = 'public.trader_activities'::pg_catalog.regclass
      AND attribute.attacl IS NOT NULL
  LOOP
    IF v_grantee.grantee = 0 THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), '
          || 'REFERENCES (%1$s) ON TABLE public.trader_activities FROM PUBLIC CASCADE',
        v_column_list
      );
    ELSIF v_grantee.rolname IS NULL THEN
      RAISE EXCEPTION
        'trader_activities retains an unresolved column ACL grantee %',
        v_grantee.grantee;
    ELSIF v_grantee.rolname <> 'postgres' THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), '
          || 'REFERENCES (%1$s) ON TABLE public.trader_activities FROM %2$I CASCADE',
        v_column_list,
        v_grantee.rolname
      );
    END IF;
  END LOOP;
END
$collapse_trader_activities_column_acl$;

-- Server readers and cron cleanup use getSupabaseAdmin/service_role. Preserve
-- precisely those CRUD operations, with no browser-facing table grant.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.trader_activities
  TO service_role;

CREATE POLICY trader_activities_service_role_only
  ON public.trader_activities
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DO $postflight$
DECLARE
  v_relation oid := 'public.trader_activities'::pg_catalog.regclass;
  v_service oid := pg_catalog.to_regrole('service_role');
  v_authenticator oid := pg_catalog.to_regrole('authenticator');
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_role name;
  v_privilege text;
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = v_relation
         AND relation.relrowsecurity
     ) THEN
    RAISE EXCEPTION 'trader_activities RLS is not enabled after ACL cutover';
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
         AND policy.polname = 'trader_activities_service_role_only'
         AND policy.polpermissive
         AND policy.polcmd = '*'
         AND policy.polroles = ARRAY[v_service]::oid[]
         AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
         AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
     ) THEN
    RAISE EXCEPTION 'trader_activities service-only RLS policy drifted';
  END IF;

  -- Direct ACL inspection catches PUBLIC and grant-option entries; effective
  -- privilege checks below also catch unexpected inherited role grants.
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
           privilege.grantee <> v_service
           OR privilege.privilege_type NOT IN (
             'SELECT', 'INSERT', 'UPDATE', 'DELETE'
           )
           OR privilege.is_grantable
         )
     ) THEN
    RAISE EXCEPTION 'trader_activities retains an unsafe direct table ACL';
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
         AND privilege.grantee = v_service
         AND privilege.privilege_type IN (
           'SELECT', 'INSERT', 'UPDATE', 'DELETE'
         )
         AND NOT privilege.is_grantable
     ) <> 4 THEN
    RAISE EXCEPTION 'trader_activities service role CRUD ACL is incomplete';
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
    RAISE EXCEPTION 'trader_activities retains a delegated column ACL';
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
          'trader_activities remains directly reachable by % via %',
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
          'trader_activities remains column-reachable by % via %',
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
      'service_role', v_relation, v_privilege
    ) THEN
      RAISE EXCEPTION
        'trader_activities service role is missing % capability',
        v_privilege;
    END IF;
  END LOOP;

  FOREACH v_privilege IN ARRAY ARRAY[
    'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
  ]::text[]
  LOOP
    IF pg_catalog.has_table_privilege(
      'service_role', v_relation, v_privilege
    ) THEN
      RAISE EXCEPTION
        'trader_activities service role retained unnecessary % capability',
        v_privilege;
    END IF;
  END LOOP;

  -- Repeat the full role-graph attestation after DDL. A concurrent GRANT that
  -- lands during the lock window makes the transaction fail rather than
  -- committing a table fence beside a privilege-escalation route.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service
      AND membership.member = v_authenticator
      AND NOT membership.admin_option
      AND NOT membership.inherit_option
      AND membership.set_option
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service
      AND membership.member NOT IN (v_authenticator, v_postgres)
  ) OR EXISTS (
    WITH RECURSIVE service_reachers(role_oid) AS (
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.roleid = v_service
        AND (membership.inherit_option OR membership.set_option OR membership.admin_option)
      UNION
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_reachers AS reachable
        ON membership.roleid = reachable.role_oid
      WHERE membership.inherit_option OR membership.set_option OR membership.admin_option
    )
    SELECT 1
    FROM service_reachers AS reachable
    WHERE reachable.role_oid NOT IN (v_authenticator, v_postgres)
  ) OR EXISTS (
    WITH RECURSIVE service_outbound(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.member = v_service
        AND (membership.inherit_option OR membership.set_option OR membership.admin_option)
      UNION
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_outbound AS reachable
        ON membership.member = reachable.role_oid
      WHERE membership.inherit_option OR membership.set_option OR membership.admin_option
    )
    SELECT 1 FROM service_outbound
  ) OR EXISTS (
    WITH RECURSIVE browser_authority(root_oid, role_oid) AS (
      SELECT browser_role.oid, membership.roleid
      FROM pg_catalog.pg_roles AS browser_role
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = browser_role.oid
       AND (membership.inherit_option OR membership.set_option OR membership.admin_option)
      WHERE browser_role.rolname IN ('anon', 'authenticated')
      UNION
      SELECT inherited.root_oid, membership.roleid
      FROM browser_authority AS inherited
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = inherited.role_oid
      WHERE membership.inherit_option OR membership.set_option OR membership.admin_option
    )
    SELECT 1
    FROM browser_authority AS inherited
    WHERE inherited.role_oid IN (v_authenticator, v_service, v_postgres)
  ) THEN
    RAISE EXCEPTION
      'trader_activities service_role membership or SET graph drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
