-- ================================================================
-- Combined Pending Migrations Script
-- Generated for production deployment
--
-- Includes (in chronological order):
--   1. 20260308000001_count_trader_followers_rpc.sql
--   2. 20260308100000_desoc_foundation.sql
--   3. 20260308200000_fix_refresh_jobs_idempotency_unique.sql
--
-- Usage:
--   psql $DATABASE_URL -f scripts/apply-desoc-migration.sql
--
-- Dependencies: None between migrations (all independent).
-- Prerequisites: Tables trader_follows, trader_sources, user_profiles,
--   groups, posts, refresh_jobs must already exist.
-- ================================================================


-- ================================================================
-- Migration 1: count_trader_followers RPC
-- Source: 20260308000001_count_trader_followers_rpc.sql
-- Purpose: Efficient follower counting via GROUP BY instead of
--          fetching all rows client-side.
-- ================================================================
BEGIN;

CREATE OR REPLACE FUNCTION count_trader_followers(trader_ids text[])
RETURNS TABLE(trader_id text, cnt bigint) AS $$
BEGIN
  RETURN QUERY
    SELECT tf.trader_id, COUNT(*)::bigint AS cnt
    FROM trader_follows tf
    WHERE tf.trader_id = ANY(trader_ids)
    GROUP BY tf.trader_id;
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;


-- ================================================================
-- Migration 2: DeSoc Foundation
-- Source: 20260308100000_desoc_foundation.sql
-- Purpose: Core DeSoc tables (trader_claims, verified_traders,
--   trader_attestations, user_exchange_connections) plus bot support
--   columns and reputation/gating columns on existing tables.
-- ================================================================
BEGIN;

-- ----------------------------------------
-- 2.1 Trader Claims (claim requests)
-- ----------------------------------------
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

CREATE INDEX IF NOT EXISTS idx_trader_claims_user ON trader_claims(user_id);
CREATE INDEX IF NOT EXISTS idx_trader_claims_status ON trader_claims(status);
CREATE INDEX IF NOT EXISTS idx_trader_claims_trader ON trader_claims(trader_id, source);

ALTER TABLE trader_claims ENABLE ROW LEVEL SECURITY;

-- RLS policies (use DO blocks to skip if already exists)
DO $$ BEGIN
  CREATE POLICY "Users can view their own claims"
    ON trader_claims FOR SELECT
    USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Users can insert their own claims"
    ON trader_claims FOR INSERT
    WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Users can delete their own pending claims"
    ON trader_claims FOR DELETE
    USING (auth.uid() = user_id AND status = 'pending');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Service role can manage all claims"
    ON trader_claims FOR ALL
    USING (true)
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------
-- 2.2 Verified Traders
-- ----------------------------------------
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

CREATE INDEX IF NOT EXISTS idx_verified_traders_trader ON verified_traders(trader_id, source);
CREATE INDEX IF NOT EXISTS idx_verified_traders_user ON verified_traders(user_id);

ALTER TABLE verified_traders ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Anyone can view verified traders"
    ON verified_traders FOR SELECT
    USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Users can update their own verified profile"
    ON verified_traders FOR UPDATE
    USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Service role can manage verified traders"
    ON verified_traders FOR ALL
    USING (true)
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------
-- 2.3 Add is_bot to trader_sources
-- ----------------------------------------
ALTER TABLE trader_sources
  ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bot_category TEXT CHECK (bot_category IS NULL OR bot_category IN ('tg_bot', 'ai_agent', 'vault', 'strategy'));

CREATE INDEX IF NOT EXISTS idx_trader_sources_is_bot ON trader_sources(is_bot) WHERE is_bot = TRUE;

-- ----------------------------------------
-- 2.4 Add reputation columns to user_profiles
-- ----------------------------------------
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS reputation_score INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_verified_trader BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS verified_trader_id TEXT,
  ADD COLUMN IF NOT EXISTS verified_trader_source TEXT;

CREATE INDEX IF NOT EXISTS idx_user_profiles_reputation ON user_profiles(reputation_score DESC);
CREATE INDEX IF NOT EXISTS idx_user_profiles_verified ON user_profiles(is_verified_trader) WHERE is_verified_trader = TRUE;

-- ----------------------------------------
-- 2.5 Add score_threshold to groups (reputation-gated)
-- ----------------------------------------
ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS min_arena_score INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_verified_only BOOLEAN DEFAULT FALSE;

-- ----------------------------------------
-- 2.6 Add arena_score to posts for weighted feed
-- ----------------------------------------
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS author_arena_score INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS author_is_verified BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_posts_author_score ON posts(author_arena_score DESC) WHERE author_arena_score > 0;

-- ----------------------------------------
-- 2.7 Attestation metadata
-- ----------------------------------------
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

DO $$ BEGIN
  CREATE POLICY "Anyone can view attestations"
    ON trader_attestations FOR SELECT
    USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Service role can manage attestations"
    ON trader_attestations FOR ALL
    USING (true)
    WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------
-- 2.8 User exchange connections
-- ----------------------------------------
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

DO $$ BEGIN
  CREATE POLICY "Users can view their own connections"
    ON user_exchange_connections FOR SELECT
    USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Users can manage their own connections"
    ON user_exchange_connections FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------
-- 2.9 Updated_at triggers
-- ----------------------------------------
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

-- ----------------------------------------
-- 2.10 Table/column comments
-- ----------------------------------------
COMMENT ON TABLE trader_claims IS 'Trader profile claim requests';
COMMENT ON TABLE verified_traders IS 'Verified trader profiles with editable social links';
COMMENT ON TABLE user_exchange_connections IS 'User exchange API connections for ownership verification';
COMMENT ON COLUMN trader_sources.is_bot IS 'Whether this trader is a bot/AI agent';
COMMENT ON COLUMN user_profiles.reputation_score IS 'DeSoc reputation score based on verified trading performance';
COMMENT ON COLUMN groups.min_arena_score IS 'Minimum Arena Score required to join this group';
COMMENT ON COLUMN posts.author_arena_score IS 'Author Arena Score at time of posting for weighted feed';

COMMIT;


-- ================================================================
-- Migration 3: Fix refresh_jobs idempotency_key unique constraint
-- Source: 20260308200000_fix_refresh_jobs_idempotency_unique.sql
-- Purpose: Adds missing UNIQUE constraint on refresh_jobs.idempotency_key
--   which was skipped when CREATE TABLE IF NOT EXISTS found an existing table.
-- ================================================================
BEGIN;

-- Add column if missing
ALTER TABLE refresh_jobs ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Add unique constraint if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'refresh_jobs_idempotency_key_key'
      AND conrelid = 'refresh_jobs'::regclass
  ) THEN
    ALTER TABLE refresh_jobs ADD CONSTRAINT refresh_jobs_idempotency_key_key UNIQUE (idempotency_key);
  END IF;
END $$;

COMMIT;


-- ================================================================
-- Verification queries (run after applying to confirm success)
-- ================================================================
-- SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('trader_claims', 'verified_traders', 'trader_attestations', 'user_exchange_connections');
-- SELECT proname FROM pg_proc WHERE proname = 'count_trader_followers';
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'trader_sources' AND column_name = 'is_bot';
-- SELECT conname FROM pg_constraint WHERE conname = 'refresh_jobs_idempotency_key_key';
