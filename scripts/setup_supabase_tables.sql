-- Supabase 数据库表结构和 RLS 策略配置脚本
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- ============================================
-- 1. 创建 profiles 表（如果不存在）
-- ============================================
-- 注意：如果 user_profiles 表已存在，可以跳过此步骤
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  handle TEXT UNIQUE,
  bio TEXT,
  avatar_url TEXT,
  email TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 如果 profiles 表不存在但 user_profiles 存在，创建一个视图
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'profiles')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_profiles') THEN
    -- 创建视图，让代码可以同时使用 profiles 和 user_profiles
    CREATE OR REPLACE VIEW profiles AS SELECT * FROM user_profiles;
  END IF;
END $$;

-- ============================================
-- 2. 创建 user_profiles 表（备用）
-- ============================================
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  handle TEXT UNIQUE,
  bio TEXT,
  avatar_url TEXT,
  email TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- 3. 更新 posts 表（添加 author_id 和 author_handle）
-- ============================================
-- 如果 posts 表不存在，需要先创建
-- 这里假设 posts 表已存在，只添加字段
DO $$ 
BEGIN
  -- 添加 author_id 字段（如果不存在）
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'author_id'
  ) THEN
    ALTER TABLE posts ADD COLUMN author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;

  -- 添加 author_handle 字段（如果不存在）
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'author_handle'
  ) THEN
    ALTER TABLE posts ADD COLUMN author_handle TEXT;
  END IF;
END $$;

-- ============================================
-- 4. 创建索引
-- ============================================
CREATE INDEX IF NOT EXISTS idx_profiles_handle ON profiles(handle);
CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles(email);
CREATE INDEX IF NOT EXISTS idx_posts_author_id ON posts(author_id);
CREATE INDEX IF NOT EXISTS idx_posts_author_handle ON posts(author_handle);
CREATE INDEX IF NOT EXISTS idx_posts_group_id ON posts(group_id);

-- ============================================
-- 5. 设置 profiles 表的 RLS 策略
-- ============================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- 删除现有策略（如果存在）
DROP POLICY IF EXISTS "Profiles are viewable by everyone" ON profiles;
DROP POLICY IF EXISTS "Users can insert their own profile" ON profiles;
DROP POLICY IF EXISTS "Users can update their own profile" ON profiles;
DROP POLICY IF EXISTS "Users can delete their own profile" ON profiles;

-- 创建新策略
CREATE POLICY "Profiles are viewable by everyone"
  ON profiles FOR SELECT
  USING (true);

CREATE POLICY "Users can insert their own profile"
  ON profiles FOR INSERT
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can update their own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = id);

CREATE POLICY "Users can delete their own profile"
  ON profiles FOR DELETE
  USING (auth.uid() = id);

-- ============================================
-- 6. 设置 posts 表的 RLS 策略
-- ============================================
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;

-- 删除现有策略（如果存在）
DROP POLICY IF EXISTS "Posts are viewable by everyone" ON posts;
DROP POLICY IF EXISTS "Authenticated users can create posts" ON posts;
DROP POLICY IF EXISTS "Users can update their own posts" ON posts;
DROP POLICY IF EXISTS "Users can delete their own posts" ON posts;

-- 创建新策略
CREATE POLICY "Posts are viewable by everyone"
  ON posts FOR SELECT
  USING (true);

CREATE POLICY "Authenticated users can create posts"
  ON posts FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Users can update their own posts"
  ON posts FOR UPDATE
  USING (auth.uid() = author_id);

CREATE POLICY "Users can delete their own posts"
  ON posts FOR DELETE
  USING (auth.uid() = author_id);

-- ============================================
-- 7. 创建触发器：自动创建 profile
-- ============================================
-- 函数：创建用户 profile（兼容 profiles 和 user_profiles 表）
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  -- 尝试插入到 profiles 表
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'profiles') THEN
    INSERT INTO public.profiles (id, email, handle)
    VALUES (
      NEW.id,
      NEW.email,
      COALESCE(
        NEW.raw_user_meta_data->>'handle',
        split_part(NEW.email, '@', 1)
      )
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;
  
  -- 尝试插入到 user_profiles 表
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_profiles') THEN
    INSERT INTO public.user_profiles (id, email, handle)
    VALUES (
      NEW.id,
      NEW.email,
      COALESCE(
        NEW.raw_user_meta_data->>'handle',
        split_part(NEW.email, '@', 1)
      )
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 删除现有触发器（如果存在）
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- 创建触发器
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ============================================
-- 8. 为现有用户创建 profiles（如果还没有）
-- ============================================
-- 为 profiles 表创建
DO $$ 
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'profiles') THEN
    INSERT INTO profiles (id, email, handle)
    SELECT 
      id,
      email,
      COALESCE(
        raw_user_meta_data->>'handle',
        split_part(email, '@', 1)
      ) as handle
    FROM auth.users
    WHERE id NOT IN (SELECT id FROM profiles)
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- 为 user_profiles 表创建
DO $$ 
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_profiles') THEN
    INSERT INTO user_profiles (id, email, handle)
    SELECT 
      id,
      email,
      COALESCE(
        raw_user_meta_data->>'handle',
        split_part(email, '@', 1)
      ) as handle
    FROM auth.users
    WHERE id NOT IN (SELECT id FROM user_profiles)
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- ============================================
-- 完成！
-- ============================================
-- 现在可以测试注册和发帖功能了

