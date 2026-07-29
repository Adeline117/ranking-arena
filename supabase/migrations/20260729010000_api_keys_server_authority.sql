-- API keys are authentication credentials and paid entitlement state.
-- Browser roles must use the authenticated server routes; direct PostgREST
-- access would expose full keys and allow callers to manufacture paid tiers.
-- The Stripe tier updater is SECURITY DEFINER, so its PostgreSQL-default
-- PUBLIC EXECUTE privilege must be closed by the same authority boundary.

BEGIN;

SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'public.api_keys:server-authority:v1',
    0
  )
);

DO $preflight$
DECLARE
  v_api_keys pg_catalog.regclass :=
    pg_catalog.to_regclass('public.api_keys');
  v_usage pg_catalog.regclass :=
    pg_catalog.to_regclass('public.api_key_usage_daily');
  v_user_profiles pg_catalog.regclass :=
    pg_catalog.to_regclass('public.user_profiles');
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
BEGIN
  IF v_postgres_oid IS NULL
    OR v_service_oid IS NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(ARRAY['anon', 'authenticated']::name[])
        AS required_role(role_name)
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.rolname = required_role.role_name
      WHERE role_row.oid IS NULL
    )
  THEN
    RAISE EXCEPTION 'required Supabase application role is missing';
  END IF;

  IF v_api_keys IS NULL OR v_usage IS NULL OR v_user_profiles IS NULL THEN
    RAISE EXCEPTION
      'API key tables and public.user_profiles must exist before authority hardening';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (v_api_keys, v_usage, v_user_profiles)
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
        OR relation.relowner <> v_postgres_oid
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (v_api_keys, v_usage, v_user_profiles)
       OR inheritance.inhparent IN (v_api_keys, v_usage, v_user_profiles)
  ) THEN
    RAISE EXCEPTION
      'API key authority requires ordinary permanent postgres-owned tables';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (v_api_keys, 'id', 'uuid'::pg_catalog.regtype, true),
        (v_api_keys, 'user_id', 'uuid'::pg_catalog.regtype, true),
        (v_api_keys, 'key', 'text'::pg_catalog.regtype, true),
        (v_api_keys, 'name', 'text'::pg_catalog.regtype, true),
        (v_api_keys, 'active', 'boolean'::pg_catalog.regtype, true),
        (v_api_keys, 'tier', 'text'::pg_catalog.regtype, true),
        (v_api_keys, 'daily_limit', 'integer'::pg_catalog.regtype, true),
        (
          v_api_keys,
          'request_count_today',
          'integer'::pg_catalog.regtype,
          true
        ),
        (
          v_api_keys,
          'last_used_at',
          'timestamp with time zone'::pg_catalog.regtype,
          false
        ),
        (
          v_api_keys,
          'created_at',
          'timestamp with time zone'::pg_catalog.regtype,
          true
        ),
        (
          v_api_keys,
          'revoked_at',
          'timestamp with time zone'::pg_catalog.regtype,
          false
        ),
        (v_usage, 'id', 'uuid'::pg_catalog.regtype, true),
        (v_usage, 'api_key_id', 'uuid'::pg_catalog.regtype, true),
        (v_usage, 'date', 'date'::pg_catalog.regtype, true),
        (v_usage, 'request_count', 'integer'::pg_catalog.regtype, true),
        (v_user_profiles, 'id', 'uuid'::pg_catalog.regtype, true),
        (v_user_profiles, 'api_tier', 'text'::pg_catalog.regtype, true),
        (
          v_user_profiles,
          'api_stripe_subscription_id',
          'text'::pg_catalog.regtype,
          false
        ),
        (
          v_user_profiles,
          'updated_at',
          'timestamp with time zone'::pg_catalog.regtype,
          false
        )
    ) AS required_column(
      relation_oid,
      column_name,
      type_oid,
      required_not_null
    )
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = required_column.relation_oid
     AND attribute.attname = required_column.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
       OR attribute.atttypid <> required_column.type_oid
       OR attribute.attgenerated <> ''
       OR (
         required_column.required_not_null
         AND NOT attribute.attnotnull
       )
  ) THEN
    RAISE EXCEPTION
      'API key tables have missing or incompatible server-route columns';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'public'
      AND routine.proname IN (
        'increment_api_key_usage',
        'reset_api_key_daily_counts',
        'rollup_api_key_usage',
        'update_user_api_tier'
      )
  ) <> 4
    OR pg_catalog.to_regprocedure(
      'public.increment_api_key_usage(text)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.reset_api_key_daily_counts()'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.rollup_api_key_usage()'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.update_user_api_tier(uuid,text,text,integer)'
    ) IS NULL
  THEN
    RAISE EXCEPTION
      'API key RPC set is missing or contains an unreviewed overload';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'public.increment_api_key_usage(text)'::pg_catalog.regprocedure,
          'record'::pg_catalog.regtype,
          true,
          false
        ),
        (
          'public.reset_api_key_daily_counts()'::pg_catalog.regprocedure,
          'void'::pg_catalog.regtype,
          false,
          false
        ),
        (
          'public.rollup_api_key_usage()'::pg_catalog.regprocedure,
          'void'::pg_catalog.regtype,
          false,
          false
        ),
        (
          'public.update_user_api_tier(uuid,text,text,integer)'::pg_catalog.regprocedure,
          'void'::pg_catalog.regtype,
          false,
          true
        )
    ) AS required_routine(
      routine_oid,
      return_type_oid,
      returns_set,
      security_definer
    )
    JOIN pg_catalog.pg_proc AS routine
      ON routine.oid = required_routine.routine_oid
    WHERE routine.proowner <> v_postgres_oid
       OR routine.prokind <> 'f'
       OR routine.prorettype <> required_routine.return_type_oid
       OR routine.proretset <> required_routine.returns_set
       OR routine.prosecdef <> required_routine.security_definer
  ) THEN
    RAISE EXCEPTION
      'API key RPC owner, return shape, or invoker authority drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.oid =
      'public.increment_api_key_usage(text)'::pg_catalog.regprocedure
      AND (
        routine.pronargs <> 1
        OR routine.pronargdefaults <> 0
        OR routine.proargnames IS DISTINCT FROM ARRAY[
          'p_key',
          'allowed',
          'remaining',
          'daily_limit'
        ]::text[]
      )
  ) THEN
    RAISE EXCEPTION
      'increment_api_key_usage input/output-name contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.oid =
      'public.update_user_api_tier(uuid,text,text,integer)'::pg_catalog.regprocedure
      AND (
        routine.pronargs <> 4
        OR routine.pronargdefaults <> 0
        OR routine.proargnames IS DISTINCT FROM ARRAY[
          'p_user_id',
          'p_api_tier',
          'p_stripe_subscription_id',
          'p_daily_limit'
        ]::text[]
        OR routine.proconfig IS DISTINCT FROM
          ARRAY['search_path=public']::text[]
      )
  ) THEN
    RAISE EXCEPTION
      'update_user_api_tier input-name or trusted search_path contract drifted';
  END IF;

  -- Browser JWT roles must not inherit the server role or the object owner.
  IF EXISTS (
    WITH RECURSIVE jwt_inherits(root_oid, role_oid) AS (
      SELECT jwt_role.oid, membership.roleid
      FROM pg_catalog.pg_roles AS jwt_role
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = jwt_role.oid
       AND membership.inherit_option
      WHERE jwt_role.rolname IN ('anon', 'authenticated')
      UNION
      SELECT inherited.root_oid, membership.roleid
      FROM jwt_inherits AS inherited
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = inherited.role_oid
       AND membership.inherit_option
    )
    SELECT 1
    FROM jwt_inherits AS inherited
    WHERE inherited.role_oid IN (v_service_oid, v_postgres_oid)
  ) THEN
    RAISE EXCEPTION
      'browser role inherits API key server authority';
  END IF;
