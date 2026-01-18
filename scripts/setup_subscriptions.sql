-- 订阅系统数据库表
-- 用于存储用户的 Stripe 订阅信息

-- ============================================
-- 订阅表
-- ============================================

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- 关联用户
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- Stripe 信息
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  
  -- 订阅状态
  tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'elite', 'enterprise')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trialing', 'past_due', 'cancelled', 'expired')),
  
  -- 订阅周期
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  
  -- 使用量跟踪
  api_calls_today INTEGER NOT NULL DEFAULT 0,
  api_calls_reset_at TIMESTAMPTZ DEFAULT NOW(),
  comparison_reports_this_month INTEGER NOT NULL DEFAULT 0,
  exports_this_month INTEGER NOT NULL DEFAULT 0,
  usage_reset_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- 时间戳
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 确保每个用户只有一条订阅记录
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);

-- Stripe 客户 ID 索引（用于 webhook 查找）
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer ON subscriptions(stripe_customer_id);

-- ============================================
-- 自动更新 updated_at 触发器
-- ============================================

CREATE OR REPLACE FUNCTION update_subscriptions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_subscriptions_updated_at ON subscriptions;
CREATE TRIGGER trg_subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION update_subscriptions_updated_at();

-- ============================================
-- 每日使用量重置函数
-- ============================================

CREATE OR REPLACE FUNCTION reset_daily_api_calls()
RETURNS void AS $$
BEGIN
  UPDATE subscriptions
  SET 
    api_calls_today = 0,
    api_calls_reset_at = NOW()
  WHERE api_calls_reset_at < NOW() - INTERVAL '1 day';
END;
$$ LANGUAGE plpgsql;

-- 每月使用量重置函数
CREATE OR REPLACE FUNCTION reset_monthly_usage()
RETURNS void AS $$
BEGIN
  UPDATE subscriptions
  SET 
    comparison_reports_this_month = 0,
    exports_this_month = 0,
    usage_reset_at = NOW()
  WHERE usage_reset_at < NOW() - INTERVAL '1 month';
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 行级安全策略
-- ============================================

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- 用户只能查看自己的订阅
DROP POLICY IF EXISTS "Users can view own subscription" ON subscriptions;
CREATE POLICY "Users can view own subscription" ON subscriptions
  FOR SELECT
  USING (auth.uid() = user_id);

-- 只有服务端可以修改订阅（通过 service_role key）
DROP POLICY IF EXISTS "Service role can manage subscriptions" ON subscriptions;
CREATE POLICY "Service role can manage subscriptions" ON subscriptions
  FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================
-- 辅助视图：用户订阅状态
-- ============================================

CREATE OR REPLACE VIEW user_subscription_status AS
SELECT 
  s.user_id,
  s.tier,
  s.status,
  s.current_period_end,
  CASE 
    WHEN s.status = 'active' AND s.tier != 'free' THEN true
    WHEN s.status = 'trialing' THEN true
    ELSE false
  END AS is_premium,
  CASE 
    WHEN s.current_period_end IS NOT NULL AND s.current_period_end < NOW() THEN true
    ELSE false
  END AS is_expired
FROM subscriptions s;

-- ============================================
-- 初始化：为现有用户创建免费订阅
-- ============================================

INSERT INTO subscriptions (user_id, tier, status)
SELECT id, 'free', 'active'
FROM auth.users
WHERE NOT EXISTS (
  SELECT 1 FROM subscriptions WHERE subscriptions.user_id = auth.users.id
)
ON CONFLICT (user_id) DO NOTHING;

-- ============================================
-- 使用示例
-- ============================================

-- 1. 查询用户订阅状态：
-- SELECT * FROM user_subscription_status WHERE user_id = 'xxx';

-- 2. 检查用户是否为付费用户：
-- SELECT is_premium FROM user_subscription_status WHERE user_id = 'xxx';

-- 3. 增加 API 调用计数：
-- UPDATE subscriptions SET api_calls_today = api_calls_today + 1 WHERE user_id = 'xxx';

-- 4. 重置每日使用量（由 cron 调用）：
-- SELECT reset_daily_api_calls();
