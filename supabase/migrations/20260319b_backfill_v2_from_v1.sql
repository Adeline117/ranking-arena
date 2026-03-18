-- Backfill trader_snapshots_v2 from trader_snapshots (v1)
--
-- Root cause: v2 unique constraint was missing before 2026-03-10, causing all
-- upserts to silently fail. This backfill restores v2 coverage from v1 data.
--
-- Only backfills rows where v2 doesn't already have data (ON CONFLICT DO NOTHING
-- for rows that already exist, DO UPDATE for stale rows).

INSERT INTO trader_snapshots_v2 (
  platform, market_type, trader_key, "window",
  roi_pct, pnl_usd, win_rate, max_drawdown,
  trades_count, followers, arena_score, sharpe_ratio,
  created_at, updated_at
)
SELECT
  ts.source AS platform,
  CASE
    WHEN ts.source IN ('binance_spot', 'bitget_spot', 'bybit_spot', 'okx_spot') THEN 'spot'
    WHEN ts.source IN (
      'gmx', 'dydx', 'hyperliquid', 'drift', 'gains', 'jupiter_perps',
      'aevo', 'perpetual_protocol', 'paradex', 'kwenta',
      'binance_web3', 'okx_web3', 'okx_wallet', 'web3_bot',
      'dune_gmx', 'dune_hyperliquid', 'dune_uniswap', 'dune_defi'
    ) THEN 'web3'
    ELSE 'futures'
  END AS market_type,
  ts.source_trader_id AS trader_key,
  ts.season_id AS "window",
  ts.roi AS roi_pct,
  ts.pnl AS pnl_usd,
  ts.win_rate,
  ts.max_drawdown,
  ts.trades_count,
  ts.followers,
  ts.arena_score,
  ts.sharpe_ratio,
  ts.captured_at AS created_at,
  ts.captured_at AS updated_at
FROM trader_snapshots ts
WHERE ts.captured_at >= NOW() - INTERVAL '72 hours'
  AND ts.season_id IN ('7D', '30D', '90D')
  AND ts.roi IS NOT NULL
ON CONFLICT (platform, market_type, trader_key, "window")
DO UPDATE SET
  roi_pct = EXCLUDED.roi_pct,
  pnl_usd = EXCLUDED.pnl_usd,
  win_rate = COALESCE(EXCLUDED.win_rate, trader_snapshots_v2.win_rate),
  max_drawdown = COALESCE(EXCLUDED.max_drawdown, trader_snapshots_v2.max_drawdown),
  trades_count = COALESCE(EXCLUDED.trades_count, trader_snapshots_v2.trades_count),
  followers = COALESCE(EXCLUDED.followers, trader_snapshots_v2.followers),
  arena_score = COALESCE(EXCLUDED.arena_score, trader_snapshots_v2.arena_score),
  sharpe_ratio = COALESCE(EXCLUDED.sharpe_ratio, trader_snapshots_v2.sharpe_ratio),
  updated_at = GREATEST(EXCLUDED.updated_at, trader_snapshots_v2.updated_at)
WHERE EXCLUDED.updated_at > trader_snapshots_v2.updated_at;
