-- Migration: 20260703005310_add_missing_feature_columns.sql
-- Created: 2026-07-03T07:53:10Z
-- Description: TODO — explain what this migration does and why

-- Concurrency Safety Checklist (delete after reviewing):
-- [ ] New tables with one-per-user rows: add UNIQUE or partial unique index
-- [ ] Counter columns: use atomic RPC (lib 00021), NOT trigger-based count+1
-- [ ] Check-then-act patterns: use pg_advisory_xact_lock or SELECT FOR UPDATE
-- [ ] FK to parent: include ON DELETE CASCADE
-- [ ] New functions: add SET search_path = public, SECURITY DEFINER if needed
-- [ ] 应用后跑 npm run qa:schema 核对落地 —— "写进仓库 ≠ 应用到生产"(2026-06 漂移教训)

-- Add columns that feature code reads AND writes but were never migrated
-- (schema drift — each write 500s). Surfaced by qa:insert-drift. All additive.
--
--  - oauth_states.code_verifier: exchange OAuth PKCE. authorize stores it,
--    callback reads it (select code_verifier) for the token exchange. Without it
--    every PKCE exchange-connect 500s.
--  - gifts.to_user_id: tip/route inserts recipient; gifts already has
--    from_user_id/post_id/amount/asset (right table), just missing recipient.
--  - user_profiles.nft_token_id / nft_minted_at: NFT-membership webhook writes
--    the minted token onto the user.
--  - trader_attestations.trader_handle / attestation_uid / published_at /
--    updated_at: attestation/mint upserts with onConflict='trader_handle' and
--    reads these back — the whole attestation feature 500s without them. The
--    onConflict requires a UNIQUE index on trader_handle.

-- Up
ALTER TABLE public.oauth_states ADD COLUMN IF NOT EXISTS code_verifier text;

ALTER TABLE public.gifts ADD COLUMN IF NOT EXISTS to_user_id uuid;

ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS nft_token_id text;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS nft_minted_at timestamptz;

ALTER TABLE public.trader_attestations ADD COLUMN IF NOT EXISTS trader_handle text;
ALTER TABLE public.trader_attestations ADD COLUMN IF NOT EXISTS attestation_uid text;
ALTER TABLE public.trader_attestations ADD COLUMN IF NOT EXISTS published_at timestamptz;
ALTER TABLE public.trader_attestations ADD COLUMN IF NOT EXISTS updated_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS trader_attestations_trader_handle_key
  ON public.trader_attestations (trader_handle)
  WHERE trader_handle IS NOT NULL;
