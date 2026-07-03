-- Migration: 20260703004700_add_subscriptions_plan_cancel_fields.sql
-- Created: 2026-07-03T07:47:00Z
-- Description: TODO — explain what this migration does and why

-- Concurrency Safety Checklist (delete after reviewing):
-- [ ] New tables with one-per-user rows: add UNIQUE or partial unique index
-- [ ] Counter columns: use atomic RPC (lib 00021), NOT trigger-based count+1
-- [ ] Check-then-act patterns: use pg_advisory_xact_lock or SELECT FOR UPDATE
-- [ ] FK to parent: include ON DELETE CASCADE
-- [ ] New functions: add SET search_path = public, SECURITY DEFINER if needed
-- [ ] 应用后跑 npm run qa:schema 核对落地 —— "写进仓库 ≠ 应用到生产"(2026-06 漂移教训)

-- Add missing plan / cancel_at_period_end / canceled_at columns to subscriptions
-- (schema drift — breaks ALL Stripe subscription webhooks).
--
-- The RPC public.update_subscription_and_profile INSERTs subscriptions.plan and
-- .cancel_at_period_end; the webhook fallback upsert writes the same; the cancel
-- handler writes .canceled_at. None existed in prod → the RPC 500s, the fallback
-- 500s → every customer.subscription.created/updated/deleted event failed to
-- sync (masked by PRO_FREE_PROMO). Surfaced by qa:insert-drift.
-- Additive + reversible. plan = billing interval label ('monthly'/'yearly'/…),
-- distinct from tier ('pro'/'free'); cancel_at_period_end mirrors Stripe's bool.

-- Up
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS plan text;
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS canceled_at timestamptz;
