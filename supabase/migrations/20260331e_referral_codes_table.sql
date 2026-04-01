-- Referral codes table (standalone, complements user_profiles.referral_code)
-- Provides a dedicated table for referral tracking with explicit counts

CREATE TABLE IF NOT EXISTS referral_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  referral_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT referral_codes_code_unique UNIQUE (code)
);

CREATE INDEX IF NOT EXISTS idx_referral_codes_user ON referral_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code);

ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own referral codes"
  ON referral_codes FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own referral codes"
  ON referral_codes FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Ensure user_profiles has referred_by column (idempotent)
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES user_profiles(id);
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS referral_code TEXT;

-- Unique index on referral_code (only non-null values)
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_referral_code
  ON user_profiles (referral_code) WHERE referral_code IS NOT NULL;

-- Index for counting referrals by referrer
CREATE INDEX IF NOT EXISTS idx_user_profiles_referred_by
  ON user_profiles (referred_by) WHERE referred_by IS NOT NULL;
