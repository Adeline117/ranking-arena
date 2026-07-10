-- Migration: 20260710015607_comments_soft_delete_columns.sql
-- Created: 2026-07-10T08:56:07Z
-- Description: Add soft-delete columns to public.comments so /api/report can
-- SOFT-hide comments (mirror of the posts auto-hide path) instead of the old
-- irreversible hard DELETE. A bot swarm of throwaway accounts could previously
-- permanently and unrecoverably delete any real comment via 3 reports. Soft
-- delete keeps the row recoverable + auditable.

-- Up
ALTER TABLE public.comments
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid,
  ADD COLUMN IF NOT EXISTS delete_reason text;

-- Partial index so the common "not deleted" comment read path stays fast.
CREATE INDEX IF NOT EXISTS idx_comments_not_deleted
  ON public.comments (post_id)
  WHERE deleted_at IS NULL;
