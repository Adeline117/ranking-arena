-- Postdeploy authority cutover: the atomic generation finalizer is now the
-- only application-executable database function allowed to mutate live
-- leaderboard ranks. Retain its owner-only cleanup/rerank helpers, but remove
-- every external EXECUTE grant from the four public legacy writers and the
-- superseded arena batch writer.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'close-legacy-leaderboard-rank-writer-rpcs@1',
    0
  )
);

CREATE TEMP TABLE expected_leaderboard_rank_writer_surface (
  signature text PRIMARY KEY,
  classification text NOT NULL CHECK (
    classification IN ('canonical', 'legacy')
  ),
  security_definer boolean NOT NULL,
  function_oid oid
) ON COMMIT DROP;

INSERT INTO expected_leaderboard_rank_writer_surface (
  signature,
  classification,
  security_definer,
  function_oid
) VALUES
  (
    'public.finalize_leaderboard_rank_generation_v1(text,bigint,uuid,uuid,text,jsonb)',
    'canonical',
    true,
    pg_catalog.to_regprocedure(
      'public.finalize_leaderboard_rank_generation_v1(text,bigint,uuid,uuid,text,jsonb)'
    )
  ),
  (
    'public.rerank_leaderboard(text)',
    'legacy',
    true,
    pg_catalog.to_regprocedure('public.rerank_leaderboard(text)')
  ),
  (
    'public.cleanup_stale_platform_rows(text,text,text[])',
    'legacy',
    true,
    pg_catalog.to_regprocedure(
      'public.cleanup_stale_platform_rows(text,text,text[])'
    )
  ),
  (
    'public.rerank_leaderboard_publication(text,uuid)',
    'legacy',
    true,
    pg_catalog.to_regprocedure(
      'public.rerank_leaderboard_publication(text,uuid)'
    )
  ),
  (
    'public.cleanup_leaderboard_rank_publication(text,uuid,jsonb)',
    'legacy',
    true,
    pg_catalog.to_regprocedure(
      'public.cleanup_leaderboard_rank_publication(text,uuid,jsonb)'
    )
  ),
  (
    'arena.write_leaderboard_rank_generation_batch_v1(text,bigint,uuid,integer,uuid,text,text[],arena.leaderboard_rank_batch_row_v1[])',
    'legacy',
    false,
    pg_catalog.to_regprocedure(
      'arena.write_leaderboard_rank_generation_batch_v1(text,bigint,uuid,integer,uuid,text,text[],arena.leaderboard_rank_batch_row_v1[])'
    )
  );

CREATE TEMP TABLE observed_leaderboard_rank_writer_surface
ON COMMIT DROP
AS
SELECT function_row.oid AS function_oid
FROM pg_catalog.pg_proc AS function_row
JOIN pg_catalog.pg_namespace AS namespace_row
  ON namespace_row.oid = function_row.pronamespace
WHERE namespace_row.nspname IN ('public', 'arena')
  AND function_row.prokind = 'f'
  AND function_row.prosrc ~* pg_catalog.concat(
    '((insert[[:space:]]+into)|(update)|(delete[[:space:]]+from)|',
    '(merge[[:space:]]+into)|(truncate([[:space:]]+table)?))',
    '[[:space:]]+(only[[:space:]]+)?(public[.])?',
    'leaderboard_ranks([[:space:]]|$)'
  );

CREATE TEMP TABLE canonical_leaderboard_publisher_authority (
  ordinality integer PRIMARY KEY,
  signature text NOT NULL UNIQUE,
  function_oid oid
) ON COMMIT DROP;

