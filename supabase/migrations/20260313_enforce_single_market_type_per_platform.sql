-- Enforce single market_type per platform in trader_snapshots_v2 and trader_profiles_v2.
--
-- Background: Different write paths (connector vs inline fetcher vs refresh_jobs) were
-- writing different market_type values for the same platform (e.g., 'perp', 'web3', 'futures'
-- all for 'hyperliquid'). This caused 11K+ duplicate rows in snapshots_v2 and 6K+ in profiles_v2.
--
-- Fix: Code now resolves canonical market_type via SOURCE_TYPE_MAP.
-- This constraint adds a DB-level safeguard: each (platform, trader_key, window) combo
-- can only have ONE row regardless of market_type.
--
-- Run AFTER data cleanup (stale futures/perp rows already deleted and merged to canonical web3).

-- Add tighter unique constraint: one row per (platform, trader_key, window)
-- This prevents any future market_type mismatch from creating duplicates
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_snapshots_v2_platform_key_window
  ON trader_snapshots_v2 (platform, trader_key, "window");

-- Same for profiles: one row per (platform, trader_key)
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_profiles_v2_platform_key
  ON trader_profiles_v2 (platform, trader_key);

-- Drop redundant non-unique indexes (now subsumed by the unique indexes above)
-- Note: Run these as separate statements since CONCURRENTLY cannot be in a transaction
DROP INDEX CONCURRENTLY IF EXISTS idx_trader_snapshots_v2_platform_key_window;
DROP INDEX CONCURRENTLY IF EXISTS idx_trader_profiles_v2_platform_key;
