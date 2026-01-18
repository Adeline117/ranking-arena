-- 性能优化迁移
-- 版本: 1.0.0
-- 创建日期: 2024
-- 描述: 添加复合索引、物化视图和查询优化

-- ============================================
-- 1. 交易员快照复合索引
-- ============================================

-- 排行榜查询优化：按来源、赛季和ROI排序
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_leaderboard 
  ON trader_snapshots(source, season_id, roi DESC NULLS LAST)
  WHERE roi IS NOT NULL;

-- 按时间范围查询最新快照
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_latest
  ON trader_snapshots(source, source_trader_id, captured_at DESC);

-- 按来源和时间范围筛选
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_source_time
  ON trader_snapshots(source, captured_at DESC);

-- 全局排行榜（跨平台）
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_global_roi
  ON trader_snapshots(season_id, roi DESC NULLS LAST)
  WHERE roi IS NOT NULL;

-- ============================================
-- 2. 帖子表复合索引
-- ============================================

-- 热门帖子排序（假设有 hot_score 字段）
-- 如果表中没有 hot_score，跳过此索引
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'hot_score'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_posts_hot_score ON posts(hot_score DESC NULLS LAST, created_at DESC)';
  END IF;
END $$;

-- 按组和时间排序
CREATE INDEX IF NOT EXISTS idx_posts_group_created
  ON posts(group_id, created_at DESC)
  WHERE group_id IS NOT NULL;

-- 按作者和时间排序
CREATE INDEX IF NOT EXISTS idx_posts_author_created
  ON posts(author_id, created_at DESC)
  WHERE author_id IS NOT NULL;

-- 点赞数排序
CREATE INDEX IF NOT EXISTS idx_posts_like_count
  ON posts(like_count DESC, created_at DESC);

-- ============================================
-- 3. 评论表复合索引
-- ============================================

-- 按帖子和时间排序
CREATE INDEX IF NOT EXISTS idx_comments_post_created
  ON comments(post_id, created_at ASC);

-- 按父评论查询子评论
CREATE INDEX IF NOT EXISTS idx_comments_parent_created
  ON comments(parent_id, created_at ASC)
  WHERE parent_id IS NOT NULL;

-- ============================================
-- 4. 物化视图：排行榜缓存
-- ============================================

-- 创建排行榜物化视图（每个来源和赛季的 Top 100）
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_leaderboard AS
WITH latest_snapshots AS (
  SELECT DISTINCT ON (source, source_trader_id, season_id)
    ts.id,
    ts.source,
    ts.source_trader_id,
    ts.season_id,
    ts.rank,
    ts.roi,
    ts.pnl,
    ts.followers,
    ts.win_rate,
    ts.max_drawdown,
    ts.trades_count,
    ts.captured_at,
    tr.handle,
    tr.profile_url
  FROM trader_snapshots ts
  LEFT JOIN trader_sources tr ON ts.source = tr.source AND ts.source_trader_id = tr.source_trader_id
  WHERE ts.roi IS NOT NULL
  ORDER BY ts.source, ts.source_trader_id, ts.season_id, ts.captured_at DESC
),
ranked AS (
  SELECT 
    *,
    ROW_NUMBER() OVER (PARTITION BY source, season_id ORDER BY roi DESC) as leaderboard_rank
  FROM latest_snapshots
)
SELECT * FROM ranked WHERE leaderboard_rank <= 100;

-- 物化视图索引
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_leaderboard_pk 
  ON mv_leaderboard(source, source_trader_id, season_id);

CREATE INDEX IF NOT EXISTS idx_mv_leaderboard_source_season
  ON mv_leaderboard(source, season_id, leaderboard_rank);

CREATE INDEX IF NOT EXISTS idx_mv_leaderboard_roi
  ON mv_leaderboard(source, season_id, roi DESC);

-- ============================================
-- 5. 物化视图：热门帖子
-- ============================================

-- 创建热门帖子物化视图
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hot_posts AS
SELECT 
  p.id,
  p.title,
  p.content,
  p.author_id,
  p.author_handle,
  p.group_id,
  p.like_count,
  p.comment_count,
  p.repost_count,
  p.view_count,
  p.created_at,
  -- 热度计算公式：点赞*3 + 评论*5 + 转发*2 + 浏览*0.1 - 时间衰减
  (
    p.like_count * 3 + 
    p.comment_count * 5 + 
    p.repost_count * 2 + 
    p.view_count * 0.1 -
    EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600 * 0.5
  ) as hot_score
FROM posts p
WHERE p.created_at > NOW() - INTERVAL '7 days'
ORDER BY hot_score DESC
LIMIT 500;

-- 物化视图索引
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_hot_posts_pk ON mv_hot_posts(id);
CREATE INDEX IF NOT EXISTS idx_mv_hot_posts_score ON mv_hot_posts(hot_score DESC);
CREATE INDEX IF NOT EXISTS idx_mv_hot_posts_group ON mv_hot_posts(group_id, hot_score DESC);

-- ============================================
-- 6. 刷新函数
-- ============================================

-- 创建刷新排行榜物化视图的函数
CREATE OR REPLACE FUNCTION refresh_leaderboard_mv()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_leaderboard;
END;
$$ LANGUAGE plpgsql;

-- 创建刷新热门帖子物化视图的函数
CREATE OR REPLACE FUNCTION refresh_hot_posts_mv()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_hot_posts;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 7. 统计信息收集
-- ============================================

-- 更新表统计信息以优化查询计划
ANALYZE trader_snapshots;
ANALYZE trader_sources;
ANALYZE posts;
ANALYZE comments;

-- ============================================
-- 8. 查询优化提示
-- ============================================

-- 为排行榜查询添加注释说明最佳查询方式
COMMENT ON MATERIALIZED VIEW mv_leaderboard IS '
排行榜缓存视图。建议每 10-30 分钟刷新一次。
使用方式:
  SELECT * FROM mv_leaderboard 
  WHERE source = ''binance_futures'' AND season_id = ''7D''
  ORDER BY leaderboard_rank
  LIMIT 100;
';

COMMENT ON MATERIALIZED VIEW mv_hot_posts IS '
热门帖子缓存视图。建议每 5-10 分钟刷新一次。
使用方式:
  SELECT * FROM mv_hot_posts
  ORDER BY hot_score DESC
  LIMIT 20;
';

-- ============================================
-- 9. Cron 日志表（如果不存在）
-- ============================================

CREATE TABLE IF NOT EXISTS cron_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  ran_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  result TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cron_logs_name_ran ON cron_logs(name, ran_at DESC);

-- ============================================
-- 10. 定时刷新（需要 pg_cron 扩展）
-- ============================================

-- 注意：以下需要在 Supabase Dashboard 中启用 pg_cron 扩展
-- 然后手动执行这些命令

-- 每 15 分钟刷新排行榜
-- SELECT cron.schedule('refresh-leaderboard', '*/15 * * * *', 'SELECT refresh_leaderboard_mv()');

-- 每 5 分钟刷新热门帖子
-- SELECT cron.schedule('refresh-hot-posts', '*/5 * * * *', 'SELECT refresh_hot_posts_mv()');
