-- Add account deletion tracking columns to user_profiles
-- Required by cleanup-deleted-accounts cron job

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMPTZ;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS deletion_reason TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS original_handle TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS original_email TEXT;

CREATE INDEX IF NOT EXISTS idx_user_profiles_deletion_scheduled
  ON user_profiles(deletion_scheduled_at)
  WHERE deleted_at IS NOT NULL;
