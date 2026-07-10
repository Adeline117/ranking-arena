-- Migration: 20260710015608_user_interactions_impression_dedup.sql
-- Created: 2026-07-10T08:56:08Z
-- Description: Prevent impression-count inflation (feed-ranking abuse, airdrop
-- bot amplified). Two parts:
--   1. Partial UNIQUE index so each (user, post) can only ever record ONE
--      'impression' row. A repeat impression insert now returns 23505, which
--      the /api/track handler treats as "already counted" and skips the bump.
--   2. increment_impression_count(post_id) atomic RPC to replace the
--      read-then-write (+1) pattern that had a lost-update race.

-- Up

-- 1a. De-duplicate any pre-existing impression rows (keep the earliest ctid)
--     so the UNIQUE index can be created. (Prod currently has 0 dup groups,
--     but this is defensive since impressions accumulate over time.)
DELETE FROM public.user_interactions a
USING public.user_interactions b
WHERE a.action = 'impression'
  AND b.action = 'impression'
  AND a.user_id = b.user_id
  AND a.target_type = b.target_type
  AND a.target_id = b.target_id
  AND a.ctid > b.ctid;

-- 1b. Enforce one impression per (user, post/target) going forward.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_interactions_impression
  ON public.user_interactions (user_id, target_type, target_id)
  WHERE action = 'impression';

-- 2. Atomic impression counter (mirrors the increment_*_count family).
CREATE OR REPLACE FUNCTION public.increment_impression_count(post_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.posts
  SET impression_count = COALESCE(impression_count, 0) + 1
  WHERE id = post_id;
$$;
