-- Fix: Add missing columns to posts table that are referenced in application code
-- These columns are used by useGroupPosts.ts, lib/data/posts.ts, and post creation

-- bookmark_count: used in group post list and bookmark API
ALTER TABLE posts ADD COLUMN IF NOT EXISTS bookmark_count INTEGER DEFAULT 0;

-- poll_enabled: used when creating posts with polls
ALTER TABLE posts ADD COLUMN IF NOT EXISTS poll_enabled BOOLEAN DEFAULT false;

-- poll_bull, poll_bear, poll_wait: poll vote counters
ALTER TABLE posts ADD COLUMN IF NOT EXISTS poll_bull INTEGER DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS poll_bear INTEGER DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS poll_wait INTEGER DEFAULT 0;

-- deleted_at, deleted_by, delete_reason: soft delete support for group admin post management
ALTER TABLE posts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS deleted_by UUID;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS delete_reason TEXT;

-- original_post_id: for reposts referencing original post
ALTER TABLE posts ADD COLUMN IF NOT EXISTS original_post_id UUID REFERENCES posts(id) ON DELETE SET NULL;

-- Index for soft-deleted posts filtering
CREATE INDEX IF NOT EXISTS idx_posts_deleted_at ON posts(deleted_at) WHERE deleted_at IS NOT NULL;

-- Index for original post lookups (reposts)
CREATE INDEX IF NOT EXISTS idx_posts_original_post_id ON posts(original_post_id) WHERE original_post_id IS NOT NULL;

-- Fix: Add missing columns to groups table
ALTER TABLE groups ADD COLUMN IF NOT EXISTS is_premium_only BOOLEAN DEFAULT false;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS name_en TEXT;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS description_en TEXT;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS created_by UUID;
