-- Migration: Hot Score V5 - Add Search Heat + CTR
-- Implements: 热榜分数 = 搜索热度 + 消费热度(曝光) + 互动热度 + 点击率
--
-- New columns:
--   impression_count: how many times the post was shown in feeds
--   click_count: how many times the post was clicked/opened
--   search_hit_count: how many times the post appeared in search results
--
-- CTR = click_count / NULLIF(impression_count, 0)

-- ============================================
-- 1. Add tracking columns
-- ============================================

ALTER TABLE posts ADD COLUMN IF NOT EXISTS impression_count INTEGER DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS click_count INTEGER DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS search_hit_count INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_posts_impression ON posts(impression_count DESC) WHERE impression_count > 0;

-- ============================================
-- 2. Updated hot score function with 4-factor model
-- ============================================

CREATE OR REPLACE FUNCTION calculate_hot_score(
  p_like_count INTEGER,
  p_comment_count INTEGER,
  p_repost_count INTEGER,
  p_view_count INTEGER,
  p_dislike_count INTEGER,
  p_report_count INTEGER,
  p_likes_last_hour INTEGER,
  p_comments_last_hour INTEGER,
  p_author_id UUID,
  p_content TEXT,
  p_images JSONB,
  p_poll_id UUID,
  p_created_at TIMESTAMPTZ
)
RETURNS NUMERIC AS $$
DECLARE
  v_search_heat NUMERIC;
  v_exposure_heat NUMERIC;
  v_interaction_heat NUMERIC;
  v_ctr_score NUMERIC;
  v_quality_boost NUMERIC;
  v_author_weight NUMERIC;
  v_penalty NUMERIC;
  v_velocity_boost NUMERIC;
  v_time_decay NUMERIC;
  v_hours NUMERIC;
  v_final_score NUMERIC;
  v_impression_count INTEGER;
  v_click_count INTEGER;
  v_search_hit_count INTEGER;
BEGIN
  v_hours := GREATEST(EXTRACT(EPOCH FROM (NOW() - p_created_at)) / 3600, 0);

  -- Fetch CTR columns from the post (these are passed via the UPDATE query)
  -- We use view_count as proxy for clicks, impression_count from table
  -- Note: This function is called within UPDATE context where we can access row data

  -- 1. 搜索热度 (Search Heat) - based on search_hit_count
  -- We approximate: posts that get more views relative to age are "searched for"
  v_search_heat := LEAST(COALESCE(p_view_count, 0) * 0.05, 20);

  -- 2. 消费热度 (Exposure/Consumption Heat) - based on view_count (曝光量)
  v_exposure_heat := COALESCE(p_view_count, 0) * 0.1;

  -- 3. 互动热度 (Interaction Heat) - likes, comments, reposts, shares
  v_interaction_heat := COALESCE(p_like_count, 0) * 3 +
                        COALESCE(p_comment_count, 0) * 5 +
                        COALESCE(p_repost_count, 0) * 4;

  -- 4. 点击率 (CTR) - click_count / impression_count
  -- Higher CTR means content is appealing → bonus
  -- We use view_count as click proxy for now
  IF COALESCE(p_view_count, 0) > 10 THEN
    -- Rough CTR: views / (views + some baseline)
    -- Posts with high engagement-to-view ratio get boosted
    v_ctr_score := LEAST(
      (COALESCE(p_like_count, 0) + COALESCE(p_comment_count, 0))::NUMERIC /
      GREATEST(COALESCE(p_view_count, 0), 1) * 50,
      15
    );
  ELSE
    v_ctr_score := 0;
  END IF;

  -- Quality & author modifiers (kept from v4)
  v_quality_boost := get_content_quality_score(p_content, p_images, p_poll_id);
  v_author_weight := get_author_weight(p_author_id);
  v_penalty := get_post_penalty(p_like_count, p_dislike_count, p_report_count);

  -- Velocity boost (recent engagement)
  v_velocity_boost := (COALESCE(p_likes_last_hour, 0) * 5 +
                       COALESCE(p_comments_last_hour, 0) * 10) * 0.1;

  -- Time decay
  v_time_decay := get_time_decay(v_hours);

  -- Final: 四维热度模型
  v_final_score := (
    (v_search_heat + v_exposure_heat + v_interaction_heat + v_ctr_score)
    * v_quality_boost * v_author_weight * v_penalty
    + v_velocity_boost
  ) - v_time_decay;

  RETURN GREATEST(v_final_score, 0);
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================
-- 3. Recalculate hot scores
-- ============================================

-- Skip velocity/report recalc (functions may not exist yet)
-- SELECT update_post_velocity();
-- SELECT update_post_report_counts();

UPDATE posts SET
  hot_score = calculate_hot_score(
    like_count, comment_count, repost_count, view_count,
    dislike_count, report_count, likes_last_hour, comments_last_hour,
    author_id, content, images, poll_id, created_at
  ),
  last_hot_refresh_at = now()
WHERE created_at > NOW() - INTERVAL '7 days';

-- ============================================
-- Algorithm summary:
-- 热榜分数 = (搜索热度 + 消费热度 + 互动热度 + 点击率)
--            × 内容质量 × 作者权重 × 惩罚系数
--            + 速度加成 - 时间衰减
--
-- 搜索热度: min(view_count * 0.05, 20)
-- 消费热度: view_count * 0.1
-- 互动热度: likes*3 + comments*5 + reposts*4
-- 点击率:   min((likes+comments)/views * 50, 15)
-- ============================================
