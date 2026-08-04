-- Post interaction read privacy.
--
-- Reaction and vote rows expose a viewer's identity together with their exact
-- choice.  They are private viewer state, not public post aggregates.  Keep
-- aggregate counters on posts public, but converge these two source tables to
-- authenticated-own reads plus explicit service/owner authority.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'ranking-arena:post-interaction-read-privacy:v1',
    0
  )
);

DO $preflight$
DECLARE
  v_auth_uid regprocedure := pg_catalog.to_regprocedure('auth.uid()');
  v_reaction_rpc regprocedure := pg_catalog.to_regprocedure(
    'public.toggle_post_reaction(uuid,uuid,text)'
  );
  v_vote_rpc regprocedure := pg_catalog.to_regprocedure(
    'public.toggle_post_vote_atomic(uuid,uuid,text)'
  );
  v_hashtag_projection regprocedure := pg_catalog.to_regprocedure(
    'public.get_hashtag_posts_page(uuid,text,integer,integer,text)'
  );
BEGIN
  IF EXISTS (
    SELECT required_role.role_name
    FROM (VALUES
      ('anon'::name),
      ('authenticated'::name),
      ('service_role'::name),
      ('postgres'::name)
    ) AS required_role(role_name)
    LEFT JOIN pg_catalog.pg_roles AS installed_role
      ON installed_role.rolname = required_role.role_name
    WHERE installed_role.oid IS NULL
  ) THEN
    RAISE EXCEPTION 'post interaction privacy roles are missing';
  END IF;

  -- authenticator is intentionally not a prerequisite.  Some isolated and
  -- self-hosted installations do not create it; ACL convergence below still
  -- removes its grants dynamically whenever the role is present.
  IF pg_catalog.to_regclass('public.post_likes') IS NULL
     OR pg_catalog.to_regclass('public.post_votes') IS NULL THEN
    RAISE EXCEPTION 'post interaction privacy tables are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.post_likes'::pg_catalog.regclass,
      'public.post_votes'::pg_catalog.regclass
    )
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
        OR pg_catalog.pg_get_userbyid(relation.relowner) <> 'postgres'
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'public.post_likes'::pg_catalog.regclass,
      'public.post_votes'::pg_catalog.regclass
    )
       OR inheritance.inhparent IN (
         'public.post_likes'::pg_catalog.regclass,
         'public.post_votes'::pg_catalog.regclass
       )
  ) THEN
    RAISE EXCEPTION 'post interaction privacy tables are incompatible';
  END IF;

  IF v_auth_uid IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_auth_uid
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'uuid'::pg_catalog.regtype
      AND function_row.provolatile IN ('i'::"char", 's'::"char")
  ) THEN
    RAISE EXCEPTION 'auth.uid() is incompatible';
  END IF;

  -- FORCE RLS changes the execution environment of the three active readers /
  -- writers that touch these tables. Refuse to change table authority if a
  -- prerequisite function has disappeared or lost its postgres-owned
  -- SECURITY DEFINER boundary; otherwise the migration could commit before
  -- the first user request reveals the owner drift.
  IF v_reaction_rpc IS NULL
     OR v_vote_rpc IS NULL
     OR v_hashtag_projection IS NULL
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid IN (
         v_reaction_rpc,
         v_vote_rpc,
         v_hashtag_projection
       )
         AND function_row.prokind = 'f'
         AND function_row.prosecdef
         AND pg_catalog.pg_get_userbyid(function_row.proowner) = 'postgres'
     ) <> 3
  THEN
    RAISE EXCEPTION 'post interaction owner functions are incompatible';
  END IF;

  IF EXISTS (
    SELECT required_column.relation_oid
    FROM (VALUES
      (
        'public.post_likes'::pg_catalog.regclass,
        'user_id'::name,
        'uuid'::pg_catalog.regtype
      ),
      (
        'public.post_votes'::pg_catalog.regclass,
        'user_id'::name,
        'uuid'::pg_catalog.regtype
      )
    ) AS required_column(relation_oid, column_name, type_oid)
    LEFT JOIN pg_catalog.pg_attribute AS installed_column
      ON installed_column.attrelid = required_column.relation_oid
     AND installed_column.attname = required_column.column_name
     AND installed_column.atttypid = required_column.type_oid
     AND installed_column.attnum > 0
     AND NOT installed_column.attisdropped
    WHERE installed_column.attrelid IS NULL
  ) THEN
    RAISE EXCEPTION 'post interaction privacy identity columns are incompatible';
  END IF;
