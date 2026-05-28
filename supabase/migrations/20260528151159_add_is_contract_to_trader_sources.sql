-- Add is_contract column for on-chain contract detection (eth_getCode)
-- NULL = unchecked, TRUE = contract (definitive bot), FALSE = EOA

ALTER TABLE trader_sources
  ADD COLUMN IF NOT EXISTS is_contract BOOLEAN,
  ADD COLUMN IF NOT EXISTS contract_checked_at TIMESTAMPTZ;

-- Index for the cron job: find unchecked DEX 0x addresses efficiently
CREATE INDEX IF NOT EXISTS idx_trader_sources_unchecked_contracts
  ON trader_sources (source)
  WHERE is_contract IS NULL AND source_trader_id LIKE '0x%';

-- Index for querying known contracts
CREATE INDEX IF NOT EXISTS idx_trader_sources_is_contract
  ON trader_sources (is_contract)
  WHERE is_contract = TRUE;

COMMENT ON COLUMN trader_sources.is_contract IS 'On-chain contract detection via eth_getCode. NULL=unchecked, TRUE=contract(bot), FALSE=EOA';
COMMENT ON COLUMN trader_sources.contract_checked_at IS 'When the contract check was performed';
