-- Pro 专属群组功能数据库扩展
-- 组长和组员都必须是 Pro 会员才能创建和加入
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- ============================================
-- 1. 扩展 groups 表，添加付费相关字段
-- ============================================
DO $$ 
BEGIN
  -- 是否为付费群组
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'is_premium_only'
  ) THEN
    ALTER TABLE groups ADD COLUMN is_premium_only BOOLEAN DEFAULT false;
    RAISE NOTICE 'Added is_premium_only column';
  END IF;

  -- 月付价格
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'subscription_price_monthly'
  ) THEN
    ALTER TABLE groups ADD COLUMN subscription_price_monthly DECIMAL(10,2) DEFAULT 9.9;
    RAISE NOTICE 'Added subscription_price_monthly column';
  END IF;

  -- 年付价格
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'subscription_price_yearly'
  ) THEN
    ALTER TABLE groups ADD COLUMN subscription_price_yearly DECIMAL(10,2) DEFAULT 99.9;
    RAISE NOTICE 'Added subscription_price_yearly column';
  END IF;

  -- 原价（月付）- 用于显示划线价
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'original_price_monthly'
  ) THEN
    ALTER TABLE groups ADD COLUMN original_price_monthly DECIMAL(10,2) DEFAULT 15;
    RAISE NOTICE 'Added original_price_monthly column';
  END IF;

  -- 原价（年付）- 用于显示划线价
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'original_price_yearly'
  ) THEN
    ALTER TABLE groups ADD COLUMN original_price_yearly DECIMAL(10,2) DEFAULT 180;
    RAISE NOTICE 'Added original_price_yearly column';
  END IF;

  -- 是否允许试用
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'allow_trial'
  ) THEN
    ALTER TABLE groups ADD COLUMN allow_trial BOOLEAN DEFAULT false;
    RAISE NOTICE 'Added allow_trial column';
  END IF;

  -- 试用天数
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'trial_days'
  ) THEN
    ALTER TABLE groups ADD COLUMN trial_days INTEGER DEFAULT 7;
    RAISE NOTICE 'Added trial_days column';
  END IF;
END $$;

-- ============================================
-- 2. 创建群组订阅表
-- ============================================
CREATE TABLE IF NOT EXISTS group_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- 订阅类型
  tier TEXT NOT NULL CHECK (tier IN ('monthly', 'yearly', 'trial')),
  -- 订阅状态
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired', 'trialing')),
  -- 价格（订阅时的价格，用于记录）
  price_paid DECIMAL(10,2),
  -- 时间信息
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  cancelled_at TIMESTAMPTZ,
  -- 支付信息
  payment_provider TEXT, -- 'stripe', 'paypal', etc.
  payment_reference TEXT, -- 支付ID/订单号
  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  -- 唯一约束：一个用户对一个群组只能有一个活跃订阅
  UNIQUE(group_id, user_id, status)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_group_subscriptions_group ON group_subscriptions(group_id);
CREATE INDEX IF NOT EXISTS idx_group_subscriptions_user ON group_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_group_subscriptions_status ON group_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_group_subscriptions_expires ON group_subscriptions(expires_at);

-- RLS 策略
ALTER TABLE group_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own subscriptions" ON group_subscriptions;
DROP POLICY IF EXISTS "Group owners can view group subscriptions" ON group_subscriptions;
DROP POLICY IF EXISTS "Users can create their own subscriptions" ON group_subscriptions;

CREATE POLICY "Users can view their own subscriptions"
  ON group_subscriptions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Group owners can view group subscriptions"
  ON group_subscriptions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM groups g 
      WHERE g.id = group_id AND g.created_by = auth.uid()
    )
  );

CREATE POLICY "Users can create their own subscriptions"
  ON group_subscriptions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- ============================================
-- 3. 更新 updated_at 触发器
-- ============================================
CREATE OR REPLACE FUNCTION update_group_subscriptions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_group_subscriptions_updated_at ON group_subscriptions;

CREATE TRIGGER trigger_update_group_subscriptions_updated_at
  BEFORE UPDATE ON group_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION update_group_subscriptions_updated_at();

-- ============================================
-- 4. 创建函数：检查用户是否有群组的有效订阅
-- ============================================
CREATE OR REPLACE FUNCTION has_valid_group_subscription(p_user_id UUID, p_group_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_has_subscription BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM group_subscriptions
    WHERE user_id = p_user_id 
      AND group_id = p_group_id
      AND status IN ('active', 'trialing')
      AND expires_at > NOW()
  ) INTO v_has_subscription;
  
  RETURN v_has_subscription;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 5. 创建函数：检查用户是否可以访问群组
