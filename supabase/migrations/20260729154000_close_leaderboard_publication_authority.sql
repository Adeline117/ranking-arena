-- Postdeploy publication cutover: live ranks, cleanup, rerank, and seal now
-- commit only inside finalize_leaderboard_rank_generation_v1. Remove the
-- rolling-deploy freshness table writes and standalone seal RPC while keeping
-- the public freshness read surface and service-only proof reader intact.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'close-leaderboard-publication-authority@1',
    0
  )
);

CREATE TEMP TABLE leaderboard_publication_authority_before (
  ordinality integer PRIMARY KEY,
  signature text NOT NULL UNIQUE,
  classification text NOT NULL CHECK (
    classification IN ('internal_seal', 'canonical_finalizer', 'proof_reader')
  ),
  function_oid oid
) ON COMMIT DROP;

INSERT INTO leaderboard_publication_authority_before (
  ordinality,
  signature,
  classification,
  function_oid
) VALUES
  (
    1,
    'public.seal_leaderboard_rank_publication(text,uuid,jsonb)',
    'internal_seal',
    pg_catalog.to_regprocedure(
      'public.seal_leaderboard_rank_publication(text,uuid,jsonb)'
    )
  ),
  (
    2,
    'public.finalize_leaderboard_rank_generation_v1(text,bigint,uuid,uuid,text,jsonb)',
    'canonical_finalizer',
    pg_catalog.to_regprocedure(
      'public.finalize_leaderboard_rank_generation_v1(text,bigint,uuid,uuid,text,jsonb)'
    )
  ),
  (
    3,
    'public.arena_leaderboard_publication_proofs(text,text[])',
    'proof_reader',
    pg_catalog.to_regprocedure(
      'public.arena_leaderboard_publication_proofs(text,text[])'
    )
  );

CREATE TEMP TABLE leaderboard_publication_private_tables (
  ordinality integer PRIMARY KEY,
  signature text NOT NULL UNIQUE,
  relation_oid oid
) ON COMMIT DROP;

INSERT INTO leaderboard_publication_private_tables (
  ordinality,
  signature,
  relation_oid
) VALUES
  (
    1,
    'arena.leaderboard_rank_mutation_fences',
    pg_catalog.to_regclass('arena.leaderboard_rank_mutation_fences')
  ),
  (
    2,
    'arena.leaderboard_rank_publications',
    pg_catalog.to_regclass('arena.leaderboard_rank_publications')
  ),
  (
    3,
    'arena.leaderboard_rank_cleanup_receipts',
    pg_catalog.to_regclass('arena.leaderboard_rank_cleanup_receipts')
  );

