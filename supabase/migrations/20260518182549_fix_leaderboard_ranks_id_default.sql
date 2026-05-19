-- CRITICAL FIX: leaderboard_ranks partitions missing id DEFAULT nextval()
--
-- Root cause: when leaderboard_ranks was rebuilt as a partitioned table, the
-- id column DEFAULT was not carried over from the original table. This caused
-- every compute-leaderboard upsert to fail with "null value in column id
-- violates not-null constraint" — but the error was swallowed by Supabase
-- client returning an error object that the cron job logged but continued past.
--
-- Impact: 0 traders in leaderboard_ranks since ~2026-05-07 (12 days).
-- Homepage pagination, search for traders, movers, platform-stats all broken.
-- Only /api/rankings/live (Redis-backed) still worked.

ALTER TABLE leaderboard_ranks ALTER COLUMN id SET DEFAULT nextval('leaderboard_ranks_id_seq');
ALTER TABLE lr_7d ALTER COLUMN id SET DEFAULT nextval('leaderboard_ranks_id_seq');
ALTER TABLE lr_30d ALTER COLUMN id SET DEFAULT nextval('leaderboard_ranks_id_seq');
ALTER TABLE lr_90d ALTER COLUMN id SET DEFAULT nextval('leaderboard_ranks_id_seq');
ALTER TABLE lr_default ALTER COLUMN id SET DEFAULT nextval('leaderboard_ranks_id_seq');

SELECT setval('leaderboard_ranks_id_seq', COALESCE((SELECT MAX(id) FROM leaderboard_ranks_old), 1));
