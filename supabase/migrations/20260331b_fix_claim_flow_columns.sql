-- Fix missing columns in user_exchange_connections needed for claim verification flow
-- verified_uid: stores the exchange account UID after API key verification
-- passphrase_encrypted: stores encrypted passphrase for OKX/Bitget
-- last_verified_at: timestamp of last successful API key verification

ALTER TABLE user_exchange_connections
  ADD COLUMN IF NOT EXISTS verified_uid TEXT,
  ADD COLUMN IF NOT EXISTS passphrase_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;

-- Index for claim verification lookup (user + exchange + active)
CREATE INDEX IF NOT EXISTS idx_uec_user_exchange_active
  ON user_exchange_connections(user_id, exchange) WHERE is_active = true;
