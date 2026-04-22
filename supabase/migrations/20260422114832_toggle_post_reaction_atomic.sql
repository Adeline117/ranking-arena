-- Migration: 20260422114832_toggle_post_reaction_atomic.sql
-- Created: 2026-04-22T18:48:32Z
-- Description: Atomic toggle_post_reaction RPC to eliminate TOCTOU race condition
--   Previously the app did SELECT→DELETE/UPDATE/INSERT as separate queries,
--   allowing concurrent requests to corrupt like_count/dislike_count.
--   This RPC uses SELECT FOR UPDATE to serialize per-(post_id, user_id).

CREATE OR REPLACE FUNCTION toggle_post_reaction(
  p_post_id UUID,
  p_user_id UUID,
  p_reaction_type TEXT DEFAULT 'up'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing RECORD;
  v_action TEXT;
  v_reaction TEXT;
BEGIN
  -- Lock the specific reaction row to prevent TOCTOU race
  SELECT id, reaction_type INTO v_existing
  FROM post_likes
  WHERE post_id = p_post_id AND user_id = p_user_id
  FOR UPDATE;

  IF v_existing IS NULL THEN
    -- No existing reaction: insert
    INSERT INTO post_likes (post_id, user_id, reaction_type)
    VALUES (p_post_id, p_user_id, p_reaction_type);
    v_action := 'added';
    v_reaction := p_reaction_type;

    -- Increment the appropriate counter
    IF p_reaction_type = 'up' THEN
      UPDATE posts SET like_count = COALESCE(like_count, 0) + 1 WHERE id = p_post_id;
    ELSE
      UPDATE posts SET dislike_count = COALESCE(dislike_count, 0) + 1 WHERE id = p_post_id;
    END IF;

  ELSIF v_existing.reaction_type = p_reaction_type THEN
    -- Same reaction type: remove (toggle off)
    DELETE FROM post_likes WHERE id = v_existing.id;
    v_action := 'removed';
    v_reaction := NULL;

    -- Decrement the appropriate counter
    IF p_reaction_type = 'up' THEN
      UPDATE posts SET like_count = GREATEST(COALESCE(like_count, 0) - 1, 0) WHERE id = p_post_id;
    ELSE
      UPDATE posts SET dislike_count = GREATEST(COALESCE(dislike_count, 0) - 1, 0) WHERE id = p_post_id;
    END IF;

  ELSE
    -- Different reaction type: update (e.g. up→down or down→up)
    UPDATE post_likes SET reaction_type = p_reaction_type WHERE id = v_existing.id;
    v_action := 'changed';
    v_reaction := p_reaction_type;

    -- Swap counters: decrement old, increment new
    IF p_reaction_type = 'up' THEN
      -- Was down, now up
      UPDATE posts SET
        like_count = COALESCE(like_count, 0) + 1,
        dislike_count = GREATEST(COALESCE(dislike_count, 0) - 1, 0)
      WHERE id = p_post_id;
    ELSE
      -- Was up, now down
      UPDATE posts SET
        like_count = GREATEST(COALESCE(like_count, 0) - 1, 0),
        dislike_count = COALESCE(dislike_count, 0) + 1
      WHERE id = p_post_id;
    END IF;
  END IF;

  RETURN jsonb_build_object('action', v_action, 'reaction', v_reaction);
END;
$$;
