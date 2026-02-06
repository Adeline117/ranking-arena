-- Phase 1: Real-time Positions Table
-- Creates table for live position tracking with Supabase Realtime support

-- Live positions table
CREATE TABLE IF NOT EXISTS trader_positions_live (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  market_type TEXT NOT NULL DEFAULT 'futures',
  trader_key TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  entry_price DECIMAL(20, 8) NOT NULL,
  current_price DECIMAL(20, 8),
  mark_price DECIMAL(20, 8),
  quantity DECIMAL(20, 8) NOT NULL,
  leverage DECIMAL(6, 2) DEFAULT 1,
  margin DECIMAL(20, 2),
  unrealized_pnl DECIMAL(20, 2),
  unrealized_pnl_pct DECIMAL(10, 4),
  liquidation_price DECIMAL(20, 8),
  opened_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- Composite unique constraint
  UNIQUE(platform, trader_key, symbol, side)
);

-- Enable Supabase Realtime for this table
ALTER TABLE trader_positions_live REPLICA IDENTITY FULL;

-- Position history (closed positions)
CREATE TABLE IF NOT EXISTS trader_positions_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  market_type TEXT NOT NULL DEFAULT 'futures',
  trader_key TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  entry_price DECIMAL(20, 8) NOT NULL,
  exit_price DECIMAL(20, 8) NOT NULL,
  quantity DECIMAL(20, 8) NOT NULL,
  leverage DECIMAL(6, 2) DEFAULT 1,
  realized_pnl DECIMAL(20, 2),
  realized_pnl_pct DECIMAL(10, 4),
  fees DECIMAL(20, 8),
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ NOT NULL,
  holding_hours DECIMAL(10, 2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for live positions
CREATE INDEX IF NOT EXISTS idx_positions_live_platform_trader
  ON trader_positions_live(platform, trader_key);

CREATE INDEX IF NOT EXISTS idx_positions_live_trader_key
  ON trader_positions_live(trader_key);

CREATE INDEX IF NOT EXISTS idx_positions_live_symbol
  ON trader_positions_live(symbol);

CREATE INDEX IF NOT EXISTS idx_positions_live_updated
  ON trader_positions_live(updated_at DESC);

-- Indexes for position history
CREATE INDEX IF NOT EXISTS idx_positions_history_platform_trader
  ON trader_positions_history(platform, trader_key, closed_at DESC);

CREATE INDEX IF NOT EXISTS idx_positions_history_trader_key
  ON trader_positions_history(trader_key, closed_at DESC);

CREATE INDEX IF NOT EXISTS idx_positions_history_closed
  ON trader_positions_history(closed_at DESC);

-- Trader position summary (aggregated view)
CREATE TABLE IF NOT EXISTS trader_position_summary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  trader_key TEXT NOT NULL,
  total_positions INTEGER DEFAULT 0,
  long_positions INTEGER DEFAULT 0,
  short_positions INTEGER DEFAULT 0,
  total_margin_usd DECIMAL(20, 2) DEFAULT 0,
  total_unrealized_pnl DECIMAL(20, 2) DEFAULT 0,
  avg_leverage DECIMAL(6, 2),
  largest_position_symbol TEXT,
  largest_position_value DECIMAL(20, 2),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(platform, trader_key)
);

CREATE INDEX IF NOT EXISTS idx_position_summary_platform_trader
  ON trader_position_summary(platform, trader_key);

-- Function to update position summary on position changes
CREATE OR REPLACE FUNCTION update_position_summary()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO trader_position_summary (platform, trader_key, total_positions, long_positions, short_positions, total_margin_usd, total_unrealized_pnl, updated_at)
  SELECT
    NEW.platform,
    NEW.trader_key,
    COUNT(*),
    COUNT(*) FILTER (WHERE side = 'long'),
    COUNT(*) FILTER (WHERE side = 'short'),
    COALESCE(SUM(margin), 0),
    COALESCE(SUM(unrealized_pnl), 0),
    NOW()
  FROM trader_positions_live
  WHERE platform = NEW.platform AND trader_key = NEW.trader_key
  ON CONFLICT (platform, trader_key)
  DO UPDATE SET
    total_positions = EXCLUDED.total_positions,
    long_positions = EXCLUDED.long_positions,
    short_positions = EXCLUDED.short_positions,
    total_margin_usd = EXCLUDED.total_margin_usd,
    total_unrealized_pnl = EXCLUDED.total_unrealized_pnl,
    updated_at = NOW();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update summary
DROP TRIGGER IF EXISTS trigger_update_position_summary ON trader_positions_live;
CREATE TRIGGER trigger_update_position_summary
  AFTER INSERT OR UPDATE OR DELETE ON trader_positions_live
  FOR EACH ROW
  EXECUTE FUNCTION update_position_summary();

-- RLS Policies
ALTER TABLE trader_positions_live ENABLE ROW LEVEL SECURITY;
ALTER TABLE trader_positions_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE trader_position_summary ENABLE ROW LEVEL SECURITY;

-- Public read access for positions
CREATE POLICY "Public read access for live positions"
  ON trader_positions_live FOR SELECT
  USING (true);

CREATE POLICY "Public read access for position history"
  ON trader_positions_history FOR SELECT
  USING (true);

CREATE POLICY "Public read access for position summary"
  ON trader_position_summary FOR SELECT
  USING (true);

-- Comments
COMMENT ON TABLE trader_positions_live IS 'Real-time open positions for traders, enabled for Supabase Realtime';
COMMENT ON TABLE trader_positions_history IS 'Historical closed positions for trade analysis';
COMMENT ON TABLE trader_position_summary IS 'Aggregated position summary per trader';
