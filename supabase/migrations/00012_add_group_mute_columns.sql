-- Add muting columns to group_members table
-- These columns are required for the group member mute functionality

ALTER TABLE group_members
  ADD COLUMN IF NOT EXISTS muted_until TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS mute_reason TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS muted_by UUID DEFAULT NULL REFERENCES auth.users(id) ON DELETE SET NULL;

-- Add index for quickly finding muted members
CREATE INDEX IF NOT EXISTS idx_group_members_muted_until
  ON group_members (group_id, muted_until)
  WHERE muted_until IS NOT NULL;
