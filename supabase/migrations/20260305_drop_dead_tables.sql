-- Drop dead tables and clean up indexes — 2026-03-05
-- These tables have ZERO code references and zero (or orphan) rows.
-- Verified via full codebase grep of .from('table_name') patterns.

-- ============================================================
-- 1. DROP 17 dead tables
-- ============================================================
DROP TABLE IF EXISTS advanced_alert_conditions CASCADE;
DROP TABLE IF EXISTS cluster_members CASCADE;
DROP TABLE IF EXISTS clusters CASCADE;
DROP TABLE IF EXISTS funding_hubs CASCADE;
DROP TABLE IF EXISTS group_join_requests CASCADE;
DROP TABLE IF EXISTS group_rules CASCADE;
DROP TABLE IF EXISTS labels CASCADE;
DROP TABLE IF EXISTS ledger_entries CASCADE;
DROP TABLE IF EXISTS post_comments CASCADE;
DROP TABLE IF EXISTS project_interactions CASCADE;
DROP TABLE IF EXISTS project_labels CASCADE;
DROP TABLE IF EXISTS project_wallets CASCADE;
DROP TABLE IF EXISTS projects CASCADE;
DROP TABLE IF EXISTS risk_scores CASCADE;
DROP TABLE IF EXISTS strategies CASCADE;
DROP TABLE IF EXISTS transfers CASCADE;
DROP TABLE IF EXISTS wallet_metadata CASCADE;

-- ============================================================
-- 2. DROP 8 redundant indexes
-- ============================================================

-- leaderboard_ranks: duplicate unique index
DROP INDEX IF EXISTS uq_leaderboard_ranks_season_source_trader;

-- leaderboard_ranks: covered by idx_leaderboard_ranks_season_arena_score_desc (has INCLUDE)
DROP INDEX IF EXISTS idx_leaderboard_ranks_season_score;

-- leaderboard_ranks: covered by multiple (source, ...) composite indexes
DROP INDEX IF EXISTS idx_lr_source;

-- posts: duplicate of idx_posts_created_at
DROP INDEX IF EXISTS idx_posts_created_desc;

-- posts: duplicate of idx_posts_group_created
DROP INDEX IF EXISTS idx_posts_group_created_at;

-- traders: overlap with traders_source_id_unique (which has WHERE clause)
DROP INDEX IF EXISTS traders_source_stid_uniq;

-- trader_snapshots: near-duplicate of idx_trader_snapshots_arena_score
DROP INDEX IF EXISTS idx_trader_snapshots_v2_season_arena;

-- trader_sources: covered by trader_sources_uniq (which adds source_type)
DROP INDEX IF EXISTS trader_sources_source_source_trader_id_key;

-- ============================================================
-- 3. CREATE 2 missing indexes
-- ============================================================

-- trader_follows: lookup followers by trader
CREATE INDEX IF NOT EXISTS idx_trader_follows_trader
ON trader_follows(source, source_trader_id);

-- feedback: filter by status + sort by time
CREATE INDEX IF NOT EXISTS idx_feedback_status_created
ON feedback(status, created_at DESC);

-- ============================================================
-- 4. Clean up orphan traders (4275 records with no trader_sources match)
-- All created before 2026-03-01
-- ============================================================
DELETE FROM traders t
WHERE NOT EXISTS (
  SELECT 1 FROM trader_sources ts WHERE ts.handle = t.handle
)
AND t.created_at < '2026-03-01';
