-- RLS 策略完善
-- 确保用户只能访问自己的数据
-- 版本: 00010
-- 创建日期: 2026-01

-- ============================================
-- 1. user_profiles 表 - 确保用户只能修改自己的资料
-- ============================================

-- 确保 RLS 已启用
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- 删除现有策略（如果存在）
DROP POLICY IF EXISTS "User profiles are viewable by everyone" ON user_profiles;
DROP POLICY IF EXISTS "Users can insert their own profile" ON user_profiles;
DROP POLICY IF EXISTS "Users can update their own profile" ON user_profiles;
DROP POLICY IF EXISTS "Users can delete their own profile" ON user_profiles;

-- 所有人都可以查看用户资料（公开信息）
CREATE POLICY "User profiles are viewable by everyone"
  ON user_profiles FOR SELECT 
  USING (true);

-- 用户只能创建自己的资料
CREATE POLICY "Users can insert their own profile"
  ON user_profiles FOR INSERT 
  WITH CHECK (auth.uid() = id);

-- 用户只能更新自己的资料
CREATE POLICY "Users can update their own profile"
  ON user_profiles FOR UPDATE 
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- 用户只能删除自己的资料（如果需要）
CREATE POLICY "Users can delete their own profile"
  ON user_profiles FOR DELETE 
  USING (auth.uid() = id);

-- ============================================
-- 2. posts 表 - 确保用户只能修改自己的帖子
-- ============================================

ALTER TABLE posts ENABLE ROW LEVEL SECURITY;

-- 删除现有策略
DROP POLICY IF EXISTS "Posts are viewable by everyone" ON posts;
DROP POLICY IF EXISTS "Authenticated users can create posts" ON posts;
DROP POLICY IF EXISTS "Users can update their own posts" ON posts;
DROP POLICY IF EXISTS "Users can delete their own posts" ON posts;

-- 所有人都可以查看帖子
CREATE POLICY "Posts are viewable by everyone"
  ON posts FOR SELECT 
  USING (true);

-- 已认证用户只能创建自己的帖子
CREATE POLICY "Authenticated users can create posts"
  ON posts FOR INSERT 
  WITH CHECK (auth.uid() = author_id);

-- 用户只能更新自己的帖子
CREATE POLICY "Users can update their own posts"
  ON posts FOR UPDATE 
  USING (auth.uid() = author_id)
  WITH CHECK (auth.uid() = author_id);

-- 用户只能删除自己的帖子
CREATE POLICY "Users can delete their own posts"
  ON posts FOR DELETE 
  USING (auth.uid() = author_id);

-- ============================================
-- 3. comments 表 - 确保用户只能修改自己的评论
-- ============================================

ALTER TABLE comments ENABLE ROW LEVEL SECURITY;

-- 删除现有策略
DROP POLICY IF EXISTS "Comments are viewable by everyone" ON comments;
DROP POLICY IF EXISTS "Authenticated users can create comments" ON comments;
DROP POLICY IF EXISTS "Users can update their own comments" ON comments;
DROP POLICY IF EXISTS "Users can delete their own comments" ON comments;

-- 所有人都可以查看评论
CREATE POLICY "Comments are viewable by everyone"
  ON comments FOR SELECT 
  USING (true);

-- 已认证用户只能创建自己的评论
CREATE POLICY "Authenticated users can create comments"
  ON comments FOR INSERT 
  WITH CHECK (auth.uid() = author_id);

-- 用户只能更新自己的评论
CREATE POLICY "Users can update their own comments"
  ON comments FOR UPDATE 
  USING (auth.uid() = author_id)
  WITH CHECK (auth.uid() = author_id);

-- 用户只能删除自己的评论
CREATE POLICY "Users can delete their own comments"
  ON comments FOR DELETE 
  USING (auth.uid() = author_id);

-- ============================================
-- 4. user_follows 表 - 确保用户只能管理自己的关注关系
-- ============================================

ALTER TABLE user_follows ENABLE ROW LEVEL SECURITY;

-- 删除现有策略
DROP POLICY IF EXISTS "User follows are viewable by everyone" ON user_follows;
DROP POLICY IF EXISTS "Users can follow others" ON user_follows;
DROP POLICY IF EXISTS "Users can unfollow" ON user_follows;

-- 所有人都可以查看关注关系
CREATE POLICY "User follows are viewable by everyone"
  ON user_follows FOR SELECT 
  USING (true);

