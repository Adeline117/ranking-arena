-- 修复 user_profiles 表：添加缺失的字段和 RLS 策略
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- ============================================
-- 1. 添加通知设置字段（如果不存在）
-- ============================================
DO $$ 
BEGIN
  -- notify_follow: 有人关注我时通知
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_profiles' AND column_name = 'notify_follow'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN notify_follow BOOLEAN DEFAULT true;
  END IF;

  -- notify_like: 有人点赞我的帖子时通知
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_profiles' AND column_name = 'notify_like'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN notify_like BOOLEAN DEFAULT true;
  END IF;

  -- notify_comment: 有人评论我的帖子时通知
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_profiles' AND column_name = 'notify_comment'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN notify_comment BOOLEAN DEFAULT true;
  END IF;

  -- notify_mention: 有人 @提及 我时通知
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_profiles' AND column_name = 'notify_mention'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN notify_mention BOOLEAN DEFAULT true;
  END IF;

  -- notify_message: 收到私信时通知（可能已存在）
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_profiles' AND column_name = 'notify_message'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN notify_message BOOLEAN DEFAULT true;
  END IF;

  -- show_followers: 展示粉丝列表（可能已存在）
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_profiles' AND column_name = 'show_followers'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN show_followers BOOLEAN DEFAULT true;
  END IF;

  -- show_following: 展示关注列表（可能已存在）
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_profiles' AND column_name = 'show_following'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN show_following BOOLEAN DEFAULT true;
  END IF;

  -- dm_permission: 私信权限（可能已存在）
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_profiles' AND column_name = 'dm_permission'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN dm_permission TEXT DEFAULT 'all' CHECK (dm_permission IN ('all', 'mutual', 'none'));
  END IF;
END $$;

-- ============================================
-- 2. 设置 user_profiles 表的 RLS 策略
-- ============================================
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- 删除现有策略（如果存在）
DROP POLICY IF EXISTS "User profiles are viewable by everyone" ON user_profiles;
DROP POLICY IF EXISTS "Users can insert their own profile" ON user_profiles;
DROP POLICY IF EXISTS "Users can update their own profile" ON user_profiles;
DROP POLICY IF EXISTS "Users can delete their own profile" ON user_profiles;

-- 创建新策略
CREATE POLICY "User profiles are viewable by everyone"
  ON user_profiles FOR SELECT
  USING (true);

CREATE POLICY "Users can insert their own profile"
  ON user_profiles FOR INSERT
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can update their own profile"
  ON user_profiles FOR UPDATE
  USING (auth.uid() = id);

CREATE POLICY "Users can delete their own profile"
  ON user_profiles FOR DELETE
  USING (auth.uid() = id);

-- ============================================
-- 3. 创建索引（如果不存在）
-- ============================================
CREATE INDEX IF NOT EXISTS idx_user_profiles_handle ON user_profiles(handle);
CREATE INDEX IF NOT EXISTS idx_user_profiles_created_at ON user_profiles(created_at DESC);

-- ============================================
-- 完成！
-- ============================================
SELECT 'user_profiles 表修复完成！' as result;

