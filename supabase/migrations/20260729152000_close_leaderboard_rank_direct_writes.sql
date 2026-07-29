-- Postdeploy cutover: the deployed leaderboard publisher now stages and
-- finalizes one generation through owner-executed SECURITY DEFINER RPCs.
-- Remove every application-role path to mutate the live rank table while
-- retaining the public/service read surface and the complete publisher RPC
-- chain.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'close-leaderboard-rank-direct-writes@1',
    0
  )
);

CREATE TEMP TABLE leaderboard_rank_publisher_authority_before
ON COMMIT DROP
AS
SELECT
  authority.ordinality,
  authority.signature,
  pg_catalog.to_regprocedure(authority.signature)::oid AS function_oid
FROM pg_catalog.unnest(ARRAY[
  'public.prepare_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)',
  'public.plan_leaderboard_rank_generation_batch_v1(text,uuid,timestamptz,jsonb)',
  'public.plan_leaderboard_rank_generation_write_set_v1(text,uuid,text,timestamptz,integer,text[])',
  'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)',
  'public.stage_leaderboard_rank_generation_batch_v1(text,bigint,uuid,integer,uuid,text,text[],jsonb)',
  'public.finalize_leaderboard_rank_generation_v1(text,bigint,uuid,uuid,text,jsonb)'
]::text[]) WITH ORDINALITY AS authority(signature, ordinality);

DO $preflight$
DECLARE
  v_postgres oid := pg_catalog.to_regrole('postgres');
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR v_postgres IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_ranks') IS NULL THEN
    RAISE EXCEPTION
      'leaderboard rank direct-write closure dependencies are unavailable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.leaderboard_ranks'::pg_catalog.regclass
      AND relation.relkind = 'p'
      AND relation.relowner = v_postgres
  ) THEN
    RAISE EXCEPTION
      'leaderboard_ranks must remain a postgres-owned partitioned table';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM leaderboard_rank_publisher_authority_before AS authority
    LEFT JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = authority.function_oid
    LEFT JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid IS NULL
       OR function_row.proowner IS DISTINCT FROM v_postgres
       OR function_row.prokind IS DISTINCT FROM 'f'
       OR language_row.lanname IS DISTINCT FROM 'plpgsql'
       OR NOT function_row.prosecdef
       OR function_row.proleakproof
       OR function_row.proisstrict
       OR function_row.proretset
       OR function_row.prorettype IS DISTINCT FROM
            'pg_catalog.jsonb'::pg_catalog.regtype
  ) THEN
    RAISE EXCEPTION
      'leaderboard publisher RPC owner/security contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM leaderboard_rank_publisher_authority_before AS authority
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = authority.function_oid
    WHERE authority.signature IN (
      'public.stage_leaderboard_rank_generation_batch_v1(text,bigint,uuid,integer,uuid,text,text[],jsonb)',
      'public.finalize_leaderboard_rank_generation_v1(text,bigint,uuid,uuid,text,jsonb)'
    )
      AND (
        function_row.provolatile IS DISTINCT FROM 'v'
        OR function_row.proparallel IS DISTINCT FROM 'u'
        OR function_row.proconfig IS NULL
        OR pg_catalog.cardinality(function_row.proconfig) <> 3
        OR NOT function_row.proconfig @> ARRAY[
          'search_path=pg_catalog, pg_temp',
          'TimeZone=UTC',
          'lock_timeout=10s'
        ]::text[]
      )
  ) THEN
    RAISE EXCEPTION
      'leaderboard stage/finalizer execution contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM leaderboard_rank_publisher_authority_before AS authority
    WHERE NOT pg_catalog.has_function_privilege(
            'service_role',
            authority.function_oid,
            'EXECUTE'
          )
       OR pg_catalog.has_function_privilege(
            'anon',
            authority.function_oid,
            'EXECUTE'
          )
       OR pg_catalog.has_function_privilege(
            'authenticated',
            authority.function_oid,
            'EXECUTE'
          )
  ) THEN
    RAISE EXCEPTION
      'leaderboard publisher RPC EXECUTE boundary drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM leaderboard_rank_publisher_authority_before AS authority
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = authority.function_oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS expanded
    WHERE expanded.privilege_type = 'EXECUTE'
      AND expanded.grantee <> function_row.proowner
      AND expanded.grantee <> 'service_role'::pg_catalog.regrole
  ) THEN
    RAISE EXCEPTION
      'leaderboard publisher RPC EXECUTE ACL is not a closed set';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM leaderboard_rank_publisher_authority_before AS authority
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = authority.function_oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS expanded
    WHERE expanded.grantee = 'service_role'::pg_catalog.regrole
      AND expanded.privilege_type = 'EXECUTE'
      AND expanded.is_grantable
  ) THEN
    RAISE EXCEPTION
      'service_role must not delegate leaderboard publisher execution';
  END IF;
END
$preflight$;

-- LOCK without ONLY recursively locks every current partition. This closes the
-- race with both parent-targeted DML and a legacy client naming a child table.
LOCK TABLE public.leaderboard_ranks IN ACCESS EXCLUSIVE MODE;

-- The parent ACL is a closed set for service_role: SELECT only, without grant
-- option. Public readers keep their existing SELECT grants and RLS policy.
REVOKE ALL PRIVILEGES
  ON TABLE public.leaderboard_ranks
  FROM service_role CASCADE;
