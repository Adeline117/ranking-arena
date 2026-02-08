-- ============================================================
-- 00063: 性能优化 - 补充复合索引
-- 
-- 目的：为高频查询路径添加缺失的复合索引
-- 影响：只读操作，不影响现有数据或功能
-- ============================================================

-- trader_snapshots: (source, captured_at DESC)
-- 已存在于 00004_performance_optimizations.sql (idx_trader_snapshots_source_time)
-- 跳过，避免重复

-- leaderboard_ranks: 排行榜查询优化
-- /api/traders 按 season_id 筛选 + arena_score 排序
-- 注意：leaderboard_ranks 表可能通过 compute-leaderboard cron 动态创建
CREATE INDEX IF NOT EXISTS idx_leaderboard_ranks_season_score
  ON leaderboard_ranks(season_id, arena_score DESC);

-- leaderboard_ranks: 按 source 筛选（交易所过滤）
CREATE INDEX IF NOT EXISTS idx_leaderboard_ranks_season_source
  ON leaderboard_ranks(season_id, source);

-- leaderboard_ranks: rank 排序（cursor 分页）
CREATE INDEX IF NOT EXISTS idx_leaderboard_ranks_season_rank
  ON leaderboard_ranks(season_id, rank ASC);

-- library_items: 分类 + 创建时间排序（/api/library 默认排序）
-- 已有 idx_library_category 单列索引，添加复合索引覆盖排序
CREATE INDEX IF NOT EXISTS idx_library_items_category_created
  ON library_items(category, created_at DESC);

-- flash_news: (published_at DESC) 
-- 已存在于 00059_flash_news.sql (idx_flash_news_published)
-- 跳过，避免重复
