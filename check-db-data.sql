-- 检查数据库中的数据
-- 在 Supabase SQL Editor 中运行

-- 1. 检查是否有快照数据
SELECT 
  source,
  COUNT(*) as count,
  MAX(captured_at) as latest_capture
FROM trader_snapshots
GROUP BY source
ORDER BY source;

-- 2. 检查最新的快照时间
SELECT 
  source,
  captured_at,
  COUNT(*) as trader_count
FROM trader_snapshots
WHERE captured_at = (
  SELECT MAX(captured_at) 
  FROM trader_snapshots t2 
  WHERE t2.source = trader_snapshots.source
)
GROUP BY source, captured_at
ORDER BY source;

-- 3. 检查是否有 trader_sources 数据
SELECT 
  source,
  COUNT(*) as count
FROM trader_sources
GROUP BY source
ORDER BY source;

-- 4. 检查示例数据
SELECT 
  source,
  source_trader_id,
  handle,
  roi,
  rank
FROM trader_snapshots
WHERE source = 'binance_web3'
ORDER BY rank
LIMIT 5;
