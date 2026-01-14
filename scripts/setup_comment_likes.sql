-- 评论点赞表
-- 用于存储用户对评论的点赞

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

-- 完成

