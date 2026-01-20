-- 交易员变动提醒系统数据库表结构
-- Pro 会员功能：关注的交易员大幅变动时自动私信提醒
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- ============================================
-- 1. 交易员快照表（用于检测变动）
-- ============================================
CREATE TABLE IF NOT EXISTS trader_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trader_id TEXT NOT NULL,
  source TEXT NOT NULL, -- binance_futures, bybit, etc.
  roi_7d DECIMAL,
  roi_30d DECIMAL,
  roi_90d DECIMAL,
  pnl_7d DECIMAL,
  pnl_30d DECIMAL,
  pnl_90d DECIMAL,
  max_drawdown DECIMAL,
  win_rate DECIMAL,
  arena_score DECIMAL,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- 每个交易员每天只保留一条快照
  UNIQUE(trader_id, source, snapshot_date)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_trader ON trader_snapshots(trader_id, source);
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_date ON trader_snapshots(snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_created ON trader_snapshots(created_at DESC);

-- RLS 策略
ALTER TABLE trader_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Trader snapshots are viewable by everyone" ON trader_snapshots;

CREATE POLICY "Trader snapshots are viewable by everyone"
  ON trader_snapshots FOR SELECT
  USING (true);

-- 只有服务端可以插入/更新快照
DROP POLICY IF EXISTS "Service can manage snapshots" ON trader_snapshots;

-- ============================================
-- 2. 用户交易员提醒配置表
-- ============================================
CREATE TABLE IF NOT EXISTS trader_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id TEXT NOT NULL,
  source TEXT, -- 可选：记录 trader 来源
  -- 提醒类型和阈值
  alert_roi_change BOOLEAN DEFAULT true, -- ROI 变动提醒
  roi_change_threshold DECIMAL DEFAULT 10, -- ROI 变动阈值（百分比，如 10 表示 10%）
  alert_drawdown BOOLEAN DEFAULT true, -- 回撤提醒
  drawdown_threshold DECIMAL DEFAULT 20, -- 回撤阈值（如 20 表示 20%）
  alert_pnl_change BOOLEAN DEFAULT false, -- PnL 变动提醒
  pnl_change_threshold DECIMAL DEFAULT 5000, -- PnL 变动阈值（USD）
  alert_score_change BOOLEAN DEFAULT true, -- Arena Score 变动提醒
  score_change_threshold DECIMAL DEFAULT 5, -- Score 变动阈值
  -- 状态
  enabled BOOLEAN DEFAULT true,
  last_alert_at TIMESTAMPTZ, -- 上次发送提醒的时间
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  -- 确保一个用户对一个交易员只有一套配置
  UNIQUE(user_id, trader_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_trader_alerts_user ON trader_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_trader_alerts_trader ON trader_alerts(trader_id);
CREATE INDEX IF NOT EXISTS idx_trader_alerts_enabled ON trader_alerts(enabled) WHERE enabled = true;

-- RLS 策略
ALTER TABLE trader_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own alerts" ON trader_alerts;
DROP POLICY IF EXISTS "Users can create their own alerts" ON trader_alerts;
DROP POLICY IF EXISTS "Users can update their own alerts" ON trader_alerts;
DROP POLICY IF EXISTS "Users can delete their own alerts" ON trader_alerts;

CREATE POLICY "Users can view their own alerts"
  ON trader_alerts FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own alerts"
  ON trader_alerts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own alerts"
  ON trader_alerts FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own alerts"
  ON trader_alerts FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- 3. 提醒日志表（记录已发送的提醒）
-- ============================================
CREATE TABLE IF NOT EXISTS trader_alert_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id UUID NOT NULL REFERENCES trader_alerts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id TEXT NOT NULL,
  alert_type TEXT NOT NULL, -- 'roi_change', 'drawdown', 'pnl_change', 'score_change'
  old_value DECIMAL,
  new_value DECIMAL,
  change_percent DECIMAL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_alert_logs_user ON trader_alert_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_alert_logs_alert ON trader_alert_logs(alert_id);
CREATE INDEX IF NOT EXISTS idx_alert_logs_created ON trader_alert_logs(created_at DESC);

-- RLS 策略
ALTER TABLE trader_alert_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own alert logs" ON trader_alert_logs;

CREATE POLICY "Users can view their own alert logs"
  ON trader_alert_logs FOR SELECT
  USING (auth.uid() = user_id);

-- ============================================
-- 4. 更新 updated_at 触发器
-- ============================================
CREATE OR REPLACE FUNCTION update_trader_alerts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_trader_alerts_updated_at ON trader_alerts;

CREATE TRIGGER trigger_update_trader_alerts_updated_at
  BEFORE UPDATE ON trader_alerts
  FOR EACH ROW
  EXECUTE FUNCTION update_trader_alerts_updated_at();

-- ============================================
-- 5. 更新 notifications 表的 type 检查约束
-- 添加 'trader_alert' 类型
-- ============================================
DO $$
BEGIN
  -- 删除旧约束
  ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  
  -- 添加新约束，包含 'trader_alert' 类型
  ALTER TABLE notifications ADD CONSTRAINT notifications_type_check 
    CHECK (type IN ('follow', 'like', 'comment', 'system', 'mention', 'message', 'trader_alert'));
EXCEPTION
  WHEN others THEN
    RAISE NOTICE 'Could not update notifications type constraint: %', SQLERRM;
END $$;

-- ============================================
-- 6. 创建函数：检测交易员变动并发送提醒
-- ============================================
CREATE OR REPLACE FUNCTION check_trader_changes_and_alert(
  p_trader_id TEXT,
  p_source TEXT,
  p_current_roi DECIMAL,
  p_current_drawdown DECIMAL,
  p_current_pnl DECIMAL,
  p_current_score DECIMAL
)
RETURNS INTEGER AS $$
DECLARE
  v_alert RECORD;
  v_prev_snapshot RECORD;
  v_alerts_sent INTEGER := 0;
  v_change DECIMAL;
  v_message TEXT;
  v_user_handle TEXT;
BEGIN
  -- 获取前一天的快照
  SELECT * INTO v_prev_snapshot
  FROM trader_snapshots
  WHERE trader_id = p_trader_id 
    AND source = p_source 
    AND snapshot_date < CURRENT_DATE
  ORDER BY snapshot_date DESC
  LIMIT 1;
  
  -- 如果没有历史快照，无法比较
  IF v_prev_snapshot IS NULL THEN
    RETURN 0;
  END IF;
  
  -- 遍历所有启用的提醒配置
  FOR v_alert IN 
    SELECT ta.*, up.handle as user_handle
    FROM trader_alerts ta
    LEFT JOIN user_profiles up ON up.id = ta.user_id
    WHERE ta.trader_id = p_trader_id 
      AND ta.enabled = true
  LOOP
    -- 检查 ROI 变动
    IF v_alert.alert_roi_change AND v_prev_snapshot.roi_90d IS NOT NULL AND p_current_roi IS NOT NULL THEN
      v_change := ABS(p_current_roi - v_prev_snapshot.roi_90d);
      IF v_change >= v_alert.roi_change_threshold THEN
        v_message := '交易员 ' || p_trader_id || ' ROI 变动 ' || 
          CASE WHEN p_current_roi > v_prev_snapshot.roi_90d THEN '+' ELSE '' END ||
          ROUND(p_current_roi - v_prev_snapshot.roi_90d, 2)::TEXT || '%';
        
        -- 记录提醒日志
        INSERT INTO trader_alert_logs (alert_id, user_id, trader_id, alert_type, old_value, new_value, change_percent, message)
        VALUES (v_alert.id, v_alert.user_id, p_trader_id, 'roi_change', v_prev_snapshot.roi_90d, p_current_roi, v_change, v_message);
        
        -- 创建通知
        INSERT INTO notifications (user_id, type, title, message, link)
        VALUES (v_alert.user_id, 'trader_alert', '交易员变动提醒', v_message, '/trader/' || p_trader_id);
        
        -- 更新上次提醒时间
        UPDATE trader_alerts SET last_alert_at = NOW() WHERE id = v_alert.id;
        
        v_alerts_sent := v_alerts_sent + 1;
      END IF;
    END IF;
    
    -- 检查回撤
    IF v_alert.alert_drawdown AND p_current_drawdown IS NOT NULL THEN
      IF ABS(p_current_drawdown) >= v_alert.drawdown_threshold THEN
        v_message := '交易员 ' || p_trader_id || ' 最大回撤达到 ' || ROUND(ABS(p_current_drawdown), 2)::TEXT || '%';
        
        INSERT INTO trader_alert_logs (alert_id, user_id, trader_id, alert_type, old_value, new_value, message)
        VALUES (v_alert.id, v_alert.user_id, p_trader_id, 'drawdown', v_prev_snapshot.max_drawdown, p_current_drawdown, v_message);
        
        INSERT INTO notifications (user_id, type, title, message, link)
        VALUES (v_alert.user_id, 'trader_alert', '回撤预警', v_message, '/trader/' || p_trader_id);
        
        UPDATE trader_alerts SET last_alert_at = NOW() WHERE id = v_alert.id;
        
        v_alerts_sent := v_alerts_sent + 1;
      END IF;
    END IF;
    
    -- 检查 Score 变动
    IF v_alert.alert_score_change AND v_prev_snapshot.arena_score IS NOT NULL AND p_current_score IS NOT NULL THEN
      v_change := ABS(p_current_score - v_prev_snapshot.arena_score);
      IF v_change >= v_alert.score_change_threshold THEN
        v_message := '交易员 ' || p_trader_id || ' Arena Score 变动 ' || 
          CASE WHEN p_current_score > v_prev_snapshot.arena_score THEN '+' ELSE '' END ||
          ROUND(p_current_score - v_prev_snapshot.arena_score, 1)::TEXT;
        
        INSERT INTO trader_alert_logs (alert_id, user_id, trader_id, alert_type, old_value, new_value, change_percent, message)
        VALUES (v_alert.id, v_alert.user_id, p_trader_id, 'score_change', v_prev_snapshot.arena_score, p_current_score, v_change, v_message);
        
        INSERT INTO notifications (user_id, type, title, message, link)
        VALUES (v_alert.user_id, 'trader_alert', 'Arena Score 变动', v_message, '/trader/' || p_trader_id);
        
        UPDATE trader_alerts SET last_alert_at = NOW() WHERE id = v_alert.id;
        
        v_alerts_sent := v_alerts_sent + 1;
      END IF;
    END IF;
  END LOOP;
  
  RETURN v_alerts_sent;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 7. 创建视图：用户的提醒配置汇总
-- ============================================
CREATE OR REPLACE VIEW user_trader_alerts_summary AS
SELECT 
  ta.user_id,
  COUNT(*) as total_alerts,
  COUNT(*) FILTER (WHERE ta.enabled) as enabled_alerts,
  MAX(ta.updated_at) as last_updated
FROM trader_alerts ta
GROUP BY ta.user_id;

-- ============================================
-- 8. 清理旧快照的函数（保留最近30天）
-- ============================================
CREATE OR REPLACE FUNCTION cleanup_old_trader_snapshots()
RETURNS INTEGER AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM trader_snapshots
  WHERE snapshot_date < CURRENT_DATE - INTERVAL '30 days';
  
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 完成
-- ============================================
-- 运行此脚本后，交易员变动提醒系统的数据库结构配置完成
-- 功能说明：
-- 1. trader_snapshots: 每日保存交易员数据快照，用于比较变动
-- 2. trader_alerts: 用户的提醒配置（ROI变动、回撤、PnL、Score）
-- 3. trader_alert_logs: 已发送提醒的日志记录
-- 4. check_trader_changes_and_alert: 检测变动并自动发送提醒的函数
