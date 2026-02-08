-- 跟单配置表
CREATE TABLE IF NOT EXISTS copy_trade_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id TEXT NOT NULL,
  exchange TEXT NOT NULL DEFAULT 'binance',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, trader_id, exchange)
);

-- 跟单日志表
CREATE TABLE IF NOT EXISTS copy_trade_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id UUID NOT NULL REFERENCES copy_trade_configs(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  pair TEXT NOT NULL,
  size NUMERIC,
  price NUMERIC,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 索引
CREATE INDEX idx_copy_trade_configs_user ON copy_trade_configs(user_id);
CREATE INDEX idx_copy_trade_configs_active ON copy_trade_configs(user_id, active) WHERE active = true;
CREATE INDEX idx_copy_trade_logs_config ON copy_trade_logs(config_id);
CREATE INDEX idx_copy_trade_logs_created ON copy_trade_logs(created_at DESC);

-- RLS
ALTER TABLE copy_trade_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE copy_trade_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "用户只能访问自己的跟单配置"
  ON copy_trade_configs FOR ALL
  USING (auth.uid() = user_id);

CREATE POLICY "用户只能访问自己的跟单日志"
  ON copy_trade_logs FOR ALL
  USING (config_id IN (SELECT id FROM copy_trade_configs WHERE user_id = auth.uid()));

-- updated_at 触发器
CREATE OR REPLACE FUNCTION update_copy_trade_configs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER copy_trade_configs_updated_at
  BEFORE UPDATE ON copy_trade_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_copy_trade_configs_updated_at();
