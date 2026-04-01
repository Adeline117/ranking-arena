-- Migration: User strikes / graduated sanctions system
-- Supports warnings, mutes, temp bans, and permanent bans

CREATE TABLE IF NOT EXISTS user_strikes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  issued_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  strike_type TEXT NOT NULL CHECK (strike_type IN ('warning', 'mute', 'temp_ban', 'perm_ban')),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_user_strikes_user_id ON user_strikes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_strikes_issued_by ON user_strikes(issued_by);
CREATE INDEX IF NOT EXISTS idx_user_strikes_type ON user_strikes(strike_type);
CREATE INDEX IF NOT EXISTS idx_user_strikes_expires ON user_strikes(expires_at)
  WHERE expires_at IS NOT NULL;

-- RLS
ALTER TABLE user_strikes ENABLE ROW LEVEL SECURITY;

-- Admins and moderators can view all strikes
DROP POLICY IF EXISTS "mod_admin_select_strikes" ON user_strikes;
CREATE POLICY "mod_admin_select_strikes"
  ON user_strikes FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'moderator')
    )
  );

-- Admins and moderators can create strikes
DROP POLICY IF EXISTS "mod_admin_insert_strikes" ON user_strikes;
CREATE POLICY "mod_admin_insert_strikes"
  ON user_strikes FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'moderator')
    )
  );

-- Users can view their own strikes
DROP POLICY IF EXISTS "users_view_own_strikes" ON user_strikes;
CREATE POLICY "users_view_own_strikes"
  ON user_strikes FOR SELECT
  USING (auth.uid() = user_id);
