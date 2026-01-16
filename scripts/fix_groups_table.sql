-- 修复 groups 表结构
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- ============================================
-- 1. 添加缺失的列到 groups 表
-- ============================================

-- 添加 member_count 列
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'member_count'
  ) THEN
    ALTER TABLE groups ADD COLUMN member_count INTEGER DEFAULT 0;
  END IF;
END $$;

-- 添加 avatar_url 列
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'avatar_url'
  ) THEN
    ALTER TABLE groups ADD COLUMN avatar_url TEXT;
  END IF;
END $$;

-- 添加 description 列
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'description'
  ) THEN
    ALTER TABLE groups ADD COLUMN description TEXT;
  END IF;
END $$;

-- 添加 description_en 列
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'description_en'
  ) THEN
    ALTER TABLE groups ADD COLUMN description_en TEXT;
  END IF;
END $$;

-- 添加 name_en 列
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'name_en'
  ) THEN
    ALTER TABLE groups ADD COLUMN name_en TEXT;
  END IF;
END $$;

-- 添加 created_by 列
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'created_by'
  ) THEN
    ALTER TABLE groups ADD COLUMN created_by UUID REFERENCES auth.users(id);
  END IF;
END $$;

-- 添加 role_names 列 (JSONB)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'role_names'
  ) THEN
    ALTER TABLE groups ADD COLUMN role_names JSONB DEFAULT '{}';
  END IF;
END $$;

-- ============================================
-- 2. 添加 posts 表缺失的列
-- ============================================

-- 添加 bookmark_count 列
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'bookmark_count'
  ) THEN
    ALTER TABLE posts ADD COLUMN bookmark_count INTEGER DEFAULT 0;
  END IF;
END $$;

-- 添加 repost_count 列
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'repost_count'
  ) THEN
    ALTER TABLE posts ADD COLUMN repost_count INTEGER DEFAULT 0;
  END IF;
END $$;

-- ============================================
-- 3. 创建 group_members 表（如果不存在）
-- ============================================

CREATE TABLE IF NOT EXISTS group_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member', -- 'owner', 'admin', 'member'
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, user_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);

-- RLS 策略
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Group members are viewable by everyone" ON group_members;
CREATE POLICY "Group members are viewable by everyone"
  ON group_members FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can join groups" ON group_members;
CREATE POLICY "Users can join groups"
  ON group_members FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can leave groups" ON group_members;
CREATE POLICY "Users can leave groups"
  ON group_members FOR DELETE USING (auth.uid() = user_id);

-- ============================================
-- 4. 创建触发器：自动更新 member_count
-- ============================================

CREATE OR REPLACE FUNCTION update_group_member_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE groups SET member_count = member_count + 1 WHERE id = NEW.group_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE groups SET member_count = GREATEST(0, member_count - 1) WHERE id = OLD.group_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_group_member_change ON group_members;
CREATE TRIGGER on_group_member_change
  AFTER INSERT OR DELETE ON group_members
  FOR EACH ROW
  EXECUTE FUNCTION update_group_member_count();

-- ============================================
-- 5. 确保 groups 表有 RLS 策略
-- ============================================

ALTER TABLE groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Groups are viewable by everyone" ON groups;
CREATE POLICY "Groups are viewable by everyone"
  ON groups FOR SELECT USING (true);

-- ============================================
-- 完成
-- ============================================

SELECT 'groups 表结构修复完成！' AS status;


