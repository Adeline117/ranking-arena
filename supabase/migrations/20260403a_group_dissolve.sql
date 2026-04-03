-- Add dissolved_at to groups table
-- When set, the group is frozen: no new posts, no joins, no member management.
-- Historical posts remain readable. Owner's sidebar hides dissolved groups.
ALTER TABLE groups ADD COLUMN IF NOT EXISTS dissolved_at timestamptz DEFAULT NULL;

-- Index for filtering active groups
CREATE INDEX IF NOT EXISTS idx_groups_dissolved_at ON groups (dissolved_at) WHERE dissolved_at IS NULL;
