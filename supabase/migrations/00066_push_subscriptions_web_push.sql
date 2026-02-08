-- Add Web Push (VAPID) columns to push_subscriptions
-- These store the browser PushSubscription keys needed for web-push

ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS endpoint TEXT,
  ADD COLUMN IF NOT EXISTS p256dh TEXT,
  ADD COLUMN IF NOT EXISTS auth TEXT;

-- For web subscriptions, endpoint is the push service URL
-- p256dh and auth are the encryption keys from PushSubscription.getKey()

COMMENT ON COLUMN push_subscriptions.endpoint IS 'Web Push subscription endpoint URL';
COMMENT ON COLUMN push_subscriptions.p256dh IS 'Web Push P-256 Diffie-Hellman public key';
COMMENT ON COLUMN push_subscriptions.auth IS 'Web Push authentication secret';
