-- =============================================
-- Trader Follows Table Setup
-- 用户关注交易员的关系表
-- =============================================

-- 创建 trader_follows 表
CREATE TABLE IF NOT EXISTS trader_follows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- 确保同一用户不能重复关注同一交易员
  UNIQUE(user_id, trader_id)
);

-- 创建索引以优化查询
CREATE INDEX IF NOT EXISTS idx_trader_follows_user_id ON trader_follows(user_id);
CREATE INDEX IF NOT EXISTS idx_trader_follows_trader_id ON trader_follows(trader_id);
CREATE INDEX IF NOT EXISTS idx_trader_follows_created_at ON trader_follows(created_at DESC);

-- 启用 RLS
ALTER TABLE trader_follows ENABLE ROW LEVEL SECURITY;

-- RLS 策略：用户只能看到自己的关注
DROP POLICY IF EXISTS "Users can view own trader follows" ON trader_follows;
CREATE POLICY "Users can view own trader follows"
  ON trader_follows FOR SELECT
  USING (auth.uid() = user_id);

-- RLS 策略：用户只能创建自己的关注
DROP POLICY IF EXISTS "Users can create own trader follows" ON trader_follows;
CREATE POLICY "Users can create own trader follows"
  ON trader_follows FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- RLS 策略：用户只能删除自己的关注
DROP POLICY IF EXISTS "Users can delete own trader follows" ON trader_follows;
CREATE POLICY "Users can delete own trader follows"
  ON trader_follows FOR DELETE
  USING (auth.uid() = user_id);

-- 授予服务角色完全访问权限
GRANT ALL ON trader_follows TO service_role;

-- 统计函数：获取交易员的关注者数量
CREATE OR REPLACE FUNCTION get_trader_follower_count(p_trader_id TEXT)
RETURNS INTEGER AS $$
BEGIN
  RETURN (
    SELECT COUNT(*)::INTEGER
    FROM trader_follows
    WHERE trader_id = p_trader_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 统计函数：获取用户关注的交易员数量
CREATE OR REPLACE FUNCTION get_user_following_traders_count(p_user_id UUID)
RETURNS INTEGER AS $$
BEGIN
  RETURN (
    SELECT COUNT(*)::INTEGER
    FROM trader_follows
    WHERE user_id = p_user_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
