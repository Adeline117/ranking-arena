-- 设置帖子图片存储的 Storage Bucket 和策略
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- ============================================
-- 1. 创建 posts bucket（如果不存在）
-- ============================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'posts',
  'posts',
  true,
  5242880, -- 5MB
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = true,
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];

-- ============================================
-- 2. 删除现有的 Storage 策略（如果存在）
-- ============================================
DROP POLICY IF EXISTS "posts_select" ON storage.objects;
DROP POLICY IF EXISTS "posts_insert" ON storage.objects;
DROP POLICY IF EXISTS "posts_update" ON storage.objects;
DROP POLICY IF EXISTS "posts_delete" ON storage.objects;
DROP POLICY IF EXISTS "Post images are publicly accessible" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload post images" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their post images" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their post images" ON storage.objects;

-- ============================================
-- 3. 创建新的 Storage 策略
-- ============================================

-- SELECT: 所有人都可以查看帖子图片（公开访问）
CREATE POLICY "posts_select"
ON storage.objects FOR SELECT
USING (bucket_id = 'posts');

-- INSERT: 已登录用户可以上传帖子图片
-- 文件路径格式: {userId}/{timestamp}-{random}.{ext}
CREATE POLICY "posts_insert"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'posts'
  AND auth.role() = 'authenticated'
);

-- UPDATE: 用户只能更新自己上传的图片
CREATE POLICY "posts_update"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'posts'
  AND auth.role() = 'authenticated'
  AND (storage.foldername(name))[1] = auth.uid()::text
)
WITH CHECK (
  bucket_id = 'posts'
  AND auth.role() = 'authenticated'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- DELETE: 用户只能删除自己上传的图片
CREATE POLICY "posts_delete"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'posts'
  AND auth.role() = 'authenticated'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- ============================================
-- 完成！
-- ============================================
SELECT 'posts Storage Bucket 设置完成！' as result;
