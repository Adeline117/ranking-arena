-- Migration: 20260612131515_fix_posts_insert_rls_tautology.sql
-- Created: 2026-06-12T20:15:15Z
-- Description: Fix posts INSERT RLS policy tautology (QA button audit, 2026-06-12)
--
-- The old posts_insert_member with_check contained a self-comparison:
--   EXISTS (SELECT 1 FROM group_members gm
--           WHERE gm.group_id = gm.group_id   -- ⚠️ always true; meant posts.group_id
--             AND gm.user_id = auth.uid())
--
-- Two consequences:
--   1. Users who belong to NO group (every new user) could not create ANY
--      post — including general (group_id IS NULL) posts. Surfaced as a 500
--      from POST /api/posts.
--   2. Membership of ANY one group granted posting into EVERY group —
--      the per-group membership check was never actually enforced.
--
-- New policy:
--   - general posts (group_id IS NULL): any authenticated user, as themselves
--   - group posts: must be a member of THAT group

-- Up
DROP POLICY IF EXISTS posts_insert_member ON public.posts;

CREATE POLICY posts_insert_member ON public.posts
  FOR INSERT TO authenticated
  WITH CHECK (
    author_id = (SELECT auth.uid())
    AND (
      group_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.group_members gm
        WHERE gm.group_id = posts.group_id
          AND gm.user_id = (SELECT auth.uid())
      )
    )
  );