END;
$preflight$;

LOCK TABLE public.post_likes, public.post_votes
  IN ACCESS EXCLUSIVE MODE;

-- Remove every policy that can authorize SELECT, including historical or
-- drifted FOR ALL policies.  Pure INSERT/UPDATE/DELETE policies are left
-- untouched.  The new policy names are reserved so a same-name DML drift
-- cannot prevent deterministic repair.
DO $policy_convergence$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT
      policy_schema.nspname AS schema_name,
      policy_table.relname AS table_name,
      policy_row.polname AS policy_name
    FROM pg_catalog.pg_policy AS policy_row
    JOIN pg_catalog.pg_class AS policy_table
      ON policy_table.oid = policy_row.polrelid
    JOIN pg_catalog.pg_namespace AS policy_schema
      ON policy_schema.oid = policy_table.relnamespace
    WHERE policy_schema.nspname = 'public'
      AND policy_table.relname IN ('post_likes', 'post_votes')
      AND (
        policy_row.polcmd IN ('r'::"char", '*'::"char")
        OR policy_row.polname IN (
          'post_likes_authenticated_own_read',
          'post_likes_service_read',
          'post_likes_postgres_access',
          'post_votes_authenticated_own_read',
          'post_votes_service_read',
          'post_votes_postgres_access'
        )
      )
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON %I.%I',
      v_policy.policy_name,
      v_policy.schema_name,
      v_policy.table_name
    );
  END LOOP;
END;
$policy_convergence$;

ALTER TABLE public.post_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_likes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.post_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_votes FORCE ROW LEVEL SECURITY;

CREATE POLICY post_likes_authenticated_own_read
  ON public.post_likes
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY post_votes_authenticated_own_read
  ON public.post_votes
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- service_role is deliberately modeled without BYPASSRLS.  Existing server
-- routes therefore retain complete read visibility through an explicit policy.
CREATE POLICY post_likes_service_read
  ON public.post_likes
  AS PERMISSIVE
  FOR SELECT
  TO service_role
  USING (true);

CREATE POLICY post_votes_service_read
  ON public.post_votes
  AS PERMISSIVE
  FOR SELECT
  TO service_role
  USING (true);

-- Existing reaction/vote RPCs and enforcement triggers are SECURITY DEFINER
-- functions owned by postgres.  FORCE RLS makes their effective owner subject
-- to policy, so postgres needs explicit read/write authority without changing
-- any end-user DML grant or pure DML policy.
CREATE POLICY post_likes_postgres_access
  ON public.post_likes
  AS PERMISSIVE
  FOR ALL
  TO postgres
  USING (true)
  WITH CHECK (true);

CREATE POLICY post_votes_postgres_access
  ON public.post_votes
  AS PERMISSIVE
  FOR ALL
  TO postgres
  USING (true)
  WITH CHECK (true);

-- Converge every direct table-level SELECT ACL, including PUBLIC and unknown
-- historical roles.  Non-SELECT table privileges are intentionally untouched.
DO $revoke_table_select$
DECLARE
  v_acl record;
  v_grantee_sql text;
