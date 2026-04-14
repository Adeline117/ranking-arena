-- Migration: fix_remaining_advisors
-- Purpose: Fix last policy overlap, add PKs to 8 tables, consolidate policies
-- Applied live before this migration file was created.

-- 1. Last multiple_permissive overlap: channel_members ALL → INSERT+UPDATE+DELETE
DROP POLICY IF EXISTS "Channel admins can manage members" ON public.channel_members;
CREATE POLICY "Channel admins can insert members" ON public.channel_members
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (channel_id IN (SELECT cm.channel_id FROM channel_members cm
    WHERE cm.user_id = (SELECT auth.uid()) AND cm.role = ANY(ARRAY['owner','admin'])));
CREATE POLICY "Channel admins can update members" ON public.channel_members
  AS PERMISSIVE FOR UPDATE TO public
  USING (channel_id IN (SELECT cm.channel_id FROM channel_members cm
    WHERE cm.user_id = (SELECT auth.uid()) AND cm.role = ANY(ARRAY['owner','admin'])));
CREATE POLICY "Channel admins can delete members" ON public.channel_members
  AS PERMISSIVE FOR DELETE TO public
  USING (channel_id IN (SELECT cm.channel_id FROM channel_members cm
    WHERE cm.user_id = (SELECT auth.uid()) AND cm.role = ANY(ARRAY['owner','admin'])));

-- 2. Add primary keys to tables without PKs (skip 13GB trader_position_history)
ALTER TABLE public.follows ADD PRIMARY KEY (user_id, trader_id);
ALTER TABLE public.tph_2026_01 ADD PRIMARY KEY (id);
ALTER TABLE public.tph_2026_02 ADD PRIMARY KEY (id);
ALTER TABLE public.tph_2026_03 ADD PRIMARY KEY (id);
ALTER TABLE public.tph_2026_04 ADD PRIMARY KEY (id);
ALTER TABLE public.tph_2026_05 ADD PRIMARY KEY (id);
ALTER TABLE public.tph_2026_06 ADD PRIMARY KEY (id);
ALTER TABLE public.tph_archive ADD PRIMARY KEY (id);
