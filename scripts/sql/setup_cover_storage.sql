-- 设置用户背景图片存储的 Storage Bucket 和策略
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- ============================================
-- 1. 添加 cover_url 字段到 user_profiles 表
-- ============================================
ALTER TABLE user_profiles 
ADD COLUMN IF NOT EXISTS cover_url TEXT;

-- 添加注释
COMMENT ON COLUMN user_profiles.cover_url IS '用户个人主页背景图片URL';

-- ============================================
-- 2. 创建 covers bucket（如果不存在）
-- ============================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('covers', 'covers', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- ============================================
-- 3. 删除现有的 Storage 策略
-- ============================================
DROP POLICY IF EXISTS "covers_select" ON storage.objects;
DROP POLICY IF EXISTS "covers_insert" ON storage.objects;
DROP POLICY IF EXISTS "covers_update" ON storage.objects;
DROP POLICY IF EXISTS "covers_delete" ON storage.objects;

-- ============================================
-- 4. 创建新的 Storage 策略
-- ============================================

-- SELECT: 所有人都可以查看背景图片
CREATE POLICY "covers_select"
ON storage.objects FOR SELECT
USING (bucket_id = 'covers');

-- INSERT: 已登录用户可以上传背景图片
CREATE POLICY "covers_insert"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'covers' 
  AND auth.role() = 'authenticated'
);

-- UPDATE: 已登录用户可以更新背景图片
CREATE POLICY "covers_update"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'covers' 
  AND auth.role() = 'authenticated'
)
WITH CHECK (
  bucket_id = 'covers' 
  AND auth.role() = 'authenticated'
);

-- DELETE: 已登录用户可以删除背景图片
CREATE POLICY "covers_delete"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'covers' 
  AND auth.role() = 'authenticated'
);

-- ============================================
-- 完成！
-- ============================================
SELECT 'covers Storage Bucket 设置完成！cover_url 字段已添加到 user_profiles 表' as result;
