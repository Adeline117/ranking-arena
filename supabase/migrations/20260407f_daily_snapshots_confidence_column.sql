-- Add confidence column to trader_daily_snapshots
-- Default 'high' for all rows. Pre-04-01 data is treated as 'low' at query time
-- (updating 422k rows in-place exceeds statement timeout).
--
-- Consumers should use: WHERE date >= '2026-04-01' OR confidence = 'high'
-- to filter trusted data, OR compute derived metrics only from recent data.

ALTER TABLE trader_daily_snapshots
  ADD COLUMN IF NOT EXISTS confidence TEXT NOT NULL DEFAULT 'high';

-- Note: The column exists but ALL rows have 'high' (the default).
-- Pre-04-01 data quality is enforced at query time in:
-- - compute-derived-metrics (Sharpe, MDD, WR)
-- - calculate-advanced-metrics (Sortino, Calmar, Beta)
-- The known-dirty date boundary is: 2026-04-01
