-- Migration: 20260701220308_competition_entries_prev_rank.sql
-- Created: 2026-07-02T05:03:08Z
-- Description: Cross-session rank-movement for competitions (audit follow-up,
-- owner-approved 2026-07-02). The update-competitions cron overwrites `rank`
-- every 30 min with no history, so standings ▲/▼ badges could only show
-- movement observed while the viewer polls. Store the previous rank at
-- recompute time so the FIRST render can show movement since the last cycle.

-- Up
ALTER TABLE public.competition_entries
  ADD COLUMN IF NOT EXISTS prev_rank integer;

COMMENT ON COLUMN public.competition_entries.prev_rank IS
  'Rank before the latest update-competitions recompute (30-min cadence); null until the second recompute after entry.';
