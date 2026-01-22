-- 群组成员计数自动同步
-- 版本: 00014
-- 创建日期: 2026-01-21
-- 说明: 添加触发器自动同步 groups.member_count 与 group_members 表

-- ============================================
-- 创建成员计数同步函数
-- ============================================

CREATE OR REPLACE FUNCTION sync_group_member_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- 新成员加入，计数 +1
    UPDATE groups
    SET member_count = member_count + 1,
        updated_at = NOW()
    WHERE id = NEW.group_id;
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    -- 成员离开，计数 -1
    UPDATE groups
    SET member_count = GREATEST(member_count - 1, 0),
        updated_at = NOW()
    WHERE id = OLD.group_id;
    RETURN OLD;

  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION sync_group_member_count IS '自动同步群组成员计数，确保 groups.member_count 与实际成员数一致';

-- ============================================
-- 创建触发器
-- ============================================

-- 删除已存在的触发器（如果有）
DROP TRIGGER IF EXISTS trigger_sync_member_count ON group_members;

-- 创建新触发器
CREATE TRIGGER trigger_sync_member_count
AFTER INSERT OR DELETE ON group_members
FOR EACH ROW
EXECUTE FUNCTION sync_group_member_count();

COMMENT ON TRIGGER trigger_sync_member_count ON group_members IS '成员加入或离开时自动更新群组成员计数';

-- ============================================
-- 一次性同步现有数据
-- ============================================

-- 修复任何现有的计数不一致
UPDATE groups g
SET member_count = (
  SELECT COUNT(*)
  FROM group_members gm
  WHERE gm.group_id = g.id
),
updated_at = NOW()
WHERE g.member_count != (
  SELECT COUNT(*)
  FROM group_members gm
  WHERE gm.group_id = g.id
);

-- ============================================
-- 验证函数
-- ============================================

CREATE OR REPLACE FUNCTION verify_group_member_counts()
RETURNS TABLE(
  group_id UUID,
  group_name TEXT,
  stored_count INTEGER,
  actual_count BIGINT,
  is_consistent BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    g.id as group_id,
    g.name as group_name,
    g.member_count as stored_count,
    COUNT(gm.id) as actual_count,
    g.member_count = COUNT(gm.id) as is_consistent
  FROM groups g
  LEFT JOIN group_members gm ON g.id = gm.group_id
  GROUP BY g.id, g.name, g.member_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION verify_group_member_counts IS '验证所有群组的成员计数一致性';

-- 使用方法: SELECT * FROM verify_group_member_counts() WHERE NOT is_consistent;
