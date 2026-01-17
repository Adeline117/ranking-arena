-- Binance 交易员主页数据优化 - 数据库表结构扩展
-- 版本: 1.1.0
-- 用于存储资产偏好、收益率曲线、仓位历史等详细数据

-- =====================================================
-- 1. 资产偏好表（按时间段）
-- =====================================================
CREATE TABLE IF NOT EXISTS trader_asset_breakdown (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source VARCHAR(50) NOT NULL,
  source_trader_id VARCHAR(255) NOT NULL,
  period VARCHAR(10) NOT NULL, -- '7D', '30D', '90D'
  symbol VARCHAR(50) NOT NULL,
  weight_pct DECIMAL(10, 4) NOT NULL, -- 权重百分比
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source, source_trader_id, period, symbol, captured_at)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_trader_asset_breakdown_source_trader 
  ON trader_asset_breakdown(source, source_trader_id);
CREATE INDEX IF NOT EXISTS idx_trader_asset_breakdown_period 
  ON trader_asset_breakdown(source, source_trader_id, period);
CREATE INDEX IF NOT EXISTS idx_trader_asset_breakdown_captured 
  ON trader_asset_breakdown(source, source_trader_id, captured_at DESC);

-- RLS 策略
ALTER TABLE trader_asset_breakdown ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read trader_asset_breakdown" ON trader_asset_breakdown;
CREATE POLICY "Public read trader_asset_breakdown" ON trader_asset_breakdown FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service insert trader_asset_breakdown" ON trader_asset_breakdown;
CREATE POLICY "Service insert trader_asset_breakdown" ON trader_asset_breakdown FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "Service update trader_asset_breakdown" ON trader_asset_breakdown;
CREATE POLICY "Service update trader_asset_breakdown" ON trader_asset_breakdown FOR UPDATE USING (true);

-- =====================================================
-- 2. 收益率曲线表（历史数据点）
-- =====================================================
CREATE TABLE IF NOT EXISTS trader_equity_curve (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source VARCHAR(50) NOT NULL,
  source_trader_id VARCHAR(255) NOT NULL,
  period VARCHAR(10) NOT NULL, -- '7D', '30D', '90D'
  data_date DATE NOT NULL, -- 数据日期
  roi_pct DECIMAL(20, 8), -- 收益率百分比
  pnl_usd DECIMAL(20, 8), -- 盈亏金额（USD）
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source, source_trader_id, period, data_date)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_trader_equity_curve_source_trader 
  ON trader_equity_curve(source, source_trader_id);
CREATE INDEX IF NOT EXISTS idx_trader_equity_curve_period 
  ON trader_equity_curve(source, source_trader_id, period);
CREATE INDEX IF NOT EXISTS idx_trader_equity_curve_date 
  ON trader_equity_curve(source, source_trader_id, period, data_date DESC);

-- RLS 策略
ALTER TABLE trader_equity_curve ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read trader_equity_curve" ON trader_equity_curve;
CREATE POLICY "Public read trader_equity_curve" ON trader_equity_curve FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service insert trader_equity_curve" ON trader_equity_curve;
CREATE POLICY "Service insert trader_equity_curve" ON trader_equity_curve FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "Service update trader_equity_curve" ON trader_equity_curve;
CREATE POLICY "Service update trader_equity_curve" ON trader_equity_curve FOR UPDATE USING (true);

-- =====================================================
-- 3. 仓位历史记录表（详细版）
-- =====================================================
CREATE TABLE IF NOT EXISTS trader_position_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source VARCHAR(50) NOT NULL,
  source_trader_id VARCHAR(255) NOT NULL,
  -- 基本信息
  symbol VARCHAR(50) NOT NULL, -- 交易对，如 BTCUSDT
  direction VARCHAR(10) NOT NULL, -- 'long' 或 'short'
  position_type VARCHAR(20) DEFAULT 'perpetual', -- 'perpetual' 永续, 'delivery' 交割
  margin_mode VARCHAR(20) DEFAULT 'cross', -- 'cross' 全仓, 'isolated' 逐仓
  -- 时间
  open_time TIMESTAMPTZ, -- 开仓时间
  close_time TIMESTAMPTZ, -- 平仓时间（部分平仓可能没有）
  -- 价格
  entry_price DECIMAL(20, 8), -- 开仓价格
  exit_price DECIMAL(20, 8), -- 平仓均价
  -- 仓位大小
  max_position_size DECIMAL(20, 8), -- 最大持仓量
  closed_size DECIMAL(20, 8), -- 已平仓量
  -- 盈亏
  pnl_usd DECIMAL(20, 8), -- 平仓盈亏（USD）
  pnl_pct DECIMAL(10, 4), -- 平仓盈亏百分比
  -- 状态
  status VARCHAR(20) DEFAULT 'closed', -- 'partial' 部分平仓, 'closed' 全部平仓
  -- 元数据
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_trader_position_history_source_trader 
  ON trader_position_history(source, source_trader_id);
