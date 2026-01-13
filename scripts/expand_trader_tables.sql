-- 扩展交易员数据表结构
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- ============================================
-- 1. 扩展 trader_snapshots 表
-- ============================================

-- 添加多时间段ROI字段
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'trader_snapshots' AND column_name = 'roi_7d'
  ) THEN
    ALTER TABLE trader_snapshots ADD COLUMN roi_7d NUMERIC;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'trader_snapshots' AND column_name = 'roi_30d'
  ) THEN
    ALTER TABLE trader_snapshots ADD COLUMN roi_30d NUMERIC;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'trader_snapshots' AND column_name = 'roi_1y'
  ) THEN
    ALTER TABLE trader_snapshots ADD COLUMN roi_1y NUMERIC;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'trader_snapshots' AND column_name = 'roi_2y'
  ) THEN
    ALTER TABLE trader_snapshots ADD COLUMN roi_2y NUMERIC;
  END IF;
END $$;

-- 添加交易统计字段
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'trader_snapshots' AND column_name = 'total_trades'
  ) THEN
    ALTER TABLE trader_snapshots ADD COLUMN total_trades INTEGER;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'trader_snapshots' AND column_name = 'avg_profit'
  ) THEN
    ALTER TABLE trader_snapshots ADD COLUMN avg_profit NUMERIC;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'trader_snapshots' AND column_name = 'avg_loss'
  ) THEN
    ALTER TABLE trader_snapshots ADD COLUMN avg_loss NUMERIC;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'trader_snapshots' AND column_name = 'profitable_trades_pct'
  ) THEN
    ALTER TABLE trader_snapshots ADD COLUMN profitable_trades_pct NUMERIC;
  END IF;
END $$;

-- 添加风险和其他指标字段
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'trader_snapshots' AND column_name = 'risk_score'
  ) THEN
    ALTER TABLE trader_snapshots ADD COLUMN risk_score NUMERIC;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'trader_snapshots' AND column_name = 'avg_holding_time_days'
  ) THEN
    ALTER TABLE trader_snapshots ADD COLUMN avg_holding_time_days NUMERIC;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'trader_snapshots' AND column_name = 'trades_per_week'
  ) THEN
    ALTER TABLE trader_snapshots ADD COLUMN trades_per_week NUMERIC;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'trader_snapshots' AND column_name = 'volume_90d'
  ) THEN
    ALTER TABLE trader_snapshots ADD COLUMN volume_90d NUMERIC;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'trader_snapshots' AND column_name = 'max_drawdown'
  ) THEN
    ALTER TABLE trader_snapshots ADD COLUMN max_drawdown NUMERIC;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'trader_snapshots' AND column_name = 'sharpe_ratio'
  ) THEN
    ALTER TABLE trader_snapshots ADD COLUMN sharpe_ratio NUMERIC;
  END IF;
END $$;

-- ============================================
-- 2. 创建 trader_frequently_traded 表
-- ============================================
CREATE TABLE IF NOT EXISTS trader_frequently_traded (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  source_trader_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  weight_pct NUMERIC,
  trade_count INTEGER,
  avg_profit NUMERIC,
  avg_loss NUMERIC,
  profitable_pct NUMERIC,
  captured_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(source, source_trader_id, symbol, captured_at)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_trader_frequently_traded_source_trader 
  ON trader_frequently_traded(source, source_trader_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_trader_frequently_traded_captured_at 
  ON trader_frequently_traded(captured_at);

-- ============================================
-- 3. 创建 trader_portfolio 表
-- ============================================
CREATE TABLE IF NOT EXISTS trader_portfolio (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  source_trader_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT CHECK (direction IN ('long', 'short')),
  invested_pct NUMERIC,
  entry_price NUMERIC,
  current_price NUMERIC,
  pnl NUMERIC,
  holding_time_days NUMERIC,
  captured_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(source, source_trader_id, symbol, captured_at)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_trader_portfolio_source_trader 
  ON trader_portfolio(source, source_trader_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_trader_portfolio_captured_at 
  ON trader_portfolio(captured_at);

-- ============================================
-- 4. 创建 trader_monthly_performance 表
-- ============================================
CREATE TABLE IF NOT EXISTS trader_monthly_performance (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  source_trader_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK (month >= 1 AND month <= 12),
  roi NUMERIC,
  pnl NUMERIC,
  captured_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(source, source_trader_id, year, month, captured_at)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_trader_monthly_performance_source_trader 
  ON trader_monthly_performance(source, source_trader_id, year, month);
CREATE INDEX IF NOT EXISTS idx_trader_monthly_performance_captured_at 
  ON trader_monthly_performance(captured_at);

-- ============================================
-- 5. 创建 trader_yearly_performance 表
-- ============================================
CREATE TABLE IF NOT EXISTS trader_yearly_performance (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  source_trader_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  roi NUMERIC,
  pnl NUMERIC,
  captured_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(source, source_trader_id, year, captured_at)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_trader_yearly_performance_source_trader 
  ON trader_yearly_performance(source, source_trader_id, year);
CREATE INDEX IF NOT EXISTS idx_trader_yearly_performance_captured_at 
  ON trader_yearly_performance(captured_at);

-- ============================================
-- 6. 为 trader_snapshots 新字段创建索引（可选，用于查询优化）
-- ============================================
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_roi_7d 
  ON trader_snapshots(source, roi_7d DESC NULLS LAST) 
  WHERE roi_7d IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_roi_30d 
  ON trader_snapshots(source, roi_30d DESC NULLS LAST) 
  WHERE roi_30d IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_roi_1y 
  ON trader_snapshots(source, roi_1y DESC NULLS LAST) 
  WHERE roi_1y IS NOT NULL;

-- ============================================
-- 完成！
-- ============================================
-- 所有表结构已扩展和创建完成

