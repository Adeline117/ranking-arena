-- Migration: 20260707152533_add_groups_name_unique_ci.sql
-- Created: 2026-07-07T22:25:33Z
-- Description: Case-insensitive unique index on groups.name (W2 audit defense-in-depth)

-- Defense-in-depth for group creation (W2 audit 2026-07-07).
--
-- The approve path's duplicate-group race is already killed by the atomic
-- `UPDATE ... WHERE status='pending'` claim gate, and apply-time does a
-- check-then-act name-collision check — but that check has no DB backstop, so a
-- fast double-submit (or two admins) could still race two same-named groups in.
-- `groups.name` had NO unique constraint (only `slug` did, and the slug fallback
-- `group-${Date.now()}` can diverge for ja/ko/emoji names). Add a case-insensitive
-- partial unique index so the database is the final arbiter of name uniqueness,
-- matching the intent the apply-time check already encodes.
--
-- Verified before applying (prod project iknktzifjdyujdccyhsv): 23 groups, 0 null
-- names, 0 empty names, 23 distinct lower(name) — no existing collision, index
-- builds cleanly. Partial (WHERE name IS NOT NULL) so any future null name is
-- unaffected; multiple nulls already allowed by UNIQUE semantics regardless.

-- Up
CREATE UNIQUE INDEX IF NOT EXISTS groups_name_lower_unique
  ON public.groups (lower(name))
  WHERE name IS NOT NULL;
