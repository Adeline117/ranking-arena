-- Migration: Hot Score Algorithm V4 - Comprehensive Optimization
--
-- This migration implements a multi-factor hot score algorithm:
-- 1. Author Quality Weight (Pro users, popular authors)
-- 2. Content Quality Signals (length, links, mentions)
-- 3. Negative Signal Penalties (dislikes, reports)
-- 4. Segmented Time Decay (gentle start, accelerating decay)
-- 5. Interaction Velocity Boost (recent engagement matters more)
--
-- Formula:
-- hot_score = (base_score * quality_boost * author_weight * penalty + velocity_boost) - time_decay

-- ============================================
-- 1. Add columns for tracking recent interactions
-- ============================================

-- Add columns to posts table for velocity tracking
ALTER TABLE posts ADD COLUMN IF NOT EXISTS likes_last_hour INTEGER DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS comments_last_hour INTEGER DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS velocity_updated_at TIMESTAMPTZ;

-- Add report_count to posts for penalty calculation
ALTER TABLE posts ADD COLUMN IF NOT EXISTS report_count INTEGER DEFAULT 0;

-- Create index for efficient velocity updates
CREATE INDEX IF NOT EXISTS idx_posts_velocity_updated ON posts(velocity_updated_at)
  WHERE velocity_updated_at IS NOT NULL;

-- ============================================
-- 2. Helper function: Calculate author weight
-- ============================================

CREATE OR REPLACE FUNCTION get_author_weight(p_author_id UUID)
RETURNS NUMERIC AS $$
DECLARE
  v_tier TEXT;
  v_followers INTEGER;
  v_weight NUMERIC := 1.0;
  v_has_tier_col BOOLEAN;
  v_has_follower_col BOOLEAN;
BEGIN
  -- Check if subscription_tier column exists
  SELECT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_schema = 'public'
    AND table_name = 'user_profiles'
    AND column_name = 'subscription_tier'
  ) INTO v_has_tier_col;

  -- Check if follower_count column exists
  SELECT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_schema = 'public'
    AND table_name = 'user_profiles'
    AND column_name = 'follower_count'
  ) INTO v_has_follower_col;

  -- Get tier if column exists
  IF v_has_tier_col THEN
    EXECUTE 'SELECT subscription_tier FROM user_profiles WHERE id = $1'
    INTO v_tier
    USING p_author_id;

    -- Pro user boost
    IF v_tier = 'pro' THEN
      v_weight := v_weight * 1.3;
    END IF;
  END IF;

  -- Get followers if column exists
  IF v_has_follower_col THEN
    EXECUTE 'SELECT follower_count FROM user_profiles WHERE id = $1'
    INTO v_followers
    USING p_author_id;

    -- Follower-based boost
    IF COALESCE(v_followers, 0) >= 1000 THEN
      v_weight := v_weight * 1.2;
    ELSIF COALESCE(v_followers, 0) >= 100 THEN
      v_weight := v_weight * 1.1;
    ELSIF COALESCE(v_followers, 0) >= 10 THEN
      v_weight := v_weight * 1.05;
    END IF;
  END IF;

  RETURN v_weight;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================
-- 3. Helper function: Calculate content quality score
-- ============================================

CREATE OR REPLACE FUNCTION get_content_quality_score(
  p_content TEXT,
  p_images JSONB,
  p_poll_id UUID
)
RETURNS NUMERIC AS $$
DECLARE
  v_score NUMERIC := 1.0;
  v_content_length INTEGER;
  v_has_links BOOLEAN;
  v_has_mentions BOOLEAN;
BEGIN
  v_content_length := COALESCE(char_length(p_content), 0);
  v_has_links := p_content ~* 'https?://';
  v_has_mentions := p_content ~ '@[a-zA-Z0-9_]+';

  -- Long content boost (>200 chars)
  IF v_content_length > 500 THEN
    v_score := v_score * 1.15;
  ELSIF v_content_length > 200 THEN
    v_score := v_score * 1.1;
  END IF;

  -- Has links (external references)
  IF v_has_links THEN
    v_score := v_score * 1.1;
  END IF;

  -- Has mentions (engaging with community)
  IF v_has_mentions THEN
    v_score := v_score * 1.1;
  END IF;

  -- Has images
  IF p_images IS NOT NULL AND jsonb_array_length(p_images) > 0 THEN
    v_score := v_score * 1.2;
  END IF;

  -- Has poll
  IF p_poll_id IS NOT NULL THEN
    v_score := v_score * 1.15;
  END IF;

  RETURN v_score;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================
-- 4. Helper function: Calculate penalty
-- ============================================

