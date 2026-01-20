-- 风险预警系统数据库迁移
-- 版本: 00006
-- 创建日期: 2026-01

-- ============================================
-- 1. 预警配置表
-- ============================================
CREATE TABLE IF NOT EXISTS alert_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id TEXT NOT NULL,
  trader_handle TEXT,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('drawdown', 'rank_drop', 'win_rate_drop', 'roi_change')),
  threshold DECIMAL(10, 2) NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, trader_id, alert_type)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_alert_configs_user_id ON alert_configs(user_id);
CREATE INDEX IF NOT EXISTS idx_alert_configs_trader_id ON alert_configs(trader_id);
CREATE INDEX IF NOT EXISTS idx_alert_configs_enabled ON alert_configs(user_id, enabled) WHERE enabled = TRUE;

-- RLS
ALTER TABLE alert_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own alert configs"
  ON alert_configs FOR SELECT 
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own alert configs"
  ON alert_configs FOR INSERT 
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own alert configs"
  ON alert_configs FOR UPDATE 
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own alert configs"
  ON alert_configs FOR DELETE 
  USING (auth.uid() = user_id);

-- ============================================
-- 2. 风险预警记录表
-- ============================================
CREATE TABLE IF NOT EXISTS risk_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id TEXT NOT NULL,
  trader_handle TEXT,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('drawdown', 'rank_drop', 'win_rate_drop', 'roi_change')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  threshold DECIMAL(10, 2) NOT NULL,
  current_value DECIMAL(10, 2) NOT NULL,
  previous_value DECIMAL(10, 2) DEFAULT 0,
  message TEXT,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_risk_alerts_user_id ON risk_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_risk_alerts_trader_id ON risk_alerts(trader_id);
CREATE INDEX IF NOT EXISTS idx_risk_alerts_unread ON risk_alerts(user_id, is_read) WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS idx_risk_alerts_created_at ON risk_alerts(created_at DESC);

-- RLS
ALTER TABLE risk_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own alerts"
  ON risk_alerts FOR SELECT 
  USING (auth.uid() = user_id);

CREATE POLICY "System can insert alerts"
  ON risk_alerts FOR INSERT 
  WITH CHECK (TRUE);

CREATE POLICY "Users can update their own alerts"
  ON risk_alerts FOR UPDATE 
  USING (auth.uid() = user_id);

-- ============================================
-- 3. 触发器：更新 updated_at
-- ============================================
CREATE OR REPLACE FUNCTION update_alert_configs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_alert_configs_updated_at ON alert_configs;
CREATE TRIGGER trigger_alert_configs_updated_at
  BEFORE UPDATE ON alert_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_alert_configs_updated_at();

-- ============================================
-- 4. 清理旧预警的函数（保留最近30天）
-- ============================================
CREATE OR REPLACE FUNCTION cleanup_old_risk_alerts()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM risk_alerts 
  WHERE created_at < NOW() - INTERVAL '30 days'
  AND is_read = TRUE;
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 5. 获取用户预警统计的函数
-- ============================================
CREATE OR REPLACE FUNCTION get_user_alert_stats(p_user_id UUID)
RETURNS TABLE (
  total_alerts BIGINT,
  unread_count BIGINT,
  critical_count BIGINT,
  warning_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COUNT(*) as total_alerts,
    COUNT(*) FILTER (WHERE is_read = FALSE) as unread_count,
    COUNT(*) FILTER (WHERE severity = 'critical' AND is_read = FALSE) as critical_count,
    COUNT(*) FILTER (WHERE severity = 'warning' AND is_read = FALSE) as warning_count
  FROM risk_alerts
  WHERE user_id = p_user_id
  AND created_at > NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql;