END
$preflight$;

LOCK TABLE public.api_keys, public.api_key_usage_daily
  IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.user_profiles IN ACCESS SHARE MODE;

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.api_key_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_key_usage_daily NO FORCE ROW LEVEL SECURITY;

-- Remove every non-owner table and column ACL, including dashboard/manual
-- grants and direct column grants that a table-level REVOKE does not touch.
DO $revoke_nonowner_table_acl$
DECLARE
  v_relation pg_catalog.regclass;
  v_relation_sql text;
  v_owner_oid oid;
  v_column_list text;
  v_grantee_oids oid[];
  v_grantee_oid oid;
  v_grantee_name name;
  v_grantee_sql text;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.api_keys'::pg_catalog.regclass,
    'public.api_key_usage_daily'::pg_catalog.regclass
  ]
  LOOP
    SELECT
      pg_catalog.format('%I.%I', namespace.nspname, relation.relname),
      relation.relowner
    INTO v_relation_sql, v_owner_oid
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE relation.oid = v_relation;

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
      RAISE EXCEPTION '% has no columns to secure', v_relation_sql;
    END IF;

    SELECT pg_catalog.array_agg(DISTINCT discovered.grantee)
    INTO v_grantee_oids
    FROM (
      SELECT table_acl.grantee
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS table_acl
      WHERE relation.oid = v_relation
      UNION
      SELECT column_acl.grantee
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS column_acl
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) AS discovered
    WHERE discovered.grantee <> v_owner_oid;

    FOREACH v_grantee_oid IN ARRAY
      COALESCE(v_grantee_oids, ARRAY[]::oid[])
    LOOP
      IF v_grantee_oid = 0::oid THEN
        v_grantee_sql := 'PUBLIC';
      ELSE
        SELECT role_row.rolname
        INTO v_grantee_name
        FROM pg_catalog.pg_roles AS role_row
        WHERE role_row.oid = v_grantee_oid;

        IF v_grantee_name IS NULL THEN
          RAISE EXCEPTION
            'dangling API key table ACL grantee oid: %',
            v_grantee_oid;
        END IF;
        v_grantee_sql := pg_catalog.format('%I', v_grantee_name);
      END IF;

      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE %s FROM %s CASCADE',
        v_relation_sql,
        v_grantee_sql
      );
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), '
          || 'REFERENCES (%1$s) ON TABLE %2$s FROM %3$s CASCADE',
        v_column_list,
        v_relation_sql,
        v_grantee_sql
      );
    END LOOP;
  END LOOP;
