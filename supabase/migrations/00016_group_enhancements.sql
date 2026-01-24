-- Migration: Group Enhancements
-- Adds audit logging, invite tracking, and ban system

-- Group audit log for moderation actions
CREATE TABLE IF NOT EXISTS group_audit_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id uuid REFERENCES groups(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL, -- 'kick', 'mute', 'unmute', 'promote', 'demote', 'delete_post', 'ban', 'unban', 'invite'
  target_id uuid,
  details jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_group_audit_group
  ON group_audit_log(group_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_group_audit_actor
  ON group_audit_log(actor_id, created_at DESC);

-- Group invites tracking
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

CREATE INDEX IF NOT EXISTS idx_group_invites_token
  ON group_invites(token_hash);

CREATE INDEX IF NOT EXISTS idx_group_invites_group
  ON group_invites(group_id, created_at DESC);

-- Group bans
CREATE TABLE IF NOT EXISTS group_bans (
  group_id uuid REFERENCES groups(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  reason text,
  banned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_bans_user
  ON group_bans(user_id);

-- RPC to atomically increment/decrement member count
CREATE OR REPLACE FUNCTION increment_member_count(p_group_id uuid, p_delta int DEFAULT 1)
RETURNS void AS $$
BEGIN
  UPDATE groups
  SET member_count = GREATEST(0, COALESCE(member_count, 0) + p_delta)
  WHERE id = p_group_id;
END;
$$ LANGUAGE plpgsql;
