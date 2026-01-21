-- 小组管理系统完善 - 数据库迁移脚本
-- 包含：角色管理、禁言、投诉、竞选等功能

-- ============================================
-- 1. 修改 groups 表 - 添加多语言规则字段
-- ============================================

-- 添加规则 JSON 字段（支持多条规则，中英文）
-- 格式: [{"zh": "规则1中文", "en": "Rule 1 English"}, ...]
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'rules_json'
  ) THEN
    ALTER TABLE groups ADD COLUMN rules_json JSONB DEFAULT '[]'::jsonb;
  END IF;
END $$;

-- 添加英文规则字段（旧版兼容）
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'rules_en'
  ) THEN
    ALTER TABLE groups ADD COLUMN rules_en TEXT;
  END IF;
END $$;

-- 添加状态字段（是否有组长）
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'groups' AND column_name = 'has_owner'
  ) THEN
    ALTER TABLE groups ADD COLUMN has_owner BOOLEAN DEFAULT true;
  END IF;
END $$;

-- ============================================
-- 2. 修改 group_members 表 - 添加 owner 角色和禁言
-- ============================================

-- 修改 role 约束，添加 owner 角色
DO $$
BEGIN
  -- 先删除旧约束
  ALTER TABLE group_members DROP CONSTRAINT IF EXISTS group_members_role_check;
  
  -- 添加新约束
  ALTER TABLE group_members ADD CONSTRAINT group_members_role_check 
    CHECK (role IN ('owner', 'admin', 'member'));
EXCEPTION
  WHEN others THEN
    RAISE NOTICE 'Could not update group_members role constraint: %', SQLERRM;
END $$;

-- 添加禁言截止时间字段
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'group_members' AND column_name = 'muted_until'
  ) THEN
    ALTER TABLE group_members ADD COLUMN muted_until TIMESTAMPTZ;
  END IF;
END $$;

-- 添加禁言原因字段
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'group_members' AND column_name = 'mute_reason'
  ) THEN
    ALTER TABLE group_members ADD COLUMN mute_reason TEXT;
  END IF;
END $$;

-- 添加禁言操作人字段
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'group_members' AND column_name = 'muted_by'
  ) THEN
    ALTER TABLE group_members ADD COLUMN muted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_group_members_muted ON group_members(group_id, muted_until) WHERE muted_until IS NOT NULL;

-- ============================================
-- 3. 修改 posts 表 - 添加软删除字段
-- ============================================

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE posts ADD COLUMN deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'deleted_by'
  ) THEN
    ALTER TABLE posts ADD COLUMN deleted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'posts' AND column_name = 'delete_reason'
  ) THEN
    ALTER TABLE posts ADD COLUMN delete_reason TEXT;
  END IF;
END $$;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_posts_deleted ON posts(group_id, deleted_at) WHERE deleted_at IS NOT NULL;

-- ============================================
-- 4. 修改 comments 表 - 添加软删除字段
-- ============================================

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'comments' AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE comments ADD COLUMN deleted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'comments' AND column_name = 'deleted_by'
  ) THEN
    ALTER TABLE comments ADD COLUMN deleted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'comments' AND column_name = 'delete_reason'
  ) THEN
    ALTER TABLE comments ADD COLUMN delete_reason TEXT;
  END IF;
END $$;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_comments_deleted ON comments(deleted_at) WHERE deleted_at IS NOT NULL;

-- ============================================
-- 5. 创建 group_edit_applications 表（小组信息修改申请）
-- ============================================

CREATE TABLE IF NOT EXISTS group_edit_applications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  applicant_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- 修改的字段
  name TEXT,
  name_en TEXT,
  description TEXT,
  description_en TEXT,
  avatar_url TEXT,
  rules_json JSONB,
  rules TEXT,
  rules_en TEXT,
  role_names JSONB,
  -- 状态
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reject_reason TEXT,
  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_group_edit_applications_group ON group_edit_applications(group_id);
CREATE INDEX IF NOT EXISTS idx_group_edit_applications_status ON group_edit_applications(status);
CREATE INDEX IF NOT EXISTS idx_group_edit_applications_created ON group_edit_applications(created_at DESC);

