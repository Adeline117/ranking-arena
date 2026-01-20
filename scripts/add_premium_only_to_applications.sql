-- 添加 is_premium_only 字段到 group_applications 表
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- ============================================
-- 1. 给 group_applications 表添加 is_premium_only 字段
-- ============================================
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'group_applications' AND column_name = 'is_premium_only'
  ) THEN
    ALTER TABLE group_applications ADD COLUMN is_premium_only BOOLEAN DEFAULT false;
  END IF;
END $$;

-- ============================================
-- 2. 更新触发器：申请批准后自动创建小组（包含 is_premium_only）
-- ============================================
CREATE OR REPLACE FUNCTION handle_group_application_approved()
RETURNS TRIGGER AS $$
DECLARE
  new_group_id UUID;
BEGIN
  -- 只在状态从非 approved 变为 approved 时触发
  IF NEW.status = 'approved' AND (OLD.status IS NULL OR OLD.status != 'approved') THEN
    -- 创建小组（包含规则字段和 is_premium_only）
    INSERT INTO groups (
      name, name_en, description, description_en, avatar_url, 
      role_names, created_by, application_id, member_count,
      rules, rules_en, rules_json, is_premium_only
    )
    VALUES (
      NEW.name, NEW.name_en, NEW.description, NEW.description_en, NEW.avatar_url, 
      NEW.role_names, NEW.applicant_id, NEW.id, 1,
      NEW.rules, NEW.rules_en, COALESCE(NEW.rules_json, '[]'::jsonb),
      COALESCE(NEW.is_premium_only, false)
    )
    RETURNING id INTO new_group_id;
    
    -- 将申请者添加为组长（owner）
    INSERT INTO group_members (group_id, user_id, role)
    VALUES (new_group_id, NEW.applicant_id, 'owner');
    
    -- 创建通知（中英文）
    INSERT INTO notifications (user_id, type, title, message, link)
    VALUES (
      NEW.applicant_id,
      'system',
      CASE WHEN NEW.is_premium_only THEN 'Pro 专属小组申请已通过' ELSE '小组申请已通过' END,
      '您申请创建的' || CASE WHEN NEW.is_premium_only THEN 'Pro 专属' ELSE '' END || '小组「' || NEW.name || '」已通过审核！',
      '/groups/' || new_group_id
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 重新创建触发器
DROP TRIGGER IF EXISTS on_group_application_approved ON group_applications;
CREATE TRIGGER on_group_application_approved
  AFTER UPDATE ON group_applications
  FOR EACH ROW
  EXECUTE FUNCTION handle_group_application_approved();

-- ============================================
-- 完成
-- ============================================
-- 此脚本添加了：
-- 1. group_applications.is_premium_only 字段
-- 2. 更新触发器以在创建小组时传递 is_premium_only
