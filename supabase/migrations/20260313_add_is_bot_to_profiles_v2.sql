-- Add is_bot and bot_category to trader_profiles_v2
-- trader_sources already has these columns (from 20260308100000_desoc_foundation.sql)
-- This adds them to the v2 profiles table for faster query filtering

ALTER TABLE trader_profiles_v2
  ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bot_category TEXT CHECK (bot_category IS NULL OR bot_category IN ('tg_bot', 'ai_agent', 'vault', 'strategy'));

CREATE INDEX IF NOT EXISTS idx_trader_profiles_v2_is_bot
  ON trader_profiles_v2 (is_bot) WHERE is_bot = TRUE;

-- Also add trader_type to trader_snapshots for filtering (if not exists)
ALTER TABLE trader_snapshots
  ADD COLUMN IF NOT EXISTS trader_type TEXT;

COMMENT ON COLUMN trader_profiles_v2.is_bot IS 'Whether this trader is a bot/AI agent';
COMMENT ON COLUMN trader_profiles_v2.bot_category IS 'Bot category: tg_bot, ai_agent, vault, strategy';
