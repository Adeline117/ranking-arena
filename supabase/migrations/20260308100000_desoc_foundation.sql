-- ============================================
-- DeSoc Foundation Migration
-- Creates trader_claims, verified_traders, and adds is_bot support
-- ============================================

-- ============================================
-- 1. Trader Claims (认领申请)
-- ============================================
CREATE TABLE IF NOT EXISTS trader_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id TEXT NOT NULL,
  source TEXT NOT NULL,
  handle TEXT,

  -- Verification
  verification_method TEXT NOT NULL CHECK (verification_method IN ('api_key', 'signature', 'video', 'social')),
  verification_data JSONB DEFAULT '{}'::jsonb,

  -- Status
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'verified', 'rejected', 'approved')),
  reject_reason TEXT,
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- One active claim per trader per source
  UNIQUE(trader_id, source)
);

CREATE INDEX idx_trader_claims_user ON trader_claims(user_id);
CREATE INDEX idx_trader_claims_status ON trader_claims(status);
CREATE INDEX idx_trader_claims_trader ON trader_claims(trader_id, source);

ALTER TABLE trader_claims ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own claims"
  ON trader_claims FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own claims"
  ON trader_claims FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own pending claims"
  ON trader_claims FOR DELETE
  USING (auth.uid() = user_id AND status = 'pending');

CREATE POLICY "Service role can manage all claims"
  ON trader_claims FOR ALL
  USING (true)
  WITH CHECK (true);

-- ============================================
-- 2. Verified Traders (已认证交易员)
-- ============================================
CREATE TABLE IF NOT EXISTS verified_traders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id TEXT NOT NULL,
  source TEXT NOT NULL,

  -- Editable profile fields
  display_name TEXT,
  bio TEXT,
  avatar_url TEXT,
  twitter_url TEXT,
  telegram_url TEXT,
  discord_url TEXT,
  website_url TEXT,

  -- Verification info
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verification_method TEXT NOT NULL,

  -- Permissions
  can_pin_posts BOOLEAN DEFAULT FALSE,
  can_reply_reviews BOOLEAN DEFAULT TRUE,
  can_receive_messages BOOLEAN DEFAULT TRUE,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- One verified trader per user, one user per trader
  UNIQUE(user_id),
  UNIQUE(trader_id, source)
);

CREATE INDEX idx_verified_traders_trader ON verified_traders(trader_id, source);
CREATE INDEX idx_verified_traders_user ON verified_traders(user_id);

ALTER TABLE verified_traders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view verified traders"
  ON verified_traders FOR SELECT
  USING (true);

CREATE POLICY "Users can update their own verified profile"
  ON verified_traders FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage verified traders"
  ON verified_traders FOR ALL
  USING (true)
  WITH CHECK (true);

-- ============================================
-- 3. Add is_bot to trader_sources
-- ============================================
ALTER TABLE trader_sources
  ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bot_category TEXT CHECK (bot_category IS NULL OR bot_category IN ('tg_bot', 'ai_agent', 'vault', 'strategy'));

CREATE INDEX IF NOT EXISTS idx_trader_sources_is_bot ON trader_sources(is_bot) WHERE is_bot = TRUE;

-- ============================================
-- 4. Add reputation_score to user_profiles (DeSoc weight)
-- ============================================
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS reputation_score INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_verified_trader BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS verified_trader_id TEXT,
  ADD COLUMN IF NOT EXISTS verified_trader_source TEXT;

CREATE INDEX IF NOT EXISTS idx_user_profiles_reputation ON user_profiles(reputation_score DESC);
CREATE INDEX IF NOT EXISTS idx_user_profiles_verified ON user_profiles(is_verified_trader) WHERE is_verified_trader = TRUE;

-- ============================================
-- 5. Add score_threshold to groups (reputation-gated)
-- ============================================
ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS min_arena_score INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_verified_only BOOLEAN DEFAULT FALSE;

-- ============================================
-- 6. Add arena_score to posts for weighted feed
-- ============================================
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS author_arena_score INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS author_is_verified BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_posts_author_score ON posts(author_arena_score DESC) WHERE author_arena_score > 0;

-- ============================================
-- 7. Attestation metadata (create table if not exists)
-- ============================================
CREATE TABLE IF NOT EXISTS trader_attestations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trader_id TEXT NOT NULL,
  source TEXT NOT NULL,
  arena_score NUMERIC,
  tx_hash TEXT,
  chain_id INTEGER DEFAULT 8453,
  score_period TEXT DEFAULT 'overall',
  minted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(trader_id, source, score_period)
);

ALTER TABLE trader_attestations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view attestations"
  ON trader_attestations FOR SELECT
  USING (true);

CREATE POLICY "Service role can manage attestations"
  ON trader_attestations FOR ALL
  USING (true)
  WITH CHECK (true);

-- ============================================
-- 8. User exchange connections (for claim verification)
-- ============================================
CREATE TABLE IF NOT EXISTS user_exchange_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  api_secret_encrypted TEXT NOT NULL,
  passphrase_encrypted TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, exchange)
);

ALTER TABLE user_exchange_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own connections"
  ON user_exchange_connections FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own connections"
  ON user_exchange_connections FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================
-- 9. Updated_at triggers
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trigger_trader_claims_updated_at
    BEFORE UPDATE ON trader_claims
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER trigger_verified_traders_updated_at
    BEFORE UPDATE ON verified_traders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER trigger_user_exchange_connections_updated_at
    BEFORE UPDATE ON user_exchange_connections
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================
-- Comments
-- ============================================
COMMENT ON TABLE trader_claims IS 'Trader profile claim requests';
COMMENT ON TABLE verified_traders IS 'Verified trader profiles with editable social links';
COMMENT ON TABLE user_exchange_connections IS 'User exchange API connections for ownership verification';
COMMENT ON COLUMN trader_sources.is_bot IS 'Whether this trader is a bot/AI agent';
COMMENT ON COLUMN user_profiles.reputation_score IS 'DeSoc reputation score based on verified trading performance';
COMMENT ON COLUMN groups.min_arena_score IS 'Minimum Arena Score required to join this group';
COMMENT ON COLUMN posts.author_arena_score IS 'Author Arena Score at time of posting for weighted feed';