BEGIN
  FOR v_acl IN
    SELECT DISTINCT
      relation.oid::pg_catalog.regclass AS relation_name,
      acl_entry.grantee,
      role_row.rolname
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = acl_entry.grantee
    WHERE relation.oid IN (
      'public.post_likes'::pg_catalog.regclass,
      'public.post_votes'::pg_catalog.regclass
    )
      AND acl_entry.privilege_type = 'SELECT'
  LOOP
    IF v_acl.grantee = 0 THEN
      v_grantee_sql := 'PUBLIC';
    ELSIF v_acl.rolname IS NOT NULL THEN
      v_grantee_sql := pg_catalog.format('%I', v_acl.rolname);
    ELSE
      RAISE EXCEPTION 'unknown post interaction table ACL grantee: %',
        v_acl.grantee;
    END IF;

    EXECUTE pg_catalog.format(
      'REVOKE SELECT ON TABLE %s FROM %s',
      v_acl.relation_name,
      v_grantee_sql
    );
  END LOOP;
END;
$revoke_table_select$;

-- Table-level REVOKE does not remove column grants.  Remove every direct
-- column SELECT grant from every grantee before reinstalling table authority.
DO $revoke_column_select$
DECLARE
  v_acl record;
  v_column_list text;
  v_grantee_sql text;
BEGIN
  FOR v_acl IN
    SELECT DISTINCT
      attribute_row.attrelid::pg_catalog.regclass AS relation_name,
      acl_entry.grantee,
      role_row.rolname
    FROM pg_catalog.pg_attribute AS attribute_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute_row.attacl) AS acl_entry
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = acl_entry.grantee
    WHERE attribute_row.attrelid IN (
      'public.post_likes'::pg_catalog.regclass,
      'public.post_votes'::pg_catalog.regclass
    )
      AND attribute_row.attnum > 0
      AND NOT attribute_row.attisdropped
      AND acl_entry.privilege_type = 'SELECT'
  LOOP
    SELECT pg_catalog.string_agg(
      pg_catalog.format('%I', installed_column.attname),
      ', '
      ORDER BY installed_column.attnum
    )
    INTO v_column_list
    FROM pg_catalog.pg_attribute AS installed_column
    WHERE installed_column.attrelid = v_acl.relation_name
      AND installed_column.attnum > 0
      AND NOT installed_column.attisdropped;

    IF v_column_list IS NULL THEN
      RAISE EXCEPTION '% has no columns to secure', v_acl.relation_name;
    END IF;

    IF v_acl.grantee = 0 THEN
      v_grantee_sql := 'PUBLIC';
    ELSIF v_acl.rolname IS NOT NULL THEN
      v_grantee_sql := pg_catalog.format('%I', v_acl.rolname);
    ELSE
      RAISE EXCEPTION 'unknown post interaction column ACL grantee: %',
        v_acl.grantee;
    END IF;

    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%s) ON TABLE %s FROM %s',
      v_column_list,
      v_acl.relation_name,
      v_grantee_sql
    );
  END LOOP;
END;
$revoke_column_select$;

GRANT SELECT ON TABLE public.post_likes, public.post_votes
  TO authenticated, service_role, postgres;

DO $postflight$
DECLARE
  v_anon_oid oid;
  v_authenticated_oid oid;
  v_service_oid oid;
  v_postgres_oid oid;
  v_authenticator_oid oid;
  v_table regclass;
