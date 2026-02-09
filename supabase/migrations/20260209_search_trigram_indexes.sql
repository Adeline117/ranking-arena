-- Search optimization: Add trigram indexes for all searched columns
-- These indexes accelerate ILIKE %pattern% queries used by /api/search

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- trader_sources (the table actually queried by the search API)
CREATE INDEX IF NOT EXISTS idx_trader_sources_handle_trgm
  ON trader_sources USING gin (handle gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_trader_sources_id_trgm
  ON trader_sources USING gin (source_trader_id gin_trgm_ops);

-- posts title (may already exist from 00014, but IF NOT EXISTS is safe)
CREATE INDEX IF NOT EXISTS idx_posts_title_trgm
  ON posts USING gin (title gin_trgm_ops);

-- library_items
CREATE INDEX IF NOT EXISTS idx_library_items_title_trgm
  ON library_items USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_library_items_author_trgm
  ON library_items USING gin (author gin_trgm_ops);

-- user_profiles
CREATE INDEX IF NOT EXISTS idx_user_profiles_handle_trgm
  ON user_profiles USING gin (handle gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_user_profiles_display_name_trgm
  ON user_profiles USING gin (display_name gin_trgm_ops);
