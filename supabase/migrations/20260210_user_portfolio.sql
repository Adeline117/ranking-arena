-- User Portfolio Tracking Tables
-- Stores exchange API connections, positions, and equity snapshots

-- 1. User Portfolios (exchange API connections)
CREATE TABLE IF NOT EXISTS user_portfolios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  api_secret_encrypted TEXT NOT NULL,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, exchange, label)
);

CREATE INDEX idx_user_portfolios_user_id ON user_portfolios(user_id);

-- 2. User Positions (current holdings)
CREATE TABLE IF NOT EXISTS user_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES user_portfolios(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  entry_price NUMERIC NOT NULL DEFAULT 0,
  mark_price NUMERIC NOT NULL DEFAULT 0,
  size NUMERIC NOT NULL DEFAULT 0,
  pnl NUMERIC NOT NULL DEFAULT 0,
  pnl_pct NUMERIC NOT NULL DEFAULT 0,
  leverage NUMERIC NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(portfolio_id, symbol, side)
);

CREATE INDEX idx_user_positions_portfolio_id ON user_positions(portfolio_id);

-- 3. Portfolio Snapshots (historical equity tracking)
CREATE TABLE IF NOT EXISTS user_portfolio_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES user_portfolios(id) ON DELETE CASCADE,
  total_equity NUMERIC NOT NULL DEFAULT 0,
  total_pnl NUMERIC NOT NULL DEFAULT 0,
  total_pnl_pct NUMERIC NOT NULL DEFAULT 0,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_portfolio_snapshots_portfolio_id ON user_portfolio_snapshots(portfolio_id);
CREATE INDEX idx_user_portfolio_snapshots_time ON user_portfolio_snapshots(portfolio_id, snapshot_at DESC);

-- RLS Policies
ALTER TABLE user_portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_portfolio_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own portfolios"
  ON user_portfolios FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view own positions"
  ON user_positions FOR ALL
  USING (portfolio_id IN (SELECT id FROM user_portfolios WHERE user_id = auth.uid()))
  WITH CHECK (portfolio_id IN (SELECT id FROM user_portfolios WHERE user_id = auth.uid()));

CREATE POLICY "Users can view own snapshots"
  ON user_portfolio_snapshots FOR ALL
  USING (portfolio_id IN (SELECT id FROM user_portfolios WHERE user_id = auth.uid()))
  WITH CHECK (portfolio_id IN (SELECT id FROM user_portfolios WHERE user_id = auth.uid()));