INSERT INTO canonical_leaderboard_publisher_authority (
  ordinality,
  signature,
  function_oid
)
SELECT
  authority.ordinality::integer,
  authority.signature,
  pg_catalog.to_regprocedure(authority.signature)
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
      'legacy leaderboard rank writer closure dependencies are unavailable';
  END IF;

  -- This postdeploy migration must run after the table-DML cutover.
  IF NOT pg_catalog.has_table_privilege(
       'service_role',
       'public.leaderboard_ranks',
       'SELECT'
     ) OR EXISTS (
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
     ) THEN
    RAISE EXCEPTION
      'leaderboard rank table-DML cutover has not completed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM expected_leaderboard_rank_writer_surface AS expected
    WHERE expected.function_oid IS NULL
  ) THEN
    RAISE EXCEPTION
      'an expected leaderboard rank writer function is unavailable';
  END IF;

  IF EXISTS (
    SELECT observed.function_oid
    FROM observed_leaderboard_rank_writer_surface AS observed
    EXCEPT
    SELECT expected.function_oid
    FROM expected_leaderboard_rank_writer_surface AS expected
  ) OR EXISTS (
    SELECT expected.function_oid
    FROM expected_leaderboard_rank_writer_surface AS expected
    EXCEPT
    SELECT observed.function_oid
    FROM observed_leaderboard_rank_writer_surface AS observed
  ) THEN
    RAISE EXCEPTION
      'leaderboard rank direct-writer catalog is not the reviewed closed set';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM expected_leaderboard_rank_writer_surface AS expected
    LEFT JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = expected.function_oid
    LEFT JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid IS NULL
       OR function_row.proowner IS DISTINCT FROM v_postgres
       OR function_row.prokind IS DISTINCT FROM 'f'
       OR language_row.lanname IS DISTINCT FROM 'plpgsql'
       OR function_row.provolatile IS DISTINCT FROM 'v'
       OR function_row.prosecdef IS DISTINCT FROM expected.security_definer
  ) THEN
    RAISE EXCEPTION
      'leaderboard rank writer owner/execution metadata drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM canonical_leaderboard_publisher_authority AS authority
    LEFT JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = authority.function_oid
    LEFT JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid IS NULL
       OR function_row.proowner IS DISTINCT FROM v_postgres
       OR function_row.prokind IS DISTINCT FROM 'f'
       OR language_row.lanname IS DISTINCT FROM 'plpgsql'
       OR NOT function_row.prosecdef
       OR function_row.proretset
       OR function_row.prorettype IS DISTINCT FROM
            'pg_catalog.jsonb'::pg_catalog.regtype
       OR NOT pg_catalog.has_function_privilege(
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
      'canonical leaderboard publisher authority drifted';
  END IF;

  -- Only the canonical finalizer may remain an externally executable direct or
  -- indirect rank writer. Unknown wrappers are rejected rather than blessed.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS caller
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = caller.pronamespace
    CROSS JOIN pg_catalog.unnest(ARRAY[
      'service_role'::name,
      'anon'::name,
      'authenticated'::name
    ]) AS role_name(value)
    WHERE namespace_row.nspname IN ('public', 'arena')
      AND caller.oid IS DISTINCT FROM pg_catalog.to_regprocedure(
        'public.finalize_leaderboard_rank_generation_v1(text,bigint,uuid,uuid,text,jsonb)'
      )
      AND caller.prosrc ~* pg_catalog.concat(
        '(cleanup_leaderboard_rank_publication|',
        'rerank_leaderboard_publication|',
        'cleanup_stale_platform_rows|rerank_leaderboard)',
        '[[:space:]]*[(]'
      )
      AND pg_catalog.has_function_privilege(
        role_name.value,
        caller.oid,
        'EXECUTE'
      )
  ) THEN
    RAISE EXCEPTION
      'an unknown externally executable indirect rank writer exists';
  END IF;
END
$preflight$;

-- Drain any live legacy write before changing its function ACL, and hold the
-- table lock until all function-object ACL changes commit together.
LOCK TABLE public.leaderboard_ranks IN ACCESS EXCLUSIVE MODE;

DO $close_legacy_execute$
DECLARE
  v_function record;
  v_grantee oid;
  v_role_name text;
BEGIN
  FOR v_function IN
    SELECT
      expected.signature,
      expected.function_oid,
      function_row.proowner
    FROM expected_leaderboard_rank_writer_surface AS expected
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = expected.function_oid
    WHERE expected.classification = 'legacy'
    ORDER BY expected.signature COLLATE pg_catalog."C"
  LOOP
    -- A no-op owner normalization takes and retains the function-object lock,
    -- preventing the cutover from racing function replacement.
    EXECUTE pg_catalog.format(
      'ALTER FUNCTION %s OWNER TO postgres',
      v_function.function_oid::pg_catalog.regprocedure
    );

    FOR v_grantee IN
      SELECT DISTINCT expanded.grantee
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS expanded
      WHERE function_row.oid = v_function.function_oid
        AND expanded.privilege_type = 'EXECUTE'
        AND expanded.grantee <> function_row.proowner
      ORDER BY expanded.grantee
    LOOP
      IF v_grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC CASCADE',
          v_function.function_oid::pg_catalog.regprocedure
        );
      ELSE
        SELECT role_row.rolname
        INTO STRICT v_role_name
        FROM pg_catalog.pg_roles AS role_row
        WHERE role_row.oid = v_grantee;

        EXECUTE pg_catalog.format(
          'REVOKE EXECUTE ON FUNCTION %s FROM %I CASCADE',
          v_function.function_oid::pg_catalog.regprocedure,
          v_role_name
        );
      END IF;
    END LOOP;

    EXECUTE pg_catalog.format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role CASCADE',
      v_function.function_oid::pg_catalog.regprocedure
    );
  END LOOP;
END
$close_legacy_execute$;