GRANT SELECT
  ON TABLE public.leaderboard_ranks
  TO service_role;

DO $close_rank_dml$
DECLARE
  v_relation regclass;
  v_columns text;
  v_privilege text;
BEGIN
  FOR v_relation IN
    SELECT partition.relid::regclass
    FROM pg_catalog.pg_partition_tree(
      'public.leaderboard_ranks'::pg_catalog.regclass
    ) AS partition
    ORDER BY partition.level, partition.relid
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE %s FROM PUBLIC, anon, authenticated, service_role CASCADE',
      v_relation
    );

    -- A table-level REVOKE does not remove historical column-level grants.
    -- Close every column-capable mutation privilege on parent and partitions.
    SELECT pg_catalog.string_agg(
      pg_catalog.format('%I', attribute.attname),
      ', '
      ORDER BY attribute.attnum
    )
    INTO STRICT v_columns
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    FOREACH v_privilege IN ARRAY ARRAY[
      'INSERT',
      'UPDATE',
      'REFERENCES'
    ]::text[]
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE %s (%s) ON TABLE %s FROM PUBLIC, anon, authenticated, service_role CASCADE',
        v_privilege,
        v_columns,
        v_relation
      );
    END LOOP;
  END LOOP;
END
$close_rank_dml$;

DO $postflight$
DECLARE
  v_authority record;
  v_relation regclass;
  v_role name;
  v_privilege text;
BEGIN
  IF NOT pg_catalog.has_table_privilege(
       'service_role',
       'public.leaderboard_ranks',
       'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'anon',
       'public.leaderboard_ranks',
       'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'authenticated',
       'public.leaderboard_ranks',
       'SELECT'
     ) THEN
    RAISE EXCEPTION 'leaderboard rank read surface drifted';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'service_role'::name,
    'anon'::name,
    'authenticated'::name
  ]
  LOOP
    FOR v_relation IN
      SELECT partition.relid::regclass
      FROM pg_catalog.pg_partition_tree(
        'public.leaderboard_ranks'::pg_catalog.regclass
      ) AS partition
      ORDER BY partition.level, partition.relid
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
        'MAINTAIN'
      ]::text[]
      LOOP
        IF pg_catalog.has_table_privilege(
             v_role,
             v_relation,
             v_privilege
           ) THEN
          RAISE EXCEPTION
            'leaderboard rank % remains open to % on %',
            v_privilege,
            v_role,
            v_relation;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS expanded
    WHERE relation.oid =
          'public.leaderboard_ranks'::pg_catalog.regclass
      AND expanded.grantee = 'service_role'::pg_catalog.regrole
      AND (
        expanded.privilege_type <> 'SELECT'
        OR expanded.is_grantable
      )
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS expanded
    WHERE relation.oid =
          'public.leaderboard_ranks'::pg_catalog.regclass
      AND expanded.grantee = 'service_role'::pg_catalog.regrole
      AND expanded.privilege_type = 'SELECT'
      AND NOT expanded.is_grantable
  ) THEN
    RAISE EXCEPTION
      'service_role leaderboard_ranks ACL is not SELECT-only';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_partition_tree(
      'public.leaderboard_ranks'::pg_catalog.regclass
    ) AS partition
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = partition.relid
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS expanded
    WHERE attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND expanded.grantee IN (
        0,
        'service_role'::pg_catalog.regrole,
        'anon'::pg_catalog.regrole,
        'authenticated'::pg_catalog.regrole
      )
      AND expanded.privilege_type IN ('INSERT', 'UPDATE', 'REFERENCES')
  ) THEN
    RAISE EXCEPTION
      'leaderboard rank column-level mutation ACL survived cutover';
  END IF;

  FOR v_authority IN
    SELECT
      before.signature,
      before.function_oid,
      function_row.oid AS after_oid,
      function_row.proowner,
      function_row.prosecdef
    FROM leaderboard_rank_publisher_authority_before AS before
    LEFT JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = pg_catalog.to_regprocedure(before.signature)
    ORDER BY before.ordinality
  LOOP
    IF v_authority.after_oid IS NULL
       OR v_authority.after_oid IS DISTINCT FROM v_authority.function_oid
       OR v_authority.proowner IS DISTINCT FROM
            'postgres'::pg_catalog.regrole
       OR NOT v_authority.prosecdef
       OR NOT pg_catalog.has_function_privilege(
            'service_role',
            v_authority.after_oid,
            'EXECUTE'
          )
       OR pg_catalog.has_function_privilege(
            'anon',
            v_authority.after_oid,
            'EXECUTE'
          )
       OR pg_catalog.has_function_privilege(
            'authenticated',
            v_authority.after_oid,
            'EXECUTE'
          ) THEN
      RAISE EXCEPTION
        'leaderboard publisher RPC postflight failed: %',
        v_authority.signature;
    END IF;
  END LOOP;
END
$postflight$;

COMMENT ON TABLE public.leaderboard_ranks IS
  'Public leaderboard read model. Live rows are mutable only inside the postgres-owned atomic generation finalizer; application roles have SELECT only.';

NOTIFY pgrst, 'reload schema';

COMMIT;
