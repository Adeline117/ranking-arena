-- Anomaly Detection System
-- Version: 1.0.0
-- Created: 2026-01-28
-- Description: Stores anomaly detection results for trader data quality monitoring

-- ============================================
-- 1. Anomaly Records Table
-- ============================================

CREATE TABLE IF NOT EXISTS trader_anomalies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trader_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  anomaly_type TEXT NOT NULL,  -- 'statistical_outlier', 'data_inconsistency', 'suspicious_pattern', etc.
  field_name TEXT NOT NULL,     -- 'roi', 'win_rate', 'trades_count', 'pnl', 'max_drawdown'
  detected_value NUMERIC,
  expected_range_min NUMERIC,
  expected_range_max NUMERIC,
  z_score NUMERIC,              -- Z-Score if applicable
  severity TEXT NOT NULL,       -- 'low', 'medium', 'high', 'critical'
  status TEXT DEFAULT 'pending',-- 'pending', 'confirmed', 'false_positive', 'resolved'
  description TEXT,             -- Human-readable description
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  notes TEXT,                   -- Admin notes
  metadata JSONB,               -- Additional context
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Composite foreign key reference
-- Note: trader_id + platform should reference trader_sources, but we'll use a loose reference for flexibility
COMMENT ON COLUMN trader_anomalies.trader_id IS 'References trader_sources.source_trader_id';
COMMENT ON COLUMN trader_anomalies.platform IS 'References trader_sources.source';

-- ============================================
-- 2. Indexes for Performance
-- ============================================

-- Query by trader
CREATE INDEX idx_trader_anomalies_trader ON trader_anomalies(trader_id, platform);

-- Query by status (for pending anomalies)
CREATE INDEX idx_trader_anomalies_status ON trader_anomalies(status) WHERE status = 'pending';

-- Query by severity (for critical anomalies)
CREATE INDEX idx_trader_anomalies_severity ON trader_anomalies(severity) WHERE severity IN ('high', 'critical');

-- Query by detection time (for recent anomalies)
CREATE INDEX idx_trader_anomalies_detected_at ON trader_anomalies(detected_at DESC);

-- Composite index for admin dashboard
CREATE INDEX idx_trader_anomalies_status_severity ON trader_anomalies(status, severity, detected_at DESC);

-- ============================================
-- 3. Statistics View
-- ============================================

CREATE OR REPLACE VIEW trader_anomaly_stats AS
SELECT
  trader_id,
  platform,
  COUNT(*) as total_anomalies,
  COUNT(*) FILTER (WHERE severity = 'critical') as critical_count,
  COUNT(*) FILTER (WHERE severity = 'high') as high_count,
  COUNT(*) FILTER (WHERE severity = 'medium') as medium_count,
  COUNT(*) FILTER (WHERE severity = 'low') as low_count,
  COUNT(*) FILTER (WHERE status = 'confirmed') as confirmed_count,
  COUNT(*) FILTER (WHERE status = 'false_positive') as false_positive_count,
  COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
  MAX(detected_at) as latest_detection,
  MIN(detected_at) as first_detection
FROM trader_anomalies
GROUP BY trader_id, platform;

COMMENT ON VIEW trader_anomaly_stats IS 'Aggregated anomaly statistics per trader';

-- ============================================
-- 4. Platform-wide Statistics View
-- ============================================

CREATE OR REPLACE VIEW platform_anomaly_stats AS
SELECT
  platform,
  COUNT(DISTINCT trader_id) as affected_traders,
  COUNT(*) as total_anomalies,
  COUNT(*) FILTER (WHERE severity = 'critical') as critical_count,
  COUNT(*) FILTER (WHERE severity = 'high') as high_count,
  COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
  COUNT(*) FILTER (WHERE detected_at > NOW() - INTERVAL '24 hours') as last_24h_count,
  COUNT(*) FILTER (WHERE detected_at > NOW() - INTERVAL '7 days') as last_7d_count,
  MAX(detected_at) as latest_detection