END
$revoke_nonowner_table_acl$;

DO $drop_all_api_key_policies$
DECLARE
  v_relation pg_catalog.regclass;
  v_relation_sql text;
  v_policy_name name;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.api_keys'::pg_catalog.regclass,
    'public.api_key_usage_daily'::pg_catalog.regclass
  ]
  LOOP
    SELECT pg_catalog.format(
      '%I.%I',
      namespace.nspname,
      relation.relname
    )
    INTO v_relation_sql
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE relation.oid = v_relation;

    FOR v_policy_name IN
      SELECT policy.polname
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_relation
      ORDER BY policy.polname
    LOOP
      EXECUTE pg_catalog.format(
        'DROP POLICY %I ON %s',
        v_policy_name,
        v_relation_sql
      );
    END LOOP;
  END LOOP;
END
$drop_all_api_key_policies$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.api_keys, public.api_key_usage_daily
  TO service_role;

CREATE POLICY service_role_manages_api_keys
  ON public.api_keys
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY service_role_manages_api_key_usage_daily
  ON public.api_key_usage_daily
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- PostgreSQL grants function EXECUTE to PUBLIC by default. Revoke every
-- non-owner routine ACL before installing the exact server-only contract.
DO $revoke_nonowner_routine_acl$
DECLARE
  v_routine pg_catalog.regprocedure;
  v_routine_sql text;
  v_owner_oid oid;
  v_grantee_oids oid[];
  v_grantee_oid oid;
  v_grantee_name name;
  v_grantee_sql text;
