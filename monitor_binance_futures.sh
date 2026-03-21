#!/bin/bash
# 监控binance_futures enrichment任务状态
# 使用方法: ./monitor_binance_futures.sh

DB_HOST="aws-0-us-west-2.pooler.supabase.com"
DB_PORT="6543"
DB_USER="postgres.iknktzifjdyujdccyhsv"
DB_NAME="postgres"
DB_PASS="j0qvCCZDzOHDfBka"

echo "=================================================="
echo "Binance Futures Enrichment 监控"
echo "=================================================="
echo ""

# 查询最近6小时的任务
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "
SELECT 
  id,
  status,
  SUBSTRING(error_message, 1, 50) as error,
  started_at AT TIME ZONE 'America/Los_Angeles' as started_pst,
  ended_at AT TIME ZONE 'America/Los_Angeles' as ended_pst,
  duration_ms / 60000 as duration_min,
  metadata->'period' as period,
  metadata->'limit' as limit
FROM pipeline_logs
WHERE job_name = 'enrich-binance_futures'
  AND started_at >= NOW() - INTERVAL '6 hours'
ORDER BY started_at DESC;
"

echo ""
echo "=================================================="
echo "统计信息（最近24小时）"
echo "=================================================="

PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "
SELECT 
  metadata->'period' as period,
  status,
  COUNT(*) as count,
  AVG(duration_ms / 60000) as avg_duration_min,
  MAX(duration_ms / 60000) as max_duration_min
FROM pipeline_logs
WHERE job_name = 'enrich-binance_futures'
  AND started_at >= NOW() - INTERVAL '24 hours'
GROUP BY metadata->'period', status
ORDER BY metadata->'period', status;
"

echo ""
echo "✅ 成功标准："
echo "   - 所有任务在3分钟内完成"
echo "   - 无任务超过5分钟"
echo "   - 失败率 < 5%"
echo ""
