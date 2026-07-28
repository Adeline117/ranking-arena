-- Bind leaderboard publication proof reads to the complete season authority.
--
-- A caller must no longer be able to ask for a trusted-looking subset. The
-- STABLE RPC materializes the distinct authority exactly once, validates the
-- caller's set against it, and uses only that frozen authority for every proof
-- row and season-global rerank check that follows.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
DECLARE
  v_proof_function oid := pg_catalog.to_regprocedure(
    'public.arena_leaderboard_publication_proofs(text,text[])'
  );
BEGIN
  IF v_proof_function IS NULL THEN
    RAISE EXCEPTION
      'leaderboard publication proof RPC must exist before authority strengthening';
  END IF;

  IF pg_catalog.to_regclass('public.leaderboard_ranks') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_source_freshness') IS NULL
     OR pg_catalog.to_regclass(
       'arena.leaderboard_rank_mutation_fences'
     ) IS NULL
     OR pg_catalog.to_regclass(
       'arena.leaderboard_rank_publications'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.arena_freshness_expected_sources()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamptz)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'leaderboard publication proof dependencies must exist';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'database owner and PostgREST API roles must exist';
  END IF;

  -- CREATE OR REPLACE cannot remove overloads. Refuse an ambiguous PostgREST
  -- surface before changing the exact function.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname = 'arena_leaderboard_publication_proofs'
      AND function_row.oid IS DISTINCT FROM v_proof_function
  ) THEN
    RAISE EXCEPTION
      'leaderboard publication proof RPC has an unsupported overload';
  END IF;

  -- Fail closed on every callable property that CREATE OR REPLACE preserves.
  -- Historical EXECUTE grants are handled separately and converged below.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_proof_function
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prokind = 'f'
      AND language_row.lanname = 'plpgsql'
      AND function_row.prosecdef
      AND NOT function_row.proleakproof
      AND NOT function_row.proisstrict
      AND function_row.provolatile = 's'
      AND function_row.proparallel = 'u'
      AND function_row.prorettype = 'pg_catalog.record'::pg_catalog.regtype
      AND function_row.proretset
      AND function_row.pronargs = 2
      AND function_row.pronargdefaults = 0
      AND function_row.proargtypes = ARRAY[
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.text[]'::pg_catalog.regtype
      ]::pg_catalog.oidvector
      AND function_row.proallargtypes = ARRAY[
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.text[]'::pg_catalog.regtype,
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.timestamptz'::pg_catalog.regtype,
        'pg_catalog.timestamptz'::pg_catalog.regtype,
        'pg_catalog.uuid'::pg_catalog.regtype,
        'pg_catalog.int8'::pg_catalog.regtype,
        'pg_catalog.int8'::pg_catalog.regtype,
        'pg_catalog.int4'::pg_catalog.regtype,
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.bool'::pg_catalog.regtype
      ]::pg_catalog.oid[]
      AND function_row.proargmodes = ARRAY[
        'i', 'i', 't', 't', 't', 't',
        't', 't', 't', 't', 't', 't'
      ]::"char"[]
      AND function_row.proargnames = ARRAY[
        'p_season_id',
        'p_sources',
        'season_id',
        'source',
        'source_as_of',
        'recorded_at',
        'score_cohort_id',
        'rank_mutation_seq',
        'current_mutation_seq',
        'published_rank_count',
        'published_identity_sha256',
        'is_sealed'
      ]::pg_catalog.text[]
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
  ) THEN
    RAISE EXCEPTION
      'leaderboard publication proof callable contract drifted';
  END IF;
END
$preflight$;

CREATE TEMP TABLE leaderboard_publication_proof_contract_before
ON COMMIT DROP
AS
SELECT function_row.oid
FROM pg_catalog.pg_proc AS function_row
WHERE function_row.oid =
  'public.arena_leaderboard_publication_proofs(text,text[])'
    ::pg_catalog.regprocedure;

