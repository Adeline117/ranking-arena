-- Add bytecode size to distinguish real bot contracts from proxy/wallet contracts.
-- Proxies (<100 bytes) are protocol infrastructure (Gains per-user proxies,
-- smart wallets, ERC-4337 accounts) — NOT bots.

ALTER TABLE trader_sources
  ADD COLUMN IF NOT EXISTS contract_bytecode_size INTEGER;

COMMENT ON COLUMN trader_sources.contract_bytecode_size IS 'Bytecode size in bytes. 0=EOA, <100=proxy/wallet, >=100=real contract(bot)';

-- Fix false positives: reset previously-marked contracts that need re-checking.
-- The cron job will re-check them with bytecode size awareness.
-- We reset is_contract to NULL so the cron picks them up again.
UPDATE trader_sources
SET is_contract = NULL,
    contract_checked_at = NULL
WHERE is_contract = true
  AND contract_bytecode_size IS NULL;
