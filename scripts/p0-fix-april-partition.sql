-- P0 Fix: April partition data quality fixes in batches
-- Run with: psql $DIRECT_URL -f scripts/p0-fix-april-partition.sql

SET statement_timeout = '120s';

-- Batch 1: Fix sharpe ratio (103k rows, ~10k per batch)
DO $$
DECLARE
  batch_size INT := 5000;
  total_fixed INT := 0;
  batch_fixed INT;
BEGIN
  LOOP
    WITH batch AS (
      SELECT ctid FROM trader_snapshots_v2_p2026_04
      WHERE sharpe_ratio IS NOT NULL AND (sharpe_ratio < -10 OR sharpe_ratio > 10)
      LIMIT batch_size
    )
    UPDATE trader_snapshots_v2_p2026_04 t
    SET sharpe_ratio = NULL
    FROM batch b WHERE t.ctid = b.ctid;

    GET DIAGNOSTICS batch_fixed = ROW_COUNT;
    total_fixed := total_fixed + batch_fixed;
    RAISE NOTICE 'Sharpe fixed: % (batch: %)', total_fixed, batch_fixed;
    EXIT WHEN batch_fixed = 0;
  END LOOP;
  RAISE NOTICE 'Total sharpe fixed: %', total_fixed;
END $$;

-- Batch 2: Fix ROI out of range (6881 rows)
DO $$
DECLARE
  batch_size INT := 5000;
  total_fixed INT := 0;
  batch_fixed INT;
BEGIN
  LOOP
    WITH batch AS (
      SELECT ctid FROM trader_snapshots_v2_p2026_04
      WHERE roi_pct IS NOT NULL AND abs(roi_pct) > 10000
      LIMIT batch_size
    )
    UPDATE trader_snapshots_v2_p2026_04 t
    SET roi_pct = NULL
    FROM batch b WHERE t.ctid = b.ctid;

    GET DIAGNOSTICS batch_fixed = ROW_COUNT;
    total_fixed := total_fixed + batch_fixed;
    RAISE NOTICE 'ROI fixed: % (batch: %)', total_fixed, batch_fixed;
    EXIT WHEN batch_fixed = 0;
  END LOOP;
  RAISE NOTICE 'Total ROI fixed: %', total_fixed;
END $$;

-- Batch 3: Fix MDD out of bounds (4038 rows)
DO $$
DECLARE
  batch_size INT := 5000;
  total_fixed INT := 0;
  batch_fixed INT;
BEGIN
  LOOP
    WITH batch AS (
      SELECT ctid FROM trader_snapshots_v2_p2026_04
      WHERE max_drawdown IS NOT NULL AND (max_drawdown < 0 OR max_drawdown > 100)
      LIMIT batch_size
    )
    UPDATE trader_snapshots_v2_p2026_04 t
    SET max_drawdown = NULL
    FROM batch b WHERE t.ctid = b.ctid;

    GET DIAGNOSTICS batch_fixed = ROW_COUNT;
    total_fixed := total_fixed + batch_fixed;
    RAISE NOTICE 'MDD fixed: % (batch: %)', total_fixed, batch_fixed;
    EXIT WHEN batch_fixed = 0;
  END LOOP;
  RAISE NOTICE 'Total MDD fixed: %', total_fixed;
END $$;

-- Batch 4: ROI ≈ PnL residual check
DO $$
DECLARE
  total_fixed INT := 0;
  batch_fixed INT;
BEGIN
  WITH batch AS (
    SELECT ctid FROM trader_snapshots_v2_p2026_04
    WHERE roi_pct IS NOT NULL AND pnl_usd IS NOT NULL
      AND abs(roi_pct) > 1000 AND abs(roi_pct - pnl_usd) < 1
  )
  UPDATE trader_snapshots_v2_p2026_04 t
  SET roi_pct = NULL
  FROM batch b WHERE t.ctid = b.ctid;

  GET DIAGNOSTICS total_fixed = ROW_COUNT;
  RAISE NOTICE 'ROI≈PnL fixed: %', total_fixed;
END $$;

-- Verify: count remaining violations
SELECT 'sharpe_bad' as issue, count(*) FROM trader_snapshots_v2_p2026_04 WHERE sharpe_ratio IS NOT NULL AND (sharpe_ratio < -10 OR sharpe_ratio > 10)
UNION ALL SELECT 'roi_bad', count(*) FROM trader_snapshots_v2_p2026_04 WHERE roi_pct IS NOT NULL AND abs(roi_pct) > 10000
UNION ALL SELECT 'mdd_bad', count(*) FROM trader_snapshots_v2_p2026_04 WHERE max_drawdown IS NOT NULL AND (max_drawdown < 0 OR max_drawdown > 100)
UNION ALL SELECT 'wr_bad', count(*) FROM trader_snapshots_v2_p2026_04 WHERE win_rate IS NOT NULL AND (win_rate < 0 OR win_rate > 100);
