-- 修复 posts 表：添加 poll_id 列
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

DO $$ 
BEGIN
  -- 添加 poll_id 字段（如果不存在）
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'poll_id'
  ) THEN
    ALTER TABLE posts ADD COLUMN poll_id UUID REFERENCES polls(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 确保 posts 表的 RLS 策略允许认证用户插入
-- 删除旧策略
DROP POLICY IF EXISTS "Authenticated users can create posts" ON posts;

-- 重新创建策略，确保 author_id 匹配当前用户
CREATE POLICY "Authenticated users can create posts"
  ON posts FOR INSERT
  WITH CHECK (auth.uid() = author_id);

SELECT 'posts 表已修复！' as result;

