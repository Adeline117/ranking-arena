-- 添加模拟评论
-- 在 Supabase SQL Editor 中运行

DO $$
DECLARE
  v_user_id UUID;
  v_user_handle TEXT := 'adelinewen';
  v_post_id UUID;
BEGIN
  -- 获取用户 ID
  SELECT id INTO v_user_id FROM auth.users WHERE email = 'adelinewen1107@outlook.com';
  
  IF v_user_id IS NULL THEN
    RAISE NOTICE '未找到用户';
    RETURN;
  END IF;

  -- 确保用户有 profile
  INSERT INTO user_profiles (id, handle, bio)
  VALUES (v_user_id, v_user_handle, '加密交易爱好者 | 长期主义者')
  ON CONFLICT (id) DO UPDATE SET handle = v_user_handle, bio = '加密交易爱好者 | 长期主义者';

  -- 获取最新的帖子 ID（如果存在）
  SELECT id INTO v_post_id FROM posts ORDER BY created_at DESC LIMIT 1;
  
  IF v_post_id IS NULL THEN
    RAISE NOTICE '没有帖子，跳过评论创建';
    RETURN;
  END IF;

  -- 为最新的帖子添加模拟评论
  INSERT INTO comments (post_id, user_id, author_handle, content, created_at)
  VALUES 
    (v_post_id, v_user_id, v_user_handle, '这个分析太棒了！学习了 👍', NOW() - INTERVAL '2 hours'),
    (v_post_id, v_user_id, v_user_handle, '请问数据来源是什么？', NOW() - INTERVAL '1 hour 30 minutes'),
    (v_post_id, v_user_id, v_user_handle, '同意楼主观点，长期看涨', NOW() - INTERVAL '1 hour'),
    (v_post_id, v_user_id, v_user_handle, '已收藏，感谢分享！', NOW() - INTERVAL '45 minutes'),
    (v_post_id, v_user_id, v_user_handle, '能不能详细说说操作策略？', NOW() - INTERVAL '30 minutes'),
    (v_post_id, v_user_id, v_user_handle, '太有帮助了，期待更多分享', NOW() - INTERVAL '15 minutes'),
    (v_post_id, v_user_id, v_user_handle, '+1 支持！', NOW() - INTERVAL '5 minutes')
  ON CONFLICT DO NOTHING;

  -- 更新帖子的评论计数
  UPDATE posts SET comment_count = (
    SELECT COUNT(*) FROM comments WHERE post_id = v_post_id
  ) WHERE id = v_post_id;

  RAISE NOTICE '✅ 评论添加成功！';
END $$;

-- 显示评论
SELECT 
  c.id,
  c.author_handle,
  c.content,
  c.created_at,
  p.title as post_title
FROM comments c
JOIN posts p ON c.post_id = p.id
ORDER BY c.created_at DESC
LIMIT 10;

