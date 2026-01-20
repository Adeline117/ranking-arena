-- Pro 会员官方群聊系统
-- 所有 Pro 会员自动加入官方群，500人一个群
-- 群主：adelinewen1107@outlook.com
-- 在 Supabase Dashboard 的 SQL Editor 中运行此脚本

-- ============================================
-- 1. 创建 Pro 官方群配置表
-- ============================================
CREATE TABLE IF NOT EXISTS pro_official_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 对应的 groups 表 ID
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  -- 群序号（第1群、第2群...）
  group_number INTEGER NOT NULL UNIQUE,
  -- 当前成员数
  current_member_count INTEGER DEFAULT 0,
  -- 最大成员数
  max_members INTEGER DEFAULT 500,
  -- 是否已满
  is_full BOOLEAN GENERATED ALWAYS AS (current_member_count >= max_members) STORED,
  -- 是否激活（用于接收新成员）
  is_active BOOLEAN DEFAULT true,
  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_pro_official_groups_active ON pro_official_groups(is_active, is_full);
CREATE INDEX IF NOT EXISTS idx_pro_official_groups_number ON pro_official_groups(group_number);

-- ============================================
-- 2. 创建 Pro 会员群成员记录表
-- ============================================
CREATE TABLE IF NOT EXISTS pro_official_group_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 用户 ID
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- 官方群配置 ID
  pro_group_id UUID NOT NULL REFERENCES pro_official_groups(id) ON DELETE CASCADE,
  -- 加入时间
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  -- 唯一约束：一个用户只能在一个官方群
  UNIQUE(user_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_pro_official_members_user ON pro_official_group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_pro_official_members_group ON pro_official_group_members(pro_group_id);

-- RLS 策略
ALTER TABLE pro_official_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE pro_official_group_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Pro official groups are viewable by pro members" ON pro_official_groups;
CREATE POLICY "Pro official groups are viewable by pro members"
  ON pro_official_groups FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM subscriptions 
      WHERE user_id = auth.uid() AND tier = 'pro' AND status = 'active'
    )
  );

DROP POLICY IF EXISTS "Pro members can view their membership" ON pro_official_group_members;
CREATE POLICY "Pro members can view their membership"
  ON pro_official_group_members FOR SELECT
  USING (auth.uid() = user_id);

-- ============================================
-- 3. 更新成员计数的触发器
-- ============================================
CREATE OR REPLACE FUNCTION update_pro_official_group_member_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE pro_official_groups 
    SET current_member_count = current_member_count + 1,
        updated_at = NOW()
    WHERE id = NEW.pro_group_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE pro_official_groups 
    SET current_member_count = current_member_count - 1,
        updated_at = NOW()
    WHERE id = OLD.pro_group_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_pro_official_member_count ON pro_official_group_members;
CREATE TRIGGER trigger_pro_official_member_count
  AFTER INSERT OR DELETE ON pro_official_group_members
  FOR EACH ROW
  EXECUTE FUNCTION update_pro_official_group_member_count();

-- ============================================
-- 4. 获取可用的官方群（未满的最小序号群）
-- ============================================
CREATE OR REPLACE FUNCTION get_available_pro_official_group()
RETURNS UUID AS $$
DECLARE
  v_group_id UUID;
BEGIN
  -- 获取未满且激活的最小序号群
  SELECT id INTO v_group_id
  FROM pro_official_groups
  WHERE is_active = true AND current_member_count < max_members
  ORDER BY group_number ASC
  LIMIT 1;
  
  RETURN v_group_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 5. 创建新的官方群
-- ============================================
CREATE OR REPLACE FUNCTION create_new_pro_official_group(p_owner_id UUID)
RETURNS UUID AS $$
DECLARE
  v_next_number INTEGER;
  v_group_id UUID;
  v_pro_group_id UUID;
BEGIN
  -- 获取下一个群序号
  SELECT COALESCE(MAX(group_number), 0) + 1 INTO v_next_number
  FROM pro_official_groups;
  
  -- 创建群组
  INSERT INTO groups (
    name, 
    name_en,
    description, 
    description_en,
    created_by,
    visibility,
    is_premium_only
  ) VALUES (
    'Arena Pro 会员群 #' || v_next_number,
    'Arena Pro Member Group #' || v_next_number,
    '欢迎加入 Arena Pro 会员专属群！在这里可以与其他 Pro 会员交流心得、获取官方支持。有问题可以直接在群里提问，我们会尽快回复。',
    'Welcome to the Arena Pro Member exclusive group! Chat with other Pro members, share tips, and get official support. Feel free to ask any questions here.',
    p_owner_id,
    'private',
    true
  ) RETURNING id INTO v_group_id;
  
  -- 创建官方群配置
  INSERT INTO pro_official_groups (group_id, group_number)
  VALUES (v_group_id, v_next_number)
  RETURNING id INTO v_pro_group_id;
  
  -- 将群主加入群成员
  INSERT INTO group_members (group_id, user_id, role)
  VALUES (v_group_id, p_owner_id, 'owner')
  ON CONFLICT DO NOTHING;
  
  RETURN v_pro_group_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 6. Pro 会员自动加入官方群
