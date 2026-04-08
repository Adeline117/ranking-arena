-- P0 Fix: Server-side batched fix using a single connection
-- Run with: psql $DIRECT_URL -f scripts/p0-fix-server-side.sql
-- Uses DO blocks with small commits to avoid OOM

SET statement_timeout = '0';  -- No timeout for this session

-- Fix sharpe violations in small batches
DO $$
DECLARE
  v_batch INT;
  v_total INT := 0;
  v_ids uuid[];
BEGIN
  LOOP
    -- Fetch IDs (uses partial index, fast)
    SELECT array_agg(id) INTO v_ids
    FROM (
      SELECT id FROM trader_snapshots_v2_p2026_04
      WHERE sharpe_ratio IS NOT NULL AND (sharpe_ratio < -10 OR sharpe_ratio > 10)
      LIMIT 200
    ) sub;

    IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
      EXIT;
    END IF;

    -- Update by PK (fast)
    UPDATE trader_snapshots_v2_p2026_04
    SET sharpe_ratio = NULL
    WHERE id = ANY(v_ids);

    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_total := v_total + v_batch;

    IF v_total % 2000 < 200 THEN
      RAISE NOTICE 'Sharpe progress: %', v_total;
    END IF;
  END LOOP;
  RAISE NOTICE 'Sharpe complete: % rows fixed', v_total;
END $$;

-- Fix ROI violations
DO $$
DECLARE
  v_batch INT;
  v_total INT := 0;
  v_ids uuid[];
BEGIN
  LOOP
    SELECT array_agg(id) INTO v_ids
    FROM (
      SELECT id FROM trader_snapshots_v2_p2026_04
      WHERE roi_pct IS NOT NULL AND abs(roi_pct) > 10000
      LIMIT 200
    ) sub;

    IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN EXIT; END IF;

    UPDATE trader_snapshots_v2_p2026_04 SET roi_pct = NULL WHERE id = ANY(v_ids);
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_total := v_total + v_batch;
    IF v_total % 2000 < 200 THEN RAISE NOTICE 'ROI progress: %', v_total; END IF;
  END LOOP;
  RAISE NOTICE 'ROI complete: % rows fixed', v_total;
END $$;

-- Fix MDD violations
DO $$
DECLARE
  v_batch INT;
  v_total INT := 0;
  v_ids uuid[];
BEGIN
  LOOP
    SELECT array_agg(id) INTO v_ids
    FROM (
      SELECT id FROM trader_snapshots_v2_p2026_04
      WHERE max_drawdown IS NOT NULL AND (max_drawdown < 0 OR max_drawdown > 100)
      LIMIT 200
    ) sub;

    IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN EXIT; END IF;

    UPDATE trader_snapshots_v2_p2026_04 SET max_drawdown = NULL WHERE id = ANY(v_ids);
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_total := v_total + v_batch;
    IF v_total % 2000 < 200 THEN RAISE NOTICE 'MDD progress: %', v_total; END IF;
  END LOOP;
  RAISE NOTICE 'MDD complete: % rows fixed', v_total;
END $$;

-- Fix ROI ≈ PnL
DO $$
DECLARE
  v_batch INT;
  v_total INT := 0;
  v_ids uuid[];
BEGIN
  LOOP
    SELECT array_agg(id) INTO v_ids
    FROM (
      SELECT id FROM trader_snapshots_v2_p2026_04
      WHERE roi_pct IS NOT NULL AND pnl_usd IS NOT NULL
        AND abs(roi_pct) > 1000 AND abs(roi_pct - pnl_usd) < 1
      LIMIT 200
    ) sub;

    IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN EXIT; END IF;

    UPDATE trader_snapshots_v2_p2026_04 SET roi_pct = NULL WHERE id = ANY(v_ids);
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_total := v_total + v_batch;
  END LOOP;
  RAISE NOTICE 'ROI≈PnL complete: % rows fixed', v_total;
END $$;

-- Cleanup temp indexes
DROP INDEX IF EXISTS idx_tmp_audit_roi;
DROP INDEX IF EXISTS idx_tmp_audit_mdd;
DROP INDEX IF EXISTS idx_tmp_audit_wr;
DROP INDEX IF EXISTS idx_tmp_audit_sharpe;

-- Drop temp function
DROP FUNCTION IF EXISTS fix_snapshot_violations;

\echo 'P0 April partition fix complete'
