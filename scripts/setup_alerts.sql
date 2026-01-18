-- ============================================
-- 风险预警系统数据库表
-- 用于存储用户告警配置和告警历史
-- ============================================

-- ============================================
-- 告警类型枚举
-- ============================================
-- DRAWDOWN_WARNING: 回撤超过阈值
-- DRAWDOWN_SPIKE: 回撤急剧加深
-- STYLE_CHANGE: 交易风格突变
-- POSITION_SPIKE: 仓位异常放大
-- WIN_RATE_DROP: 胜率骤降
-- FOLLOWER_EXODUS: 大量跟单者撤离
-- PROFIT_TARGET_HIT: 达到止盈目标
-- STOP_LOSS_HIT: 达到止损目标

-- ============================================
-- 用户告警配置表
-- ============================================

CREATE TABLE IF NOT EXISTS user_alert_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id TEXT NOT NULL,
  source TEXT NOT NULL,
  
  -- 告警阈值配置
  drawdown_threshold NUMERIC DEFAULT 10,       -- 回撤告警阈值（%）
  drawdown_spike_threshold NUMERIC DEFAULT 5,  -- 回撤急剧加深阈值（24小时内）
  win_rate_drop_threshold NUMERIC DEFAULT 10,  -- 胜率下降告警阈值（%）
  profit_target NUMERIC,                        -- 止盈目标（%）
  stop_loss NUMERIC,                            -- 止损目标（%）
  
  -- 通知方式
  notify_in_app BOOLEAN DEFAULT TRUE,
  notify_email BOOLEAN DEFAULT FALSE,
  notify_push BOOLEAN DEFAULT FALSE,
  
  -- 启用的告警类型
  alert_types TEXT[] DEFAULT ARRAY['DRAWDOWN_WARNING', 'DRAWDOWN_SPIKE', 'WIN_RATE_DROP'],
  
  -- 状态
  enabled BOOLEAN DEFAULT TRUE,
  
  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- 每个用户对每个交易员只能有一个配置
  UNIQUE(user_id, trader_id, source)
);

-- ============================================
-- 告警历史表
-- ============================================

CREATE TABLE IF NOT EXISTS trader_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id TEXT NOT NULL,
  source TEXT NOT NULL,
  
  -- 告警信息
  type TEXT NOT NULL,                           -- 告警类型
  severity TEXT NOT NULL DEFAULT 'MEDIUM',      -- LOW, MEDIUM, HIGH, CRITICAL
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  data JSONB,                                   -- 具体数据（如回撤值、变化量等）
  
  -- 状态
  read BOOLEAN DEFAULT FALSE,
  acknowledged_at TIMESTAMPTZ,                  -- 用户确认时间
  
  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 交易员历史数据快照（用于检测变化）
-- ============================================

CREATE TABLE IF NOT EXISTS trader_daily_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trader_id TEXT NOT NULL,
  source TEXT NOT NULL,
  
  -- 核心指标
  roi NUMERIC,
  pnl NUMERIC,
  max_drawdown NUMERIC,
  win_rate NUMERIC,
  followers INTEGER,
  trades_count INTEGER,
  
  -- 快照日期（每天一条记录）
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- 每个交易员每天只有一条记录
  UNIQUE(trader_id, source, snapshot_date)
);

-- ============================================
-- 索引优化
-- ============================================

-- 告警配置索引
CREATE INDEX IF NOT EXISTS idx_alert_configs_user ON user_alert_configs(user_id);
CREATE INDEX IF NOT EXISTS idx_alert_configs_trader ON user_alert_configs(trader_id, source);
CREATE INDEX IF NOT EXISTS idx_alert_configs_enabled ON user_alert_configs(enabled) WHERE enabled = true;

-- 告警历史索引
CREATE INDEX IF NOT EXISTS idx_alerts_user ON trader_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_user_unread ON trader_alerts(user_id, read) WHERE read = false;
CREATE INDEX IF NOT EXISTS idx_alerts_trader ON trader_alerts(trader_id, source);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON trader_alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_type ON trader_alerts(type);

-- 每日快照索引
CREATE INDEX IF NOT EXISTS idx_daily_snapshots_trader ON trader_daily_snapshots(trader_id, source);
CREATE INDEX IF NOT EXISTS idx_daily_snapshots_date ON trader_daily_snapshots(snapshot_date DESC);

-- ============================================
-- 自动更新 updated_at 触发器
-- ============================================

CREATE OR REPLACE FUNCTION update_alert_configs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_alert_configs_updated_at ON user_alert_configs;
CREATE TRIGGER trg_alert_configs_updated_at
  BEFORE UPDATE ON user_alert_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_alert_configs_updated_at();

-- ============================================
-- 获取用户未读告警数量
-- ============================================

CREATE OR REPLACE FUNCTION get_unread_alert_count(p_user_id UUID)
RETURNS INTEGER AS $$
  SELECT COUNT(*)::INTEGER
  FROM trader_alerts
  WHERE user_id = p_user_id AND read = false;
$$ LANGUAGE SQL STABLE;

-- ============================================
-- 批量标记告警已读
-- ============================================

CREATE OR REPLACE FUNCTION mark_alerts_read(p_user_id UUID, p_alert_ids UUID[])
RETURNS INTEGER AS $$
  WITH updated AS (
    UPDATE trader_alerts
    SET read = true, acknowledged_at = NOW()
    WHERE user_id = p_user_id AND id = ANY(p_alert_ids)
    RETURNING id
  )
  SELECT COUNT(*)::INTEGER FROM updated;
$$ LANGUAGE SQL;

-- ============================================
-- Row Level Security (RLS)
-- ============================================

ALTER TABLE user_alert_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE trader_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE trader_daily_snapshots ENABLE ROW LEVEL SECURITY;

-- 告警配置策略
DROP POLICY IF EXISTS "Users can view their own alert configs" ON user_alert_configs;
CREATE POLICY "Users can view their own alert configs" ON user_alert_configs
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create their own alert configs" ON user_alert_configs;
CREATE POLICY "Users can create their own alert configs" ON user_alert_configs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own alert configs" ON user_alert_configs;
CREATE POLICY "Users can update their own alert configs" ON user_alert_configs
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own alert configs" ON user_alert_configs;
CREATE POLICY "Users can delete their own alert configs" ON user_alert_configs
  FOR DELETE USING (auth.uid() = user_id);

-- 告警历史策略
DROP POLICY IF EXISTS "Users can view their own alerts" ON trader_alerts;
CREATE POLICY "Users can view their own alerts" ON trader_alerts
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "System can create alerts" ON trader_alerts;
CREATE POLICY "System can create alerts" ON trader_alerts
  FOR INSERT WITH CHECK (true);  -- Cron job 需要创建告警

DROP POLICY IF EXISTS "Users can update their own alerts" ON trader_alerts;
CREATE POLICY "Users can update their own alerts" ON trader_alerts
  FOR UPDATE USING (auth.uid() = user_id);

-- 每日快照策略（只读，由 Cron 写入）
DROP POLICY IF EXISTS "Daily snapshots are viewable by everyone" ON trader_daily_snapshots;
CREATE POLICY "Daily snapshots are viewable by everyone" ON trader_daily_snapshots
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "System can create daily snapshots" ON trader_daily_snapshots;
CREATE POLICY "System can create daily snapshots" ON trader_daily_snapshots
  FOR INSERT WITH CHECK (true);
