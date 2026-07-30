-- Migration: 20260729223000_rerank_public_eligible_rows_only.sql
--
-- `rank` is public authority, not a display convenience. The legacy reranker
-- assigned ROW_NUMBER to every materialized row, including zero/null scores,
-- outliers, partial/estimated metrics, stale observations, and sources outside
-- the active serving registry. Keep those observations for profile/raw-data
-- paths, but make their rank NULL and rank only the reviewed public cohort.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
DECLARE
  v_expected_sources oid := pg_catalog.to_regprocedure(
    'public.arena_freshness_expected_sources()'
  );
  v_eligibility oid := pg_catalog.to_regprocedure(
    'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamp with time zone)'
  );
  v_legacy_rerank oid := pg_catalog.to_regprocedure(
    'public.rerank_leaderboard(text)'
  );
  v_quarantine_marker constant text :=
    'bitget-bot-cumulative-rank-quarantine@1';
BEGIN
  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'database owner and PostgREST API roles are required';
  END IF;
  IF pg_catalog.to_regclass('public.leaderboard_ranks') IS NULL THEN
    RAISE EXCEPTION 'public.leaderboard_ranks is required before eligibility-aware reranking';
  END IF;
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.exchanges') IS NULL THEN
    RAISE EXCEPTION 'arena source registry is required before eligibility-aware reranking';
  END IF;
  IF v_expected_sources IS NULL THEN
    RAISE EXCEPTION 'public.arena_freshness_expected_sources() is required';
  END IF;
  IF v_eligibility IS NULL THEN
    RAISE EXCEPTION 'arena.leaderboard_rank_row_is_public_eligible(...) is required';
  END IF;
  IF v_legacy_rerank IS NULL THEN
    RAISE EXCEPTION 'legacy public.rerank_leaderboard(text) is required';
  END IF;

  -- Do not install a new rank authority on top of the pre-quarantine source
  -- registry function. The reviewed Bitget bot migration hardened this exact
  -- catalog contract and installed a validated table-level backstop.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_expected_sources
      AND function_row.prokind = 'f'
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prosecdef
      AND function_row.provolatile = 's'
      AND function_row.proretset
      AND function_row.pronargs = 0
      AND function_row.prorettype = 'pg_catalog.record'::pg_catalog.regtype
      AND language_row.lanname = 'sql'
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
      AND (
        pg_catalog.length(function_row.prosrc)
        - pg_catalog.length(
            pg_catalog.replace(
              function_row.prosrc,
              v_quarantine_marker,
              ''
            )
          )
      ) / pg_catalog.length(v_quarantine_marker) = 1
  ) THEN
    RAISE EXCEPTION
      'post-quarantine expected-source authority contract is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
          'public.leaderboard_ranks'::pg_catalog.regclass
      AND constraint_row.conname =
          'leaderboard_ranks_block_cumulative_bitget_bot_authority'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) =
        'CHECK (source <> ALL (ARRAY[''bitget_bots_futures''::text, ''bitget_bots_spot''::text]))'
  ) THEN
    RAISE EXCEPTION
      'validated cumulative Bitget bot rank quarantine is required';
  END IF;
END
$preflight$;