-- RLS 策略
ALTER TABLE group_edit_applications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Group owners can view their applications" ON group_edit_applications;
DROP POLICY IF EXISTS "Group owners can create applications" ON group_edit_applications;
DROP POLICY IF EXISTS "Admins can view all edit applications" ON group_edit_applications;
DROP POLICY IF EXISTS "Admins can update edit applications" ON group_edit_applications;

CREATE POLICY "Group owners can view their applications"
  ON group_edit_applications FOR SELECT
  USING (auth.uid() = applicant_id);

CREATE POLICY "Group owners can create applications"
  ON group_edit_applications FOR INSERT
  WITH CHECK (auth.uid() = applicant_id);

CREATE POLICY "Admins can view all edit applications"
  ON group_edit_applications FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

CREATE POLICY "Admins can update edit applications"
  ON group_edit_applications FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles 
      WHERE user_profiles.id = auth.uid() 
      AND user_profiles.role = 'admin'
    )
  );

-- ============================================
-- 6. 创建 group_complaints 表（投诉记录）
-- ============================================

CREATE TABLE IF NOT EXISTS group_complaints (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  complainant_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_role TEXT NOT NULL CHECK (target_role IN ('owner', 'admin')),
  reason TEXT NOT NULL CHECK (char_length(reason) >= 30),
  -- 状态：pending=收集投诉, voting=投票中, resolved=已解决, dismissed=已驳回
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'voting', 'resolved', 'dismissed')),
  -- 投诉统计
  complaint_count INTEGER DEFAULT 1,
  -- 投票相关
  vote_started_at TIMESTAMPTZ,
  vote_end_at TIMESTAMPTZ,
  votes_for INTEGER DEFAULT 0,
  votes_against INTEGER DEFAULT 0,
  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  -- 每个小组同一时间只能有一个进行中的投诉
  UNIQUE(group_id, target_user_id, status) 
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_group_complaints_group ON group_complaints(group_id);
CREATE INDEX IF NOT EXISTS idx_group_complaints_status ON group_complaints(status);
CREATE INDEX IF NOT EXISTS idx_group_complaints_target ON group_complaints(target_user_id);
CREATE INDEX IF NOT EXISTS idx_group_complaints_voting ON group_complaints(group_id, status) WHERE status = 'voting';

-- RLS 策略
ALTER TABLE group_complaints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view complaints in their groups" ON group_complaints;
DROP POLICY IF EXISTS "Members can create complaints" ON group_complaints;
DROP POLICY IF EXISTS "System can update complaints" ON group_complaints;

CREATE POLICY "Members can view complaints in their groups"
  ON group_complaints FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM group_members 
      WHERE group_members.group_id = group_complaints.group_id 
      AND group_members.user_id = auth.uid()
    )
  );

CREATE POLICY "Members can create complaints"
  ON group_complaints FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM group_members 
      WHERE group_members.group_id = group_complaints.group_id 
      AND group_members.user_id = auth.uid()
    )
  );

CREATE POLICY "System can update complaints"
  ON group_complaints FOR UPDATE
  USING (true);

-- ============================================
-- 7. 创建 group_complaint_votes 表（投诉投票记录）
-- ============================================

