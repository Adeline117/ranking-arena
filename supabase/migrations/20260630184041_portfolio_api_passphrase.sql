-- Migration: 20260630184041_portfolio_api_passphrase.sql
-- Created: 2026-07-01T01:40:41Z
-- Description: TODO — explain what this migration does and why

-- Concurrency Safety Checklist (delete after reviewing):
-- [ ] New tables with one-per-user rows: add UNIQUE or partial unique index
-- [ ] Counter columns: use atomic RPC (lib 00021), NOT trigger-based count+1
-- [ ] Check-then-act patterns: use pg_advisory_xact_lock or SELECT FOR UPDATE
-- [ ] FK to parent: include ON DELETE CASCADE
-- [ ] New functions: add SET search_path = public, SECURITY DEFINER if needed
-- [ ] 应用后跑 npm run qa:schema 核对落地 —— "写进仓库 ≠ 应用到生产"(2026-06 漂移教训)

-- Optional encrypted API passphrase for exchanges that require one (Bitget,
-- KuCoin, CoinEx, OKX). Stored the same way as the key/secret
-- (AES-256-GCM via lib/exchange/secure-encryption). Nullable: most exchanges
-- (Bybit, MEXC, Gate, etc.) don't use a passphrase.

-- Up
ALTER TABLE public.user_portfolios
  ADD COLUMN IF NOT EXISTS api_passphrase_encrypted text;