-- ============================================
CREATE OR REPLACE FUNCTION join_pro_official_group(p_user_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_pro_group_id UUID;
  v_group_id UUID;
  v_existing_membership UUID;
  v_owner_id UUID;
BEGIN
  -- 检查用户是否已经在某个官方群
  SELECT id INTO v_existing_membership
  FROM pro_official_group_members
  WHERE user_id = p_user_id;
  
  IF v_existing_membership IS NOT NULL THEN
    -- 已经是成员，返回现有信息
    SELECT pog.group_id INTO v_group_id
    FROM pro_official_group_members pogm
    JOIN pro_official_groups pog ON pog.id = pogm.pro_group_id
    WHERE pogm.user_id = p_user_id;
    
    RETURN jsonb_build_object(
      'success', true,
      'message', 'already_member',
      'group_id', v_group_id
    );
  END IF;
  
  -- 获取可用的官方群
  v_pro_group_id := get_available_pro_official_group();
  
  -- 如果没有可用的群，创建新群
  IF v_pro_group_id IS NULL THEN
    -- 获取群主 ID（adelinewen1107@outlook.com）
    SELECT id INTO v_owner_id
    FROM auth.users
    WHERE email = 'adelinewen1107@outlook.com';
    
    IF v_owner_id IS NULL THEN
      -- 备用：从 user_profiles 查找
      SELECT id INTO v_owner_id
      FROM user_profiles
      WHERE email = 'adelinewen1107@outlook.com'
      LIMIT 1;
    END IF;
    
    IF v_owner_id IS NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'message', 'owner_not_found'
      );
    END IF;
    
    v_pro_group_id := create_new_pro_official_group(v_owner_id);
  END IF;
  
  -- 获取群 ID
  SELECT group_id INTO v_group_id
  FROM pro_official_groups
  WHERE id = v_pro_group_id;
  
  -- 加入官方群记录
  INSERT INTO pro_official_group_members (user_id, pro_group_id)
  VALUES (p_user_id, v_pro_group_id);
  
  -- 加入 group_members
  INSERT INTO group_members (group_id, user_id, role)
  VALUES (v_group_id, p_user_id, 'member')
  ON CONFLICT DO NOTHING;
  
  RETURN jsonb_build_object(
    'success', true,
    'message', 'joined',
    'group_id', v_group_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 7. Pro 会员离开官方群（取消订阅时调用）
-- ============================================
CREATE OR REPLACE FUNCTION leave_pro_official_group(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_group_id UUID;
BEGIN
  -- 获取用户所在的官方群
  SELECT pog.group_id INTO v_group_id
  FROM pro_official_group_members pogm
  JOIN pro_official_groups pog ON pog.id = pogm.pro_group_id
  WHERE pogm.user_id = p_user_id;
  
  IF v_group_id IS NULL THEN
    RETURN false;
  END IF;
  
  -- 从官方群记录中删除
  DELETE FROM pro_official_group_members
  WHERE user_id = p_user_id;
  
  -- 从 group_members 中删除
  DELETE FROM group_members
  WHERE group_id = v_group_id AND user_id = p_user_id;
  
  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 8. 获取用户的官方群信息
-- ============================================
CREATE OR REPLACE FUNCTION get_user_pro_official_group(p_user_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'group_id', g.id,
    'group_name', g.name,
    'group_number', pog.group_number,
    'member_count', pog.current_member_count,
    'max_members', pog.max_members,
    'joined_at', pogm.joined_at
  ) INTO v_result
  FROM pro_official_group_members pogm
  JOIN pro_official_groups pog ON pog.id = pogm.pro_group_id
  JOIN groups g ON g.id = pog.group_id
  WHERE pogm.user_id = p_user_id;
  
  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 完成
-- ============================================
-- 功能说明：
-- 1. pro_official_groups: 管理官方 Pro 会员群配置（500人上限）
-- 2. pro_official_group_members: 记录会员所在的官方群
-- 3. 自动加入: 新 Pro 会员自动加入未满的官方群
-- 4. 自动创建: 当所有群都满时，自动创建新群
-- 5. 群主固定: adelinewen1107@outlook.com
-- 6. 取消订阅时自动离群
