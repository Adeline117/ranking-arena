-- Add dislike support for comments
ALTER TABLE comments ADD COLUMN IF NOT EXISTS dislike_count INTEGER DEFAULT 0;
ALTER TABLE comment_likes ADD COLUMN IF NOT EXISTS reaction_type TEXT DEFAULT 'like' CHECK (reaction_type IN ('like', 'dislike'));
