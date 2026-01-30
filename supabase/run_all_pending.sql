-- ================================================================
-- ALL PENDING MIGRATIONS (00008 - 00030) - COMBINED & FIXED
-- Run this in Supabase SQL Editor
-- ================================================================

-- ============================================
-- 00008: Admin Features (reordered: role column first)
-- ============================================

-- Add role column FIRST (other RLS policies depend on it)
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

-- Ban columns
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_profiles' AND column_name = 'banned_at') THEN
    ALTER TABLE user_profiles ADD COLUMN banned_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_profiles' AND column_name = 'banned_reason') THEN
    ALTER TABLE user_profiles ADD COLUMN banned_reason TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_profiles' AND column_name = 'banned_by') THEN
    ALTER TABLE user_profiles ADD COLUMN banned_by UUID REFERENCES auth.users(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_profiles_banned ON user_profiles(banned_at) WHERE banned_at IS NOT NULL;

-- Content reports
CREATE TABLE IF NOT EXISTS content_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type IN ('post', 'comment', 'message', 'user')),
  content_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('spam', 'harassment', 'inappropriate', 'misinformation', 'fraud', 'other')),
  description TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  resolved_by UUID REFERENCES auth.users(id),
  resolved_at TIMESTAMPTZ,
  action_taken TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_reports_status ON content_reports(status);
CREATE INDEX IF NOT EXISTS idx_content_reports_content ON content_reports(content_type, content_id);
CREATE INDEX IF NOT EXISTS idx_content_reports_reporter ON content_reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_content_reports_created ON content_reports(created_at DESC);

ALTER TABLE content_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own reports" ON content_reports;
CREATE POLICY "Users can view own reports" ON content_reports FOR SELECT USING (auth.uid() = reporter_id);
DROP POLICY IF EXISTS "Users can create reports" ON content_reports;
CREATE POLICY "Users can create reports" ON content_reports FOR INSERT WITH CHECK (auth.uid() = reporter_id);
DROP POLICY IF EXISTS "Admins can view all reports" ON content_reports;
CREATE POLICY "Admins can view all reports" ON content_reports FOR SELECT USING (EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.id = auth.uid() AND user_profiles.role = 'admin'));
DROP POLICY IF EXISTS "Admins can update reports" ON content_reports;
CREATE POLICY "Admins can update reports" ON content_reports FOR UPDATE USING (EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.id = auth.uid() AND user_profiles.role = 'admin'));

-- Admin logs
CREATE TABLE IF NOT EXISTS admin_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id UUID,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_logs_admin ON admin_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_logs_action ON admin_logs(action);
CREATE INDEX IF NOT EXISTS idx_admin_logs_created ON admin_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_logs_target ON admin_logs(target_type, target_id);

ALTER TABLE admin_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins can view logs" ON admin_logs;
CREATE POLICY "Admins can view logs" ON admin_logs FOR SELECT USING (EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.id = auth.uid() AND user_profiles.role = 'admin'));
DROP POLICY IF EXISTS "Admins can create logs" ON admin_logs;
CREATE POLICY "Admins can create logs" ON admin_logs FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.id = auth.uid() AND user_profiles.role = 'admin'));

-- Alert config
CREATE TABLE IF NOT EXISTS alert_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT UNIQUE NOT NULL,
  value TEXT,
  enabled BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id)
);

INSERT INTO alert_config (key, value, enabled) VALUES
  ('slack_webhook_url', NULL, false),
  ('feishu_webhook_url', NULL, false),
  ('alert_email', NULL, false)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE alert_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins can view alert config" ON alert_config;
CREATE POLICY "Admins can view alert config" ON alert_config FOR SELECT USING (EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.id = auth.uid() AND user_profiles.role = 'admin'));
DROP POLICY IF EXISTS "Admins can update alert config" ON alert_config;
CREATE POLICY "Admins can update alert config" ON alert_config FOR UPDATE USING (EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.id = auth.uid() AND user_profiles.role = 'admin'));
DROP POLICY IF EXISTS "Admins can insert alert config" ON alert_config;
CREATE POLICY "Admins can insert alert config" ON alert_config FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.id = auth.uid() AND user_profiles.role = 'admin'));

-- ============================================
-- 00009: Arena Score
-- ============================================

ALTER TABLE trader_snapshots ADD COLUMN IF NOT EXISTS arena_score NUMERIC(6,2) DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_arena_score ON trader_snapshots(source, season_id, arena_score DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS trader_scores (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  source_trader_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  arena_score NUMERIC(6,2) NOT NULL DEFAULT 0,
  return_score NUMERIC(6,2) DEFAULT 0,
  drawdown_score NUMERIC(6,2) DEFAULT 0,
  stability_score NUMERIC(6,2) DEFAULT 0,
  meets_threshold BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source, source_trader_id, season_id)
);

CREATE INDEX IF NOT EXISTS idx_trader_scores_lookup ON trader_scores(source, source_trader_id, season_id);
CREATE INDEX IF NOT EXISTS idx_trader_scores_ranking ON trader_scores(source, season_id, arena_score DESC);

-- ============================================
-- MISSING TABLES: group_applications & group_edit_applications
-- (Referenced by code but never created in migrations)
-- ============================================

CREATE TABLE IF NOT EXISTS group_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  name_en text,
  description text,
  description_en text,
  avatar_url text,
  role_names jsonb,
  rules_json jsonb,
  rules text,
  is_premium_only boolean DEFAULT false,
  status text NOT NULL DEFAULT 'pending',
  reject_reason text,
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_edit_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  applicant_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text,
  name_en text,
  description text,
  description_en text,
  avatar_url text,
  rules_json jsonb,
  rules text,
  role_names jsonb,
  is_premium_only boolean,
  status text NOT NULL DEFAULT 'pending',
  reject_reason text,
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

-- ============================================
-- 00010: RLS Policies
-- ============================================

-- Ensure posts.author_id column exists (migration 00001 defines it, but DB may differ)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'posts')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'posts' AND column_name = 'author_id')
  THEN
    ALTER TABLE posts ADD COLUMN author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_posts_author_id ON posts(author_id);
  END IF;
