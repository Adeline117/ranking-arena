-- 评论点赞原子操作函数
-- 用于安全地增加和减少评论的点赞数，避免并发竞态条件

-- 增加评论点赞数（原子操作）
CREATE OR REPLACE FUNCTION increment_comment_like_count(p_comment_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_new_count INTEGER;
BEGIN
  UPDATE comments 
  SET like_count = COALESCE(like_count, 0) + 1
  WHERE id = p_comment_id
  RETURNING like_count INTO v_new_count;
  
  RETURN COALESCE(v_new_count, 0);
END;
$$ LANGUAGE plpgsql;

-- 减少评论点赞数（原子操作，确保不会小于0）
CREATE OR REPLACE FUNCTION decrement_comment_like_count(p_comment_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_new_count INTEGER;
BEGIN
  UPDATE comments 
  SET like_count = GREATEST(0, COALESCE(like_count, 0) - 1)
  WHERE id = p_comment_id
  RETURNING like_count INTO v_new_count;
  
  RETURN COALESCE(v_new_count, 0);
END;
$$ LANGUAGE plpgsql;

-- 授予执行权限
GRANT EXECUTE ON FUNCTION increment_comment_like_count(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION decrement_comment_like_count(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION increment_comment_like_count(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION decrement_comment_like_count(UUID) TO service_role;