CREATE TABLE IF NOT EXISTS group_complaint_votes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  complaint_id UUID NOT NULL REFERENCES group_complaints(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vote BOOLEAN NOT NULL, -- true=支持投诉, false=反对投诉
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(complaint_id, user_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_group_complaint_votes_complaint ON group_complaint_votes(complaint_id);
CREATE INDEX IF NOT EXISTS idx_group_complaint_votes_user ON group_complaint_votes(user_id);

-- RLS 策略
ALTER TABLE group_complaint_votes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view complaint votes" ON group_complaint_votes;
DROP POLICY IF EXISTS "Members can vote on complaints" ON group_complaint_votes;

CREATE POLICY "Members can view complaint votes"
  ON group_complaint_votes FOR SELECT
  USING (true);

CREATE POLICY "Members can vote on complaints"
  ON group_complaint_votes FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- ============================================
-- 8. 创建 group_complainants 表（投诉人记录）
-- ============================================

CREATE TABLE IF NOT EXISTS group_complainants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  complaint_id UUID NOT NULL REFERENCES group_complaints(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(complaint_id, user_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_group_complainants_complaint ON group_complainants(complaint_id);
CREATE INDEX IF NOT EXISTS idx_group_complainants_user ON group_complainants(user_id);

-- RLS 策略
ALTER TABLE group_complainants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view complainants" ON group_complainants;
DROP POLICY IF EXISTS "Users can add themselves as complainants" ON group_complainants;

CREATE POLICY "Users can view complainants"
  ON group_complainants FOR SELECT
  USING (true);

CREATE POLICY "Users can add themselves as complainants"
  ON group_complainants FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- ============================================
-- 9. 创建 group_leader_elections 表（组长竞选）
-- ============================================

CREATE TABLE IF NOT EXISTS group_leader_elections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  -- 状态：open=开放申请, voting=投票中, closed=已结束
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'voting', 'closed')),
  -- 时间
  started_at TIMESTAMPTZ DEFAULT NOW(),
  voting_started_at TIMESTAMPTZ,
  voting_end_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  -- 结果
  winner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- 每个小组同一时间只能有一个进行中的竞选
  UNIQUE(group_id, status)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_group_leader_elections_group ON group_leader_elections(group_id);
CREATE INDEX IF NOT EXISTS idx_group_leader_elections_status ON group_leader_elections(status);

-- RLS 策略
ALTER TABLE group_leader_elections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view elections" ON group_leader_elections;
DROP POLICY IF EXISTS "System can manage elections" ON group_leader_elections;

CREATE POLICY "Anyone can view elections"
  ON group_leader_elections FOR SELECT
  USING (true);

CREATE POLICY "System can manage elections"
  ON group_leader_elections FOR ALL
  USING (true);

-- ============================================
-- 10. 创建 group_leader_applications 表（组长竞选申请）
-- ============================================

CREATE TABLE IF NOT EXISTS group_leader_applications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  election_id UUID NOT NULL REFERENCES group_leader_elections(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  statement TEXT NOT NULL, -- 竞选宣言
  vote_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(election_id, user_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_group_leader_applications_election ON group_leader_applications(election_id);
CREATE INDEX IF NOT EXISTS idx_group_leader_applications_votes ON group_leader_applications(election_id, vote_count DESC);

-- RLS 策略
ALTER TABLE group_leader_applications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view leader applications" ON group_leader_applications;
DROP POLICY IF EXISTS "Members can apply for leader" ON group_leader_applications;

CREATE POLICY "Anyone can view leader applications"
  ON group_leader_applications FOR SELECT
  USING (true);

CREATE POLICY "Members can apply for leader"
  ON group_leader_applications FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- ============================================
-- 11. 创建 group_leader_votes 表（组长竞选投票）
-- ============================================

CREATE TABLE IF NOT EXISTS group_leader_votes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  election_id UUID NOT NULL REFERENCES group_leader_elections(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES group_leader_applications(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(election_id, user_id) -- 每人每次竞选只能投一票
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_group_leader_votes_election ON group_leader_votes(election_id);
CREATE INDEX IF NOT EXISTS idx_group_leader_votes_application ON group_leader_votes(application_id);

-- RLS 策略
ALTER TABLE group_leader_votes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view leader votes" ON group_leader_votes;
DROP POLICY IF EXISTS "Members can vote for leader" ON group_leader_votes;

CREATE POLICY "Anyone can view leader votes"
  ON group_leader_votes FOR SELECT
  USING (true);

CREATE POLICY "Members can vote for leader"
  ON group_leader_votes FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- ============================================
-- 12. 触发器：更新组长竞选投票计数
-- ============================================

CREATE OR REPLACE FUNCTION update_leader_application_vote_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE group_leader_applications
    SET vote_count = vote_count + 1
    WHERE id = NEW.application_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE group_leader_applications
    SET vote_count = vote_count - 1
    WHERE id = OLD.application_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_leader_vote_count ON group_leader_votes;
CREATE TRIGGER trigger_update_leader_vote_count
  AFTER INSERT OR DELETE ON group_leader_votes
  FOR EACH ROW
  EXECUTE FUNCTION update_leader_application_vote_count();

-- ============================================
-- 13. 触发器：更新投诉投票计数
-- ============================================

CREATE OR REPLACE FUNCTION update_complaint_vote_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.vote THEN
      UPDATE group_complaints SET votes_for = votes_for + 1 WHERE id = NEW.complaint_id;
    ELSE
      UPDATE group_complaints SET votes_against = votes_against + 1 WHERE id = NEW.complaint_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.vote THEN
      UPDATE group_complaints SET votes_for = votes_for - 1 WHERE id = OLD.complaint_id;
    ELSE
      UPDATE group_complaints SET votes_against = votes_against - 1 WHERE id = OLD.complaint_id;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_complaint_vote_count ON group_complaint_votes;
CREATE TRIGGER trigger_update_complaint_vote_count
  AFTER INSERT OR DELETE ON group_complaint_votes
  FOR EACH ROW
  EXECUTE FUNCTION update_complaint_vote_count();

-- ============================================
-- 14. 触发器：小组信息修改申请批准后自动更新小组
-- ============================================

CREATE OR REPLACE FUNCTION handle_group_edit_approved()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'approved' AND (OLD.status IS NULL OR OLD.status != 'approved') THEN
    -- 更新小组信息（只更新非空字段）
    UPDATE groups SET
      name = COALESCE(NEW.name, groups.name),
      name_en = COALESCE(NEW.name_en, groups.name_en),
      description = COALESCE(NEW.description, groups.description),
      description_en = COALESCE(NEW.description_en, groups.description_en),
      avatar_url = COALESCE(NEW.avatar_url, groups.avatar_url),
      rules_json = COALESCE(NEW.rules_json, groups.rules_json),
      rules = COALESCE(NEW.rules, groups.rules),
      rules_en = COALESCE(NEW.rules_en, groups.rules_en),
      role_names = COALESCE(NEW.role_names, groups.role_names)
    WHERE id = NEW.group_id;
    
    -- 发送通知给申请人
    INSERT INTO notifications (user_id, type, title, message, link)
    VALUES (
      NEW.applicant_id,
      'system',
      '小组信息修改已通过',
      '您提交的小组信息修改申请已通过审核！',
      '/groups/' || NEW.group_id
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_group_edit_approved ON group_edit_applications;
CREATE TRIGGER on_group_edit_approved
  AFTER UPDATE ON group_edit_applications
  FOR EACH ROW
  EXECUTE FUNCTION handle_group_edit_approved();

-- ============================================
-- 15. 触发器：小组信息修改申请被拒绝时发送通知
-- ============================================

CREATE OR REPLACE FUNCTION handle_group_edit_rejected()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'rejected' AND (OLD.status IS NULL OR OLD.status != 'rejected') THEN
    INSERT INTO notifications (user_id, type, title, message, link)
    VALUES (
      NEW.applicant_id,
      'system',
      '小组信息修改未通过',
      '您提交的小组信息修改申请未通过审核。' || 
        CASE WHEN NEW.reject_reason IS NOT NULL THEN '原因：' || NEW.reject_reason ELSE '' END,
      '/groups/' || NEW.group_id
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_group_edit_rejected ON group_edit_applications;
CREATE TRIGGER on_group_edit_rejected
  AFTER UPDATE ON group_edit_applications
  FOR EACH ROW
  EXECUTE FUNCTION handle_group_edit_rejected();

-- ============================================
-- 16. 更新现有数据：将 admin 角色改为 owner（组长）
-- ============================================

-- 对于每个小组，将第一个 admin 改为 owner
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN 
    SELECT DISTINCT ON (group_id) id, group_id 
    FROM group_members 
    WHERE role = 'admin'
    ORDER BY group_id, joined_at ASC
  LOOP
    UPDATE group_members SET role = 'owner' WHERE id = r.id;
  END LOOP;
END $$;

-- ============================================
-- 17. 更新 group_applications 表 - 添加规则字段
-- ============================================

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'group_applications' AND column_name = 'rules_json'
  ) THEN
    ALTER TABLE group_applications ADD COLUMN rules_json JSONB DEFAULT '[]'::jsonb;
  END IF;
END $$;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'group_applications' AND column_name = 'rules'
  ) THEN
    ALTER TABLE group_applications ADD COLUMN rules TEXT;
  END IF;
END $$;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'group_applications' AND column_name = 'rules_en'
  ) THEN
    ALTER TABLE group_applications ADD COLUMN rules_en TEXT;
  END IF;
END $$;

-- ============================================
-- 完成
-- ============================================
-- 运行此脚本后，小组管理系统的数据库结构就配置完成了。
