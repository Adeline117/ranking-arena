-- RLS 安全修复
-- 版本: 00011
-- 创建日期: 2026-01-21
-- 修复审计报告中发现的致命和高危问题

-- ============================================
-- 1. 修复致命漏洞：notifications INSERT 策略
-- 问题：任何认证用户可以给任何人插入通知
-- ============================================

-- 删除不安全的 INSERT 策略
DROP POLICY IF EXISTS "System can insert notifications" ON notifications;

-- 创建安全的 INSERT 策略：只允许服务端角色或触发器插入
-- 注意：Supabase 触发器使用 SECURITY DEFINER，不受 RLS 限制
CREATE POLICY "Only service role can insert notifications"
  ON notifications FOR INSERT
  WITH CHECK (
    -- 服务端角色（用于 API 调用）
    auth.role() = 'service_role'
    OR
    -- 允许用户给自己创建通知（用于前端测试，可选移除）
    auth.uid() = user_id
  );

-- ============================================
-- 2. 修复致命漏洞：risk_alerts INSERT 策略
-- 问题：任何认证用户可以创建风险预警
-- ============================================

-- 删除不安全的 INSERT 策略
DROP POLICY IF EXISTS "System can insert alerts" ON risk_alerts;

-- 创建安全的 INSERT 策略：只允许服务端角色
CREATE POLICY "Only service role can insert risk alerts"
  ON risk_alerts FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

-- ============================================
-- 3. 修复致命漏洞：push_notification_logs INSERT 策略
-- 问题：任何认证用户可以创建推送日志
-- ============================================

-- 先检查表是否存在
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'push_notification_logs'
  ) THEN
    -- 删除不安全的 INSERT 策略
    DROP POLICY IF EXISTS "System can insert push logs" ON push_notification_logs;

    -- 创建安全的 INSERT 策略
    CREATE POLICY "Only service role can insert push logs"
      ON push_notification_logs FOR INSERT
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

-- ============================================
-- 4. 修复致命漏洞：group_applications RLS
-- 问题：群组 owner/admin 无法审核自己群的申请
-- ============================================

-- 删除现有策略（只允许站点 admin 更新）
DROP POLICY IF EXISTS "Admins can update applications" ON group_applications;

-- 创建新策略：群组 owner/admin 可以更新自己群的申请
CREATE POLICY "Group admins can update applications"
  ON group_applications FOR UPDATE
  USING (
    -- 站点管理员
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
    OR
    -- 群组 owner/admin
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_applications.group_id
      AND gm.user_id = auth.uid()
      AND gm.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    -- 站点管理员
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
    OR
    -- 群组 owner/admin
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_applications.group_id
      AND gm.user_id = auth.uid()
      AND gm.role IN ('owner', 'admin')
    )
  );

-- 同样修复 SELECT 策略，让群组管理员能看到申请
DROP POLICY IF EXISTS "Admins can view all applications" ON group_applications;

CREATE POLICY "Group admins can view applications"
  ON group_applications FOR SELECT
  USING (
    -- 申请人自己
    auth.uid() = applicant_id
    OR
    -- 站点管理员
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
    OR
    -- 群组 owner/admin
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_applications.group_id
      AND gm.user_id = auth.uid()
      AND gm.role IN ('owner', 'admin')
    )
  );

-- 删除重复的用户自己查看策略（已合并到上面）
DROP POLICY IF EXISTS "Users can view their own applications" ON group_applications;

-- ============================================
-- 5. 修复高危问题：pro_official_groups RLS
-- 问题：只检查 tier = 'pro'，elite/enterprise 用户被拒
-- ============================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'pro_official_groups'
  ) THEN
    -- 删除现有策略
    DROP POLICY IF EXISTS "Pro official groups are viewable by pro members" ON pro_official_groups;

    -- 创建新策略：所有付费用户都可访问
    CREATE POLICY "Pro official groups are viewable by premium members"
      ON pro_official_groups FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM subscriptions
          WHERE user_id = auth.uid()
          AND tier IN ('pro', 'elite', 'enterprise')
          AND status = 'active'
        )
      );
  END IF;
END $$;

-- ============================================
-- 6. 修复高危问题：群组管理员删帖能力
-- 问题：群组 admin 无法删除群内违规帖子
-- ============================================

-- 删除现有的 DELETE 策略
DROP POLICY IF EXISTS "Users can delete their own posts" ON posts;

