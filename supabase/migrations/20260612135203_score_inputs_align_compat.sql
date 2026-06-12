-- Description: ENDGAME prep — align arena.score_inputs with what the compat
-- writer actually puts into trader_latest, so compute-leaderboard can later
-- read the view instead of trader_latest (then compat + trader_latest +
-- the 33GB trader_snapshots_v2 archive all retire).
-- Two gaps fixed: (1) currency filter was USDT-only, dropping serving
-- USDx/USDC/USD sources (5 platforms / 54k rows) — all are $1-pegged, the
-- ranking layer is implicitly dollar-denominated (same call compat made);
-- (2) add the advanced-metric columns compute reads (sharpe/sortino/calmar/
-- volatility) sourced from trader_stats.

-- DROP+CREATE (not REPLACE): column list changes order/adds columns, which
-- CREATE OR REPLACE forbids.
DROP VIEW IF EXISTS arena.score_inputs;
CREATE VIEW arena.score_inputs AS
WITH latest_passed AS (
  SELECT DISTINCT ON (ls.source_id, ls.timeframe)
         ls.id AS snapshot_id, ls.source_id, ls.timeframe, ls.scraped_at
    FROM arena.leaderboard_snapshots ls
   WHERE ls.count_check_passed
   ORDER BY ls.source_id, ls.timeframe, ls.scraped_at DESC
)
SELECT
  COALESCE(s.meta->>'legacy_platform', s.slug)             AS platform,
  CASE WHEN s.product_type='spot' THEN 'spot' ELSE 'futures' END AS market_type,
  t.exchange_trader_id                                     AS trader_key,
  (lp.timeframe::text || 'D')                              AS "window",
  LEAST(GREATEST(e.headline_roi, -10000), 10000)           AS roi_pct,
  e.headline_pnl                                           AS pnl_usd,
  LEAST(GREATEST(e.headline_win_rate, 0), 100)             AS win_rate,
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
  s.currency                                               AS currency,
  lp.scraped_at                                            AS as_of
FROM latest_passed lp
JOIN arena.sources s             ON s.id = lp.source_id
JOIN arena.leaderboard_entries e ON e.snapshot_id = lp.snapshot_id
JOIN arena.traders t             ON t.id = e.trader_id
LEFT JOIN arena.trader_stats st  ON st.trader_id = t.id AND st.timeframe = lp.timeframe
WHERE s.serving_mode <> 'legacy'
  AND s.currency IN ('USDT','USDx','USDC','USD')   -- all $1-pegged (spec §5.8: UI labels honestly; ranking is $)
  AND (s.meta->>'legacy_platform') IS DISTINCT FROM 'null';

GRANT SELECT ON arena.score_inputs TO service_role;
