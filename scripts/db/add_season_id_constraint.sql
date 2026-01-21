-- 为 trader_snapshots 表添加 season_id 唯一约束
-- 这是为了支持按不同周期（7D、30D、90D）存储独立的快照数据

-- 首先，如果存在旧的唯一约束，删除它
ALTER TABLE trader_snapshots 
  DROP CONSTRAINT IF EXISTS trader_snapshots_source_source_trader_id_captured_at_key;

-- 添加新的唯一约束，包含 season_id
ALTER TABLE trader_snapshots 
  ADD CONSTRAINT trader_snapshots_unique_per_season 
  UNIQUE (source, source_trader_id, season_id, captured_at);

-- 为没有 season_id 的旧数据设置默认值为 '90D'
UPDATE trader_snapshots 
  SET season_id = '90D' 
  WHERE season_id IS NULL;

-- 添加索引以加速按 season_id 查询
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_season_id 
  ON trader_snapshots(source, source_trader_id, season_id, captured_at DESC);

-- 验证结果
SELECT season_id, COUNT(*) as count 
FROM trader_snapshots 
GROUP BY season_id;