BEGIN
  SELECT role_row.oid INTO STRICT v_anon_oid
  FROM pg_catalog.pg_roles AS role_row WHERE role_row.rolname = 'anon';
  SELECT role_row.oid INTO STRICT v_authenticated_oid
  FROM pg_catalog.pg_roles AS role_row WHERE role_row.rolname = 'authenticated';
  SELECT role_row.oid INTO STRICT v_service_oid
  FROM pg_catalog.pg_roles AS role_row WHERE role_row.rolname = 'service_role';
  SELECT role_row.oid INTO STRICT v_postgres_oid
  FROM pg_catalog.pg_roles AS role_row WHERE role_row.rolname = 'postgres';
  SELECT role_row.oid INTO v_authenticator_oid
  FROM pg_catalog.pg_roles AS role_row WHERE role_row.rolname = 'authenticator';

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.post_likes'::pg_catalog.regclass,
      'public.post_votes'::pg_catalog.regclass
    )
      AND (NOT relation.relrowsecurity OR NOT relation.relforcerowsecurity)
  ) THEN
    RAISE EXCEPTION 'post interaction FORCE RLS convergence is incomplete';
  END IF;

  IF EXISTS (
    WITH installed_policy AS (
      SELECT
        policy_table.relname AS table_name,
        policy_row.polname AS policy_name,
        policy_row.polpermissive,
        policy_row.polcmd,
        policy_row.polroles,
        pg_catalog.pg_get_expr(
          policy_row.polqual,
          policy_row.polrelid
        ) AS using_expression,
        pg_catalog.pg_get_expr(
          policy_row.polwithcheck,
          policy_row.polrelid
        ) AS check_expression
      FROM pg_catalog.pg_policy AS policy_row
      JOIN pg_catalog.pg_class AS policy_table
        ON policy_table.oid = policy_row.polrelid
      WHERE policy_table.oid IN (
        'public.post_likes'::pg_catalog.regclass,
        'public.post_votes'::pg_catalog.regclass
      )
        AND policy_row.polcmd IN ('r'::"char", '*'::"char")
    ),
    expected_policy AS (
      SELECT *
      FROM (VALUES
        (
          'post_likes'::name,
          'post_likes_authenticated_own_read'::name,
          'r'::"char",
          ARRAY[v_authenticated_oid]::oid[]
        ),
        (
          'post_likes'::name,
          'post_likes_service_read'::name,
          'r'::"char",
          ARRAY[v_service_oid]::oid[]
        ),
        (
          'post_likes'::name,
          'post_likes_postgres_access'::name,
          '*'::"char",
          ARRAY[v_postgres_oid]::oid[]
        ),
        (
          'post_votes'::name,
          'post_votes_authenticated_own_read'::name,
          'r'::"char",
          ARRAY[v_authenticated_oid]::oid[]
        ),
        (
          'post_votes'::name,
          'post_votes_service_read'::name,
          'r'::"char",
          ARRAY[v_service_oid]::oid[]
        ),
        (
          'post_votes'::name,
          'post_votes_postgres_access'::name,
          '*'::"char",
          ARRAY[v_postgres_oid]::oid[]
        )
      ) AS expected(table_name, policy_name, command, roles)
    )
    SELECT 1
    FROM (
      ((SELECT table_name, policy_name, polcmd, polroles
        FROM installed_policy
        WHERE polpermissive)
       EXCEPT
       (SELECT table_name, policy_name, command, roles
        FROM expected_policy))
      UNION ALL
      ((SELECT table_name, policy_name, command, roles
        FROM expected_policy)
       EXCEPT
       (SELECT table_name, policy_name, polcmd, polroles
        FROM installed_policy
        WHERE polpermissive))
    ) AS unexpected
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid IN (
      'public.post_likes'::pg_catalog.regclass,
      'public.post_votes'::pg_catalog.regclass
    )
      AND policy_row.polcmd IN ('r'::"char", '*'::"char")
    HAVING pg_catalog.count(*) <> 6
  ) THEN
    RAISE EXCEPTION 'post interaction read policy convergence is incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid IN (
      'public.post_likes'::pg_catalog.regclass,
      'public.post_votes'::pg_catalog.regclass
    )
      AND policy_row.polname IN (
        'post_likes_authenticated_own_read',
        'post_votes_authenticated_own_read'
      )
      AND (
        policy_row.polwithcheck IS NOT NULL
        OR pg_catalog.strpos(
          pg_catalog.pg_get_expr(policy_row.polqual, policy_row.polrelid),
          'auth.uid()'
        ) = 0
        OR pg_catalog.strpos(
          pg_catalog.pg_get_expr(policy_row.polqual, policy_row.polrelid),
          'user_id'
        ) = 0
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid IN (
      'public.post_likes'::pg_catalog.regclass,
      'public.post_votes'::pg_catalog.regclass
    )
      AND policy_row.polname IN (
        'post_likes_service_read',
        'post_votes_service_read'
      )
      AND (
        pg_catalog.pg_get_expr(
          policy_row.polqual,
          policy_row.polrelid
        ) IS DISTINCT FROM 'true'
        OR policy_row.polwithcheck IS NOT NULL
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid IN (
      'public.post_likes'::pg_catalog.regclass,
      'public.post_votes'::pg_catalog.regclass
    )
      AND policy_row.polname IN (
        'post_likes_postgres_access',
        'post_votes_postgres_access'
      )
      AND (
        pg_catalog.pg_get_expr(
          policy_row.polqual,
          policy_row.polrelid
        ) IS DISTINCT FROM 'true'
        OR pg_catalog.pg_get_expr(
          policy_row.polwithcheck,
          policy_row.polrelid
        ) IS DISTINCT FROM 'true'
      )
  ) THEN
    RAISE EXCEPTION 'post interaction read policy expressions are incompatible';
  END IF;

  -- No column-specific SELECT ACL may remain.  The only direct table SELECT
  -- grantees are the three explicit authorities installed above.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute_row.attacl) AS acl_entry
    WHERE attribute_row.attrelid IN (
      'public.post_likes'::pg_catalog.regclass,
      'public.post_votes'::pg_catalog.regclass
    )
      AND attribute_row.attnum > 0
      AND NOT attribute_row.attisdropped
      AND acl_entry.privilege_type = 'SELECT'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid IN (
      'public.post_likes'::pg_catalog.regclass,
      'public.post_votes'::pg_catalog.regclass
    )
      AND acl_entry.privilege_type = 'SELECT'
      AND acl_entry.grantee NOT IN (
        v_authenticated_oid,
        v_service_oid,
        v_postgres_oid
      )
  ) THEN
    RAISE EXCEPTION 'post interaction SELECT ACL convergence is incomplete';
  END IF;

  FOREACH v_table IN ARRAY ARRAY[
    'public.post_likes'::pg_catalog.regclass,
    'public.post_votes'::pg_catalog.regclass
  ]
  LOOP
    IF pg_catalog.has_table_privilege('anon', v_table, 'SELECT')
       OR NOT pg_catalog.has_table_privilege(
         'authenticated', v_table, 'SELECT'
       )
       OR NOT pg_catalog.has_table_privilege(
         'service_role', v_table, 'SELECT'
       )
       OR NOT pg_catalog.has_table_privilege('postgres', v_table, 'SELECT')
       OR (
         v_authenticator_oid IS NOT NULL
         AND pg_catalog.has_table_privilege(
           'authenticator', v_table, 'SELECT'
         )
       )
    THEN
      RAISE EXCEPTION '% has incompatible effective SELECT ACLs', v_table;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute_row
      WHERE attribute_row.attrelid = v_table
        AND attribute_row.attnum > 0
        AND NOT attribute_row.attisdropped
        AND (
          pg_catalog.has_column_privilege(
            'anon', v_table, attribute_row.attnum, 'SELECT'
          )
          OR NOT pg_catalog.has_column_privilege(
            'authenticated', v_table, attribute_row.attnum, 'SELECT'
          )
          OR NOT pg_catalog.has_column_privilege(
            'service_role', v_table, attribute_row.attnum, 'SELECT'
          )
          OR NOT pg_catalog.has_column_privilege(
            'postgres', v_table, attribute_row.attnum, 'SELECT'
          )
          OR (
            v_authenticator_oid IS NOT NULL
            AND pg_catalog.has_column_privilege(
              'authenticator', v_table, attribute_row.attnum, 'SELECT'
            )
          )
        )
    ) THEN
      RAISE EXCEPTION '% has incompatible effective column SELECT ACLs',
        v_table;
    END IF;
  END LOOP;
END;
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
