-- Add pg_trgm GIN indexes for faster ILIKE search
-- These indexes speed up `column ILIKE '%query%'` patterns in /api/search
-- Without these, ILIKE with leading wildcard triggers full table scans

-- Enable pg_trgm extension (usually already enabled on Supabase)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Posts: search by title
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_title_trgm
  ON posts USING gin (title gin_trgm_ops);

-- Library items: search by title and author
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_library_items_title_trgm
  ON library_items USING gin (title gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_library_items_author_trgm
  ON library_items USING gin (author gin_trgm_ops);

-- User profiles: search by handle, display_name
-- bio excluded (too large, rarely searched alone)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_profiles_handle_trgm
  ON user_profiles USING gin (handle gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_profiles_display_name_trgm
  ON user_profiles USING gin (display_name gin_trgm_ops);

-- Groups: search by name
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_groups_name_trgm
  ON groups USING gin (name gin_trgm_ops);
