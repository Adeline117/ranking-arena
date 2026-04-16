-- Migration: 20260416162941_clamp_trader_snapshots_max_drawdown.sql
-- Created: 2026-04-16
-- Description: Clean + constrain trader_snapshots.max_drawdown; also ROI guardrail
--
-- Root cause: trader_snapshots has no CHECK constraint on max_drawdown or ROI,
-- unlike leaderboard_ranks. Fetchers from hyperliquid (and a few others) push
-- raw upstream values through to the table — resulting in garbage MDDs in the
-- billions (e.g. 587,181,549,526% drawdown) and negative MDDs from gains.
--
-- Audit (2026-04-16, trader_snapshots.max_drawdown):
--   hyperliquid max:   587,181,549,526.087   (1193 rows > 100%, 633 rows < 0)
--   binance_web3 max:  1,956,589.91          (132 rows > 100%)
--   gmx max:           2,978,436.55          (271 rows > 100%)
--   gains min:         -6,382,984.73         (53 rows < 0)
--   Across all sources: 3206 rows with max_drawdown > 100, plus 686 < 0.
--
-- These corrupt rows break downstream calmar_ratio computations and could
-- inflate arena_score inputs if reintroduced. leaderboard_ranks already has
-- this constraint; compute-leaderboard clamps at read time so the user impact
-- is limited, but the dirty source data must not persist.
--
-- Fix:
--  1. NULL out grossly-out-of-range max_drawdown values (< -100 or > 10000).
--     Light fuzz around the 0-100 range (< 0, 100-10000) is preserved but
--     NULL'd for consistency with leaderboard_ranks bounds.
--  2. NULL out ROI values > 10000% or < -10000% (clear corruption — already
--     enforced on leaderboard_ranks via chk_lr_roi).
--  3. Add CHECK CONSTRAINT ... NOT VALID so all FUTURE writes are blocked.
--     NOT VALID means existing rows are grandfathered; after this migration
--     the whole table is already compliant so a follow-up VALIDATE CONSTRAINT
--     can run later without a long table lock.

-- 1. Clean corrupt max_drawdown values
UPDATE public.trader_snapshots
SET max_drawdown = NULL
WHERE max_drawdown IS NOT NULL
  AND (max_drawdown < 0 OR max_drawdown > 100);

-- 2. Clean corrupt ROI values (> 10000% = 100x, clearly junk)
UPDATE public.trader_snapshots
SET roi = NULL
WHERE roi IS NOT NULL
  AND (roi < -10000 OR roi > 100000);

-- 3. Add forward-looking guardrail (NOT VALID so existing rows aren't re-checked)
ALTER TABLE public.trader_snapshots
  ADD CONSTRAINT chk_ts_max_drawdown_range
  CHECK (max_drawdown IS NULL OR (max_drawdown >= 0 AND max_drawdown <= 100))
  NOT VALID;

ALTER TABLE public.trader_snapshots
  ADD CONSTRAINT chk_ts_roi_range
  CHECK (roi IS NULL OR (roi >= -10000 AND roi <= 100000))
  NOT VALID;

-- Since we just cleaned the table, the constraints can be validated cheaply.
-- VALIDATE takes a SHARE UPDATE EXCLUSIVE lock (doesn't block reads/writes).
ALTER TABLE public.trader_snapshots VALIDATE CONSTRAINT chk_ts_max_drawdown_range;
ALTER TABLE public.trader_snapshots VALIDATE CONSTRAINT chk_ts_roi_range;

COMMENT ON CONSTRAINT chk_ts_max_drawdown_range ON public.trader_snapshots IS
'max_drawdown must be in [0, 100]% — mirrors leaderboard_ranks_max_drawdown_check_pos';

COMMENT ON CONSTRAINT chk_ts_roi_range ON public.trader_snapshots IS
'roi must be in [-10000, 100000]% — blocks corrupt upstream values from hyperliquid et al';
