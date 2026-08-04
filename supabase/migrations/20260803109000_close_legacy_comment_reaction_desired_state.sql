-- Migration: 20260803109000_close_legacy_comment_reaction_desired_state.sql
-- Created: 2026-08-03T11:30:00Z
-- Description: Postdeploy contract for the causal comment-reaction cutover.
--   Run only after every old application instance has drained. Retain the
--   four-argument desired-state function because the causal SECURITY DEFINER
--   composes it as postgres, but remove every non-owner EXECUTE path so a
--   delayed legacy caller cannot bypass the reservation-order fence.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_gate$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.comment-reaction-count-repair:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'legacy comment reaction desired-state closure gate is busy';
  END IF;
END
$migration_gate$;

-- The exclusive migration gate drains every reviewed 1060/1070/1080 caller.
-- Holding the complete relation lock graph until commit also prevents an
-- unreviewed legacy transaction from crossing the ACL publication boundary.
LOCK TABLE auth.users,
  public.posts,
  public.groups,
  public.comments,
  public.comment_likes,
  public.blocked_users,
  public.group_members,
  public.group_bans,
  public.user_follows,
  public.comment_reaction_count_repair_queue,
  public.comment_reaction_intent_heads,
  public.comment_reaction_intent_operations
IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_service oid := pg_catalog.to_regrole('service_role');
  v_plpgsql oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
  v_function regprocedure;
  v_expected record;
  v_source text;
  v_comment text;
  v_invalid text[];
  v_defaults text[];
  v_constraints text[];
  v_indexes text[];
  v_relation regclass;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR v_postgres IS NULL
     OR v_service IS NULL
     OR v_plpgsql IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('authenticator') IS NULL
     OR pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regclass(
       'public.comment_reaction_intent_heads'
     ) IS NULL
     OR pg_catalog.to_regclass(
       'public.comment_reaction_intent_operations'
     ) IS NULL
  THEN
    RAISE EXCEPTION
      'causal comment reaction contract foundations are unavailable';
  END IF;

  IF NOT COALESCE(
    (
      SELECT role_row.rolbypassrls AND NOT role_row.rolsuper
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_service
    ),
    false
  ) OR pg_catalog.pg_has_role(v_service, v_postgres, 'MEMBER') OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname IN ('anon', 'authenticated', 'authenticator')
      AND (role_row.rolbypassrls OR role_row.rolsuper)
  ) THEN
    RAISE EXCEPTION 'causal comment reaction role boundary drifted';
  END IF;

  -- Exact columns, including order, type and nullability. The exact counts
  -- reject both unknown live columns and partially dropped/recreated shapes.
  SELECT pg_catalog.array_agg(
    required.table_name || '.' || required.column_name
    ORDER BY required.table_name, required.ordinal
  )
  INTO v_invalid
  FROM (
    VALUES
      ('comment_reaction_intent_heads', 1, 'actor_id', 'uuid'::pg_catalog.regtype, true),
      ('comment_reaction_intent_heads', 2, 'comment_id', 'uuid'::pg_catalog.regtype, true),
      ('comment_reaction_intent_heads', 3, 'latest_issued_sequence', 'bigint'::pg_catalog.regtype, true),
      ('comment_reaction_intent_heads', 4, 'latest_applied_sequence', 'bigint'::pg_catalog.regtype, true),
      ('comment_reaction_intent_heads', 5, 'updated_at', 'timestamptz'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 1, 'actor_id', 'uuid'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 2, 'request_id', 'text'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 3, 'comment_id', 'uuid'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 4, 'post_id', 'uuid'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 5, 'intent_sequence', 'bigint'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 6, 'desired_reaction', 'text'::pg_catalog.regtype, false),
      ('comment_reaction_intent_operations', 7, 'intent_fingerprint', 'text'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 8, 'state', 'text'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 9, 'result', 'jsonb'::pg_catalog.regtype, false),
      ('comment_reaction_intent_operations', 10, 'issued_at', 'timestamptz'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 11, 'expires_at', 'timestamptz'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 12, 'retain_until', 'timestamptz'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 13, 'completed_at', 'timestamptz'::pg_catalog.regtype, false)
  ) AS required(table_name, ordinal, column_name, type_oid, not_null)
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = pg_catalog.to_regclass(
      'public.' || required.table_name
    )
   AND attribute.attnum = required.ordinal
   AND attribute.attname = required.column_name
   AND NOT attribute.attisdropped
  WHERE attribute.attname IS NULL
     OR attribute.atttypid <> required.type_oid
     OR attribute.attnotnull IS DISTINCT FROM required.not_null;

  IF v_invalid IS NOT NULL
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid =
         'public.comment_reaction_intent_heads'::pg_catalog.regclass
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
     ) <> 5
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid =
         'public.comment_reaction_intent_operations'::pg_catalog.regclass
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
     ) <> 13
  THEN
    RAISE EXCEPTION
      'causal comment reaction table columns drifted: %', v_invalid;
  END IF;

  SELECT pg_catalog.array_agg(
    relation.relname || '.' || attribute.attname || '=' ||
      pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
    ORDER BY relation.relname, attribute.attname
  )
  INTO v_defaults
  FROM pg_catalog.pg_attrdef AS default_row
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = default_row.adrelid
   AND attribute.attnum = default_row.adnum
  JOIN pg_catalog.pg_class AS relation
    ON relation.oid = default_row.adrelid
  WHERE default_row.adrelid IN (
    'public.comment_reaction_intent_heads'::pg_catalog.regclass,
    'public.comment_reaction_intent_operations'::pg_catalog.regclass
  );
  IF v_defaults IS DISTINCT FROM ARRAY[
    'comment_reaction_intent_heads.latest_applied_sequence=0',
    'comment_reaction_intent_heads.latest_issued_sequence=0',
    'comment_reaction_intent_heads.updated_at=statement_timestamp()',
    'comment_reaction_intent_operations.issued_at=statement_timestamp()',
    'comment_reaction_intent_operations.state=''issued''::text'
  ]::text[] THEN
    RAISE EXCEPTION 'causal comment reaction table defaults drifted';
  END IF;

  SELECT pg_catalog.array_agg(
    constraint_row.conname ORDER BY constraint_row.conname
  )
  INTO STRICT v_constraints
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid =
    'public.comment_reaction_intent_heads'::pg_catalog.regclass;
  IF v_constraints IS DISTINCT FROM ARRAY[
    'comment_reaction_intent_heads_actor_fkey',
    'comment_reaction_intent_heads_comment_fkey',
    'comment_reaction_intent_heads_pkey',
    'comment_reaction_intent_heads_sequence_check'
  ]::text[] OR (
    SELECT pg_catalog.md5(pg_catalog.string_agg(
      constraint_row.conname || ':' ||
        pg_catalog.pg_get_constraintdef(constraint_row.oid, false),
      E'\n' ORDER BY constraint_row.conname
    ))
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.comment_reaction_intent_heads'::pg_catalog.regclass
  ) IS DISTINCT FROM '7c5eaa3f9fc4a9a682ce5ede3fd1a6ca' THEN
    RAISE EXCEPTION 'causal comment reaction head constraints drifted';
  END IF;

  SELECT pg_catalog.array_agg(
    constraint_row.conname ORDER BY constraint_row.conname
  )
  INTO STRICT v_constraints
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid =
    'public.comment_reaction_intent_operations'::pg_catalog.regclass;
  IF v_constraints IS DISTINCT FROM ARRAY[
    'comment_reaction_intent_operations_desired_check',
    'comment_reaction_intent_operations_fingerprint_check',
    'comment_reaction_intent_operations_head_fkey',
    'comment_reaction_intent_operations_pkey',
    'comment_reaction_intent_operations_request_check',
    'comment_reaction_intent_operations_result_check',
    'comment_reaction_intent_operations_sequence_check',
    'comment_reaction_intent_operations_sequence_key',
    'comment_reaction_intent_operations_state_check',
    'comment_reaction_intent_operations_time_check'
  ]::text[] OR (
    SELECT pg_catalog.md5(pg_catalog.string_agg(
      constraint_row.conname || ':' ||
        pg_catalog.pg_get_constraintdef(constraint_row.oid, false),
      E'\n' ORDER BY constraint_row.conname
    ))
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.comment_reaction_intent_operations'::pg_catalog.regclass
  ) IS DISTINCT FROM '7c85c4c638d898935eec524084a73b6e' THEN
    RAISE EXCEPTION 'causal comment reaction operation constraints drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (
      'public.comment_reaction_intent_heads'::pg_catalog.regclass,
      'public.comment_reaction_intent_operations'::pg_catalog.regclass
    )
      AND NOT constraint_row.convalidated
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conname =
      'comment_reaction_intent_heads_actor_fkey'
      AND constraint_row.conrelid =
        'public.comment_reaction_intent_heads'::pg_catalog.regclass
      AND constraint_row.confrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_row.confdeltype = 'c'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conname =
      'comment_reaction_intent_heads_comment_fkey'
      AND constraint_row.conrelid =
        'public.comment_reaction_intent_heads'::pg_catalog.regclass
      AND constraint_row.confrelid = 'public.comments'::pg_catalog.regclass
      AND constraint_row.confdeltype = 'c'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conname =
      'comment_reaction_intent_operations_head_fkey'
      AND constraint_row.conrelid =
        'public.comment_reaction_intent_operations'::pg_catalog.regclass
      AND constraint_row.confrelid =
        'public.comment_reaction_intent_heads'::pg_catalog.regclass
      AND constraint_row.confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'causal comment reaction foreign-key boundary drifted';
  END IF;

  SELECT pg_catalog.array_agg(index_row.relname ORDER BY index_row.relname)
  INTO STRICT v_indexes
  FROM pg_catalog.pg_index AS index_metadata
  JOIN pg_catalog.pg_class AS index_row
    ON index_row.oid = index_metadata.indexrelid
  WHERE index_metadata.indrelid =
    'public.comment_reaction_intent_heads'::pg_catalog.regclass
    AND index_metadata.indisvalid
    AND index_metadata.indisready;
  IF v_indexes IS DISTINCT FROM ARRAY[
    'comment_reaction_intent_heads_cleanup_idx',
    'comment_reaction_intent_heads_pkey'
  ]::text[] OR (
    SELECT pg_catalog.md5(pg_catalog.string_agg(
      index_row.relname || ':' ||
        pg_catalog.pg_get_indexdef(index_metadata.indexrelid, 0, false),
      E'\n' ORDER BY index_row.relname
    ))
    FROM pg_catalog.pg_index AS index_metadata
    JOIN pg_catalog.pg_class AS index_row
      ON index_row.oid = index_metadata.indexrelid
    WHERE index_metadata.indrelid =
      'public.comment_reaction_intent_heads'::pg_catalog.regclass
  ) IS DISTINCT FROM '6db551c8f0e870195efb3e5341e0050a' THEN
    RAISE EXCEPTION 'causal comment reaction head indexes drifted';
  END IF;

  SELECT pg_catalog.array_agg(index_row.relname ORDER BY index_row.relname)
  INTO STRICT v_indexes
  FROM pg_catalog.pg_index AS index_metadata
  JOIN pg_catalog.pg_class AS index_row
    ON index_row.oid = index_metadata.indexrelid
  WHERE index_metadata.indrelid =
    'public.comment_reaction_intent_operations'::pg_catalog.regclass
    AND index_metadata.indisvalid
    AND index_metadata.indisready;
  IF v_indexes IS DISTINCT FROM ARRAY[
    'comment_reaction_intent_operations_pkey',
    'comment_reaction_intent_operations_retention_idx',
    'comment_reaction_intent_operations_sequence_key'
  ]::text[] OR (
    SELECT pg_catalog.md5(pg_catalog.string_agg(
      index_row.relname || ':' ||
        pg_catalog.pg_get_indexdef(index_metadata.indexrelid, 0, false),
      E'\n' ORDER BY index_row.relname
    ))
    FROM pg_catalog.pg_index AS index_metadata
    JOIN pg_catalog.pg_class AS index_row
      ON index_row.oid = index_metadata.indexrelid
    WHERE index_metadata.indrelid =
      'public.comment_reaction_intent_operations'::pg_catalog.regclass
  ) IS DISTINCT FROM '1a0886f337f4c19cdd9b46c42a130b2b' THEN
    RAISE EXCEPTION 'causal comment reaction operation indexes drifted';
  END IF;

  FOREACH v_relation IN ARRAY ARRAY[
    'public.comment_reaction_intent_heads'::pg_catalog.regclass,
    'public.comment_reaction_intent_operations'::pg_catalog.regclass
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND NOT relation.relispartition
        AND relation.relowner = v_postgres
        AND relation.relrowsecurity
        AND relation.relforcerowsecurity
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy_row
      WHERE policy_row.polrelid = v_relation
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_relation
        AND NOT trigger_row.tgisinternal
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid = v_relation
         OR inheritance.inhparent = v_relation
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      WHERE relation.oid = v_relation
        AND acl_entry.grantee <> relation.relowner
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = attribute.attrelid
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee <> relation.relowner
    ) THEN
      RAISE EXCEPTION
        'causal comment reaction private table boundary drifted: %',
        v_relation;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'set_comment_reaction_desired_state_atomic',
        'reserve_comment_reaction_intent_atomic',
        'set_comment_reaction_desired_state_causal_atomic',
        'cleanup_comment_reaction_intents_atomic'
      )
  ) <> 4 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'set_comment_reaction_desired_state_atomic',
        'reserve_comment_reaction_intent_atomic',
        'set_comment_reaction_desired_state_causal_atomic',
        'cleanup_comment_reaction_intents_atomic'
      )
      AND function_row.oid NOT IN (
        pg_catalog.to_regprocedure(
          'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)'
        )::oid,
        pg_catalog.to_regprocedure(
          'public.reserve_comment_reaction_intent_atomic(uuid,uuid,uuid,text,text)'
        )::oid,
        pg_catalog.to_regprocedure(
          'public.set_comment_reaction_desired_state_causal_atomic(uuid,uuid,uuid,text,bigint,text)'
        )::oid,
        pg_catalog.to_regprocedure(
          'public.cleanup_comment_reaction_intents_atomic(integer)'
        )::oid
      )
  ) THEN
    RAISE EXCEPTION
      'comment reaction desired-state function surface is not the reviewed closed set';
  END IF;

  FOR v_expected IN
    SELECT *
    FROM (
      VALUES
        (
          'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)',
          ARRAY['p_actor_id', 'p_post_id', 'p_comment_id', 'p_desired_reaction']::text[],
          0,
          'comment-reaction-desired-state:v1:',
          '2c40ab0522cd0afceb7bbc6a44e29a09',
          false
        ),
        (
          'public.reserve_comment_reaction_intent_atomic(uuid,uuid,uuid,text,text)',
          ARRAY['p_actor_id', 'p_post_id', 'p_comment_id', 'p_request_id', 'p_desired_reaction']::text[],
          0,
          'comment-reaction-causal-intent:reserve-v1:',
          '2fdaa03887397d4e3c0222d771328c1b',
          true
        ),
        (
          'public.set_comment_reaction_desired_state_causal_atomic(uuid,uuid,uuid,text,bigint,text)',
          ARRAY['p_actor_id', 'p_post_id', 'p_comment_id', 'p_request_id', 'p_intent_sequence', 'p_desired_reaction']::text[],
          0,
          'comment-reaction-causal-intent:apply-v1:',
          'bd71579634a5312dd8af6093235b2bf8',
          true
        ),
        (
          'public.cleanup_comment_reaction_intents_atomic(integer)',
          ARRAY['p_limit']::text[],
          1,
          'comment-reaction-causal-intent:cleanup-v1:',
          'c9d0d109b295740e1f6b47d45e523c6b',
          true
        )
    ) AS expected(
      signature,
      argument_names,
      argument_defaults,
      source_prefix,
      source_digest,
      require_service_execute
    )
  LOOP
    v_function := pg_catalog.to_regprocedure(v_expected.signature);
    IF v_function IS NULL OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_function
        AND function_row.prokind = 'f'
        AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
        AND NOT function_row.proretset
        AND function_row.proowner = v_postgres
        AND function_row.prosecdef
        AND function_row.provolatile = 'v'
        AND function_row.prolang = v_plpgsql
        AND NOT function_row.proisstrict
        AND function_row.proparallel = 'u'
        AND NOT function_row.proleakproof
        AND function_row.pronargs =
          pg_catalog.cardinality(v_expected.argument_names)
        AND function_row.pronargdefaults = v_expected.argument_defaults
        AND function_row.proargnames = v_expected.argument_names
        AND pg_catalog.cardinality(function_row.proconfig) = 4
        AND function_row.proconfig @> ARRAY[
          'search_path=pg_catalog, pg_temp',
          'row_security=off',
          'lock_timeout=5s',
          'statement_timeout=15s'
        ]::text[]
    ) THEN
      RAISE EXCEPTION
        'comment reaction function metadata drifted: %',
        v_expected.signature;
    END IF;

    SELECT function_row.prosrc,
           pg_catalog.obj_description(function_row.oid, 'pg_proc')
    INTO STRICT v_source, v_comment
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function;
    IF pg_catalog.md5(v_source) IS DISTINCT FROM v_expected.source_digest
       OR v_comment IS DISTINCT FROM
         v_expected.source_prefix || v_expected.source_digest
    THEN
      RAISE EXCEPTION
        'comment reaction function source seal drifted: %',
        v_expected.signature;
    END IF;

    IF v_expected.require_service_execute AND (
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS function_row
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            function_row.proacl,
            pg_catalog.acldefault('f', function_row.proowner)
          )
        ) AS acl_entry
        WHERE function_row.oid = v_function
          AND acl_entry.grantee = v_service
          AND acl_entry.privilege_type = 'EXECUTE'
          AND NOT acl_entry.is_grantable
      ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS function_row
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            function_row.proacl,
            pg_catalog.acldefault('f', function_row.proowner)
          )
        ) AS acl_entry
        WHERE function_row.oid = v_function
          AND (
            acl_entry.privilege_type <> 'EXECUTE'
            OR acl_entry.grantee NOT IN (function_row.proowner, v_service)
            OR (
              acl_entry.grantee = v_service
              AND acl_entry.is_grantable
            )
          )
      )
    ) THEN
      RAISE EXCEPTION
        'causal comment reaction function ACL drifted: %',
        v_expected.signature;
    END IF;

    IF v_expected.signature =
         'public.set_comment_reaction_desired_state_causal_atomic(uuid,uuid,uuid,text,bigint,text)'
       AND pg_catalog.strpos(
         v_source,
         'public.set_comment_reaction_desired_state_atomic('
       ) = 0
    THEN
      RAISE EXCEPTION
        'causal comment reaction apply no longer composes the sealed owner function';
    END IF;
  END LOOP;
