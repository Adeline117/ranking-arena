-- Migration: Pro会员系统字段补充
-- 在 user_profiles 表添加缺失的 Pro 字段

-- pro_plan: monthly/yearly
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS pro_plan TEXT;

-- pro_expires_at: 会员过期时间
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS pro_expires_at TIMESTAMPTZ;

-- stripe_subscription_id: Stripe订阅ID（stripe_customer_id 已存在）
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

-- is_pro: 快捷布尔字段（与 subscription_tier='pro' 冗余但查询更快）
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS is_pro BOOLEAN DEFAULT false;

-- 索引：按 Pro 状态快速筛选
CREATE INDEX IF NOT EXISTS idx_user_profiles_is_pro
  ON user_profiles(is_pro) WHERE is_pro = true;

-- 在 user_levels 表补充 pro_plan（已有 is_pro 和 pro_expires_at）
ALTER TABLE user_levels
  ADD COLUMN IF NOT EXISTS pro_plan TEXT;

ALTER TABLE user_levels
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

ALTER TABLE user_levels
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