-- 用户只能创建自己的关注关系
CREATE POLICY "Users can follow others"
  ON user_follows FOR INSERT 
  WITH CHECK (auth.uid() = follower_id);

-- 用户只能删除自己的关注关系
CREATE POLICY "Users can unfollow"
  ON user_follows FOR DELETE 
  USING (auth.uid() = follower_id);

-- ============================================
-- 5. notifications 表 - 确保用户只能访问自己的通知
-- ============================================

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- 删除现有策略
DROP POLICY IF EXISTS "Users can view their own notifications" ON notifications;
DROP POLICY IF EXISTS "Users can update their own notifications" ON notifications;
DROP POLICY IF EXISTS "System can insert notifications" ON notifications;

-- 用户只能查看自己的通知
CREATE POLICY "Users can view their own notifications"
  ON notifications FOR SELECT 
  USING (auth.uid() = user_id);

-- 用户只能更新自己的通知
CREATE POLICY "Users can update their own notifications"
  ON notifications FOR UPDATE 
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 系统可以插入通知（通过服务端函数）
CREATE POLICY "System can insert notifications"
  ON notifications FOR INSERT 
  WITH CHECK (true);

-- 用户只能删除自己的通知
CREATE POLICY "Users can delete their own notifications"
  ON notifications FOR DELETE 
  USING (auth.uid() = user_id);

-- ============================================
-- 6. alert_configs 表 - 确保用户只能访问自己的预警配置
-- ============================================

ALTER TABLE alert_configs ENABLE ROW LEVEL SECURITY;

-- 删除现有策略
DROP POLICY IF EXISTS "Users can view their own alert configs" ON alert_configs;
DROP POLICY IF EXISTS "Users can insert their own alert configs" ON alert_configs;
DROP POLICY IF EXISTS "Users can update their own alert configs" ON alert_configs;
DROP POLICY IF EXISTS "Users can delete their own alert configs" ON alert_configs;

-- 用户只能查看自己的预警配置
CREATE POLICY "Users can view their own alert configs"
  ON alert_configs FOR SELECT 
  USING (auth.uid() = user_id);

-- 用户只能创建自己的预警配置
CREATE POLICY "Users can insert their own alert configs"
  ON alert_configs FOR INSERT 
  WITH CHECK (auth.uid() = user_id);

-- 用户只能更新自己的预警配置
CREATE POLICY "Users can update their own alert configs"
  ON alert_configs FOR UPDATE 
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 用户只能删除自己的预警配置
CREATE POLICY "Users can delete their own alert configs"
  ON alert_configs FOR DELETE 
  USING (auth.uid() = user_id);

-- ============================================
-- 7. risk_alerts 表 - 确保用户只能访问自己的风险预警
-- ============================================

ALTER TABLE risk_alerts ENABLE ROW LEVEL SECURITY;

-- 删除现有策略
DROP POLICY IF EXISTS "Users can view their own alerts" ON risk_alerts;
DROP POLICY IF EXISTS "System can insert alerts" ON risk_alerts;
DROP POLICY IF EXISTS "Users can update their own alerts" ON risk_alerts;

-- 用户只能查看自己的风险预警
CREATE POLICY "Users can view their own alerts"
  ON risk_alerts FOR SELECT 
  USING (auth.uid() = user_id);

-- 系统可以插入预警（通过服务端函数）
CREATE POLICY "System can insert alerts"
  ON risk_alerts FOR INSERT 
  WITH CHECK (true);

-- 用户只能更新自己的风险预警
CREATE POLICY "Users can update their own alerts"
  ON risk_alerts FOR UPDATE 
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================
-- 8. push_subscriptions 表 - 确保用户只能访问自己的推送订阅
-- ============================================

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- 删除现有策略
DROP POLICY IF EXISTS "Users can view their own push subscriptions" ON push_subscriptions;
DROP POLICY IF EXISTS "Users can insert their own push subscriptions" ON push_subscriptions;
DROP POLICY IF EXISTS "Users can update their own push subscriptions" ON push_subscriptions;
DROP POLICY IF EXISTS "Users can delete their own push subscriptions" ON push_subscriptions;

-- 用户只能查看自己的推送订阅
CREATE POLICY "Users can view their own push subscriptions"
  ON push_subscriptions FOR SELECT 
  USING (auth.uid() = user_id);

