-- Migration: 20260709135100_score_inputs_coalesce_stats.sql
-- Created: 2026-07-09T21:51:00Z
-- Description: score_inputs 视图 pnl/win_rate/roi 用 trader_stats 回填(修 bybit 全源 PnL=0)

-- 逐源缺数据检查(2026-07-09)发现:serving 层 bybit(=bybit_copytrade)PnL 三个时间段
-- 全 0%、bitget_cfd/bitget_spot 同样 —— 但主数据层 arena.trader_stats 有 pnl(深抓 21%+)。
-- 根因:arena.score_inputs 的 `e.headline_pnl AS pnl_usd` 只取板面 headline,而 bybit
-- copytrade 板是 ROI-only 板(125K entries headline_pnl 0%)→ pnl 永远 null,明明视图
-- 已 LEFT JOIN trader_stats(mdd/copiers/trades/sharpe 都在用它)。
-- 后果链:pnl null → v4 分数 f_pnl=0(权重 0.30)→ 整个 bybit 源被系统性压分。
-- 修:pnl/win_rate/roi 三个字段 COALESCE(板面, trader_stats 深抓值)。这不是自派生——
-- trader_stats 的值来自交易所自己的 profile 页(死命令合规)。
-- 注:本定义基于 pg_get_viewdef 拉的【生产当前定义】(比 20260611 原始迁移多了
-- board_rank/sharpe/sortino/calmar/volatility/currency 列 + 币种放宽),列数列序不变,
-- CREATE OR REPLACE 兼容(初稿按旧迁移写少了列 → 42P16 cannot drop columns,已纠正)。

-- Up
CREATE OR REPLACE VIEW arena.score_inputs AS
WITH latest_passed AS (
  SELECT DISTINCT ON (ls.source_id, ls.timeframe)
         ls.id AS snapshot_id, ls.source_id, ls.timeframe, ls.scraped_at
    FROM arena.leaderboard_snapshots ls
   WHERE ls.count_check_passed
   ORDER BY ls.source_id, ls.timeframe, ls.scraped_at DESC
)
SELECT
  COALESCE(s.meta->>'legacy_platform', s.slug)             AS platform,
  CASE WHEN s.product_type = 'spot' THEN 'spot' ELSE 'futures' END AS market_type,
  t.exchange_trader_id                                     AS trader_key,
  (lp.timeframe::text || 'D')                              AS "window",
  e.rank                                                   AS board_rank,
  LEAST(GREATEST(COALESCE(e.headline_roi, st.roi), -10000), 10000) AS roi_pct,
  COALESCE(e.headline_pnl, st.pnl)                         AS pnl_usd,
  LEAST(GREATEST(COALESCE(e.headline_win_rate, st.win_rate), 0), 100) AS win_rate,
  LEAST(abs(st.mdd), 100)                                  AS max_drawdown,
  st.copier_count                                          AS copiers,
  st.total_positions                                       AS trades_count,
  st.sharpe                                                AS sharpe_ratio,
  (st.extras->>'sortino')::numeric                         AS sortino_ratio,
  (st.extras->>'calmar')::numeric                          AS calmar_ratio,
  (st.extras->>'volatility')::numeric                      AS volatility_pct,
  t.trader_kind,
  t.nickname                                               AS handle,
  COALESCE(t.avatar_url_mirror, t.avatar_url_origin)       AS avatar_url,
  s.currency,
  lp.scraped_at                                            AS as_of
FROM latest_passed lp
JOIN arena.sources s             ON s.id = lp.source_id
JOIN arena.leaderboard_entries e ON e.snapshot_id = lp.snapshot_id
JOIN arena.traders t             ON t.id = e.trader_id
LEFT JOIN arena.trader_stats st  ON st.trader_id = t.id AND st.timeframe = lp.timeframe
WHERE s.serving_mode <> 'legacy'
  AND s.currency = ANY (ARRAY['USDT','USDx','USDC','USD'])
  AND (s.meta->>'legacy_platform') IS DISTINCT FROM 'null';

GRANT SELECT ON arena.score_inputs TO service_role;
