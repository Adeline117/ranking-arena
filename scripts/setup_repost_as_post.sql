-- 转发功能重构：转发创建新帖子
-- 添加 original_post_id 字段到 posts 表，用于关联原始帖子

-- 1. 添加 original_post_id 字段
ALTER TABLE posts ADD COLUMN IF NOT EXISTS original_post_id UUID REFERENCES posts(id) ON DELETE SET NULL;

-- 2. 创建索引以加速查询
CREATE INDEX IF NOT EXISTS idx_posts_original_post_id ON posts(original_post_id) WHERE original_post_id IS NOT NULL;

-- 3. 注释：转发帖子的结构
-- - original_post_id: 指向被转发的原始帖子
-- - title: 转发者的评论标题（可为空）
-- - content: 转发者的评论内容（可为空）
-- - author_id/author_handle: 转发者
-- - 其他字段正常使用

COMMENT ON COLUMN posts.original_post_id IS '转发帖子：指向被转发的原始帖子ID';
