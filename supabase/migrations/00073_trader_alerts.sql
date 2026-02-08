-- 00073: 扩展交易员提醒系统 - 添加价格提醒和通用提醒支持
-- 在现有 trader_alerts 表基础上添加新字段，创建 alert_history 表

-- 1. 扩展 trader_alerts 表：添加排名变化、价格提醒相关字段
ALTER TABLE trader_alerts
  ADD COLUMN IF NOT EXISTS alert_rank_change BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS rank_change_threshold INTEGER DEFAULT 5,
  ADD COLUMN IF NOT EXISTS alert_new_position BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS alert_price_above BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS price_above_value NUMERIC DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS alert_price_below BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS price_below_value NUMERIC DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS price_symbol VARCHAR(20) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_triggered_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS one_time BOOLEAN DEFAULT FALSE;

-- 2. alert_history 表 - 提醒触发历史
CREATE TABLE IF NOT EXISTS alert_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id UUID NOT NULL REFERENCES trader_alerts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  alert_type VARCHAR(30) NOT NULL,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_alert_history_alert_id ON alert_history(alert_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_history_user_id ON alert_history(user_id, triggered_at DESC);

-- 3. RLS
ALTER TABLE alert_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own alert history"
  ON alert_history FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "System can insert alert history"
  ON alert_history FOR INSERT
  WITH CHECK (TRUE);

COMMENT ON TABLE alert_history IS '用户提醒触发历史记录';
COMMENT ON COLUMN trader_alerts.alert_rank_change IS '是否启用排名变化提醒';
COMMENT ON COLUMN trader_alerts.alert_price_above IS '是否启用价格上破提醒';
COMMENT ON COLUMN trader_alerts.alert_price_below IS '是否启用价格下破提醒';
COMMENT ON COLUMN trader_alerts.one_time IS '是否为一次性提醒（触发后自动关闭）';
