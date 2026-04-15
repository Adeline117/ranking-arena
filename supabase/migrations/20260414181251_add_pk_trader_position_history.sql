-- Migration: add_pk_trader_position_history
-- Purpose: Add primary key to the last table without one (13 GB, 84M rows)
-- Strategy: CREATE UNIQUE INDEX CONCURRENTLY (no lock) + REINDEX if needed
--           then ALTER TABLE ADD CONSTRAINT ... USING INDEX
-- Applied live via psql before this migration file was created.

-- Step 1: Build unique index concurrently (no table lock)
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS trader_position_history_pkey_idx
ON public.trader_position_history (id);

-- Step 2: Promote to PK using the pre-built index
ALTER TABLE public.trader_position_history
ADD CONSTRAINT trader_position_history_pkey PRIMARY KEY USING INDEX trader_position_history_pkey_idx;
