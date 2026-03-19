-- ==========================================================
-- Post Visibility, Full-text Search, Content Warning, Language
-- ==========================================================

-- Feature 1: Post Visibility Levels
ALTER TABLE posts ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public'
  CHECK (visibility IN ('public', 'followers', 'group'));
CREATE INDEX IF NOT EXISTS idx_posts_visibility ON posts(visibility);

-- Feature 2: Full-text Search on Posts
ALTER TABLE posts ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE OR REPLACE FUNCTION posts_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.content, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_posts_search_vector ON posts;
CREATE TRIGGER trigger_posts_search_vector
  BEFORE INSERT OR UPDATE OF title, content ON posts
  FOR EACH ROW EXECUTE FUNCTION posts_search_vector_trigger();

CREATE INDEX IF NOT EXISTS idx_posts_search ON posts USING GIN (search_vector);

-- Backfill existing posts
UPDATE posts SET search_vector =
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(content, '')), 'B');

-- Feature 3: Content Warning / Sensitive Flag
ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_sensitive boolean DEFAULT false;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS content_warning text;

-- Feature 4: Post Language Detection
ALTER TABLE posts ADD COLUMN IF NOT EXISTS language text DEFAULT 'zh';
