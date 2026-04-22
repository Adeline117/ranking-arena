-- Migration: 20260422121411_unique_default_bookmark_folder.sql
-- Created: 2026-04-22T19:14:11Z
-- Description: Prevent TOCTOU race on default bookmark folder creation.
-- Two concurrent bookmark requests could both create a default folder
-- because check-then-insert had no DB-level uniqueness guard.

-- Partial unique index: only one is_default=true row per user.
-- Concurrent INSERT will get unique violation → second request reuses existing.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'bookmark_folders') THEN
    -- Clean up duplicates first (keep the oldest one)
    DELETE FROM bookmark_folders bf
    WHERE bf.is_default = true
      AND bf.id != (
        SELECT id FROM bookmark_folders bf2
        WHERE bf2.user_id = bf.user_id AND bf2.is_default = true
        ORDER BY bf2.created_at ASC
        LIMIT 1
      );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bookmark_folders_one_default_per_user
      ON bookmark_folders (user_id)
      WHERE is_default = true;
  END IF;
END $$;
