-- 打赏系统数据库表
-- 用于存储帖子打赏记录

-- ============================================
-- 打赏记录表
-- ============================================

CREATE TABLE IF NOT EXISTS tips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- 帖子信息
  post_id UUID NOT NULL,
  
  -- 用户信息
  from_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  to_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  
  -- 金额（美分）
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  
  -- Stripe 支付信息
  stripe_payment_intent_id TEXT,
  stripe_checkout_session_id TEXT,
  
  -- 状态: pending, completed, failed, refunded
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  
  -- 备注
  message TEXT,
  
  -- 时间戳
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_tips_post_id ON tips(post_id);
CREATE INDEX IF NOT EXISTS idx_tips_from_user ON tips(from_user_id);
CREATE INDEX IF NOT EXISTS idx_tips_to_user ON tips(to_user_id);
CREATE INDEX IF NOT EXISTS idx_tips_status ON tips(status);
CREATE INDEX IF NOT EXISTS idx_tips_stripe_session ON tips(stripe_checkout_session_id);
CREATE INDEX IF NOT EXISTS idx_tips_stripe_intent ON tips(stripe_payment_intent_id);

-- ============================================
-- 行级安全策略
-- ============================================

ALTER TABLE tips ENABLE ROW LEVEL SECURITY;

-- 用户可以查看自己发送或收到的打赏
DROP POLICY IF EXISTS "Users can view own tips" ON tips;
CREATE POLICY "Users can view own tips" ON tips
  FOR SELECT
  USING (auth.uid() = from_user_id OR auth.uid() = to_user_id);

-- 用户只能创建自己发送的打赏（pending 状态）
DROP POLICY IF EXISTS "Users can create tips" ON tips;
CREATE POLICY "Users can create tips" ON tips
  FOR INSERT
  WITH CHECK (auth.uid() = from_user_id AND status = 'pending');

-- 只有服务端可以更新打赏状态
DROP POLICY IF EXISTS "Service role can manage tips" ON tips;
CREATE POLICY "Service role can manage tips" ON tips
  FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================
-- 打赏统计视图
-- ============================================

CREATE OR REPLACE VIEW user_tip_stats AS
SELECT 
  u.id AS user_id,
  COALESCE(sent.total_sent, 0) AS total_tips_sent,
  COALESCE(sent.count_sent, 0) AS tips_sent_count,
  COALESCE(received.total_received, 0) AS total_tips_received,
  COALESCE(received.count_received, 0) AS tips_received_count
FROM auth.users u
LEFT JOIN (
  SELECT 
    from_user_id,
    SUM(amount_cents) AS total_sent,
    COUNT(*) AS count_sent
  FROM tips 
  WHERE status = 'completed'
  GROUP BY from_user_id
) sent ON u.id = sent.from_user_id
LEFT JOIN (
  SELECT 
    to_user_id,
    SUM(amount_cents) AS total_received,
    COUNT(*) AS count_received
  FROM tips 
  WHERE status = 'completed'
  GROUP BY to_user_id
) received ON u.id = received.to_user_id;

-- ============================================
-- 帖子打赏统计
-- ============================================

CREATE OR REPLACE VIEW post_tip_stats AS
SELECT 
  post_id,
  SUM(amount_cents) AS total_tips,
  COUNT(*) AS tip_count
FROM tips
WHERE status = 'completed'
GROUP BY post_id;

-- ============================================
-- 如果有旧的 gifts 表，迁移数据
-- ============================================

-- INSERT INTO tips (post_id, from_user_id, to_user_id, amount_cents, status, created_at)
-- SELECT post_id, from_user_id, to_user_id, amount_cents, 'completed', created_at
-- FROM gifts
-- ON CONFLICT DO NOTHING;
