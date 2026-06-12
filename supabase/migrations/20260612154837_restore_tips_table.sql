-- Migration: 20260612154836_restore_tips_table.sql
-- Created: 2026-06-12T22:48:36Z
-- Description: Canonical CREATE TABLE for `tips` (帖子打赏 / post tipping via
--   Stripe one-time checkout). Table was dropped from prod but its feature
--   code is live and healthy.
--
-- ── Phantom-table history ────────────────────────────────────────────
-- No repo migration ever created `tips`. The ONLY historical reference is
-- 00015_payment_improvements.sql, which created the partial idempotency
-- index `idx_tips_idempotency ON tips(from_user_id, post_id, amount_cents,
-- status) WHERE status = 'pending'` — proof the table existed out-of-band
-- (dashboard) when 00015 ran, and proof of the canonical column names
-- (from_user_id, NOT sender_id). There is no prior CREATE TABLE to revive,
-- so this migration is derived entirely from code usage. The 00015 index
-- is re-created here verbatim.
--
-- Column derivation:
--   app/api/tip/checkout/route.ts
--     INSERT (L91-98): post_id, from_user_id, to_user_id (= posts.author_id),
--       amount_cents, message (sliced to 200 chars, nullable), status='pending'
--     SELECT id (L99), idempotency probe (L46-54): from_user_id + post_id +
--       amount_cents + status='pending' + created_at >= now()-60s
--     UPDATE (L139): stripe_checkout_session_id by id
--     Amount bounds (L41): 100 <= amount_cents <= 50000 (app-side; DB keeps
--       a looser > 0 invariant so price changes never need a migration)
--   app/api/stripe/webhook/handlers/checkout.ts handleTipPaymentCompleted
--     UPDATE (L179-186): status='completed', stripe_payment_intent_id,
--       completed_at — by id (uuid from session metadata)
--   app/api/settings/export/route.ts (L130-141): SELECT * ORDER BY created_at
--     — NOTE: it filters on sender_id / receiver_id, which contradicts every
--     other usage AND the 00015 index. Canonical names win (from_user_id /
--     to_user_id); the export route has a latent column-name bug (errors are
--     swallowed by `?? []`). Flagged for a separate TS fix — not papered over
--     with alias columns here.
--   status vocabulary: code writes only 'pending' and 'completed'. 'failed'
--     and 'refunded' are reserved in the CHECK so a future refund/expiry
--     webhook handler doesn't need a schema migration; nothing writes them yet.
--
-- Client / RLS analysis:
--   * tip/checkout + settings/export run under withAuth, which injects
--     getSupabaseAdmin() (lib/api/middleware.ts L250) — SERVICE ROLE.
--   * stripe webhook uses getSupabase() = getSupabaseAdmin()
--     (app/api/stripe/webhook/handlers/shared.ts L7) — SERVICE ROLE.
--   → All current reads/writes bypass RLS. Policies below are defense-in-
--     depth: tipper and recipient may SELECT their own rows; there are NO
--     INSERT/UPDATE/DELETE policies for authenticated users — money state
--     must only ever be mutated via the service role (Stripe-verified paths).

-- ============================================================
-- Table
-- ============================================================

CREATE TABLE IF NOT EXISTS tips (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Post being tipped. SET NULL (not CASCADE): tips are financial records
  -- and must survive post deletion for accounting/GDPR-export purposes.
  post_id                     uuid REFERENCES posts(id) ON DELETE SET NULL,
  -- Tipper. CASCADE: deleting the auth user erases their payment trail
  -- (GDPR — export route treats sent tips as the tipper's own data).
  from_user_id                uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Recipient (= posts.author_id at tip time). SET NULL so the tipper's
  -- payment history survives recipient account deletion.
  to_user_id                  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  amount_cents                integer NOT NULL CHECK (amount_cents > 0),  -- app enforces $1-$500 (100-50000)
  message                     text,                                       -- app slices to 200 chars
  status                      text NOT NULL DEFAULT 'pending'
                              CONSTRAINT tips_status_check
                              CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  stripe_checkout_session_id  text,                                       -- set right after session creation
  stripe_payment_intent_id    text,                                       -- set by webhook on completion
  completed_at                timestamptz,                                -- set by webhook on completion
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Indexes (query patterns)
-- ============================================================

-- Verbatim revival of 00015_payment_improvements.sql — the 60s duplicate-tip
-- probe in app/api/tip/checkout/route.ts L46-54.
CREATE INDEX IF NOT EXISTS idx_tips_idempotency
  ON tips(from_user_id, post_id, amount_cents, status)
  WHERE status = 'pending';

-- GDPR export: tips sent — WHERE from_user_id = ? ORDER BY created_at DESC
-- (also serves any "my sent tips" listing).
CREATE INDEX IF NOT EXISTS idx_tips_from_user
  ON tips (from_user_id, created_at DESC);

-- GDPR export: tips received — WHERE to_user_id = ? ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS idx_tips_to_user
  ON tips (to_user_id, created_at DESC);

-- Webhook updates target the PK (id) — no extra index needed.
-- stripe_checkout_session_id is never queried by code today; index omitted.

-- ============================================================
-- updated_at trigger (repo convention: per-table trigger fn,
-- cf. 00007_push_subscriptions.sql, 20260612144443_avoid_votes)
-- ============================================================

CREATE OR REPLACE FUNCTION update_tips_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_tips_updated_at ON tips;
CREATE TRIGGER trigger_tips_updated_at
  BEFORE UPDATE ON tips
  FOR EACH ROW
  EXECUTE FUNCTION update_tips_updated_at();

-- ============================================================
-- RLS — defense in depth (all live code paths use the service role,
-- which bypasses RLS). Current conventions: (SELECT auth.uid()) initplan
-- wrapping, no FOR ALL, one permissive policy per action.
-- ============================================================

ALTER TABLE tips ENABLE ROW LEVEL SECURITY;

-- Tipper and recipient can each see their own tips.
DROP POLICY IF EXISTS "Users can view own tips" ON tips;
CREATE POLICY "Users can view own tips"
  ON tips FOR SELECT
  USING ((SELECT auth.uid()) = from_user_id OR (SELECT auth.uid()) = to_user_id);

-- Deliberately NO INSERT/UPDATE/DELETE policies for authenticated users:
-- tip rows are created/completed exclusively through service-role code
-- paths (checkout route + Stripe webhook). The service role bypasses RLS.

COMMENT ON TABLE tips IS '帖子打赏 — Stripe one-time checkout tips on posts. Created 2026-06-12 from code usage; table was previously phantom in the repo (only the 00015 idempotency index referenced it). Writes are service-role only; status flows pending → completed via Stripe webhook.';
COMMENT ON COLUMN tips.amount_cents IS 'Tip amount in USD cents; app enforces 100-50000 ($1-$500) at app/api/tip/checkout/route.ts.';
COMMENT ON COLUMN tips.status IS 'pending (created at checkout) → completed (Stripe webhook). failed/refunded reserved, not yet written by code.';
