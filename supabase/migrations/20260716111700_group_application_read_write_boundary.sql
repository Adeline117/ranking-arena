-- Keep group-application review authority on the existing service-only atomic
-- RPCs. Applicant reads already use the authenticated server API and its
-- explicit six-field allowlist, so browsers need no direct table/view access.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('group-application-authority-migrations', 0)
);

DO $required_relation$
BEGIN
  IF pg_catalog.to_regclass('public.group_applications') IS NULL
    OR pg_catalog.to_regprocedure(
      'public.has_current_global_pro_entitlement(uuid)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.submit_group_application_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.review_group_application_atomic(uuid,uuid,text,text,boolean)'
    ) IS NULL
  THEN
    RAISE EXCEPTION 'atomic group-application boundary must exist before its ACL lockdown';
  END IF;
END
$required_relation$;

-- Block concurrent table/policy/ACL changes before replacing any authority.
-- lock_timeout bounds this ACCESS EXCLUSIVE acquisition on a busy production
-- table; a timeout rolls the whole migration back without partial ACL drift.
LOCK TABLE public.group_applications IN ACCESS EXCLUSIVE MODE;

DROP FUNCTION IF EXISTS public.submit_group_application_atomic(
  uuid, text, text, text, text, text, jsonb, jsonb, text, boolean
);
DROP FUNCTION IF EXISTS public.review_group_application_atomic(
  uuid, uuid, text, text
);

DO $drop_noncanonical_group_application_routines$
DECLARE
  routine record;
BEGIN
  FOR routine IN
    SELECT
      function_namespace.nspname,
      procedure.proname,
      pg_catalog.pg_get_function_identity_arguments(procedure.oid) AS identity_arguments
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS function_namespace
      ON function_namespace.oid = procedure.pronamespace
    WHERE function_namespace.nspname = 'public'
      AND procedure.proname IN (
        'submit_group_application_atomic',
        'review_group_application_atomic'
      )
      AND procedure.prokind IN ('f', 'p')
      AND procedure.oid NOT IN (
        pg_catalog.to_regprocedure(
          'public.submit_group_application_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean)'
        ),
        pg_catalog.to_regprocedure(
          'public.review_group_application_atomic(uuid,uuid,text,text,boolean)'
        )
      )
  LOOP
    EXECUTE pg_catalog.format(
      'DROP ROUTINE %I.%I(%s) RESTRICT',
      routine.nspname,
      routine.proname,
      routine.identity_arguments
    );
  END LOOP;
END
$drop_noncanonical_group_application_routines$;

ALTER TABLE public.group_applications ENABLE ROW LEVEL SECURITY;

DROP VIEW IF EXISTS public.own_group_applications;

DO $replace_group_application_policies$
DECLARE
  policy_row record;
BEGIN
  FOR policy_row IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_applications'::regclass
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.group_applications',
      policy_row.polname
    );
  END LOOP;
END
$replace_group_application_policies$;

DO $revoke_nonowner_group_application_table_access$
DECLARE
  grantee record;
BEGIN
  FOR grantee IN
    SELECT DISTINCT acl.grantee, role_info.rolname
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl
    LEFT JOIN pg_catalog.pg_roles AS role_info
      ON role_info.oid = acl.grantee
    WHERE relation.oid = 'public.group_applications'::regclass
      AND acl.grantee <> relation.relowner
  LOOP
    IF grantee.grantee = 0 THEN
      REVOKE ALL PRIVILEGES ON public.group_applications FROM PUBLIC;
    ELSIF grantee.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON public.group_applications FROM %I',
        grantee.rolname
      );
    END IF;
  END LOOP;
END
$revoke_nonowner_group_application_table_access$;

REVOKE ALL PRIVILEGES ON public.group_applications
  FROM PUBLIC, anon, authenticated, service_role;

DO $revoke_group_application_column_access$
DECLARE
  column_list text;
  grantee record;
BEGIN
  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', '
    ORDER BY attribute.attnum
  )
  INTO column_list
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.group_applications'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF column_list IS NOT NULL THEN
    FOR grantee IN
      SELECT DISTINCT acl.grantee, role_info.rolname
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl
      LEFT JOIN pg_catalog.pg_roles AS role_info
        ON role_info.oid = acl.grantee
      WHERE attribute.attrelid = 'public.group_applications'::regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl.grantee <> (
          SELECT relation.relowner
          FROM pg_catalog.pg_class AS relation
          WHERE relation.oid = 'public.group_applications'::regclass
        )
    LOOP
      IF grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
            || 'ON public.group_applications FROM PUBLIC',
          column_list
        );
      ELSIF grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
            || 'ON public.group_applications FROM %2$I',
          column_list,
          grantee.rolname
        );
      END IF;
    END LOOP;

    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
        || 'ON public.group_applications FROM PUBLIC, anon, authenticated, service_role',
      column_list
    );
  END IF;
END
$revoke_group_application_column_access$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.group_applications TO service_role;

CREATE POLICY server_role_mutation
  ON public.group_applications
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DO $revoke_nonowner_group_application_function_access$
DECLARE
  grantee record;
BEGIN
  FOR grantee IN
    SELECT DISTINCT
      function_namespace.nspname,
      procedure.proname,
      pg_catalog.pg_get_function_identity_arguments(procedure.oid) AS identity_arguments,
      acl.grantee,
      role_info.rolname
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS function_namespace
      ON function_namespace.oid = procedure.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS acl
    LEFT JOIN pg_catalog.pg_roles AS role_info
      ON role_info.oid = acl.grantee
    WHERE procedure.oid IN (
      pg_catalog.to_regprocedure('public.has_current_global_pro_entitlement(uuid)'),
      pg_catalog.to_regprocedure(
        'public.submit_group_application_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean)'
      ),
      pg_catalog.to_regprocedure(
        'public.review_group_application_atomic(uuid,uuid,text,text,boolean)'
      )
    )
      AND acl.grantee <> procedure.proowner
  LOOP
    IF grantee.grantee = 0 THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM PUBLIC',
        grantee.nspname,
        grantee.proname,
        grantee.identity_arguments
      );
    ELSIF grantee.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM %I',
        grantee.nspname,
        grantee.proname,
        grantee.identity_arguments,
        grantee.rolname
      );
    END IF;
  END LOOP;
