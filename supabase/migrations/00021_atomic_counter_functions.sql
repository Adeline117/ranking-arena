-- Migration: Atomic Counter Functions
-- Adds RPC functions for atomic increment/decrement operations to prevent race conditions

-- Atomic decrement bookmark count
CREATE OR REPLACE FUNCTION decrement_bookmark_count(post_id uuid)
RETURNS TABLE(bookmark_count integer) AS $$
BEGIN
  RETURN QUERY
  UPDATE posts
  SET bookmark_count = GREATEST(0, COALESCE(posts.bookmark_count, 0) - 1)
  WHERE id = post_id
  RETURNING posts.bookmark_count;
END;
$$ LANGUAGE plpgsql;

-- Atomic increment bookmark count
CREATE OR REPLACE FUNCTION increment_bookmark_count(post_id uuid)
RETURNS TABLE(bookmark_count integer) AS $$
BEGIN
  RETURN QUERY
  UPDATE posts
  SET bookmark_count = COALESCE(posts.bookmark_count, 0) + 1
  WHERE id = post_id
  RETURNING posts.bookmark_count;
END;
$$ LANGUAGE plpgsql;

-- Atomic decrement like count
CREATE OR REPLACE FUNCTION decrement_like_count(post_id uuid)
RETURNS TABLE(like_count integer) AS $$
BEGIN
  RETURN QUERY
  UPDATE posts
  SET like_count = GREATEST(0, COALESCE(posts.like_count, 0) - 1)
  WHERE id = post_id
  RETURNING posts.like_count;
END;
$$ LANGUAGE plpgsql;

-- Atomic increment like count
CREATE OR REPLACE FUNCTION increment_like_count(post_id uuid)
RETURNS TABLE(like_count integer) AS $$
BEGIN
  RETURN QUERY
  UPDATE posts
  SET like_count = COALESCE(posts.like_count, 0) + 1
  WHERE id = post_id
  RETURNING posts.like_count;
END;
$$ LANGUAGE plpgsql;

-- Atomic decrement comment count
CREATE OR REPLACE FUNCTION decrement_comment_count(post_id uuid)
RETURNS TABLE(comment_count integer) AS $$
BEGIN
  RETURN QUERY
  UPDATE posts
  SET comment_count = GREATEST(0, COALESCE(posts.comment_count, 0) - 1)
  WHERE id = post_id
  RETURNING posts.comment_count;
END;
$$ LANGUAGE plpgsql;

-- Atomic increment comment count
CREATE OR REPLACE FUNCTION increment_comment_count(post_id uuid)
RETURNS TABLE(comment_count integer) AS $$
BEGIN
  RETURN QUERY
  UPDATE posts
  SET comment_count = COALESCE(posts.comment_count, 0) + 1
  WHERE id = post_id
  RETURNING posts.comment_count;
END;
$$ LANGUAGE plpgsql;

-- Atomic decrement group member count
CREATE OR REPLACE FUNCTION decrement_member_count(group_id uuid)
RETURNS TABLE(member_count integer) AS $$
BEGIN
  RETURN QUERY
  UPDATE groups
  SET member_count = GREATEST(0, COALESCE(groups.member_count, 0) - 1)
  WHERE id = group_id
  RETURNING groups.member_count;
END;
$$ LANGUAGE plpgsql;

-- Atomic increment group member count
CREATE OR REPLACE FUNCTION increment_member_count(group_id uuid)
RETURNS TABLE(member_count integer) AS $$
BEGIN
  RETURN QUERY
  UPDATE groups
  SET member_count = COALESCE(groups.member_count, 0) + 1
  WHERE id = group_id
  RETURNING groups.member_count;
END;
$$ LANGUAGE plpgsql;
