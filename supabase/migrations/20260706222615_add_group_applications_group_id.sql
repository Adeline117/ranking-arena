-- Migration: 20260706222615_add_group_applications_group_id.sql
-- Created: 2026-07-07T05:26:15Z
-- Description: Link an approved group application to the group it created (U9-10).
--
-- Switching group creation from "apply auto-approves + creates group" to a real
-- admin review flow: apply now inserts a PENDING application and creates nothing;
-- the group is created on admin approval. This column records which group an
-- approval produced, so the "我的申请 / My applications" list can show a
-- "前往小组 / Go to group" link on approved cards (the U9-10 dead-info fix). NULL
-- while pending/rejected. ON DELETE SET NULL: if the group is later deleted, the
-- historical application row survives with a dangling-but-null pointer.

-- Up
ALTER TABLE public.group_applications
  ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES public.groups(id) ON DELETE SET NULL;