-- 用户只能创建自己的推送订阅
CREATE POLICY "Users can insert their own push subscriptions"
  ON push_subscriptions FOR INSERT 
  WITH CHECK (auth.uid() = user_id);

-- 用户只能更新自己的推送订阅
CREATE POLICY "Users can update their own push subscriptions"
  ON push_subscriptions FOR UPDATE 
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 用户只能删除自己的推送订阅
CREATE POLICY "Users can delete their own push subscriptions"
  ON push_subscriptions FOR DELETE 
  USING (auth.uid() = user_id);

-- ============================================
-- 9. push_notification_logs 表 - 确保用户只能查看自己的推送日志
-- ============================================

ALTER TABLE push_notification_logs ENABLE ROW LEVEL SECURITY;

-- 删除现有策略
DROP POLICY IF EXISTS "Users can view their own push logs" ON push_notification_logs;
DROP POLICY IF EXISTS "System can insert push logs" ON push_notification_logs;

-- 用户只能查看自己的推送日志
CREATE POLICY "Users can view their own push logs"
  ON push_notification_logs FOR SELECT 
  USING (auth.uid() = user_id);

-- 系统可以插入推送日志（通过服务端函数）
CREATE POLICY "System can insert push logs"
  ON push_notification_logs FOR INSERT 
  WITH CHECK (true);

-- ============================================
-- 10. content_reports 表 - 确保用户只能访问自己提交的举报
-- ============================================

ALTER TABLE content_reports ENABLE ROW LEVEL SECURITY;

-- 删除现有策略
DROP POLICY IF EXISTS "Users can view own reports" ON content_reports;
DROP POLICY IF EXISTS "Users can create reports" ON content_reports;
DROP POLICY IF EXISTS "Admins can view all reports" ON content_reports;
DROP POLICY IF EXISTS "Admins can update reports" ON content_reports;

-- 用户可以查看自己提交的举报
CREATE POLICY "Users can view own reports"
  ON content_reports FOR SELECT
  USING (auth.uid() = reporter_id);

-- 用户可以创建举报
CREATE POLICY "Users can create reports"
  ON content_reports FOR INSERT
  WITH CHECK (auth.uid() = reporter_id);

-- 管理员可以查看所有举报
CREATE POLICY "Admins can view all reports"
  ON content_reports FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- 管理员可以更新举报状态
CREATE POLICY "Admins can update reports"
  ON content_reports FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- ============================================
-- 11. admin_logs 表 - 只有管理员可以访问
-- ============================================

ALTER TABLE admin_logs ENABLE ROW LEVEL SECURITY;

-- 删除现有策略
DROP POLICY IF EXISTS "Admins can view logs" ON admin_logs;
DROP POLICY IF EXISTS "Admins can create logs" ON admin_logs;

-- 只有管理员可以查看日志
CREATE POLICY "Admins can view logs"
  ON admin_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- 只有管理员可以创建日志
CREATE POLICY "Admins can create logs"
  ON admin_logs FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- ============================================
-- 12. alert_config 表 - 只有管理员可以访问
-- ============================================

ALTER TABLE alert_config ENABLE ROW LEVEL SECURITY;

-- 删除现有策略
DROP POLICY IF EXISTS "Admins can view alert config" ON alert_config;
DROP POLICY IF EXISTS "Admins can update alert config" ON alert_config;
DROP POLICY IF EXISTS "Admins can insert alert config" ON alert_config;

-- 只有管理员可以查看配置
CREATE POLICY "Admins can view alert config"
  ON alert_config FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- 只有管理员可以更新配置
CREATE POLICY "Admins can update alert config"
  ON alert_config FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- 只有管理员可以插入配置
CREATE POLICY "Admins can insert alert config"
  ON alert_config FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- ============================================
-- 13. group_members 表 - 确保用户只能管理自己的成员关系
-- ============================================

ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;

-- 删除现有策略
DROP POLICY IF EXISTS "Group members are viewable by everyone" ON group_members;
DROP POLICY IF EXISTS "Users can join groups" ON group_members;
DROP POLICY IF EXISTS "Users can leave groups" ON group_members;
DROP POLICY IF EXISTS "Group admins can update members" ON group_members;

-- 所有人都可以查看成员关系
CREATE POLICY "Group members are viewable by everyone"
  ON group_members FOR SELECT 
  USING (true);

