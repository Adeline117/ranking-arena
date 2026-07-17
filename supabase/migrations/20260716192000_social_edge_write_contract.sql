-- Contract phase for 20260716190000/191000. Deploy this migration only after
-- both follow and block API route commits are live. It removes the temporary
-- direct-write compatibility surface while preserving all existing reads.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('public.social-edges:write-contract:v1', 0)
);

DO $preflight$
DECLARE
  v_missing_roles text[];
  v_follow_function regprocedure := pg_catalog.to_regprocedure(
    'public.mutate_user_follow_atomic(uuid,uuid,text)'
  );
  v_block_function regprocedure := pg_catalog.to_regprocedure(
    'public.mutate_user_block_atomic(uuid,uuid,text)'
  );
  v_pair_function regprocedure := pg_catalog.to_regprocedure(
    'public.serialize_direct_message_pair_edge()'
  );
BEGIN
  IF pg_catalog.to_regclass('public.user_follows') IS NULL
     OR pg_catalog.to_regclass('public.blocked_users') IS NULL
  THEN
    RAISE EXCEPTION
      'social edge tables must exist before the direct-write contract';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = relation.relowner
    WHERE relation.oid IN (
      'public.user_follows'::pg_catalog.regclass,
      'public.blocked_users'::pg_catalog.regclass
    )
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR owner_role.rolname <> 'postgres'
      )
  ) THEN
    RAISE EXCEPTION
      'social edge tables must be permanent ordinary postgres-owned tables';
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
    RAISE EXCEPTION 'social edge ACL roles are missing: %', v_missing_roles;
  END IF;

  IF v_follow_function IS NULL OR v_block_function IS NULL THEN
    RAISE EXCEPTION
      'atomic follow and block RPCs must exist before direct-write revocation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid IN (v_follow_function, v_block_function)
      AND (
        NOT function_row.prosecdef
        OR function_row.prorettype <> 'jsonb'::pg_catalog.regtype
        OR function_row.provolatile <> 'v'
      )
  ) THEN
    RAISE EXCEPTION 'atomic social edge RPC metadata is incompatible';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role', v_follow_function, 'EXECUTE'
     ) OR NOT pg_catalog.has_function_privilege(
       'service_role', v_block_function, 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'authenticated', v_follow_function, 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'authenticated', v_block_function, 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'anon', v_follow_function, 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'anon', v_block_function, 'EXECUTE'
     )
  THEN
    RAISE EXCEPTION 'atomic social edge RPC execute boundary is incompatible';
  END IF;

  IF v_pair_function IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_follows'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_serialize_dm_follow_pair'
      AND trigger_row.tgfoid = v_pair_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 31
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.blocked_users'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_serialize_dm_block_pair'
      AND trigger_row.tgfoid = v_pair_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 31
  ) THEN
    RAISE EXCEPTION 'canonical social edge serializer boundary is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhparent IN (
      'public.user_follows'::pg_catalog.regclass,
      'public.blocked_users'::pg_catalog.regclass
    )
  ) THEN
    RAISE EXCEPTION 'social edge tables must not have inherited children';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class IN (
      'public.user_follows'::pg_catalog.regclass,
      'public.blocked_users'::pg_catalog.regclass
    )
      AND rewrite_rule.rulename <> '_RETURN'
  ) THEN
    RAISE EXCEPTION 'social edge tables must not have user-defined rules';
  END IF;
END
$preflight$;

-- Policy and privilege changes share one short ACCESS EXCLUSIVE boundary so
-- no direct writer can cross from the old contract into the new one.
LOCK TABLE public.blocked_users, public.user_follows
  IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.blocked_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocked_users NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_follows NO FORCE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.blocked_users, public.user_follows
  FROM PUBLIC, anon, authenticated, service_role;

