-- 2026-02-19: Data cleanup and ensure unique constraint
-- 1. Delete dydx empty addresses (no trades, no win_rate)
-- 2. Ensure unique constraint on (season_id, source, source_trader_id)
-- Note: constraint already exists as leaderboard_ranks_season_id_source_source_trader_id_key

-- Cleanup dydx empty addresses
DELETE FROM leaderboard_ranks 
WHERE source='dydx' AND win_rate IS NULL AND (trades_count=0 OR trades_count IS NULL);

-- Ensure unique constraint (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS uq_leaderboard_ranks_season_source_trader 
ON leaderboard_ranks (season_id, source, source_trader_id);
