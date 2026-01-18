-- ============================================
-- 跟单日记功能数据库表
-- 用户记录跟单经历，形成 UGC 内容
-- ============================================

-- ============================================
-- 跟单日记表
-- ============================================

CREATE TABLE IF NOT EXISTS follow_journals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id TEXT NOT NULL,
  source TEXT NOT NULL,
  
  -- 日记内容
  title TEXT,
  content TEXT NOT NULL,
  
  -- 跟单数据
  profit_loss_percent NUMERIC,          -- 盈亏比例
  profit_loss_amount NUMERIC,           -- 盈亏金额
  start_date DATE,                      -- 开始跟单日期
  end_date DATE,                        -- 结束跟单日期（可选，还在跟单则为空）
  initial_capital NUMERIC,              -- 初始资金
  
  -- 媒体
  screenshots TEXT[],                   -- 截图 URLs
  
  -- 标签
  tags TEXT[],                          -- 用户标签
  
  -- 可见性
  visibility TEXT DEFAULT 'public' CHECK (visibility IN ('public', 'followers', 'private')),
  
  -- 互动数据
  like_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  view_count INTEGER DEFAULT 0,
  
  -- 状态
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  is_pinned BOOLEAN DEFAULT FALSE,      -- 是否置顶
  
  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 日记评论表
-- ============================================

CREATE TABLE IF NOT EXISTS journal_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id UUID NOT NULL REFERENCES follow_journals(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES journal_comments(id) ON DELETE CASCADE,  -- 回复
  
  content TEXT NOT NULL,
  like_count INTEGER DEFAULT 0,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 日记点赞表
-- ============================================

CREATE TABLE IF NOT EXISTS journal_likes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id UUID NOT NULL REFERENCES follow_journals(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(journal_id, user_id)
);

-- ============================================
-- 索引优化
-- ============================================

-- 日记索引
CREATE INDEX IF NOT EXISTS idx_journals_user ON follow_journals(user_id);
CREATE INDEX IF NOT EXISTS idx_journals_trader ON follow_journals(trader_id, source);
CREATE INDEX IF NOT EXISTS idx_journals_visibility ON follow_journals(visibility) WHERE visibility = 'public';
CREATE INDEX IF NOT EXISTS idx_journals_created ON follow_journals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_journals_status ON follow_journals(status) WHERE status = 'active';

-- 评论索引
CREATE INDEX IF NOT EXISTS idx_journal_comments_journal ON journal_comments(journal_id);
CREATE INDEX IF NOT EXISTS idx_journal_comments_user ON journal_comments(user_id);
CREATE INDEX IF NOT EXISTS idx_journal_comments_parent ON journal_comments(parent_id);

-- 点赞索引
CREATE INDEX IF NOT EXISTS idx_journal_likes_journal ON journal_likes(journal_id);
CREATE INDEX IF NOT EXISTS idx_journal_likes_user ON journal_likes(user_id);

-- ============================================
-- 自动更新 updated_at 触发器
-- ============================================

CREATE OR REPLACE FUNCTION update_follow_journals_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_follow_journals_updated_at ON follow_journals;
CREATE TRIGGER trg_follow_journals_updated_at
  BEFORE UPDATE ON follow_journals
  FOR EACH ROW
  EXECUTE FUNCTION update_follow_journals_updated_at();

-- ============================================
-- 更新点赞计数触发器
-- ============================================

CREATE OR REPLACE FUNCTION update_journal_like_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE follow_journals SET like_count = like_count + 1 WHERE id = NEW.journal_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE follow_journals SET like_count = like_count - 1 WHERE id = OLD.journal_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_like_count ON journal_likes;
CREATE TRIGGER trg_journal_like_count
  AFTER INSERT OR DELETE ON journal_likes
  FOR EACH ROW
  EXECUTE FUNCTION update_journal_like_count();

-- ============================================
-- 更新评论计数触发器
-- ============================================

CREATE OR REPLACE FUNCTION update_journal_comment_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE follow_journals SET comment_count = comment_count + 1 WHERE id = NEW.journal_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE follow_journals SET comment_count = comment_count - 1 WHERE id = OLD.journal_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_comment_count ON journal_comments;
CREATE TRIGGER trg_journal_comment_count
  AFTER INSERT OR DELETE ON journal_comments
  FOR EACH ROW
  EXECUTE FUNCTION update_journal_comment_count();

-- ============================================
-- Row Level Security (RLS)
-- ============================================

ALTER TABLE follow_journals ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_likes ENABLE ROW LEVEL SECURITY;

-- 日记策略
DROP POLICY IF EXISTS "Public journals are viewable by everyone" ON follow_journals;
CREATE POLICY "Public journals are viewable by everyone" ON follow_journals
  FOR SELECT USING (visibility = 'public' OR auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create their own journals" ON follow_journals;
CREATE POLICY "Users can create their own journals" ON follow_journals
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own journals" ON follow_journals;
CREATE POLICY "Users can update their own journals" ON follow_journals
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own journals" ON follow_journals;
CREATE POLICY "Users can delete their own journals" ON follow_journals
  FOR DELETE USING (auth.uid() = user_id);

-- 评论策略
DROP POLICY IF EXISTS "Comments are viewable by everyone" ON journal_comments;
CREATE POLICY "Comments are viewable by everyone" ON journal_comments
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can create comments" ON journal_comments;
CREATE POLICY "Users can create comments" ON journal_comments
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own comments" ON journal_comments;
CREATE POLICY "Users can update their own comments" ON journal_comments
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own comments" ON journal_comments;
CREATE POLICY "Users can delete their own comments" ON journal_comments
  FOR DELETE USING (auth.uid() = user_id);

-- 点赞策略
DROP POLICY IF EXISTS "Likes are viewable by everyone" ON journal_likes;
CREATE POLICY "Likes are viewable by everyone" ON journal_likes
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can create their own likes" ON journal_likes;
CREATE POLICY "Users can create their own likes" ON journal_likes
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own likes" ON journal_likes;
CREATE POLICY "Users can delete their own likes" ON journal_likes
  FOR DELETE USING (auth.uid() = user_id);
