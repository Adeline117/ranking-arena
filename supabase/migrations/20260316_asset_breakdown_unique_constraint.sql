-- Add unique constraint on trader_asset_breakdown for upsert ON CONFLICT to work.
-- The upsert uses (source, source_trader_id, period, symbol) as conflict key.
-- Without this constraint, all upserts fail with error 42P10.

-- First deduplicate existing rows (keep the newest by id)
DELETE FROM trader_asset_breakdown a
USING trader_asset_breakdown b
WHERE a.source = b.source
  AND a.source_trader_id = b.source_trader_id
  AND a.period = b.period
  AND a.symbol = b.symbol
  AND a.id < b.id;

-- Now add the unique constraint
ALTER TABLE trader_asset_breakdown
  ADD CONSTRAINT uq_asset_breakdown_source_trader_period_symbol
  UNIQUE (source, source_trader_id, period, symbol);
