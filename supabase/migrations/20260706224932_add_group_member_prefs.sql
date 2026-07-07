-- Migration: 20260706224932_add_group_member_prefs.sql
-- Created: 2026-07-07T05:49:32Z
-- Description: Per-member group preferences — self-mute + pin (U9-12).
--
-- group_members already has `notifications_muted`/`muted_by`/`mute_reason` — but
-- that is ADMIN moderation (an admin silences a disruptive member; muted_by set).
-- U9-12 wants MEMBER-controlled prefs, semantically distinct, so we add:
--   * self_notify_muted — the member muted the group's admin broadcasts for
--     themselves (default false = still receive them; the notify broadcast route
--     excludes rows where this is true).
--   * pinned — the member pinned this group to the top of their "my groups" list.
-- Both default false and live on the existing per-membership row (no new table).

-- Up
ALTER TABLE public.group_members
  ADD COLUMN IF NOT EXISTS self_notify_muted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
