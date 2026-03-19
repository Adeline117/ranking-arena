-- Add referral system columns to user_profiles
-- referral_code: unique short code for sharing
-- referred_by: user ID of the referrer

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES user_profiles(id);

-- Unique index on referral_code (only non-null values)
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_referral_code
  ON user_profiles (referral_code) WHERE referral_code IS NOT NULL;

-- Index for counting referrals by referrer
CREATE INDEX IF NOT EXISTS idx_user_profiles_referred_by
  ON user_profiles (referred_by) WHERE referred_by IS NOT NULL;
