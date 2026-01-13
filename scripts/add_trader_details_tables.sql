-- ============================================
-- 交易员详情数据表
-- ============================================

-- 1. 添加多时间段 ROI 列到 trader_snapshots
ALTER TABLE trader_snapshots 
ADD COLUMN IF NOT EXISTS roi_7d NUMERIC(20, 8),
ADD COLUMN IF NOT EXISTS roi_30d NUMERIC(20, 8),
ADD COLUMN IF NOT EXISTS trades_count INTEGER,
ADD COLUMN IF NOT EXISTS holding_days NUMERIC(10, 2),
ADD COLUMN IF NOT EXISTS avg_profit NUMERIC(20, 8),
ADD COLUMN IF NOT EXISTS avg_loss NUMERIC(20, 8),
ADD COLUMN IF NOT EXISTS copier_pnl NUMERIC(20, 8),
ADD COLUMN IF NOT EXISTS total_copiers INTEGER;

-- 2. 创建 trader_portfolio 表（持仓分布/品种偏好）
CREATE TABLE IF NOT EXISTS trader_portfolio (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  source_trader_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  weight_pct NUMERIC(10, 4),
  direction TEXT DEFAULT 'long',
  entry_price NUMERIC(20, 8),
  pnl_pct NUMERIC(10, 4),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source, source_trader_id, symbol)
);

-- 3. 创建 trader_position_history 表（历史订单）
CREATE TABLE IF NOT EXISTS trader_position_history (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  source_trader_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT,
  entry_price NUMERIC(20, 8),
  exit_price NUMERIC(20, 8),
  pnl_pct NUMERIC(10, 4),
  leverage INTEGER,
  size NUMERIC(20, 8),
  open_time TIMESTAMPTZ,
  close_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. 创建 trader_stats 表（详细统计数据）
CREATE TABLE IF NOT EXISTS trader_stats (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  source_trader_id TEXT NOT NULL,
  trade_frequency INTEGER,
  avg_holding_hours NUMERIC(10, 2),
  max_holding_hours NUMERIC(10, 2),
  profitable_trades_pct NUMERIC(10, 4),
  avg_profit_per_trade NUMERIC(20, 8),
  avg_loss_per_trade NUMERIC(20, 8),
  sharpe_ratio NUMERIC(10, 4),
  sortino_ratio NUMERIC(10, 4),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source, source_trader_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_trader_portfolio_trader ON trader_portfolio(source, source_trader_id);
CREATE INDEX IF NOT EXISTS idx_trader_position_history_trader ON trader_position_history(source, source_trader_id);
CREATE INDEX IF NOT EXISTS idx_trader_position_history_time ON trader_position_history(close_time DESC);
CREATE INDEX IF NOT EXISTS idx_trader_stats_trader ON trader_stats(source, source_trader_id);

-- RLS
ALTER TABLE trader_portfolio ENABLE ROW LEVEL SECURITY;
ALTER TABLE trader_position_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE trader_stats ENABLE ROW LEVEL SECURITY;

-- 公开读取策略
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'trader_portfolio' AND policyname = '允许公开读取 trader_portfolio') THEN
    CREATE POLICY "允许公开读取 trader_portfolio" ON trader_portfolio FOR SELECT USING (true);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'trader_position_history' AND policyname = '允许公开读取 trader_position_history') THEN
    CREATE POLICY "允许公开读取 trader_position_history" ON trader_position_history FOR SELECT USING (true);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'trader_stats' AND policyname = '允许公开读取 trader_stats') THEN
    CREATE POLICY "允许公开读取 trader_stats" ON trader_stats FOR SELECT USING (true);
  END IF;
END $$;
