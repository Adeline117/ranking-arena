-- ============================================
-- 评论点赞系统完整设置脚本
-- 包含：表结构 + RLS策略 + 原子操作函数
-- ============================================

-- ============================================
-- 第一部分：评论点赞表
-- ============================================

CREATE TABLE IF NOT EXISTS comment_likes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  comment_id UUID NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(comment_id, user_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_comment_likes_comment ON comment_likes(comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_likes_user ON comment_likes(user_id);
CREATE INDEX IF NOT EXISTS idx_comment_likes_comment_user ON comment_likes(comment_id, user_id);

-- RLS 策略
ALTER TABLE comment_likes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Comment likes are viewable by everyone" ON comment_likes;
DROP POLICY IF EXISTS "Users can insert their own comment likes" ON comment_likes;
DROP POLICY IF EXISTS "Users can delete their own comment likes" ON comment_likes;

CREATE POLICY "Comment likes are viewable by everyone"
  ON comment_likes FOR SELECT
  USING (true);

CREATE POLICY "Users can insert their own comment likes"
  ON comment_likes FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own comment likes"
  ON comment_likes FOR DELETE
  USING (auth.uid() = user_id);

-- 确保 comments 表有 like_count 字段
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'comments' AND column_name = 'like_count'
  ) THEN
    ALTER TABLE comments ADD COLUMN like_count INTEGER DEFAULT 0;
  END IF;
END $$;

-- ============================================
-- 第二部分：评论点赞原子操作函数
-- 用于安全地增加和减少评论的点赞数，避免并发竞态条件
-- ============================================

-- 增加评论点赞数（原子操作）
CREATE OR REPLACE FUNCTION increment_comment_like_count(p_comment_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_new_count INTEGER;
BEGIN
  UPDATE comments 
  SET like_count = COALESCE(like_count, 0) + 1
  WHERE id = p_comment_id
  RETURNING like_count INTO v_new_count;
  
  RETURN COALESCE(v_new_count, 0);
END;
$$ LANGUAGE plpgsql;

-- 减少评论点赞数（原子操作，确保不会小于0）
CREATE OR REPLACE FUNCTION decrement_comment_like_count(p_comment_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_new_count INTEGER;
BEGIN
  UPDATE comments 
  SET like_count = GREATEST(0, COALESCE(like_count, 0) - 1)
  WHERE id = p_comment_id
  RETURNING like_count INTO v_new_count;
  
  RETURN COALESCE(v_new_count, 0);
END;
$$ LANGUAGE plpgsql;

-- 授予执行权限
GRANT EXECUTE ON FUNCTION increment_comment_like_count(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION decrement_comment_like_count(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION increment_comment_like_count(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION decrement_comment_like_count(UUID) TO service_role;

-- ============================================
-- 完成
-- ============================================
SELECT '✅ 评论点赞系统设置完成！' AS status;
