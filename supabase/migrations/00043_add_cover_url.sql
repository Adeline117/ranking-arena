-- Add cover_url column to user_profiles
-- This column stores the URL for user's profile cover/background image

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS cover_url TEXT;

COMMENT ON COLUMN user_profiles.cover_url IS 'URL for user profile cover/background image';
