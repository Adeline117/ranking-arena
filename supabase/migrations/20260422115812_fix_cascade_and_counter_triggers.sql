-- Migration: 20260422115812_fix_cascade_and_counter_triggers.sql
-- Created: 2026-04-22T18:58:17Z
-- Description: Fix two data integrity issues:
--   1. Ensure ON DELETE CASCADE on post child tables (comments, likes, bookmarks)
--      so post deletion atomically removes all children.
--   2. Drop non-atomic counter triggers that race under concurrency.
--      Counters will be maintained by periodic recount (cron) + atomic RPC functions
--      (already in 00021_atomic_counter_functions.sql).

-- ============================================================================
-- 1. Ensure CASCADE on post child FKs
-- ============================================================================
-- If the FK already has CASCADE, ALTER is a no-op (idempotent).
-- If the FK exists without CASCADE, we drop and recreate it.

-- comments.post_id → posts.id
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
    WHERE tc.table_name = 'comments' AND ccu.column_name = 'post_id'
      AND tc.constraint_type = 'FOREIGN KEY'
  ) THEN
    -- Check if CASCADE already set
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.referential_constraints rc
      JOIN information_schema.table_constraints tc ON rc.constraint_name = tc.constraint_name
      WHERE tc.table_name = 'comments' AND rc.delete_rule = 'CASCADE'
        AND tc.constraint_type = 'FOREIGN KEY'
    ) THEN
      -- Drop and recreate with CASCADE
      ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_post_id_fkey;
      ALTER TABLE comments ADD CONSTRAINT comments_post_id_fkey
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE;
    END IF;
  END IF;
END $$;

-- post_likes.post_id → posts.id
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'post_likes') THEN
    ALTER TABLE post_likes DROP CONSTRAINT IF EXISTS post_likes_post_id_fkey;
    ALTER TABLE post_likes ADD CONSTRAINT post_likes_post_id_fkey
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE;
  END IF;
END $$;

-- post_bookmarks.post_id → posts.id
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'post_bookmarks') THEN
    ALTER TABLE post_bookmarks DROP CONSTRAINT IF EXISTS post_bookmarks_post_id_fkey;
    ALTER TABLE post_bookmarks ADD CONSTRAINT post_bookmarks_post_id_fkey
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ============================================================================
-- 2. Drop non-atomic counter triggers
-- ============================================================================
-- These triggers use `SET count = count + 1` which races under READ COMMITTED.
-- Atomic RPC functions (00021) + periodic recount cron replace them.

DROP TRIGGER IF EXISTS trigger_update_post_comment_count ON comments;
DROP TRIGGER IF EXISTS trigger_update_follow_counts ON user_follows;

-- Keep the functions in case other code references them, but they won't auto-fire.
-- To fully remove: DROP FUNCTION IF EXISTS update_post_comment_count() CASCADE;
-- To fully remove: DROP FUNCTION IF EXISTS update_follow_counts() CASCADE;
