-- Description: ARENA_DATA_SPEC §7 #2 — binance_futures was seeded with
-- timeframes_native='{90}' (a typo; should be 7/30/90 like binance_spot).
-- The adapter crawls all three regardless, but scheduler derived-board
-- logic + the frontend capability matrix read this column, so the wrong
-- value mislabels the source's available timeframes. Idempotent.

UPDATE arena.sources SET timeframes_native = '{7,30,90}'
WHERE slug = 'binance_futures' AND timeframes_native = '{90}';