DO $preflight$
DECLARE
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_seal oid := pg_catalog.to_regprocedure(
    'public.seal_leaderboard_rank_publication(text,uuid,jsonb)'
  );
  v_finalizer oid := pg_catalog.to_regprocedure(
    'public.finalize_leaderboard_rank_generation_v1(text,bigint,uuid,uuid,text,jsonb)'
  );
  v_proof_reader oid := pg_catalog.to_regprocedure(
    'public.arena_leaderboard_publication_proofs(text,text[])'
  );
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR v_postgres IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regclass(
       'public.leaderboard_source_freshness'
     ) IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_ranks') IS NULL
     OR EXISTS (
       SELECT 1
       FROM leaderboard_publication_authority_before AS authority
       WHERE authority.function_oid IS NULL
     )
     OR EXISTS (
       SELECT 1
       FROM leaderboard_publication_private_tables AS relation
       WHERE relation.relation_oid IS NULL
     ) THEN
    RAISE EXCEPTION
      'leaderboard publication authority dependencies are unavailable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid =
          'public.leaderboard_source_freshness'::pg_catalog.regclass
      AND relation.relkind = 'r'
      AND relation.relowner = v_postgres
      AND relation.relrowsecurity
  ) THEN
    RAISE EXCEPTION
      'leaderboard_source_freshness owner/RLS contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM leaderboard_publication_authority_before AS authority
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = authority.function_oid
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.proowner IS DISTINCT FROM v_postgres
       OR function_row.prokind IS DISTINCT FROM 'f'
       OR language_row.lanname IS DISTINCT FROM 'plpgsql'
       OR NOT function_row.prosecdef
  ) THEN
    RAISE EXCEPTION
      'leaderboard publication function owner/security metadata drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_seal
      AND function_row.provolatile = 'v'
      AND NOT function_row.proretset
      AND function_row.prorettype =
          'pg_catalog.jsonb'::pg_catalog.regtype
      AND function_row.proconfig IS NOT NULL
      AND pg_catalog.cardinality(function_row.proconfig) = 2
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=10s'
      ]::text[]
  ) THEN
    RAISE EXCEPTION 'leaderboard seal execution contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_finalizer
      AND function_row.provolatile = 'v'
      AND NOT function_row.proretset
      AND function_row.prorettype =
          'pg_catalog.jsonb'::pg_catalog.regtype
      AND function_row.prosrc ~
          'public[.]seal_leaderboard_rank_publication[[:space:]]*[(]'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_proof_reader
      AND function_row.provolatile = 's'
      AND function_row.proretset
      AND function_row.prorettype =
          'pg_catalog.record'::pg_catalog.regtype
      AND function_row.proconfig =
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION
      'finalizer/proof-reader publication contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname IN (
        'seal_leaderboard_rank_publication',
        'finalize_leaderboard_rank_generation_v1',
        'arena_leaderboard_publication_proofs'
      )
      AND function_row.oid NOT IN (v_seal, v_finalizer, v_proof_reader)
  ) THEN
    RAISE EXCEPTION
      'leaderboard publication authority has an unsupported overload';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role', v_finalizer, 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_proof_reader, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('anon', v_seal, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', v_seal, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('anon', v_finalizer, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', v_finalizer, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_proof_reader, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_proof_reader, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'leaderboard publication application EXECUTE boundary drifted';
  END IF;

  -- Enforce postdeploy ordering after the rank-table and legacy-writer cuts.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY[
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER',
      'MAINTAIN'
    ]::text[]) AS privilege_name(value)
    WHERE pg_catalog.has_table_privilege(
      'service_role',
      'public.leaderboard_ranks',
      privilege_name.value
    )
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    'public.cleanup_leaderboard_rank_publication(text,uuid,jsonb)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    'public.rerank_leaderboard_publication(text,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'leaderboard rank writer postdeploy cuts have not completed';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
       'service_role',
       'public.leaderboard_source_freshness',
       'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'anon',
       'public.leaderboard_source_freshness',
       'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'authenticated',
       'public.leaderboard_source_freshness',
       'SELECT'
     ) THEN
    RAISE EXCEPTION 'leaderboard freshness read surface drifted';
  END IF;
END
$preflight$;

-- Retain a function-object lock through commit so the ACL cutover cannot race
-- CREATE OR REPLACE. The finalizer invokes this function as owner afterwards.
ALTER FUNCTION public.seal_leaderboard_rank_publication(text, uuid, jsonb)
  OWNER TO postgres;

LOCK TABLE
  public.leaderboard_source_freshness,
  arena.leaderboard_rank_mutation_fences,
  arena.leaderboard_rank_publications,
  arena.leaderboard_rank_cleanup_receipts
IN ACCESS EXCLUSIVE MODE;

DO $close_seal_execute$
DECLARE
  v_seal oid := pg_catalog.to_regprocedure(
    'public.seal_leaderboard_rank_publication(text,uuid,jsonb)'
  );
  v_grantee oid;
  v_role_name text;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT expanded.grantee
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS expanded
    WHERE function_row.oid = v_seal
      AND expanded.privilege_type = 'EXECUTE'
      AND expanded.grantee <> function_row.proowner
    ORDER BY expanded.grantee
  LOOP
    IF v_grantee = 0 THEN
      EXECUTE
        'REVOKE EXECUTE ON FUNCTION public.seal_leaderboard_rank_publication(text, uuid, jsonb) FROM PUBLIC CASCADE';
    ELSE
      SELECT role_row.rolname
      INTO STRICT v_role_name
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_grantee;

      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON FUNCTION public.seal_leaderboard_rank_publication(text, uuid, jsonb) FROM %I CASCADE',
        v_role_name
      );
    END IF;
  END LOOP;

  REVOKE EXECUTE
    ON FUNCTION public.seal_leaderboard_rank_publication(text, uuid, jsonb)
    FROM PUBLIC, anon, authenticated, service_role CASCADE;
END
$close_seal_execute$;

REVOKE ALL PRIVILEGES
  ON TABLE public.leaderboard_source_freshness
  FROM service_role CASCADE;
GRANT SELECT
  ON TABLE public.leaderboard_source_freshness
  TO service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON TABLE public.leaderboard_source_freshness
  FROM PUBLIC, anon, authenticated, service_role CASCADE;

DO $close_freshness_column_dml$
DECLARE
  v_columns text;
  v_privilege text;
BEGIN
  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', '
    ORDER BY attribute.attnum
  )
  INTO STRICT v_columns
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid =
        'public.leaderboard_source_freshness'::pg_catalog.regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  FOREACH v_privilege IN ARRAY ARRAY[
    'INSERT',
    'UPDATE',
    'REFERENCES'
  ]::text[]
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE %s (%s) ON TABLE public.leaderboard_source_freshness FROM PUBLIC, anon, authenticated, service_role CASCADE',
      v_privilege,
      v_columns
    );
  END LOOP;