-- 用户只能创建自己的成员关系
CREATE POLICY "Users can join groups"
  ON group_members FOR INSERT 
  WITH CHECK (auth.uid() = user_id);

-- 用户只能删除自己的成员关系（离开群组）
CREATE POLICY "Users can leave groups"
  ON group_members FOR DELETE 
  USING (auth.uid() = user_id);

-- 群组管理员可以更新成员（角色、禁言等）
CREATE POLICY "Group admins can update members"
  ON group_members FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_members.group_id
      AND gm.user_id = auth.uid()
      AND gm.role IN ('admin', 'owner')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_members.group_id
      AND gm.user_id = auth.uid()
      AND gm.role IN ('admin', 'owner')
    )
  );

-- ============================================
-- 14. groups 表 - 确保只有创建者或管理员可以修改
-- ============================================

ALTER TABLE groups ENABLE ROW LEVEL SECURITY;

-- 删除现有策略
DROP POLICY IF EXISTS "Groups are viewable by everyone" ON groups;
DROP POLICY IF EXISTS "Group creators can update their groups" ON groups;
DROP POLICY IF EXISTS "Group admins can update their groups" ON groups;
DROP POLICY IF EXISTS "Group creators can delete their groups" ON groups;

-- 所有人都可以查看群组
CREATE POLICY "Groups are viewable by everyone"
  ON groups FOR SELECT 
  USING (true);

-- 群组创建者可以更新自己的群组
CREATE POLICY "Group creators can update their groups"
  ON groups FOR UPDATE
  USING (auth.uid() = created_by)
  WITH CHECK (auth.uid() = created_by);

-- 群组管理员也可以更新群组（通过 group_members 表检查）
CREATE POLICY "Group admins can update their groups"
  ON groups FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = groups.id
      AND gm.user_id = auth.uid()
      AND gm.role IN ('admin', 'owner')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = groups.id
      AND gm.user_id = auth.uid()
      AND gm.role IN ('admin', 'owner')
    )
  );

-- 群组创建者可以删除自己的群组
CREATE POLICY "Group creators can delete their groups"
  ON groups FOR DELETE
  USING (auth.uid() = created_by);

-- ============================================
-- 15. group_applications 表 - 确保用户只能访问自己的申请
-- ============================================

ALTER TABLE group_applications ENABLE ROW LEVEL SECURITY;

-- 删除现有策略
DROP POLICY IF EXISTS "Users can view their own applications" ON group_applications;
DROP POLICY IF EXISTS "Users can create applications" ON group_applications;
DROP POLICY IF EXISTS "Admins can view all applications" ON group_applications;
DROP POLICY IF EXISTS "Admins can update applications" ON group_applications;

-- 用户可以查看自己的申请
CREATE POLICY "Users can view their own applications"
  ON group_applications FOR SELECT
  USING (auth.uid() = applicant_id);

-- 用户可以创建申请
CREATE POLICY "Users can create applications"
  ON group_applications FOR INSERT
  WITH CHECK (auth.uid() = applicant_id);

-- 管理员可以查看所有申请
CREATE POLICY "Admins can view all applications"
  ON group_applications FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- 管理员可以更新申请状态
CREATE POLICY "Admins can update applications"
  ON group_applications FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- ============================================
-- 16. post_bookmarks 表 - 确保用户只能访问自己的收藏
-- ============================================

-- 检查表是否存在
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'post_bookmarks'
  ) THEN
    ALTER TABLE post_bookmarks ENABLE ROW LEVEL SECURITY;

    -- 删除现有策略
    DROP POLICY IF EXISTS "Users can view their own bookmarks" ON post_bookmarks;
    DROP POLICY IF EXISTS "Users can insert their own bookmarks" ON post_bookmarks;
    DROP POLICY IF EXISTS "Users can delete their own bookmarks" ON post_bookmarks;

    -- 用户只能查看自己的收藏
    CREATE POLICY "Users can view their own bookmarks"
      ON post_bookmarks FOR SELECT 
      USING (auth.uid() = user_id);

    -- 用户只能创建自己的收藏
    CREATE POLICY "Users can insert their own bookmarks"
      ON post_bookmarks FOR INSERT 
      WITH CHECK (auth.uid() = user_id);

    -- 用户只能删除自己的收藏
    CREATE POLICY "Users can delete their own bookmarks"
      ON post_bookmarks FOR DELETE 
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ============================================
-- 17. reposts 表 - 确保用户只能管理自己的转发
-- ============================================