END $$;

-- Ensure posts.author_handle column exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'posts')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'posts' AND column_name = 'author_handle')
  THEN
    ALTER TABLE posts ADD COLUMN author_handle TEXT;
  END IF;
END $$;

-- Ensure comments.author_id column exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'comments')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'comments' AND column_name = 'author_id')
  THEN
    ALTER TABLE comments ADD COLUMN author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_comments_author_id ON comments(author_id);
  END IF;
END $$;

-- Ensure user_follows columns exist
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_follows')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_follows' AND column_name = 'follower_id')
  THEN
    ALTER TABLE user_follows ADD COLUMN follower_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Ensure notifications.user_id column exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'notifications')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'notifications' AND column_name = 'user_id')
  THEN
    ALTER TABLE notifications ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "User profiles are viewable by everyone" ON user_profiles;
DROP POLICY IF EXISTS "Users can insert their own profile" ON user_profiles;
DROP POLICY IF EXISTS "Users can update their own profile" ON user_profiles;
DROP POLICY IF EXISTS "Users can delete their own profile" ON user_profiles;
CREATE POLICY "User profiles are viewable by everyone" ON user_profiles FOR SELECT USING (true);
CREATE POLICY "Users can insert their own profile" ON user_profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "Users can update their own profile" ON user_profiles FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
CREATE POLICY "Users can delete their own profile" ON user_profiles FOR DELETE USING (auth.uid() = id);

ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Posts are viewable by everyone" ON posts;
DROP POLICY IF EXISTS "Authenticated users can create posts" ON posts;
DROP POLICY IF EXISTS "Users can update their own posts" ON posts;
DROP POLICY IF EXISTS "Users can delete their own posts" ON posts;
CREATE POLICY "Posts are viewable by everyone" ON posts FOR SELECT USING (true);
CREATE POLICY "Authenticated users can create posts" ON posts FOR INSERT WITH CHECK (auth.uid() = author_id);
CREATE POLICY "Users can update their own posts" ON posts FOR UPDATE USING (auth.uid() = author_id) WITH CHECK (auth.uid() = author_id);
CREATE POLICY "Users can delete their own posts" ON posts FOR DELETE USING (auth.uid() = author_id);

ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Comments are viewable by everyone" ON comments;
DROP POLICY IF EXISTS "Authenticated users can create comments" ON comments;
DROP POLICY IF EXISTS "Users can update their own comments" ON comments;
DROP POLICY IF EXISTS "Users can delete their own comments" ON comments;
CREATE POLICY "Comments are viewable by everyone" ON comments FOR SELECT USING (true);
CREATE POLICY "Authenticated users can create comments" ON comments FOR INSERT WITH CHECK (auth.uid() = author_id);
CREATE POLICY "Users can update their own comments" ON comments FOR UPDATE USING (auth.uid() = author_id) WITH CHECK (auth.uid() = author_id);
CREATE POLICY "Users can delete their own comments" ON comments FOR DELETE USING (auth.uid() = author_id);

ALTER TABLE user_follows ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "User follows are viewable by everyone" ON user_follows;
DROP POLICY IF EXISTS "Users can follow others" ON user_follows;
DROP POLICY IF EXISTS "Users can unfollow" ON user_follows;
CREATE POLICY "User follows are viewable by everyone" ON user_follows FOR SELECT USING (true);
CREATE POLICY "Users can follow others" ON user_follows FOR INSERT WITH CHECK (auth.uid() = follower_id);
CREATE POLICY "Users can unfollow" ON user_follows FOR DELETE USING (auth.uid() = follower_id);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view their own notifications" ON notifications;
DROP POLICY IF EXISTS "Users can update their own notifications" ON notifications;
DROP POLICY IF EXISTS "System can insert notifications" ON notifications;
DROP POLICY IF EXISTS "Users can delete their own notifications" ON notifications;
CREATE POLICY "Users can view their own notifications" ON notifications FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can update their own notifications" ON notifications FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "System can insert notifications" ON notifications FOR INSERT WITH CHECK (true);
CREATE POLICY "Users can delete their own notifications" ON notifications FOR DELETE USING (auth.uid() = user_id);

DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'alert_configs') THEN
ALTER TABLE alert_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view their own alert configs" ON alert_configs;
DROP POLICY IF EXISTS "Users can insert their own alert configs" ON alert_configs;
DROP POLICY IF EXISTS "Users can update their own alert configs" ON alert_configs;
DROP POLICY IF EXISTS "Users can delete their own alert configs" ON alert_configs;
CREATE POLICY "Users can view their own alert configs" ON alert_configs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their own alert configs" ON alert_configs FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own alert configs" ON alert_configs FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete their own alert configs" ON alert_configs FOR DELETE USING (auth.uid() = user_id);
END IF; END $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'risk_alerts') THEN
ALTER TABLE risk_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view their own alerts" ON risk_alerts;
DROP POLICY IF EXISTS "System can insert alerts" ON risk_alerts;
DROP POLICY IF EXISTS "Users can update their own alerts" ON risk_alerts;
CREATE POLICY "Users can view their own alerts" ON risk_alerts FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "System can insert alerts" ON risk_alerts FOR INSERT WITH CHECK (true);
CREATE POLICY "Users can update their own alerts" ON risk_alerts FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
END IF; END $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'push_subscriptions') THEN
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
END IF; END $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'push_notification_logs') THEN
ALTER TABLE push_notification_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view their own push logs" ON push_notification_logs;
DROP POLICY IF EXISTS "System can insert push logs" ON push_notification_logs;
CREATE POLICY "Users can view their own push logs" ON push_notification_logs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "System can insert push logs" ON push_notification_logs FOR INSERT WITH CHECK (true);
END IF; END $$;

