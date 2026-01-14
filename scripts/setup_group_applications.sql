-- 小组申请功能相关表结构
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- ============================================
-- 1. 创建 group_applications 申请表
-- ============================================
CREATE TABLE IF NOT EXISTS group_applications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  applicant_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                 -- 小组名（中文）
  name_en TEXT,                       -- 小组名（英文）
  description TEXT,                   -- 小组简介（中文）
  description_en TEXT,                -- 小组简介（英文）
  avatar_url TEXT,                    -- 小组头像
  role_names JSONB DEFAULT '{
    "admin": {"zh": "管理员", "en": "Admin"},
    "member": {"zh": "成员", "en": "Member"}
  }'::jsonb,                          -- 角色称呼（admin包含组长和管理员）
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reject_reason TEXT,                 -- 拒绝原因
  created_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_group_applications_applicant ON group_applications(applicant_id);
CREATE INDEX IF NOT EXISTS idx_group_applications_status ON group_applications(status);
CREATE INDEX IF NOT EXISTS idx_group_applications_created ON group_applications(created_at DESC);

-- RLS 策略
ALTER TABLE group_applications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own applications" ON group_applications;
DROP POLICY IF EXISTS "Users can create applications" ON group_applications;
DROP POLICY IF EXISTS "Admins can view all applications" ON group_applications;
DROP POLICY IF EXISTS "Admins can update applications" ON group_applications;

-- 用户可以查看自己的申请
CREATE POLICY "Users can view their own applications"
  ON group_applications FOR SELECT
  USING (auth.uid() = applicant_id);

-- 用户可以创建申请
CREATE POLICY "Users can create applications"
  ON group_applications FOR INSERT
  WITH CHECK (auth.uid() = applicant_id);

-- 管理员可以查看所有申请（通过 user_profiles.role = 'admin'）
CREATE POLICY "Admins can view all applications"
  ON group_applications FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- 管理员可以更新申请状态
CREATE POLICY "Admins can update applications"
  ON group_applications FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- ============================================
-- 2. 更新 groups 表结构
-- ============================================

-- 添加 name_en 字段（英文名称）
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'name_en'
  ) THEN
    ALTER TABLE groups ADD COLUMN name_en TEXT;
  END IF;
END $$;

-- 添加 description_en 字段（英文简介）
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'description_en'
  ) THEN
    ALTER TABLE groups ADD COLUMN description_en TEXT;
  END IF;
END $$;

-- 添加 role_names 字段（角色称呼）
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'role_names'
  ) THEN
    ALTER TABLE groups ADD COLUMN role_names JSONB DEFAULT '{
      "admin": {"zh": "管理员", "en": "Admin"},
      "member": {"zh": "成员", "en": "Member"}
    }'::jsonb;
  END IF;
END $$;

-- 添加 created_by 字段（创建者 ID）
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'created_by'
  ) THEN
    ALTER TABLE groups ADD COLUMN created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 添加 application_id 字段（关联的申请 ID）
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'application_id'
  ) THEN
    ALTER TABLE groups ADD COLUMN application_id UUID REFERENCES group_applications(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_groups_created_by ON groups(created_by);

-- ============================================
-- 3. 更新 group_members 表结构
-- ============================================

-- 添加 role 字段（成员角色：admin/member，admin包含组长和管理员）
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'group_members' AND column_name = 'role'
  ) THEN
    ALTER TABLE group_members ADD COLUMN role TEXT DEFAULT 'member' CHECK (role IN ('admin', 'member'));
  END IF;
END $$;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_group_members_role ON group_members(role);

-- ============================================
-- 4. 触发器：申请批准后自动创建小组
-- ============================================
CREATE OR REPLACE FUNCTION handle_group_application_approved()
RETURNS TRIGGER AS $$
DECLARE
  new_group_id UUID;
BEGIN
  -- 只在状态从非 approved 变为 approved 时触发
  IF NEW.status = 'approved' AND (OLD.status IS NULL OR OLD.status != 'approved') THEN
    -- 创建小组
    INSERT INTO groups (name, name_en, description, description_en, avatar_url, role_names, created_by, application_id, member_count)
    VALUES (NEW.name, NEW.name_en, NEW.description, NEW.description_en, NEW.avatar_url, NEW.role_names, NEW.applicant_id, NEW.id, 1)
    RETURNING id INTO new_group_id;
    
    -- 将申请者添加为管理员（组长）
    INSERT INTO group_members (group_id, user_id, role)
    VALUES (new_group_id, NEW.applicant_id, 'admin');
    
    -- 创建通知
    INSERT INTO notifications (user_id, type, title, message, link)
    VALUES (
      NEW.applicant_id,
      'system',
      '小组申请已通过',
      '您申请创建的小组「' || NEW.name || '」已通过审核！',
      '/groups/' || new_group_id
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_group_application_approved ON group_applications;
CREATE TRIGGER on_group_application_approved
  AFTER UPDATE ON group_applications
  FOR EACH ROW
  EXECUTE FUNCTION handle_group_application_approved();

-- ============================================
-- 5. 触发器：申请被拒绝时发送通知
-- ============================================
CREATE OR REPLACE FUNCTION handle_group_application_rejected()
RETURNS TRIGGER AS $$
BEGIN
  -- 只在状态从非 rejected 变为 rejected 时触发
  IF NEW.status = 'rejected' AND (OLD.status IS NULL OR OLD.status != 'rejected') THEN
    -- 创建通知
    INSERT INTO notifications (user_id, type, title, message, link)
    VALUES (
      NEW.applicant_id,
      'system',
      '小组申请未通过',
      '您申请创建的小组「' || NEW.name || '」未通过审核。' || 
        CASE WHEN NEW.reject_reason IS NOT NULL THEN '原因：' || NEW.reject_reason ELSE '' END,
      '/groups'
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_group_application_rejected ON group_applications;
CREATE TRIGGER on_group_application_rejected
  AFTER UPDATE ON group_applications
  FOR EACH ROW
  EXECUTE FUNCTION handle_group_application_rejected();

-- ============================================
-- 完成
-- ============================================
-- 运行此脚本后，小组申请功能的数据库结构就配置完成了。

