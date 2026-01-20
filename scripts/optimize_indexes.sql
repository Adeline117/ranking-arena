-- ============================================
-- 数据库索引优化脚本 (安全版本)
-- 
-- 用途: 优化常用查询的性能
-- 运行: 在 Supabase SQL Editor 中执行
-- 注意: 此脚本只为已存在的列创建索引
-- ============================================

-- 1. trader_sources 表优化
-- ============================================

-- 按来源查询
CREATE INDEX IF NOT EXISTS idx_trader_sources_source 
ON trader_sources(source);

-- Handle 查询 (单个交易员页面)
CREATE INDEX IF NOT EXISTS idx_trader_sources_handle 
ON trader_sources(handle) 
WHERE handle IS NOT NULL;

-- 更新时间排序
CREATE INDEX IF NOT EXISTS idx_trader_sources_updated_at 
ON trader_sources(updated_at DESC);


-- 2. trader_snapshots 表优化
-- ============================================

-- 按来源和交易员查询
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_source_trader 
ON trader_snapshots(source, source_trader_id);

-- 按 ROI 排序 (排行榜)
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_roi 
ON trader_snapshots(roi DESC NULLS LAST);

-- 按赛季筛选
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_season 
ON trader_snapshots(season_id, roi DESC NULLS LAST);

-- 按捕获时间排序
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_captured 
ON trader_snapshots(source, source_trader_id, captured_at DESC);


-- 3. trader_stats_detail 表优化 (如果存在)
-- ============================================

DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'trader_stats_detail') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_trader_stats_source_trader ON trader_stats_detail(source, source_trader_id)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_trader_stats_period ON trader_stats_detail(source, source_trader_id, period)';
  END IF;
END $$;


-- 4. trader_portfolio 表优化 (如果存在)
-- ============================================

DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'trader_portfolio') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_trader_portfolio_source_trader ON trader_portfolio(source, source_trader_id)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_trader_portfolio_captured ON trader_portfolio(source, source_trader_id, captured_at DESC)';
  END IF;
END $$;


-- 5. trader_position_history 表优化 (如果存在)
-- ============================================

DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'trader_position_history') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_trader_positions_source_trader ON trader_position_history(source, source_trader_id)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_trader_positions_close_time ON trader_position_history(source, source_trader_id, close_time DESC)';
  END IF;
END $$;


-- 6. trader_equity_curve 表优化 (如果存在)
-- ============================================

DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'trader_equity_curve') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_equity_curve_source_period ON trader_equity_curve(source, source_trader_id, period)';
  END IF;
END $$;


-- 7. posts 表优化 (如果存在)
-- ============================================

DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'posts') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id, created_at DESC)';
  END IF;
END $$;


-- 8. comments 表优化 (如果存在)
-- ============================================

DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'comments') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id, created_at ASC)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_comments_user_id ON comments(user_id, created_at DESC)';
  END IF;
END $$;


-- 9. user_profiles 表优化 (如果存在)
-- ============================================

DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'user_profiles') THEN
    -- 检查 handle 列是否存在
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'user_profiles' AND column_name = 'handle') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_user_profiles_handle ON user_profiles(handle) WHERE handle IS NOT NULL';
    END IF;
  END IF;
END $$;


-- 10. notifications 表优化 (如果存在)
-- ============================================

DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'notifications') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, read, created_at DESC)';
  END IF;
END $$;


-- 11. trader_follows 表优化 (如果存在)
-- ============================================

DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'trader_follows') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_trader_follows_user ON trader_follows(user_id)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_trader_follows_trader ON trader_follows(trader_id)';
  END IF;
END $$;


-- 12. groups 表优化 (如果存在)
-- ============================================

DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'groups') THEN
    -- 检查 member_count 列是否存在
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'groups' AND column_name = 'member_count') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_groups_member_count ON groups(member_count DESC)';
    END IF;
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_groups_created_at ON groups(created_at DESC)';
  END IF;
END $$;


-- ============================================
-- 验证索引创建
-- ============================================

-- 查看所有自定义索引
SELECT 
  schemaname,
  tablename,
  indexname
FROM pg_indexes 
WHERE schemaname = 'public' 
  AND indexname LIKE 'idx_%'
ORDER BY tablename, indexname;


-- ============================================
-- 更新统计信息
-- ============================================

ANALYZE trader_sources;
ANALYZE trader_snapshots;
