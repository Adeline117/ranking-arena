-- Migration: 20260611214414_arena_currency_add_usd.sql
-- Created: 2026-06-12T04:44:14Z
-- Description: Add 'USD' to the arena.sources currency CHECK (spec §5.8).
-- Bitfinex (#26, API-first) denominates its public rankings API in literal
-- USD (tGLOBAL:USD) — not USDT/USDC. Money stays unit-honest: we extend the
-- enum rather than mislabel (the DEX USDC precedent is genuinely USDC).
-- Other arena.* tables carry free-text currency columns; only sources has
-- the CHECK.

-- Up
ALTER TABLE arena.sources DROP CONSTRAINT sources_currency_check;
ALTER TABLE arena.sources
  ADD CONSTRAINT sources_currency_check
  CHECK (currency IN ('USDT', 'USDx', 'USDC', 'USD'));