-- 检查表是否存在
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'reposts'
  ) THEN
    ALTER TABLE reposts ENABLE ROW LEVEL SECURITY;

    -- 删除现有策略
    DROP POLICY IF EXISTS "Reposts are viewable by everyone" ON reposts;
    DROP POLICY IF EXISTS "Users can insert their own reposts" ON reposts;
    DROP POLICY IF EXISTS "Users can delete their own reposts" ON reposts;

    -- 所有人都可以查看转发
    CREATE POLICY "Reposts are viewable by everyone"
      ON reposts FOR SELECT 
      USING (true);

    -- 用户只能创建自己的转发
    CREATE POLICY "Users can insert their own reposts"
      ON reposts FOR INSERT 
      WITH CHECK (auth.uid() = user_id);

    -- 用户只能删除自己的转发
    CREATE POLICY "Users can delete their own reposts"
      ON reposts FOR DELETE 
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ============================================
-- 18. pro_official_groups 表 - Pro 会员可以查看
-- ============================================

-- 检查表是否存在
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'pro_official_groups'
  ) THEN
    ALTER TABLE pro_official_groups ENABLE ROW LEVEL SECURITY;

    -- 删除现有策略
    DROP POLICY IF EXISTS "Pro official groups are viewable by pro members" ON pro_official_groups;

    -- Pro 会员可以查看官方群
    CREATE POLICY "Pro official groups are viewable by pro members"
      ON pro_official_groups FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM subscriptions 
          WHERE user_id = auth.uid() AND tier = 'pro' AND status = 'active'
        )
      );
  END IF;
END $$;

-- ============================================
-- 19. pro_official_group_members 表 - 确保用户只能查看自己的成员关系
-- ============================================

-- 检查表是否存在
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'pro_official_group_members'
  ) THEN
    ALTER TABLE pro_official_group_members ENABLE ROW LEVEL SECURITY;

    -- 删除现有策略
    DROP POLICY IF EXISTS "Pro members can view their membership" ON pro_official_group_members;

    -- Pro 会员只能查看自己的成员关系
    CREATE POLICY "Pro members can view their membership"
      ON pro_official_group_members FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ============================================
-- 20. post_likes 表 - 确保用户只能管理自己的点赞
-- ============================================

-- 检查表是否存在
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'post_likes'
  ) THEN
    ALTER TABLE post_likes ENABLE ROW LEVEL SECURITY;

    -- 删除现有策略
    DROP POLICY IF EXISTS "Post likes are viewable by everyone" ON post_likes;
    DROP POLICY IF EXISTS "Users can insert their own likes" ON post_likes;
    DROP POLICY IF EXISTS "Users can update their own likes" ON post_likes;
    DROP POLICY IF EXISTS "Users can delete their own likes" ON post_likes;

    -- 所有人都可以查看点赞
    CREATE POLICY "Post likes are viewable by everyone"
      ON post_likes FOR SELECT 
      USING (true);

    -- 用户只能创建自己的点赞
    CREATE POLICY "Users can insert their own likes"
      ON post_likes FOR INSERT 
      WITH CHECK (auth.uid() = user_id);

    -- 用户只能更新自己的点赞
    CREATE POLICY "Users can update their own likes"
      ON post_likes FOR UPDATE 
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);

    -- 用户只能删除自己的点赞
    CREATE POLICY "Users can delete their own likes"
      ON post_likes FOR DELETE 
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ============================================
-- 21. post_votes 表 - 确保用户只能管理自己的投票
-- ============================================

-- 检查表是否存在
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'post_votes'
  ) THEN
    ALTER TABLE post_votes ENABLE ROW LEVEL SECURITY;

    -- 删除现有策略
    DROP POLICY IF EXISTS "Post votes are viewable by everyone" ON post_votes;
    DROP POLICY IF EXISTS "Users can insert their own votes" ON post_votes;
    DROP POLICY IF EXISTS "Users can update their own votes" ON post_votes;
    DROP POLICY IF EXISTS "Users can delete their own votes" ON post_votes;

    -- 所有人都可以查看投票
    CREATE POLICY "Post votes are viewable by everyone"
      ON post_votes FOR SELECT 
      USING (true);

    -- 用户只能创建自己的投票
    CREATE POLICY "Users can insert their own votes"
      ON post_votes FOR INSERT 
      WITH CHECK (auth.uid() = user_id);

    -- 用户只能更新自己的投票
    CREATE POLICY "Users can update their own votes"
      ON post_votes FOR UPDATE 
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);

    -- 用户只能删除自己的投票
    CREATE POLICY "Users can delete their own votes"
      ON post_votes FOR DELETE 
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ============================================
-- 22. comment_likes 表 - 确保用户只能管理自己的评论点赞
-- ============================================

