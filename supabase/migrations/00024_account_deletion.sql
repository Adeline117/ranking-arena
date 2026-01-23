-- Account Deletion Support
-- Adds soft-delete columns to user_profiles for 30-day grace period deletion

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS deletion_reason TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS original_handle TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS original_email TEXT DEFAULT NULL;

-- Index for finding accounts pending deletion (cron job)
CREATE INDEX IF NOT EXISTS idx_user_profiles_deletion_scheduled
  ON user_profiles (deletion_scheduled_at)
  WHERE deletion_scheduled_at IS NOT NULL AND deleted_at IS NOT NULL;

-- Index for checking deleted status
CREATE INDEX IF NOT EXISTS idx_user_profiles_deleted_at
  ON user_profiles (deleted_at)
  WHERE deleted_at IS NOT NULL;
