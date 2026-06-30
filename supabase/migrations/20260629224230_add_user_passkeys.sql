-- Migration: 20260629224230_add_user_passkeys.sql
-- Created: 2026-06-30T05:42:30Z
-- Description: WebAuthn/passkey credentials for passwordless login.
--   Verification flows run server-side with the service-role client (the user is
--   not yet authenticated during login, and credential lookup is by credential_id),
--   so RLS here protects only direct client access — owner-only.

CREATE TABLE IF NOT EXISTS user_passkeys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,        -- base64url credential id
  public_key TEXT NOT NULL,                  -- base64 of the COSE public key bytes
  counter BIGINT NOT NULL DEFAULT 0,         -- signature counter (clone detection)
  transports TEXT[],                         -- e.g. {internal,hybrid,usb}
  device_name TEXT,                          -- user-facing label
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_user_passkeys_user ON user_passkeys(user_id);

ALTER TABLE user_passkeys ENABLE ROW LEVEL SECURITY;

-- Owner-only direct access (server auth flows use the service-role client).
CREATE POLICY "Users can read their own passkeys"
  ON user_passkeys FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can enroll their own passkeys"
  ON user_passkeys FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can rename their own passkeys"
  ON user_passkeys FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete their own passkeys"
  ON user_passkeys FOR DELETE USING (auth.uid() = user_id);
