-- ============================================
-- User Weight System Migration
-- Adds user weight scoring system based on multiple factors
-- ============================================

-- 1. Add weight column to user_profiles table
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS weight INTEGER DEFAULT 0;

-- 2. Add index for weight sorting
CREATE INDEX IF NOT EXISTS idx_user_profiles_weight ON user_profiles(weight DESC);

-- 3. Function to calculate user weight score
CREATE OR REPLACE FUNCTION calculate_user_weight(p_user_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_weight INTEGER DEFAULT 0;
  v_registration_score INTEGER DEFAULT 0;
  v_activity_score INTEGER DEFAULT 0;
  v_recent_activity_score INTEGER DEFAULT 0;
  v_membership_score INTEGER DEFAULT 0;
  v_profile_score INTEGER DEFAULT 0;
  
  v_created_at TIMESTAMP WITH TIME ZONE;
  v_days_since_registration INTEGER;
  v_post_count INTEGER;
  v_comment_count INTEGER;
  v_recent_activity_count INTEGER;
  v_subscription_tier TEXT;
  v_has_avatar BOOLEAN DEFAULT FALSE;
  v_has_bio BOOLEAN DEFAULT FALSE;
  v_has_handle BOOLEAN DEFAULT FALSE;
BEGIN
  -- Get user profile data
  SELECT 
    created_at, 
    subscription_tier, 
    (avatar_url IS NOT NULL AND avatar_url != '') as has_avatar,
    (bio IS NOT NULL AND bio != '') as has_bio,
    (handle IS NOT NULL AND handle != '') as has_handle
  INTO 
    v_created_at, 
    v_subscription_tier, 
    v_has_avatar, 
    v_has_bio, 
    v_has_handle
  FROM user_profiles 
  WHERE id = p_user_id;
  
  -- Return 0 if user not found
  IF v_created_at IS NULL THEN
    RETURN 0;
  END IF;
  
  -- 1. Registration Time Score (最高 20 分)
  -- 注册越早权重越高，假设项目启动是2024-01-01
  v_days_since_registration := EXTRACT(EPOCH FROM (v_created_at - '2024-01-01'::timestamp)) / 86400;
  IF v_days_since_registration <= 0 THEN
    -- 项目启动前或当天注册的用户得满分
    v_registration_score := 20;
  ELSIF v_days_since_registration <= 30 THEN
    -- 前30天注册，15-20分
    v_registration_score := 20 - (v_days_since_registration::FLOAT / 30 * 5)::INTEGER;
  ELSIF v_days_since_registration <= 90 THEN
    -- 前90天注册，10-15分
    v_registration_score := 15 - ((v_days_since_registration - 30)::FLOAT / 60 * 5)::INTEGER;
  ELSIF v_days_since_registration <= 180 THEN
    -- 前180天注册，5-10分
    v_registration_score := 10 - ((v_days_since_registration - 90)::FLOAT / 90 * 5)::INTEGER;
  ELSE
    -- 180天后注册，0-5分
    v_registration_score := GREATEST(0, 5 - ((v_days_since_registration - 180)::FLOAT / 180 * 5)::INTEGER);
  END IF;
  
  -- 2. Activity Score (总发帖数+评论数，最高 25 分)
  SELECT 
    COALESCE(COUNT(p.id), 0) as post_count
  INTO v_post_count
  FROM posts p 
  WHERE p.author_id = p_user_id;
  
  SELECT 
    COALESCE(COUNT(c.id), 0) as comment_count
  INTO v_comment_count
  FROM comments c 
  WHERE c.author_id = p_user_id;
  
  -- 总活跃度计算：帖子权重更高
  v_activity_score := LEAST(25, (v_post_count * 2 + v_comment_count) / 5);
  
  -- 3. Recent Activity Score (最近7天活跃，最高 15 分)
  SELECT 
    COALESCE(COUNT(*), 0)
  INTO v_recent_activity_count
  FROM (
    SELECT 1 FROM posts WHERE author_id = p_user_id AND created_at >= NOW() - INTERVAL '7 days'
    UNION ALL
    SELECT 1 FROM comments WHERE author_id = p_user_id AND created_at >= NOW() - INTERVAL '7 days'
  ) recent;
  
  IF v_recent_activity_count > 0 THEN
    v_recent_activity_score := LEAST(15, v_recent_activity_count * 3);
  END IF;
  
  -- 4. Membership Score (Pro 会员，最高 25 分)
  IF v_subscription_tier = 'pro' THEN
    v_membership_score := 25;
  END IF;
  
  -- 5. Profile Completeness Score (最高 15 分)
  IF v_has_handle THEN
    v_profile_score := v_profile_score + 5;
  END IF;
  IF v_has_avatar THEN
    v_profile_score := v_profile_score + 5;
  END IF;
  IF v_has_bio THEN
    v_profile_score := v_profile_score + 5;
  END IF;
  
  -- 计算总权重
  v_weight := v_registration_score + v_activity_score + v_recent_activity_score + v_membership_score + v_profile_score;
  
  -- 确保权重在 0-100 范围内
  v_weight := GREATEST(0, LEAST(100, v_weight));
  
  -- 更新用户权重
  UPDATE user_profiles SET weight = v_weight WHERE id = p_user_id;
  
  RETURN v_weight;
END;
$$ LANGUAGE plpgsql;

-- 4. Function to recalculate all user weights
CREATE OR REPLACE FUNCTION recalculate_all_user_weights()
RETURNS TABLE(user_id UUID, old_weight INTEGER, new_weight INTEGER) AS $$
DECLARE
  r RECORD;
  v_old_weight INTEGER;
  v_new_weight INTEGER;
BEGIN
  FOR r IN SELECT id, weight FROM user_profiles LOOP
    v_old_weight := r.weight;
    v_new_weight := calculate_user_weight(r.id);
    
    RETURN QUERY SELECT r.id, v_old_weight, v_new_weight;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- 5. Trigger to auto-update weight on profile changes
CREATE OR REPLACE FUNCTION trigger_update_user_weight()
RETURNS TRIGGER AS $$
BEGIN
  -- Update weight when relevant fields change
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.avatar_url IS DISTINCT FROM NEW.avatar_url) OR
       (OLD.bio IS DISTINCT FROM NEW.bio) OR
       (OLD.handle IS DISTINCT FROM NEW.handle) OR
       (OLD.subscription_tier IS DISTINCT FROM NEW.subscription_tier) THEN
      NEW.weight := calculate_user_weight(NEW.id);
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.weight := calculate_user_weight(NEW.id);
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger
DROP TRIGGER IF EXISTS trigger_auto_update_user_weight ON user_profiles;
CREATE TRIGGER trigger_auto_update_user_weight
  BEFORE INSERT OR UPDATE ON user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION trigger_update_user_weight();

