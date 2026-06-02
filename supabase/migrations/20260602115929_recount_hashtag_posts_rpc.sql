-- Migration: 20260602115929_recount_hashtag_posts_rpc.sql
-- Created: 2026-06-02T18:59:29Z
-- Description: Batch recount hashtag post_count in a single UPDATE (replaces N+1 per-tag updates)

-- Up
CREATE OR REPLACE FUNCTION recount_hashtag_posts(hashtag_ids uuid[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE hashtags h
  SET post_count = COALESCE(sub.cnt, 0)
  FROM (
    SELECT hashtag_id, count(*)::int AS cnt
    FROM post_hashtags
    WHERE hashtag_id = ANY(hashtag_ids)
    GROUP BY hashtag_id
  ) sub
  WHERE h.id = sub.hashtag_id;
$$;
