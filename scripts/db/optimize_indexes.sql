-- ============================================
-- 数据库索引优化脚本 (完全安全版本)
-- 
-- 用途: 优化常用查询的性能
-- 运行: 在 Supabase SQL Editor 中执行
-- 注意: 所有索引都会先检查列是否存在
-- ============================================

-- 辅助函数：安全创建索引
CREATE OR REPLACE FUNCTION safe_create_index(
  p_index_name TEXT,
  p_table_name TEXT,
  p_column_names TEXT[],
  p_index_def TEXT
) RETURNS VOID AS $$
DECLARE
  v_column TEXT;
  v_all_exist BOOLEAN := TRUE;
BEGIN
  -- 检查表是否存在
  IF NOT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = p_table_name) THEN
    RAISE NOTICE 'Table % does not exist, skipping index %', p_table_name, p_index_name;
    RETURN;
  END IF;
  
  -- 检查所有列是否存在
  FOREACH v_column IN ARRAY p_column_names LOOP
    IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = p_table_name AND column_name = v_column) THEN
      RAISE NOTICE 'Column %.% does not exist, skipping index %', p_table_name, v_column, p_index_name;
      v_all_exist := FALSE;
    END IF;
  END LOOP;
  
  -- 如果所有列都存在，创建索引
  IF v_all_exist THEN
    EXECUTE p_index_def;
    RAISE NOTICE 'Created index %', p_index_name;
  END IF;
END;
$$ LANGUAGE plpgsql;


-- ============================================
-- 1. trader_sources 表索引
-- ============================================

SELECT safe_create_index(
  'idx_trader_sources_source',
  'trader_sources',
  ARRAY['source'],
  'CREATE INDEX IF NOT EXISTS idx_trader_sources_source ON trader_sources(source)'
);

SELECT safe_create_index(
  'idx_trader_sources_handle',
  'trader_sources',
  ARRAY['handle'],
  'CREATE INDEX IF NOT EXISTS idx_trader_sources_handle ON trader_sources(handle) WHERE handle IS NOT NULL'
);

SELECT safe_create_index(
  'idx_trader_sources_created_at',
  'trader_sources',
  ARRAY['created_at'],
  'CREATE INDEX IF NOT EXISTS idx_trader_sources_created_at ON trader_sources(created_at DESC)'
);


-- ============================================
-- 2. trader_snapshots 表索引
-- ============================================

SELECT safe_create_index(
  'idx_trader_snapshots_source_trader',
  'trader_snapshots',
  ARRAY['source', 'source_trader_id'],
  'CREATE INDEX IF NOT EXISTS idx_trader_snapshots_source_trader ON trader_snapshots(source, source_trader_id)'
);

SELECT safe_create_index(
  'idx_trader_snapshots_roi',
  'trader_snapshots',
  ARRAY['roi'],
  'CREATE INDEX IF NOT EXISTS idx_trader_snapshots_roi ON trader_snapshots(roi DESC NULLS LAST)'
);

SELECT safe_create_index(
  'idx_trader_snapshots_season',
  'trader_snapshots',
  ARRAY['season_id', 'roi'],
  'CREATE INDEX IF NOT EXISTS idx_trader_snapshots_season ON trader_snapshots(season_id, roi DESC NULLS LAST)'
);

SELECT safe_create_index(
  'idx_trader_snapshots_captured',
  'trader_snapshots',
  ARRAY['source', 'source_trader_id', 'captured_at'],
  'CREATE INDEX IF NOT EXISTS idx_trader_snapshots_captured ON trader_snapshots(source, source_trader_id, captured_at DESC)'
);


-- ============================================
-- 3. trader_stats_detail 表索引
-- ============================================

SELECT safe_create_index(
  'idx_trader_stats_source_trader',
  'trader_stats_detail',
  ARRAY['source', 'source_trader_id'],
  'CREATE INDEX IF NOT EXISTS idx_trader_stats_source_trader ON trader_stats_detail(source, source_trader_id)'
);

