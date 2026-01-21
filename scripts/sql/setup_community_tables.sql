-- 社区功能相关表结构
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- ============================================
-- 1. 帖子点赞表
-- ============================================
CREATE TABLE IF NOT EXISTS post_likes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reaction_type TEXT DEFAULT 'up' CHECK (reaction_type IN ('up', 'down')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(post_id, user_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_post_likes_post ON post_likes(post_id);
CREATE INDEX IF NOT EXISTS idx_post_likes_user ON post_likes(user_id);

-- RLS 策略
ALTER TABLE post_likes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Post likes are viewable by everyone" ON post_likes;
DROP POLICY IF EXISTS "Users can insert their own likes" ON post_likes;
DROP POLICY IF EXISTS "Users can update their own likes" ON post_likes;
DROP POLICY IF EXISTS "Users can delete their own likes" ON post_likes;

CREATE POLICY "Post likes are viewable by everyone"
  ON post_likes FOR SELECT
  USING (true);

CREATE POLICY "Users can insert their own likes"
  ON post_likes FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own likes"
  ON post_likes FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own likes"
  ON post_likes FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- 2. 帖子投票表（看涨/看跌/观望）
-- ============================================
CREATE TABLE IF NOT EXISTS post_votes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  choice TEXT NOT NULL CHECK (choice IN ('bull', 'bear', 'wait')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(post_id, user_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_post_votes_post ON post_votes(post_id);
CREATE INDEX IF NOT EXISTS idx_post_votes_user ON post_votes(user_id);

-- RLS 策略
ALTER TABLE post_votes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Post votes are viewable by everyone" ON post_votes;
DROP POLICY IF EXISTS "Users can insert their own votes" ON post_votes;
DROP POLICY IF EXISTS "Users can update their own votes" ON post_votes;
DROP POLICY IF EXISTS "Users can delete their own votes" ON post_votes;

CREATE POLICY "Post votes are viewable by everyone"
  ON post_votes FOR SELECT
  USING (true);

CREATE POLICY "Users can insert their own votes"
  ON post_votes FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own votes"
  ON post_votes FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own votes"
  ON post_votes FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- 3. 评论表
-- ============================================
CREATE TABLE IF NOT EXISTS comments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  parent_id UUID REFERENCES comments(id) ON DELETE CASCADE, -- 支持嵌套回复
  like_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_created ON comments(post_id, created_at DESC);

-- RLS 策略
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Comments are viewable by everyone" ON comments;
DROP POLICY IF EXISTS "Users can insert their own comments" ON comments;
DROP POLICY IF EXISTS "Users can update their own comments" ON comments;
DROP POLICY IF EXISTS "Users can delete their own comments" ON comments;

CREATE POLICY "Comments are viewable by everyone"
  ON comments FOR SELECT
  USING (true);

CREATE POLICY "Users can insert their own comments"
  ON comments FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own comments"
  ON comments FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own comments"
  ON comments FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- 4. 通知表
-- ============================================
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('follow', 'like', 'comment', 'system', 'mention')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  read BOOLEAN DEFAULT false,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL, -- 触发通知的用户
  reference_id UUID, -- 相关的帖子/评论等的ID
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(user_id, created_at DESC);

-- RLS 策略
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own notifications" ON notifications;
DROP POLICY IF EXISTS "Users can update their own notifications" ON notifications;

CREATE POLICY "Users can view their own notifications"
  ON notifications FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own notifications"
  ON notifications FOR UPDATE
  USING (auth.uid() = user_id);

-- 允许系统通过触发器创建通知
CREATE POLICY "System can insert notifications"
  ON notifications FOR INSERT
  WITH CHECK (true);

-- ============================================
-- 5. 更新 posts 表结构（添加投票和计数字段）
-- ============================================
DO $$ 
BEGIN
  -- 添加投票启用字段
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'poll_enabled'
  ) THEN
    ALTER TABLE posts ADD COLUMN poll_enabled BOOLEAN DEFAULT false;
  END IF;

  -- 添加看涨票数
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'poll_bull'
  ) THEN
    ALTER TABLE posts ADD COLUMN poll_bull INTEGER DEFAULT 0;
  END IF;

  -- 添加看跌票数
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'poll_bear'
  ) THEN
    ALTER TABLE posts ADD COLUMN poll_bear INTEGER DEFAULT 0;
  END IF;

  -- 添加观望票数
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'poll_wait'
  ) THEN
    ALTER TABLE posts ADD COLUMN poll_wait INTEGER DEFAULT 0;
  END IF;

  -- 添加点赞数
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'like_count'
  ) THEN
    ALTER TABLE posts ADD COLUMN like_count INTEGER DEFAULT 0;
  END IF;

  -- 添加踩数
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'dislike_count'
  ) THEN
    ALTER TABLE posts ADD COLUMN dislike_count INTEGER DEFAULT 0;
  END IF;

  -- 添加评论数
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'comment_count'
  ) THEN
    ALTER TABLE posts ADD COLUMN comment_count INTEGER DEFAULT 0;
  END IF;

  -- 添加浏览数
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'view_count'
  ) THEN
    ALTER TABLE posts ADD COLUMN view_count INTEGER DEFAULT 0;
  END IF;

  -- 添加热度分数
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'hot_score'
  ) THEN
    ALTER TABLE posts ADD COLUMN hot_score INTEGER DEFAULT 0;
  END IF;
