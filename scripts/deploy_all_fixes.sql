-- =============================================
-- 一键部署所有修复的数据库脚本
-- 在 Supabase SQL Editor 中运行此脚本
-- =============================================

-- ============================================
-- 1. 原子计数函数
-- ============================================

-- 原子递增书签计数
CREATE OR REPLACE FUNCTION increment_bookmark_count(post_id UUID)
RETURNS TABLE(bookmark_count INTEGER) AS $$
BEGIN
  RETURN QUERY
  UPDATE posts
  SET bookmark_count = COALESCE(posts.bookmark_count, 0) + 1
  WHERE id = post_id
  RETURNING posts.bookmark_count;
END;
$$ LANGUAGE plpgsql;

-- 原子递减书签计数
CREATE OR REPLACE FUNCTION decrement_bookmark_count(post_id UUID)
RETURNS TABLE(bookmark_count INTEGER) AS $$
BEGIN
  RETURN QUERY
  UPDATE posts
  SET bookmark_count = GREATEST(0, COALESCE(posts.bookmark_count, 1) - 1)
  WHERE id = post_id
  RETURNING posts.bookmark_count;
END;
$$ LANGUAGE plpgsql;

-- 原子递增点赞计数
CREATE OR REPLACE FUNCTION increment_like_count(post_id UUID)
RETURNS TABLE(like_count INTEGER) AS $$
BEGIN
  RETURN QUERY
  UPDATE posts
  SET like_count = COALESCE(posts.like_count, 0) + 1
  WHERE id = post_id
  RETURNING posts.like_count;
END;
$$ LANGUAGE plpgsql;

-- 原子递减点赞计数
CREATE OR REPLACE FUNCTION decrement_like_count(post_id UUID)
RETURNS TABLE(like_count INTEGER) AS $$
BEGIN
  RETURN QUERY
  UPDATE posts
  SET like_count = GREATEST(0, COALESCE(posts.like_count, 1) - 1)
  WHERE id = post_id
  RETURNING posts.like_count;
END;
$$ LANGUAGE plpgsql;

-- 原子递增浏览计数
CREATE OR REPLACE FUNCTION increment_view_count(post_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE posts
  SET view_count = COALESCE(view_count, 0) + 1
  WHERE id = post_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 2. 交易员关注表
-- ============================================

CREATE TABLE IF NOT EXISTS trader_follows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, trader_id)
);

CREATE INDEX IF NOT EXISTS idx_trader_follows_user_id ON trader_follows(user_id);
CREATE INDEX IF NOT EXISTS idx_trader_follows_trader_id ON trader_follows(trader_id);
CREATE INDEX IF NOT EXISTS idx_trader_follows_created_at ON trader_follows(created_at DESC);

ALTER TABLE trader_follows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own trader follows" ON trader_follows;
CREATE POLICY "Users can view own trader follows"
  ON trader_follows FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create own trader follows" ON trader_follows;
CREATE POLICY "Users can create own trader follows"
  ON trader_follows FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own trader follows" ON trader_follows;
CREATE POLICY "Users can delete own trader follows"
  ON trader_follows FOR DELETE USING (auth.uid() = user_id);

GRANT ALL ON trader_follows TO service_role;

-- ============================================
-- 3. 用户互关表
-- ============================================

CREATE TABLE IF NOT EXISTS user_follows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  following_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(follower_id, following_id),
  CHECK (follower_id != following_id)
);

CREATE INDEX IF NOT EXISTS idx_user_follows_follower_id ON user_follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_following_id ON user_follows(following_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_created_at ON user_follows(created_at DESC);

ALTER TABLE user_follows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view user follows" ON user_follows;
CREATE POLICY "Anyone can view user follows"
  ON user_follows FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can create own follows" ON user_follows;
CREATE POLICY "Users can create own follows"
  ON user_follows FOR INSERT WITH CHECK (auth.uid() = follower_id);

DROP POLICY IF EXISTS "Users can delete own follows" ON user_follows;
CREATE POLICY "Users can delete own follows"
  ON user_follows FOR DELETE USING (auth.uid() = follower_id);

GRANT ALL ON user_follows TO service_role;

-- ============================================
-- 4. 统计函数
-- ============================================

CREATE OR REPLACE FUNCTION get_trader_follower_count(p_trader_id TEXT)
RETURNS INTEGER AS $$
BEGIN
  RETURN (SELECT COUNT(*)::INTEGER FROM trader_follows WHERE trader_id = p_trader_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_user_following_traders_count(p_user_id UUID)
RETURNS INTEGER AS $$
BEGIN
  RETURN (SELECT COUNT(*)::INTEGER FROM trader_follows WHERE user_id = p_user_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_user_follower_count(p_user_id UUID)
RETURNS INTEGER AS $$
BEGIN
  RETURN (SELECT COUNT(*)::INTEGER FROM user_follows WHERE following_id = p_user_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_user_following_count(p_user_id UUID)
RETURNS INTEGER AS $$
BEGIN
  RETURN (SELECT COUNT(*)::INTEGER FROM user_follows WHERE follower_id = p_user_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

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

-- ============================================
-- 完成
-- ============================================
SELECT '✅ 所有修复脚本执行完成!' as result;
