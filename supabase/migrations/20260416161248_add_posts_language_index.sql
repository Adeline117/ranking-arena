-- Add partial covering index for language-filtered public posts feed.
-- Root cause: lib/data/posts.ts filters .eq('language', lang) + .order('created_at', desc)
-- but no index covers (language, created_at). For zh/en toggle, minority-language
-- users hit full table scan once posts > 500K rows.

CREATE INDEX IF NOT EXISTS idx_posts_language_visibility_created
  ON posts (language, visibility, created_at DESC)
  WHERE visibility = 'public';
