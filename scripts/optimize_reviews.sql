-- ============================================
-- 评价系统性能优化
-- 物化视图替代实时 VIEW 聚合
-- ============================================

-- 1. 创建物化视图替代原有的 VIEW
-- 物化视图会存储聚合结果，避免每次查询都全表扫描

-- 先删除原有的 VIEW（如果存在）
DROP VIEW IF EXISTS trader_community_scores;

-- 创建物化视图
CREATE MATERIALIZED VIEW IF NOT EXISTS trader_community_scores AS
SELECT 
  trader_id,
  source,
  ROUND(AVG(overall_rating)::NUMERIC, 2) as avg_rating,
  ROUND(AVG(stability_rating)::NUMERIC, 2) as avg_stability,
  ROUND(AVG(drawdown_rating)::NUMERIC, 2) as avg_drawdown,
  COUNT(*) as review_count,
  ROUND(AVG(CASE WHEN would_recommend THEN 1 ELSE 0 END)::NUMERIC, 2) as recommend_rate,
  ROUND(AVG(follow_duration_days)::NUMERIC, 0) as avg_follow_days,
  ROUND(AVG(profit_loss_percent)::NUMERIC, 2) as avg_profit_loss,
  COUNT(CASE WHEN verified THEN 1 END) as verified_reviews,
  MAX(created_at) as last_review_at
FROM trader_reviews
GROUP BY trader_id, source;

-- 创建唯一索引（用于并发刷新）
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_scores_trader 
ON trader_community_scores(trader_id, source);

-- 创建额外的查询优化索引
CREATE INDEX IF NOT EXISTS idx_community_scores_review_count 
ON trader_community_scores(review_count DESC);

CREATE INDEX IF NOT EXISTS idx_community_scores_rating 
ON trader_community_scores(avg_rating DESC);

-- ============================================
-- 2. 创建刷新函数
-- ============================================

-- 刷新物化视图的函数
CREATE OR REPLACE FUNCTION refresh_community_scores()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY trader_community_scores;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 3. 创建触发器自动刷新
-- 每次评价变更后，标记需要刷新（延迟刷新策略）
-- ============================================

-- 创建刷新状态表
CREATE TABLE IF NOT EXISTS materialized_view_refresh_status (
  view_name TEXT PRIMARY KEY,
  needs_refresh BOOLEAN DEFAULT FALSE,
  last_refresh_at TIMESTAMPTZ,
  last_marked_at TIMESTAMPTZ
);

-- 初始化状态
INSERT INTO materialized_view_refresh_status (view_name, needs_refresh, last_refresh_at)
VALUES ('trader_community_scores', FALSE, NOW())
ON CONFLICT (view_name) DO NOTHING;

-- 标记需要刷新的函数
CREATE OR REPLACE FUNCTION mark_community_scores_for_refresh()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE materialized_view_refresh_status
  SET needs_refresh = TRUE, last_marked_at = NOW()
  WHERE view_name = 'trader_community_scores';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 创建触发器（在评价表变更后标记）
DROP TRIGGER IF EXISTS trg_mark_refresh_on_review_change ON trader_reviews;
CREATE TRIGGER trg_mark_refresh_on_review_change
  AFTER INSERT OR UPDATE OR DELETE ON trader_reviews
  FOR EACH STATEMENT
  EXECUTE FUNCTION mark_community_scores_for_refresh();

-- ============================================
-- 4. 定期刷新的辅助函数
-- 由 Cron 调用，只在需要时刷新
-- ============================================

CREATE OR REPLACE FUNCTION refresh_community_scores_if_needed()
RETURNS BOOLEAN AS $$
DECLARE
  should_refresh BOOLEAN;
