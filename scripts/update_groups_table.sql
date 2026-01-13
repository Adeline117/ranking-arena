-- 更新 groups 表结构
-- 添加头像、描述、成员数等字段

-- 添加 avatar_url 字段（如果不存在）
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'avatar_url'
  ) THEN
    ALTER TABLE groups ADD COLUMN avatar_url TEXT;
  END IF;
END $$;

-- 添加 description 字段（如果不存在）
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'description'
  ) THEN
    ALTER TABLE groups ADD COLUMN description TEXT;
  END IF;
END $$;

-- 添加 member_count 字段（如果不存在）
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'member_count'
  ) THEN
    ALTER TABLE groups ADD COLUMN member_count INTEGER DEFAULT 0;
  END IF;
END $$;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_groups_member_count ON groups(member_count DESC);

-- 创建函数：自动更新 member_count
CREATE OR REPLACE FUNCTION update_group_member_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE groups 
    SET member_count = (
      SELECT COUNT(*) 
      FROM group_members 
      WHERE group_id = NEW.group_id
    )
    WHERE id = NEW.group_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE groups 
    SET member_count = (
      SELECT COUNT(*) 
      FROM group_members 
      WHERE group_id = OLD.group_id
    )
    WHERE id = OLD.group_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 创建触发器：自动更新 member_count
DROP TRIGGER IF EXISTS trigger_update_group_member_count ON group_members;
CREATE TRIGGER trigger_update_group_member_count
  AFTER INSERT OR DELETE ON group_members
  FOR EACH ROW
  EXECUTE FUNCTION update_group_member_count();

-- 初始化现有小组的 member_count
UPDATE groups 
SET member_count = (
  SELECT COUNT(*) 
  FROM group_members 
  WHERE group_members.group_id = groups.id
);