END $$;

-- ============================================
-- 6. 触发器：自动更新帖子点赞计数
-- ============================================
CREATE OR REPLACE FUNCTION update_post_like_counts()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.reaction_type = 'up' THEN
      UPDATE posts SET like_count = like_count + 1 WHERE id = NEW.post_id;
    ELSE
      UPDATE posts SET dislike_count = dislike_count + 1 WHERE id = NEW.post_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.reaction_type = 'up' THEN
      UPDATE posts SET like_count = GREATEST(0, like_count - 1) WHERE id = OLD.post_id;
    ELSE
      UPDATE posts SET dislike_count = GREATEST(0, dislike_count - 1) WHERE id = OLD.post_id;
    END IF;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    -- 如果reaction_type改变了
    IF OLD.reaction_type != NEW.reaction_type THEN
      IF OLD.reaction_type = 'up' THEN
        UPDATE posts SET like_count = GREATEST(0, like_count - 1), dislike_count = dislike_count + 1 WHERE id = NEW.post_id;
      ELSE
        UPDATE posts SET dislike_count = GREATEST(0, dislike_count - 1), like_count = like_count + 1 WHERE id = NEW.post_id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_post_like_change ON post_likes;
CREATE TRIGGER on_post_like_change
  AFTER INSERT OR UPDATE OR DELETE ON post_likes
  FOR EACH ROW
  EXECUTE FUNCTION update_post_like_counts();

