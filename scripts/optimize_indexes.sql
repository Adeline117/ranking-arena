-- ============================================
-- 数据库索引优化脚本
-- 
-- 用途: 优化常用查询的性能
-- 运行: 在 Supabase SQL Editor 中执行
-- ============================================

-- 1. trader_sources 表优化
-- ============================================

-- 按来源和活跃状态查询 (排行榜页面)
CREATE INDEX IF NOT EXISTS idx_trader_sources_source_active 
ON trader_sources(source, is_active) 
WHERE is_active = true;

-- 按 arena_score 排序 (排行榜排序)
CREATE INDEX IF NOT EXISTS idx_trader_sources_arena_score 
ON trader_sources(arena_score DESC NULLS LAST) 
WHERE is_active = true;

-- 按 ROI 排序 (各时间段)
CREATE INDEX IF NOT EXISTS idx_trader_sources_roi_7d 
ON trader_sources(roi_7d DESC NULLS LAST) 
WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_trader_sources_roi_30d 
ON trader_sources(roi_30d DESC NULLS LAST) 
WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_trader_sources_roi_90d 
ON trader_sources(roi_90d DESC NULLS LAST) 
WHERE is_active = true;

-- Handle 查询 (单个交易员页面)
CREATE UNIQUE INDEX IF NOT EXISTS idx_trader_sources_handle 
ON trader_sources(handle) 
WHERE handle IS NOT NULL;

-- 增量更新查询 (cron 任务)
CREATE INDEX IF NOT EXISTS idx_trader_sources_updated_at 
ON trader_sources(updated_at ASC NULLS FIRST) 
WHERE is_active = true;

-- 复合索引: 来源 + 交易员 ID (详情查询)
CREATE UNIQUE INDEX IF NOT EXISTS idx_trader_sources_source_id 
ON trader_sources(source, source_trader_id);


-- 2. trader_stats_detail 表优化
-- ============================================

-- 按来源和交易员查询
CREATE INDEX IF NOT EXISTS idx_trader_stats_source_trader 
ON trader_stats_detail(source, source_trader_id);

-- 按时间段筛选
CREATE INDEX IF NOT EXISTS idx_trader_stats_period 
ON trader_stats_detail(source, source_trader_id, period);


-- 3. trader_portfolio 表优化
-- ============================================

-- 按来源和交易员查询当前持仓
CREATE INDEX IF NOT EXISTS idx_trader_portfolio_source_trader 
ON trader_portfolio(source, source_trader_id);

-- 按捕获时间排序
CREATE INDEX IF NOT EXISTS idx_trader_portfolio_captured 
ON trader_portfolio(source, source_trader_id, captured_at DESC);


-- 4. trader_position_history 表优化
-- ============================================

-- 按来源和交易员查询历史仓位
CREATE INDEX IF NOT EXISTS idx_trader_positions_source_trader 
ON trader_position_history(source, source_trader_id);

-- 按关闭时间排序 (最近交易)
CREATE INDEX IF NOT EXISTS idx_trader_positions_close_time 
ON trader_position_history(source, source_trader_id, close_time DESC);


-- 5. trader_equity_curve 表优化
-- ============================================

-- 按来源、交易员和时间段查询
CREATE INDEX IF NOT EXISTS idx_equity_curve_source_period 
ON trader_equity_curve(source, source_trader_id, period);

-- 按日期排序
CREATE INDEX IF NOT EXISTS idx_equity_curve_date 
ON trader_equity_curve(source, source_trader_id, period, data_date);


-- 6. trader_asset_breakdown 表优化
-- ============================================

-- 按来源、交易员和时间段查询
CREATE INDEX IF NOT EXISTS idx_asset_breakdown_source_period 
ON trader_asset_breakdown(source, source_trader_id, period);


-- 7. posts 表优化
-- ============================================

-- 按创建时间排序 (时间线)
CREATE INDEX IF NOT EXISTS idx_posts_created_at 
ON posts(created_at DESC);

-- 按小组筛选
CREATE INDEX IF NOT EXISTS idx_posts_group_id 
ON posts(group_id, created_at DESC) 
WHERE group_id IS NOT NULL;

-- 按作者筛选
CREATE INDEX IF NOT EXISTS idx_posts_author 
ON posts(author_id, created_at DESC);

-- 热门帖子 (点赞数排序)
CREATE INDEX IF NOT EXISTS idx_posts_like_count 
ON posts(like_count DESC);


-- 8. comments 表优化
-- ============================================

-- 按帖子查询评论
CREATE INDEX IF NOT EXISTS idx_comments_post_id 
ON comments(post_id, created_at ASC);

-- 按用户查询评论
CREATE INDEX IF NOT EXISTS idx_comments_user_id 
ON comments(user_id, created_at DESC);


-- 9. user_profiles 表优化
-- ============================================

-- 按 handle 查询
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_handle 
ON user_profiles(handle) 
WHERE handle IS NOT NULL;

-- 订阅状态查询
CREATE INDEX IF NOT EXISTS idx_user_profiles_subscription 
ON user_profiles(subscription_tier) 
WHERE subscription_tier != 'free';


-- 10. notifications 表优化
-- ============================================

-- 按用户和未读状态查询
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread 
ON notifications(user_id, read, created_at DESC);


-- 11. trader_follows 表优化
-- ============================================

-- 按用户查询关注列表
CREATE INDEX IF NOT EXISTS idx_trader_follows_user 
ON trader_follows(user_id);

-- 按交易员查询粉丝
CREATE INDEX IF NOT EXISTS idx_trader_follows_trader 
ON trader_follows(trader_id);


-- 12. groups 表优化
-- ============================================

-- 按成员数排序
CREATE INDEX IF NOT EXISTS idx_groups_member_count 
ON groups(member_count DESC);

-- 按创建时间排序
CREATE INDEX IF NOT EXISTS idx_groups_created_at 
ON groups(created_at DESC);


-- ============================================
-- 验证索引创建
-- ============================================

-- 查看所有自定义索引
SELECT 
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes 
WHERE schemaname = 'public' 
  AND indexname LIKE 'idx_%'
ORDER BY tablename, indexname;


-- ============================================
-- 性能分析建议
-- ============================================

-- 1. 定期运行 ANALYZE 更新统计信息
-- ANALYZE trader_sources;
-- ANALYZE posts;
-- ANALYZE user_profiles;

-- 2. 监控慢查询
-- SELECT * FROM pg_stat_statements 
-- ORDER BY total_exec_time DESC 
-- LIMIT 20;

-- 3. 检查索引使用情况
-- SELECT 
--   relname as table,
--   indexrelname as index,
--   idx_scan as scans,
--   idx_tup_read as tuples_read,
--   idx_tup_fetch as tuples_fetched
-- FROM pg_stat_user_indexes
-- WHERE schemaname = 'public'
-- ORDER BY idx_scan DESC;