-- 6. Trigger to update weight when user posts/comments
CREATE OR REPLACE FUNCTION trigger_update_weight_on_activity()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_TABLE_NAME = 'posts' THEN
    IF TG_OP = 'INSERT' THEN
      PERFORM calculate_user_weight(NEW.author_id);
    ELSIF TG_OP = 'DELETE' THEN
      PERFORM calculate_user_weight(OLD.author_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'comments' THEN
    IF TG_OP = 'INSERT' THEN
      PERFORM calculate_user_weight(NEW.author_id);
    ELSIF TG_OP = 'DELETE' THEN
      PERFORM calculate_user_weight(OLD.author_id);
    END IF;
  END IF;
  
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Create triggers for posts and comments
DROP TRIGGER IF EXISTS trigger_posts_update_weight ON posts;
CREATE TRIGGER trigger_posts_update_weight
  AFTER INSERT OR DELETE ON posts
  FOR EACH ROW
  EXECUTE FUNCTION trigger_update_weight_on_activity();

DROP TRIGGER IF EXISTS trigger_comments_update_weight ON comments;
CREATE TRIGGER trigger_comments_update_weight
  AFTER INSERT OR DELETE ON comments
  FOR EACH ROW
  EXECUTE FUNCTION trigger_update_weight_on_activity();

-- 7. Initial weight calculation for existing users
-- This will be done via the API to avoid migration timeout
-- SELECT recalculate_all_user_weights();

-- 8. Weight-enhanced search function
CREATE OR REPLACE FUNCTION search_posts_with_weight(
  search_query TEXT,
  result_limit INTEGER DEFAULT 20,
  result_offset INTEGER DEFAULT 0,
  weight_factor DECIMAL DEFAULT 0.4
)
RETURNS TABLE(
  id UUID,
  title TEXT,
  content TEXT,
  author_id UUID,
  author_handle TEXT,
  group_id UUID,
  poll_enabled BOOLEAN,
  poll_id UUID,
  poll_bull INTEGER,
  poll_bear INTEGER,
  poll_wait INTEGER,
  like_count INTEGER,
  dislike_count INTEGER,
  comment_count INTEGER,
  bookmark_count INTEGER,
  repost_count INTEGER,
  view_count INTEGER,
  hot_score DECIMAL,
  is_pinned BOOLEAN,
  images TEXT[],
  created_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE,
  original_post_id UUID,
  group_name TEXT,
  group_name_en TEXT,
  author_weight INTEGER,
  weighted_score DECIMAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    p.id,
    p.title,
    p.content,
    p.author_id,
    p.author_handle,
    p.group_id,
    p.poll_enabled,
    p.poll_id,
    p.poll_bull,
    p.poll_bear,
    p.poll_wait,
    p.like_count,
    p.dislike_count,
    p.comment_count,
    p.bookmark_count,
    p.repost_count,
    p.view_count,
    p.hot_score,
    p.is_pinned,
    p.images,
    p.created_at,
    p.updated_at,
    p.original_post_id,
    g.name as group_name,
    g.name_en as group_name_en,
    COALESCE(up.weight, 0) as author_weight,
    (COALESCE(p.hot_score, 0) * (1 + weight_factor * COALESCE(up.weight, 0) / 100.0)) as weighted_score
  FROM posts p
  LEFT JOIN user_profiles up ON p.author_id = up.id
  LEFT JOIN groups g ON p.group_id = g.id
  WHERE (p.title ILIKE '%' || search_query || '%' OR p.content ILIKE '%' || search_query || '%')
  ORDER BY (COALESCE(p.hot_score, 0) * (1 + weight_factor * COALESCE(up.weight, 0) / 100.0)) DESC
  LIMIT result_limit OFFSET result_offset;
END;
$$ LANGUAGE plpgsql;

-- Add comment
COMMENT ON COLUMN user_profiles.weight IS 'User weight score (0-100) based on registration time, activity, membership, and profile completeness';
COMMENT ON FUNCTION calculate_user_weight(UUID) IS 'Calculates user weight score based on multiple factors: registration(20) + activity(25) + recent activity(15) + membership(25) + profile(15)';
COMMENT ON FUNCTION search_posts_with_weight(TEXT, INTEGER, INTEGER, DECIMAL) IS 'Weight-enhanced search function that prioritizes content from high-weight users';