-- group_members RLS
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Group members are viewable by everyone" ON group_members;
DROP POLICY IF EXISTS "Users can join groups" ON group_members;
DROP POLICY IF EXISTS "Users can leave groups" ON group_members;
DROP POLICY IF EXISTS "Group admins can update members" ON group_members;
CREATE POLICY "Group members are viewable by everyone" ON group_members FOR SELECT USING (true);
CREATE POLICY "Users can join groups" ON group_members FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can leave groups" ON group_members FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY "Group admins can update members" ON group_members FOR UPDATE
  USING (EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = group_members.group_id AND gm.user_id = auth.uid() AND gm.role IN ('admin', 'owner')))
  WITH CHECK (EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = group_members.group_id AND gm.user_id = auth.uid() AND gm.role IN ('admin', 'owner')));

-- groups RLS
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Groups are viewable by everyone" ON groups;
DROP POLICY IF EXISTS "Group creators can update their groups" ON groups;
DROP POLICY IF EXISTS "Group admins can update their groups" ON groups;
DROP POLICY IF EXISTS "Group creators can delete their groups" ON groups;
CREATE POLICY "Groups are viewable by everyone" ON groups FOR SELECT USING (true);
CREATE POLICY "Group creators can update their groups" ON groups FOR UPDATE USING (auth.uid() = created_by) WITH CHECK (auth.uid() = created_by);
CREATE POLICY "Group admins can update their groups" ON groups FOR UPDATE
  USING (EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = groups.id AND gm.user_id = auth.uid() AND gm.role IN ('admin', 'owner')))
  WITH CHECK (EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = groups.id AND gm.user_id = auth.uid() AND gm.role IN ('admin', 'owner')));
CREATE POLICY "Group creators can delete their groups" ON groups FOR DELETE USING (auth.uid() = created_by);

-- group_applications RLS
ALTER TABLE group_applications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view their own applications" ON group_applications;
DROP POLICY IF EXISTS "Users can create applications" ON group_applications;
DROP POLICY IF EXISTS "Admins can view all applications" ON group_applications;
DROP POLICY IF EXISTS "Admins can update applications" ON group_applications;
CREATE POLICY "Users can view their own applications" ON group_applications FOR SELECT USING (auth.uid() = applicant_id);
CREATE POLICY "Users can create applications" ON group_applications FOR INSERT WITH CHECK (auth.uid() = applicant_id);
CREATE POLICY "Admins can view all applications" ON group_applications FOR SELECT USING (EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.id = auth.uid() AND user_profiles.role = 'admin'));
CREATE POLICY "Admins can update applications" ON group_applications FOR UPDATE USING (EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.id = auth.uid() AND user_profiles.role = 'admin'));

-- group_edit_applications RLS
ALTER TABLE group_edit_applications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view their own edit applications" ON group_edit_applications;
DROP POLICY IF EXISTS "Users can create edit applications" ON group_edit_applications;
DROP POLICY IF EXISTS "Admins can view all edit applications" ON group_edit_applications;
DROP POLICY IF EXISTS "Admins can update edit applications" ON group_edit_applications;
CREATE POLICY "Users can view their own edit applications" ON group_edit_applications FOR SELECT USING (auth.uid() = applicant_id);
CREATE POLICY "Users can create edit applications" ON group_edit_applications FOR INSERT WITH CHECK (auth.uid() = applicant_id);
CREATE POLICY "Admins can view all edit applications" ON group_edit_applications FOR SELECT USING (EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.id = auth.uid() AND user_profiles.role = 'admin'));
CREATE POLICY "Admins can update edit applications" ON group_edit_applications FOR UPDATE USING (EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.id = auth.uid() AND user_profiles.role = 'admin'));

-- ============================================
-- 00011: Document Nullable Fields (comments only)
-- ============================================

COMMENT ON COLUMN trader_snapshots.win_rate IS 'Win rate %. May be NULL for exchanges like GMX';
COMMENT ON COLUMN trader_snapshots.max_drawdown IS 'Max drawdown %. May be NULL for some exchanges';
COMMENT ON COLUMN trader_snapshots.followers IS 'Follower count. NULL if exchange has no copy-trading';
COMMENT ON COLUMN trader_snapshots.pnl IS 'PnL in USD. May be NULL';
COMMENT ON COLUMN trader_snapshots.trades_count IS 'Trade count. May be NULL';

-- ============================================
-- 00012: Group Mute Columns
-- ============================================

ALTER TABLE group_members
  ADD COLUMN IF NOT EXISTS muted_until TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS mute_reason TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS muted_by UUID DEFAULT NULL REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_group_members_muted_until ON group_members (group_id, muted_until) WHERE muted_until IS NOT NULL;

-- ============================================
-- 00013: Hot Score Refresh
-- ============================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'posts' AND column_name = 'hot_score') THEN
    ALTER TABLE posts ADD COLUMN hot_score DOUBLE PRECISION DEFAULT 0;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_posts_hot_score ON posts(hot_score DESC NULLS LAST, created_at DESC);

CREATE OR REPLACE FUNCTION refresh_hot_scores()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE updated_count INTEGER;
BEGIN
  UPDATE posts SET hot_score = (
    COALESCE(like_count, 0) * 3 + COALESCE(comment_count, 0) * 5 +
    COALESCE(repost_count, 0) * 2 + COALESCE(view_count, 0) * 0.1 -
    LN(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 + 2) * 2
  ) WHERE created_at > NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END; $$;

