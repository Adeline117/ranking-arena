-- Stripe 订阅系统数据库扩展
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- ============================================
-- 1. 扩展 user_profiles 表
-- ============================================
ALTER TABLE user_profiles 
ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE,
ADD COLUMN IF NOT EXISTS subscription_tier TEXT DEFAULT 'free' CHECK (subscription_tier IN ('free', 'pro', 'elite', 'enterprise'));

CREATE INDEX IF NOT EXISTS idx_user_profiles_stripe_customer_id ON user_profiles(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_subscription_tier ON user_profiles(subscription_tier);

-- ============================================
-- 2. 创建 subscriptions 表
-- ============================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  stripe_customer_id TEXT,
  status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('active', 'canceled', 'incomplete', 'expired', 'past_due', 'paused', 'trialing', 'unpaid', 'inactive')),
  tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'elite', 'enterprise')),
  plan TEXT CHECK (plan IN ('monthly', 'yearly')),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT false,
  canceled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_subscription_id ON subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

-- RLS
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own subscription" ON subscriptions
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage subscriptions" ON subscriptions
  FOR ALL USING (auth.role() = 'service_role');

-- ============================================
-- 3. 创建 payment_history 表
-- ============================================
CREATE TABLE IF NOT EXISTS payment_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_invoice_id TEXT,
  stripe_payment_intent_id TEXT,
  amount INTEGER NOT NULL, -- 以分为单位
  currency TEXT DEFAULT 'usd',
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'pending', 'refunded')),
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_payment_history_user_id ON payment_history(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_history_stripe_invoice_id ON payment_history(stripe_invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_history_status ON payment_history(status);
CREATE INDEX IF NOT EXISTS idx_payment_history_created_at ON payment_history(created_at DESC);

-- RLS
ALTER TABLE payment_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own payment history" ON payment_history
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage payment history" ON payment_history
  FOR ALL USING (auth.role() = 'service_role');

-- ============================================
-- 4. 创建辅助函数：检查用户是否为 Pro 会员
-- ============================================
CREATE OR REPLACE FUNCTION is_pro_subscriber(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_status TEXT;
  v_tier TEXT;
  v_period_end TIMESTAMPTZ;
BEGIN
  SELECT status, tier, current_period_end 
  INTO v_status, v_tier, v_period_end
  FROM subscriptions 
  WHERE user_id = p_user_id;

  -- 检查订阅是否有效
  IF v_status IN ('active', 'trialing') AND v_tier IN ('pro', 'elite', 'enterprise') THEN
    -- 检查是否在有效期内
    IF v_period_end IS NULL OR v_period_end > NOW() THEN
      RETURN true;
    END IF;
  END IF;

  RETURN false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 5. 创建辅助函数：获取用户订阅 tier
-- ============================================
CREATE OR REPLACE FUNCTION get_user_subscription_tier(p_user_id UUID)
RETURNS TEXT AS $$
DECLARE
  v_tier TEXT;
BEGIN
  SELECT tier INTO v_tier
  FROM subscriptions
  WHERE user_id = p_user_id
    AND status IN ('active', 'trialing')
    AND (current_period_end IS NULL OR current_period_end > NOW());

  RETURN COALESCE(v_tier, 'free');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 6. 创建视图：订阅统计
-- ============================================
CREATE OR REPLACE VIEW subscription_stats AS
SELECT 
  COUNT(*) FILTER (WHERE status = 'active') as active_subscriptions,
  COUNT(*) FILTER (WHERE status = 'trialing') as trialing_subscriptions,
  COUNT(*) FILTER (WHERE tier = 'pro') as pro_subscribers,
  COUNT(*) FILTER (WHERE tier = 'elite') as elite_subscribers,
  COUNT(*) FILTER (WHERE tier = 'enterprise') as enterprise_subscribers,
  COUNT(*) FILTER (WHERE plan = 'monthly' AND status = 'active') as monthly_subscribers,
  COUNT(*) FILTER (WHERE plan = 'yearly' AND status = 'active') as yearly_subscribers
FROM subscriptions;

-- ============================================
-- 7. 创建触发器：自动更新 updated_at
-- ============================================
CREATE OR REPLACE FUNCTION update_subscription_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_subscriptions_updated_at ON subscriptions;
CREATE TRIGGER trigger_subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION update_subscription_timestamp();

-- ============================================
-- 8. 创建触发器：同步 user_profiles.subscription_tier
-- ============================================
CREATE OR REPLACE FUNCTION sync_user_subscription_tier()
RETURNS TRIGGER AS $$
BEGIN
  -- 当订阅状态变为 active 时，更新用户 tier
  IF NEW.status = 'active' THEN
    UPDATE user_profiles
    SET subscription_tier = NEW.tier,
        updated_at = NOW()
    WHERE id = NEW.user_id;
  -- 当订阅取消或过期时，重置为 free
  ELSIF NEW.status IN ('canceled', 'expired', 'unpaid') THEN
    UPDATE user_profiles
    SET subscription_tier = 'free',
        updated_at = NOW()
    WHERE id = NEW.user_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_sync_subscription_tier ON subscriptions;
CREATE TRIGGER trigger_sync_subscription_tier
  AFTER INSERT OR UPDATE ON subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION sync_user_subscription_tier();

-- ============================================
-- 完成
-- ============================================
-- 功能说明：
-- 1. user_profiles 扩展：支持 Stripe Customer ID 和订阅等级
-- 2. subscriptions 表：存储用户订阅信息
-- 3. payment_history 表：存储付款记录
-- 4. 辅助函数：检查 Pro 状态、获取订阅等级
-- 5. 自动同步：订阅状态变化时自动更新用户 tier
--
-- 环境变量配置（添加到 .env.local）：
-- STRIPE_SECRET_KEY=sk_test_xxx
-- STRIPE_WEBHOOK_SECRET=whsec_xxx
-- STRIPE_PRICE_MONTHLY_ID=price_xxx
-- STRIPE_PRICE_YEARLY_ID=price_xxx
