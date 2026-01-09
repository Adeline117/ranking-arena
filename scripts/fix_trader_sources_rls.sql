-- 修复 trader_sources 表的 RLS 策略
-- 确保允许公共读取，以便前端可以查询交易员信息

-- 1. 确保 trader_sources 表存在（如果不存在，需要先创建）
-- 注意：如果表不存在，请先运行数据导入脚本创建表

-- 2. 检查并启用 RLS
DO $$ 
BEGIN
  -- 如果表存在，启用 RLS
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'trader_sources') THEN
    ALTER TABLE trader_sources ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- 3. 删除现有的 SELECT 策略（如果存在）
DROP POLICY IF EXISTS "trader_sources are viewable by everyone" ON trader_sources;
DROP POLICY IF EXISTS "Public read access to trader_sources" ON trader_sources;
DROP POLICY IF EXISTS "Allow public read" ON trader_sources;

-- 4. 创建允许所有人读取的策略
CREATE POLICY "trader_sources are viewable by everyone"
  ON trader_sources FOR SELECT
  USING (true);

-- 5. 如果需要，也可以允许插入和更新（通常只有管理员需要）
-- 注意：这里只允许读取，插入和更新应该通过服务端 API 进行

-- 6. 创建索引以提高查询性能（如果不存在）
CREATE INDEX IF NOT EXISTS idx_trader_sources_source ON trader_sources(source);
CREATE INDEX IF NOT EXISTS idx_trader_sources_source_trader_id ON trader_sources(source, source_trader_id);
CREATE INDEX IF NOT EXISTS idx_trader_sources_handle ON trader_sources(handle) WHERE handle IS NOT NULL;

-- 完成！
-- 现在 trader_sources 表应该允许所有人读取了

