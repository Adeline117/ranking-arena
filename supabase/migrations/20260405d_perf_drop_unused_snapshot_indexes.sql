-- Performance: drop barely-used indexes from trader_snapshots_v2 partitions
-- These slow down every upsert (254ms avg, 61K calls = 15.7M ms total)
-- Each dropped index speeds up writes by reducing index maintenance overhead
--
-- idx_snapshots_v2_part_roi_ranking: 154 MB, 94 scans total (across all partitions)
--   Definition: (platform, market_type, window, roi_pct DESC NULLS LAST)
--   Reason: leaderboard rankings now use leaderboard_ranks table, not snapshots
--
-- idx_snapshots_v2_part_trader: 174 MB, 162 scans total
--   Definition: (platform, market_type, trader_key, window, as_of_ts DESC)
--   Reason: redundant with upsert unique constraint index (4.5M scans)

DROP INDEX IF EXISTS idx_snapshots_v2_part_roi_ranking;
DROP INDEX IF EXISTS idx_snapshots_v2_part_trader;
