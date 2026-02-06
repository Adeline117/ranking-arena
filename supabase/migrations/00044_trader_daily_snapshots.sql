-- Create trader daily snapshots table for historical data aggregation
-- This table stores end-of-day snapshots of trader performance metrics

CREATE TABLE trader_daily_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  trader_key TEXT NOT NULL,
  date DATE NOT NULL,
  roi DECIMAL(12, 4),
  pnl DECIMAL(18, 2),
  daily_return_pct DECIMAL(10, 6),
  win_rate DECIMAL(5, 2),
  max_drawdown DECIMAL(5, 2),
  followers INTEGER,
  trades_count INTEGER,
  cumulative_pnl DECIMAL(20, 2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(platform, trader_key, date)
);

-- Index for efficient queries by trader and date
CREATE INDEX idx_daily_snapshots_trader_date
  ON trader_daily_snapshots(platform, trader_key, date DESC);

-- Index for date-based queries
CREATE INDEX idx_daily_snapshots_date
  ON trader_daily_snapshots(date DESC);

-- Add metrics quality fields to trader_snapshots table
ALTER TABLE trader_snapshots
  ADD COLUMN IF NOT EXISTS metrics_quality TEXT CHECK (metrics_quality IN ('high', 'medium', 'low', 'insufficient')),
  ADD COLUMN IF NOT EXISTS metrics_data_points INTEGER;

-- Comment on the tables and columns
COMMENT ON TABLE trader_daily_snapshots IS 'Daily end-of-day snapshots of trader performance metrics for historical analysis and advanced metrics calculation';
COMMENT ON COLUMN trader_snapshots.metrics_quality IS 'Quality indicator for metrics based on data availability: high (>90% data), medium (50-90%), low (10-50%), insufficient (<10%)';
COMMENT ON COLUMN trader_snapshots.metrics_data_points IS 'Number of data points used for metrics calculation';