CREATE OR REPLACE FUNCTION get_post_penalty(
  p_like_count INTEGER,
  p_dislike_count INTEGER,
  p_report_count INTEGER
)
RETURNS NUMERIC AS $$
DECLARE
  v_penalty NUMERIC := 1.0;
  v_dislike_ratio NUMERIC;
BEGIN
  -- Calculate dislike ratio
  IF COALESCE(p_like_count, 0) > 0 THEN
    v_dislike_ratio := COALESCE(p_dislike_count, 0)::NUMERIC / p_like_count;
  ELSE
    v_dislike_ratio := CASE WHEN COALESCE(p_dislike_count, 0) > 0 THEN 1.0 ELSE 0 END;
  END IF;

  -- High dislike ratio penalty
  IF v_dislike_ratio > 0.5 THEN
    v_penalty := v_penalty * 0.5;
  ELSIF v_dislike_ratio > 0.3 THEN
    v_penalty := v_penalty * 0.7;
  ELSIF v_dislike_ratio > 0.2 THEN
    v_penalty := v_penalty * 0.85;
  END IF;

  -- Report penalty (only if report_count is provided)
  IF COALESCE(p_report_count, 0) >= 3 THEN
    v_penalty := v_penalty * 0.3;
  ELSIF COALESCE(p_report_count, 0) >= 2 THEN
    v_penalty := v_penalty * 0.5;
  ELSIF COALESCE(p_report_count, 0) >= 1 THEN
    v_penalty := v_penalty * 0.7;
  END IF;

  RETURN v_penalty;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================
-- 5. Helper function: Calculate time decay (segmented)
-- ============================================

CREATE OR REPLACE FUNCTION get_time_decay(p_hours NUMERIC)
RETURNS NUMERIC AS $$
BEGIN
  -- Segmented decay: gentle start, accelerating over time
  IF p_hours < 1 THEN
    RETURN 0;                                    -- New posts: no decay
  ELSIF p_hours < 6 THEN
    RETURN p_hours * 0.5;                        -- 1-6h: gentle (max 3)
  ELSIF p_hours < 24 THEN
    RETURN 3 + (p_hours - 6) * 1;                -- 6-24h: medium (3-21)
  ELSIF p_hours < 72 THEN
    RETURN 21 + (p_hours - 24) * 2;              -- 1-3 days: faster (21-117)
  ELSE
    RETURN 117 + (p_hours - 72) * 3;             -- 3+ days: aggressive
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================
-- 6. Main hot score calculation function
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
  v_base_score NUMERIC;
  v_quality_boost NUMERIC;
  v_author_weight NUMERIC;
  v_penalty NUMERIC;
  v_velocity_boost NUMERIC;
  v_time_decay NUMERIC;
  v_hours NUMERIC;
  v_final_score NUMERIC;
BEGIN
  -- Calculate hours since creation
  v_hours := GREATEST(EXTRACT(EPOCH FROM (NOW() - p_created_at)) / 3600, 0);

  -- 1. Base engagement score
  v_base_score := COALESCE(p_like_count, 0) * 3 +
                  COALESCE(p_comment_count, 0) * 5 +
                  COALESCE(p_repost_count, 0) * 2 +
                  COALESCE(p_view_count, 0) * 0.1;

  -- 2. Content quality boost
  v_quality_boost := get_content_quality_score(p_content, p_images, p_poll_id);

  -- 3. Author weight
  v_author_weight := get_author_weight(p_author_id);

  -- 4. Penalty for negative signals
  v_penalty := get_post_penalty(p_like_count, p_dislike_count, p_report_count);

  -- 5. Velocity boost (recent engagement)
  v_velocity_boost := (COALESCE(p_likes_last_hour, 0) * 5 +
                       COALESCE(p_comments_last_hour, 0) * 10) * 0.1;

  -- 6. Time decay
  v_time_decay := get_time_decay(v_hours);

  -- Final calculation
  v_final_score := (v_base_score * v_quality_boost * v_author_weight * v_penalty + v_velocity_boost) - v_time_decay;

  RETURN GREATEST(v_final_score, 0);
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================
-- 7. Update refresh_hot_scores function
-- ============================================

CREATE OR REPLACE FUNCTION refresh_hot_scores()
RETURNS INTEGER AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE posts SET
    hot_score = calculate_hot_score(
      like_count,
      comment_count,
      repost_count,
      view_count,
      dislike_count,
      report_count,
      likes_last_hour,
      comments_last_hour,
      author_id,
      content,
      images,
      poll_id,
      created_at
    ),
    last_hot_refresh_at = now()
  WHERE created_at > NOW() - INTERVAL '7 days';

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 8. Update incremental refresh function
-- ============================================

