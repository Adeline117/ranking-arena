-- Migration: Search Improvements
-- Adds pg_trgm extension for fuzzy matching, trigram indexes, and search analytics table

-- Enable pg_trgm extension for fuzzy text matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram indexes for fuzzy search on key tables
CREATE INDEX IF NOT EXISTS idx_trader_sources_v2_name_trgm
  ON trader_sources_v2 USING gin (display_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_posts_title_trgm
  ON posts USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_groups_name_trgm
  ON groups USING gin (name gin_trgm_ops);

-- Search analytics table for tracking queries
CREATE TABLE IF NOT EXISTS search_analytics (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  query text NOT NULL,
  result_count int NOT NULL DEFAULT 0,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  source text DEFAULT 'dropdown', -- 'dropdown', 'page', 'api'
  created_at timestamptz DEFAULT now()
);

-- Index for analytics queries
CREATE INDEX IF NOT EXISTS idx_search_analytics_created
  ON search_analytics(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_search_analytics_query
  ON search_analytics USING gin (query gin_trgm_ops);
