-- Fix migration: Create trader_alerts table (missing base table for 00073)
-- Applied manually on 2026-02-08
-- Also applied indexes from 00074 (excluding market_type/window indexes which don't exist on trader_snapshots)

-- 1. Create trader_alerts base table
CREATE TABLE IF NOT EXISTS trader_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id TEXT NOT NULL,
  source TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  alert_roi_change BOOLEAN DEFAULT TRUE,
  roi_change_threshold NUMERIC DEFAULT 10,
  alert_drawdown BOOLEAN DEFAULT TRUE,
  drawdown_threshold NUMERIC DEFAULT 20,
  alert_pnl_change BOOLEAN DEFAULT FALSE,
  pnl_change_threshold NUMERIC DEFAULT 5000,
  alert_score_change BOOLEAN DEFAULT TRUE,
  score_change_threshold NUMERIC DEFAULT 5,
  alert_rank_change BOOLEAN DEFAULT FALSE,
  rank_change_threshold INTEGER DEFAULT 5,
  alert_new_position BOOLEAN DEFAULT FALSE,
  alert_price_above BOOLEAN DEFAULT FALSE,
  price_above_value NUMERIC DEFAULT NULL,
  alert_price_below BOOLEAN DEFAULT FALSE,
  price_below_value NUMERIC DEFAULT NULL,
  price_symbol VARCHAR(20) DEFAULT NULL,
  last_triggered_at TIMESTAMPTZ DEFAULT NULL,
  one_time BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, trader_id)
);

CREATE INDEX IF NOT EXISTS idx_trader_alerts_user ON trader_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_trader_alerts_trader ON trader_alerts(trader_id);

ALTER TABLE trader_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own alerts" ON trader_alerts
  FOR ALL USING (auth.uid() = user_id);

-- 2. Add alert_id to existing alert_history table
ALTER TABLE alert_history ADD COLUMN IF NOT EXISTS alert_id UUID REFERENCES trader_alerts(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_alert_history_alert_id ON alert_history(alert_id, triggered_at DESC);