-- ============================================
-- 7. 触发器：自动更新帖子投票计数
-- ============================================
CREATE OR REPLACE FUNCTION update_post_vote_counts()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.choice = 'bull' THEN
      UPDATE posts SET poll_bull = poll_bull + 1 WHERE id = NEW.post_id;
    ELSIF NEW.choice = 'bear' THEN
      UPDATE posts SET poll_bear = poll_bear + 1 WHERE id = NEW.post_id;
    ELSE
      UPDATE posts SET poll_wait = poll_wait + 1 WHERE id = NEW.post_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.choice = 'bull' THEN
      UPDATE posts SET poll_bull = GREATEST(0, poll_bull - 1) WHERE id = OLD.post_id;
    ELSIF OLD.choice = 'bear' THEN
      UPDATE posts SET poll_bear = GREATEST(0, poll_bear - 1) WHERE id = OLD.post_id;
    ELSE
      UPDATE posts SET poll_wait = GREATEST(0, poll_wait - 1) WHERE id = OLD.post_id;
    END IF;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    -- 如果投票选择改变了
    IF OLD.choice != NEW.choice THEN
      -- 减少旧选项
      IF OLD.choice = 'bull' THEN
        UPDATE posts SET poll_bull = GREATEST(0, poll_bull - 1) WHERE id = NEW.post_id;
      ELSIF OLD.choice = 'bear' THEN
        UPDATE posts SET poll_bear = GREATEST(0, poll_bear - 1) WHERE id = NEW.post_id;
      ELSE
        UPDATE posts SET poll_wait = GREATEST(0, poll_wait - 1) WHERE id = NEW.post_id;
      END IF;
      -- 增加新选项
      IF NEW.choice = 'bull' THEN
        UPDATE posts SET poll_bull = poll_bull + 1 WHERE id = NEW.post_id;
      ELSIF NEW.choice = 'bear' THEN
        UPDATE posts SET poll_bear = poll_bear + 1 WHERE id = NEW.post_id;
      ELSE
        UPDATE posts SET poll_wait = poll_wait + 1 WHERE id = NEW.post_id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_post_vote_change ON post_votes;
CREATE TRIGGER on_post_vote_change
  AFTER INSERT OR UPDATE OR DELETE ON post_votes
  FOR EACH ROW
  EXECUTE FUNCTION update_post_vote_counts();

-- ============================================
-- 8. 触发器：自动更新帖子评论计数
-- ============================================
CREATE OR REPLACE FUNCTION update_post_comment_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE posts SET comment_count = comment_count + 1 WHERE id = NEW.post_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE posts SET comment_count = GREATEST(0, comment_count - 1) WHERE id = OLD.post_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_comment_change ON comments;
CREATE TRIGGER on_comment_change
  AFTER INSERT OR DELETE ON comments
  FOR EACH ROW
  EXECUTE FUNCTION update_post_comment_count();

-- ============================================
-- 9. 触发器：点赞时创建通知
-- ============================================
CREATE OR REPLACE FUNCTION create_like_notification()
RETURNS TRIGGER AS $$
DECLARE
  post_author_id UUID;
  actor_handle TEXT;
  post_title TEXT;
