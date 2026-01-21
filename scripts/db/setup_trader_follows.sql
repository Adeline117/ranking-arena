-- 创建 trader_follows 表，用于存储 Arena 用户对 Trader 的关注关系
-- 所有 trader 的粉丝数只能来源 Arena 注册用户的关注

-- ============================================
-- 1. 创建 trader_follows 表（如果不存在）
-- ============================================
CREATE TABLE IF NOT EXISTS trader_follows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- trader_id 可以是 trader_sources 的 source_trader_id 或组合键 (source, source_trader_id)
  -- 为了简单，使用 source_trader_id 作为 trader 的唯一标识
  -- 如果同一个 trader 在多个交易所存在，需要根据实际业务决定是否合并
  trader_id TEXT NOT NULL,
  source TEXT, -- 可选：记录 trader 来源（binance, bybit 等）
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- 确保一个用户只能关注一个 trader 一次
  UNIQUE(user_id, trader_id)
);

-- ============================================
-- 2. 创建索引
-- ============================================
CREATE INDEX IF NOT EXISTS idx_trader_follows_user_id ON trader_follows(user_id);
CREATE INDEX IF NOT EXISTS idx_trader_follows_trader_id ON trader_follows(trader_id);
CREATE INDEX IF NOT EXISTS idx_trader_follows_source ON trader_follows(source);
CREATE INDEX IF NOT EXISTS idx_trader_follows_created_at ON trader_follows(created_at);

-- ============================================
-- 3. 如果已存在 follows 表，迁移数据到 trader_follows
-- ============================================
DO $$ 
BEGIN
  -- 检查是否存在 follows 表
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'follows') THEN
    -- 检查 follows 表是否有 trader_id 列
    IF EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_name = 'follows' AND column_name = 'trader_id'
    ) THEN
      -- 迁移现有数据（如果还没有迁移）
      INSERT INTO trader_follows (user_id, trader_id, created_at, updated_at)
      SELECT user_id, trader_id, created_at, updated_at
      FROM follows
      WHERE trader_id IS NOT NULL
      ON CONFLICT (user_id, trader_id) DO NOTHING;
      
      RAISE NOTICE '已迁移 follows 表中的 trader 关注数据到 trader_follows';
    END IF;
  END IF;
END $$;

-- ============================================
-- 4. 设置 RLS 策略
-- ============================================
ALTER TABLE trader_follows ENABLE ROW LEVEL SECURITY;

-- 删除现有策略（如果存在）
DROP POLICY IF EXISTS "Anyone can view trader follows" ON trader_follows;
DROP POLICY IF EXISTS "Users can follow traders" ON trader_follows;
DROP POLICY IF EXISTS "Users can unfollow traders" ON trader_follows;

-- 任何人都可以查看关注关系（用于统计粉丝数）
CREATE POLICY "Anyone can view trader follows"
  ON trader_follows FOR SELECT
  USING (true);

-- 用户可以关注 trader
CREATE POLICY "Users can follow traders"
  ON trader_follows FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 用户可以取消关注（只能取消自己的关注）
CREATE POLICY "Users can unfollow traders"
  ON trader_follows FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- 5. 创建函数：获取 trader 的 Arena 粉丝数
-- ============================================
CREATE OR REPLACE FUNCTION get_trader_arena_followers_count(trader_id_param TEXT)
RETURNS INTEGER AS $$
BEGIN
  RETURN (
    SELECT COUNT(*)
    FROM trader_follows
    WHERE trader_id = trader_id_param
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 6. 创建视图：trader 粉丝数统计（便于查询）
-- ============================================
CREATE OR REPLACE VIEW trader_arena_followers_count AS
SELECT 
  trader_id,
  source,
  COUNT(*) as followers_count,
  MAX(created_at) as last_follow_at
FROM trader_follows
GROUP BY trader_id, source;

-- ============================================
-- 7. 添加更新 updated_at 的触发器
-- ============================================
CREATE OR REPLACE FUNCTION update_trader_follows_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_trader_follows_updated_at ON trader_follows;

CREATE TRIGGER trigger_update_trader_follows_updated_at
  BEFORE UPDATE ON trader_follows
  FOR EACH ROW
  EXECUTE FUNCTION update_trader_follows_updated_at();

-- ============================================
-- 完成！
-- ============================================
-- 现在所有 trader 的粉丝数只能来源 Arena 注册用户的关注
-- 使用 trader_follows 表统计粉丝数，不再使用从交易所 API 获取的 followers

