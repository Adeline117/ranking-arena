-- Migration: 20260702234121_add_groups_slug_column.sql
-- Created: 2026-07-03T06:41:21Z
-- Description: Add the missing `slug` column to public.groups (schema drift fix).
--
-- app/api/groups/apply/route.ts inserts a `slug` value on group creation, but
-- production `groups` never had the column. Result: EVERY group creation 500'd
-- with PGRST204 "Could not find the 'slug' column of 'groups' in the schema
-- cache" — group creation was fully broken in production. Surfaced by the QA
-- write-flow sweep (auth-button-sweep Step 13, B-4).
--
-- Additive + reversible: nullable text; existing rows stay NULL. Partial unique
-- index enforces uniqueness only where set (multiple NULLs allowed), matching
-- the route's intent (slug derived from the already-unique group name).

-- Up
ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS slug text;

CREATE UNIQUE INDEX IF NOT EXISTS groups_slug_key
  ON public.groups (slug)
  WHERE slug IS NOT NULL;
