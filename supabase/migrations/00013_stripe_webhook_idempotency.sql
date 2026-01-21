-- Stripe Webhook 幂等性支持
-- 版本: 00013
-- 创建日期: 2026-01-21
-- 说明: 创建 stripe_events 表用于存储已处理的 Stripe 事件，防止重复处理

-- ============================================
-- 创建 stripe_events 表
-- ============================================

CREATE TABLE IF NOT EXISTS stripe_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL UNIQUE,          -- Stripe 事件 ID (evt_xxx)
  event_type TEXT NOT NULL,                -- 事件类型 (checkout.session.completed 等)
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload JSONB,                           -- 可选：存储事件负载用于审计
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 创建索引用于快速查找
CREATE INDEX IF NOT EXISTS idx_stripe_events_event_id ON stripe_events(event_id);
CREATE INDEX IF NOT EXISTS idx_stripe_events_event_type ON stripe_events(event_type);
CREATE INDEX IF NOT EXISTS idx_stripe_events_processed_at ON stripe_events(processed_at);

-- 添加注释
COMMENT ON TABLE stripe_events IS 'Stripe webhook 事件去重表，用于实现幂等性';
COMMENT ON COLUMN stripe_events.event_id IS 'Stripe 事件唯一标识符 (evt_xxx)';
COMMENT ON COLUMN stripe_events.event_type IS '事件类型，如 checkout.session.completed';
COMMENT ON COLUMN stripe_events.payload IS '事件负载 JSON，用于审计和调试';

-- ============================================
-- RLS 策略
-- ============================================

-- 启用 RLS
ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;

-- 只允许服务端角色访问此表（webhook 使用 service role）
CREATE POLICY "Service role only" ON stripe_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================
-- 清理函数：删除 30 天前的事件记录
-- ============================================

CREATE OR REPLACE FUNCTION cleanup_old_stripe_events()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM stripe_events
  WHERE processed_at < NOW() - INTERVAL '30 days';

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION cleanup_old_stripe_events IS '清理 30 天前的 Stripe 事件记录，减少表膨胀';

-- ============================================
-- 授权
-- ============================================

-- 授予 service_role 完全访问权限
GRANT ALL ON stripe_events TO service_role;

-- 授予 authenticated 用户无权限（此表仅服务端使用）
REVOKE ALL ON stripe_events FROM authenticated;
REVOKE ALL ON stripe_events FROM anon;
