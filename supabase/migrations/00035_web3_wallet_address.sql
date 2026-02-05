-- ============================================
-- 00031: Web3 Identity — wallet_address on user_profiles
-- ============================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_profiles' AND column_name = 'wallet_address'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN wallet_address TEXT;
  END IF;
END $$;

-- Unique index: one wallet per user, one user per wallet
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_wallet_address
  ON user_profiles(wallet_address)
  WHERE wallet_address IS NOT NULL;