CREATE INDEX IF NOT EXISTS idx_trader_position_history_open_time 
  ON trader_position_history(source, source_trader_id, open_time DESC);
CREATE INDEX IF NOT EXISTS idx_trader_position_history_close_time 
  ON trader_position_history(source, source_trader_id, close_time DESC);

-- RLS 策略
ALTER TABLE trader_position_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read trader_position_history" ON trader_position_history;
CREATE POLICY "Public read trader_position_history" ON trader_position_history FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service insert trader_position_history" ON trader_position_history;
CREATE POLICY "Service insert trader_position_history" ON trader_position_history FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "Service update trader_position_history" ON trader_position_history;
CREATE POLICY "Service update trader_position_history" ON trader_position_history FOR UPDATE USING (true);

-- =====================================================
-- 4. 详细统计数据表
-- =====================================================
CREATE TABLE IF NOT EXISTS trader_stats_detail (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source VARCHAR(50) NOT NULL,
  source_trader_id VARCHAR(255) NOT NULL,
  period VARCHAR(10), -- '7D', '30D', '90D' 或 NULL 表示全部
  -- ROI 数据
  roi DECIMAL(20, 8),
  -- 交易统计
  total_trades INTEGER,
  profitable_trades_pct DECIMAL(10, 4),
  avg_holding_time_hours DECIMAL(10, 2),
  avg_profit DECIMAL(20, 8),
  avg_loss DECIMAL(20, 8),
  largest_win DECIMAL(20, 8),
  largest_loss DECIMAL(20, 8),
  -- 风险指标
  sharpe_ratio DECIMAL(10, 4),
  max_drawdown DECIMAL(10, 4),
  current_drawdown DECIMAL(10, 4),
  volatility DECIMAL(10, 4),
  -- 跟单数据
  copiers_count INTEGER,
  copiers_pnl DECIMAL(20, 8),
  aum DECIMAL(20, 8),
  -- 仓位统计
  winning_positions INTEGER,
  total_positions INTEGER,
  -- 元数据
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source, source_trader_id, period, captured_at)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_trader_stats_detail_source_trader 
  ON trader_stats_detail(source, source_trader_id);
CREATE INDEX IF NOT EXISTS idx_trader_stats_detail_period 
  ON trader_stats_detail(source, source_trader_id, period);
CREATE INDEX IF NOT EXISTS idx_trader_stats_detail_captured 
  ON trader_stats_detail(source, source_trader_id, captured_at DESC);

-- RLS 策略
ALTER TABLE trader_stats_detail ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read trader_stats_detail" ON trader_stats_detail;
CREATE POLICY "Public read trader_stats_detail" ON trader_stats_detail FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service insert trader_stats_detail" ON trader_stats_detail;
CREATE POLICY "Service insert trader_stats_detail" ON trader_stats_detail FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "Service update trader_stats_detail" ON trader_stats_detail;
CREATE POLICY "Service update trader_stats_detail" ON trader_stats_detail FOR UPDATE USING (true);

-- =====================================================
-- 5. 当前持仓表
-- =====================================================
CREATE TABLE IF NOT EXISTS trader_portfolio (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source VARCHAR(50) NOT NULL,
  source_trader_id VARCHAR(255) NOT NULL,
  symbol VARCHAR(50) NOT NULL,
  direction VARCHAR(10) NOT NULL, -- 'long' 或 'short'
  invested_pct DECIMAL(10, 4), -- 投入占比
  entry_price DECIMAL(20, 8), -- 入场价格
  pnl DECIMAL(20, 8), -- 当前盈亏
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source, source_trader_id, symbol, captured_at)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_trader_portfolio_source_trader 
  ON trader_portfolio(source, source_trader_id);
CREATE INDEX IF NOT EXISTS idx_trader_portfolio_captured 
  ON trader_portfolio(source, source_trader_id, captured_at DESC);

-- RLS 策略
ALTER TABLE trader_portfolio ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read trader_portfolio" ON trader_portfolio;
CREATE POLICY "Public read trader_portfolio" ON trader_portfolio FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service insert trader_portfolio" ON trader_portfolio;
CREATE POLICY "Service insert trader_portfolio" ON trader_portfolio FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "Service update trader_portfolio" ON trader_portfolio;
CREATE POLICY "Service update trader_portfolio" ON trader_portfolio FOR UPDATE USING (true);
