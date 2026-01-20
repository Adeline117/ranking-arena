-- 管理后台功能增强
-- 版本: 1.0.0
-- 创建日期: 2026-01-19

-- ============================================
-- 1. 用户封禁相关字段
-- ============================================

-- 添加封禁时间
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_profiles' AND column_name = 'banned_at'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN banned_at TIMESTAMPTZ;
  END IF;
END $$;

-- 添加封禁原因
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_profiles' AND column_name = 'banned_reason'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN banned_reason TEXT;
  END IF;
END $$;

-- 添加封禁操作者
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_profiles' AND column_name = 'banned_by'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN banned_by UUID REFERENCES auth.users(id);
  END IF;
END $$;

-- 创建封禁用户索引
CREATE INDEX IF NOT EXISTS idx_user_profiles_banned ON user_profiles(banned_at) WHERE banned_at IS NOT NULL;

-- ============================================
-- 2. 内容举报表
-- ============================================

CREATE TABLE IF NOT EXISTS content_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type IN ('post', 'comment')),
  content_id UUID NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('spam', 'harassment', 'inappropriate', 'misinformation', 'other')),
  description TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  resolved_by UUID REFERENCES auth.users(id),
  resolved_at TIMESTAMPTZ,
  action_taken TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_content_reports_status ON content_reports(status);
CREATE INDEX IF NOT EXISTS idx_content_reports_content ON content_reports(content_type, content_id);
CREATE INDEX IF NOT EXISTS idx_content_reports_reporter ON content_reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_content_reports_created ON content_reports(created_at DESC);

-- RLS 策略
ALTER TABLE content_reports ENABLE ROW LEVEL SECURITY;

-- 用户可以查看自己提交的举报
DROP POLICY IF EXISTS "Users can view own reports" ON content_reports;
CREATE POLICY "Users can view own reports"
  ON content_reports FOR SELECT
  USING (auth.uid() = reporter_id);

-- 用户可以创建举报
DROP POLICY IF EXISTS "Users can create reports" ON content_reports;
CREATE POLICY "Users can create reports"
  ON content_reports FOR INSERT
  WITH CHECK (auth.uid() = reporter_id);

-- 管理员可以查看所有举报
DROP POLICY IF EXISTS "Admins can view all reports" ON content_reports;
CREATE POLICY "Admins can view all reports"
  ON content_reports FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- 管理员可以更新举报状态
DROP POLICY IF EXISTS "Admins can update reports" ON content_reports;
CREATE POLICY "Admins can update reports"
  ON content_reports FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- ============================================
-- 3. 管理员操作日志表
-- ============================================

CREATE TABLE IF NOT EXISTS admin_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id UUID,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_admin_logs_admin ON admin_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_logs_action ON admin_logs(action);
CREATE INDEX IF NOT EXISTS idx_admin_logs_created ON admin_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_logs_target ON admin_logs(target_type, target_id);

-- RLS 策略
ALTER TABLE admin_logs ENABLE ROW LEVEL SECURITY;

-- 只有管理员可以查看日志
DROP POLICY IF EXISTS "Admins can view logs" ON admin_logs;
CREATE POLICY "Admins can view logs"
  ON admin_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- 只有管理员可以创建日志
DROP POLICY IF EXISTS "Admins can create logs" ON admin_logs;
CREATE POLICY "Admins can create logs"
  ON admin_logs FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- ============================================
-- 4. 报警配置表
-- ============================================

CREATE TABLE IF NOT EXISTS alert_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT UNIQUE NOT NULL,
  value TEXT,
  enabled BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id)
);

-- 初始化默认配置
INSERT INTO alert_config (key, value, enabled) VALUES
  ('slack_webhook_url', NULL, false),
  ('feishu_webhook_url', NULL, false),
  ('alert_email', NULL, false)
ON CONFLICT (key) DO NOTHING;

-- RLS 策略
ALTER TABLE alert_config ENABLE ROW LEVEL SECURITY;

-- 只有管理员可以查看配置
DROP POLICY IF EXISTS "Admins can view alert config" ON alert_config;
CREATE POLICY "Admins can view alert config"
  ON alert_config FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- 只有管理员可以更新配置
DROP POLICY IF EXISTS "Admins can update alert config" ON alert_config;
CREATE POLICY "Admins can update alert config"
  ON alert_config FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- 只有管理员可以插入配置
DROP POLICY IF EXISTS "Admins can insert alert config" ON alert_config;
CREATE POLICY "Admins can insert alert config"
  ON alert_config FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- ============================================
-- 5. 确保 user_profiles 有 role 字段
-- ============================================

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'user_profiles' AND column_name = 'role'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN role TEXT DEFAULT 'user' CHECK (role IN ('user', 'admin'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_profiles_role ON user_profiles(role);

-- ============================================
-- 完成
-- ============================================
