-- Keep group-application review authority on the existing service-only atomic
-- RPCs. Applicant reads already use the authenticated server API and its
-- explicit six-field allowlist, so browsers need no direct table/view access.

BEGIN;

DO $required_relation$
BEGIN
  IF pg_catalog.to_regclass('public.group_applications') IS NULL
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

REVOKE ALL PRIVILEGES ON public.group_applications
  FROM PUBLIC, anon, authenticated;

DO $revoke_group_application_column_access$
DECLARE
  column_list text;
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
    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
        || 'ON public.group_applications FROM PUBLIC, anon, authenticated',
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
  submit_function oid := pg_catalog.to_regprocedure(
    'public.submit_group_application_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean)'
  );
  review_function oid := pg_catalog.to_regprocedure(
    'public.review_group_application_atomic(uuid,uuid,text,text,boolean)'
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
  ) THEN
    RAISE EXCEPTION 'service group-application ACL is incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_applications'::regclass
      AND policy.polname = 'server_role_mutation'
      AND policy.polcmd = '*'
      AND policy.polroles @> ARRAY[
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role')
      ]::oid[]
  ) THEN
    RAISE EXCEPTION 'service group-application policy is incomplete';
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

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_applications'::regclass
  ) <> 1 THEN
    RAISE EXCEPTION 'unexpected group-application policy remains';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid IN (submit_function, review_function)
      AND (
        NOT procedure.prosecdef
        OR procedure.proowner <> (
          SELECT role_info.oid
          FROM pg_catalog.pg_roles AS role_info
          WHERE role_info.rolname = 'postgres'
        )
      )
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
  ) THEN
    RAISE EXCEPTION 'atomic group-application RPC authority is incomplete';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
