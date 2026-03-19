-- Add mentions and hashtags arrays to posts for @mention and #hashtag support
ALTER TABLE posts ADD COLUMN IF NOT EXISTS mentions text[] DEFAULT '{}';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS hashtags text[] DEFAULT '{}';

-- GIN indexes for efficient array lookups (e.g. "find all posts mentioning @alice")
CREATE INDEX IF NOT EXISTS idx_posts_mentions ON posts USING GIN (mentions);
CREATE INDEX IF NOT EXISTS idx_posts_hashtags ON posts USING GIN (hashtags);