DO $revoke_column_mutations$
DECLARE
  v_relation regclass;
  v_column_list text;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.blocked_users'::pg_catalog.regclass,
    'public.user_follows'::pg_catalog.regclass
  ]
  LOOP
    SELECT pg_catalog.string_agg(
      pg_catalog.format('%I', attribute.attname),
      ', ' ORDER BY attribute.attnum
    )
    INTO STRICT v_column_list
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    EXECUTE pg_catalog.format(
      'REVOKE INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
        || 'ON TABLE %2$s FROM PUBLIC, anon, authenticated, service_role',
      v_column_list,
      v_relation
    );
  END LOOP;
END
$revoke_column_mutations$;

-- RLS is a second deny layer. Keep every SELECT-only policy untouched, while
-- eliminating historical INSERT/UPDATE/DELETE/FOR ALL mutation policies.
DO $drop_direct_mutation_policies$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT policy.polrelid, policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid IN (
      'public.blocked_users'::pg_catalog.regclass,
      'public.user_follows'::pg_catalog.regclass
    )
      AND policy.polcmd IN ('*', 'a', 'w', 'd')
    ORDER BY policy.polrelid, policy.polname
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON %s',
      v_policy.polname,
      v_policy.polrelid::pg_catalog.regclass
    );
  END LOOP;
END
$drop_direct_mutation_policies$;

DO $postflight$
DECLARE
  v_relation regclass;
  v_role text;
  v_column record;
  v_privilege text;
  v_follow_function regprocedure :=
    'public.mutate_user_follow_atomic(uuid,uuid,text)'::regprocedure;
  v_block_function regprocedure :=
    'public.mutate_user_block_atomic(uuid,uuid,text)'::regprocedure;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.blocked_users'::pg_catalog.regclass,
    'public.user_follows'::pg_catalog.regclass
  ]
  LOOP
    IF NOT (
      SELECT relation.relrowsecurity
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
    ) THEN
      RAISE EXCEPTION 'social edge RLS was disabled for %', v_relation;
    END IF;
    IF (
      SELECT relation.relforcerowsecurity
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
    ) THEN
      RAISE EXCEPTION 'social edge table unexpectedly forces its postgres owner: %', v_relation;
    END IF;

    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::text[]
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ]::text[]
      LOOP
        IF pg_catalog.has_table_privilege(v_role, v_relation, v_privilege) THEN
          RAISE EXCEPTION
            '% retains direct % on %', v_role, v_privilege, v_relation;
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
          'INSERT', 'UPDATE', 'REFERENCES'
        ]::text[]
        LOOP
          IF pg_catalog.has_column_privilege(
            v_role,
            v_relation,
            v_column.attname,
            v_privilege
          ) THEN
            RAISE EXCEPTION
              '% retains column % on %.%',
              v_role,
              v_privilege,
              v_relation,
              v_column.attname;
          END IF;
        END LOOP;
      END LOOP;
    END LOOP;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_relation
        AND policy.polcmd IN ('*', 'a', 'w', 'd')
    ) THEN
      RAISE EXCEPTION 'direct social edge mutation policy survived on %', v_relation;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.aclexplode(
        COALESCE(
          (SELECT relation.relacl
           FROM pg_catalog.pg_class AS relation
           WHERE relation.oid = v_relation),
          '{}'::aclitem[]
        )
      ) AS acl
      WHERE acl.grantee = 0
        AND acl.privilege_type IN (
          'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
        )
    ) THEN
      RAISE EXCEPTION 'PUBLIC retains a direct mutation grant on %', v_relation;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_function_privilege(
       'service_role', v_follow_function, 'EXECUTE'
     ) OR NOT pg_catalog.has_function_privilege(
       'service_role', v_block_function, 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'authenticated', v_follow_function, 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'authenticated', v_block_function, 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'anon', v_follow_function, 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'anon', v_block_function, 'EXECUTE'
     )
  THEN
    RAISE EXCEPTION 'atomic social edge RPC boundary drifted during contract';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
