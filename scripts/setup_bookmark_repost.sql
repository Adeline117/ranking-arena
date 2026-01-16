-- 收藏和转发功能相关表结构
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- ============================================
-- 1. 创建 post_bookmarks 收藏表
-- ============================================
CREATE TABLE IF NOT EXISTS post_bookmarks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(post_id, user_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_post_bookmarks_post ON post_bookmarks(post_id);
CREATE INDEX IF NOT EXISTS idx_post_bookmarks_user ON post_bookmarks(user_id);
CREATE INDEX IF NOT EXISTS idx_post_bookmarks_created ON post_bookmarks(user_id, created_at DESC);

-- RLS 策略
ALTER TABLE post_bookmarks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own bookmarks" ON post_bookmarks;
DROP POLICY IF EXISTS "Users can insert their own bookmarks" ON post_bookmarks;
DROP POLICY IF EXISTS "Users can delete their own bookmarks" ON post_bookmarks;

CREATE POLICY "Users can view their own bookmarks"
  ON post_bookmarks FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own bookmarks"
  ON post_bookmarks FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own bookmarks"
  ON post_bookmarks FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- 2. 创建 reposts 转发表
-- ============================================
CREATE TABLE IF NOT EXISTS reposts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  comment TEXT,                    -- 转发时的评论（可选）
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(post_id, user_id)        -- 每个用户对同一帖子只能转发一次
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_reposts_post ON reposts(post_id);
CREATE INDEX IF NOT EXISTS idx_reposts_user ON reposts(user_id);
CREATE INDEX IF NOT EXISTS idx_reposts_created ON reposts(user_id, created_at DESC);

-- RLS 策略
ALTER TABLE reposts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Reposts are viewable by everyone" ON reposts;
DROP POLICY IF EXISTS "Users can insert their own reposts" ON reposts;
DROP POLICY IF EXISTS "Users can delete their own reposts" ON reposts;

CREATE POLICY "Reposts are viewable by everyone"
  ON reposts FOR SELECT
  USING (true);

CREATE POLICY "Users can insert their own reposts"
  ON reposts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own reposts"
  ON reposts FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- 3. 更新 posts 表，添加 bookmark_count 和 repost_count
-- ============================================
DO $$ 
BEGIN
  -- 添加 bookmark_count 字段
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'bookmark_count'
  ) THEN
    ALTER TABLE posts ADD COLUMN bookmark_count INTEGER DEFAULT 0;
  END IF;

  -- 添加 repost_count 字段
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'repost_count'
  ) THEN
    ALTER TABLE posts ADD COLUMN repost_count INTEGER DEFAULT 0;
  END IF;
END $$;

-- ============================================
-- 4. 触发器：自动更新帖子收藏计数
-- ============================================
CREATE OR REPLACE FUNCTION update_post_bookmark_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE posts SET bookmark_count = bookmark_count + 1 WHERE id = NEW.post_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE posts SET bookmark_count = GREATEST(0, bookmark_count - 1) WHERE id = OLD.post_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_post_bookmark_change ON post_bookmarks;
CREATE TRIGGER on_post_bookmark_change
  AFTER INSERT OR DELETE ON post_bookmarks
  FOR EACH ROW
  EXECUTE FUNCTION update_post_bookmark_count();

-- ============================================
-- 5. 触发器：自动更新帖子转发计数
-- ============================================
CREATE OR REPLACE FUNCTION update_post_repost_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE posts SET repost_count = repost_count + 1 WHERE id = NEW.post_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE posts SET repost_count = GREATEST(0, repost_count - 1) WHERE id = OLD.post_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_post_repost_change ON reposts;
CREATE TRIGGER on_post_repost_change
  AFTER INSERT OR DELETE ON reposts
  FOR EACH ROW
  EXECUTE FUNCTION update_post_repost_count();

-- ============================================
-- 6. 触发器：转发时创建通知
-- ============================================
CREATE OR REPLACE FUNCTION create_repost_notification()
RETURNS TRIGGER AS $$
DECLARE
  post_author_id UUID;
  reposter_handle TEXT;
  post_title TEXT;
BEGIN
  -- 获取帖子作者ID和标题
  SELECT author_id, title INTO post_author_id, post_title FROM posts WHERE id = NEW.post_id;
  
  -- 不给自己发通知
  IF post_author_id IS NOT NULL AND post_author_id != NEW.user_id THEN
    -- 获取转发者的handle
    SELECT handle INTO reposter_handle FROM user_profiles WHERE id = NEW.user_id;
    
    INSERT INTO notifications (user_id, type, title, message, link, actor_id, reference_id)
    VALUES (
      post_author_id,
      'system',
      '帖子被转发',
      COALESCE(reposter_handle, '有人') || ' 转发了你的帖子 "' || COALESCE(LEFT(post_title, 30), '无标题') || '"',
      '/post/' || NEW.post_id,
      NEW.user_id,
      NEW.post_id
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_repost_create_notification ON reposts;
CREATE TRIGGER on_repost_create_notification
  AFTER INSERT ON reposts
  FOR EACH ROW
  EXECUTE FUNCTION create_repost_notification();

-- ============================================
-- 完成
-- ============================================
-- 运行此脚本后，收藏和转发功能的数据库结构就配置完成了。


