-- ══════════════════════════════════════════════════════════════
-- Database audit fixes (2026-03-31)
-- P1-1: trader_sources composite index → already exists (00074)
-- P2-1: Social table composite indexes (missing ones only)
-- P2-3: Safety net drop of old materialized views
-- P2-5: BRIN index on trader_snapshots_v2.as_of_ts
-- ══════════════════════════════════════════════════════════════

-- P2-1: user_follows composite index for feed queries
-- (notifications and group_members already have composite indexes)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_follows_follower_created
  ON user_follows (follower_id, created_at DESC);

-- P2-3: Safety net — ensure old materialized views are gone
-- (Previously dropped in 20260319ab but adding idempotent safety net)
DROP MATERIALIZED VIEW IF EXISTS mv_leaderboard CASCADE;
DROP MATERIALIZED VIEW IF EXISTS mv_hot_posts CASCADE;

-- P2-5: BRIN index for time-series queries on snapshots_v2
-- (10x smaller than btree for monotonic timestamps)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_snapshots_v2_as_of_ts_brin
  ON trader_snapshots_v2 USING brin (as_of_ts);
