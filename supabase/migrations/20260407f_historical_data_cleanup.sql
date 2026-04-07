-- Historical data cleanup: null out values that fail gatekeeper rules.
-- Same rules as validateBeforeWrite() in lib/pipeline/validate-before-write.ts

-- 1. trader_snapshots_v2: null out invalid metrics
UPDATE trader_snapshots_v2 SET roi_pct = NULL
WHERE roi_pct IS NOT NULL AND (roi_pct < -10000 OR roi_pct > 10000);

UPDATE trader_snapshots_v2 SET pnl_usd = NULL
WHERE pnl_usd IS NOT NULL AND (pnl_usd < -10000000 OR pnl_usd > 1000000000);

UPDATE trader_snapshots_v2 SET win_rate = NULL
WHERE win_rate IS NOT NULL AND (win_rate < 0 OR win_rate > 100);

UPDATE trader_snapshots_v2 SET max_drawdown = NULL
WHERE max_drawdown IS NOT NULL AND (max_drawdown < 0 OR max_drawdown > 100);

UPDATE trader_snapshots_v2 SET sharpe_ratio = NULL
WHERE sharpe_ratio IS NOT NULL AND (sharpe_ratio < -10 OR sharpe_ratio > 10);

-- 2. leaderboard_ranks: null out invalid metrics
UPDATE leaderboard_ranks SET roi = NULL
WHERE roi IS NOT NULL AND (roi < -10000 OR roi > 10000);

UPDATE leaderboard_ranks SET pnl = NULL
WHERE pnl IS NOT NULL AND (pnl < -10000000 OR pnl > 1000000000);

UPDATE leaderboard_ranks SET win_rate = NULL
WHERE win_rate IS NOT NULL AND (win_rate < 0 OR win_rate > 100);

UPDATE leaderboard_ranks SET max_drawdown = NULL
WHERE max_drawdown IS NOT NULL AND (max_drawdown < 0 OR max_drawdown > 100);

UPDATE leaderboard_ranks SET sharpe_ratio = NULL
WHERE sharpe_ratio IS NOT NULL AND (sharpe_ratio < -10 OR sharpe_ratio > 10);

-- 3. ROI ≈ PnL (field mapping error): null ROI where roi ≈ pnl
UPDATE trader_snapshots_v2 SET roi_pct = NULL
WHERE roi_pct IS NOT NULL AND pnl_usd IS NOT NULL
  AND abs(roi_pct - pnl_usd) < 0.01 AND abs(roi_pct) > 10;

-- 4. trader_daily_snapshots: same cleanup
UPDATE trader_daily_snapshots SET roi_pct = NULL
WHERE roi_pct IS NOT NULL AND (roi_pct < -10000 OR roi_pct > 10000);

UPDATE trader_daily_snapshots SET pnl_usd = NULL
WHERE pnl_usd IS NOT NULL AND (pnl_usd < -10000000 OR pnl_usd > 1000000000);

UPDATE trader_daily_snapshots SET win_rate = NULL
WHERE win_rate IS NOT NULL AND (win_rate < 0 OR win_rate > 100);

UPDATE trader_daily_snapshots SET max_drawdown = NULL
WHERE max_drawdown IS NOT NULL AND (max_drawdown < 0 OR max_drawdown > 100);