END
$preflight$;

DO $close_legacy_execute$
DECLARE
  v_function regprocedure :=
    'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)'::pg_catalog.regprocedure;
  v_owner oid;
  v_grantee record;
  v_grantee_sql text;
BEGIN
  SELECT function_row.proowner
  INTO STRICT v_owner
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

  -- Discover the complete current ACL instead of assuming the standard roles.
  -- REVOKE CASCADE also removes privileges delegated through grant options.
  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee, role_row.rolname
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = acl_entry.grantee
    WHERE function_row.oid = v_function
      AND acl_entry.grantee <> v_owner
  LOOP
    IF v_grantee.grantee <> 0 AND v_grantee.rolname IS NULL THEN
      RAISE EXCEPTION
        'legacy comment reaction ACL references missing role oid %',
        v_grantee.grantee;
    END IF;
    v_grantee_sql := CASE
      WHEN v_grantee.grantee = 0 THEN 'PUBLIC'
      ELSE pg_catalog.quote_ident(v_grantee.rolname)
    END;
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s CASCADE',
      v_function,
      v_grantee_sql
    );
  END LOOP;
END
$close_legacy_execute$;

DO $postflight$
DECLARE
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_service oid := pg_catalog.to_regrole('service_role');
  v_plpgsql oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
  v_base regprocedure :=
    'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)'::pg_catalog.regprocedure;
  v_function regprocedure;
  v_expected record;
  v_source text;
  v_comment text;
  v_relation regclass;
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'set_comment_reaction_desired_state_atomic',
        'reserve_comment_reaction_intent_atomic',
        'set_comment_reaction_desired_state_causal_atomic',
        'cleanup_comment_reaction_intents_atomic'
      )
  ) <> 4 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'set_comment_reaction_desired_state_atomic',
        'reserve_comment_reaction_intent_atomic',
        'set_comment_reaction_desired_state_causal_atomic',
        'cleanup_comment_reaction_intents_atomic'
      )
      AND function_row.oid NOT IN (
        v_base::oid,
        'public.reserve_comment_reaction_intent_atomic(uuid,uuid,uuid,text,text)'::pg_catalog.regprocedure::oid,
        'public.set_comment_reaction_desired_state_causal_atomic(uuid,uuid,uuid,text,bigint,text)'::pg_catalog.regprocedure::oid,
        'public.cleanup_comment_reaction_intents_atomic(integer)'::pg_catalog.regprocedure::oid
      )
  ) THEN
    RAISE EXCEPTION
      'comment reaction function surface changed during contract publication';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_base
    AND function_row.proowner = v_postgres
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
    AND NOT function_row.proretset
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prolang = v_plpgsql
    AND NOT function_row.proisstrict
    AND function_row.proparallel = 'u'
    AND NOT function_row.proleakproof
    AND function_row.pronargs = 4
    AND function_row.pronargdefaults = 0
    AND function_row.proargnames = ARRAY[
      'p_actor_id',
      'p_post_id',
      'p_comment_id',
      'p_desired_reaction'
    ]::text[]
    AND pg_catalog.cardinality(function_row.proconfig) = 4
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off',
      'lock_timeout=5s',
      'statement_timeout=15s'
    ]::text[];
  IF pg_catalog.md5(v_source) IS DISTINCT FROM
       '2c40ab0522cd0afceb7bbc6a44e29a09'
     OR v_comment IS DISTINCT FROM
       'comment-reaction-desired-state:v1:2c40ab0522cd0afceb7bbc6a44e29a09'
     OR NOT pg_catalog.has_function_privilege(
       v_postgres,
       v_base,
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(v_service, v_base, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_base, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated',
       v_base,
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticator',
       v_base,
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS acl_entry
       WHERE function_row.oid = v_base
         AND acl_entry.grantee <> function_row.proowner
     )
  THEN
    RAISE EXCEPTION
      'legacy comment reaction desired-state authority is not owner-only';
  END IF;

  FOR v_expected IN
    SELECT *
    FROM (
      VALUES
        (
          'public.reserve_comment_reaction_intent_atomic(uuid,uuid,uuid,text,text)',
          ARRAY['p_actor_id', 'p_post_id', 'p_comment_id', 'p_request_id', 'p_desired_reaction']::text[],
          0,
          'comment-reaction-causal-intent:reserve-v1:',
          '2fdaa03887397d4e3c0222d771328c1b'
        ),
        (
          'public.set_comment_reaction_desired_state_causal_atomic(uuid,uuid,uuid,text,bigint,text)',
          ARRAY['p_actor_id', 'p_post_id', 'p_comment_id', 'p_request_id', 'p_intent_sequence', 'p_desired_reaction']::text[],
          0,
          'comment-reaction-causal-intent:apply-v1:',
          'bd71579634a5312dd8af6093235b2bf8'
        ),
        (
          'public.cleanup_comment_reaction_intents_atomic(integer)',
          ARRAY['p_limit']::text[],
          1,
          'comment-reaction-causal-intent:cleanup-v1:',
          'c9d0d109b295740e1f6b47d45e523c6b'
        )
    ) AS expected(
      signature,
      argument_names,
      argument_defaults,
      source_prefix,
      source_digest
    )
  LOOP
    v_function := pg_catalog.to_regprocedure(v_expected.signature);
    SELECT function_row.prosrc,
           pg_catalog.obj_description(function_row.oid, 'pg_proc')
    INTO STRICT v_source, v_comment
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.proowner = v_postgres
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND NOT function_row.proretset
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prolang = v_plpgsql
      AND NOT function_row.proisstrict
      AND function_row.proparallel = 'u'
      AND NOT function_row.proleakproof
      AND function_row.pronargs =
        pg_catalog.cardinality(v_expected.argument_names)
      AND function_row.pronargdefaults = v_expected.argument_defaults
      AND function_row.proargnames = v_expected.argument_names
      AND pg_catalog.cardinality(function_row.proconfig) = 4
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'row_security=off',
        'lock_timeout=5s',
        'statement_timeout=15s'
      ]::text[];
    IF pg_catalog.md5(v_source) IS DISTINCT FROM v_expected.source_digest
       OR v_comment IS DISTINCT FROM
         v_expected.source_prefix || v_expected.source_digest
       OR NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             function_row.proacl,
             pg_catalog.acldefault('f', function_row.proowner)
           )
         ) AS acl_entry
         WHERE function_row.oid = v_function
           AND acl_entry.grantee = v_service
           AND acl_entry.privilege_type = 'EXECUTE'
           AND NOT acl_entry.is_grantable
       ) OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             function_row.proacl,
             pg_catalog.acldefault('f', function_row.proowner)
           )
         ) AS acl_entry
         WHERE function_row.oid = v_function
           AND (
             acl_entry.privilege_type <> 'EXECUTE'
             OR acl_entry.grantee NOT IN (function_row.proowner, v_service)
             OR (
               acl_entry.grantee = v_service
               AND acl_entry.is_grantable
             )
           )
       )
    THEN
      RAISE EXCEPTION
        'causal comment reaction authority changed during contract publication: %',
        v_expected.signature;
    END IF;

    IF v_expected.signature =
         'public.set_comment_reaction_desired_state_causal_atomic(uuid,uuid,uuid,text,bigint,text)'
       AND pg_catalog.strpos(
         v_source,
         'public.set_comment_reaction_desired_state_atomic('
       ) = 0
    THEN
      RAISE EXCEPTION
        'causal comment reaction composition changed during contract publication';
    END IF;
  END LOOP;

  FOREACH v_relation IN ARRAY ARRAY[
    'public.comment_reaction_intent_heads'::pg_catalog.regclass,
    'public.comment_reaction_intent_operations'::pg_catalog.regclass
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
        AND relation.relowner = v_postgres
        AND relation.relrowsecurity
        AND relation.relforcerowsecurity
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      WHERE relation.oid = v_relation
        AND acl_entry.grantee <> relation.relowner
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = attribute.attrelid
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee <> relation.relowner
    ) THEN
      RAISE EXCEPTION
        'causal comment reaction private table boundary changed during publication: %',
        v_relation;
    END IF;
  END LOOP;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
