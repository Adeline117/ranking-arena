-- Migration: Add hot_score column and refresh function
-- This supports the /api/cron/refresh-hot-scores endpoint

-- 1. Add hot_score column to posts if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'posts' AND column_name = 'hot_score'
  ) THEN
    ALTER TABLE posts ADD COLUMN hot_score DOUBLE PRECISION DEFAULT 0;
  END IF;
END $$;

-- 2. Create index for hot_score sorting
CREATE INDEX IF NOT EXISTS idx_posts_hot_score
  ON posts(hot_score DESC NULLS LAST, created_at DESC);

-- 3. Create the refresh_hot_scores RPC function
CREATE OR REPLACE FUNCTION refresh_hot_scores()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE posts
  SET hot_score = (
    COALESCE(like_count, 0) * 3 +
    COALESCE(comment_count, 0) * 5 +
    COALESCE(repost_count, 0) * 2 +
    COALESCE(view_count, 0) * 0.1 -
    LN(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 + 2) * 2
  )
  WHERE created_at > NOW() - INTERVAL '7 days';

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

-- 4. Initialize hot_score for existing posts (idempotent)
DO $$
BEGIN
  -- Only run if there are posts with uninitialized hot_score
  IF EXISTS (
    SELECT 1 FROM posts
    WHERE created_at > NOW() - INTERVAL '7 days'
      AND (hot_score IS NULL OR hot_score = 0)
    LIMIT 1
  ) THEN
    UPDATE posts
    SET hot_score = (
      COALESCE(like_count, 0) * 3 +
      COALESCE(comment_count, 0) * 5 +
      COALESCE(repost_count, 0) * 2 +
      COALESCE(view_count, 0) * 0.1 -
      LN(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 + 2) * 2
    )
    WHERE created_at > NOW() - INTERVAL '7 days'
      AND (hot_score IS NULL OR hot_score = 0);
  END IF;
END $$;
