-- 用户绑定交易所账号相关表结构
-- 执行前请确保已创建 uuid_generate_v4() 扩展（如果还没有）

-- 表1：user_exchange_connections（用户交易所连接）
CREATE TABLE IF NOT EXISTS user_exchange_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange TEXT NOT NULL, -- 'binance', 'bybit', 'bitget', 'mexc', 'coinex'
  exchange_user_id TEXT, -- 用户在交易所的用户ID（如果有）
  api_key_encrypted TEXT NOT NULL, -- 加密的API Key
  api_secret_encrypted TEXT NOT NULL, -- 加密的API Secret
  access_token_encrypted TEXT, -- 加密的Access Token（如果使用OAuth）
  refresh_token_encrypted TEXT, -- 加密的Refresh Token（如果使用OAuth）
  expires_at TIMESTAMPTZ, -- Token过期时间（如果使用OAuth）
  is_active BOOLEAN DEFAULT true,
  last_sync_at TIMESTAMPTZ, -- 最后同步时间
  last_sync_status TEXT, -- 'success', 'error', 'pending'
  last_sync_error TEXT, -- 最后同步错误信息
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, exchange)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_user_exchange_user ON user_exchange_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_user_exchange_active ON user_exchange_connections(user_id, is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_user_exchange_sync ON user_exchange_connections(last_sync_at) WHERE is_active = true;

-- RLS策略（确保用户只能访问自己的连接）
ALTER TABLE user_exchange_connections ENABLE ROW LEVEL SECURITY;

-- 删除旧策略（如果存在）
DROP POLICY IF EXISTS "Users can view their own connections" ON user_exchange_connections;
DROP POLICY IF EXISTS "Users can insert their own connections" ON user_exchange_connections;
DROP POLICY IF EXISTS "Users can update their own connections" ON user_exchange_connections;
DROP POLICY IF EXISTS "Users can delete their own connections" ON user_exchange_connections;

-- 创建新策略
CREATE POLICY "Users can view their own connections"
  ON user_exchange_connections FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own connections"
  ON user_exchange_connections FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own connections"
  ON user_exchange_connections FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own connections"
  ON user_exchange_connections FOR DELETE
  USING (auth.uid() = user_id);

-- 表2：user_trading_data（用户交易数据）
CREATE TABLE IF NOT EXISTS user_trading_data (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  total_trades INTEGER,
  avg_profit NUMERIC,
  avg_loss NUMERIC,
  profitable_trades_pct NUMERIC,
  trades_per_week NUMERIC,
  avg_holding_time_days NUMERIC,
  profitable_holding_time_days NUMERIC,
  active_since DATE,
  profitable_weeks INTEGER,
  profitable_weeks_pct NUMERIC,
  return_ytd NUMERIC,
  return_2y NUMERIC,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, exchange, period_start, period_end)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_user_trading_user ON user_trading_data(user_id, exchange, period_end DESC);

-- RLS策略
ALTER TABLE user_trading_data ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own trading data" ON user_trading_data;

CREATE POLICY "Users can view their own trading data"
  ON user_trading_data FOR SELECT
  USING (auth.uid() = user_id);

-- 表3：user_frequently_traded（用户常用交易币种）
CREATE TABLE IF NOT EXISTS user_frequently_traded (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  trade_count INTEGER,
  weight_pct NUMERIC,
  avg_profit NUMERIC,
  avg_loss NUMERIC,
  profitable_pct NUMERIC,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, exchange, symbol, period_start, period_end)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_user_frequently_user ON user_frequently_traded(user_id, exchange, period_end DESC, weight_pct DESC);

-- RLS策略
ALTER TABLE user_frequently_traded ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own frequently traded" ON user_frequently_traded;

CREATE POLICY "Users can view their own frequently traded"
  ON user_frequently_traded FOR SELECT
  USING (auth.uid() = user_id);

-- 表4：user_portfolio_breakdown（用户投资组合分解）
CREATE TABLE IF NOT EXISTS user_portfolio_breakdown (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL, -- 'long' or 'short'
  weight_pct NUMERIC,
  value_usd NUMERIC,
  pnl_pct NUMERIC,
  current_price NUMERIC,
  snapshot_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, exchange, symbol, snapshot_at)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_user_portfolio_user ON user_portfolio_breakdown(user_id, exchange, snapshot_at DESC);

-- RLS策略
ALTER TABLE user_portfolio_breakdown ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own portfolio" ON user_portfolio_breakdown;

CREATE POLICY "Users can view their own portfolio"
  ON user_portfolio_breakdown FOR SELECT
  USING (auth.uid() = user_id);

-- 表5：user_trading_history（用户交易历史 - 可选，用于详细分析）
CREATE TABLE IF NOT EXISTS user_trading_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange TEXT NOT NULL,
  trade_id TEXT NOT NULL, -- 交易所的交易ID
  symbol TEXT NOT NULL,
  side TEXT NOT NULL, -- 'buy' or 'sell'
  quantity NUMERIC NOT NULL,
  price NUMERIC NOT NULL,
  fee NUMERIC,
  pnl NUMERIC,
  holding_time_days NUMERIC, -- 持仓时间（天）
  executed_at TIMESTAMPTZ NOT NULL,
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, exchange, trade_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_user_history_user ON user_trading_history(user_id, exchange, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_history_symbol ON user_trading_history(user_id, exchange, symbol);

-- RLS策略
ALTER TABLE user_trading_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own trading history" ON user_trading_history;

CREATE POLICY "Users can view their own trading history"
  ON user_trading_history FOR SELECT
  USING (auth.uid() = user_id);

-- 创建更新时间触发器函数（如果还没有）
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 为表添加更新时间触发器
DROP TRIGGER IF EXISTS update_user_exchange_connections_updated_at ON user_exchange_connections;
CREATE TRIGGER update_user_exchange_connections_updated_at
  BEFORE UPDATE ON user_exchange_connections
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_user_trading_data_updated_at ON user_trading_data;
CREATE TRIGGER update_user_trading_data_updated_at
  BEFORE UPDATE ON user_trading_data
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_user_frequently_traded_updated_at ON user_frequently_traded;
CREATE TRIGGER update_user_frequently_traded_updated_at
  BEFORE UPDATE ON user_frequently_traded
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_user_portfolio_breakdown_updated_at ON user_portfolio_breakdown;
CREATE TRIGGER update_user_portfolio_breakdown_updated_at
  BEFORE UPDATE ON user_portfolio_breakdown
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


