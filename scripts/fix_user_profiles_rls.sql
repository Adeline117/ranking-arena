-- 修复 user_profiles 表的 RLS 策略
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- ============================================
-- 1. 确保 RLS 已启用
-- ============================================
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- ============================================
-- 2. 删除所有现有策略
-- ============================================
DROP POLICY IF EXISTS "User profiles are viewable by everyone" ON user_profiles;
DROP POLICY IF EXISTS "Users can insert their own profile" ON user_profiles;
DROP POLICY IF EXISTS "Users can update their own profile" ON user_profiles;
DROP POLICY IF EXISTS "Users can delete their own profile" ON user_profiles;
DROP POLICY IF EXISTS "Enable read access for all users" ON user_profiles;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON user_profiles;
DROP POLICY IF EXISTS "Enable update for users based on id" ON user_profiles;
DROP POLICY IF EXISTS "Enable delete for users based on id" ON user_profiles;
DROP POLICY IF EXISTS "user_profiles_select" ON user_profiles;
DROP POLICY IF EXISTS "user_profiles_insert" ON user_profiles;
DROP POLICY IF EXISTS "user_profiles_update" ON user_profiles;
DROP POLICY IF EXISTS "user_profiles_delete" ON user_profiles;

-- ============================================
-- 3. 创建新的 RLS 策略
-- ============================================

-- SELECT: 所有人都可以查看
CREATE POLICY "user_profiles_select"
  ON user_profiles FOR SELECT
  USING (true);

-- INSERT: 用户只能插入自己的 profile（id 必须等于 auth.uid()）
CREATE POLICY "user_profiles_insert"
  ON user_profiles FOR INSERT
  WITH CHECK (auth.uid() = id);

-- UPDATE: 用户只能更新自己的 profile
CREATE POLICY "user_profiles_update"
  ON user_profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- DELETE: 用户只能删除自己的 profile
CREATE POLICY "user_profiles_delete"
  ON user_profiles FOR DELETE
  USING (auth.uid() = id);

-- ============================================
-- 4. 验证策略已创建
-- ============================================
SELECT 
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies 
WHERE tablename = 'user_profiles';

-- ============================================
-- 完成！
-- ============================================
SELECT 'user_profiles RLS 策略修复完成！' as result;