CREATE OR REPLACE FUNCTION refresh_hot_scores_incremental()
RETURNS INTEGER AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE posts SET
    hot_score = calculate_hot_score(
      like_count,
      comment_count,
      repost_count,
      view_count,
      dislike_count,
      report_count,
      likes_last_hour,
      comments_last_hour,
      author_id,
      content,
      images,
      poll_id,
      created_at
    ),
    last_hot_refresh_at = now()
  WHERE created_at > NOW() - INTERVAL '7 days'
    AND (
      last_hot_refresh_at IS NULL
      OR updated_at > last_hot_refresh_at
      OR created_at > NOW() - INTERVAL '1 hour'
    );

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 9. Function to update velocity metrics
-- ============================================

CREATE OR REPLACE FUNCTION update_post_velocity()
RETURNS INTEGER AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  -- Update likes in last hour
  UPDATE posts p SET
    likes_last_hour = (
      SELECT COUNT(*)
      FROM post_reactions pr
      WHERE pr.post_id = p.id
        AND pr.reaction_type = 'up'
        AND pr.created_at > NOW() - INTERVAL '1 hour'
    ),
    comments_last_hour = (
      SELECT COUNT(*)
      FROM comments c
      WHERE c.post_id = p.id
        AND c.created_at > NOW() - INTERVAL '1 hour'
    ),
    velocity_updated_at = NOW()
  WHERE created_at > NOW() - INTERVAL '7 days';

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 10. Function to update report count on posts
-- ============================================

CREATE OR REPLACE FUNCTION update_post_report_counts()
RETURNS INTEGER AS $$
DECLARE
  updated_count INTEGER := 0;
  table_exists BOOLEAN;
BEGIN
  -- Check if content_reports table exists
  SELECT EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public'
    AND table_name = 'content_reports'
  ) INTO table_exists;

  IF NOT table_exists THEN
    -- Table doesn't exist, just return 0
    RETURN 0;
  END IF;

  UPDATE posts p SET
    report_count = (
      SELECT COUNT(*)
      FROM content_reports cr
      WHERE cr.content_type = 'post'
        AND cr.content_id = p.id::text
        AND cr.status = 'pending'
    )
  WHERE created_at > NOW() - INTERVAL '30 days';

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 11. Trigger to update report_count on new reports
-- (Only created if content_reports table exists)
-- ============================================

CREATE OR REPLACE FUNCTION trigger_update_post_report_count()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.content_type = 'post' THEN
    UPDATE posts SET
      report_count = (
        SELECT COUNT(*)
        FROM content_reports
        WHERE content_type = 'post'
          AND content_id = NEW.content_id
          AND status = 'pending'
      )
    WHERE id::text = NEW.content_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Only create trigger if content_reports table exists
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public'
    AND table_name = 'content_reports'
  ) THEN
    DROP TRIGGER IF EXISTS trigger_content_report_update_post ON content_reports;
    CREATE TRIGGER trigger_content_report_update_post
      AFTER INSERT OR UPDATE ON content_reports
      FOR EACH ROW
      EXECUTE FUNCTION trigger_update_post_report_count();
  END IF;
END $$;

-- ============================================
-- 12. Initialize hot scores with new algorithm
-- ============================================

-- First, update velocity metrics
SELECT update_post_velocity();

-- Then, update report counts
SELECT update_post_report_counts();

-- Finally, recalculate all hot scores
UPDATE posts SET
  hot_score = calculate_hot_score(
    like_count,
    comment_count,
    repost_count,
    view_count,
    dislike_count,
    report_count,
    likes_last_hour,
    comments_last_hour,
    author_id,
    content,
    images,
    poll_id,
    created_at
  ),
  last_hot_refresh_at = now()
WHERE created_at > NOW() - INTERVAL '7 days';

-- ============================================
-- Comments
-- ============================================
--
-- Algorithm weights summary:
--
-- BASE SCORE:
--   likes * 3 + comments * 5 + reposts * 2 + views * 0.1
--
-- QUALITY BOOST (multiplicative):
--   +10-15% for long content (200-500+ chars)
--   +10% for links
--   +10% for mentions
--   +20% for images
--   +15% for polls
--
-- AUTHOR WEIGHT (multiplicative):
--   +30% for Pro users
--   +5-20% based on follower count (10/100/1000+)
--
-- PENALTY (multiplicative):
--   15-50% reduction for high dislike ratio (>0.2-0.5)
--   30-70% reduction for reports (1-3+)
--
-- VELOCITY BOOST (additive):
--   likes_last_hour * 5 * 0.1 + comments_last_hour * 10 * 0.1
--
-- TIME DECAY (subtractive):
--   0-1h:   0
--   1-6h:   0.5 per hour (max 3)
--   6-24h:  1 per hour (3-21)
--   1-3d:   2 per hour (21-117)
--   3d+:    3 per hour (117+)