-- 检查表是否存在
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'comment_likes'
  ) THEN
    ALTER TABLE comment_likes ENABLE ROW LEVEL SECURITY;

    -- 删除现有策略
    DROP POLICY IF EXISTS "Comment likes are viewable by everyone" ON comment_likes;
    DROP POLICY IF EXISTS "Users can insert their own comment likes" ON comment_likes;
    DROP POLICY IF EXISTS "Users can delete their own comment likes" ON comment_likes;

    -- 所有人都可以查看评论点赞
    CREATE POLICY "Comment likes are viewable by everyone"
      ON comment_likes FOR SELECT 
      USING (true);

    -- 用户只能创建自己的评论点赞
    CREATE POLICY "Users can insert their own comment likes"
      ON comment_likes FOR INSERT 
      WITH CHECK (auth.uid() = user_id);

    -- 用户只能删除自己的评论点赞
    CREATE POLICY "Users can delete their own comment likes"
      ON comment_likes FOR DELETE 
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ============================================
-- 23. subscriptions 表 - 确保用户只能查看自己的订阅
-- ============================================

-- 检查表是否存在
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'subscriptions'
  ) THEN
    ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

    -- 删除现有策略
    DROP POLICY IF EXISTS "Users can view own subscription" ON subscriptions;
    DROP POLICY IF EXISTS "Service role can manage subscriptions" ON subscriptions;

    -- 用户只能查看自己的订阅
    CREATE POLICY "Users can view own subscription"
      ON subscriptions FOR SELECT
      USING (auth.uid() = user_id);

    -- 服务端角色可以管理所有订阅（用于支付回调等）
    CREATE POLICY "Service role can manage subscriptions"
      ON subscriptions FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ============================================
-- 24. group_subscriptions 表 - 确保用户只能访问自己的群组订阅
-- ============================================

-- 检查表是否存在
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'group_subscriptions'
  ) THEN
    ALTER TABLE group_subscriptions ENABLE ROW LEVEL SECURITY;

    -- 删除现有策略
    DROP POLICY IF EXISTS "Users can view their own subscriptions" ON group_subscriptions;
    DROP POLICY IF EXISTS "Group owners can view group subscriptions" ON group_subscriptions;
    DROP POLICY IF EXISTS "Users can create their own subscriptions" ON group_subscriptions;

    -- 用户只能查看自己的订阅
    CREATE POLICY "Users can view their own subscriptions"
      ON group_subscriptions FOR SELECT
      USING (auth.uid() = user_id);

    -- 群组所有者可以查看群组的所有订阅
    CREATE POLICY "Group owners can view group subscriptions"
      ON group_subscriptions FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM group_members gm
          JOIN groups g ON g.id = gm.group_id
          WHERE gm.group_id = group_subscriptions.group_id
          AND gm.user_id = auth.uid()
          AND gm.role IN ('owner', 'admin')
        )
      );

    -- 用户只能创建自己的订阅
    CREATE POLICY "Users can create their own subscriptions"
      ON group_subscriptions FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- ============================================
-- 25. avoid_votes 表 - 确保用户只能管理自己的风险投票
-- ============================================