-- 创建新策略：作者或群组管理员可以删除帖子
CREATE POLICY "Authors and group admins can delete posts"
  ON posts FOR DELETE
  USING (
    -- 帖子作者
    auth.uid() = author_id
    OR
    -- 群组管理员（仅对群组内的帖子）
    (
      group_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM group_members gm
        WHERE gm.group_id = posts.group_id
        AND gm.user_id = auth.uid()
        AND gm.role IN ('owner', 'admin')
      )
    )
    OR
    -- 站点管理员
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

-- ============================================
-- 7. 修复高危问题：群组管理员删评论能力
-- ============================================

-- 删除现有的 DELETE 策略
DROP POLICY IF EXISTS "Users can delete their own comments" ON comments;

-- 创建新策略：作者或群组管理员可以删除评论
CREATE POLICY "Authors and group admins can delete comments"
  ON comments FOR DELETE
  USING (
    -- 评论作者
    auth.uid() = author_id
    OR
    -- 群组管理员（通过帖子关联）
    EXISTS (
      SELECT 1 FROM posts p
      JOIN group_members gm ON gm.group_id = p.group_id
      WHERE p.id = comments.post_id
      AND p.group_id IS NOT NULL
      AND gm.user_id = auth.uid()
      AND gm.role IN ('owner', 'admin')
    )
    OR
    -- 站点管理员
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

-- ============================================
-- 8. 创建辅助函数：检查是否为群组管理员
-- 用于简化后续 RLS 策略
-- ============================================

CREATE OR REPLACE FUNCTION is_group_admin(p_group_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = p_group_id
    AND user_id = auth.uid()
    AND role IN ('owner', 'admin')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- 创建辅助函数：检查是否为站点管理员
CREATE OR REPLACE FUNCTION is_site_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM user_profiles
    WHERE id = auth.uid()
    AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- 创建辅助函数：检查是否为付费用户
CREATE OR REPLACE FUNCTION is_premium_user()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM subscriptions
    WHERE user_id = auth.uid()
    AND tier IN ('pro', 'elite', 'enterprise')
    AND status = 'active'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ============================================
-- 9. 修复 group_edit_applications RLS
-- 确保群组管理员能处理编辑申请
-- ============================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'group_edit_applications'
  ) THEN
    -- 删除现有策略
    DROP POLICY IF EXISTS "Group owners can view edit applications" ON group_edit_applications;
    DROP POLICY IF EXISTS "Admins can update edit applications" ON group_edit_applications;

    -- 群组管理员可以查看编辑申请
    CREATE POLICY "Group admins can view edit applications"
      ON group_edit_applications FOR SELECT
      USING (
        auth.uid() = applicant_id
        OR is_group_admin(group_id)
        OR is_site_admin()
      );

    -- 站点管理员可以更新编辑申请
    CREATE POLICY "Site admins can update edit applications"
      ON group_edit_applications FOR UPDATE
      USING (is_site_admin())
      WITH CHECK (is_site_admin());
  END IF;
END $$;

-- ============================================
-- 10. 添加索引优化 RLS 查询性能
-- ============================================

-- group_members 的复合索引（用于 RLS 检查）
CREATE INDEX IF NOT EXISTS idx_group_members_user_role
  ON group_members(user_id, group_id, role);

-- user_profiles 的角色索引
CREATE INDEX IF NOT EXISTS idx_user_profiles_role_admin
  ON user_profiles(id)
  WHERE role = 'admin';

-- subscriptions 的活跃付费用户索引
CREATE INDEX IF NOT EXISTS idx_subscriptions_active_premium
  ON subscriptions(user_id)
  WHERE status = 'active' AND tier IN ('pro', 'elite', 'enterprise');

-- ============================================
-- 完成
-- ============================================
-- 本迁移修复了以下问题：
-- 1. [致命] notifications INSERT 漏洞
-- 2. [致命] risk_alerts INSERT 漏洞
-- 3. [致命] push_notification_logs INSERT 漏洞
-- 4. [致命] group_applications RLS（群组管理员无法审核）
-- 5. [高危] pro_official_groups RLS（elite/enterprise 被拒）
-- 6. [高危] 群组管理员无法删帖
-- 7. [高危] 群组管理员无法删评论
-- 8. [优化] 添加辅助函数简化 RLS
-- 9. [修复] group_edit_applications RLS
-- 10. [优化] 添加索引提升 RLS 性能
