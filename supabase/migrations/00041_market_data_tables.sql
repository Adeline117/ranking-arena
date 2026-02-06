-- Phase 1: Market Data Tables
-- Creates tables for market benchmarks, funding rates, open interest, and liquidations

-- Market benchmarks (BTC/ETH daily prices for correlation calculation)
CREATE TABLE IF NOT EXISTS market_benchmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  date DATE NOT NULL,
  open_price DECIMAL(20, 8),
  high_price DECIMAL(20, 8),
  low_price DECIMAL(20, 8),
  close_price DECIMAL(20, 8) NOT NULL,
  volume DECIMAL(30, 8),
  daily_return_pct DECIMAL(10, 6),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(symbol, date)
);

-- Indexes for market_benchmarks
CREATE INDEX IF NOT EXISTS idx_market_benchmarks_symbol_date
  ON market_benchmarks(symbol, date DESC);

CREATE INDEX IF NOT EXISTS idx_market_benchmarks_date
  ON market_benchmarks(date DESC);

-- Funding rates (for futures/perps market sentiment)
CREATE TABLE IF NOT EXISTS funding_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  symbol TEXT NOT NULL,
  funding_rate DECIMAL(12, 8) NOT NULL,
  funding_time TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(platform, symbol, funding_time)
);

-- Indexes for funding_rates
CREATE INDEX IF NOT EXISTS idx_funding_rates_platform_symbol
  ON funding_rates(platform, symbol, funding_time DESC);

CREATE INDEX IF NOT EXISTS idx_funding_rates_time
  ON funding_rates(funding_time DESC);

-- Open interest (market depth indicator)
CREATE TABLE IF NOT EXISTS open_interest (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  symbol TEXT NOT NULL,
  open_interest_usd DECIMAL(20, 2) NOT NULL,
  open_interest_contracts DECIMAL(20, 8),
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(platform, symbol, timestamp)
);

-- Indexes for open_interest
CREATE INDEX IF NOT EXISTS idx_open_interest_platform_symbol
  ON open_interest(platform, symbol, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_open_interest_timestamp
  ON open_interest(timestamp DESC);

-- Liquidations (market volatility/sentiment indicator)
CREATE TABLE IF NOT EXISTS liquidations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  value_usd DECIMAL(20, 2) NOT NULL,
  quantity DECIMAL(20, 8),
  price DECIMAL(20, 8),
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for liquidations
CREATE INDEX IF NOT EXISTS idx_liquidations_platform_symbol
  ON liquidations(platform, symbol, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_liquidations_timestamp
  ON liquidations(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_liquidations_side_timestamp
  ON liquidations(side, timestamp DESC);

-- Aggregated liquidation stats (hourly rollup for performance)
CREATE TABLE IF NOT EXISTS liquidation_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  symbol TEXT NOT NULL,
  hour_bucket TIMESTAMPTZ NOT NULL,
  long_liquidations_usd DECIMAL(20, 2) DEFAULT 0,
  short_liquidations_usd DECIMAL(20, 2) DEFAULT 0,
  long_count INTEGER DEFAULT 0,
  short_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(platform, symbol, hour_bucket)
);

CREATE INDEX IF NOT EXISTS idx_liquidation_stats_platform_symbol
  ON liquidation_stats(platform, symbol, hour_bucket DESC);

-- Market conditions (derived from price action)
CREATE TABLE IF NOT EXISTS market_conditions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  date DATE NOT NULL,
  condition TEXT NOT NULL CHECK (condition IN ('bull', 'bear', 'sideways')),
  volatility_regime TEXT CHECK (volatility_regime IN ('low', 'medium', 'high', 'extreme')),
  trend_strength DECIMAL(5, 2),
  rsi_14 DECIMAL(5, 2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(symbol, date)
);

CREATE INDEX IF NOT EXISTS idx_market_conditions_symbol_date
  ON market_conditions(symbol, date DESC);

-- Comments
COMMENT ON TABLE market_benchmarks IS 'Daily OHLCV data for BTC/ETH used in correlation calculations';
COMMENT ON TABLE funding_rates IS 'Perpetual futures funding rates by platform and symbol';
COMMENT ON TABLE open_interest IS 'Open interest data by platform and symbol';
COMMENT ON TABLE liquidations IS 'Individual liquidation events';
COMMENT ON TABLE liquidation_stats IS 'Hourly aggregated liquidation statistics';
COMMENT ON TABLE market_conditions IS 'Derived market condition classifications';
