-- Bot Subscriptions table
-- Stores Telegram/Discord user subscriptions for trader rank change alerts.
-- Used by the Telegram bot (/follow, /unfollow) and future Discord bot commands.

CREATE TABLE IF NOT EXISTS bot_subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  platform_type TEXT NOT NULL CHECK (platform_type IN ('telegram', 'discord')),
  platform_user_id TEXT NOT NULL,       -- Telegram user ID or Discord user ID
  chat_id TEXT NOT NULL,                -- Telegram chat ID or Discord channel ID
  trader_id TEXT NOT NULL,              -- format: "platform:traderKey" e.g. "binance_futures:abc123"
  trader_handle TEXT,                   -- cached display name
  trader_platform TEXT,                 -- exchange platform key
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE (platform_type, platform_user_id, trader_id)
);

-- Index for fast lookup by platform user
CREATE INDEX IF NOT EXISTS idx_bot_subs_user ON bot_subscriptions (platform_type, platform_user_id) WHERE enabled = true;

-- Index for alert dispatch: find all subscribers for a given trader
CREATE INDEX IF NOT EXISTS idx_bot_subs_trader ON bot_subscriptions (trader_id) WHERE enabled = true;

-- RLS: service role only (no client access)
ALTER TABLE bot_subscriptions ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (used by API routes)
CREATE POLICY "service_role_all" ON bot_subscriptions
  FOR ALL
  USING (true)
  WITH CHECK (true);