BEGIN
  -- 只有点赞（up）才发通知
  IF NEW.reaction_type = 'up' THEN
    -- 获取帖子作者ID和标题
    SELECT author_id, title INTO post_author_id, post_title FROM posts WHERE id = NEW.post_id;
    
    -- 不给自己发通知
    IF post_author_id IS NOT NULL AND post_author_id != NEW.user_id THEN
      -- 获取点赞者的handle
      SELECT handle INTO actor_handle FROM user_profiles WHERE id = NEW.user_id;
      
      INSERT INTO notifications (user_id, type, title, message, link, actor_id, reference_id)
      VALUES (
        post_author_id,
        'like',
        '收到新的点赞',
        COALESCE(actor_handle, '有人') || ' 赞了你的帖子 "' || COALESCE(LEFT(post_title, 30), '无标题') || '"',
        '/post/' || NEW.post_id,
        NEW.user_id,
        NEW.post_id
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_like_create_notification ON post_likes;
CREATE TRIGGER on_like_create_notification
  AFTER INSERT ON post_likes
  FOR EACH ROW
  EXECUTE FUNCTION create_like_notification();

-- ============================================
-- 10. 触发器：评论时创建通知
-- ============================================
CREATE OR REPLACE FUNCTION create_comment_notification()
RETURNS TRIGGER AS $$
DECLARE
  post_author_id UUID;
  parent_author_id UUID;
  actor_handle TEXT;
  post_title TEXT;
BEGIN
  -- 获取帖子作者ID和标题
  SELECT author_id, title INTO post_author_id, post_title FROM posts WHERE id = NEW.post_id;
  
  -- 获取评论者的handle
  SELECT handle INTO actor_handle FROM user_profiles WHERE id = NEW.user_id;
  
  -- 如果是回复其他评论
  IF NEW.parent_id IS NOT NULL THEN
    SELECT user_id INTO parent_author_id FROM comments WHERE id = NEW.parent_id;
    
    -- 通知被回复的评论作者
    IF parent_author_id IS NOT NULL AND parent_author_id != NEW.user_id THEN
      INSERT INTO notifications (user_id, type, title, message, link, actor_id, reference_id)
      VALUES (
        parent_author_id,
        'comment',
        '收到新的回复',
        COALESCE(actor_handle, '有人') || ' 回复了你的评论',
        '/post/' || NEW.post_id || '#comment-' || NEW.id,
        NEW.user_id,
        NEW.id
      );
    END IF;
  END IF;
  
  -- 通知帖子作者（如果不是评论作者本人，且不是被回复的人）
  IF post_author_id IS NOT NULL AND post_author_id != NEW.user_id AND post_author_id != parent_author_id THEN
    INSERT INTO notifications (user_id, type, title, message, link, actor_id, reference_id)
    VALUES (
      post_author_id,
      'comment',
      '收到新的评论',
      COALESCE(actor_handle, '有人') || ' 评论了你的帖子 "' || COALESCE(LEFT(post_title, 30), '无标题') || '"',
      '/post/' || NEW.post_id || '#comment-' || NEW.id,
      NEW.user_id,
      NEW.id
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_comment_create_notification ON comments;
CREATE TRIGGER on_comment_create_notification
  AFTER INSERT ON comments
  FOR EACH ROW
  EXECUTE FUNCTION create_comment_notification();

-- ============================================
-- 11. 触发器：关注时创建通知
-- ============================================
CREATE OR REPLACE FUNCTION create_follow_notification()
RETURNS TRIGGER AS $$
DECLARE
  actor_handle TEXT;
  followed_user_id UUID;
BEGIN
  -- 获取关注者的handle
  SELECT handle INTO actor_handle FROM user_profiles WHERE id = NEW.follower_id;
  
  -- 尝试从 trader_sources 获取被关注者的用户ID
  SELECT up.id INTO followed_user_id 
  FROM user_profiles up 
  INNER JOIN trader_sources ts ON up.handle = ts.handle
  WHERE ts.source_trader_id = NEW.trader_id
  LIMIT 1;
  
  -- 如果被关注的交易员是注册用户，发送通知
  IF followed_user_id IS NOT NULL AND followed_user_id != NEW.follower_id THEN
    INSERT INTO notifications (user_id, type, title, message, link, actor_id, reference_id)
    VALUES (
      followed_user_id,
      'follow',
      '新粉丝',
      COALESCE(actor_handle, '有人') || ' 关注了你',
      '/u/' || COALESCE(actor_handle, NEW.follower_id::TEXT),
      NEW.follower_id,
      NEW.trader_id::UUID
    );
  END IF;
  
  RETURN NEW;
EXCEPTION
  WHEN others THEN
    -- 忽略错误，不影响关注操作
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 只有在 trader_follows 表存在时才创建触发器
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'trader_follows') THEN
    DROP TRIGGER IF EXISTS on_follow_create_notification ON trader_follows;
    CREATE TRIGGER on_follow_create_notification
      AFTER INSERT ON trader_follows
      FOR EACH ROW
      EXECUTE FUNCTION create_follow_notification();
  END IF;
END $$;

-- ============================================
-- 12. 更新时间自动更新函数
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 13. 评论更新时间触发器
-- ============================================
DROP TRIGGER IF EXISTS update_comments_updated_at ON comments;
CREATE TRIGGER update_comments_updated_at
  BEFORE UPDATE ON comments
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- 完成
-- ============================================
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本后，
-- 社区功能的数据库结构就配置完成了。