BEGIN
  FOREACH v_routine IN ARRAY ARRAY[
    'public.increment_api_key_usage(text)'::pg_catalog.regprocedure,
    'public.reset_api_key_daily_counts()'::pg_catalog.regprocedure,
    'public.rollup_api_key_usage()'::pg_catalog.regprocedure,
    'public.update_user_api_tier(uuid,text,text,integer)'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT
      pg_catalog.format(
        '%I.%I(%s)',
        namespace.nspname,
        routine.proname,
        pg_catalog.pg_get_function_identity_arguments(routine.oid)
      ),
      routine.proowner
    INTO v_routine_sql, v_owner_oid
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE routine.oid = v_routine;

    SELECT pg_catalog.array_agg(DISTINCT acl_entry.grantee)
    INTO v_grantee_oids
    FROM pg_catalog.pg_proc AS routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        routine.proacl,
        pg_catalog.acldefault('f', routine.proowner)
      )
    ) AS acl_entry
    WHERE routine.oid = v_routine
      AND acl_entry.grantee <> v_owner_oid;

    FOREACH v_grantee_oid IN ARRAY
      COALESCE(v_grantee_oids, ARRAY[]::oid[])
    LOOP
      IF v_grantee_oid = 0::oid THEN
        v_grantee_sql := 'PUBLIC';
      ELSE
        SELECT role_row.rolname
        INTO v_grantee_name
        FROM pg_catalog.pg_roles AS role_row
        WHERE role_row.oid = v_grantee_oid;

        IF v_grantee_name IS NULL THEN
          RAISE EXCEPTION
            'dangling API key routine ACL grantee oid: %',
            v_grantee_oid;
        END IF;
        v_grantee_sql := pg_catalog.format('%I', v_grantee_name);
      END IF;

      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s CASCADE',
        v_routine_sql,
        v_grantee_sql
      );
    END LOOP;
  END LOOP;
END
$revoke_nonowner_routine_acl$;

GRANT EXECUTE
  ON FUNCTION public.increment_api_key_usage(text)
  TO service_role;
GRANT EXECUTE
  ON FUNCTION public.reset_api_key_daily_counts()
  TO service_role;
GRANT EXECUTE
  ON FUNCTION public.rollup_api_key_usage()
  TO service_role;
GRANT EXECUTE
  ON FUNCTION public.update_user_api_tier(uuid, text, text, integer)
  TO service_role;

DO $postflight$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_relation pg_catalog.regclass;
  v_relation_sql text;
  v_expected_policy name;
  v_service_privileges text[];
  v_role name;
  v_privilege text;
  v_column name;
  v_routine pg_catalog.regprocedure;
  v_routine_sql text;
  v_owner_oid oid;
