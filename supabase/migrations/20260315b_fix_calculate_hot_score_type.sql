-- Fix: calculate_hot_score type mismatch for images parameter
-- The posts.images column is text[] but calculate_hot_score expected JSONB.
-- This creates a text[] overload that casts to JSONB internally.

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
  p_images TEXT[],
  p_poll_id UUID,
  p_created_at TIMESTAMPTZ
)
RETURNS NUMERIC AS $$
BEGIN
  -- Delegate to the JSONB version with a cast
  RETURN calculate_hot_score(
    p_like_count,
    p_comment_count,
    p_repost_count,
    p_view_count,
    p_dislike_count,
    p_report_count,
    p_likes_last_hour,
    p_comments_last_hour,
    p_author_id,
    p_content,
    CASE WHEN p_images IS NOT NULL THEN to_jsonb(p_images) ELSE NULL END,
    p_poll_id,
    p_created_at
  );
END;
$$ LANGUAGE plpgsql STABLE;
