-- 更新 posts 表结构
-- 添加链接、图片、投票等字段

-- 添加 links 字段（JSONB，存储链接数组）
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'links'
  ) THEN
    ALTER TABLE posts ADD COLUMN links JSONB DEFAULT '[]'::jsonb;
  END IF;
END $$;

-- 添加 images 字段（TEXT[]，存储图片 URL 数组）
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'images'
  ) THEN
    ALTER TABLE posts ADD COLUMN images TEXT[] DEFAULT ARRAY[]::TEXT[];
  END IF;
END $$;

-- 添加 poll_id 字段（关联投票表）
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'poll_id'
  ) THEN
    ALTER TABLE posts ADD COLUMN poll_id UUID REFERENCES polls(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_posts_poll_id ON posts(poll_id);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_like_count ON posts(like_count DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_posts_comment_count ON posts(comment_count DESC NULLS LAST);

