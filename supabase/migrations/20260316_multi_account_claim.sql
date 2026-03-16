-- Multi-account claim system: allow users to link multiple trader accounts
-- Phase 1 MVP

-- 1. New junction table for multi-account linking
CREATE TABLE IF NOT EXISTS user_linked_traders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id       TEXT NOT NULL,
  source          TEXT NOT NULL,
  market_type     TEXT DEFAULT 'futures',
  label           TEXT,
  is_primary      BOOLEAN DEFAULT FALSE,
  display_order   INTEGER DEFAULT 0,
  verified_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verification_method TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, trader_id, source),
  UNIQUE(trader_id, source)
);

CREATE INDEX IF NOT EXISTS idx_ult_user ON user_linked_traders(user_id, display_order);
CREATE INDEX IF NOT EXISTS idx_ult_trader ON user_linked_traders(trader_id, source);

-- 2. Remove single-user constraint on verified_traders (allow multi-account)
ALTER TABLE verified_traders DROP CONSTRAINT IF EXISTS verified_traders_user_id_key;
ALTER TABLE verified_traders ADD COLUMN IF NOT EXISTS is_primary BOOLEAN DEFAULT TRUE;

-- 3. Add linked count to user_profiles
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS linked_trader_count INTEGER DEFAULT 0;

-- 4. RLS policies
ALTER TABLE user_linked_traders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own linked traders" ON user_linked_traders FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own linked traders" ON user_linked_traders FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own linked traders" ON user_linked_traders FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own linked traders" ON user_linked_traders FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY "Service role full access linked traders" ON user_linked_traders FOR ALL USING (true) WITH CHECK (true);
