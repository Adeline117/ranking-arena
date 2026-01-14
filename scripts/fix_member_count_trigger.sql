-- 修复小组成员数触发器

-- 1. 删除旧触发器
DROP TRIGGER IF EXISTS trigger_update_group_member_count ON group_members;

-- 2. 创建或替换函数
CREATE OR REPLACE FUNCTION update_group_member_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE groups SET member_count = COALESCE(member_count, 0) + 1 WHERE id = NEW.group_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE groups SET member_count = GREATEST(0, COALESCE(member_count, 0) - 1) WHERE id = OLD.group_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 3. 创建新触发器
CREATE TRIGGER trigger_update_group_member_count
AFTER INSERT OR DELETE ON group_members
FOR EACH ROW
EXECUTE FUNCTION update_group_member_count();

-- 4. 同步现有数据
UPDATE groups g
SET member_count = (
  SELECT COUNT(*)
  FROM group_members gm
  WHERE gm.group_id = g.id
);

-- 5. 创建 post_votes 触发器更新帖子投票数
CREATE OR REPLACE FUNCTION update_post_poll_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.choice = 'bull' THEN
      UPDATE posts SET poll_bull = COALESCE(poll_bull, 0) + 1 WHERE id = NEW.post_id;
    ELSIF NEW.choice = 'bear' THEN
      UPDATE posts SET poll_bear = COALESCE(poll_bear, 0) + 1 WHERE id = NEW.post_id;
    ELSIF NEW.choice = 'wait' THEN
      UPDATE posts SET poll_wait = COALESCE(poll_wait, 0) + 1 WHERE id = NEW.post_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.choice = 'bull' THEN
      UPDATE posts SET poll_bull = GREATEST(0, COALESCE(poll_bull, 0) - 1) WHERE id = OLD.post_id;
    ELSIF OLD.choice = 'bear' THEN
      UPDATE posts SET poll_bear = GREATEST(0, COALESCE(poll_bear, 0) - 1) WHERE id = OLD.post_id;
    ELSIF OLD.choice = 'wait' THEN
      UPDATE posts SET poll_wait = GREATEST(0, COALESCE(poll_wait, 0) - 1) WHERE id = OLD.post_id;
    END IF;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    -- 减少旧选项
    IF OLD.choice = 'bull' THEN
      UPDATE posts SET poll_bull = GREATEST(0, COALESCE(poll_bull, 0) - 1) WHERE id = OLD.post_id;
    ELSIF OLD.choice = 'bear' THEN
      UPDATE posts SET poll_bear = GREATEST(0, COALESCE(poll_bear, 0) - 1) WHERE id = OLD.post_id;
    ELSIF OLD.choice = 'wait' THEN
      UPDATE posts SET poll_wait = GREATEST(0, COALESCE(poll_wait, 0) - 1) WHERE id = OLD.post_id;
    END IF;
    -- 增加新选项
    IF NEW.choice = 'bull' THEN
      UPDATE posts SET poll_bull = COALESCE(poll_bull, 0) + 1 WHERE id = NEW.post_id;
    ELSIF NEW.choice = 'bear' THEN
      UPDATE posts SET poll_bear = COALESCE(poll_bear, 0) + 1 WHERE id = NEW.post_id;
    ELSIF NEW.choice = 'wait' THEN
      UPDATE posts SET poll_wait = COALESCE(poll_wait, 0) + 1 WHERE id = NEW.post_id;
    END IF;
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_post_poll_count ON post_votes;
CREATE TRIGGER trigger_update_post_poll_count
AFTER INSERT OR UPDATE OR DELETE ON post_votes
FOR EACH ROW
EXECUTE FUNCTION update_post_poll_count();

