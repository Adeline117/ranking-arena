-- Fix: subscriptions.status CHECK constraint allows 'cancelled' (British)
-- but code writes 'canceled' (American, matching Stripe API).
-- Add 'canceled' to allowed values so both spellings are accepted.

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check
  CHECK (status = ANY (ARRAY['active', 'trialing', 'past_due', 'canceled', 'cancelled', 'expired']));