-- 检查表是否存在
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'avoid_votes'
  ) THEN
    ALTER TABLE avoid_votes ENABLE ROW LEVEL SECURITY;

    -- 删除现有策略
    DROP POLICY IF EXISTS "Active votes are viewable" ON avoid_votes;
    DROP POLICY IF EXISTS "Users can create risk reports" ON avoid_votes;
    DROP POLICY IF EXISTS "Users can update own reports" ON avoid_votes;
    DROP POLICY IF EXISTS "Users can delete own reports" ON avoid_votes;

    -- 所有人都可以查看活跃的投票
    CREATE POLICY "Active votes are viewable"
      ON avoid_votes FOR SELECT
      USING (status = 'active');

    -- 用户只能创建自己的风险投票
    CREATE POLICY "Users can create risk reports"
      ON avoid_votes FOR INSERT
      WITH CHECK (auth.uid() = user_id);

    -- 用户只能更新自己的风险投票
    CREATE POLICY "Users can update own reports"
      ON avoid_votes FOR UPDATE
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);

    -- 用户只能删除自己的风险投票
    CREATE POLICY "Users can delete own reports"
      ON avoid_votes FOR DELETE
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ============================================
-- 26. group_complaint_votes 表 - 确保用户只能管理自己的投诉投票
-- ============================================

-- 检查表是否存在
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'group_complaint_votes'
  ) THEN
    ALTER TABLE group_complaint_votes ENABLE ROW LEVEL SECURITY;

    -- 删除现有策略
    DROP POLICY IF EXISTS "Members can view complaint votes" ON group_complaint_votes;
    DROP POLICY IF EXISTS "Members can vote on complaints" ON group_complaint_votes;

    -- 群组成员可以查看投诉投票
    CREATE POLICY "Members can view complaint votes"
      ON group_complaint_votes FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM group_complaints gc
          JOIN group_members gm ON gm.group_id = gc.group_id
          WHERE gc.id = group_complaint_votes.complaint_id
          AND gm.user_id = auth.uid()
        )
      );

    -- 群组成员可以投票
    CREATE POLICY "Members can vote on complaints"
      ON group_complaint_votes FOR INSERT
      WITH CHECK (
        auth.uid() = user_id
        AND EXISTS (
          SELECT 1 FROM group_complaints gc
          JOIN group_members gm ON gm.group_id = gc.group_id
          WHERE gc.id = group_complaint_votes.complaint_id
          AND gm.user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- ============================================
-- 27. group_leader_votes 表 - 确保用户只能管理自己的组长投票
-- ============================================

-- 检查表是否存在
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'group_leader_votes'
  ) THEN
    ALTER TABLE group_leader_votes ENABLE ROW LEVEL SECURITY;

    -- 删除现有策略
    DROP POLICY IF EXISTS "Anyone can view leader votes" ON group_leader_votes;
    DROP POLICY IF EXISTS "Members can vote for leader" ON group_leader_votes;

    -- 所有人都可以查看组长投票
    CREATE POLICY "Anyone can view leader votes"
      ON group_leader_votes FOR SELECT
      USING (true);

    -- 群组成员可以投票
    CREATE POLICY "Members can vote for leader"
      ON group_leader_votes FOR INSERT
      WITH CHECK (
        auth.uid() = user_id
        AND EXISTS (
          SELECT 1 FROM group_leader_applications gla
          JOIN group_members gm ON gm.group_id = (
            SELECT group_id FROM group_leader_elections 
            WHERE id = gla.election_id
          )
          WHERE gla.id = group_leader_votes.application_id
          AND gm.user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- ============================================
-- 28. folder_subscriptions 表 - 确保用户只能访问自己的文件夹订阅
-- ============================================

-- 检查表是否存在
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'folder_subscriptions'
  ) THEN
    ALTER TABLE folder_subscriptions ENABLE ROW LEVEL SECURITY;

    -- 删除现有策略
    DROP POLICY IF EXISTS "Users can view own subscriptions" ON folder_subscriptions;
    DROP POLICY IF EXISTS "Users can manage own subscriptions" ON folder_subscriptions;
    DROP POLICY IF EXISTS "Users can subscribe to public folders" ON folder_subscriptions;

    -- 用户只能查看自己的订阅
    CREATE POLICY "Users can view own subscriptions"
      ON folder_subscriptions FOR SELECT
      USING (auth.uid() = user_id);

    -- 用户只能管理自己的订阅
    CREATE POLICY "Users can manage own subscriptions"
      ON folder_subscriptions FOR ALL
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- ============================================
-- 完成
-- ============================================
-- 所有用户数据表现在都有完整的 RLS 策略，确保：
-- 1. 用户只能查看、修改、删除自己的数据
-- 2. 公开数据（如帖子、评论）所有人都可以查看
-- 3. 管理员有特殊权限访问管理相关表
-- 4. 群组管理员可以管理群组成员
-- 5. 所有用户相关的表都已启用 RLS 并配置了适当的策略
