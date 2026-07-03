-- Migration: 20260703004516_add_user_profiles_stripe_customer_id.sql
-- Created: 2026-07-03T07:45:16Z
-- Description: Add the missing `stripe_customer_id` column to public.user_profiles
--             (schema drift fix — breaks all Stripe webhook reconciliation).
--
-- The entire payment layer reads/writes user_profiles.stripe_customer_id:
--   - invoice/refund webhooks: .eq('stripe_customer_id', customerId) to find the
--     user for a Stripe event (these SELECTs 500 without the column → payment
--     events never reconcile back to grant/revoke Pro);
--   - verify-session / checkout / portal / tip / sync-subscription write & read it;
--   - migrations 00015 (SECURITY DEFINER upsert fn) and 00079 both ASSUMED it
--     already existed ("stripe_customer_id 已存在") — but prod user_profiles only
--     ever had stripe_subscription_id. The column was never actually applied.
-- Currently masked by PRO_FREE_PROMO (everyone is Pro regardless of sync).
-- Surfaced by the column-drift guard (qa:insert-drift, 7 write sites).
--
-- Additive + reversible: nullable text; index for the webhook lookups by customer.

-- Up
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS stripe_customer_id text;

CREATE INDEX IF NOT EXISTS idx_user_profiles_stripe_customer_id
  ON public.user_profiles (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
