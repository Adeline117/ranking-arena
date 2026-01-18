-- ============================================
-- 邀请码系统表结构
-- ============================================

-- 邀请码表
CREATE TABLE IF NOT EXISTS invite_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  creator_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  
  -- 使用限制
  max_uses INTEGER DEFAULT 10,
  current_uses INTEGER DEFAULT 0,
  
  -- 试用配置
  trial_days INTEGER DEFAULT 7,
  trial_tier TEXT DEFAULT 'pro' CHECK (trial_tier IN ('pro', 'elite')),
  
  -- 状态
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT TRUE,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 邀请码兑换记录
CREATE TABLE IF NOT EXISTS invite_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id UUID NOT NULL REFERENCES invite_codes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  
  redeemed_at TIMESTAMPTZ DEFAULT NOW(),
  trial_expires_at TIMESTAMPTZ NOT NULL,
  
  UNIQUE(code_id, user_id),
  UNIQUE(user_id)  -- 每个用户只能使用一次邀请码
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code);
CREATE INDEX IF NOT EXISTS idx_invite_codes_creator ON invite_codes(creator_id);
CREATE INDEX IF NOT EXISTS idx_invite_redemptions_user ON invite_redemptions(user_id);

-- ============================================
-- 更新用户订阅表以支持邀请码试用
-- ============================================

-- 添加邀请码相关字段（如果不存在）
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_subscriptions' 
    AND column_name = 'source'
  ) THEN
    ALTER TABLE user_subscriptions ADD COLUMN source TEXT;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_subscriptions' 
    AND column_name = 'invite_code_id'
  ) THEN
    ALTER TABLE user_subscriptions ADD COLUMN invite_code_id UUID REFERENCES invite_codes(id);
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_subscriptions' 
    AND column_name = 'trial_ends_at'
  ) THEN
    ALTER TABLE user_subscriptions ADD COLUMN trial_ends_at TIMESTAMPTZ;
  END IF;
END $$;

-- ============================================
-- RLS 策略
-- ============================================

ALTER TABLE invite_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE invite_redemptions ENABLE ROW LEVEL SECURITY;

-- 邀请码：创建者可以查看和管理自己的邀请码
CREATE POLICY "Users can view own invite codes"
  ON invite_codes FOR SELECT
  TO authenticated
  USING (creator_id = auth.uid());

CREATE POLICY "Users can create invite codes"
  ON invite_codes FOR INSERT
  TO authenticated
  WITH CHECK (creator_id = auth.uid());

CREATE POLICY "Users can update own invite codes"
  ON invite_codes FOR UPDATE
  TO authenticated
  USING (creator_id = auth.uid());

-- 任何人可以通过 code 验证邀请码（用于兑换验证）
CREATE POLICY "Anyone can validate invite codes"
  ON invite_codes FOR SELECT
  TO authenticated
  USING (is_active = true);

-- 兑换记录：用户只能查看和创建自己的记录
CREATE POLICY "Users can view own redemptions"
  ON invite_redemptions FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can redeem invite codes"
  ON invite_redemptions FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- ============================================
-- 邀请码使用统计视图
-- ============================================

CREATE OR REPLACE VIEW invite_code_stats AS
SELECT 
  ic.id,
  ic.code,
  ic.creator_id,
  ic.max_uses,
  ic.current_uses,
  ic.trial_days,
  ic.trial_tier,
  ic.expires_at,
  ic.is_active,
  ic.created_at,
  COUNT(ir.id) as total_redemptions,
  COUNT(CASE WHEN ir.trial_expires_at > NOW() THEN 1 END) as active_trials
FROM invite_codes ic
LEFT JOIN invite_redemptions ir ON ic.id = ir.code_id
GROUP BY ic.id;
