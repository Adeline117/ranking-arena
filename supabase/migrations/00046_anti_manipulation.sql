-- Anti-Manipulation Detection and Tracking System
-- Stores alerts and trader flags for suspicious trading activity

-- ============================================
-- Manipulation Alerts Table
-- ============================================

CREATE TABLE IF NOT EXISTS manipulation_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type TEXT NOT NULL CHECK (alert_type IN (
    'SAME_MS_TRADES',           -- Trades at exact same millisecond
    'WASH_TRADING',             -- Self-trading patterns
    'COORDINATED_TRADES',       -- Multiple accounts trading together
    'ABNORMAL_WIN_RATE',        -- Win rate too high (>95%)
    'RELATED_ACCOUNTS',         -- Linked accounts suspicious activity
    'IP_CLUSTER',               -- Multiple accounts from same IP
    'VOLUME_MANIPULATION',      -- Fake volume
    'STOP_HUNT',                -- Stop hunting patterns
    'PRICE_MANIPULATION'        -- Pump and dump patterns
  )),
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  traders TEXT[] NOT NULL,     -- Array of trader IDs involved (format: platform:trader_id)
  evidence JSONB NOT NULL,      -- Detailed evidence data
  auto_action TEXT CHECK (auto_action IN ('flag', 'suspend', 'ban', 'none')),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'investigating', 'resolved', 'false_positive')),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES auth.users(id),
  resolution_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX idx_manipulation_alerts_type ON manipulation_alerts(alert_type);
CREATE INDEX idx_manipulation_alerts_severity ON manipulation_alerts(severity);
CREATE INDEX idx_manipulation_alerts_status ON manipulation_alerts(status);
CREATE INDEX idx_manipulation_alerts_created ON manipulation_alerts(created_at DESC);
CREATE INDEX idx_manipulation_alerts_traders ON manipulation_alerts USING GIN(traders);

-- ============================================
-- Trader Flags Table
-- ============================================

CREATE TABLE IF NOT EXISTS trader_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  trader_key TEXT NOT NULL,
  flag_status TEXT NOT NULL CHECK (flag_status IN ('flagged', 'suspended', 'banned', 'cleared')),
  reason TEXT NOT NULL,
  alert_id UUID REFERENCES manipulation_alerts(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,        -- Auto-clear date for temporary flags
  notes TEXT,
  flagged_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(platform, trader_key, flag_status, alert_id)
);

-- Indexes
CREATE INDEX idx_trader_flags_trader ON trader_flags(platform, trader_key);
CREATE INDEX idx_trader_flags_status ON trader_flags(flag_status);
CREATE INDEX idx_trader_flags_alert ON trader_flags(alert_id);
CREATE INDEX idx_trader_flags_expires ON trader_flags(expires_at) WHERE expires_at IS NOT NULL;

-- ============================================
-- Alert History Table (for audit trail)
-- ============================================

CREATE TABLE IF NOT EXISTS manipulation_alert_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id UUID NOT NULL REFERENCES manipulation_alerts(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'resolved', 'escalated', 'dismissed')),
  performed_by UUID REFERENCES auth.users(id),
  old_status TEXT,
  new_status TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_alert_history_alert ON manipulation_alert_history(alert_id, created_at DESC);

-- ============================================
-- Views for Easy Querying
-- ============================================

-- Active suspicious traders
CREATE OR REPLACE VIEW v_suspicious_traders AS
SELECT DISTINCT
  tf.platform,
  tf.trader_key,
  tf.flag_status,
  array_agg(DISTINCT ma.alert_type) as alert_types,
  max(ma.severity) as max_severity,
  count(DISTINCT ma.id) as alert_count,
  max(tf.created_at) as last_flagged_at
FROM trader_flags tf
JOIN manipulation_alerts ma ON ma.id = tf.alert_id
WHERE tf.flag_status IN ('flagged', 'suspended', 'banned')
  AND ma.status = 'active'
GROUP BY tf.platform, tf.trader_key, tf.flag_status;

-- Recent alerts summary
CREATE OR REPLACE VIEW v_recent_alerts AS
SELECT
  ma.id,
  ma.alert_type,
  ma.severity,
  ma.status,
  ma.traders,
  cardinality(ma.traders) as trader_count,
  ma.auto_action,
  ma.created_at,
  ma.updated_at,
  count(tf.id) as flagged_traders
FROM manipulation_alerts ma
LEFT JOIN trader_flags tf ON tf.alert_id = ma.id
WHERE ma.created_at > NOW() - INTERVAL '30 days'
GROUP BY ma.id
ORDER BY ma.created_at DESC;

-- ============================================
-- Functions
-- ============================================

-- Auto-expire temporary flags
CREATE OR REPLACE FUNCTION expire_trader_flags()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE trader_flags
  SET flag_status = 'cleared',
      updated_at = NOW()
  WHERE expires_at IS NOT NULL
    AND expires_at < NOW()
    AND flag_status IN ('flagged', 'suspended');
END;
$$;

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_manipulation_alerts_updated_at
  BEFORE UPDATE ON manipulation_alerts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_trader_flags_updated_at
  BEFORE UPDATE ON trader_flags
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- Row Level Security (RLS)
-- ============================================

ALTER TABLE manipulation_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE trader_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE manipulation_alert_history ENABLE ROW LEVEL SECURITY;

-- Admin-only access
CREATE POLICY "Admins can view all alerts"
  ON manipulation_alerts FOR SELECT
  TO authenticated
  USING (auth.jwt() ->> 'role' = 'admin');

CREATE POLICY "Admins can manage alerts"
  ON manipulation_alerts FOR ALL
  TO authenticated
  USING (auth.jwt() ->> 'role' = 'admin');

CREATE POLICY "Admins can view all flags"
  ON trader_flags FOR SELECT
  TO authenticated
  USING (auth.jwt() ->> 'role' = 'admin');

CREATE POLICY "Admins can manage flags"
  ON trader_flags FOR ALL
  TO authenticated
  USING (auth.jwt() ->> 'role' = 'admin');

CREATE POLICY "Admins can view alert history"
  ON manipulation_alert_history FOR SELECT
  TO authenticated
  USING (auth.jwt() ->> 'role' = 'admin');

-- Service role (cron jobs) can insert
CREATE POLICY "Service can insert alerts"
  ON manipulation_alerts FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "Service can insert flags"
  ON trader_flags FOR INSERT
  TO service_role
  WITH CHECK (true);

-- ============================================
-- Comments
-- ============================================

COMMENT ON TABLE manipulation_alerts IS 'Stores alerts for detected suspicious trading patterns';
COMMENT ON TABLE trader_flags IS 'Tracks flagged traders and their current status';
COMMENT ON TABLE manipulation_alert_history IS 'Audit trail for all alert status changes';
COMMENT ON VIEW v_suspicious_traders IS 'Active suspicious traders with aggregated alert data';
COMMENT ON VIEW v_recent_alerts IS 'Recent alerts with summary statistics';
