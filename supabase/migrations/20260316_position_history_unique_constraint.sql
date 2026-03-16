-- Add unique constraint on trader_position_history for upsert ON CONFLICT to work.
-- The upsert uses (source, source_trader_id, symbol, open_time) as conflict key.
-- Without this constraint, all upserts fail with error 42P10.

-- First deduplicate existing rows (keep the newest by updated_at)
DELETE FROM trader_position_history a
USING trader_position_history b
WHERE a.source = b.source
  AND a.source_trader_id = b.source_trader_id
  AND a.symbol = b.symbol
  AND a.open_time = b.open_time
  AND a.id < b.id;

-- Now add the unique constraint
ALTER TABLE trader_position_history
  ADD CONSTRAINT uq_position_history_source_trader_symbol_opentime
  UNIQUE (source, source_trader_id, symbol, open_time);
