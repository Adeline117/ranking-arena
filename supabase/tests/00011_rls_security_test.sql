-- RLS 策略验证测试
-- 用于验证 00011_fix_rls_security.sql 中的修复
-- 运行方式: 在 Supabase SQL Editor 中执行

-- ============================================
-- 测试准备：创建测试数据
-- ============================================

DO $$
DECLARE
  v_user1_id UUID := gen_random_uuid();
  v_user2_id UUID := gen_random_uuid();
  v_admin_id UUID := gen_random_uuid();
  v_group_id UUID := gen_random_uuid();
  v_post_id UUID := gen_random_uuid();
  v_comment_id UUID := gen_random_uuid();
  v_application_id UUID := gen_random_uuid();
BEGIN
  -- 注意：这是验证脚本，不会实际执行
  -- 用于文档化预期行为

  RAISE NOTICE '=== RLS 策略验证测试 ===';
  RAISE NOTICE '';

  -- ============================================
  -- 测试 1: notifications INSERT 策略
  -- ============================================
  RAISE NOTICE '测试 1: notifications INSERT 策略';
  RAISE NOTICE '  预期: 普通用户无法给他人插入通知';
  RAISE NOTICE '  预期: 用户可以给自己插入通知';
  RAISE NOTICE '  预期: service_role 可以给任何人插入通知';
  RAISE NOTICE '';

  -- ============================================
  -- 测试 2: risk_alerts INSERT 策略
  -- ============================================
  RAISE NOTICE '测试 2: risk_alerts INSERT 策略';
  RAISE NOTICE '  预期: 普通用户无法插入风险预警';
  RAISE NOTICE '  预期: service_role 可以插入风险预警';
  RAISE NOTICE '';

  -- ============================================
  -- 测试 3: group_applications 策略
  -- ============================================
  RAISE NOTICE '测试 3: group_applications 策略';
  RAISE NOTICE '  预期: 群组 owner 可以查看群组申请';
  RAISE NOTICE '  预期: 群组 admin 可以查看群组申请';
  RAISE NOTICE '  预期: 群组 owner 可以更新申请状态';
  RAISE NOTICE '  预期: 群组 admin 可以更新申请状态';
  RAISE NOTICE '  预期: 普通成员无法查看/更新申请';
  RAISE NOTICE '  预期: 站点 admin 可以查看/更新所有申请';
  RAISE NOTICE '';

  -- ============================================
  -- 测试 4: pro_official_groups 策略
  -- ============================================
  RAISE NOTICE '测试 4: pro_official_groups 策略';
  RAISE NOTICE '  预期: pro 用户可以查看';
  RAISE NOTICE '  预期: elite 用户可以查看';
  RAISE NOTICE '  预期: enterprise 用户可以查看';
  RAISE NOTICE '  预期: free 用户无法查看';
  RAISE NOTICE '';

  -- ============================================
  -- 测试 5: posts DELETE 策略
  -- ============================================
  RAISE NOTICE '测试 5: posts DELETE 策略';
  RAISE NOTICE '  预期: 作者可以删除自己的帖子';
  RAISE NOTICE '  预期: 群组 owner 可以删除群内帖子';
  RAISE NOTICE '  预期: 群组 admin 可以删除群内帖子';
  RAISE NOTICE '  预期: 普通成员无法删除他人帖子';
  RAISE NOTICE '  预期: 站点 admin 可以删除任何帖子';
  RAISE NOTICE '';

  -- ============================================
  -- 测试 6: comments DELETE 策略
  -- ============================================
  RAISE NOTICE '测试 6: comments DELETE 策略';
  RAISE NOTICE '  预期: 作者可以删除自己的评论';
  RAISE NOTICE '  预期: 群组 admin 可以删除群内帖子的评论';
  RAISE NOTICE '  预期: 普通用户无法删除他人评论';
  RAISE NOTICE '  预期: 站点 admin 可以删除任何评论';
  RAISE NOTICE '';

  -- ============================================
  -- 测试 7: 辅助函数
  -- ============================================
  RAISE NOTICE '测试 7: 辅助函数';
  RAISE NOTICE '  is_group_admin(group_id): 检查群组管理员';
  RAISE NOTICE '  is_site_admin(): 检查站点管理员';
  RAISE NOTICE '  is_premium_user(): 检查付费用户';
  RAISE NOTICE '';

  RAISE NOTICE '=== 测试完成 ===';
END $$;

-- ============================================
-- 辅助函数验证查询
-- ============================================

-- 验证 is_group_admin 函数存在
SELECT
  p.proname AS function_name,
  pg_get_function_result(p.oid) AS return_type,
  pg_get_function_arguments(p.oid) AS arguments
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN ('is_group_admin', 'is_site_admin', 'is_premium_user');

-- ============================================
-- 索引验证查询
-- ============================================

-- 验证新索引已创建
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'idx_group_members_user_role',
    'idx_user_profiles_role_admin',
    'idx_subscriptions_active_premium'
  );

-- ============================================
-- RLS 策略验证查询
-- ============================================

-- 列出所有 RLS 策略
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'notifications',
    'risk_alerts',
    'push_notification_logs',
    'group_applications',
    'pro_official_groups',
    'posts',
    'comments',
    'group_edit_applications'
  )
ORDER BY tablename, policyname;
