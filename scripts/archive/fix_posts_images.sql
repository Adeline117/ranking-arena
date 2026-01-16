-- 修复 posts 表结构
-- 确保 images 字段存在（用于存储图片URL数组）

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

-- 确保 poll_enabled 字段存在
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'poll_enabled'
  ) THEN
    ALTER TABLE posts ADD COLUMN poll_enabled BOOLEAN DEFAULT false;
  END IF;
END $$;

-- 确保投票计数字段存在
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'poll_bull'
  ) THEN
    ALTER TABLE posts ADD COLUMN poll_bull INTEGER DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'poll_bear'
  ) THEN
    ALTER TABLE posts ADD COLUMN poll_bear INTEGER DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'poll_wait'
  ) THEN
    ALTER TABLE posts ADD COLUMN poll_wait INTEGER DEFAULT 0;
  END IF;
END $$;

-- 确保热度分数字段存在
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'hot_score'
  ) THEN
    ALTER TABLE posts ADD COLUMN hot_score INTEGER DEFAULT 0;
  END IF;
END $$;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_posts_images ON posts USING GIN (images);
CREATE INDEX IF NOT EXISTS idx_posts_hot_score ON posts(hot_score DESC NULLS LAST);

-- 完成
-- 运行此脚本后，posts 表将支持图片上传和投票功能

