-- ============================================
-- 数据库索引优化脚本
-- 在 Supabase Dashboard 的 SQL Editor 中运行
-- 
-- 使用说明：
-- 1. 登录 Supabase Dashboard
-- 2. 进入 SQL Editor
-- 3. 复制此脚本并执行
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
  ON posts(hot_score DESC, created_at DESC);

-- 帖子点赞数排序索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_like_count 
  ON posts(like_count DESC, created_at DESC);

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
-- 第三部分：交易员快照索引（关键性能优化）
-- ============================================

-- 交易员快照复合索引（优化排行榜查询）
-- 注意：字段名是 captured_at 而非 fetched_at
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_snapshots_composite 
  ON trader_snapshots(source, season_id, captured_at DESC, roi DESC);

-- 按 source 和最新时间查询
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_snapshots_source_time 
  ON trader_snapshots(source, captured_at DESC);

-- 按 source 和 season_id 查询（用于时间段筛选）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_snapshots_source_season 
  ON trader_snapshots(source, season_id, captured_at DESC);

-- 按 ROI 排序索引（部分索引，只包含有效数据）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_snapshots_roi 
  ON trader_snapshots(source, roi DESC) 
  WHERE roi IS NOT NULL;

-- 按 PnL 过滤索引（排除 Bybit，用于 PnL >= 1000 过滤）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_snapshots_pnl 
  ON trader_snapshots(source, pnl DESC) 
  WHERE pnl >= 1000;

-- ============================================
-- 第四部分：交易员来源索引
-- ============================================

-- trader_sources 按 source 和 source_trader_id 索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_sources_lookup 
  ON trader_sources(source, source_trader_id);

-- ============================================
-- 第五部分：用户相关索引
-- ============================================

-- 用户 profile 按 handle 索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_profiles_handle 
  ON user_profiles(handle);

-- 用户 profile 按 ID 索引（主键通常已有，但确保存在）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_profiles_id 
  ON user_profiles(id);

-- 用户 profile 按创建时间索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_profiles_created 
  ON user_profiles(created_at DESC);

-- ============================================
-- 第六部分：社交功能索引
-- ============================================

-- 帖子点赞记录（注意：表名可能是 post_likes 或 post_reactions）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_likes_post 
  ON post_likes(post_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_likes_user 
  ON post_likes(user_id);

-- 复合索引用于查询用户是否点赞某帖子
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_likes_user_post 
  ON post_likes(user_id, post_id);

-- 帖子投票记录
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_votes_post 
  ON post_votes(post_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_votes_user 
  ON post_votes(user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_votes_user_post 
  ON post_votes(user_id, post_id);

-- 关注记录按关注者索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_followers_follower 
  ON trader_followers(follower_id, created_at DESC);

-- 关注记录按被关注者索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_followers_trader 
  ON trader_followers(trader_id);

-- ============================================
-- 第七部分：小组相关索引
-- ============================================

-- 小组成员按小组索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_group_members_group 
  ON group_members(group_id);

-- 小组成员按用户索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_group_members_user 
  ON group_members(user_id);

-- 复合索引用于检查用户是否是小组成员
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_group_members_user_group 
  ON group_members(user_id, group_id);

-- ============================================
-- 第八部分：通知索引
-- ============================================

-- 通知按用户和未读状态索引（用于通知中心）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_unread 
  ON notifications(user_id, is_read, created_at DESC);

-- 通知按用户索引（获取所有通知）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user 
  ON notifications(user_id, created_at DESC);

-- ============================================
-- 第九部分：消息相关索引
-- ============================================

-- 会话按参与者索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_participants 
  ON conversations USING GIN (participant_ids);

-- 消息按会话索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_conversation 
  ON messages(conversation_id, created_at DESC);

-- ============================================
-- 第十部分：收藏相关索引
-- ============================================

-- 收藏按用户索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookmarks_user 
  ON bookmarks(user_id, created_at DESC);

-- 收藏按帖子索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookmarks_post 
  ON bookmarks(post_id);

-- ============================================
-- 分析索引使用情况（可选运行）
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

-- 查看表大小和索引大小
-- SELECT
--   relname AS table_name,
--   pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
--   pg_size_pretty(pg_relation_size(relid)) AS table_size,
--   pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid)) AS index_size
-- FROM pg_catalog.pg_statio_user_tables
-- ORDER BY pg_total_relation_size(relid) DESC;

-- ============================================
-- 第十一部分：物化视图（可选 - 高级优化）
-- ============================================

-- 创建排行榜物化视图（缓存 Top 100 交易员）
-- 注意：需要定期刷新
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_top_traders_90d AS
SELECT 
  ts.source,
  ts.source_trader_id,
  ts.roi,
  ts.pnl,
  ts.win_rate,
  ts.max_drawdown,
  ts.trades_count,
  ts.captured_at,
  tsrc.handle,
  tsrc.profile_url
FROM trader_snapshots ts
LEFT JOIN trader_sources tsrc 
  ON ts.source = tsrc.source AND ts.source_trader_id = tsrc.source_trader_id
WHERE ts.season_id = '90D'
  AND ts.captured_at = (
    SELECT MAX(captured_at) 
    FROM trader_snapshots 
    WHERE source = ts.source AND season_id = '90D'
  )
ORDER BY ts.roi DESC
LIMIT 500;

-- 物化视图索引
CREATE INDEX IF NOT EXISTS idx_mv_top_traders_roi 
  ON mv_top_traders_90d(roi DESC);

CREATE INDEX IF NOT EXISTS idx_mv_top_traders_source 
  ON mv_top_traders_90d(source, roi DESC);

-- 刷新物化视图的函数
CREATE OR REPLACE FUNCTION refresh_top_traders_view()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_top_traders_90d;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 第十二部分：查询性能分析函数
-- ============================================

-- 获取慢查询统计
CREATE OR REPLACE FUNCTION get_slow_queries(threshold_ms int DEFAULT 100)
RETURNS TABLE(
  query text,
  calls bigint,
  mean_time float,
  total_time float
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    pg_stat_statements.query,
    pg_stat_statements.calls,
    pg_stat_statements.mean_exec_time,
    pg_stat_statements.total_exec_time
  FROM pg_stat_statements
  WHERE pg_stat_statements.mean_exec_time > threshold_ms
  ORDER BY pg_stat_statements.total_exec_time DESC
  LIMIT 20;
EXCEPTION
  WHEN undefined_table THEN
    -- pg_stat_statements 扩展未启用
    RETURN;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 完成
-- ============================================

SELECT '✅ 索引优化完成！请在 Supabase Dashboard 中运行此脚本。' AS status;
