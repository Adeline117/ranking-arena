-- Migration: 20261127104836_public_ranked_leaderboard_inline_row_policy.sql
-- Description: the public leaderboard view evaluates the row policy inline
--   instead of through two per-row function calls.
--
-- Why: on 2026-11-27 /api/traders took 5.9-6.7 s and the three seasons
--   returned 500 for several minutes. The page query
--     SELECT * FROM public.public_ranked_leaderboard
--      WHERE season_id = '90D' AND idle_window = false ORDER BY rank LIMIT 51
--   ran 1,439 ms and the idle count 1,264 ms: the view evaluates every row of
--   the season (11,392 for 90D) before sorting, and each evaluation is a call
--   of the SECURITY DEFINER wrapper arena.public_ranked_leaderboard_row_is_eligible
--   and, inside it, of arena.leaderboard_rank_row_is_public_eligible, which
--   carries SET search_path. Neither can be inlined, so every row pays two
--   function calls and two configuration switches. A PostgreSQL 17 replica of
--   the 90D season (14,000 rows, 9,334 served after the idle filter) takes
--   402 ms for the page; with the policy inlined it takes 20 ms, the idle count
--   14 ms, and a page at offset 6,000 the same 20 ms. The joins of the view
--   (served sources, head, witness) take under 10 ms and are not changed.
--
-- What changes:
--   * arena.leaderboard_rank_row_is_public_eligible_expr(public.leaderboard_ranks,
--     timestamptz): NEW. The current policy expression (20261122201611),
--     copied verbatim, as a SQL-standard body (parsed at creation, so it does
--     not depend on the caller's search_path), STABLE (the computed_at window
--     uses timestamptz - interval, which is STABLE; an IMMUTABLE declaration
--     would stop inlining), not STRICT (its COALESCE would stop inlining),
--     PARALLEL SAFE. EXECUTE is granted to anon, authenticated and
--     service_role: PostgreSQL inlines a function only for a caller allowed
--     to execute it. It is a pure predicate over the row the caller passes in;
--     it reads no table and reveals nothing the caller does not already hold.
--     This is a deliberate exception to "only the owner holds a privilege on
--     the policy function" (20261122201611), which still holds for
--     arena.leaderboard_rank_row_is_public_eligible itself.
--   * arena.leaderboard_rank_row_is_public_eligible: only its body, which now
--     returns the new function's result. Signature, LANGUAGE sql, IMMUTABLE,
--     PARALLEL SAFE, SET search_path, owner, ACL and comment are unchanged, so
--     rerank, seal, proofs and the serving authority keep calling it and the
--     policy has a single definition.
--   * public.public_ranked_leaderboard: the 20261124114140 body, with the
--     wrapper call replaced by the new function. Same 37 columns, options,
--     owner and grants. The wrapper's COALESCE(..., false) and STRICT add
--     nothing: the policy already returns COALESCE(..., false), and neither
--     argument can be NULL in the view.
--   No row the view returns changes: the PostgreSQL 17 proof compares the view
--   before and after within one statement, across every serving scenario of
--   the 20261124114140 proof and a policy matrix of boundary rows.
--
-- Safety: refuses unless the policy body is the 20261122201611 body (sha256
--   1a9fd63c...1429) or this migration's own (replay), its attributes are the
--   expected ones, and the view is the 37-column 20261124114140 view (it
--   still reads the served sources and the wrapper, or this migration's
--   function on replay). It adds no trigger or constraint and touches no
--   table the worker startup gate pins.
--
-- POSTDEPLOY. No application or worker release depends on it.
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
DECLARE
  v_policy record;
  v_view_definition text;
