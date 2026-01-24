-- Migration: Hot Score Power Decay
-- Changes time decay from logarithmic/power-division to power-subtraction formula.
-- New formula is gentle in first 24h, then accelerates decay for older posts.
--
-- Decay comparison:
--   1h:  old=2.2  new=0.1   (new posts stay visible longer)
--   24h: old=6.5  new=5.0   (roughly equivalent)
--   48h: old=7.8  new=12.3  (2-day posts decay faster)
--   72h: old=8.6  new=20.5  (3-day posts decay significantly)
--   7d:  old=10.3 new=55.8  (week-old posts are effectively cleared)

-- Update the main refresh_hot_scores function with power decay subtraction
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
      - POWER(GREATEST(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600, 0) / 24.0, 1.3) * 5
    ),
    last_hot_refresh_at = now()
  WHERE created_at > NOW() - INTERVAL '7 days';

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update the incremental refresh function with the same formula
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
      - POWER(GREATEST(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600, 0) / 24.0, 1.3) * 5
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

-- Re-initialize hot_score for all recent posts with the new formula
UPDATE posts SET
  hot_score = (
    (COALESCE(like_count, 0) * 3 +
     COALESCE(comment_count, 0) * 5 +
     COALESCE(repost_count, 0) * 2 +
     COALESCE(view_count, 0) * 0.1)
    * CASE WHEN images IS NOT NULL AND jsonb_array_length(images) > 0 THEN 1.2 ELSE 1.0 END
    * CASE WHEN poll_id IS NOT NULL THEN 1.15 ELSE 1.0 END
    - POWER(GREATEST(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600, 0) / 24.0, 1.3) * 5
  ),
  last_hot_refresh_at = now()
WHERE created_at > NOW() - INTERVAL '7 days';
