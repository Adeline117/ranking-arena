-- Backfill daily_return_pct for 2026-03-17 and 2026-03-18
-- Uses the same logic as aggregate-daily-snapshots

WITH prev_snapshots AS (
  -- Get latest snapshot before target date for each trader
  SELECT DISTINCT ON (platform, trader_key)
    platform,
    trader_key,
    pnl,
    roi
  FROM trader_daily_snapshots
  WHERE date < '2026-03-17'
  ORDER BY platform, trader_key, date DESC
),
current_snapshots AS (
  -- Get snapshots for 3/17 and 3/18
  SELECT 
    platform,
    trader_key,
    date,
    pnl,
    roi
  FROM trader_daily_snapshots
  WHERE date IN ('2026-03-17', '2026-03-18')
),
calculated_returns AS (
  -- Calculate daily_return_pct with bounds checking
  SELECT 
    c.platform,
    c.trader_key,
    c.date,
    CASE
      -- Prefer ROI delta (with bounds check: -1000% to +1000%)
      WHEN c.roi IS NOT NULL AND p.roi IS NOT NULL THEN
        GREATEST(-1000, LEAST(1000, c.roi - p.roi))
      -- Fallback to PnL delta (with bounds check)
      WHEN c.pnl IS NOT NULL AND p.pnl IS NOT NULL AND ABS(p.pnl) > 0.01 THEN
        GREATEST(-1000, LEAST(1000, ((c.pnl - p.pnl) / ABS(p.pnl)) * 100))
      ELSE
        NULL
    END as daily_return_pct
  FROM current_snapshots c
  LEFT JOIN prev_snapshots p 
    ON c.platform = p.platform 
    AND c.trader_key = p.trader_key
)
UPDATE trader_daily_snapshots tds
SET daily_return_pct = cr.daily_return_pct
FROM calculated_returns cr
WHERE tds.platform = cr.platform
  AND tds.trader_key = cr.trader_key
  AND tds.date = cr.date
  AND cr.daily_return_pct IS NOT NULL;

-- Report results
SELECT 
  date,
  COUNT(*) as total,
  COUNT(daily_return_pct) as has_return,
  ROUND(100.0 * COUNT(daily_return_pct) / COUNT(*), 2) as coverage_pct
FROM trader_daily_snapshots
WHERE date IN ('2026-03-17', '2026-03-18')
GROUP BY date
ORDER BY date;
