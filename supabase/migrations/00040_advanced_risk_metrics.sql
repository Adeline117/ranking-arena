-- Phase 1: Advanced Risk Metrics
-- Adds advanced trading metrics to trader_snapshots table

-- Risk Metrics
ALTER TABLE trader_snapshots
  ADD COLUMN IF NOT EXISTS sortino_ratio DECIMAL(10, 4),
  ADD COLUMN IF NOT EXISTS calmar_ratio DECIMAL(10, 4),
  ADD COLUMN IF NOT EXISTS profit_factor DECIMAL(10, 4),
  ADD COLUMN IF NOT EXISTS recovery_factor DECIMAL(10, 4),
  ADD COLUMN IF NOT EXISTS max_consecutive_wins INTEGER,
  ADD COLUMN IF NOT EXISTS max_consecutive_losses INTEGER,
  ADD COLUMN IF NOT EXISTS avg_holding_hours DECIMAL(10, 2),
  ADD COLUMN IF NOT EXISTS volatility_pct DECIMAL(8, 4),
  ADD COLUMN IF NOT EXISTS downside_volatility_pct DECIMAL(8, 4);

-- Market Correlation
ALTER TABLE trader_snapshots
  ADD COLUMN IF NOT EXISTS beta_btc DECIMAL(8, 4),
  ADD COLUMN IF NOT EXISTS beta_eth DECIMAL(8, 4),
  ADD COLUMN IF NOT EXISTS alpha DECIMAL(10, 4),
  ADD COLUMN IF NOT EXISTS market_condition_tags JSONB DEFAULT '[]'::jsonb;

-- Trading Style Classification
ALTER TABLE trader_snapshots
  ADD COLUMN IF NOT EXISTS trading_style TEXT CHECK (trading_style IN ('hft', 'day_trader', 'swing', 'trend', 'scalping')),
  ADD COLUMN IF NOT EXISTS asset_preference TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS style_confidence DECIMAL(5, 2);

-- Arena Score V3 Components
ALTER TABLE trader_snapshots
  ADD COLUMN IF NOT EXISTS pnl_score DECIMAL(6, 2),
  ADD COLUMN IF NOT EXISTS alpha_score DECIMAL(6, 2),
  ADD COLUMN IF NOT EXISTS consistency_score DECIMAL(6, 2),
  ADD COLUMN IF NOT EXISTS risk_adjusted_score_v3 DECIMAL(6, 2),
  ADD COLUMN IF NOT EXISTS arena_score_v3 DECIMAL(6, 2);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_sortino_ratio
  ON trader_snapshots(sortino_ratio DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_trader_snapshots_calmar_ratio
  ON trader_snapshots(calmar_ratio DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_trader_snapshots_alpha
  ON trader_snapshots(alpha DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_trader_snapshots_trading_style
  ON trader_snapshots(trading_style) WHERE trading_style IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trader_snapshots_arena_score_v3
  ON trader_snapshots(arena_score_v3 DESC NULLS LAST);

-- Composite index for filtered sorting
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_style_score
  ON trader_snapshots(trading_style, arena_score_v3 DESC NULLS LAST)
  WHERE trading_style IS NOT NULL;

-- Comments
COMMENT ON COLUMN trader_snapshots.sortino_ratio IS 'Sortino ratio - downside risk-adjusted return';
COMMENT ON COLUMN trader_snapshots.calmar_ratio IS 'Calmar ratio - annualized ROI / max drawdown';
COMMENT ON COLUMN trader_snapshots.profit_factor IS 'Gross profit / gross loss';
COMMENT ON COLUMN trader_snapshots.recovery_factor IS 'Net profit / max drawdown';
COMMENT ON COLUMN trader_snapshots.max_consecutive_wins IS 'Maximum consecutive winning trades';
COMMENT ON COLUMN trader_snapshots.max_consecutive_losses IS 'Maximum consecutive losing trades';
COMMENT ON COLUMN trader_snapshots.avg_holding_hours IS 'Average position holding time in hours';
COMMENT ON COLUMN trader_snapshots.volatility_pct IS 'Return volatility (standard deviation)';
COMMENT ON COLUMN trader_snapshots.downside_volatility_pct IS 'Downside volatility for Sortino calculation';
COMMENT ON COLUMN trader_snapshots.beta_btc IS 'Correlation coefficient with BTC';
COMMENT ON COLUMN trader_snapshots.beta_eth IS 'Correlation coefficient with ETH';
COMMENT ON COLUMN trader_snapshots.alpha IS 'Excess return vs benchmark (Jensen alpha)';
COMMENT ON COLUMN trader_snapshots.market_condition_tags IS 'Performance tags by market condition (bull/bear/sideways)';
COMMENT ON COLUMN trader_snapshots.trading_style IS 'Classified trading style: hft, day_trader, swing, trend, scalping';
COMMENT ON COLUMN trader_snapshots.asset_preference IS 'Preferred trading assets (e.g., BTC, ETH, altcoins)';
COMMENT ON COLUMN trader_snapshots.style_confidence IS 'Confidence score for trading style classification (0-100)';
COMMENT ON COLUMN trader_snapshots.pnl_score IS 'Arena Score V3 PnL component (0-12)';
COMMENT ON COLUMN trader_snapshots.alpha_score IS 'Arena Score V3 alpha component (0-5)';
COMMENT ON COLUMN trader_snapshots.consistency_score IS 'Arena Score V3 consistency component (0-5)';
COMMENT ON COLUMN trader_snapshots.risk_adjusted_score_v3 IS 'Arena Score V3 risk-adjusted component (0-10)';
COMMENT ON COLUMN trader_snapshots.arena_score_v3 IS 'Arena Score V3 total (0-100)';