BEGIN
  -- 检查是否需要刷新
  SELECT needs_refresh INTO should_refresh
  FROM materialized_view_refresh_status
  WHERE view_name = 'trader_community_scores';
  
  IF should_refresh THEN
    -- 执行刷新
    REFRESH MATERIALIZED VIEW CONCURRENTLY trader_community_scores;
    
    -- 更新状态
    UPDATE materialized_view_refresh_status
    SET needs_refresh = FALSE, last_refresh_at = NOW()
    WHERE view_name = 'trader_community_scores';
    
    RETURN TRUE;
  END IF;
  
  RETURN FALSE;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 5. 避雷榜物化视图优化
-- ============================================

-- 先删除原有的 VIEW
DROP VIEW IF EXISTS trader_avoid_scores;

-- 创建物化视图
CREATE MATERIALIZED VIEW IF NOT EXISTS trader_avoid_scores AS
SELECT 
  trader_id,
  source,
  COUNT(*) as avoid_count,
  COUNT(CASE WHEN reason_type = 'high_drawdown' THEN 1 END) as high_drawdown_count,
  COUNT(CASE WHEN reason_type = 'fake_data' THEN 1 END) as fake_data_count,
  COUNT(CASE WHEN reason_type = 'inconsistent' THEN 1 END) as inconsistent_count,
  ROUND(AVG(loss_percent)::NUMERIC, 2) as avg_loss_percent,
  ROUND(AVG(follow_duration_days)::NUMERIC, 0) as avg_follow_days,
  MAX(created_at) as latest_vote_at
FROM avoid_votes
GROUP BY trader_id, source
HAVING COUNT(*) >= 3;  -- 至少 3 票才上榜

-- 创建唯一索引
CREATE UNIQUE INDEX IF NOT EXISTS idx_avoid_scores_trader 
ON trader_avoid_scores(trader_id, source);

-- 创建排序索引
CREATE INDEX IF NOT EXISTS idx_avoid_scores_count 
ON trader_avoid_scores(avoid_count DESC);

-- 添加到刷新状态表
INSERT INTO materialized_view_refresh_status (view_name, needs_refresh, last_refresh_at)
VALUES ('trader_avoid_scores', FALSE, NOW())
ON CONFLICT (view_name) DO NOTHING;

-- 避雷投票变更触发器
CREATE OR REPLACE FUNCTION mark_avoid_scores_for_refresh()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE materialized_view_refresh_status
  SET needs_refresh = TRUE, last_marked_at = NOW()
  WHERE view_name = 'trader_avoid_scores';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mark_refresh_on_avoid_vote_change ON avoid_votes;
CREATE TRIGGER trg_mark_refresh_on_avoid_vote_change
  AFTER INSERT OR UPDATE OR DELETE ON avoid_votes
  FOR EACH STATEMENT
  EXECUTE FUNCTION mark_avoid_scores_for_refresh();

-- 避雷榜刷新函数
CREATE OR REPLACE FUNCTION refresh_avoid_scores_if_needed()
RETURNS BOOLEAN AS $$
DECLARE
  should_refresh BOOLEAN;
BEGIN
  SELECT needs_refresh INTO should_refresh
  FROM materialized_view_refresh_status
  WHERE view_name = 'trader_avoid_scores';
  
  IF should_refresh THEN
    REFRESH MATERIALIZED VIEW CONCURRENTLY trader_avoid_scores;
    
    UPDATE materialized_view_refresh_status
    SET needs_refresh = FALSE, last_refresh_at = NOW()
    WHERE view_name = 'trader_avoid_scores';
    
    RETURN TRUE;
  END IF;
  
  RETURN FALSE;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 6. 一键刷新所有物化视图
-- ============================================

CREATE OR REPLACE FUNCTION refresh_all_materialized_views()
RETURNS TABLE(view_name TEXT, refreshed BOOLEAN) AS $$
BEGIN
  view_name := 'trader_community_scores';
  SELECT refresh_community_scores_if_needed() INTO refreshed;
  RETURN NEXT;
  
  view_name := 'trader_avoid_scores';
  SELECT refresh_avoid_scores_if_needed() INTO refreshed;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 7. 首次执行刷新
-- ============================================

-- 立即刷新一次以填充数据
SELECT refresh_community_scores();
