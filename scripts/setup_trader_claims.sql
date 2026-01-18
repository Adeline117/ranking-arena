-- ============================================
-- 交易员认领系统数据库表
-- 允许交易员认领自己的账号，获得认证徽章
-- ============================================

-- ============================================
-- 交易员认领申请表
-- ============================================

CREATE TABLE IF NOT EXISTS trader_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id TEXT NOT NULL,
  source TEXT NOT NULL,
  
  -- 验证信息
  verification_method TEXT NOT NULL CHECK (verification_method IN ('api_key', 'signature', 'video', 'social')),
  verification_data JSONB,              -- 存储验证所需的数据
  
  -- 状态
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'verified', 'rejected')),
  reject_reason TEXT,                   -- 拒绝原因
  
  -- 审核
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  
  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- 每个交易员只能被一个用户认领
  UNIQUE(trader_id, source)
);

-- ============================================
-- 已认证交易员资料表（认领成功后）
-- ============================================

CREATE TABLE IF NOT EXISTS verified_traders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id TEXT NOT NULL,
  source TEXT NOT NULL,
  
  -- 交易员资料
  display_name TEXT,                    -- 显示名称
  bio TEXT,                             -- 个人简介
  avatar_url TEXT,                      -- 自定义头像
  
  -- 社交链接
  twitter_url TEXT,
  telegram_url TEXT,
  discord_url TEXT,
  website_url TEXT,
  
  -- 认证信息
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verification_method TEXT NOT NULL,
  
  -- 功能权限
  can_pin_posts BOOLEAN DEFAULT TRUE,   -- 可以置顶帖子
  can_reply_reviews BOOLEAN DEFAULT TRUE, -- 可以回复评价
  can_receive_messages BOOLEAN DEFAULT FALSE, -- 可以接收私信
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- 每个交易员账号只能对应一条认证记录
  UNIQUE(trader_id, source),
  -- 每个用户只能认领一个交易员账号
  UNIQUE(user_id)
);

-- ============================================
-- 索引优化
-- ============================================

-- 认领申请索引
CREATE INDEX IF NOT EXISTS idx_claims_user ON trader_claims(user_id);
CREATE INDEX IF NOT EXISTS idx_claims_trader ON trader_claims(trader_id, source);
CREATE INDEX IF NOT EXISTS idx_claims_status ON trader_claims(status);
CREATE INDEX IF NOT EXISTS idx_claims_pending ON trader_claims(status) WHERE status = 'pending';

-- 已认证交易员索引
CREATE INDEX IF NOT EXISTS idx_verified_user ON verified_traders(user_id);
CREATE INDEX IF NOT EXISTS idx_verified_trader ON verified_traders(trader_id, source);

-- ============================================
-- 自动更新 updated_at 触发器
-- ============================================

CREATE OR REPLACE FUNCTION update_trader_claims_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_trader_claims_updated_at ON trader_claims;
CREATE TRIGGER trg_trader_claims_updated_at
  BEFORE UPDATE ON trader_claims
  FOR EACH ROW
  EXECUTE FUNCTION update_trader_claims_updated_at();

CREATE OR REPLACE FUNCTION update_verified_traders_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_verified_traders_updated_at ON verified_traders;
CREATE TRIGGER trg_verified_traders_updated_at
  BEFORE UPDATE ON verified_traders
  FOR EACH ROW
  EXECUTE FUNCTION update_verified_traders_updated_at();

-- ============================================
-- 检查交易员是否已认证
-- ============================================

CREATE OR REPLACE FUNCTION is_trader_verified(p_trader_id TEXT, p_source TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS(
    SELECT 1 FROM verified_traders 
    WHERE trader_id = p_trader_id AND source = p_source
  );
$$ LANGUAGE SQL STABLE;

-- ============================================
-- 获取交易员的认证信息
-- ============================================

CREATE OR REPLACE FUNCTION get_trader_verification(p_trader_id TEXT, p_source TEXT)
RETURNS TABLE(
  user_id UUID,
  display_name TEXT,
  bio TEXT,
  avatar_url TEXT,
  twitter_url TEXT,
  telegram_url TEXT,
  discord_url TEXT,
  website_url TEXT,
  verified_at TIMESTAMPTZ,
  verification_method TEXT
) AS $$
  SELECT 
    user_id,
    display_name,
    bio,
    avatar_url,
    twitter_url,
    telegram_url,
    discord_url,
    website_url,
    verified_at,
    verification_method
  FROM verified_traders 
  WHERE trader_id = p_trader_id AND source = p_source;
$$ LANGUAGE SQL STABLE;

-- ============================================
-- Row Level Security (RLS)
-- ============================================

ALTER TABLE trader_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE verified_traders ENABLE ROW LEVEL SECURITY;

-- 认领申请策略
DROP POLICY IF EXISTS "Users can view their own claims" ON trader_claims;
CREATE POLICY "Users can view their own claims" ON trader_claims
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create claims" ON trader_claims;
CREATE POLICY "Users can create claims" ON trader_claims
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins can view all claims" ON trader_claims;
CREATE POLICY "Admins can view all claims" ON trader_claims
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Admins can update claims" ON trader_claims;
CREATE POLICY "Admins can update claims" ON trader_claims
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- 已认证交易员策略
DROP POLICY IF EXISTS "Verified traders are public" ON verified_traders;
CREATE POLICY "Verified traders are public" ON verified_traders
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can update their own profile" ON verified_traders;
CREATE POLICY "Users can update their own profile" ON verified_traders
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "System can insert verified traders" ON verified_traders;
CREATE POLICY "System can insert verified traders" ON verified_traders
  FOR INSERT WITH CHECK (true);
