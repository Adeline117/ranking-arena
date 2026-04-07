-- P0 Historical Data Audit & Fix
-- Applies validate-snapshot.ts checks retroactively to all historical data.
-- Also fixes known platform-specific bugs (Bitget decimal ROI, Bybit PnL=0, Hyperliquid ROI≈PnL).
--
-- All fixes SET invalid fields to NULL (preserve rows, just clean bad values).

BEGIN;

-- ============================================
-- Step 1: ROI out of range |roi_pct| > 100,000%
-- (validate-snapshot check #3)
-- ============================================
UPDATE trader_snapshots_v2
SET roi_pct = NULL
WHERE roi_pct IS NOT NULL
  AND abs(roi_pct) > 100000;

-- ============================================
-- Step 2: Win rate out of bounds (< 0 or > 100)
-- (validate-snapshot check #5)
-- ============================================
UPDATE trader_snapshots_v2
SET win_rate = NULL
WHERE win_rate IS NOT NULL
  AND (win_rate < 0 OR win_rate > 100);

-- ============================================
-- Step 3: Max drawdown out of bounds (< 0 or > 100)
-- (validate-snapshot check #6)
-- ============================================
UPDATE trader_snapshots_v2
SET max_drawdown = NULL
WHERE max_drawdown IS NOT NULL
  AND (max_drawdown < 0 OR max_drawdown > 100);

-- ============================================
-- Step 4: Bybit PnL = 0 → NULL
-- Before 2026-04-01, Bybit leaderboard didn't return PnL.
-- Code defaulted to 0 instead of null. These are "unknown", not "zero profit".
-- ============================================
UPDATE trader_snapshots_v2
SET pnl_usd = NULL
WHERE platform = 'bybit_futures'
  AND pnl_usd = 0;

-- Also fix trader_daily_snapshots
UPDATE trader_daily_snapshots
SET pnl = NULL
WHERE platform = 'bybit_futures'
  AND pnl = 0;

-- ============================================
-- Step 5: Bitget ROI decimal ratio bug
-- VPS scraper returned decimals (0.155 = 15.5%) but connector didn't ×100.
-- ROI values in (-1, 1) excluding 0 are suspicious. NULL them for re-fetch.
-- Also check (-10, 10) range since some decimals could be e.g. 1.55 = 155%.
-- ============================================
UPDATE trader_snapshots_v2
SET roi_pct = NULL
WHERE platform = 'bitget_futures'
  AND roi_pct IS NOT NULL
  AND roi_pct != 0
  AND abs(roi_pct) < 1;

-- ============================================
-- Step 6: Hyperliquid ROI ≈ PnL residual cleanup
-- When |ROI| > 1000 and |ROI - PnL| < 1, ROI was set to PnL value by mistake.
-- (validate-snapshot check #4)
-- ============================================
UPDATE trader_snapshots_v2
SET roi_pct = NULL
WHERE platform = 'hyperliquid'
  AND roi_pct IS NOT NULL
  AND pnl_usd IS NOT NULL
  AND abs(roi_pct) > 1000
  AND abs(roi_pct - pnl_usd) < 1;

-- Also apply ROI ≈ PnL check to ALL platforms (not just hyperliquid)
UPDATE trader_snapshots_v2
SET roi_pct = NULL
WHERE roi_pct IS NOT NULL
  AND pnl_usd IS NOT NULL
  AND abs(roi_pct) > 1000
  AND abs(roi_pct - pnl_usd) < 1
  AND platform != 'hyperliquid';  -- hyperliquid already handled above

COMMIT;
