-- Migration: 20260709201917_score_inputs_first_party_branch.sql
-- Created: 2026-07-09T20:19:17Z (PT)
-- Description: score_inputs view 加第一方分支 — claimed 交易员用自己账号算的 stats 参与排名
--
-- 认领交易员 P1(owner 拍板):claimed 且第一方数据新鲜(<48h)的交易员,排名输入
-- 改用 trader_stats(provenance='first_party');数据过期(key 失效/撤销)自动回落
-- 板面分支——行永不消失,只降级。设计级前提:score_inputs 的 headline 来自
-- leaderboard_entries(板面),只写 trader_stats 不会改变排名,覆盖必须做在本 view。
-- 列数/列序/列名与现行定义(20260709135100)完全一致(CREATE OR REPLACE 约束)。

-- Up

-- claimed 交易员的快速过滤索引(人工审核制,行数极少)
CREATE INDEX IF NOT EXISTS traders_claimed_idx
  ON arena.traders ((meta->>'claimed'))
  WHERE meta->>'claimed' = 'true';

CREATE OR REPLACE VIEW arena.score_inputs AS
WITH latest_passed AS (
  SELECT DISTINCT ON (ls.source_id, ls.timeframe)
         ls.id AS snapshot_id, ls.source_id, ls.timeframe, ls.scraped_at
    FROM arena.leaderboard_snapshots ls
   WHERE ls.count_check_passed
   ORDER BY ls.source_id, ls.timeframe, ls.scraped_at DESC
),
fp_fresh AS (
  -- claimed 交易员 × timeframe 的新鲜第一方 stats(排他判据与分支2完全一致)
  SELECT st.trader_id, st.timeframe
    FROM arena.trader_stats st
    JOIN arena.traders t ON t.id = st.trader_id
   WHERE t.meta->>'claimed' = 'true'
     AND st.extras->>'provenance' = 'first_party'
     AND st.as_of > now() - interval '48 hours'
)
-- ── 分支 1:板面(现行逻辑;claimed 且第一方新鲜的行让位) ──
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
  AND (s.meta->>'legacy_platform') IS DISTINCT FROM 'null'
  AND NOT EXISTS (
    SELECT 1 FROM fp_fresh f
     WHERE f.trader_id = t.id AND f.timeframe = lp.timeframe)

UNION ALL

-- ── 分支 2:第一方(claimed + provenance='first_party' + <48h) ──
SELECT
  COALESCE(s.meta->>'legacy_platform', s.slug)             AS platform,
  CASE WHEN s.product_type = 'spot' THEN 'spot' ELSE 'futures' END AS market_type,
  t.exchange_trader_id                                     AS trader_key,
  (st.timeframe::text || 'D')                              AS "window",
  br.rank                                                  AS board_rank,
  LEAST(GREATEST(st.roi, -10000), 10000)                   AS roi_pct,
  st.pnl                                                   AS pnl_usd,
  LEAST(GREATEST(st.win_rate, 0), 100)                     AS win_rate,
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
  st.as_of                                                 AS as_of
FROM arena.traders t
JOIN arena.sources s            ON s.id = t.source_id
JOIN arena.trader_stats st      ON st.trader_id = t.id AND st.timeframe IN (7, 30, 90)
LEFT JOIN LATERAL (
  SELECT e2.rank
    FROM latest_passed lp2
    JOIN arena.leaderboard_entries e2
      ON e2.snapshot_id = lp2.snapshot_id AND e2.trader_id = t.id
   WHERE lp2.source_id = s.id AND lp2.timeframe = st.timeframe
   LIMIT 1
) br ON true
WHERE t.meta->>'claimed' = 'true'
  AND st.extras->>'provenance' = 'first_party'
  AND st.as_of > now() - interval '48 hours'
  AND s.currency = ANY (ARRAY['USDT','USDx','USDC','USD']);

GRANT SELECT ON arena.score_inputs TO service_role;
