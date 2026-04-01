-- Extend trader_alerts with read_at for notification tracking
-- and add trader_alert_logs table for position change signal history

-- Add read_at column to trader_alerts (for marking alerts as read)
ALTER TABLE trader_alerts ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ DEFAULT NULL;

-- Create trader_alert_logs table if not exists (for cron job logging)
CREATE TABLE IF NOT EXISTS trader_alert_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id UUID REFERENCES trader_alerts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  old_value NUMERIC,
  new_value NUMERIC,
  change_percent NUMERIC,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trader_alert_logs_alert ON trader_alert_logs(alert_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trader_alert_logs_user ON trader_alert_logs(user_id, created_at DESC);

ALTER TABLE trader_alert_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "Users can read own alert logs"
  ON trader_alert_logs FOR SELECT USING (auth.uid() = user_id);

-- Index for efficient unread alerts query
CREATE INDEX IF NOT EXISTS idx_trader_alerts_unread
  ON trader_alerts(user_id, enabled) WHERE read_at IS NULL;