FROM trader_anomalies
GROUP BY platform;

COMMENT ON VIEW platform_anomaly_stats IS 'Platform-wide anomaly statistics';

-- ============================================
-- 5. Update Trigger
-- ============================================

CREATE OR REPLACE FUNCTION update_trader_anomaly_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();

  -- Auto-set resolved_at when status changes to resolved/false_positive
  IF NEW.status IN ('resolved', 'false_positive') AND OLD.status NOT IN ('resolved', 'false_positive') THEN
    NEW.resolved_at = NOW();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_trader_anomaly_timestamp
  BEFORE UPDATE ON trader_anomalies
  FOR EACH ROW
  EXECUTE FUNCTION update_trader_anomaly_timestamp();

-- ============================================
-- 6. RLS Policies
-- ============================================

ALTER TABLE trader_anomalies ENABLE ROW LEVEL SECURITY;

-- Public can view confirmed anomalies (for transparency)
CREATE POLICY "Confirmed anomalies are viewable by everyone"
  ON trader_anomalies FOR SELECT
  USING (status = 'confirmed');

-- Admins can view all anomalies
CREATE POLICY "Admins can view all anomalies"
  ON trader_anomalies FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.is_admin = true
    )
  );

-- Admins can insert anomalies (system-generated)
CREATE POLICY "Admins can insert anomalies"
  ON trader_anomalies FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.is_admin = true
    )
  );

-- Admins can update anomalies
CREATE POLICY "Admins can update anomalies"
  ON trader_anomalies FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.is_admin = true
    )
  );

-- Service role can do everything (for cron jobs)
CREATE POLICY "Service role can manage anomalies"
  ON trader_anomalies FOR ALL
  USING (auth.jwt()->>'role' = 'service_role');

-- ============================================
-- 7. Helper Functions
-- ============================================

-- Get pending critical anomalies count
CREATE OR REPLACE FUNCTION get_pending_critical_anomalies_count()
RETURNS INTEGER AS $$
  SELECT COUNT(*)::INTEGER
  FROM trader_anomalies
  WHERE status = 'pending'
  AND severity IN ('critical', 'high');
$$ LANGUAGE SQL STABLE;

COMMENT ON FUNCTION get_pending_critical_anomalies_count IS 'Returns count of pending critical/high severity anomalies';

-- Mark trader as suspicious based on anomalies
CREATE OR REPLACE FUNCTION check_trader_suspicion(p_trader_id TEXT, p_platform TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  critical_count INTEGER;
  high_count INTEGER;
BEGIN
  -- Count critical and high severity anomalies
  SELECT
    COUNT(*) FILTER (WHERE severity = 'critical'),
    COUNT(*) FILTER (WHERE severity = 'high')
  INTO critical_count, high_count
  FROM trader_anomalies
  WHERE trader_id = p_trader_id
  AND platform = p_platform
  AND status IN ('pending', 'confirmed');

  -- Suspicious if: 1+ critical OR 3+ high severity
  RETURN critical_count > 0 OR high_count >= 3;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION check_trader_suspicion IS 'Checks if trader should be marked as suspicious based on anomaly count';

-- ============================================
-- 8. Initial Data & Comments
-- ============================================

COMMENT ON TABLE trader_anomalies IS 'Stores detected anomalies in trader data for quality monitoring and fraud detection';
COMMENT ON COLUMN trader_anomalies.anomaly_type IS 'Type of anomaly: statistical_outlier, data_inconsistency, suspicious_pattern, time_series_anomaly, behavioral_anomaly';
COMMENT ON COLUMN trader_anomalies.severity IS 'Severity level: low (1-2 std), medium (2-3 std), high (3-4 std), critical (>4 std or major inconsistency)';
COMMENT ON COLUMN trader_anomalies.status IS 'Current status: pending (needs review), confirmed (real issue), false_positive (not an issue), resolved (fixed)';
COMMENT ON COLUMN trader_anomalies.metadata IS 'Additional context: sample_size, confidence, related_anomalies, etc.';
