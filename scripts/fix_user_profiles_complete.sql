-- 完整修复 user_profiles 表结构
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- 1. 如果表存在但结构不对，先删除（谨慎操作）
-- 注意：这会删除所有数据！如果表中有重要数据，请先备份
-- DROP TABLE IF EXISTS user_profiles CASCADE;

-- 2. 创建表（如果不存在）
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  handle TEXT,
  bio TEXT,
  avatar_url TEXT,
  email TEXT,
  market_pairs JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. 确保所有列都存在（如果表已存在但缺少列）
DO $$ 
BEGIN
  -- 确保 id 列存在（主键）
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'user_profiles' AND column_name = 'id'
  ) THEN
    -- 如果表存在但没有 id 列，需要先添加
    ALTER TABLE user_profiles ADD COLUMN id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;

  -- 添加 handle 列
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'user_profiles' AND column_name = 'handle'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN handle TEXT;
  END IF;

  -- 添加 bio 列
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'user_profiles' AND column_name = 'bio'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN bio TEXT;
  END IF;

  -- 添加 avatar_url 列
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'user_profiles' AND column_name = 'avatar_url'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN avatar_url TEXT;
  END IF;

  -- 添加 email 列
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'user_profiles' AND column_name = 'email'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN email TEXT;
  END IF;

  -- 添加 market_pairs 列（MarketPanel 自定义行情用）
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_profiles' AND column_name = 'market_pairs'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN market_pairs JSONB DEFAULT '[]'::jsonb;
  END IF;

  -- 添加 created_at 列
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'user_profiles' AND column_name = 'created_at'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
  END IF;

  -- 添加 updated_at 列
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'user_profiles' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
  END IF;
END $$;

-- 4. 添加唯一约束（如果不存在）
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'user_profiles_handle_key'
  ) THEN
    ALTER TABLE user_profiles ADD CONSTRAINT user_profiles_handle_key UNIQUE (handle);
  END IF;
END $$;

-- 5. 刷新 schema cache（非常重要！）
NOTIFY pgrst, 'reload schema';

-- 6. 验证表结构
SELECT 
  column_name, 
  data_type, 
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public' 
  AND table_name = 'user_profiles'
ORDER BY ordinal_position;

