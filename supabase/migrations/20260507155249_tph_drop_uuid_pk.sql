-- Migration: Drop unused UUID PK from trader_position_history
-- Purpose: The `id` UUID column + its 5.3GB PK index are never queried by app code.
--          All upserts and queries use the natural key:
--          (source, source_trader_id, symbol, open_time)
--          which is already enforced via unique constraint.
-- Savings: ~5GB index space freed immediately.

ALTER TABLE trader_position_history DROP CONSTRAINT trader_position_history_pkey;
ALTER TABLE trader_position_history DROP COLUMN id;
