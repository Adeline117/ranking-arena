-- Arena Recommendation Functions
-- Run via Supabase SQL Editor or psql

-- 方案A: 协同过滤
CREATE OR REPLACE FUNCTION recommend_by_collaborative_filtering(
  p_user_id uuid,
  p_target_type text DEFAULT 'post',
  p_limit int DEFAULT 20
)
RETURNS TABLE(target_id text, score float) AS $$
BEGIN
  RETURN QUERY
  WITH my_targets AS (
    SELECT DISTINCT ui.target_id
    FROM user_interactions ui
    WHERE ui.user_id = p_user_id
      AND ui.target_type = p_target_type
      AND ui.action IN ('like', 'comment', 'share', 'view')
  ),
  similar_users AS (
    SELECT ui.user_id, COUNT(DISTINCT ui.target_id) as overlap
    FROM user_interactions ui
    JOIN my_targets mt ON ui.target_id = mt.target_id
    WHERE ui.user_id != p_user_id
      AND ui.target_type = p_target_type
      AND ui.action IN ('like', 'comment', 'share')
    GROUP BY ui.user_id
    ORDER BY overlap DESC
    LIMIT 100
  ),
  recommendations AS (
    SELECT ui.target_id, 
           SUM(su.overlap) as score
    FROM user_interactions ui
    JOIN similar_users su ON ui.user_id = su.user_id
    WHERE ui.target_type = p_target_type
      AND ui.action IN ('like', 'comment', 'share')
      AND ui.target_id NOT IN (SELECT target_id FROM my_targets)
    GROUP BY ui.target_id
    ORDER BY score DESC
    LIMIT p_limit
  )
  SELECT r.target_id, r.score FROM recommendations r;
END;
$$ LANGUAGE plpgsql STABLE;

-- 方案B: 个性化Feed (70%热度 + 30%个性化)
CREATE OR REPLACE FUNCTION get_personalized_feed(
  p_user_id uuid,
  p_limit int DEFAULT 20,
  p_offset int DEFAULT 0
)
RETURNS TABLE(
  post_id uuid,
  final_score float
) AS $$
BEGIN
  RETURN QUERY
  WITH user_group_ids AS (
    SELECT group_id FROM group_members WHERE user_id = p_user_id
  ),
  user_followed_ids AS (
    SELECT following_id FROM user_follows WHERE follower_id = p_user_id
  ),
  scored_posts AS (
    SELECT 
      p.id,
      COALESCE(p.hot_score, 0) * 0.7 as hot_component,
      CASE WHEN p.group_id IN (SELECT group_id FROM user_group_ids) THEN 20 ELSE 0 END +
      CASE WHEN p.author_id IN (SELECT following_id FROM user_followed_ids) THEN 30 ELSE 0 END +
      COALESCE((
        SELECT COUNT(*) * 5
        FROM user_interactions ui
        WHERE ui.user_id = p_user_id
          AND ui.target_type = 'post'
          AND ui.action IN ('like', 'comment')
          AND ui.target_id IN (
            SELECT id::text FROM posts WHERE group_id = p.group_id
          )
        LIMIT 10
      ), 0) as personalization_component
    FROM posts p
    WHERE p.created_at > NOW() - INTERVAL '7 days'
  )
  SELECT 
    sp.id,
    sp.hot_component + sp.personalization_component * 0.3 as final_score
  FROM scored_posts sp
  ORDER BY final_score DESC
  LIMIT p_limit OFFSET p_offset;
END;
$$ LANGUAGE plpgsql STABLE;

-- 方案C: 小组推荐
CREATE OR REPLACE FUNCTION recommend_groups_for_user(
  p_user_id uuid,
  p_limit int DEFAULT 10
)
RETURNS TABLE(
  group_id uuid,
  group_name text,
  score float,
  reason text
) AS $$
BEGIN
  RETURN QUERY
  WITH my_groups AS (
    SELECT gm.group_id FROM group_members gm WHERE gm.user_id = p_user_id
  ),
  follow_based AS (
    SELECT gm.group_id, COUNT(*) * 10 as score, 'followed_users_joined' as reason
    FROM group_members gm
    JOIN user_follows uf ON gm.user_id = uf.following_id
    WHERE uf.follower_id = p_user_id
      AND gm.group_id NOT IN (SELECT group_id FROM my_groups)
    GROUP BY gm.group_id
  ),
  overlap_based AS (
    SELECT gm2.group_id, COUNT(DISTINCT gm2.user_id) * 5 as score, 'members_overlap' as reason
    FROM group_members gm1
    JOIN group_members gm2 ON gm1.user_id = gm2.user_id
    WHERE gm1.group_id IN (SELECT group_id FROM my_groups)
      AND gm2.group_id NOT IN (SELECT group_id FROM my_groups)
      AND gm1.user_id != p_user_id
    GROUP BY gm2.group_id
  ),
  combined AS (
    SELECT COALESCE(f.group_id, o.group_id) as gid,
           COALESCE(f.score, 0) + COALESCE(o.score, 0) as total_score,
           COALESCE(f.reason, o.reason) as top_reason
    FROM follow_based f
    FULL OUTER JOIN overlap_based o ON f.group_id = o.group_id
  )
  SELECT c.gid, g.name, c.total_score, c.top_reason
  FROM combined c
  JOIN groups g ON g.id = c.gid
  ORDER BY c.total_score DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE;
