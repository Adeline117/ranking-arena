-- 原子递增书签计数
CREATE OR REPLACE FUNCTION increment_bookmark_count(post_id UUID)
RETURNS TABLE(bookmark_count INTEGER) AS $$
BEGIN
  RETURN QUERY
  UPDATE posts
  SET bookmark_count = COALESCE(posts.bookmark_count, 0) + 1
  WHERE id = post_id
  RETURNING posts.bookmark_count;
END;
$$ LANGUAGE plpgsql;

-- 原子递减书签计数
CREATE OR REPLACE FUNCTION decrement_bookmark_count(post_id UUID)
RETURNS TABLE(bookmark_count INTEGER) AS $$
BEGIN
  RETURN QUERY
  UPDATE posts
  SET bookmark_count = GREATEST(0, COALESCE(posts.bookmark_count, 1) - 1)
  WHERE id = post_id
  RETURNING posts.bookmark_count;
END;
$$ LANGUAGE plpgsql;

-- 原子递增点赞计数
CREATE OR REPLACE FUNCTION increment_like_count(post_id UUID)
RETURNS TABLE(like_count INTEGER) AS $$
BEGIN
  RETURN QUERY
  UPDATE posts
  SET like_count = COALESCE(posts.like_count, 0) + 1
  WHERE id = post_id
  RETURNING posts.like_count;
END;
$$ LANGUAGE plpgsql;

-- 原子递减点赞计数
CREATE OR REPLACE FUNCTION decrement_like_count(post_id UUID)
RETURNS TABLE(like_count INTEGER) AS $$
BEGIN
  RETURN QUERY
  UPDATE posts
  SET like_count = GREATEST(0, COALESCE(posts.like_count, 1) - 1)
  WHERE id = post_id
  RETURNING posts.like_count;
END;
$$ LANGUAGE plpgsql;

-- 原子递增浏览计数
CREATE OR REPLACE FUNCTION increment_view_count(post_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE posts
  SET view_count = COALESCE(view_count, 0) + 1
  WHERE id = post_id;
END;
$$ LANGUAGE plpgsql;
