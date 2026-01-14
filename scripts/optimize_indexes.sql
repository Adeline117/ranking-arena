-- ============================================
-- 数据库索引优化脚本
-- 在 Supabase Dashboard 的 SQL Editor 中运行
-- ============================================

-- ============================================
-- 第一部分：帖子相关索引
-- ============================================

-- 帖子按创建时间倒序索引（用于首页展示）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_created_at_desc 
  ON posts(created_at DESC);

-- 帖子按小组和创建时间索引（用于小组内帖子列表）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_group_created 
  ON posts(group_id, created_at DESC);

-- 帖子按作者索引（用于用户个人主页）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_author_handle 
  ON posts(author_handle, created_at DESC);

-- 帖子热度分数索引（用于热门排序）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_hot_score 
  ON posts(like_count DESC, comment_count DESC, created_at DESC);

-- ============================================
-- 第二部分：评论相关索引
-- ============================================

-- 评论按帖子和创建时间索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_comments_post_created 
  ON comments(post_id, created_at DESC);

-- 评论按作者索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_comments_author 
  ON comments(author_id, created_at DESC);

-- ============================================
-- 第三部分：交易员快照索引
-- ============================================

-- 交易员快照复合索引（优化排行榜查询）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_snapshots_composite 
  ON trader_snapshots(source, season_id, fetched_at DESC, roi DESC);

-- 按 source 和最新时间查询
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_snapshots_source_time 
  ON trader_snapshots(source, fetched_at DESC);

-- 按 ROI 排序索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_snapshots_roi 
  ON trader_snapshots(source, roi DESC) 
  WHERE roi IS NOT NULL;

-- ============================================
-- 第四部分：用户相关索引
-- ============================================

-- 用户 profile 按 handle 索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_profiles_handle 
  ON user_profiles(handle);

-- 用户 profile 按创建时间索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_profiles_created 
  ON user_profiles(created_at DESC);

-- ============================================
-- 第五部分：社交功能索引
-- ============================================

-- 点赞记录按帖子索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_reactions_post 
  ON post_reactions(post_id);

-- 点赞记录按用户索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_reactions_user 
  ON post_reactions(user_id);

-- 关注记录按关注者索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_followers_follower 
  ON trader_followers(follower_id, created_at DESC);

-- 关注记录按被关注者索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_followers_trader 
  ON trader_followers(trader_id);

-- ============================================
-- 第六部分：小组相关索引
-- ============================================

-- 小组成员按小组索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_group_members_group 
  ON group_members(group_id);

-- 小组成员按用户索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_group_members_user 
  ON group_members(user_id);

-- ============================================
-- 第七部分：通知索引
-- ============================================

-- 通知按用户和未读状态索引（用于通知中心）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_unread 
  ON notifications(user_id, is_read, created_at DESC);

-- ============================================
-- 第八部分：分析索引使用情况
-- ============================================

-- 查看索引使用统计（运行此查询查看哪些索引被使用）
-- SELECT 
--   schemaname,
--   tablename,
--   indexname,
--   idx_scan,
--   idx_tup_read,
--   idx_tup_fetch
-- FROM pg_stat_user_indexes
-- ORDER BY idx_scan DESC;

-- ============================================
-- 完成
-- ============================================

SELECT '✅ 索引优化完成！' AS status;

