-- Add notifications_muted column to group_members
-- Allows users to mute group notifications without leaving the group
-- Used for auto-mute when Pro members are auto-joined to official group

ALTER TABLE group_members
ADD COLUMN IF NOT EXISTS notifications_muted BOOLEAN DEFAULT FALSE;

-- Index for efficient querying of unmuted members (for notification delivery)
CREATE INDEX IF NOT EXISTS idx_group_members_notifications_muted
ON group_members(group_id, user_id) WHERE notifications_muted = FALSE;

COMMENT ON COLUMN group_members.notifications_muted IS 'User-controlled mute: when true, no notifications from this group';
