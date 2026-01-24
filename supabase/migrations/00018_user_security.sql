-- Migration: User Security
-- Adds 2FA support, session management, blocked users, and email digest

-- 2FA columns on user_profiles
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS totp_secret text;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS totp_enabled boolean DEFAULT false;

-- Backup codes for 2FA recovery
CREATE TABLE IF NOT EXISTS backup_codes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used boolean DEFAULT false,
  used_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_backup_codes_user
  ON backup_codes(user_id) WHERE used = false;

-- Login sessions for session management
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

CREATE INDEX IF NOT EXISTS idx_login_sessions_user
  ON login_sessions(user_id, last_active_at DESC)
  WHERE revoked = false;

-- Blocked users
CREATE TABLE IF NOT EXISTS blocked_users (
  blocker_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_blocked_users_blocked
  ON blocked_users(blocked_id);

-- Email digest preferences
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS email_digest text DEFAULT 'none';
-- Valid values: 'none', 'daily', 'weekly'

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS email_digest_last_sent timestamptz;

-- Settings version for conflict detection
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS settings_version int DEFAULT 0;
