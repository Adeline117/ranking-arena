-- Binance 交易员主页数据优化 - 数据库表结构扩展
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
DROP POLICY IF EXISTS "Public read access" ON trader_asset_breakdown;
CREATE POLICY "Public read access" ON trader_asset_breakdown FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role can insert" ON trader_asset_breakdown;
CREATE POLICY "Service role can insert" ON trader_asset_breakdown FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "Service role can update" ON trader_asset_breakdown;
CREATE POLICY "Service role can update" ON trader_asset_breakdown FOR UPDATE USING (true);

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
DROP POLICY IF EXISTS "Public read access" ON trader_equity_curve;
CREATE POLICY "Public read access" ON trader_equity_curve FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role can insert" ON trader_equity_curve;
CREATE POLICY "Service role can insert" ON trader_equity_curve FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "Service role can update" ON trader_equity_curve;
CREATE POLICY "Service role can update" ON trader_equity_curve FOR UPDATE USING (true);

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
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  -- 复合唯一约束（同一交易员的同一仓位不重复）
  UNIQUE(source, source_trader_id, symbol, open_time)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_trader_position_history_source_trader 
  ON trader_position_history(source, source_trader_id);
CREATE INDEX IF NOT EXISTS idx_trader_position_history_open_time 
  ON trader_position_history(source, source_trader_id, open_time DESC);
CREATE INDEX IF NOT EXISTS idx_trader_position_history_close_time 
  ON trader_position_history(source, source_trader_id, close_time DESC);
CREATE INDEX IF NOT EXISTS idx_trader_position_history_symbol 
  ON trader_position_history(source, source_trader_id, symbol);

-- RLS 策略
ALTER TABLE trader_position_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read access" ON trader_position_history;
CREATE POLICY "Public read access" ON trader_position_history FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role can insert" ON trader_position_history;
CREATE POLICY "Service role can insert" ON trader_position_history FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "Service role can update" ON trader_position_history;
CREATE POLICY "Service role can update" ON trader_position_history FOR UPDATE USING (true);

-- =====================================================
-- 4. 扩展 trader_stats_detail 表（添加新字段）
-- =====================================================
-- 添加 winning_positions 和 total_positions 字段
DO $$
BEGIN
  -- 获胜仓位数
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'trader_stats_detail' AND column_name = 'winning_positions') THEN
    ALTER TABLE trader_stats_detail ADD COLUMN winning_positions INTEGER;
  END IF;
  
  -- 总仓位数
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'trader_stats_detail' AND column_name = 'total_positions') THEN
    ALTER TABLE trader_stats_detail ADD COLUMN total_positions INTEGER;
  END IF;
  
  -- 时间段（7D/30D/90D）
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'trader_stats_detail' AND column_name = 'period') THEN
    ALTER TABLE trader_stats_detail ADD COLUMN period VARCHAR(10) DEFAULT '90D';
  END IF;
  
  -- 更新唯一约束（如果需要按 period 区分）
  -- 注意：这可能会失败如果已存在重复数据，需要先清理
END $$;

-- 为 trader_stats_detail 添加 period 索引
CREATE INDEX IF NOT EXISTS idx_trader_stats_detail_period 
  ON trader_stats_detail(source, source_trader_id, period);

-- =====================================================
-- 5. 添加 tracked_since 视图（获取 Arena 首次抓取时间）
-- =====================================================
CREATE OR REPLACE VIEW trader_tracked_since AS
SELECT 
  source,
  source_trader_id,
  MIN(captured_at) AS tracked_since
FROM trader_snapshots
GROUP BY source, source_trader_id;

-- =====================================================
-- 6. 触发器：自动更新 updated_at
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- trader_asset_breakdown
DROP TRIGGER IF EXISTS update_trader_asset_breakdown_updated_at ON trader_asset_breakdown;
CREATE TRIGGER update_trader_asset_breakdown_updated_at
  BEFORE UPDATE ON trader_asset_breakdown
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- trader_position_history
DROP TRIGGER IF EXISTS update_trader_position_history_updated_at ON trader_position_history;
CREATE TRIGGER update_trader_position_history_updated_at
  BEFORE UPDATE ON trader_position_history
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- 完成
-- =====================================================
-- 执行此脚本后，数据库将具备存储以下数据的能力：
-- 1. 按时间段（7D/30D/90D）的资产偏好分布
-- 2. 收益率曲线历史数据点
-- 3. 详细的仓位历史记录（包括开平仓时间、价格、盈亏等）
-- 4. 扩展的交易员统计数据（获胜仓位数、总仓位数）
-- 5. tracked_since 视图用于查询 Arena 首次追踪时间
