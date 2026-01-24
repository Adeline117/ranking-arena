-- Migration: Hot Score Improvements
-- Adds incremental refresh tracking and improved scoring formula

-- Track when each post was last refreshed
ALTER TABLE posts ADD COLUMN IF NOT EXISTS last_hot_refresh_at timestamptz;

-- Index for incremental refresh queries
CREATE INDEX IF NOT EXISTS idx_posts_hot_refresh
  ON posts(last_hot_refresh_at)
  WHERE created_at > now() - interval '7 days';

-- Improved hot score refresh function (incremental)
-- New formula: (likes*3 + comments*5 + reposts*2 + views*0.1) * quality_boost / power(hours+2, 1.5)
-- Quality boost: has_images=1.2, author_followers>100=1.1, has_poll=1.15
CREATE OR REPLACE FUNCTION refresh_hot_scores_incremental()
RETURNS INTEGER AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE posts SET
    hot_score = (
      (COALESCE(like_count, 0) * 3 +
       COALESCE(comment_count, 0) * 5 +
       COALESCE(repost_count, 0) * 2 +
       COALESCE(view_count, 0) * 0.1)
      * CASE WHEN images IS NOT NULL AND jsonb_array_length(images) > 0 THEN 1.2 ELSE 1.0 END
      * CASE WHEN poll_id IS NOT NULL THEN 1.15 ELSE 1.0 END
      / POWER(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 + 2, 1.5)
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
$$ LANGUAGE plpgsql;

-- Keep the original function as fallback (updates all recent posts)
CREATE OR REPLACE FUNCTION refresh_hot_scores()
RETURNS INTEGER AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE posts SET
    hot_score = (
      (COALESCE(like_count, 0) * 3 +
       COALESCE(comment_count, 0) * 5 +
       COALESCE(repost_count, 0) * 2 +
       COALESCE(view_count, 0) * 0.1)
      * CASE WHEN images IS NOT NULL AND jsonb_array_length(images) > 0 THEN 1.2 ELSE 1.0 END
      * CASE WHEN poll_id IS NOT NULL THEN 1.15 ELSE 1.0 END
      / POWER(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 + 2, 1.5)
    ),
    last_hot_refresh_at = now()
  WHERE created_at > NOW() - INTERVAL '7 days';

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql;
