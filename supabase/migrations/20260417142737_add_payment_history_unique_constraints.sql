-- Add unique constraints on payment_history for webhook idempotency.
-- Without these, onConflict: 'stripe_invoice_id' and 'stripe_payment_intent_id'
-- silently fall back to INSERT, creating duplicate records on webhook retries.

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_history_invoice
  ON payment_history (stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_history_pi
  ON payment_history (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
