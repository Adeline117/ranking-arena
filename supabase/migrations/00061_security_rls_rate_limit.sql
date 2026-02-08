-- 00061: Security hardening - Add missing RLS policies for user-facing tables
-- Tables with RLS enabled but no policies are locked to service_role only.
-- Adding user-facing policies where the API needs client access.

-- ============================================================
-- post_bookmarks - Users manage their own bookmarks
-- ============================================================
CREATE POLICY "post_bookmarks_select_own" ON public.post_bookmarks
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "post_bookmarks_insert_own" ON public.post_bookmarks
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "post_bookmarks_delete_own" ON public.post_bookmarks
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================
-- blocked_users - Users manage their own blocks
-- ============================================================
CREATE POLICY "blocked_users_select_own" ON public.blocked_users
  FOR SELECT USING (auth.uid() = blocker_id);

CREATE POLICY "blocked_users_insert_own" ON public.blocked_users
  FOR INSERT WITH CHECK (auth.uid() = blocker_id);

CREATE POLICY "blocked_users_delete_own" ON public.blocked_users
  FOR DELETE USING (auth.uid() = blocker_id);

-- ============================================================
-- reposts - Public read, users manage their own
-- ============================================================
CREATE POLICY "reposts_select_all" ON public.reposts
  FOR SELECT USING (true);

CREATE POLICY "reposts_insert_own" ON public.reposts
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "reposts_delete_own" ON public.reposts
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================
-- post_reactions - Public read, users manage their own
-- ============================================================
CREATE POLICY "post_reactions_select_all" ON public.post_reactions
  FOR SELECT USING (true);

CREATE POLICY "post_reactions_insert_own" ON public.post_reactions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "post_reactions_delete_own" ON public.post_reactions
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================
-- group_bans - Group admins can manage, banned users can see own
-- ============================================================
CREATE POLICY "group_bans_select_member" ON public.group_bans
  FOR SELECT USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_bans.group_id
        AND gm.user_id = auth.uid()
        AND gm.role IN ('admin', 'owner')
    )
  );

CREATE POLICY "group_bans_insert_admin" ON public.group_bans
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_bans.group_id
        AND gm.user_id = auth.uid()
        AND gm.role IN ('admin', 'owner')
    )
  );

CREATE POLICY "group_bans_delete_admin" ON public.group_bans
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_bans.group_id
        AND gm.user_id = auth.uid()
        AND gm.role IN ('admin', 'owner')
    )
  );

-- ============================================================
-- group_invites - Group admins can manage invites
-- ============================================================
CREATE POLICY "group_invites_select_admin" ON public.group_invites
  FOR SELECT USING (
    auth.uid() = created_by
    OR EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_invites.group_id
        AND gm.user_id = auth.uid()
        AND gm.role IN ('admin', 'owner')
    )
  );

CREATE POLICY "group_invites_insert_admin" ON public.group_invites
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_invites.group_id
        AND gm.user_id = auth.uid()
        AND gm.role IN ('admin', 'owner')
    )
  );

CREATE POLICY "group_invites_delete_admin" ON public.group_invites
  FOR DELETE USING (
    auth.uid() = created_by
    OR EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_invites.group_id
        AND gm.user_id = auth.uid()
        AND gm.role IN ('admin', 'owner')
    )
  );

-- ============================================================
-- group_audit_log - Group admins can read
-- ============================================================
CREATE POLICY "group_audit_log_select_admin" ON public.group_audit_log
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = group_audit_log.group_id
        AND gm.user_id = auth.uid()
        AND gm.role IN ('admin', 'owner')
    )
  );

-- ============================================================
-- trader_daily_snapshots - Public read, service write (cron only)
-- ============================================================
CREATE POLICY "trader_daily_snapshots_select_all" ON public.trader_daily_snapshots
  FOR SELECT USING (true);

-- Remaining tables with no policies are correctly locked to service_role:
-- account_bindings, backup_codes, cron_logs, funding_rates, liquidation_stats,
-- liquidations, login_sessions, market_benchmarks, market_conditions,
-- oauth_states, open_interest, search_analytics, trader_merges,
-- trader_scores, trader_seasons
-- These are all internal/service-only tables.
