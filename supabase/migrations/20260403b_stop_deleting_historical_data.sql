-- Replace cleanup_stale_data() to STOP deleting trader historical data.
-- Policy: "绝对不要删除数据库历史数据 — 积累做好多年"
--
-- REMOVED deletions: trader_equity_curve, trader_stats_detail,
--                    trader_daily_snapshots, trader_position_history
-- KEPT: pipeline_logs (operational logs, 90d retention)

CREATE OR REPLACE FUNCTION cleanup_stale_data()
RETURNS TABLE (table_name TEXT, deleted_rows BIGINT) AS $$
DECLARE
  v_deleted BIGINT;
BEGIN
  -- pipeline_logs: 90 days (operational logs only, not trader data)
  DELETE FROM pipeline_logs WHERE started_at < NOW() - INTERVAL '90 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  table_name := 'pipeline_logs'; deleted_rows := v_deleted;
  RETURN NEXT;

  -- All trader data tables are PRESERVED indefinitely:
  -- trader_equity_curve, trader_stats_detail, trader_daily_snapshots,
  -- trader_position_history, trader_snapshots_v2
  -- Use VACUUM/ANALYZE for maintenance, not DELETE.
END;
$$ LANGUAGE plpgsql;