END
$revoke_nonowner_group_application_function_access$;

REVOKE ALL ON FUNCTION public.has_current_global_pro_entitlement(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.submit_group_application_atomic(
  uuid, text, text, text, text, text, jsonb, jsonb, text, boolean, boolean
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_group_application_atomic(
  uuid, text, text, text, text, text, jsonb, jsonb, text, boolean, boolean
) TO service_role;

REVOKE ALL ON FUNCTION public.review_group_application_atomic(
  uuid, uuid, text, text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_group_application_atomic(
  uuid, uuid, text, text, boolean
) TO service_role;

DO $postflight$
DECLARE
  entitlement_function oid := pg_catalog.to_regprocedure(
    'public.has_current_global_pro_entitlement(uuid)'
  );
  submit_function oid := pg_catalog.to_regprocedure(
    'public.submit_group_application_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean)'
  );
  review_function oid := pg_catalog.to_regprocedure(
    'public.review_group_application_atomic(uuid,uuid,text,text,boolean)'
  );
  postgres_role_oid oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres'
  );
  service_role_oid oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role'
  );
  unsafe_role_oids oid[] := ARRAY[
    0::oid,
    (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'anon'),
    (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated')
  ];
BEGIN
  IF pg_catalog.has_table_privilege(
    'anon',
    'public.group_applications',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR pg_catalog.has_table_privilege(
    'authenticated',
    'public.group_applications',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR pg_catalog.has_any_column_privilege(
    'anon',
    'public.group_applications',
    'SELECT,INSERT,UPDATE,REFERENCES'
  ) OR pg_catalog.has_any_column_privilege(
    'authenticated',
    'public.group_applications',
    'SELECT,INSERT,UPDATE,REFERENCES'
  ) THEN
    RAISE EXCEPTION 'JWT privilege remains on group_applications';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl
    WHERE relation.oid = 'public.group_applications'::regclass
      AND acl.grantee NOT IN (relation.relowner, service_role_oid)
  ) THEN
    RAISE EXCEPTION 'non-service table ACL remains on group_applications';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_applications'::regclass
      AND policy.polroles && unsafe_role_oids
  ) THEN
    RAISE EXCEPTION 'JWT policy remains on group_applications';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
    'service_role',
    'public.group_applications',
    'SELECT'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role',
    'public.group_applications',
    'INSERT'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role',
    'public.group_applications',
    'UPDATE'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role',
    'public.group_applications',
    'DELETE'
  ) OR pg_catalog.has_table_privilege(
    'service_role',
    'public.group_applications',
    'TRUNCATE,REFERENCES,TRIGGER'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS acl
    WHERE relation.oid = 'public.group_applications'::regclass
      AND acl.grantee = service_role_oid
      AND acl.is_grantable
  ) OR (
    SELECT pg_catalog.array_agg(
      DISTINCT acl.privilege_type
      ORDER BY acl.privilege_type
    )
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl
    WHERE relation.oid = 'public.group_applications'::regclass
      AND acl.grantee = service_role_oid
  ) IS DISTINCT FROM ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[] THEN
    RAISE EXCEPTION 'service group-application table ACL is not exact CRUD';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = attribute.attrelid
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl
    WHERE attribute.attrelid = 'public.group_applications'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl.grantee <> relation.relowner
  ) THEN
    RAISE EXCEPTION 'nonowner column ACL remains on group_applications';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_applications'::regclass
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_applications'::regclass
      AND policy.polname = 'server_role_mutation'
      AND policy.polcmd = '*'
      AND policy.polpermissive
      AND policy.polroles = ARRAY[service_role_oid]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true) = 'true'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, true) = 'true'
  ) THEN
    RAISE EXCEPTION 'service group-application policy is not exact';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_applications'::regclass
      AND relation.relkind IN ('r', 'p')
      AND relation.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'group-application RLS is disabled';
  END IF;

  IF entitlement_function IS NULL
    OR submit_function IS NULL
    OR review_function IS NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS function_namespace
        ON function_namespace.oid = procedure.pronamespace
      WHERE function_namespace.nspname = 'public'
        AND (
          (procedure.proname = 'submit_group_application_atomic'
            AND procedure.oid <> submit_function)
          OR (procedure.proname = 'review_group_application_atomic'
            AND procedure.oid <> review_function)
        )
    ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid IN (entitlement_function, submit_function, review_function)
      AND (
        procedure.prokind <> 'f'
        OR
        NOT procedure.prosecdef
        OR procedure.proowner <> postgres_role_oid
      )
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    entitlement_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    entitlement_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    entitlement_function,
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    submit_function,
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    review_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    submit_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    submit_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    review_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    review_function,
    'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS acl
    WHERE procedure.oid IN (submit_function, review_function)
      AND acl.privilege_type = 'EXECUTE'
      AND (
        acl.grantee NOT IN (postgres_role_oid, service_role_oid)
        OR (acl.grantee = service_role_oid AND acl.is_grantable)
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS acl
    WHERE procedure.oid = entitlement_function
      AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee <> postgres_role_oid
  ) THEN
    RAISE EXCEPTION 'atomic group-application RPC authority is not service-only';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
