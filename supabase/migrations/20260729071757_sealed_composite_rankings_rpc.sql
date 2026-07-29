-- Exact 7D/30D/90D composite ranking read over caller-proved publications.
--
-- The application double-proves all three complete dynamic authorities around
-- this single-statement snapshot. This RPC additionally binds every season to
-- its exact publication UUID and rejects a source array that differs from the
-- immutable publication receipt. Only the server-side service role may call it.
--
-- Forward compensation: revoke and drop only
-- public.arena_read_composite_rankings_v1 with the exact signature below.
-- This migration writes no application data, so PITR is not required.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.leaderboard_ranks') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_rank_publications') IS NULL THEN
    RAISE EXCEPTION
      'sealed leaderboard ranks and publication receipts must exist';
  END IF;
  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'required PostgREST roles must exist';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.arena_read_composite_rankings_v1(
  p_7d_cohort_id uuid,
  p_30d_cohort_id uuid,
  p_90d_cohort_id uuid,
  p_7d_sources text[],
  p_30d_sources text[],
  p_90d_sources text[],
  p_scope_sources text[],
  p_limit integer,
  p_offset integer,
  p_sort_by text,
  p_sort_dir text,
  p_min_pnl numeric,
  p_min_trades bigint,
  p_trader_type text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_receipt_sources text[];
  v_all_authority_sources text[];
  v_duplicate_season text;
  v_duplicate_source text;
  v_duplicate_identity text;
BEGIN
  IF p_7d_cohort_id IS NULL
     OR p_30d_cohort_id IS NULL
     OR p_90d_cohort_id IS NULL THEN
    RAISE EXCEPTION 'all composite publication cohort ids are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500
     OR p_offset IS NULL OR p_offset < 0 OR p_offset > 1000000 THEN
    RAISE EXCEPTION 'invalid composite pagination'
      USING ERRCODE = '22023';
  END IF;
  IF p_sort_by IS NULL OR p_sort_by NOT IN (
    'arena_score',
    'roi',
    'pnl',
    'drawdown',
    'copiers',
    'win_rate',
    'sharpe_ratio',
    'trades_count'
  ) OR p_sort_dir IS NULL OR p_sort_dir NOT IN ('asc', 'desc') THEN
    RAISE EXCEPTION 'invalid composite sort'
      USING ERRCODE = '22023';
  END IF;
  IF p_min_pnl::text IN ('NaN', 'Infinity', '-Infinity')
     OR (p_min_trades IS NOT NULL AND p_min_trades < 0)
     OR (
       p_trader_type IS NOT NULL
       AND p_trader_type NOT IN ('human', 'bot', 'suspected_bot')
     ) THEN
    RAISE EXCEPTION 'invalid composite result filter'
      USING ERRCODE = '22023';
  END IF;

  IF p_7d_sources IS NULL
     OR pg_catalog.cardinality(p_7d_sources) < 1
     OR pg_catalog.cardinality(p_7d_sources) > 256
     OR p_30d_sources IS NULL
     OR pg_catalog.cardinality(p_30d_sources) < 1
     OR pg_catalog.cardinality(p_30d_sources) > 256
     OR p_90d_sources IS NULL
     OR pg_catalog.cardinality(p_90d_sources) < 1
     OR pg_catalog.cardinality(p_90d_sources) > 256
     OR p_scope_sources IS NULL
     OR pg_catalog.cardinality(p_scope_sources) > 256 THEN
    RAISE EXCEPTION 'invalid composite source bounds'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      p_7d_sources || p_30d_sources || p_90d_sources || p_scope_sources
    ) AS source_row(source)
    WHERE source_row.source IS NULL
       OR source_row.source !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
  ) OR (
    SELECT pg_catalog.count(DISTINCT source_row.source)
    FROM pg_catalog.unnest(p_7d_sources) AS source_row(source)
  ) <> pg_catalog.cardinality(p_7d_sources)
     OR (
       SELECT pg_catalog.count(DISTINCT source_row.source)
       FROM pg_catalog.unnest(p_30d_sources) AS source_row(source)
     ) <> pg_catalog.cardinality(p_30d_sources)
     OR (
       SELECT pg_catalog.count(DISTINCT source_row.source)
       FROM pg_catalog.unnest(p_90d_sources) AS source_row(source)
     ) <> pg_catalog.cardinality(p_90d_sources)
     OR (
       SELECT pg_catalog.count(DISTINCT source_row.source)
       FROM pg_catalog.unnest(p_scope_sources) AS source_row(source)
     ) <> pg_catalog.cardinality(p_scope_sources) THEN
    RAISE EXCEPTION 'composite sources are invalid or duplicated'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(
           receipt_proof.proof->>'source'
           ORDER BY receipt_proof.proof->>'source' COLLATE "C"
         )
  INTO v_receipt_sources
  FROM arena.leaderboard_rank_publications AS publication
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(publication.proofs)
    AS receipt_proof(proof)
  WHERE publication.id = p_7d_cohort_id
    AND publication.season_id = '7D';
  IF v_receipt_sources IS NULL OR v_receipt_sources <> p_7d_sources THEN
    RAISE EXCEPTION '7D composite authority differs from its publication receipt'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(
           receipt_proof.proof->>'source'
           ORDER BY receipt_proof.proof->>'source' COLLATE "C"
         )
  INTO v_receipt_sources
  FROM arena.leaderboard_rank_publications AS publication
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(publication.proofs)
    AS receipt_proof(proof)
  WHERE publication.id = p_30d_cohort_id
    AND publication.season_id = '30D';
  IF v_receipt_sources IS NULL OR v_receipt_sources <> p_30d_sources THEN
    RAISE EXCEPTION '30D composite authority differs from its publication receipt'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(
           receipt_proof.proof->>'source'
           ORDER BY receipt_proof.proof->>'source' COLLATE "C"
         )
  INTO v_receipt_sources
  FROM arena.leaderboard_rank_publications AS publication
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(publication.proofs)
    AS receipt_proof(proof)
  WHERE publication.id = p_90d_cohort_id
    AND publication.season_id = '90D';
  IF v_receipt_sources IS NULL OR v_receipt_sources <> p_90d_sources THEN
    RAISE EXCEPTION '90D composite authority differs from its publication receipt'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(DISTINCT authority_source ORDER BY authority_source)
  INTO v_all_authority_sources
  FROM pg_catalog.unnest(
    p_7d_sources || p_30d_sources || p_90d_sources
  ) AS authority(authority_source);
  IF NOT p_scope_sources <@ v_all_authority_sources THEN
    RAISE EXCEPTION 'composite result scope exceeds the sealed authority'
      USING ERRCODE = '22023';
  END IF;

  -- A wallet address is one public identity regardless of hexadecimal case.
  -- The physical uniqueness constraint is byte-sensitive, so a corrupted or
  -- privileged publication can otherwise seal both 0xAbC and 0xabc. Never
  -- reinterpret such an immutable receipt by silently selecting one score.
  SELECT
    duplicate_identity.season_id,
    duplicate_identity.source,
    duplicate_identity.identity_key
  INTO
    v_duplicate_season,
    v_duplicate_source,
    v_duplicate_identity
  FROM (
    SELECT
      receipt_identity.season_id,
      receipt_identity.source,
      receipt_identity.identity_key
    FROM (
      SELECT
        ranks.season_id,
        ranks.source COLLATE "C" AS source,
        CASE
          WHEN ranks.source_trader_id LIKE '0x%'
            THEN pg_catalog.lower(ranks.source_trader_id)
          ELSE ranks.source_trader_id
        END COLLATE "C" AS identity_key
      FROM public.leaderboard_ranks AS ranks
      WHERE ranks.season_id = '7D'
        AND ranks.rank_publication_id = p_7d_cohort_id
        AND ranks.source = ANY (p_7d_sources)
        AND ranks.arena_score > 0
        AND ranks.roi BETWEEN -50000 AND 50000
        AND (ranks.is_outlier IS NULL OR ranks.is_outlier = false)

      UNION ALL

      SELECT
        ranks.season_id,
        ranks.source COLLATE "C",
        CASE
          WHEN ranks.source_trader_id LIKE '0x%'
            THEN pg_catalog.lower(ranks.source_trader_id)
          ELSE ranks.source_trader_id
        END COLLATE "C"
      FROM public.leaderboard_ranks AS ranks
      WHERE ranks.season_id = '30D'
        AND ranks.rank_publication_id = p_30d_cohort_id
        AND ranks.source = ANY (p_30d_sources)
        AND ranks.arena_score > 0
        AND ranks.roi BETWEEN -50000 AND 50000
        AND (ranks.is_outlier IS NULL OR ranks.is_outlier = false)

      UNION ALL

      SELECT
        ranks.season_id,
        ranks.source COLLATE "C",
        CASE
          WHEN ranks.source_trader_id LIKE '0x%'
            THEN pg_catalog.lower(ranks.source_trader_id)
          ELSE ranks.source_trader_id
        END COLLATE "C"
      FROM public.leaderboard_ranks AS ranks
      WHERE ranks.season_id = '90D'
        AND ranks.rank_publication_id = p_90d_cohort_id
        AND ranks.source = ANY (p_90d_sources)
        AND ranks.arena_score > 0
        AND ranks.roi BETWEEN -50000 AND 50000
        AND (ranks.is_outlier IS NULL OR ranks.is_outlier = false)
    ) AS receipt_identity
    GROUP BY
      receipt_identity.season_id,
      receipt_identity.source,
      receipt_identity.identity_key
    HAVING pg_catalog.count(*) > 1
  ) AS duplicate_identity
  ORDER BY
    duplicate_identity.season_id COLLATE "C",
    duplicate_identity.source COLLATE "C",
    duplicate_identity.identity_key COLLATE "C"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'sealed composite publication contains duplicate canonical identity: season=%, source=%, identity=%',
      v_duplicate_season,
      v_duplicate_source,
      v_duplicate_identity
      USING ERRCODE = '22000';
  END IF;

  RETURN (
    -- Keep every population-wide phase narrow. The old implementation carried
    -- more than thirty display columns through repeated MATERIALIZED window
    -- sorts and joined two unindexed CTEs. Only the selected page is allowed to
    -- rejoin the wide physical row.
    WITH season_scores AS MATERIALIZED (
      SELECT
        ranks.id,
        ranks.season_id,
        ranks.source COLLATE "C" AS source,
        CASE
          WHEN ranks.source_trader_id LIKE '0x%'
            THEN pg_catalog.lower(ranks.source_trader_id)
          ELSE ranks.source_trader_id
        END COLLATE "C" AS identity_key,
        LEAST(ranks.arena_score, 100::numeric) AS season_score
      FROM public.leaderboard_ranks AS ranks
      WHERE ranks.season_id = '7D'
        AND ranks.rank_publication_id = p_7d_cohort_id
        AND ranks.source = ANY (p_7d_sources)
        AND ranks.source = ANY (p_scope_sources)
        AND ranks.arena_score > 0
        AND ranks.roi BETWEEN -50000 AND 50000
        AND (ranks.is_outlier IS NULL OR ranks.is_outlier = false)

      UNION ALL

      SELECT
        ranks.id,
        ranks.season_id,
        ranks.source COLLATE "C",
        CASE
          WHEN ranks.source_trader_id LIKE '0x%'
            THEN pg_catalog.lower(ranks.source_trader_id)
          ELSE ranks.source_trader_id
        END COLLATE "C",
        LEAST(ranks.arena_score, 100::numeric)
      FROM public.leaderboard_ranks AS ranks
      WHERE ranks.season_id = '30D'
        AND ranks.rank_publication_id = p_30d_cohort_id
        AND ranks.source = ANY (p_30d_sources)
        AND ranks.source = ANY (p_scope_sources)
        AND ranks.arena_score > 0
        AND ranks.roi BETWEEN -50000 AND 50000
        AND (ranks.is_outlier IS NULL OR ranks.is_outlier = false)

      UNION ALL

      SELECT
        ranks.id,
        ranks.season_id,
        ranks.source COLLATE "C",
        CASE
          WHEN ranks.source_trader_id LIKE '0x%'
            THEN pg_catalog.lower(ranks.source_trader_id)
          ELSE ranks.source_trader_id
        END COLLATE "C",
        LEAST(ranks.arena_score, 100::numeric)
      FROM public.leaderboard_ranks AS ranks
      WHERE ranks.season_id = '90D'
        AND ranks.rank_publication_id = p_90d_cohort_id
        AND ranks.source = ANY (p_90d_sources)
        AND ranks.source = ANY (p_scope_sources)
        AND ranks.arena_score > 0
        AND ranks.roi BETWEEN -50000 AND 50000
        AND (ranks.is_outlier IS NULL OR ranks.is_outlier = false)
    ),
    identity_scores AS MATERIALIZED (
      SELECT
        source,
        identity_key,
        COALESCE(
          pg_catalog.max(id) FILTER (WHERE season_id = '90D'),
          pg_catalog.max(id) FILTER (WHERE season_id = '30D'),
          pg_catalog.max(id) FILTER (WHERE season_id = '7D')
        ) AS primary_id,
        CASE
          WHEN pg_catalog.count(*) FILTER (WHERE season_id = '90D') = 1 THEN '90D'
          WHEN pg_catalog.count(*) FILTER (WHERE season_id = '30D') = 1 THEN '30D'
          ELSE '7D'
        END AS primary_season,
        pg_catalog.max(season_score) FILTER (WHERE season_id = '7D') AS score_7d,
        pg_catalog.max(season_score) FILTER (WHERE season_id = '30D') AS score_30d,
        pg_catalog.max(season_score) FILTER (WHERE season_id = '90D') AS score_90d
      FROM season_scores
      GROUP BY source, identity_key
    ),
    composite_scores AS MATERIALIZED (
      SELECT
        identity_scores.*,
        GREATEST(
          0::numeric,
          LEAST(
            100::numeric,
            (
              COALESCE(score_7d * 0.05, 0)
              + COALESCE(score_30d * 0.25, 0)
              + COALESCE(score_90d * 0.70, 0)
            ) / NULLIF(
              CASE WHEN score_7d IS NULL THEN 0 ELSE 0.05 END
              + CASE WHEN score_30d IS NULL THEN 0 ELSE 0.25 END
              + CASE WHEN score_90d IS NULL THEN 0 ELSE 0.70 END,
              0
            )
          )
        ) AS unrounded_score
      FROM identity_scores
    ),
    ranked_keys AS MATERIALIZED (
      SELECT
        composite_scores.*,
        pg_catalog.round(composite_scores.unrounded_score, 1) AS composite_score,
        pg_catalog.row_number() OVER (
          ORDER BY
            composite_scores.unrounded_score DESC,
            composite_scores.source COLLATE "C",
            composite_scores.identity_key COLLATE "C"
        ) AS composite_rank
      FROM composite_scores
    ),
    filtered_keys AS MATERIALIZED (
      SELECT
        ranked_keys.*,
        primary_rank.roi,
        primary_rank.pnl,
        primary_rank.max_drawdown,
        primary_rank.copiers,
        primary_rank.win_rate,
        primary_rank.sharpe_ratio,
        primary_rank.trades_count,
        primary_rank.trader_type
      FROM ranked_keys
      JOIN public.leaderboard_ranks AS primary_rank
        ON primary_rank.id = ranked_keys.primary_id
       AND primary_rank.season_id = ranked_keys.primary_season
       AND primary_rank.source = ranked_keys.source
       AND primary_rank.rank_publication_id = CASE ranked_keys.primary_season
         WHEN '90D' THEN p_90d_cohort_id
         WHEN '30D' THEN p_30d_cohort_id
         ELSE p_7d_cohort_id
       END
      WHERE (p_min_pnl IS NULL OR primary_rank.pnl >= p_min_pnl)
        AND (p_min_trades IS NULL OR primary_rank.trades_count >= p_min_trades)
        AND (
          p_trader_type IS NULL
          OR (
            p_trader_type = 'bot'
            AND (
              primary_rank.source = 'web3_bot'
              OR primary_rank.trader_type IN ('bot', 'suspected_bot')
            )
          )
          OR (
            p_trader_type = 'suspected_bot'
            AND primary_rank.trader_type = 'suspected_bot'
          )
          OR (
            p_trader_type = 'human'
            AND primary_rank.source <> 'web3_bot'
            AND (
              primary_rank.trader_type IS NULL
              OR primary_rank.trader_type = 'human'
            )
          )
        )
    ),
    ordered_keys AS MATERIALIZED (
      SELECT
        filtered_keys.*,
        pg_catalog.row_number() OVER (
          ORDER BY
            CASE
              WHEN p_sort_by = 'arena_score' AND p_sort_dir = 'asc'
                THEN composite_score
            END ASC NULLS LAST,
            CASE
              WHEN p_sort_by = 'arena_score' AND p_sort_dir = 'desc'
                THEN composite_score
            END DESC NULLS LAST,
            CASE WHEN p_sort_by = 'roi' AND p_sort_dir = 'asc' THEN roi END
              ASC NULLS LAST,
            CASE WHEN p_sort_by = 'roi' AND p_sort_dir = 'desc' THEN roi END
              DESC NULLS LAST,
            CASE WHEN p_sort_by = 'pnl' AND p_sort_dir = 'asc' THEN pnl END
              ASC NULLS LAST,
            CASE WHEN p_sort_by = 'pnl' AND p_sort_dir = 'desc' THEN pnl END
              DESC NULLS LAST,
            CASE
              WHEN p_sort_by = 'drawdown' AND p_sort_dir = 'asc'
                THEN max_drawdown
            END ASC NULLS LAST,
            CASE
              WHEN p_sort_by = 'drawdown' AND p_sort_dir = 'desc'
                THEN max_drawdown
            END DESC NULLS LAST,
            CASE WHEN p_sort_by = 'copiers' AND p_sort_dir = 'asc' THEN copiers END
              ASC NULLS LAST,
            CASE WHEN p_sort_by = 'copiers' AND p_sort_dir = 'desc' THEN copiers END
              DESC NULLS LAST,
            CASE
              WHEN p_sort_by = 'win_rate' AND p_sort_dir = 'asc'
                THEN win_rate
            END ASC NULLS LAST,
            CASE
              WHEN p_sort_by = 'win_rate' AND p_sort_dir = 'desc'
                THEN win_rate
            END DESC NULLS LAST,
            CASE
              WHEN p_sort_by = 'sharpe_ratio' AND p_sort_dir = 'asc'
                THEN sharpe_ratio
            END ASC NULLS LAST,
            CASE
              WHEN p_sort_by = 'sharpe_ratio' AND p_sort_dir = 'desc'
                THEN sharpe_ratio
            END DESC NULLS LAST,
            CASE
              WHEN p_sort_by = 'trades_count' AND p_sort_dir = 'asc'
                THEN trades_count
            END ASC NULLS LAST,
            CASE
              WHEN p_sort_by = 'trades_count' AND p_sort_dir = 'desc'
                THEN trades_count
            END DESC NULLS LAST,
            composite_rank
        ) AS response_order
      FROM filtered_keys
    ),
    page_keys AS MATERIALIZED (
      SELECT *
      FROM ordered_keys
      ORDER BY response_order
      OFFSET p_offset
      LIMIT p_limit
    ),
    page AS MATERIALIZED (
      SELECT
        page_keys.response_order,
        page_keys.score_7d,
        page_keys.score_30d,
        page_keys.score_90d,
        page_keys.composite_score,
        page_keys.composite_rank,
        primary_rank.*
      FROM page_keys
      JOIN public.leaderboard_ranks AS primary_rank
        ON primary_rank.id = page_keys.primary_id
       AND primary_rank.season_id = page_keys.primary_season
       AND primary_rank.source = page_keys.source
    )
    SELECT pg_catalog.jsonb_build_object(
      'contract', 'sealed-composite-rankings-rpc@1',
      'total_count', (SELECT pg_catalog.count(*) FROM filtered_keys),
      'rows', COALESCE(
        (
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'source', page.source,
              'source_trader_id', page.source_trader_id,
              'handle', page.handle,
              'source_type', page.source_type,
              'roi', page.roi,
              'pnl', page.pnl,
              'win_rate', page.win_rate,
              'max_drawdown', page.max_drawdown,
              'trades_count', page.trades_count,
              'followers', page.followers,
              'copiers', page.copiers,
              'avatar_url', page.avatar_url,
              'computed_at', page.computed_at,
              'profitability_score', page.profitability_score,
              'risk_control_score', page.risk_control_score,
              'execution_score', page.execution_score,
              'score_completeness', page.score_completeness,
              'trading_style', page.trading_style,
              'avg_holding_hours', page.avg_holding_hours,
              'sharpe_ratio', page.sharpe_ratio,
              'sortino_ratio', page.sortino_ratio,
              'calmar_ratio', page.calmar_ratio,
              'profit_factor', page.profit_factor,
              'trader_type', page.trader_type,
              'primary_season', page.season_id,
              'primary_publication_id', page.rank_publication_id,
              'score_7d', page.score_7d,
              'score_30d', page.score_30d,
              'score_90d', page.score_90d,
              'composite_score', page.composite_score,
              'composite_rank', page.composite_rank
            )
            ORDER BY page.response_order
          )
          FROM page
        ),
        '[]'::jsonb
      )
    )
  );
END;
$function$;

ALTER FUNCTION public.arena_read_composite_rankings_v1(
  uuid,
  uuid,
  uuid,
  text[],
  text[],
  text[],
  text[],
  integer,
  integer,
  text,
  text,
  numeric,
  bigint,
  text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.arena_read_composite_rankings_v1(
  uuid,
  uuid,
  uuid,
  text[],
  text[],
  text[],
  text[],
  integer,
  integer,
  text,
  text,
  numeric,
  bigint,
  text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_read_composite_rankings_v1(
  uuid,
  uuid,
  uuid,
  text[],
  text[],
  text[],
  text[],
  integer,
  integer,
  text,
  text,
  numeric,
  bigint,
  text
) TO service_role;

COMMENT ON FUNCTION public.arena_read_composite_rankings_v1(
  uuid,
  uuid,
  uuid,
  text[],
  text[],
  text[],
  text[],
  integer,
  integer,
  text,
  text,
  numeric,
  bigint,
  text
) IS
  'Server-only exact 7D/30D/90D composite page bound to three sealed publication receipts.';

COMMIT;
