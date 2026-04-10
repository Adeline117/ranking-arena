-- Migration: 20260409173945_drop_kol_applications_table.sql
-- Created: 2026-04-10T00:39:45Z
-- Description: Drop kol_applications + kol_tier column.
--
-- WHY: Both /kol/apply (deleted in c123bf429) and /admin/kol (deleted in
-- this PR) are gone. The kol_applications table is now write-and-read by
-- nothing, and `user_profiles.kol_tier` has zero TypeScript references.
-- Keeping orphaned tables/columns invites accidental re-coupling and
-- silent RLS drift. See docs/reviews/scope-audit-2026-04-09.md.
--
-- Reversibility: original schema lives in 20260208180000_kol_and_moderation.sql
-- if the KOL feature is ever re-introduced.

-- ============================================================================
-- Drop the table (and its RLS policies via CASCADE)
-- ============================================================================
DROP TABLE IF EXISTS public.kol_applications CASCADE;

-- ============================================================================
-- Drop the now-orphaned column on user_profiles
-- ============================================================================
ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS kol_tier;
