-- Data lifecycle cleanup: prevent unbounded growth of enrichment tables
-- Retention: equity_curve 365d, stats_detail 90d, daily_snapshots 365d

-- Cleanup function (called by daily cron or manually)
CREATE OR REPLACE FUNCTION cleanup_stale_data()
RETURNS TABLE (table_name TEXT, deleted_rows BIGINT) AS $$
DECLARE
  v_deleted BIGINT;
BEGIN
  -- trader_equity_curve: 365 days
  DELETE FROM trader_equity_curve WHERE data_date < CURRENT_DATE - INTERVAL '365 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  table_name := 'trader_equity_curve'; deleted_rows := v_deleted;
  RETURN NEXT;

  -- trader_stats_detail: 90 days
  DELETE FROM trader_stats_detail WHERE captured_at < NOW() - INTERVAL '90 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  table_name := 'trader_stats_detail'; deleted_rows := v_deleted;
  RETURN NEXT;

  -- trader_daily_snapshots: 365 days
  DELETE FROM trader_daily_snapshots WHERE date < CURRENT_DATE - INTERVAL '365 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  table_name := 'trader_daily_snapshots'; deleted_rows := v_deleted;
  RETURN NEXT;

  -- trader_position_history: 180 days
  DELETE FROM trader_position_history WHERE captured_at < NOW() - INTERVAL '180 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  table_name := 'trader_position_history'; deleted_rows := v_deleted;
  RETURN NEXT;

  -- pipeline_logs: 30 days
  DELETE FROM pipeline_logs WHERE started_at < NOW() - INTERVAL '30 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  table_name := 'pipeline_logs'; deleted_rows := v_deleted;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- Drop redundant constraint (4-col superseded by 3-col)
ALTER TABLE trader_snapshots_v2
  DROP CONSTRAINT IF EXISTS trader_snapshots_v2_platform_market_trader_window_uniq;
