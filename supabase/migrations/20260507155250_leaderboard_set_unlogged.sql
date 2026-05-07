-- Migration: Set leaderboard_ranks to UNLOGGED
-- Purpose: Reduce WAL writes 3-5x. leaderboard_ranks is a computed table
--          rebuilt hourly by compute-leaderboard cron. If PostgreSQL crashes,
--          data is lost but auto-rebuilt within 2 hours.
-- Safety: Partitioned table — each partition must be altered individually.

ALTER TABLE lr_7d SET UNLOGGED;
ALTER TABLE lr_30d SET UNLOGGED;
ALTER TABLE lr_90d SET UNLOGGED;
ALTER TABLE lr_default SET UNLOGGED;
ALTER TABLE leaderboard_ranks SET UNLOGGED;
