-- Migration: 20260506173111_add_missing_perf_indexes_posts_user_profiles.sql
-- Created: 2026-05-07T00:31:11Z
-- Description: Add 2 missing performance indexes found by 6-agent deep audit.
--
-- Root cause: missing composite indexes cause full table scans on
-- author feeds and exact-match user profile lookups.

-- 1. Posts author feed: queries filter by author_id + sort by created_at DESC.
-- lib/data/posts.ts line 308 does .eq('author_id', x).order('created_at', desc).
-- Without this index, author-specific feeds trigger sequential scans on posts.
CREATE INDEX IF NOT EXISTS idx_posts_author_id_created_at
  ON posts (author_id, created_at DESC);

-- 2. User profiles exact handle lookup: trigram indexes exist for ILIKE search,
-- but .eq('handle', x) exact matches don't benefit from trigram.
-- This B-tree index covers the common case of exact profile lookups.
CREATE INDEX IF NOT EXISTS idx_user_profiles_handle_btree
  ON user_profiles (handle)
  WHERE handle IS NOT NULL;
