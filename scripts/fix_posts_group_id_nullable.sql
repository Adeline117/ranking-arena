-- 修复 posts 表：允许 group_id 为 null（个人动态不属于任何小组）
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- 移除 group_id 的 NOT NULL 约束
ALTER TABLE posts ALTER COLUMN group_id DROP NOT NULL;

-- 添加 poll_id 字段（如果不存在）
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'poll_id'
  ) THEN
    ALTER TABLE posts ADD COLUMN poll_id UUID REFERENCES polls(id) ON DELETE SET NULL;
  END IF;
END $$;

SELECT 'posts.group_id 已改为可空，个人动态可以正常发布了！' as result;

