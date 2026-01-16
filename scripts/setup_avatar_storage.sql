-- 设置头像存储的 Storage Bucket 和策略
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- ============================================
-- 1. 创建 avatars bucket（如果不存在）
-- ============================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- ============================================
-- 2. 删除现有的 Storage 策略
-- ============================================
DROP POLICY IF EXISTS "Avatar images are publicly accessible" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload their own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own avatar" ON storage.objects;
DROP POLICY IF EXISTS "avatars_select" ON storage.objects;
DROP POLICY IF EXISTS "avatars_insert" ON storage.objects;
DROP POLICY IF EXISTS "avatars_update" ON storage.objects;
DROP POLICY IF EXISTS "avatars_delete" ON storage.objects;

-- ============================================
-- 3. 创建新的 Storage 策略
-- ============================================

-- SELECT: 所有人都可以查看头像
CREATE POLICY "avatars_select"
ON storage.objects FOR SELECT
USING (bucket_id = 'avatars');

-- INSERT: 已登录用户可以上传头像
CREATE POLICY "avatars_insert"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'avatars' 
  AND auth.role() = 'authenticated'
);

-- UPDATE: 已登录用户可以更新头像
CREATE POLICY "avatars_update"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'avatars' 
  AND auth.role() = 'authenticated'
)
WITH CHECK (
  bucket_id = 'avatars' 
  AND auth.role() = 'authenticated'
);

-- DELETE: 已登录用户可以删除头像
CREATE POLICY "avatars_delete"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'avatars' 
  AND auth.role() = 'authenticated'
);

-- ============================================
-- 完成！
-- ============================================
SELECT 'avatars Storage Bucket 设置完成！' as result;


