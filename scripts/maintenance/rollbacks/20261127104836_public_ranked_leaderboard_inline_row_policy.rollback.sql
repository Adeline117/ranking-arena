-- Rollback of 20261127104836_public_ranked_leaderboard_inline_row_policy.sql.
-- Not a migration: kept beside the launch runner for the release owner.
--
-- Restores, verbatim, the 20261122201611 body of
-- arena.leaderboard_rank_row_is_public_eligible and the 20261124114140 view
-- (which calls the SECURITY DEFINER wrapper per row again). The view returns
-- the same rows either way; only the per-row cost returns. The inlinable
-- function arena.leaderboard_rank_row_is_public_eligible_expr is left in
-- place (nothing calls it after this; removing it is a separate decision).
-- Refuses unless 20261127104836 is the installed state.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF (
       SELECT pg_catalog.encode(
                pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')), 'hex')
         FROM pg_catalog.pg_proc AS procedure_row
        WHERE procedure_row.oid = pg_catalog.to_regprocedure(
          'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamp with time zone)')
     ) IS DISTINCT FROM 'daa18d7cd487b15e247ba9e300d770f14ff18d5b15ef0d5e3362173b2cb7e4ba'
     OR pg_catalog.strpos(
          pg_catalog.pg_get_viewdef('public.public_ranked_leaderboard'::pg_catalog.regclass),
          'leaderboard_rank_row_is_public_eligible_expr(') = 0 THEN
    RAISE EXCEPTION '20261127104836 is not the installed state; refusing to roll it back';
  END IF;
END
$preflight$;

-- 20261122201611, verbatim.
CREATE OR REPLACE FUNCTION arena.leaderboard_rank_row_is_public_eligible(
  p_rank public.leaderboard_ranks,
  p_observed_at timestamptz
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(
    (p_rank).source ~ '^[a-z0-9]+(_[a-z0-9]+)*$'
    AND (p_rank).source = pg_catalog.lower(pg_catalog.btrim((p_rank).source))
    AND pg_catalog.btrim((p_rank).source_trader_id) <> ''
    AND (p_rank).source_trader_id = pg_catalog.btrim((p_rank).source_trader_id)
    AND (p_rank).score_completeness IS NOT DISTINCT FROM (
      CASE
        WHEN (p_rank).win_rate IS NOT NULL AND (p_rank).max_drawdown IS NOT NULL
          THEN 'full'
        WHEN (p_rank).win_rate IS NULL AND (p_rank).max_drawdown IS NULL
          THEN 'minimal'
        ELSE 'partial'
      END
    )
    AND (p_rank).metrics_estimated IS NOT DISTINCT FROM false
    AND (p_rank).is_outlier IS NOT TRUE
    AND (p_rank).arena_score IS NOT NULL
    AND (p_rank).arena_score > 0
    AND (p_rank).arena_score <= 100
    AND (p_rank).roi IS NOT NULL
    AND (p_rank).roi >= -10000
    AND (p_rank).roi <= 10000
    AND (p_rank).pnl IS NOT NULL
    AND (p_rank).pnl >= -100000000
    AND (p_rank).pnl <= 1000000000
    AND (
      (p_rank).win_rate IS NULL
      OR ((p_rank).win_rate >= 0 AND (p_rank).win_rate <= 100)
    )
    AND (
      (p_rank).max_drawdown IS NULL
      OR ((p_rank).max_drawdown >= 0 AND (p_rank).max_drawdown < 100)
    )
    AND (p_rank).computed_at IS NOT NULL
    AND (p_rank).computed_at >= p_observed_at - interval '48 hours'
    AND (p_rank).computed_at <= p_observed_at + interval '5 minutes',
    false
  );
$function$;

-- 20261124114140, verbatim.
CREATE OR REPLACE VIEW public.public_ranked_leaderboard
WITH (security_barrier = true, security_invoker = false)
AS
WITH observed AS MATERIALIZED (
  SELECT pg_catalog.statement_timestamp() AS observed_at
),
served_sources AS MATERIALIZED (
  SELECT served.season_id, served.source
  FROM observed
  CROSS JOIN LATERAL arena.public_ranked_leaderboard_served_sources(
    observed.observed_at
  ) AS served
)
SELECT
  rank_row.id,
  rank_row.season_id,
  rank_row.source,
  rank_row.source_type,
  rank_row.source_trader_id,
  rank_row.rank,
  rank_row.arena_score,
  rank_row.arena_score_v3,
  rank_row.arena_score_v4,
  rank_row.roi,
  rank_row.pnl,
  rank_row.win_rate,
  rank_row.max_drawdown,
  rank_row.followers,
  rank_row.copiers,
  rank_row.trades_count,
  rank_row.handle,
  rank_row.avatar_url,
  rank_row.computed_at,
  rank_row.profitability_score,
  rank_row.risk_control_score,
  rank_row.execution_score,
  rank_row.score_completeness,
  rank_row.trading_style,
  rank_row.avg_holding_hours,
  rank_row.style_confidence,
  rank_row.sharpe_ratio,
  rank_row.sortino_ratio,
  rank_row.profit_factor,
  rank_row.calmar_ratio,
  rank_row.trader_type,
  rank_row.is_outlier,
  rank_row.metrics_estimated,
  rank_row.rank_change,
  rank_row.is_new,
  COALESCE(
    (rank_row.score_factors -> 'idle_window') = 'true'::pg_catalog.jsonb,
    false
  ) AS idle_window,
  COALESCE(
    (rank_row.score_factors -> 'mdd_contradiction') = 'true'::pg_catalog.jsonb,
    false
  ) AS mdd_contradiction
FROM public.leaderboard_ranks AS rank_row
JOIN served_sources AS served
  ON served.season_id = rank_row.season_id
 AND served.source = rank_row.source
JOIN ONLY arena.public_ranked_leaderboard_serving_heads AS head
  ON head.season_id = rank_row.season_id
 AND head.score_cohort_id = rank_row.rank_publication_id
JOIN ONLY arena.public_ranked_leaderboard_serving_sources AS source_witness
  ON source_witness.season_id = rank_row.season_id
 AND source_witness.source = rank_row.source
 AND source_witness.score_cohort_id = rank_row.rank_publication_id
CROSS JOIN observed
WHERE rank_row.rank IS NOT NULL
  AND arena.public_ranked_leaderboard_row_is_eligible(
    rank_row,
    observed.observed_at
  );

ALTER VIEW public.public_ranked_leaderboard OWNER TO postgres;

DO $postflight$
BEGIN
  IF (
       SELECT pg_catalog.encode(
                pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')), 'hex')
         FROM pg_catalog.pg_proc AS procedure_row
        WHERE procedure_row.oid = pg_catalog.to_regprocedure(
          'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamp with time zone)')
     ) IS DISTINCT FROM '1a9fd63c3a986c44bc8cc39a25d4e1962b2f09b34c89cabdc63eba2567601429' THEN
    RAISE EXCEPTION 'the policy body is not the 20261122201611 body after the rollback';
  END IF;
END
$postflight$;

COMMIT;