END
$close_freshness_column_dml$;

DO $converge_private_tables$
DECLARE
  v_relation record;
BEGIN
  FOR v_relation IN
    SELECT private_table.signature, private_table.relation_oid
    FROM leaderboard_publication_private_tables AS private_table
    ORDER BY private_table.ordinality
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE %s FROM PUBLIC, anon, authenticated, service_role CASCADE',
      v_relation.relation_oid::pg_catalog.regclass
    );
  END LOOP;
END
$converge_private_tables$;

COMMENT ON FUNCTION public.seal_leaderboard_rank_publication(
  text,
  uuid,
  jsonb
) IS
  'Owner-only atomic-finalizer helper. Application roles cannot seal publication state independently.';
COMMENT ON TABLE public.leaderboard_source_freshness IS
  'Public read-only source watermark and immutable publication pointer. Only the postgres-owned atomic finalizer seal may mutate it.';

DO $postflight$
DECLARE
  v_authority record;
  v_private record;
  v_role name;
  v_privilege text;
BEGIN
  FOR v_authority IN
    SELECT
      before.signature,
      before.classification,
      before.function_oid,
      function_row.oid AS after_oid,
      function_row.proowner,
      function_row.prosecdef
    FROM leaderboard_publication_authority_before AS before
    LEFT JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = pg_catalog.to_regprocedure(before.signature)
    ORDER BY before.ordinality
  LOOP
    IF v_authority.after_oid IS NULL
       OR v_authority.after_oid IS DISTINCT FROM v_authority.function_oid
       OR v_authority.proowner IS DISTINCT FROM
            'postgres'::pg_catalog.regrole
       OR NOT v_authority.prosecdef THEN
      RAISE EXCEPTION
        'leaderboard publication function identity drifted: %',
        v_authority.signature;
    END IF;

    FOREACH v_role IN ARRAY ARRAY[
      'service_role'::name,
      'anon'::name,
      'authenticated'::name
    ]
    LOOP
      IF pg_catalog.has_function_privilege(
           v_role,
           v_authority.after_oid,
           'EXECUTE'
         ) IS DISTINCT FROM (
           v_role = 'service_role'::name
           AND v_authority.classification IN (
             'canonical_finalizer',
             'proof_reader'
           )
         ) THEN
        RAISE EXCEPTION
          'leaderboard publication EXECUTE boundary drifted: % / %',
          v_authority.signature,
          v_role;
      END IF;
    END LOOP;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS expanded
    WHERE function_row.oid =
          'public.seal_leaderboard_rank_publication(text,uuid,jsonb)'
            ::pg_catalog.regprocedure
      AND expanded.privilege_type = 'EXECUTE'
      AND expanded.grantee <> function_row.proowner
  ) THEN
    RAISE EXCEPTION 'leaderboard seal ACL is not owner-only';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'service_role'::name,
    'anon'::name,
    'authenticated'::name
  ]
  LOOP
    IF NOT pg_catalog.has_table_privilege(
         v_role,
         'public.leaderboard_source_freshness',
         'SELECT'
       ) THEN
      RAISE EXCEPTION 'leaderboard freshness read closed to %', v_role;
    END IF;

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
           'public.leaderboard_source_freshness',
           v_privilege
         ) THEN
        RAISE EXCEPTION
          'leaderboard freshness % remains open to %',
          v_privilege,
          v_role;
      END IF;
    END LOOP;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS expanded
    WHERE attribute.attrelid =
          'public.leaderboard_source_freshness'::pg_catalog.regclass
      AND attribute.attnum > 0
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
      'leaderboard freshness column-level mutation ACL survived';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid =
          'public.leaderboard_source_freshness'::pg_catalog.regclass
      AND policy.polcmd IN ('*', 'a', 'w', 'd')
  ) THEN
    RAISE EXCEPTION
      'leaderboard freshness write policy survived publication cutover';
  END IF;

  FOR v_private IN
    SELECT private_table.signature, private_table.relation_oid
    FROM leaderboard_publication_private_tables AS private_table
    ORDER BY private_table.ordinality
  LOOP
    FOREACH v_role IN ARRAY ARRAY[
      'service_role'::name,
      'anon'::name,
      'authenticated'::name
    ]
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'SELECT',
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
             v_private.relation_oid,
             v_privilege
           ) THEN
          RAISE EXCEPTION
            'private publication table % remains open to % / %',
            v_private.signature,
            v_role,
            v_privilege;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