CREATE OR REPLACE FUNCTION public.arena_leaderboard_publication_proofs(
  p_season_id text,
  p_sources text[]
)
RETURNS TABLE (
  season_id text,
  source text,
  source_as_of timestamptz,
  recorded_at timestamptz,
  score_cohort_id uuid,
  rank_mutation_seq bigint,
  current_mutation_seq bigint,
  published_rank_count integer,
  published_identity_sha256 text,
  is_sealed boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_authority_sources text[];
  v_authority_count integer;
BEGIN
  IF p_season_id IS NULL OR p_season_id NOT IN ('7D', '30D', '90D') THEN
    RAISE EXCEPTION 'invalid leaderboard proof season: %', p_season_id
      USING ERRCODE = '22023';
  END IF;

  IF p_sources IS NULL
     OR pg_catalog.array_ndims(p_sources) IS DISTINCT FROM 1
     OR pg_catalog.array_lower(p_sources, 1) IS DISTINCT FROM 1
     OR pg_catalog.cardinality(p_sources) < 1
     OR pg_catalog.cardinality(p_sources) > 256
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(p_sources) AS requested(value)
       WHERE requested.value IS NULL
          OR pg_catalog.char_length(requested.value) > 128
          OR requested.value COLLATE "C"
               !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
     )
     OR (
       SELECT pg_catalog.count(DISTINCT requested.value COLLATE "C")
       FROM pg_catalog.unnest(p_sources) AS requested(value)
     ) <> pg_catalog.cardinality(p_sources)
     OR (
       SELECT COALESCE(
         pg_catalog.sum(
           pg_catalog.octet_length(
             pg_catalog.convert_to(requested.value, 'UTF8')
           )
         ),
         0
       )
       FROM pg_catalog.unnest(p_sources) AS requested(value)
     ) > 65536 THEN
    RAISE EXCEPTION
      'proof sources are invalid, duplicated, or exceed the request bound'
      USING ERRCODE = '22023';
  END IF;

  -- This is the only authority read in the RPC. Because the function is
  -- STABLE, this materialization and every later proof read share the caller
  -- statement snapshot even while the registry changes concurrently.
  SELECT COALESCE(
    pg_catalog.array_agg(
      authority_source.source
      ORDER BY authority_source.source COLLATE "C"
    ),
    ARRAY[]::pg_catalog.text[]
  )
  INTO v_authority_sources
  FROM (
    SELECT DISTINCT authority.filter_source COLLATE "C" AS source
    FROM public.arena_freshness_expected_sources() AS authority
    WHERE authority.season_id = p_season_id
  ) AS authority_source;

  v_authority_count := pg_catalog.cardinality(v_authority_sources);

  IF v_authority_count < 1
     OR v_authority_count > 256
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(v_authority_sources) AS authority(source)
       WHERE authority.source IS NULL
          OR pg_catalog.char_length(authority.source) > 128
          OR authority.source COLLATE "C"
               !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
     ) THEN
    RAISE EXCEPTION
      'leaderboard proof authority is empty, invalid, or exceeds the bound'
      USING ERRCODE = '22023';
  END IF;

  -- Both EXCEPT directions are deliberate: neither a trusted-looking subset
  -- nor an invented superset may reach the proof rows.
  IF EXISTS (
    SELECT authority.source COLLATE "C"
    FROM pg_catalog.unnest(v_authority_sources) AS authority(source)
    EXCEPT
    SELECT requested.value COLLATE "C"
    FROM pg_catalog.unnest(p_sources) AS requested(value)
  ) OR EXISTS (
    SELECT requested.value COLLATE "C"
    FROM pg_catalog.unnest(p_sources) AS requested(value)
    EXCEPT
    SELECT authority.source COLLATE "C"
    FROM pg_catalog.unnest(v_authority_sources) AS authority(source)
  ) THEN
    RAISE EXCEPTION
      'proof sources do not exactly match the season authority'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH rank_authority AS MATERIALIZED (
    SELECT authority.source
    FROM pg_catalog.unnest(v_authority_sources) AS authority(source)
  ),
  ordered AS MATERIALIZED (
    SELECT
      ranks.id,
      pg_catalog.row_number() OVER (
        ORDER BY ranks.arena_score DESC NULLS LAST, ranks.id
      ) AS expected_rank
    FROM public.leaderboard_ranks AS ranks
    JOIN rank_authority ON rank_authority.source = ranks.source
    WHERE ranks.season_id = p_season_id
      AND arena.leaderboard_rank_row_is_public_eligible(
        ranks,
        pg_catalog.statement_timestamp()
      )
  )
  SELECT
    p_season_id,
    requested.source,
    freshness.source_as_of,
    freshness.recorded_at,
    freshness.score_cohort_id,
    freshness.rank_mutation_seq,
    COALESCE(fence.mutation_seq, 0),
    freshness.published_rank_count,
    freshness.published_identity_sha256,
    COALESCE((
      publication.id IS NOT NULL
      AND publication.season_id = p_season_id
      AND publication.published_at IS NOT DISTINCT FROM freshness.recorded_at
      AND publication.source_count =
            pg_catalog.jsonb_array_length(publication.proofs)
      AND publication.source_count = v_authority_count
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(publication.proofs) AS audit(proof)
        WHERE NOT EXISTS (
          SELECT 1
          FROM rank_authority
          WHERE rank_authority.source = audit.proof->>'source'
        )
      )
      AND freshness.score_cohort_id IS NOT NULL
      AND freshness.rank_mutation_seq IS NOT NULL
      AND freshness.rank_mutation_seq = COALESCE(fence.mutation_seq, 0)
      AND freshness.published_rank_count IS NOT NULL
      AND freshness.published_identity_sha256 ~ '^[0-9a-f]{64}$'
      AND EXISTS (
        SELECT 1
        FROM rank_authority
        WHERE rank_authority.source = freshness.source
      )
      AND 1 = (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_array_elements(publication.proofs) AS audit(proof)
        WHERE audit.proof->>'source' = freshness.source
      )
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(publication.proofs) AS audit(proof)
        WHERE audit.proof = pg_catalog.jsonb_build_object(
          'source', freshness.source,
          'source_as_of', pg_catalog.to_char(
            freshness.source_as_of AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ),
          'recorded_at', pg_catalog.to_char(
            freshness.recorded_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ),
          'score_cohort_id', freshness.score_cohort_id,
          'rank_mutation_seq', freshness.rank_mutation_seq,
          'published_rank_count', freshness.published_rank_count,
          'published_identity_sha256', freshness.published_identity_sha256
        )
      )
      AND freshness.published_rank_count = (
        SELECT pg_catalog.count(*)::integer
        FROM public.leaderboard_ranks AS ranks
        WHERE ranks.season_id = p_season_id
          AND ranks.source = freshness.source
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.leaderboard_ranks AS ranks
        WHERE ranks.season_id = p_season_id
          AND ranks.source = freshness.source
          AND (
            ranks.rank_publication_id IS DISTINCT FROM freshness.score_cohort_id
            OR NOT arena.leaderboard_rank_row_is_public_eligible(
              ranks,
              pg_catalog.statement_timestamp()
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.leaderboard_ranks AS ranks
        JOIN ordered ON ordered.id = ranks.id
        WHERE ranks.season_id = p_season_id
          AND ranks.rank::bigint IS DISTINCT FROM ordered.expected_rank
      )
    ), false) AS is_sealed
  FROM rank_authority AS requested
  LEFT JOIN public.leaderboard_source_freshness AS freshness
    ON freshness.season_id = p_season_id
   AND freshness.source = requested.source
  LEFT JOIN arena.leaderboard_rank_mutation_fences AS fence
    ON fence.season_id = p_season_id
   AND fence.source = requested.source
  LEFT JOIN arena.leaderboard_rank_publications AS publication
    ON publication.id = freshness.score_cohort_id
   AND publication.season_id = p_season_id
  ORDER BY requested.source COLLATE "C";
