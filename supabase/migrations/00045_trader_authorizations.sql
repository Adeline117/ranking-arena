-- 交易员授权系统
-- 允许交易员主动接入，授权展示实盘数据

-- ============================================
-- 1. 交易员授权表
-- ============================================
CREATE TABLE IF NOT EXISTS trader_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 用户信息
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 交易所信息
  platform TEXT NOT NULL,
  trader_id TEXT NOT NULL, -- 交易所的trader ID/UID

  -- 授权凭证（加密存储）
  encrypted_api_key TEXT NOT NULL,
  encrypted_api_secret TEXT NOT NULL,
  encrypted_passphrase TEXT, -- 某些交易所需要（如OKX）

  -- 权限配置
  permissions JSONB DEFAULT '["read_positions", "read_orders", "read_balance"]'::jsonb,

  -- 状态
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked', 'expired')),

  -- 验证信息
  last_verified_at TIMESTAMPTZ,
  verification_error TEXT,

  -- 数据质量
  data_source TEXT NOT NULL DEFAULT 'authorized',
  sync_frequency TEXT DEFAULT 'realtime', -- realtime, 5min, 15min, 1hour

  -- 元数据
  label TEXT, -- 用户可以给授权起名（如"主账户", "合约账户"）
  notes TEXT,

  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,

  -- 唯一约束：一个用户在一个交易所只能有一个授权
  UNIQUE(user_id, platform, trader_id)
);

-- 索引
CREATE INDEX idx_trader_authorizations_user_id ON trader_authorizations(user_id);
CREATE INDEX idx_trader_authorizations_platform ON trader_authorizations(platform);
CREATE INDEX idx_trader_authorizations_status ON trader_authorizations(status);
CREATE INDEX idx_trader_authorizations_trader_id ON trader_authorizations(platform, trader_id);

-- RLS 策略
ALTER TABLE trader_authorizations ENABLE ROW LEVEL SECURITY;

-- 用户只能查看自己的授权
CREATE POLICY "Users can view their own authorizations"
  ON trader_authorizations FOR SELECT
  USING (auth.uid() = user_id);

-- 用户可以创建自己的授权
CREATE POLICY "Users can create their own authorizations"
  ON trader_authorizations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 用户可以更新自己的授权
CREATE POLICY "Users can update their own authorizations"
  ON trader_authorizations FOR UPDATE
  USING (auth.uid() = user_id);

-- 用户可以删除自己的授权
CREATE POLICY "Users can delete their own authorizations"
  ON trader_authorizations FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- 2. 授权同步日志表
-- ============================================
CREATE TABLE IF NOT EXISTS authorization_sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_id UUID NOT NULL REFERENCES trader_authorizations(id) ON DELETE CASCADE,

  -- 同步结果
  sync_status TEXT NOT NULL CHECK (sync_status IN ('success', 'failed', 'partial')),
  records_synced INTEGER DEFAULT 0,
  error_message TEXT,

  -- 同步数据
  synced_data JSONB, -- 存储同步的数据摘要

  -- 时间戳
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_sync_logs_authorization ON authorization_sync_logs(authorization_id, synced_at DESC);
CREATE INDEX idx_sync_logs_status ON authorization_sync_logs(sync_status);

-- RLS 策略（只允许通过授权表访问）
ALTER TABLE authorization_sync_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view logs for their authorizations"
  ON authorization_sync_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM trader_authorizations
      WHERE trader_authorizations.id = authorization_sync_logs.authorization_id
      AND trader_authorizations.user_id = auth.uid()
    )
  );

-- ============================================
-- 3. 授权数据标记（在trader_snapshots中）
-- ============================================
-- 为trader_snapshots添加授权标识
ALTER TABLE trader_snapshots
  ADD COLUMN IF NOT EXISTS authorization_id UUID REFERENCES trader_authorizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_authorized BOOLEAN DEFAULT FALSE;

-- 索引
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_authorization
  ON trader_snapshots(authorization_id)
  WHERE authorization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trader_snapshots_authorized
  ON trader_snapshots(is_authorized)
  WHERE is_authorized = TRUE;

-- ============================================
-- 4. 更新时间戳触发器
-- ============================================
CREATE OR REPLACE FUNCTION update_trader_authorizations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_trader_authorizations_updated_at
  BEFORE UPDATE ON trader_authorizations
  FOR EACH ROW
  EXECUTE FUNCTION update_trader_authorizations_updated_at();

-- ============================================
-- 5. 注释
-- ============================================
COMMENT ON TABLE trader_authorizations IS '交易员授权表：存储用户授权的交易所API凭证';
COMMENT ON COLUMN trader_authorizations.encrypted_api_key IS 'AES-256加密的API Key';
COMMENT ON COLUMN trader_authorizations.encrypted_api_secret IS 'AES-256加密的API Secret';
COMMENT ON COLUMN trader_authorizations.permissions IS '授权权限列表（JSON数组）';
COMMENT ON COLUMN trader_authorizations.status IS '授权状态：active-生效中, suspended-暂停, revoked-已撤销, expired-已过期';
COMMENT ON COLUMN trader_authorizations.sync_frequency IS '数据同步频率：realtime-实时, 5min-5分钟, 15min-15分钟, 1hour-1小时';

COMMENT ON TABLE authorization_sync_logs IS '授权数据同步日志：记录每次同步的结果';
COMMENT ON COLUMN authorization_sync_logs.synced_data IS '同步数据摘要（JSON格式）';

COMMENT ON COLUMN trader_snapshots.authorization_id IS '关联的授权ID（如果数据来自授权接入）';
COMMENT ON COLUMN trader_snapshots.is_authorized IS '是否来自授权数据（高质量数据标识）';