SELECT safe_create_index(
  'idx_trader_stats_period',
  'trader_stats_detail',
  ARRAY['source', 'source_trader_id', 'period'],
  'CREATE INDEX IF NOT EXISTS idx_trader_stats_period ON trader_stats_detail(source, source_trader_id, period)'
);


-- ============================================
-- 4. trader_portfolio 表索引
-- ============================================

SELECT safe_create_index(
  'idx_trader_portfolio_source_trader',
  'trader_portfolio',
  ARRAY['source', 'source_trader_id'],
  'CREATE INDEX IF NOT EXISTS idx_trader_portfolio_source_trader ON trader_portfolio(source, source_trader_id)'
);

SELECT safe_create_index(
  'idx_trader_portfolio_captured',
  'trader_portfolio',
  ARRAY['source', 'source_trader_id', 'captured_at'],
  'CREATE INDEX IF NOT EXISTS idx_trader_portfolio_captured ON trader_portfolio(source, source_trader_id, captured_at DESC)'
);


-- ============================================
-- 5. trader_position_history 表索引
-- ============================================

SELECT safe_create_index(
  'idx_trader_positions_source_trader',
  'trader_position_history',
  ARRAY['source', 'source_trader_id'],
  'CREATE INDEX IF NOT EXISTS idx_trader_positions_source_trader ON trader_position_history(source, source_trader_id)'
);

SELECT safe_create_index(
  'idx_trader_positions_close_time',
  'trader_position_history',
  ARRAY['source', 'source_trader_id', 'close_time'],
  'CREATE INDEX IF NOT EXISTS idx_trader_positions_close_time ON trader_position_history(source, source_trader_id, close_time DESC)'
);


-- ============================================
-- 6. trader_equity_curve 表索引
-- ============================================

SELECT safe_create_index(
  'idx_equity_curve_source_period',
  'trader_equity_curve',
  ARRAY['source', 'source_trader_id', 'period'],
  'CREATE INDEX IF NOT EXISTS idx_equity_curve_source_period ON trader_equity_curve(source, source_trader_id, period)'
);


-- ============================================
-- 7. posts 表索引
-- ============================================

SELECT safe_create_index(
  'idx_posts_created_at',
  'posts',
  ARRAY['created_at'],
  'CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC)'
);

SELECT safe_create_index(
  'idx_posts_author',
  'posts',
  ARRAY['author_id', 'created_at'],
  'CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id, created_at DESC)'
);


-- ============================================
-- 8. comments 表索引
-- ============================================

SELECT safe_create_index(
  'idx_comments_post_id',
  'comments',
  ARRAY['post_id', 'created_at'],
  'CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id, created_at ASC)'
);


-- ============================================
-- 9. user_profiles 表索引
-- ============================================

SELECT safe_create_index(
  'idx_user_profiles_handle',
  'user_profiles',
  ARRAY['handle'],
  'CREATE INDEX IF NOT EXISTS idx_user_profiles_handle ON user_profiles(handle) WHERE handle IS NOT NULL'
);


-- ============================================
-- 10. notifications 表索引
-- ============================================

SELECT safe_create_index(
  'idx_notifications_user_unread',
  'notifications',
  ARRAY['user_id', 'read', 'created_at'],
  'CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, read, created_at DESC)'
);


-- ============================================
-- 11. groups 表索引
-- ============================================

SELECT safe_create_index(
  'idx_groups_created_at',
  'groups',
  ARRAY['created_at'],
  'CREATE INDEX IF NOT EXISTS idx_groups_created_at ON groups(created_at DESC)'
);

SELECT safe_create_index(
  'idx_groups_member_count',
  'groups',
  ARRAY['member_count'],
  'CREATE INDEX IF NOT EXISTS idx_groups_member_count ON groups(member_count DESC)'
);


-- ============================================
-- 清理辅助函数
-- ============================================

DROP FUNCTION IF EXISTS safe_create_index(TEXT, TEXT, TEXT[], TEXT);


-- ============================================
-- 查看创建的索引
-- ============================================

SELECT 
  tablename,
  indexname
FROM pg_indexes 
WHERE schemaname = 'public' 
  AND indexname LIKE 'idx_%'
ORDER BY tablename, indexname;