COMMENT ON FUNCTION public.rerank_leaderboard(text) IS
  'Retired owner-only legacy rerank. Atomic generation finalization is the sole application-executable live-rank writer.';
COMMENT ON FUNCTION public.cleanup_stale_platform_rows(text, text, text[]) IS
  'Retired owner-only legacy cleanup. Atomic generation finalization is the sole application-executable live-rank writer.';
COMMENT ON FUNCTION public.rerank_leaderboard_publication(text, uuid) IS
  'Owner-only atomic-finalizer helper; never an independently executable application RPC.';
COMMENT ON FUNCTION public.cleanup_leaderboard_rank_publication(
  text,
  uuid,
  jsonb
) IS
  'Owner-only atomic-finalizer helper; never an independently executable application RPC.';
COMMENT ON FUNCTION arena.write_leaderboard_rank_generation_batch_v1(
  text,
  bigint,
  uuid,
  integer,
  uuid,
  text,
  text[],
  arena.leaderboard_rank_batch_row_v1[]
) IS
  'Retired owner-only staged-writer implementation. The public atomic stage/finalizer pair replaced live batch writes.';

DO $postflight$
DECLARE
  v_expected record;
  v_role name;
BEGIN
  FOR v_expected IN
    SELECT
      expected.signature,
      expected.classification,
      expected.security_definer,
      expected.function_oid,
      function_row.oid AS after_oid,
      function_row.proowner,
      function_row.prosecdef
    FROM expected_leaderboard_rank_writer_surface AS expected
    LEFT JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = pg_catalog.to_regprocedure(expected.signature)
    ORDER BY expected.signature COLLATE pg_catalog."C"
  LOOP
    IF v_expected.after_oid IS NULL
       OR v_expected.after_oid IS DISTINCT FROM v_expected.function_oid
       OR v_expected.proowner IS DISTINCT FROM
            'postgres'::pg_catalog.regrole
       OR v_expected.prosecdef IS DISTINCT FROM
            v_expected.security_definer THEN
      RAISE EXCEPTION
        'leaderboard rank writer identity drifted: %',
        v_expected.signature;
    END IF;

    FOREACH v_role IN ARRAY ARRAY[
      'service_role'::name,
      'anon'::name,
      'authenticated'::name
    ]
    LOOP
      IF pg_catalog.has_function_privilege(
           v_role,
           v_expected.after_oid,
           'EXECUTE'
         ) IS DISTINCT FROM (
           v_expected.classification = 'canonical'
           AND v_role = 'service_role'::name
         ) THEN
        RAISE EXCEPTION
          'leaderboard rank writer EXECUTE boundary drifted: % / %',
          v_expected.signature,
          v_role;
      END IF;
    END LOOP;

    IF v_expected.classification = 'legacy' AND EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS expanded
      WHERE function_row.oid = v_expected.after_oid
        AND expanded.privilege_type = 'EXECUTE'
        AND expanded.grantee <> function_row.proowner
    ) THEN
      RAISE EXCEPTION
        'legacy leaderboard rank writer ACL is not owner-only: %',
        v_expected.signature;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM canonical_leaderboard_publisher_authority AS authority
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = authority.function_oid
    WHERE function_row.proowner IS DISTINCT FROM
            'postgres'::pg_catalog.regrole
       OR NOT function_row.prosecdef
       OR NOT pg_catalog.has_function_privilege(
            'service_role', authority.function_oid, 'EXECUTE'
          )
       OR pg_catalog.has_function_privilege(
            'anon', authority.function_oid, 'EXECUTE'
          )
       OR pg_catalog.has_function_privilege(
            'authenticated', authority.function_oid, 'EXECUTE'
          )
  ) THEN
    RAISE EXCEPTION
      'canonical leaderboard publisher authority changed during cutover';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS caller
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = caller.pronamespace
    CROSS JOIN pg_catalog.unnest(ARRAY[
      'service_role'::name,
      'anon'::name,
      'authenticated'::name
    ]) AS role_name(value)
    WHERE namespace_row.nspname IN ('public', 'arena')
      AND caller.oid IS DISTINCT FROM pg_catalog.to_regprocedure(
        'public.finalize_leaderboard_rank_generation_v1(text,bigint,uuid,uuid,text,jsonb)'
      )
      AND caller.prosrc ~* pg_catalog.concat(
        '(cleanup_leaderboard_rank_publication|',
        'rerank_leaderboard_publication|',
        'cleanup_stale_platform_rows|rerank_leaderboard)',
        '[[:space:]]*[(]'
      )
      AND pg_catalog.has_function_privilege(
        role_name.value,
        caller.oid,
        'EXECUTE'
      )
  ) THEN
    RAISE EXCEPTION
      'an externally executable indirect leaderboard rank writer survived';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