-- Use a new RPC identity so an application deployment that reaches an older
-- database gets 42883 and fails closed instead of silently calling the legacy
-- all-row implementation. The follow-up rank/count migration cuts the legacy
-- name over in the same transaction as the live rank/count repair.
CREATE OR REPLACE FUNCTION public.rerank_public_eligible_leaderboard(
  p_season_id text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '10s'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  IF p_season_id IS NULL
     OR p_season_id NOT IN ('7D', '30D', '90D') THEN
    RAISE EXCEPTION 'invalid leaderboard rerank season: %', p_season_id
      USING ERRCODE = '22023';
  END IF;

  -- Match the established publication lock order. The registry snapshot and
  -- rank rewrite therefore belong to one transaction and one source authority.
  LOCK TABLE arena.sources, arena.exchanges IN SHARE MODE;
  LOCK TABLE public.leaderboard_ranks IN SHARE ROW EXCLUSIVE MODE;

  WITH rank_authority AS MATERIALIZED (
    SELECT DISTINCT authority.filter_source AS source
    FROM public.arena_freshness_expected_sources() AS authority
    WHERE authority.season_id = p_season_id
  ),
  classified AS MATERIALIZED (
    SELECT
      ranks.id,
      ranks.season_id,
      ranks.source,
      ranks.source_trader_id,
      ranks.arena_score,
      rank_authority.source IS NOT NULL
        AND arena.leaderboard_rank_row_is_public_eligible(
          ranks,
          pg_catalog.transaction_timestamp()
        ) AS is_eligible
    FROM public.leaderboard_ranks AS ranks
    LEFT JOIN rank_authority
      ON rank_authority.source = ranks.source
    WHERE ranks.season_id = p_season_id
  ),
  ordered AS MATERIALIZED (
    SELECT
      classified.id,
      classified.season_id,
      pg_catalog.row_number() OVER (
        ORDER BY
          classified.arena_score DESC NULLS LAST,
          classified.id
      )::integer AS expected_rank
    FROM classified
    WHERE classified.is_eligible
  ),
  desired AS MATERIALIZED (
    SELECT
      classified.id,
      classified.season_id,
      ordered.expected_rank,
      NULL::integer AS expected_rank_change,
      false AS expected_is_new
    FROM classified
    LEFT JOIN ordered
      ON ordered.id = classified.id
     AND ordered.season_id = classified.season_id
  )
  UPDATE public.leaderboard_ranks AS ranks
  SET
    rank = desired.expected_rank,
    rank_change = desired.expected_rank_change,
    is_new = desired.expected_is_new
  FROM desired
  WHERE ranks.id = desired.id
    AND ranks.season_id = desired.season_id
    AND (
      ranks.rank IS DISTINCT FROM desired.expected_rank
      OR ranks.rank_change IS DISTINCT FROM desired.expected_rank_change
      OR ranks.is_new IS DISTINCT FROM desired.expected_is_new
    );

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END
$function$;

ALTER FUNCTION public.rerank_public_eligible_leaderboard(text)
  OWNER TO postgres;

-- CREATE FUNCTION can inherit explicit grants from ALTER DEFAULT PRIVILEGES,
-- so remove all non-owner grants from the new fail-closed identity before
-- granting the one intended runtime caller. The legacy identity remains
-- untouched until the atomic rank/count cutover migration.
DO $close_acl$
DECLARE
  v_target record;
  v_function oid;
  v_owner oid;
  v_grantee oid;
  v_grantee_name name;
BEGIN
  FOR v_target IN
    SELECT requested.signature
    FROM (
      VALUES
        ('public.rerank_public_eligible_leaderboard(text)'::text)
    ) AS requested(signature)
    ORDER BY requested.signature
  LOOP
    v_function := pg_catalog.to_regprocedure(v_target.signature);
    IF v_function IS NULL THEN
      RAISE EXCEPTION 'rerank ACL target is missing: %', v_target.signature;
    END IF;

    SELECT function_row.proowner
    INTO STRICT v_owner
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function;

    FOR v_grantee IN
      SELECT DISTINCT acl_row.grantee
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_row
      WHERE function_row.oid = v_function
        AND acl_row.grantee <> v_owner
      ORDER BY acl_row.grantee
    LOOP
      IF v_grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE',
          v_target.signature
        );
      ELSE
        SELECT role_row.rolname
        INTO STRICT v_grantee_name
        FROM pg_catalog.pg_roles AS role_row
        WHERE role_row.oid = v_grantee;

        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
          v_target.signature,
          v_grantee_name
        );
      END IF;
    END LOOP;
  END LOOP;
END
$close_acl$;

REVOKE ALL ON FUNCTION public.rerank_public_eligible_leaderboard(text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.rerank_public_eligible_leaderboard(text)
  TO service_role;

COMMENT ON FUNCTION public.rerank_public_eligible_leaderboard(text) IS
  'Service-only atomic rerank for the active, full-evidence public cohort; all ineligible season rows receive rank NULL and legacy movement is withheld until a generation-aware baseline exists.';

DO $postflight$
DECLARE
  v_service_role oid := pg_catalog.to_regrole('service_role');
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM (
      VALUES
        (
          pg_catalog.to_regprocedure(
            'public.rerank_public_eligible_leaderboard(text)'
          )
        )
    ) AS target(function_oid)
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = target.function_oid
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.prokind = 'f'
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prosecdef
      AND NOT function_row.proretset
      AND function_row.prorettype = 'pg_catalog.int4'::pg_catalog.regtype
      AND function_row.pronargs = 1
      AND function_row.proargtypes =
        ARRAY['pg_catalog.text'::pg_catalog.regtype]::pg_catalog.oidvector
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=10s'
      ]::pg_catalog.text[]
      AND language_row.lanname = 'plpgsql'
  ) <> 1 THEN
    RAISE EXCEPTION 'rerank function catalog postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          pg_catalog.to_regprocedure(
            'public.rerank_public_eligible_leaderboard(text)'
          )
        )
    ) AS target(function_oid)
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = target.function_oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_row
    WHERE acl_row.privilege_type = 'EXECUTE'
      AND acl_row.grantee <> function_row.proowner
      AND acl_row.grantee <> v_service_role
  ) OR (
    SELECT pg_catalog.count(*)
    FROM (
      VALUES
        (
          pg_catalog.to_regprocedure(
            'public.rerank_public_eligible_leaderboard(text)'
          )
        )
    ) AS target(function_oid)
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = target.function_oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_row
    WHERE acl_row.privilege_type = 'EXECUTE'
      AND acl_row.grantee = v_service_role
      AND NOT acl_row.is_grantable
  ) <> 1
     OR pg_catalog.has_function_privilege(
          'anon',
          'public.rerank_public_eligible_leaderboard(text)',
          'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'authenticated',
          'public.rerank_public_eligible_leaderboard(text)',
          'EXECUTE'
        ) THEN
    RAISE EXCEPTION 'rerank function execution boundary postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
