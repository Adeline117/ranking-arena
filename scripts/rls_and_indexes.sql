-- RLS 与索引（上线必备）
-- ✅ 幂等：可重复执行；缺表会自动创建

-- ============================================
-- 0) 创建缺失表（只创建代码当前用到的最小字段）
-- ============================================

-- user_profiles（如果你已跑过 fix_user_profiles_complete.sql，这里不会改动）
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  handle TEXT UNIQUE,
  bio TEXT,
  avatar_url TEXT,
  email TEXT,
  market_pairs JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- posts（用于小组/搜索/发帖）
CREATE TABLE IF NOT EXISTS posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id TEXT,
  title TEXT,
  content TEXT,
  author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  author_handle TEXT,
  like_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- groups
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subtitle TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- group_members
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);

-- follows（当前前端使用 user_id / trader_id 两列）
CREATE TABLE IF NOT EXISTS follows (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- account_bindings（设置页用）
CREATE TABLE IF NOT EXISTS account_bindings (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  account_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (user_id, platform)
);

-- cron_logs（cron 记录）
CREATE TABLE IF NOT EXISTS cron_logs (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  ran_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  result TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- gifts（打赏）
CREATE TABLE IF NOT EXISTS gifts (
  id BIGSERIAL PRIMARY KEY,
  post_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 1) user_profiles
ALTER TABLE IF EXISTS user_profiles ENABLE ROW LEVEL SECURITY;

-- 任何人可读（公开字段）
DO $$
BEGIN
  IF to_regclass('public.user_profiles') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='user_profiles' AND policyname='user_profiles_read_all'
  ) THEN
    CREATE POLICY user_profiles_read_all ON user_profiles
      FOR SELECT USING (true);
  END IF;
END $$;

-- 仅本人可写
DO $$
BEGIN
  IF to_regclass('public.user_profiles') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='user_profiles' AND policyname='user_profiles_write_self'
  ) THEN
    CREATE POLICY user_profiles_write_self ON user_profiles
      FOR INSERT WITH CHECK (auth.uid() = id);
    CREATE POLICY user_profiles_update_self ON user_profiles
      FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
  END IF;
END $$;

-- 唯一索引
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_handle_unique ON user_profiles(handle);

-- 2) posts
ALTER TABLE IF EXISTS posts ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF to_regclass('public.posts') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='posts' AND policyname='posts_read_all'
  ) THEN
    CREATE POLICY posts_read_all ON posts FOR SELECT USING (true);
  END IF;
  IF to_regclass('public.posts') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='posts' AND policyname='posts_write_self'
  ) THEN
    CREATE POLICY posts_write_self ON posts FOR INSERT WITH CHECK (auth.uid() = author_id);
    CREATE POLICY posts_update_self ON posts FOR UPDATE USING (auth.uid() = author_id) WITH CHECK (auth.uid() = author_id);
    CREATE POLICY posts_delete_self ON posts FOR DELETE USING (auth.uid() = author_id);
  END IF;
END $$;

-- 3) follows
ALTER TABLE IF EXISTS follows ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF to_regclass('public.follows') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='follows' AND policyname='follows_read_all'
  ) THEN
    CREATE POLICY follows_read_all ON follows FOR SELECT USING (true);
  END IF;
  IF to_regclass('public.follows') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='follows' AND policyname='follows_write_self'
  ) THEN
    CREATE POLICY follows_write_self ON follows FOR INSERT WITH CHECK (auth.uid() = user_id);
    CREATE POLICY follows_delete_self ON follows FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

-- 去重约束
DO $$
BEGIN
  IF to_regclass('public.follows') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='follows' AND indexname='idx_follows_unique_pair'
  ) THEN
    CREATE UNIQUE INDEX idx_follows_unique_pair ON follows(user_id, trader_id);
  END IF;
END $$;

-- 4) Storage（avatars）：
-- 注意：很多 Supabase 项目里 storage.objects 的 owner 不是当前 SQL Editor 角色，
-- 会触发：ERROR 42501 must be owner of table objects
-- 因此这里改为“尽力而为”，失败也不阻断后续表/索引创建。
DO $$
BEGIN
  -- 创建 bucket（可能因权限失败）
  BEGIN
    insert into storage.buckets (id, name, public)
    select 'avatars', 'avatars', true
    where not exists (select 1 from storage.buckets where id='avatars');
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skip: no privilege to insert storage.buckets. Please create bucket avatars in Dashboard.';
  WHEN undefined_table THEN
    RAISE NOTICE 'Skip: storage.buckets not found (storage not enabled).';
  END;

  -- 创建 policies（可能因不是 owner 失败）
  BEGIN
    ALTER TABLE IF EXISTS storage.objects ENABLE ROW LEVEL SECURITY;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='avatars_read'
    ) THEN
      CREATE POLICY avatars_read ON storage.objects
        FOR SELECT USING (bucket_id = 'avatars');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='avatars_write_self'
    ) THEN
      CREATE POLICY avatars_write_self ON storage.objects
        FOR INSERT WITH CHECK (bucket_id = 'avatars' AND (auth.uid()::text = (storage.foldername(name))[1]));
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skip: no privilege to alter/create policy on storage.objects. Configure Storage policies in Dashboard.';
  WHEN undefined_table THEN
    RAISE NOTICE 'Skip: storage.objects not found (storage not enabled).';
  END;
END $$;

-- 5) 常用索引
CREATE INDEX IF NOT EXISTS idx_posts_author_created_at ON posts(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_source_captured_at ON trader_snapshots(source, captured_at DESC);

-- 刷新 schema
NOTIFY pgrst, 'reload schema';


