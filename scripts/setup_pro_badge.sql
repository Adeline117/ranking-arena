-- Pro 徽章显示设置
-- 在 user_profiles 表添加 show_pro_badge 字段
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- ============================================
-- 1. 添加 show_pro_badge 字段
-- ============================================
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_profiles' AND column_name = 'show_pro_badge'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN show_pro_badge BOOLEAN DEFAULT true;
    RAISE NOTICE 'Added show_pro_badge column to user_profiles';
  ELSE
    RAISE NOTICE 'show_pro_badge column already exists';
  END IF;
END $$;

-- ============================================
-- 2. 创建视图：用户会员状态（包含徽章显示设置）
-- ============================================
CREATE OR REPLACE VIEW user_membership_status AS
SELECT 
  up.id as user_id,
  up.handle,
  up.avatar_url,
  up.show_pro_badge,
  COALESCE(s.tier, 'free') as tier,
  COALESCE(s.status, 'active') as subscription_status,
  s.current_period_end as subscription_expires_at,
  CASE 
    WHEN s.tier IN ('pro', 'elite', 'enterprise') AND s.status = 'active' 
    THEN true 
    ELSE false 
  END as is_premium,
  CASE 
    WHEN s.tier IN ('pro', 'elite', 'enterprise') AND s.status = 'active' AND up.show_pro_badge = true
    THEN s.tier
    ELSE NULL
  END as display_badge_tier
FROM user_profiles up
LEFT JOIN subscriptions s ON s.user_id = up.id;

-- ============================================
-- 3. 创建函数：获取用户是否显示徽章
-- ============================================
CREATE OR REPLACE FUNCTION get_user_badge_tier(p_user_id UUID)
RETURNS TEXT AS $$
DECLARE
  v_tier TEXT;
  v_show_badge BOOLEAN;
  v_status TEXT;
BEGIN
  -- 获取用户设置
  SELECT show_pro_badge INTO v_show_badge
  FROM user_profiles WHERE id = p_user_id;
  
  -- 如果不显示徽章，返回 NULL
  IF v_show_badge IS NOT TRUE THEN
    RETURN NULL;
  END IF;
  
  -- 获取订阅状态
  SELECT tier, status INTO v_tier, v_status
  FROM subscriptions 
  WHERE user_id = p_user_id;
  
  -- 检查是否为有效会员
  IF v_tier IN ('pro', 'elite', 'enterprise') AND v_status = 'active' THEN
    RETURN v_tier;
  END IF;
  
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 完成
-- ============================================
-- 功能说明：
-- 1. show_pro_badge: 用户可在隐私设置中控制是否显示 Pro 徽章
-- 2. user_membership_status 视图: 方便查询用户的会员状态和徽章显示
-- 3. get_user_badge_tier 函数: 获取应该显示的徽章等级（考虑用户设置）
