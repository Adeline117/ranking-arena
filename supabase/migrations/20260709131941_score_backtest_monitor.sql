-- Migration: 20260709131941_score_backtest_monitor.sql
-- Created: 2026-07-09T20:19:41Z
-- Description: Arena Score 预测力持续回测 — 周快照 + 30d 前瞻评估(表 ×2 + RPC ×2)

-- 背景(2026-07-08 回测):过去 ROI/PnL 不预测未来收益(均值回归)→ v4 权重据此校准到
-- 赚钱 0.50/实力 0.50。那次是一次性回溯;本迁移把验证做成【真前瞻】的常设监控:
--   1) snapshot_score_backtest():每周快照当天 v4 分数 + 当前权益(trader_series
--      account_value 覆盖的队列,~2.5K 交易员,主要 HL)。
--   2) evaluate_score_backtest(30):找到 ≥30 天前、未评估的最老快照,计算
--      "当时的分数分位 → 之后 30 天权益回报":五分位中位前瞻回报 + 秩相关(Spearman 近似)
--      + Q5−Q1 分位差,落 score_backtest_runs。
-- 分数若真有预测力:rank_corr > 0 且 top_minus_bottom > 0 持续为正;反之提示回炉。

-- Up
CREATE TABLE IF NOT EXISTS public.score_backtest_snapshots (
  run_date date NOT NULL,
  season text NOT NULL,
  source text NOT NULL,
  source_trader_id text NOT NULL,
  arena_score numeric NOT NULL,
  equity numeric NOT NULL,
  PRIMARY KEY (run_date, season, source, source_trader_id)
);

CREATE TABLE IF NOT EXISTS public.score_backtest_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_at timestamptz NOT NULL DEFAULT now(),
  snapshot_date date NOT NULL,
  season text NOT NULL,
  horizon_days int NOT NULL,
  n int NOT NULL,
  quintiles jsonb NOT NULL,
  rank_corr numeric,
  top_minus_bottom numeric,
  UNIQUE (snapshot_date, season, horizon_days)
);

-- 内部运维表:RLS 开、无公开策略(仅 service role 可达)
ALTER TABLE public.score_backtest_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.score_backtest_runs ENABLE ROW LEVEL SECURITY;

-- 周快照:当天 v4 分数 + 最近 14 天内的最新权益(equity>1000 滤玩具号)。
-- 14 天窗口:深抓权益队列与当前服务榜的交集在 4 天窗口只有 ~220,放宽到 14 天 ~580;
-- 横截面分位比较容忍这点时间抖动,样本量对监控更重要(有效 horizon ≈ 30±14d)。
CREATE OR REPLACE FUNCTION public.snapshot_score_backtest()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, arena
AS $$
  WITH latest_equity AS (
    SELECT DISTINCT ON (s.trader_id) s.trader_id, s.value AS equity
    FROM arena.trader_series s
    WHERE s.metric = 'account_value' AND s.timeframe = 90
      AND s.ts > now() - interval '14 days'
    ORDER BY s.trader_id, s.ts DESC
  ),
  ins AS (
    INSERT INTO public.score_backtest_snapshots
      (run_date, season, source, source_trader_id, arena_score, equity)
    SELECT current_date, '90D', src.slug, tr.exchange_trader_id, lr.arena_score, le.equity
    FROM latest_equity le
    JOIN arena.traders tr ON tr.id = le.trader_id
    JOIN arena.sources src ON src.id = tr.source_id
    JOIN public.leaderboard_ranks lr
      ON lr.season_id = '90D'
     AND lr.source = src.slug
     AND lr.source_trader_id = tr.exchange_trader_id
    WHERE le.equity > 1000 AND lr.arena_score IS NOT NULL
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT coalesce(count(*), 0)::int FROM ins;
$$;

-- 前瞻评估:最老的「≥horizon 天前且未评估」快照批次 → 五分位前瞻回报 + 秩相关
CREATE OR REPLACE FUNCTION public.evaluate_score_backtest(p_horizon_days int DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, arena
AS $$
DECLARE
  v_snapshot_date date;
  v_result jsonb;
BEGIN
  SELECT min(s.run_date) INTO v_snapshot_date
  FROM public.score_backtest_snapshots s
  WHERE s.run_date <= current_date - p_horizon_days
    AND NOT EXISTS (
      SELECT 1 FROM public.score_backtest_runs r
      WHERE r.snapshot_date = s.run_date AND r.season = s.season
        AND r.horizon_days = p_horizon_days
    );

  IF v_snapshot_date IS NULL THEN
    RETURN jsonb_build_object('status', 'no_pending_snapshot');
  END IF;

  WITH now_equity AS (
    SELECT DISTINCT ON (s.trader_id) s.trader_id, s.value AS equity
    FROM arena.trader_series s
    WHERE s.metric = 'account_value' AND s.timeframe = 90
      AND s.ts > now() - interval '14 days'
    ORDER BY s.trader_id, s.ts DESC
  ),
  joined AS (
    SELECT snap.arena_score, (ne.equity / snap.equity - 1) AS fwd
    FROM public.score_backtest_snapshots snap
    JOIN arena.sources src ON src.slug = snap.source
    JOIN arena.traders tr
      ON tr.source_id = src.id AND tr.exchange_trader_id = snap.source_trader_id
    JOIN now_equity ne ON ne.trader_id = tr.id
    WHERE snap.run_date = v_snapshot_date AND snap.season = '90D'
      AND ne.equity > 0 AND ne.equity / snap.equity BETWEEN 0.02 AND 50
  ),
  ranked AS (
    SELECT arena_score, fwd,
           ntile(5) OVER (ORDER BY arena_score) AS quint,
           percent_rank() OVER (ORDER BY arena_score) AS pr_score,
           percent_rank() OVER (ORDER BY fwd) AS pr_fwd
    FROM joined
  ),
  quints AS (
    SELECT quint,
           count(*) AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY fwd) AS fwd_median
    FROM ranked GROUP BY quint
  ),
  stats AS (
    SELECT count(*) AS n, corr(pr_score, pr_fwd) AS rank_corr FROM ranked
  ),
  ins AS (
    INSERT INTO public.score_backtest_runs
      (snapshot_date, season, horizon_days, n, quintiles, rank_corr, top_minus_bottom)
    SELECT v_snapshot_date, '90D', p_horizon_days, stats.n,
      coalesce((SELECT jsonb_object_agg('q' || quint, round(fwd_median::numeric, 4)) FROM quints),
               '{}'::jsonb),
      round(stats.rank_corr::numeric, 4),
      round(((SELECT fwd_median FROM quints WHERE quint = 5)
           - (SELECT fwd_median FROM quints WHERE quint = 1))::numeric, 4)
    FROM stats
    -- 样本不足也落行(否则该批次永远挡在队首);解读时 n<100 视为无结论
    RETURNING jsonb_build_object(
      'status', 'evaluated', 'snapshot_date', snapshot_date, 'horizon_days', horizon_days,
      'n', n, 'quintiles', quintiles, 'rank_corr', rank_corr, 'top_minus_bottom', top_minus_bottom
    )
  )
  SELECT * INTO v_result FROM ins;

  RETURN coalesce(v_result,
    jsonb_build_object('status', 'empty_join', 'snapshot_date', v_snapshot_date));
END;
$$;
