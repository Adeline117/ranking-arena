-- Performance: No DB changes needed for this optimization round.
-- This migration is a documentation marker for the getUser() → getSession() migration.
--
-- Changes made in application code:
-- 1. Replaced supabase.auth.getUser() with supabase.auth.getSession() in 8 client components
--    - getUser() makes a network request to Supabase Auth server every time
--    - getSession() reads from local storage (zero latency)
--    - This eliminates 5-8 unnecessary API calls per page load
--
-- 2. MarketPanel polling reduced from 10s to 30s (matches CDN cache TTL)
-- 3. Added visibility-based refresh to MarketPanel
-- 4. Added framer-motion to optimizePackageImports for better tree-shaking

-- Index for getInitialTraders source filtering (already covered by existing indexes)
-- idx_trader_snapshots_season_arena ON (season_id, arena_score DESC) WHERE arena_score IS NOT NULL
-- covers the main SSR query path well.

SELECT 1; -- no-op migration
