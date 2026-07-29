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
SET statement_timeout = '25s'
AS $function$
DECLARE
  v_receipt_sources text[];
  v_all_authority_sources text[];
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

  RETURN (
    WITH season_rows AS MATERIALIZED (
      SELECT
        ranks.id,
        ranks.season_id,
        ranks.source,
        CASE
          WHEN ranks.source_trader_id LIKE '0x%'
            THEN pg_catalog.lower(ranks.source_trader_id)
          ELSE ranks.source_trader_id
        END AS identity_key,
        ranks.source_trader_id,
        ranks.handle,
        ranks.source_type,
        ranks.roi,
        ranks.pnl,
        ranks.win_rate,
        ranks.max_drawdown,
        ranks.trades_count,
        ranks.followers,
        ranks.copiers,
        LEAST(ranks.arena_score, 100::numeric) AS season_score,
        ranks.avatar_url,
        ranks.computed_at,
        ranks.profitability_score,
        ranks.risk_control_score,
        ranks.execution_score,
        ranks.score_completeness,
        ranks.trading_style,
        ranks.avg_holding_hours,
        ranks.sharpe_ratio,
        ranks.sortino_ratio,
        ranks.calmar_ratio,
        ranks.profit_factor,
        ranks.trader_type,
        ranks.rank_publication_id
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
        ranks.source,
        CASE
          WHEN ranks.source_trader_id LIKE '0x%'
            THEN pg_catalog.lower(ranks.source_trader_id)
          ELSE ranks.source_trader_id
        END,
        ranks.source_trader_id,
        ranks.handle,
        ranks.source_type,
        ranks.roi,
        ranks.pnl,
        ranks.win_rate,
        ranks.max_drawdown,
        ranks.trades_count,
        ranks.followers,
        ranks.copiers,
        LEAST(ranks.arena_score, 100::numeric),
        ranks.avatar_url,
        ranks.computed_at,
        ranks.profitability_score,
        ranks.risk_control_score,
        ranks.execution_score,
        ranks.score_completeness,
        ranks.trading_style,
        ranks.avg_holding_hours,
        ranks.sharpe_ratio,
        ranks.sortino_ratio,
        ranks.calmar_ratio,
        ranks.profit_factor,
        ranks.trader_type,
        ranks.rank_publication_id
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
        ranks.source,
        CASE
          WHEN ranks.source_trader_id LIKE '0x%'
            THEN pg_catalog.lower(ranks.source_trader_id)
          ELSE ranks.source_trader_id
        END,
        ranks.source_trader_id,
        ranks.handle,
        ranks.source_type,
        ranks.roi,
        ranks.pnl,
        ranks.win_rate,
        ranks.max_drawdown,
        ranks.trades_count,
        ranks.followers,
        ranks.copiers,
        LEAST(ranks.arena_score, 100::numeric),
        ranks.avatar_url,
        ranks.computed_at,
        ranks.profitability_score,
        ranks.risk_control_score,
        ranks.execution_score,
        ranks.score_completeness,
        ranks.trading_style,
        ranks.avg_holding_hours,
        ranks.sharpe_ratio,
        ranks.sortino_ratio,
        ranks.calmar_ratio,
        ranks.profit_factor,
        ranks.trader_type,
        ranks.rank_publication_id
      FROM public.leaderboard_ranks AS ranks
      WHERE ranks.season_id = '90D'
        AND ranks.rank_publication_id = p_90d_cohort_id
        AND ranks.source = ANY (p_90d_sources)
        AND ranks.source = ANY (p_scope_sources)
        AND ranks.arena_score > 0
        AND ranks.roi BETWEEN -50000 AND 50000
        AND (ranks.is_outlier IS NULL OR ranks.is_outlier = false)
    ),
    canonical_season_rows AS MATERIALIZED (
      SELECT deduplicated.*
      FROM (
        SELECT
          season_rows.*,
          pg_catalog.row_number() OVER (
            PARTITION BY season_id, source, identity_key
            ORDER BY season_score DESC, id
          ) AS identity_copy
        FROM season_rows
      ) AS deduplicated
      WHERE deduplicated.identity_copy = 1
    ),
    score_pivot AS MATERIALIZED (
      SELECT
        source,
        identity_key,
        pg_catalog.max(season_score) FILTER (WHERE season_id = '7D') AS score_7d,
        pg_catalog.max(season_score) FILTER (WHERE season_id = '30D') AS score_30d,
        pg_catalog.max(season_score) FILTER (WHERE season_id = '90D') AS score_90d
      FROM canonical_season_rows
      GROUP BY source, identity_key
    ),
    composite_scores AS MATERIALIZED (
      SELECT
        score_pivot.*,
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
        ) AS composite_score
      FROM score_pivot
    ),
    primary_rows AS MATERIALIZED (
      SELECT ranked_primary.*
      FROM (
        SELECT
          canonical_season_rows.*,
          pg_catalog.row_number() OVER (
            PARTITION BY source, identity_key
            ORDER BY
              CASE season_id WHEN '90D' THEN 1 WHEN '30D' THEN 2 ELSE 3 END,
              id
          ) AS primary_order
        FROM canonical_season_rows
      ) AS ranked_primary
      WHERE ranked_primary.primary_order = 1
    ),
    ranked AS MATERIALIZED (
      SELECT
        primary_rows.*,
        composite_scores.score_7d,
        composite_scores.score_30d,
        composite_scores.score_90d,
        pg_catalog.round(composite_scores.composite_score, 1) AS composite_score,
        pg_catalog.row_number() OVER (
          ORDER BY
            composite_scores.composite_score DESC,
            primary_rows.source,
            primary_rows.identity_key
        ) AS composite_rank
      FROM composite_scores
      JOIN primary_rows USING (source, identity_key)
    ),
    filtered AS MATERIALIZED (
      SELECT *
      FROM ranked
      WHERE (p_min_pnl IS NULL OR ranked.pnl >= p_min_pnl)
        AND (p_min_trades IS NULL OR ranked.trades_count >= p_min_trades)
        AND (
          p_trader_type IS NULL
          OR (
            p_trader_type = 'bot'
            AND (
              ranked.source = 'web3_bot'
              OR ranked.trader_type IN ('bot', 'suspected_bot')
            )
          )
          OR (
            p_trader_type = 'suspected_bot'
            AND ranked.trader_type = 'suspected_bot'
          )
          OR (
            p_trader_type = 'human'
            AND ranked.source <> 'web3_bot'
            AND (ranked.trader_type IS NULL OR ranked.trader_type = 'human')
          )
        )
    ),
    ordered AS MATERIALIZED (
      SELECT
        filtered.*,
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
      FROM filtered
    ),
    page AS MATERIALIZED (
      SELECT *
      FROM ordered
      ORDER BY response_order
      OFFSET p_offset
      LIMIT p_limit
    )
    SELECT pg_catalog.jsonb_build_object(
      'contract', 'sealed-composite-rankings-rpc@1',
      'total_count', (SELECT pg_catalog.count(*) FROM filtered),
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