-- ============================================
CREATE OR REPLACE FUNCTION can_access_group(p_user_id UUID, p_group_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_group RECORD;
  v_is_member BOOLEAN;
BEGIN
  -- 获取群组信息
  SELECT is_premium_only, created_by INTO v_group
  FROM groups WHERE id = p_group_id;
  
  -- 群组不存在
  IF v_group IS NULL THEN
    RETURN false;
  END IF;
  
  -- 群组创建者总是可以访问
  IF v_group.created_by = p_user_id THEN
    RETURN true;
  END IF;
  
  -- 检查是否为群组成员
  SELECT EXISTS (
    SELECT 1 FROM group_members 
    WHERE group_id = p_group_id AND user_id = p_user_id
  ) INTO v_is_member;
  
  -- 如果是非付费群组，成员可以访问
  IF NOT v_group.is_premium_only THEN
    RETURN v_is_member;
  END IF;
  
  -- 付费群组：需要有有效订阅
  RETURN has_valid_group_subscription(p_user_id, p_group_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 6. 创建视图：群组订阅统计
-- ============================================
CREATE OR REPLACE VIEW group_subscription_stats AS
SELECT 
  g.id as group_id,
  g.name,
  g.is_premium_only,
  g.subscription_price_monthly,
  g.subscription_price_yearly,
  COUNT(gs.id) FILTER (WHERE gs.status = 'active') as active_subscribers,
  COUNT(gs.id) FILTER (WHERE gs.status = 'trialing') as trial_users,
  COALESCE(SUM(gs.price_paid) FILTER (WHERE gs.status = 'active'), 0) as total_revenue
FROM groups g
LEFT JOIN group_subscriptions gs ON gs.group_id = g.id
WHERE g.is_premium_only = true
GROUP BY g.id, g.name, g.is_premium_only, g.subscription_price_monthly, g.subscription_price_yearly;

-- ============================================
-- 7. 创建函数：过期订阅自动更新状态
-- ============================================
CREATE OR REPLACE FUNCTION expire_group_subscriptions()
RETURNS INTEGER AS $$
DECLARE
  v_expired_count INTEGER;
BEGIN
  UPDATE group_subscriptions
  SET status = 'expired'
  WHERE status IN ('active', 'trialing')
    AND expires_at < NOW();
  
  GET DIAGNOSTICS v_expired_count = ROW_COUNT;
  RETURN v_expired_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 8. 创建函数：检查用户是否为 Pro 会员
-- ============================================
CREATE OR REPLACE FUNCTION is_pro_member(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_tier TEXT;
  v_status TEXT;
BEGIN
  SELECT tier, status INTO v_tier, v_status
  FROM subscriptions 
  WHERE user_id = p_user_id
    AND status = 'active';
  
  IF v_tier IN ('pro', 'elite', 'enterprise') AND v_status = 'active' THEN
    RETURN true;
  END IF;
  
  RETURN false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 9. 创建函数：检查用户是否可以创建 Pro 群组
-- ============================================
CREATE OR REPLACE FUNCTION can_create_pro_group(p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  -- 只有 Pro 会员才能创建 Pro 群组
  RETURN is_pro_member(p_user_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 10. 创建函数：检查用户是否可以加入 Pro 群组
-- ============================================
CREATE OR REPLACE FUNCTION can_join_pro_group(p_user_id UUID, p_group_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_is_premium_only BOOLEAN;
BEGIN
  -- 获取群组是否为 Pro 专属
  SELECT is_premium_only INTO v_is_premium_only
  FROM groups WHERE id = p_group_id;
  
  -- 非 Pro 群组任何人都可以加入
  IF NOT v_is_premium_only THEN
    RETURN true;
  END IF;
  
  -- Pro 群组只有 Pro 会员才能加入
  RETURN is_pro_member(p_user_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 完成
-- ============================================
-- 功能说明：
-- 1. groups 表扩展：支持设置 Pro 群组、定价、原价（划线价）
-- 2. group_subscriptions 表：管理用户的群组订阅
-- 3. 价格显示：~~$15/月~~ $9.9/月 | ~~$180/年~~ $99.9/年
-- 4. 函数支持：检查订阅有效性、访问权限
-- 5. Pro 群组：组长和组员都必须是 Pro 会员
-- 6. 支持试用期功能