-- ============================================
-- 00014: Search Improvements
-- ============================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'trader_sources_v2') THEN
    CREATE INDEX IF NOT EXISTS idx_trader_sources_v2_name_trgm ON trader_sources_v2 USING gin (display_name gin_trgm_ops);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_posts_title_trgm ON posts USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_groups_name_trgm ON groups USING gin (name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS search_analytics (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  query text NOT NULL,
  result_count int NOT NULL DEFAULT 0,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  source text DEFAULT 'dropdown',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_search_analytics_created ON search_analytics(created_at DESC);

-- ============================================
-- 00015: Payment Improvements
-- ============================================

CREATE OR REPLACE FUNCTION update_subscription_and_profile(
  p_user_id uuid, p_tier text, p_status text, p_stripe_sub_id text,
  p_stripe_customer_id text, p_plan text, p_period_start timestamptz,
  p_period_end timestamptz, p_cancel_at_period_end boolean DEFAULT false
) RETURNS void AS $$
BEGIN
  INSERT INTO subscriptions (user_id, stripe_subscription_id, stripe_customer_id, status, tier, plan, current_period_start, current_period_end, cancel_at_period_end, updated_at)
  VALUES (p_user_id, p_stripe_sub_id, p_stripe_customer_id, p_status, p_tier, p_plan, p_period_start, p_period_end, p_cancel_at_period_end, now())
  ON CONFLICT (user_id) DO UPDATE SET
    stripe_subscription_id = EXCLUDED.stripe_subscription_id, stripe_customer_id = EXCLUDED.stripe_customer_id,
    status = EXCLUDED.status, tier = EXCLUDED.tier, plan = EXCLUDED.plan,
    current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end,
    cancel_at_period_end = EXCLUDED.cancel_at_period_end, updated_at = now();
  UPDATE user_profiles SET
    subscription_tier = CASE WHEN p_status IN ('active', 'trialing') THEN 'pro' ELSE 'free' END,
    stripe_customer_id = p_stripe_customer_id, updated_at = now()
  WHERE id = p_user_id;
END; $$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tips') THEN
    CREATE INDEX IF NOT EXISTS idx_tips_idempotency ON tips(from_user_id, post_id, amount_cents, status) WHERE status = 'pending';
  END IF;
END $$;

-- ============================================
-- 00016: Group Enhancements
-- ============================================

CREATE TABLE IF NOT EXISTS group_audit_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id uuid REFERENCES groups(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_id uuid,
  details jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_group_audit_group ON group_audit_log(group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_group_audit_actor ON group_audit_log(actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS group_invites (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id uuid REFERENCES groups(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  token_hash text NOT NULL,
  max_uses int DEFAULT 50,
  used_count int DEFAULT 0,
  expires_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_group_invites_token ON group_invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_group_invites_group ON group_invites(group_id, created_at DESC);

CREATE TABLE IF NOT EXISTS group_bans (
  group_id uuid REFERENCES groups(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  reason text,
  banned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_group_bans_user ON group_bans(user_id);

CREATE OR REPLACE FUNCTION increment_member_count(p_group_id uuid, p_delta int DEFAULT 1)
RETURNS void AS $$
BEGIN
  UPDATE groups SET member_count = GREATEST(0, COALESCE(member_count, 0) + p_delta) WHERE id = p_group_id;
END; $$ LANGUAGE plpgsql;

-- ============================================
-- 00017: Hot Score Improvements
-- ============================================

ALTER TABLE posts ADD COLUMN IF NOT EXISTS last_hot_refresh_at timestamptz;
-- NOTE: cannot use now() in partial index predicate (must be IMMUTABLE)
-- Use a plain index instead
CREATE INDEX IF NOT EXISTS idx_posts_hot_refresh ON posts(last_hot_refresh_at, created_at DESC);

-- ============================================
-- 00018: User Security
-- ============================================

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS totp_secret text;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS totp_enabled boolean DEFAULT false;

CREATE TABLE IF NOT EXISTS backup_codes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used boolean DEFAULT false,
  used_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_backup_codes_user ON backup_codes(user_id) WHERE used = false;

CREATE TABLE IF NOT EXISTS login_sessions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  device_info jsonb,
  ip_address text,
  user_agent text,
  created_at timestamptz DEFAULT now(),
  last_active_at timestamptz DEFAULT now(),
  is_current boolean DEFAULT false,
  revoked boolean DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_login_sessions_user ON login_sessions(user_id, last_active_at DESC) WHERE revoked = false;

CREATE TABLE IF NOT EXISTS blocked_users (
  blocker_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocked_users_blocked ON blocked_users(blocked_id);

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS email_digest text DEFAULT 'none';
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS email_digest_last_sent timestamptz;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS settings_version int DEFAULT 0;

-- ============================================
-- 00019: Hot Score Power Decay (overrides 00013/00017)
-- ============================================

CREATE OR REPLACE FUNCTION refresh_hot_scores()
RETURNS INTEGER AS $$
DECLARE updated_count INTEGER;
BEGIN
  UPDATE posts SET hot_score = (
    (COALESCE(like_count, 0) * 3 + COALESCE(comment_count, 0) * 5 + COALESCE(repost_count, 0) * 2 + COALESCE(view_count, 0) * 0.1)
    * CASE WHEN images IS NOT NULL AND jsonb_array_length(images) > 0 THEN 1.2 ELSE 1.0 END
    * CASE WHEN poll_id IS NOT NULL THEN 1.15 ELSE 1.0 END
    - POWER(GREATEST(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600, 0) / 24.0, 1.3) * 5
  ), last_hot_refresh_at = now()
  WHERE created_at > NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END; $$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION refresh_hot_scores_incremental()
RETURNS INTEGER AS $$
DECLARE updated_count INTEGER;
BEGIN
  UPDATE posts SET hot_score = (
    (COALESCE(like_count, 0) * 3 + COALESCE(comment_count, 0) * 5 + COALESCE(repost_count, 0) * 2 + COALESCE(view_count, 0) * 0.1)
    * CASE WHEN images IS NOT NULL AND jsonb_array_length(images) > 0 THEN 1.2 ELSE 1.0 END
    * CASE WHEN poll_id IS NOT NULL THEN 1.15 ELSE 1.0 END
    - POWER(GREATEST(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600, 0) / 24.0, 1.3) * 5
  ), last_hot_refresh_at = now()
  WHERE created_at > NOW() - INTERVAL '7 days'
    AND (last_hot_refresh_at IS NULL OR updated_at > last_hot_refresh_at OR created_at > NOW() - INTERVAL '1 hour');
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END; $$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 00020: Push Subscriptions
-- ============================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('fcm', 'apns', 'web')),
  platform TEXT CHECK (platform IN ('ios', 'android', 'web')),
  device_id TEXT,
  device_name TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, token)
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id) WHERE enabled = true;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own push subscriptions" ON push_subscriptions;
CREATE POLICY "Users can view own push subscriptions" ON push_subscriptions FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can create own push subscriptions" ON push_subscriptions;
CREATE POLICY "Users can create own push subscriptions" ON push_subscriptions FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own push subscriptions" ON push_subscriptions;
CREATE POLICY "Users can update own push subscriptions" ON push_subscriptions FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own push subscriptions" ON push_subscriptions;
CREATE POLICY "Users can delete own push subscriptions" ON push_subscriptions FOR DELETE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Service role full access to push subscriptions" ON push_subscriptions;
CREATE POLICY "Service role full access to push subscriptions" ON push_subscriptions FOR ALL USING (auth.role() = 'service_role');

CREATE TABLE IF NOT EXISTS notification_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data JSONB,
  channel_id TEXT DEFAULT 'arena_default',
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'failed', 'clicked')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_notification_history_user_id ON notification_history(user_id, sent_at DESC);
ALTER TABLE notification_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own notification history" ON notification_history;
CREATE POLICY "Users can view own notification history" ON notification_history FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Service role full access to notification history" ON notification_history;
CREATE POLICY "Service role full access to notification history" ON notification_history FOR ALL USING (auth.role() = 'service_role');

-- ============================================
-- 00021: Atomic Counter Functions
-- ============================================

CREATE OR REPLACE FUNCTION decrement_bookmark_count(post_id uuid) RETURNS TABLE(bookmark_count integer) AS $$ BEGIN RETURN QUERY UPDATE posts SET bookmark_count = GREATEST(0, COALESCE(posts.bookmark_count, 0) - 1) WHERE id = post_id RETURNING posts.bookmark_count; END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION increment_bookmark_count(post_id uuid) RETURNS TABLE(bookmark_count integer) AS $$ BEGIN RETURN QUERY UPDATE posts SET bookmark_count = COALESCE(posts.bookmark_count, 0) + 1 WHERE id = post_id RETURNING posts.bookmark_count; END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION decrement_like_count(post_id uuid) RETURNS TABLE(like_count integer) AS $$ BEGIN RETURN QUERY UPDATE posts SET like_count = GREATEST(0, COALESCE(posts.like_count, 0) - 1) WHERE id = post_id RETURNING posts.like_count; END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION increment_like_count(post_id uuid) RETURNS TABLE(like_count integer) AS $$ BEGIN RETURN QUERY UPDATE posts SET like_count = COALESCE(posts.like_count, 0) + 1 WHERE id = post_id RETURNING posts.like_count; END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION decrement_comment_count(post_id uuid) RETURNS TABLE(comment_count integer) AS $$ BEGIN RETURN QUERY UPDATE posts SET comment_count = GREATEST(0, COALESCE(posts.comment_count, 0) - 1) WHERE id = post_id RETURNING posts.comment_count; END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION increment_comment_count(post_id uuid) RETURNS TABLE(comment_count integer) AS $$ BEGIN RETURN QUERY UPDATE posts SET comment_count = COALESCE(posts.comment_count, 0) + 1 WHERE id = post_id RETURNING posts.comment_count; END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION decrement_member_count(group_id uuid) RETURNS TABLE(member_count integer) AS $$ BEGIN RETURN QUERY UPDATE groups SET member_count = GREATEST(0, COALESCE(groups.member_count, 0) - 1) WHERE id = group_id RETURNING groups.member_count; END; $$ LANGUAGE plpgsql;

-- ============================================
-- 00022: Refresh Jobs
-- ============================================

CREATE TABLE IF NOT EXISTS refresh_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type TEXT NOT NULL,
  platform TEXT NOT NULL,
  trader_key TEXT,
  priority INTEGER DEFAULT 3,
  status TEXT DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  next_run_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refresh_jobs_pending ON refresh_jobs (status, next_run_at, priority) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_refresh_jobs_platform ON refresh_jobs (platform, status);

CREATE OR REPLACE FUNCTION cleanup_old_refresh_jobs() RETURNS INTEGER AS $$
DECLARE deleted_count INTEGER;
BEGIN
  DELETE FROM refresh_jobs WHERE status IN ('completed', 'failed') AND completed_at < NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END; $$ LANGUAGE plpgsql;

-- ============================================
-- 00023: Storage Buckets
-- ============================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', true, 5242880, ARRAY['image/jpeg','image/jpg','image/png','image/gif','image/webp'])
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('covers', 'covers', true, 10485760, ARRAY['image/jpeg','image/jpg','image/png','image/gif','image/webp'])
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Public can view avatars" ON storage.objects;
CREATE POLICY "Public can view avatars" ON storage.objects FOR SELECT USING (bucket_id = 'avatars');
DROP POLICY IF EXISTS "Users can upload own avatar" ON storage.objects;
CREATE POLICY "Users can upload own avatar" ON storage.objects FOR INSERT WITH CHECK (
  bucket_id = 'avatars' AND auth.role() = 'authenticated' AND ((storage.foldername(name))[1] = auth.uid()::text OR name LIKE auth.uid()::text || '-%')
);
DROP POLICY IF EXISTS "Users can update own avatar" ON storage.objects;
CREATE POLICY "Users can update own avatar" ON storage.objects FOR UPDATE USING (
  bucket_id = 'avatars' AND auth.role() = 'authenticated' AND ((storage.foldername(name))[1] = auth.uid()::text OR name LIKE auth.uid()::text || '-%')
);
DROP POLICY IF EXISTS "Users can delete own avatar" ON storage.objects;
CREATE POLICY "Users can delete own avatar" ON storage.objects FOR DELETE USING (
  bucket_id = 'avatars' AND auth.role() = 'authenticated' AND ((storage.foldername(name))[1] = auth.uid()::text OR name LIKE auth.uid()::text || '-%')
);

DROP POLICY IF EXISTS "Public can view covers" ON storage.objects;
CREATE POLICY "Public can view covers" ON storage.objects FOR SELECT USING (bucket_id = 'covers');
DROP POLICY IF EXISTS "Users can upload own cover" ON storage.objects;
CREATE POLICY "Users can upload own cover" ON storage.objects FOR INSERT WITH CHECK (
  bucket_id = 'covers' AND auth.role() = 'authenticated' AND ((storage.foldername(name))[1] = auth.uid()::text OR name LIKE auth.uid()::text || '-%')
);
DROP POLICY IF EXISTS "Users can update own cover" ON storage.objects;
CREATE POLICY "Users can update own cover" ON storage.objects FOR UPDATE USING (
  bucket_id = 'covers' AND auth.role() = 'authenticated' AND ((storage.foldername(name))[1] = auth.uid()::text OR name LIKE auth.uid()::text || '-%')
);
DROP POLICY IF EXISTS "Users can delete own cover" ON storage.objects;
CREATE POLICY "Users can delete own cover" ON storage.objects FOR DELETE USING (
  bucket_id = 'covers' AND auth.role() = 'authenticated' AND ((storage.foldername(name))[1] = auth.uid()::text OR name LIKE auth.uid()::text || '-%')
);

-- ============================================
-- 00024: Chat Media Support
-- ============================================

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'direct_messages') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'direct_messages' AND column_name = 'media_url') THEN
      ALTER TABLE direct_messages ADD COLUMN media_url TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'direct_messages' AND column_name = 'media_type') THEN
      ALTER TABLE direct_messages ADD COLUMN media_type TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'direct_messages' AND column_name = 'media_name') THEN
      ALTER TABLE direct_messages ADD COLUMN media_name TEXT;
    END IF;
  END IF;
END $$;

-- ============================================
-- 00025a: Hot Score Prerequisites
-- ============================================

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS follower_count INTEGER DEFAULT 0;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS following_count INTEGER DEFAULT 0;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS subscription_tier TEXT DEFAULT 'free';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS dislike_count INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS post_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reaction_type TEXT NOT NULL CHECK (reaction_type IN ('up', 'down')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(post_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_post_reactions_post ON post_reactions(post_id);
CREATE INDEX IF NOT EXISTS idx_post_reactions_user ON post_reactions(user_id);

-- ============================================
-- 00025b: Hot Score Algorithm V4
-- (Functions only - the final UPDATE at end of original is skipped for safety)
-- ============================================

ALTER TABLE posts ADD COLUMN IF NOT EXISTS likes_last_hour INTEGER DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS comments_last_hour INTEGER DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS velocity_updated_at TIMESTAMPTZ;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS report_count INTEGER DEFAULT 0;

CREATE OR REPLACE FUNCTION get_author_weight(p_author_id UUID) RETURNS NUMERIC AS $$
DECLARE v_tier TEXT; v_followers INTEGER; v_weight NUMERIC := 1.0; v_has_tier_col BOOLEAN; v_has_follower_col BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_profiles' AND column_name = 'subscription_tier') INTO v_has_tier_col;
  SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_profiles' AND column_name = 'follower_count') INTO v_has_follower_col;
  IF v_has_tier_col THEN EXECUTE 'SELECT subscription_tier FROM user_profiles WHERE id = $1' INTO v_tier USING p_author_id; IF v_tier = 'pro' THEN v_weight := v_weight * 1.3; END IF; END IF;
  IF v_has_follower_col THEN EXECUTE 'SELECT follower_count FROM user_profiles WHERE id = $1' INTO v_followers USING p_author_id;
    IF COALESCE(v_followers, 0) >= 1000 THEN v_weight := v_weight * 1.2; ELSIF COALESCE(v_followers, 0) >= 100 THEN v_weight := v_weight * 1.1; ELSIF COALESCE(v_followers, 0) >= 10 THEN v_weight := v_weight * 1.05; END IF;
  END IF;
  RETURN v_weight;
END; $$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION get_content_quality_score(p_content TEXT, p_images JSONB, p_poll_id UUID) RETURNS NUMERIC AS $$
DECLARE v_score NUMERIC := 1.0; v_content_length INTEGER;
BEGIN
  v_content_length := COALESCE(char_length(p_content), 0);
  IF v_content_length > 500 THEN v_score := v_score * 1.15; ELSIF v_content_length > 200 THEN v_score := v_score * 1.1; END IF;
  IF p_content ~* 'https?://' THEN v_score := v_score * 1.1; END IF;
  IF p_content ~ '@[a-zA-Z0-9_]+' THEN v_score := v_score * 1.1; END IF;
  IF p_images IS NOT NULL AND jsonb_array_length(p_images) > 0 THEN v_score := v_score * 1.2; END IF;
  IF p_poll_id IS NOT NULL THEN v_score := v_score * 1.15; END IF;
  RETURN v_score;
END; $$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION get_post_penalty(p_like_count INTEGER, p_dislike_count INTEGER, p_report_count INTEGER) RETURNS NUMERIC AS $$
DECLARE v_penalty NUMERIC := 1.0; v_dislike_ratio NUMERIC;
BEGIN
  IF COALESCE(p_like_count, 0) > 0 THEN v_dislike_ratio := COALESCE(p_dislike_count, 0)::NUMERIC / p_like_count;
  ELSE v_dislike_ratio := CASE WHEN COALESCE(p_dislike_count, 0) > 0 THEN 1.0 ELSE 0 END; END IF;
  IF v_dislike_ratio > 0.5 THEN v_penalty := v_penalty * 0.5; ELSIF v_dislike_ratio > 0.3 THEN v_penalty := v_penalty * 0.7; ELSIF v_dislike_ratio > 0.2 THEN v_penalty := v_penalty * 0.85; END IF;
  IF COALESCE(p_report_count, 0) >= 3 THEN v_penalty := v_penalty * 0.3; ELSIF COALESCE(p_report_count, 0) >= 2 THEN v_penalty := v_penalty * 0.5; ELSIF COALESCE(p_report_count, 0) >= 1 THEN v_penalty := v_penalty * 0.7; END IF;
  RETURN v_penalty;
END; $$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION get_time_decay(p_hours NUMERIC) RETURNS NUMERIC AS $$
BEGIN
  IF p_hours < 1 THEN RETURN 0;
  ELSIF p_hours < 6 THEN RETURN p_hours * 0.5;
  ELSIF p_hours < 24 THEN RETURN 3 + (p_hours - 6) * 1;
  ELSIF p_hours < 72 THEN RETURN 21 + (p_hours - 24) * 2;
  ELSE RETURN 117 + (p_hours - 72) * 3; END IF;
END; $$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION calculate_hot_score(
  p_like_count INTEGER, p_comment_count INTEGER, p_repost_count INTEGER, p_view_count INTEGER,
  p_dislike_count INTEGER, p_report_count INTEGER, p_likes_last_hour INTEGER, p_comments_last_hour INTEGER,
  p_author_id UUID, p_content TEXT, p_images JSONB, p_poll_id UUID, p_created_at TIMESTAMPTZ
) RETURNS NUMERIC AS $$
DECLARE v_base NUMERIC; v_quality NUMERIC; v_author NUMERIC; v_penalty NUMERIC; v_velocity NUMERIC; v_decay NUMERIC; v_hours NUMERIC;
BEGIN
  v_hours := GREATEST(EXTRACT(EPOCH FROM (NOW() - p_created_at)) / 3600, 0);
  v_base := COALESCE(p_like_count,0)*3 + COALESCE(p_comment_count,0)*5 + COALESCE(p_repost_count,0)*2 + COALESCE(p_view_count,0)*0.1;
  v_quality := get_content_quality_score(p_content, p_images, p_poll_id);
  v_author := get_author_weight(p_author_id);
  v_penalty := get_post_penalty(p_like_count, p_dislike_count, p_report_count);
  v_velocity := (COALESCE(p_likes_last_hour,0)*5 + COALESCE(p_comments_last_hour,0)*10) * 0.1;
  v_decay := get_time_decay(v_hours);
  RETURN GREATEST((v_base * v_quality * v_author * v_penalty + v_velocity) - v_decay, 0);
END; $$ LANGUAGE plpgsql STABLE;

-- Override refresh functions with V4
CREATE OR REPLACE FUNCTION refresh_hot_scores() RETURNS INTEGER AS $$
DECLARE updated_count INTEGER;
BEGIN
  UPDATE posts SET hot_score = calculate_hot_score(like_count, comment_count, repost_count, view_count, dislike_count, report_count, likes_last_hour, comments_last_hour, author_id, content, images, poll_id, created_at), last_hot_refresh_at = now()
  WHERE created_at > NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS updated_count = ROW_COUNT; RETURN updated_count;
END; $$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION refresh_hot_scores_incremental() RETURNS INTEGER AS $$
DECLARE updated_count INTEGER;
BEGIN
  UPDATE posts SET hot_score = calculate_hot_score(like_count, comment_count, repost_count, view_count, dislike_count, report_count, likes_last_hour, comments_last_hour, author_id, content, images, poll_id, created_at), last_hot_refresh_at = now()
  WHERE created_at > NOW() - INTERVAL '7 days' AND (last_hot_refresh_at IS NULL OR updated_at > last_hot_refresh_at OR created_at > NOW() - INTERVAL '1 hour');
  GET DIAGNOSTICS updated_count = ROW_COUNT; RETURN updated_count;
END; $$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION update_post_velocity() RETURNS INTEGER AS $$
DECLARE updated_count INTEGER;
BEGIN
  UPDATE posts p SET
    likes_last_hour = (SELECT COUNT(*) FROM post_reactions pr WHERE pr.post_id = p.id AND pr.reaction_type = 'up' AND pr.created_at > NOW() - INTERVAL '1 hour'),
    comments_last_hour = (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.created_at > NOW() - INTERVAL '1 hour'),
    velocity_updated_at = NOW()
  WHERE created_at > NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS updated_count = ROW_COUNT; RETURN updated_count;
END; $$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 00026: Smart Scheduler
-- ============================================

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'trader_sources') THEN
    ALTER TABLE trader_sources ADD COLUMN IF NOT EXISTS activity_tier VARCHAR(20);
    ALTER TABLE trader_sources ADD COLUMN IF NOT EXISTS next_refresh_at TIMESTAMPTZ;
    ALTER TABLE trader_sources ADD COLUMN IF NOT EXISTS last_refreshed_at TIMESTAMPTZ;
    ALTER TABLE trader_sources ADD COLUMN IF NOT EXISTS refresh_priority INTEGER;
    ALTER TABLE trader_sources ADD COLUMN IF NOT EXISTS tier_updated_at TIMESTAMPTZ;

    ALTER TABLE trader_sources DROP CONSTRAINT IF EXISTS trader_sources_activity_tier_check;
    ALTER TABLE trader_sources ADD CONSTRAINT trader_sources_activity_tier_check CHECK (activity_tier IN ('hot', 'active', 'normal', 'dormant') OR activity_tier IS NULL);
    ALTER TABLE trader_sources DROP CONSTRAINT IF EXISTS trader_sources_priority_check;
    ALTER TABLE trader_sources ADD CONSTRAINT trader_sources_priority_check CHECK (refresh_priority >= 10 AND refresh_priority <= 40 OR refresh_priority IS NULL);

    CREATE INDEX IF NOT EXISTS idx_trader_sources_schedule ON trader_sources(activity_tier, next_refresh_at) WHERE is_active = true;
    CREATE INDEX IF NOT EXISTS idx_trader_sources_refresh_priority ON trader_sources(refresh_priority, next_refresh_at) WHERE is_active = true;

    UPDATE trader_sources SET activity_tier = 'normal', refresh_priority = 30, next_refresh_at = NOW() + INTERVAL '4 hours', tier_updated_at = NOW()
    WHERE is_active = true AND activity_tier IS NULL;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION get_next_refresh_time(tier VARCHAR(20), base_time TIMESTAMPTZ DEFAULT NOW()) RETURNS TIMESTAMPTZ AS $$
BEGIN
  RETURN CASE tier WHEN 'hot' THEN base_time + INTERVAL '15 minutes' WHEN 'active' THEN base_time + INTERVAL '1 hour' WHEN 'normal' THEN base_time + INTERVAL '4 hours' WHEN 'dormant' THEN base_time + INTERVAL '24 hours' ELSE base_time + INTERVAL '4 hours' END;
END; $$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================
-- 00027: Anomaly Detection (FIXED: is_admin -> role = 'admin')
-- ============================================

CREATE TABLE IF NOT EXISTS trader_anomalies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trader_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  anomaly_type TEXT NOT NULL,
  field_name TEXT NOT NULL,
  detected_value NUMERIC,
  expected_range_min NUMERIC,
  expected_range_max NUMERIC,
  z_score NUMERIC,
  severity TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  description TEXT,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  notes TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trader_anomalies_trader ON trader_anomalies(trader_id, platform);
CREATE INDEX IF NOT EXISTS idx_trader_anomalies_status ON trader_anomalies(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_trader_anomalies_severity ON trader_anomalies(severity) WHERE severity IN ('high', 'critical');
CREATE INDEX IF NOT EXISTS idx_trader_anomalies_detected_at ON trader_anomalies(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_trader_anomalies_status_severity ON trader_anomalies(status, severity, detected_at DESC);

CREATE OR REPLACE FUNCTION update_trader_anomaly_timestamp() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  IF NEW.status IN ('resolved', 'false_positive') AND OLD.status NOT IN ('resolved', 'false_positive') THEN NEW.resolved_at = NOW(); END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_trader_anomaly_timestamp ON trader_anomalies;
CREATE TRIGGER trigger_update_trader_anomaly_timestamp BEFORE UPDATE ON trader_anomalies FOR EACH ROW EXECUTE FUNCTION update_trader_anomaly_timestamp();

ALTER TABLE trader_anomalies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Confirmed anomalies are viewable by everyone" ON trader_anomalies;
CREATE POLICY "Confirmed anomalies are viewable by everyone" ON trader_anomalies FOR SELECT USING (status = 'confirmed');
DROP POLICY IF EXISTS "Admins can view all anomalies" ON trader_anomalies;
CREATE POLICY "Admins can view all anomalies" ON trader_anomalies FOR SELECT USING (EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.id = auth.uid() AND user_profiles.role = 'admin'));
DROP POLICY IF EXISTS "Admins can insert anomalies" ON trader_anomalies;
CREATE POLICY "Admins can insert anomalies" ON trader_anomalies FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.id = auth.uid() AND user_profiles.role = 'admin'));
DROP POLICY IF EXISTS "Admins can update anomalies" ON trader_anomalies;
CREATE POLICY "Admins can update anomalies" ON trader_anomalies FOR UPDATE USING (EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.id = auth.uid() AND user_profiles.role = 'admin'));
DROP POLICY IF EXISTS "Service role can manage anomalies" ON trader_anomalies;
CREATE POLICY "Service role can manage anomalies" ON trader_anomalies FOR ALL USING (auth.jwt()->>'role' = 'service_role');

CREATE OR REPLACE FUNCTION get_pending_critical_anomalies_count() RETURNS INTEGER AS $$
  SELECT COUNT(*)::INTEGER FROM trader_anomalies WHERE status = 'pending' AND severity IN ('critical', 'high');
$$ LANGUAGE SQL STABLE;

-- ============================================
-- 00028: Add rules_json
-- ============================================

ALTER TABLE groups ADD COLUMN IF NOT EXISTS rules_json jsonb DEFAULT NULL;
ALTER TABLE group_applications ADD COLUMN IF NOT EXISTS rules_json jsonb DEFAULT NULL;
ALTER TABLE group_edit_applications ADD COLUMN IF NOT EXISTS rules_json jsonb DEFAULT NULL;

-- ============================================
-- 00029: Trader Reviews
-- ============================================

CREATE TABLE IF NOT EXISTS trader_reviews (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  trader_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  content TEXT NOT NULL CHECK (char_length(content) <= 2000),
  like_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT trader_reviews_unique_user_trader UNIQUE (trader_id, user_id)
);

CREATE TABLE IF NOT EXISTS review_likes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  review_id UUID NOT NULL REFERENCES trader_reviews(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT review_likes_unique UNIQUE (review_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_trader_reviews_trader_id ON trader_reviews(trader_id);
CREATE INDEX IF NOT EXISTS idx_trader_reviews_user_id ON trader_reviews(user_id);
CREATE INDEX IF NOT EXISTS idx_trader_reviews_created_at ON trader_reviews(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_likes_review_id ON review_likes(review_id);

ALTER TABLE trader_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_likes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read reviews" ON trader_reviews;
CREATE POLICY "Anyone can read reviews" ON trader_reviews FOR SELECT USING (true);
DROP POLICY IF EXISTS "Authenticated users can create reviews" ON trader_reviews;
CREATE POLICY "Authenticated users can create reviews" ON trader_reviews FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own reviews" ON trader_reviews;
CREATE POLICY "Users can update own reviews" ON trader_reviews FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own reviews" ON trader_reviews;
CREATE POLICY "Users can delete own reviews" ON trader_reviews FOR DELETE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Anyone can read review likes" ON review_likes;
CREATE POLICY "Anyone can read review likes" ON review_likes FOR SELECT USING (true);
DROP POLICY IF EXISTS "Authenticated users can like reviews" ON review_likes;
CREATE POLICY "Authenticated users can like reviews" ON review_likes FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can unlike own likes" ON review_likes;
CREATE POLICY "Users can unlike own likes" ON review_likes FOR DELETE USING (auth.uid() = user_id);

-- ============================================
-- 00030: Upsert Unique Constraint
-- ============================================

ALTER TABLE trader_snapshots DROP CONSTRAINT IF EXISTS trader_snapshots_unique_per_season;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_trader_snapshots_source_trader_season') THEN
    ALTER TABLE trader_snapshots ADD CONSTRAINT uq_trader_snapshots_source_trader_season UNIQUE (source, source_trader_id, season_id);
  END IF;
END $$;

-- ============================================
-- DONE - All migrations 00008-00030 applied
-- ============================================
