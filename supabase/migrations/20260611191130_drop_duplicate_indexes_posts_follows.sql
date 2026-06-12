-- Migration: 20260611191130_drop_duplicate_indexes_posts_follows.sql
-- Created: 2026-06-12T02:11:30Z
-- Description: Performance advisor (2026-06-12) — two pairs of IDENTICAL
--   indexes double the write amplification on hot tables:
--     public.posts:   idx_posts_author_created_at == idx_posts_author_id_created_at
--     public.follows: follows_pkey == idx_follows_unique_pair
--   Keep the constraint-backed/canonical one, drop the duplicate.

DROP INDEX IF EXISTS public.idx_posts_author_created_at;
DROP INDEX IF EXISTS public.idx_follows_unique_pair;
