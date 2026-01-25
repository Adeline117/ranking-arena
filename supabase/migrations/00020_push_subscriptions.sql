-- Push Subscriptions Table
-- Stores device push tokens for native (FCM/APNs) and web push notifications

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('fcm', 'apns', 'web')),
  platform TEXT CHECK (platform IN ('ios', 'android', 'web')),
  device_id TEXT,
  device_name TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Unique constraint: one token per user
  UNIQUE (user_id, token)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id
  ON push_subscriptions(user_id) WHERE enabled = true;

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_token
  ON push_subscriptions(token);

-- RLS Policies
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Users can read their own subscriptions
CREATE POLICY "Users can view own push subscriptions"
  ON push_subscriptions FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own subscriptions
CREATE POLICY "Users can create own push subscriptions"
  ON push_subscriptions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own subscriptions
CREATE POLICY "Users can update own push subscriptions"
  ON push_subscriptions FOR UPDATE
  USING (auth.uid() = user_id);

-- Users can delete their own subscriptions
CREATE POLICY "Users can delete own push subscriptions"
  ON push_subscriptions FOR DELETE
  USING (auth.uid() = user_id);

-- Service role can do everything (for server-side operations)
CREATE POLICY "Service role full access to push subscriptions"
  ON push_subscriptions FOR ALL
  USING (auth.role() = 'service_role');

-- Notification History Table (optional, for tracking sent notifications)
CREATE TABLE IF NOT EXISTS notification_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data JSONB,
  channel_id TEXT DEFAULT 'arena_default',
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'failed', 'clicked')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_notification_history_user_id
  ON notification_history(user_id, sent_at DESC);

ALTER TABLE notification_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own notification history"
  ON notification_history FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to notification history"
  ON notification_history FOR ALL
  USING (auth.role() = 'service_role');