BEGIN
  SELECT
    procedure_row.oid,
    pg_catalog.pg_get_userbyid(procedure_row.proowner) AS owner,
    procedure_row.prosecdef,
    procedure_row.provolatile,
    procedure_row.proparallel,
    procedure_row.proconfig,
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')), 'hex'
    ) AS body_sha256
  INTO v_policy
  FROM pg_catalog.pg_proc AS procedure_row
  WHERE procedure_row.oid = pg_catalog.to_regprocedure(
    'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamp with time zone)'
  );
  IF v_policy.oid IS NULL THEN
    RAISE EXCEPTION 'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks, timestamptz) does not exist';
  END IF;
  IF v_policy.body_sha256 NOT IN (
    -- 20261122201611 (roi_pnl only)
    '1a9fd63c3a986c44bc8cc39a25d4e1962b2f09b34c89cabdc63eba2567601429',
    -- this migration's body (replay)
    'daa18d7cd487b15e247ba9e300d770f14ff18d5b15ef0d5e3362173b2cb7e4ba'
  ) THEN
    RAISE EXCEPTION 'unexpected body of arena.leaderboard_rank_row_is_public_eligible (sha256 %); refusing',
      v_policy.body_sha256;
  END IF;
  IF v_policy.owner IS DISTINCT FROM 'postgres'
     OR v_policy.prosecdef
     OR v_policy.provolatile <> 'i'
     OR v_policy.proparallel <> 's'
     OR v_policy.proconfig IS DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[] THEN
    RAISE EXCEPTION 'arena.leaderboard_rank_row_is_public_eligible has unexpected attributes';
  END IF;

  IF pg_catalog.to_regclass('public.public_ranked_leaderboard') IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.public_ranked_leaderboard_served_sources(timestamp with time zone)') IS NULL THEN
    RAISE EXCEPTION 'the 20261124114140 public leaderboard is required';
  END IF;
  IF (
       SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY attribute.attnum)
         FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.public_ranked_leaderboard'::pg_catalog.regclass
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
     ) IS DISTINCT FROM ARRAY[
      'id',
      'season_id',
      'source',
      'source_type',
      'source_trader_id',
      'rank',
      'arena_score',
      'arena_score_v3',
      'arena_score_v4',
      'roi',
      'pnl',
      'win_rate',
      'max_drawdown',
      'followers',
      'copiers',
      'trades_count',
      'handle',
      'avatar_url',
      'computed_at',
      'profitability_score',
      'risk_control_score',
      'execution_score',
      'score_completeness',
      'trading_style',
      'avg_holding_hours',
      'style_confidence',
      'sharpe_ratio',
      'sortino_ratio',
      'profit_factor',
      'calmar_ratio',
      'trader_type',
      'is_outlier',
      'metrics_estimated',
      'rank_change',
      'is_new',
      'idle_window',
      'mdd_contradiction'
    ]::pg_catalog.text[] THEN
    RAISE EXCEPTION 'public.public_ranked_leaderboard is not the 37-column 20261123021904 shape';
  END IF;
  v_view_definition := pg_catalog.pg_get_viewdef('public.public_ranked_leaderboard'::pg_catalog.regclass);
  IF pg_catalog.strpos(v_view_definition, 'public_ranked_leaderboard_served_sources(') = 0
     OR (pg_catalog.strpos(v_view_definition, 'public_ranked_leaderboard_row_is_eligible(') = 0
         AND pg_catalog.strpos(v_view_definition, 'leaderboard_rank_row_is_public_eligible_expr(') = 0) THEN
    RAISE EXCEPTION 'public.public_ranked_leaderboard is not the 20261124114140 view';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION arena.leaderboard_rank_row_is_public_eligible_expr(
  p_rank public.leaderboard_ranks,
  p_observed_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
RETURN COALESCE(
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

ALTER FUNCTION arena.leaderboard_rank_row_is_public_eligible_expr(
  public.leaderboard_ranks, timestamptz
) OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.leaderboard_rank_row_is_public_eligible_expr(
  public.leaderboard_ranks, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION arena.leaderboard_rank_row_is_public_eligible_expr(
  public.leaderboard_ranks, timestamptz
) TO anon, authenticated, service_role;
COMMENT ON FUNCTION arena.leaderboard_rank_row_is_public_eligible_expr(
  public.leaderboard_ranks, timestamptz
) IS 'The public rank row policy, inlinable. arena.leaderboard_rank_row_is_public_eligible returns its result.';

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
  SELECT arena.leaderboard_rank_row_is_public_eligible_expr(p_rank, p_observed_at);
$function$;

-- The 20261124114140 view; only the row policy call differs.
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
  AND arena.leaderboard_rank_row_is_public_eligible_expr(
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
     ) IS DISTINCT FROM 'daa18d7cd487b15e247ba9e300d770f14ff18d5b15ef0d5e3362173b2cb7e4ba' THEN
    RAISE EXCEPTION 'the policy body is not the reviewed one';
  END IF;
  IF (
       SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY attribute.attnum)
         FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.public_ranked_leaderboard'::pg_catalog.regclass
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
     ) IS DISTINCT FROM ARRAY[
      'id',
      'season_id',
      'source',
      'source_type',
      'source_trader_id',
      'rank',
      'arena_score',
      'arena_score_v3',
      'arena_score_v4',
      'roi',
      'pnl',
      'win_rate',
      'max_drawdown',
      'followers',
      'copiers',
      'trades_count',
      'handle',
      'avatar_url',
      'computed_at',
      'profitability_score',
      'risk_control_score',
      'execution_score',
      'score_completeness',
      'trading_style',
      'avg_holding_hours',
      'style_confidence',
      'sharpe_ratio',
      'sortino_ratio',
      'profit_factor',
      'calmar_ratio',
      'trader_type',
      'is_outlier',
      'metrics_estimated',
      'rank_change',
      'is_new',
      'idle_window',
      'mdd_contradiction'
    ]::pg_catalog.text[] THEN
    RAISE EXCEPTION 'public.public_ranked_leaderboard columns changed';
  END IF;
END
$postflight$;

COMMIT;
