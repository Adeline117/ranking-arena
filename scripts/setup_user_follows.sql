-- =============================================
-- User Follows Table Setup
-- 用户互相关注的关系表
-- =============================================

-- 创建 user_follows 表
CREATE TABLE IF NOT EXISTS user_follows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  following_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- 确保同一用户不能重复关注同一用户
  UNIQUE(follower_id, following_id),
  -- 防止自己关注自己
  CHECK (follower_id != following_id)
);

-- 创建索引以优化查询
CREATE INDEX IF NOT EXISTS idx_user_follows_follower_id ON user_follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_following_id ON user_follows(following_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_created_at ON user_follows(created_at DESC);

-- 启用 RLS
ALTER TABLE user_follows ENABLE ROW LEVEL SECURITY;

-- RLS 策略：任何人都可以查看关注关系
DROP POLICY IF EXISTS "Anyone can view user follows" ON user_follows;
CREATE POLICY "Anyone can view user follows"
  ON user_follows FOR SELECT
  USING (true);

-- RLS 策略：用户只能创建自己的关注
DROP POLICY IF EXISTS "Users can create own follows" ON user_follows;
CREATE POLICY "Users can create own follows"
  ON user_follows FOR INSERT
  WITH CHECK (auth.uid() = follower_id);

-- RLS 策略：用户只能删除自己的关注
DROP POLICY IF EXISTS "Users can delete own follows" ON user_follows;
CREATE POLICY "Users can delete own follows"
  ON user_follows FOR DELETE
  USING (auth.uid() = follower_id);

-- 授予服务角色完全访问权限
GRANT ALL ON user_follows TO service_role;

-- 统计函数：获取用户的粉丝数量
CREATE OR REPLACE FUNCTION get_user_follower_count(p_user_id UUID)
RETURNS INTEGER AS $$
BEGIN
  RETURN (
    SELECT COUNT(*)::INTEGER
    FROM user_follows
    WHERE following_id = p_user_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 统计函数：获取用户关注的人数
CREATE OR REPLACE FUNCTION get_user_following_count(p_user_id UUID)
RETURNS INTEGER AS $$
BEGIN
  RETURN (
    SELECT COUNT(*)::INTEGER
    FROM user_follows
    WHERE follower_id = p_user_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 检查是否互相关注
CREATE OR REPLACE FUNCTION check_mutual_follow(p_user1_id UUID, p_user2_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM user_follows WHERE follower_id = p_user1_id AND following_id = p_user2_id
  ) AND EXISTS (
    SELECT 1 FROM user_follows WHERE follower_id = p_user2_id AND following_id = p_user1_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