END;
$function$;

ALTER FUNCTION public.arena_leaderboard_publication_proofs(text, text[])
  OWNER TO postgres;

-- CREATE OR REPLACE preserves historical ACLs. Remove every direct EXECUTE
-- grantee other than the owner and service role, including PUBLIC and quoted
-- names; CASCADE also removes grants they delegated.
DO $revoke_rogue_execute$
DECLARE
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
    WHERE function_row.oid =
      'public.arena_leaderboard_publication_proofs(text,text[])'
        ::pg_catalog.regprocedure
      AND expanded.privilege_type = 'EXECUTE'
      AND expanded.grantee <> function_row.proowner
      AND expanded.grantee <> 'service_role'::pg_catalog.regrole
    ORDER BY expanded.grantee
  LOOP
    IF v_grantee = 0 THEN
      EXECUTE
        'REVOKE EXECUTE ON FUNCTION public.arena_leaderboard_publication_proofs(text, text[]) FROM PUBLIC CASCADE';
    ELSE
      SELECT role_row.rolname
      INTO STRICT v_role_name
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_grantee;

      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON FUNCTION public.arena_leaderboard_publication_proofs(text, text[]) FROM %I CASCADE',
        v_role_name
      );
    END IF;
  END LOOP;
END
$revoke_rogue_execute$;

