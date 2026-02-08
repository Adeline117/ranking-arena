-- Migration: 00001_sample_migration
-- Description: Sample migration showing the expected format
-- Author: System
-- Date: 2026-02-08
--
-- This is a sample migration file. Replace with actual schema changes.
-- Delete this file before creating real migrations.

-- Example: Add an index for common query patterns
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_snapshots_updated
--   ON trader_snapshots(updated_at DESC);

-- Example: Add a new column
-- ALTER TABLE traders ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ;
