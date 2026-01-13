-- 创建交易员详情数据表

-- 1. 交易员持仓数据
CREATE TABLE IF NOT EXISTS trader_portfolio (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source VARCHAR(50) NOT NULL,
  source_trader_id VARCHAR(255) NOT NULL,
  symbol VARCHAR(50) NOT NULL,
  direction VARCHAR(10) DEFAULT 'long',
  invested_pct DECIMAL(10, 4),
  entry_price DECIMAL(20, 8),
  current_price DECIMAL(20, 8),
  pnl DECIMAL(20, 8),
  holding_time_days INTEGER,
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source, source_trader_id, symbol, captured_at)
);

-- 2. 交易员月度表现
CREATE TABLE IF NOT EXISTS trader_monthly_performance (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source VARCHAR(50) NOT NULL,
  source_trader_id VARCHAR(255) NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  roi DECIMAL(10, 4),
  pnl DECIMAL(20, 8),
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source, source_trader_id, year, month)
);

-- 3. 交易员年度表现
CREATE TABLE IF NOT EXISTS trader_yearly_performance (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source VARCHAR(50) NOT NULL,
  source_trader_id VARCHAR(255) NOT NULL,
  year INTEGER NOT NULL,
  roi DECIMAL(10, 4),
  pnl DECIMAL(20, 8),
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source, source_trader_id, year)
);

-- 4. 交易员常用交易币种
CREATE TABLE IF NOT EXISTS trader_frequently_traded (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source VARCHAR(50) NOT NULL,
  source_trader_id VARCHAR(255) NOT NULL,
  symbol VARCHAR(50) NOT NULL,
  weight_pct DECIMAL(10, 4),
  trade_count INTEGER,
  avg_profit DECIMAL(20, 8),
  avg_loss DECIMAL(20, 8),
  profitable_pct DECIMAL(10, 4),
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source, source_trader_id, symbol, captured_at)
);

-- 5. 交易员详细统计 (扩展 trader_snapshots 的附加数据)
CREATE TABLE IF NOT EXISTS trader_stats_detail (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source VARCHAR(50) NOT NULL,
  source_trader_id VARCHAR(255) NOT NULL,
  -- 时间段 ROI
  roi_7d DECIMAL(10, 4),
  roi_30d DECIMAL(10, 4),
  roi_90d DECIMAL(10, 4),
  roi_180d DECIMAL(10, 4),
  roi_1y DECIMAL(10, 4),
  roi_all DECIMAL(10, 4),
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
  -- 元数据
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source, source_trader_id, captured_at)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_trader_portfolio_source_trader ON trader_portfolio(source, source_trader_id);
CREATE INDEX IF NOT EXISTS idx_trader_monthly_perf_source_trader ON trader_monthly_performance(source, source_trader_id);
CREATE INDEX IF NOT EXISTS idx_trader_yearly_perf_source_trader ON trader_yearly_performance(source, source_trader_id);
CREATE INDEX IF NOT EXISTS idx_trader_frequently_traded_source_trader ON trader_frequently_traded(source, source_trader_id);
CREATE INDEX IF NOT EXISTS idx_trader_stats_detail_source_trader ON trader_stats_detail(source, source_trader_id);

-- RLS 策略（公开可读）
ALTER TABLE trader_portfolio ENABLE ROW LEVEL SECURITY;
ALTER TABLE trader_monthly_performance ENABLE ROW LEVEL SECURITY;
ALTER TABLE trader_yearly_performance ENABLE ROW LEVEL SECURITY;
ALTER TABLE trader_frequently_traded ENABLE ROW LEVEL SECURITY;
ALTER TABLE trader_stats_detail ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read access" ON trader_portfolio FOR SELECT USING (true);
CREATE POLICY "Public read access" ON trader_monthly_performance FOR SELECT USING (true);
CREATE POLICY "Public read access" ON trader_yearly_performance FOR SELECT USING (true);
CREATE POLICY "Public read access" ON trader_frequently_traded FOR SELECT USING (true);
CREATE POLICY "Public read access" ON trader_stats_detail FOR SELECT USING (true);

-- 服务角色可写
CREATE POLICY "Service role can insert" ON trader_portfolio FOR INSERT WITH CHECK (true);
CREATE POLICY "Service role can insert" ON trader_monthly_performance FOR INSERT WITH CHECK (true);
CREATE POLICY "Service role can insert" ON trader_yearly_performance FOR INSERT WITH CHECK (true);
CREATE POLICY "Service role can insert" ON trader_frequently_traded FOR INSERT WITH CHECK (true);
CREATE POLICY "Service role can insert" ON trader_stats_detail FOR INSERT WITH CHECK (true);

CREATE POLICY "Service role can update" ON trader_portfolio FOR UPDATE USING (true);
CREATE POLICY "Service role can update" ON trader_monthly_performance FOR UPDATE USING (true);
CREATE POLICY "Service role can update" ON trader_yearly_performance FOR UPDATE USING (true);
CREATE POLICY "Service role can update" ON trader_frequently_traded FOR UPDATE USING (true);
CREATE POLICY "Service role can update" ON trader_stats_detail FOR UPDATE USING (true);