REVOKE EXECUTE
  ON FUNCTION public.arena_leaderboard_publication_proofs(text, text[])
  FROM PUBLIC, anon, authenticated;
REVOKE GRANT OPTION FOR EXECUTE
  ON FUNCTION public.arena_leaderboard_publication_proofs(text, text[])
  FROM service_role CASCADE;
GRANT EXECUTE
  ON FUNCTION public.arena_leaderboard_publication_proofs(text, text[])
  TO service_role;

COMMENT ON FUNCTION public.arena_leaderboard_publication_proofs(text, text[]) IS
  'Service-only, full-authority proof read: one STABLE statement snapshot anchors the exact authority, immutable receipt, row count, writer cohort, current fence, and season-global rank order.';

DO $postflight$
DECLARE
  v_before oid;
  v_after oid := pg_catalog.to_regprocedure(
    'public.arena_leaderboard_publication_proofs(text,text[])'
  );
BEGIN
  SELECT contract.oid
  INTO STRICT v_before
  FROM leaderboard_publication_proof_contract_before AS contract;

  IF v_after IS NULL OR v_after IS DISTINCT FROM v_before OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname = 'arena_leaderboard_publication_proofs'
      AND function_row.oid IS DISTINCT FROM v_after
  ) THEN
    RAISE EXCEPTION
      'leaderboard publication proof identity or overload postflight failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_after
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prokind = 'f'
      AND language_row.lanname = 'plpgsql'
      AND function_row.prosecdef
      AND NOT function_row.proleakproof
      AND NOT function_row.proisstrict
      AND function_row.provolatile = 's'
      AND function_row.proparallel = 'u'
      AND function_row.prorettype = 'pg_catalog.record'::pg_catalog.regtype
      AND function_row.proretset
      AND function_row.pronargs = 2
      AND function_row.pronargdefaults = 0
      AND function_row.proargtypes = ARRAY[
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.text[]'::pg_catalog.regtype
      ]::pg_catalog.oidvector
      AND function_row.proallargtypes = ARRAY[
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.text[]'::pg_catalog.regtype,
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.timestamptz'::pg_catalog.regtype,
        'pg_catalog.timestamptz'::pg_catalog.regtype,
        'pg_catalog.uuid'::pg_catalog.regtype,
        'pg_catalog.int8'::pg_catalog.regtype,
        'pg_catalog.int8'::pg_catalog.regtype,
        'pg_catalog.int4'::pg_catalog.regtype,
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.bool'::pg_catalog.regtype
      ]::pg_catalog.oid[]
      AND function_row.proargmodes = ARRAY[
        'i', 'i', 't', 't', 't', 't',
        't', 't', 't', 't', 't', 't'
      ]::"char"[]
      AND function_row.proargnames = ARRAY[
        'p_season_id',
        'p_sources',
        'season_id',
        'source',
        'source_as_of',
        'recorded_at',
        'score_cohort_id',
        'rank_mutation_seq',
        'current_mutation_seq',
        'published_rank_count',
        'published_identity_sha256',
        'is_sealed'
      ]::pg_catalog.text[]
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
  ) THEN
    RAISE EXCEPTION
      'leaderboard publication proof callable postflight failed';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role', v_after, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('anon', v_after, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', v_after, 'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS expanded
       WHERE function_row.oid = v_after
         AND expanded.privilege_type = 'EXECUTE'
         AND expanded.grantee <> function_row.proowner
         AND expanded.grantee <> 'service_role'::pg_catalog.regrole
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS expanded
       WHERE function_row.oid = v_after
         AND expanded.grantee = 'service_role'::pg_catalog.regrole
         AND expanded.privilege_type = 'EXECUTE'
         AND expanded.is_grantable
     ) THEN
    RAISE EXCEPTION
      'leaderboard publication proof EXECUTE ACL is not a closed set';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
