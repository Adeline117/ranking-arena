-- Stripe webhook idempotency table
-- Prevents duplicate event processing when Stripe retries webhooks
CREATE TABLE IF NOT EXISTS stripe_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL,
  event_type text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_stripe_events_event_id UNIQUE (event_id)
);

-- Auto-cleanup: drop events older than 30 days (Stripe retries within 3 days max)
CREATE INDEX idx_stripe_events_processed_at ON stripe_events (processed_at);

-- Payment history / audit trail
-- Records every payment-related event for compliance and debugging
-- Columns match the webhook handler insert calls in handlers/invoice.ts and handlers/refund.ts
CREATE TABLE IF NOT EXISTS payment_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  stripe_invoice_id text,
  stripe_payment_intent_id text,
  amount integer,              -- in cents (negative for refunds)
  currency text DEFAULT 'usd',
  status text NOT NULL,        -- succeeded, failed, refunded, etc.
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_history_user_id ON payment_history (user_id, created_at DESC);
CREATE INDEX idx_payment_history_invoice ON payment_history (stripe_invoice_id);

-- RLS: only service role can write (webhook handler uses admin client)
ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_history ENABLE ROW LEVEL SECURITY;

-- Users can read their own payment history
CREATE POLICY "Users can view own payment history"
  ON payment_history FOR SELECT
  USING (auth.uid() = user_id);