BEGIN
  FOR v_relation, v_expected_policy IN
    SELECT *
    FROM (
      VALUES
        (
          'public.api_keys'::pg_catalog.regclass,
          'service_role_manages_api_keys'::name
        ),
        (
          'public.api_key_usage_daily'::pg_catalog.regclass,
          'service_role_manages_api_key_usage_daily'::name
        )
    ) AS expected(relation_oid, policy_name)
  LOOP
    SELECT pg_catalog.format(
      '%I.%I',
      namespace.nspname,
      relation.relname
    )
    INTO v_relation_sql
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE relation.oid = v_relation;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND NOT relation.relispartition
        AND relation.relowner = v_postgres_oid
        AND relation.relrowsecurity
        AND NOT relation.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION
        '% table owner/RLS authority seal is incomplete',
        v_relation_sql;
    END IF;

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
        AND acl_entry.grantee NOT IN (relation.relowner, v_service_oid)
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee <> v_postgres_oid
    ) THEN
      RAISE EXCEPTION
        'non-owner or direct column ACL remains on %',
        v_relation_sql;
    END IF;

    SELECT pg_catalog.array_agg(
      acl_entry.privilege_type
      ORDER BY acl_entry.privilege_type
    )
    INTO v_service_privileges
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = v_relation
      AND acl_entry.grantee = v_service_oid
      AND NOT acl_entry.is_grantable;

    IF v_service_privileges IS DISTINCT FROM
      ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS relation
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            relation.relacl,
            pg_catalog.acldefault('r', relation.relowner)
          )
        ) AS acl_entry
        WHERE relation.oid = v_relation
          AND acl_entry.grantee = v_service_oid
          AND (
            acl_entry.is_grantable
            OR acl_entry.grantor <> v_postgres_oid
          )
      )
    THEN
      RAISE EXCEPTION
        'service_role ACL is not exact CRUD on %',
        v_relation_sql;
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
            '% still has % on %',
            v_role,
            v_privilege,
            v_relation_sql;
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
              '% still has column % on %.%',
              v_role,
              v_privilege,
              v_relation_sql,
              v_column;
          END IF;
        END LOOP;
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
        AND policy.polname = v_expected_policy
        AND policy.polpermissive
        AND policy.polcmd = '*'
        AND policy.polroles = ARRAY[v_service_oid]::oid[]
        AND pg_catalog.pg_get_expr(
          policy.polqual,
          policy.polrelid
        ) = 'true'
        AND pg_catalog.pg_get_expr(
          policy.polwithcheck,
          policy.polrelid
        ) = 'true'
    ) THEN
      RAISE EXCEPTION
        'policies did not converge to service-only ALL on %',
        v_relation_sql;
    END IF;
  END LOOP;

  FOREACH v_routine IN ARRAY ARRAY[
    'public.increment_api_key_usage(text)'::pg_catalog.regprocedure,
    'public.reset_api_key_daily_counts()'::pg_catalog.regprocedure,
    'public.rollup_api_key_usage()'::pg_catalog.regprocedure,
    'public.update_user_api_tier(uuid,text,text,integer)'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT
      pg_catalog.format(
        '%I.%I(%s)',
        namespace.nspname,
        routine.proname,
        pg_catalog.pg_get_function_identity_arguments(routine.oid)
      ),
      routine.proowner
    INTO v_routine_sql, v_owner_oid
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE routine.oid = v_routine;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          routine.proacl,
          pg_catalog.acldefault('f', routine.proowner)
        )
      ) AS acl_entry
      WHERE routine.oid = v_routine
        AND acl_entry.grantee NOT IN (v_owner_oid, v_service_oid)
    ) OR (
      SELECT pg_catalog.array_agg(
        acl_entry.privilege_type
        ORDER BY acl_entry.privilege_type
      )
      FROM pg_catalog.pg_proc AS routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          routine.proacl,
          pg_catalog.acldefault('f', routine.proowner)
        )
      ) AS acl_entry
      WHERE routine.oid = v_routine
        AND acl_entry.grantee = v_service_oid
        AND NOT acl_entry.is_grantable
    ) IS DISTINCT FROM ARRAY['EXECUTE']::text[]
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS routine
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            routine.proacl,
            pg_catalog.acldefault('f', routine.proowner)
          )
        ) AS acl_entry
        WHERE routine.oid = v_routine
          AND acl_entry.grantee = v_service_oid
          AND (
            acl_entry.is_grantable
            OR acl_entry.grantor <> v_postgres_oid
          )
      )
    THEN
      RAISE EXCEPTION
        'routine ACL is not exact service-only EXECUTE on %',
        v_routine_sql;
    END IF;

    IF pg_catalog.has_function_privilege(
      'anon',
      v_routine,
      'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticated',
      v_routine,
      'EXECUTE'
    ) THEN
      RAISE EXCEPTION
        'browser role retains EXECUTE on %',
        v_routine_sql;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.oid =
      'public.increment_api_key_usage(text)'::pg_catalog.regprocedure
      AND (
        routine.proowner <> v_postgres_oid
        OR routine.prosecdef
        OR routine.proargnames IS DISTINCT FROM ARRAY[
          'p_key',
          'allowed',
          'remaining',
          'daily_limit'
        ]::text[]
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.oid =
      'public.update_user_api_tier(uuid,text,text,integer)'::pg_catalog.regprocedure
      AND (
        routine.proowner <> v_postgres_oid
        OR NOT routine.prosecdef
        OR routine.proconfig IS DISTINCT FROM
          ARRAY['search_path=public']::text[]
        OR routine.proargnames IS DISTINCT FROM ARRAY[
          'p_user_id',
          'p_api_tier',
          'p_stripe_subscription_id',
          'p_daily_limit'
        ]::text[]
      )
  ) THEN
    RAISE EXCEPTION
      'API key RPC trusted owner/input/search_path seal drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'public'
      AND routine.proname IN (
        'increment_api_key_usage',
        'reset_api_key_daily_counts',
        'rollup_api_key_usage',
        'update_user_api_tier'
      )
  ) <> 4 THEN
    RAISE EXCEPTION
      'API key RPC set acquired an unreviewed overload during migration';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
