-- Migration: 20260526105227_fix_leaderboard_ranks_id_sequence.sql
-- Root cause fix: leaderboard_ranks partitioned table had no DEFAULT on id column.
-- The old table (leaderboard_ranks_old, dropped in previous cleanup) owned the sequence.
-- When it was dropped, the sequence was dropped too. The new partitioned table's id
-- column was NOT NULL with no default -> every INSERT/UPSERT from compute-leaderboard
-- silently failed -> leaderboard went to 0 traders across all periods.
-- Applied manually via Supabase MCP on 2026-05-26.

CREATE SEQUENCE IF NOT EXISTS leaderboard_ranks_id_seq;
SELECT setval('leaderboard_ranks_id_seq', 1000000);
ALTER TABLE public.leaderboard_ranks ALTER COLUMN id SET DEFAULT nextval('leaderboard_ranks_id_seq');
GRANT USAGE, SELECT ON SEQUENCE leaderboard_ranks_id_seq TO service_role, postgres, anon, authenticated;
