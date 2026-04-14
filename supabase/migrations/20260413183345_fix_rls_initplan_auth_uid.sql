-- Migration: fix_rls_initplan_auth_uid
-- Purpose: Wrap bare auth.uid() and auth.jwt() calls in RLS policies
--          with (SELECT auth.uid()) / (SELECT auth.jwt()) to enable
--          PostgreSQL InitPlan optimization (evaluate once per query,
--          not once per row).
-- Ref: https://supabase.com/docs/guides/database/database-linter?lint=0013_auth_rls_initplan
--
-- Total policies fixed: 204

BEGIN;

-- ============================================================
-- Table: account_bindings (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can delete own bindings" ON public.account_bindings;
CREATE POLICY "Users can delete own bindings"
  ON public.account_bindings
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can insert own bindings" ON public.account_bindings;
CREATE POLICY "Users can insert own bindings"
  ON public.account_bindings
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can view own bindings" ON public.account_bindings;
CREATE POLICY "Users can view own bindings"
  ON public.account_bindings
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: admin_logs (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "Admins can create logs" ON public.admin_logs;
CREATE POLICY "Admins can create logs"
  ON public.admin_logs
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = (SELECT auth.uid())) AND (user_profiles.role = 'admin'::text))))
  );

DROP POLICY IF EXISTS "Admins can view logs" ON public.admin_logs;
CREATE POLICY "Admins can view logs"
  ON public.admin_logs
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = (SELECT auth.uid())) AND (user_profiles.role = 'admin'::text))))
  );

-- ============================================================
-- Table: advanced_alert_conditions (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "Users can manage own alert conditions" ON public.advanced_alert_conditions;
CREATE POLICY "Users can manage own alert conditions"
  ON public.advanced_alert_conditions
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (
    (user_id = (SELECT auth.uid()))
  );

-- ============================================================
-- Table: alert_config (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "Admins can insert alert config" ON public.alert_config;
CREATE POLICY "Admins can insert alert config"
  ON public.alert_config
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = (SELECT auth.uid())) AND (user_profiles.role = 'admin'::text))))
  );

DROP POLICY IF EXISTS "Admins can update alert config" ON public.alert_config;
CREATE POLICY "Admins can update alert config"
  ON public.alert_config
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = (SELECT auth.uid())) AND (user_profiles.role = 'admin'::text))))
  );

DROP POLICY IF EXISTS "Admins can view alert config" ON public.alert_config;
CREATE POLICY "Admins can view alert config"
  ON public.alert_config
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = (SELECT auth.uid())) AND (user_profiles.role = 'admin'::text))))
  );

-- ============================================================
-- Table: alert_history (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "Users can view own alert history" ON public.alert_history;
CREATE POLICY "Users can view own alert history"
  ON public.alert_history
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    (user_id = (SELECT auth.uid()))
  );

-- ============================================================
-- Table: authorization_sync_logs (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "Users can view logs for their authorizations" ON public.authorization_sync_logs;
CREATE POLICY "Users can view logs for their authorizations"
  ON public.authorization_sync_logs
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    (EXISTS ( SELECT 1
   FROM trader_authorizations
  WHERE ((trader_authorizations.id = authorization_sync_logs.authorization_id) AND (trader_authorizations.user_id = (SELECT auth.uid())))))
  );

-- ============================================================
-- Table: backup_codes (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can insert own backup codes" ON public.backup_codes;
CREATE POLICY "Users can insert own backup codes"
  ON public.backup_codes
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can update own backup codes" ON public.backup_codes;
CREATE POLICY "Users can update own backup codes"
  ON public.backup_codes
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  )
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can view own backup codes" ON public.backup_codes;
CREATE POLICY "Users can view own backup codes"
  ON public.backup_codes
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: blocked_users (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "blocked_users_delete_own" ON public.blocked_users;
CREATE POLICY "blocked_users_delete_own"
  ON public.blocked_users
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = blocker_id)
  );

DROP POLICY IF EXISTS "blocked_users_insert_own" ON public.blocked_users;
CREATE POLICY "blocked_users_insert_own"
  ON public.blocked_users
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = blocker_id)
  );

DROP POLICY IF EXISTS "blocked_users_select_own" ON public.blocked_users;
CREATE POLICY "blocked_users_select_own"
  ON public.blocked_users
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = blocker_id)
  );

-- ============================================================
-- Table: book_ratings (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "book_ratings_delete_own" ON public.book_ratings;
CREATE POLICY "book_ratings_delete_own"
  ON public.book_ratings
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "book_ratings_insert_own" ON public.book_ratings;
CREATE POLICY "book_ratings_insert_own"
  ON public.book_ratings
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "book_ratings_update_own" ON public.book_ratings;
CREATE POLICY "book_ratings_update_own"
  ON public.book_ratings
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  )
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: bookmark_folders (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can manage own folders" ON public.bookmark_folders;
CREATE POLICY "Users can manage own folders"
  ON public.bookmark_folders
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (
    (user_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "Users can view own and public folders" ON public.bookmark_folders;
CREATE POLICY "Users can view own and public folders"
  ON public.bookmark_folders
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((user_id = (SELECT auth.uid())) OR (is_public = true))
  );

-- ============================================================
-- Table: channel_members (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "Channel admins can manage members" ON public.channel_members;
CREATE POLICY "Channel admins can manage members"
  ON public.channel_members
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (
    (channel_id IN ( SELECT cm.channel_id
   FROM channel_members cm
  WHERE ((cm.user_id = (SELECT auth.uid())) AND (cm.role = ANY (ARRAY['owner'::text, 'admin'::text])))))
  );

DROP POLICY IF EXISTS "Members can view channel members" ON public.channel_members;
CREATE POLICY "Members can view channel members"
  ON public.channel_members
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    (channel_id IN ( SELECT cm.channel_id
   FROM channel_members cm
  WHERE (cm.user_id = (SELECT auth.uid()))))
  );

-- ============================================================
-- Table: channel_message_reads (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "Users can manage own read status" ON public.channel_message_reads;
CREATE POLICY "Users can manage own read status"
  ON public.channel_message_reads
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (
    (user_id = (SELECT auth.uid()))
  );

-- ============================================================
-- Table: channel_messages (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "Members can send messages" ON public.channel_messages;
CREATE POLICY "Members can send messages"
  ON public.channel_messages
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((sender_id = (SELECT auth.uid())) AND (channel_id IN ( SELECT channel_members.channel_id
   FROM channel_members
  WHERE (channel_members.user_id = (SELECT auth.uid())))))
  );

DROP POLICY IF EXISTS "Members can view channel messages" ON public.channel_messages;
CREATE POLICY "Members can view channel messages"
  ON public.channel_messages
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    (channel_id IN ( SELECT channel_members.channel_id
   FROM channel_members
  WHERE (channel_members.user_id = (SELECT auth.uid()))))
  );

-- ============================================================
-- Table: chat_channels (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "Channel owners can update" ON public.chat_channels;
CREATE POLICY "Channel owners can update"
  ON public.chat_channels
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    (id IN ( SELECT channel_members.channel_id
   FROM channel_members
  WHERE ((channel_members.user_id = (SELECT auth.uid())) AND (channel_members.role = ANY (ARRAY['owner'::text, 'admin'::text])))))
  );

DROP POLICY IF EXISTS "Users can create channels" ON public.chat_channels;
CREATE POLICY "Users can create channels"
  ON public.chat_channels
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    (created_by = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "Users can view channels they are members of" ON public.chat_channels;
CREATE POLICY "Users can view channels they are members of"
  ON public.chat_channels
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    (id IN ( SELECT channel_members.channel_id
   FROM channel_members
  WHERE (channel_members.user_id = (SELECT auth.uid()))))
  );

-- ============================================================
-- Table: collection_items (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "collection_items_via_collection" ON public.collection_items;
CREATE POLICY "collection_items_via_collection"
  ON public.collection_items
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (
    (EXISTS ( SELECT 1
   FROM user_collections uc
  WHERE ((uc.id = collection_items.collection_id) AND ((uc.user_id = (SELECT auth.uid())) OR (uc.is_public = true)))))
  );

-- ============================================================
-- Table: comment_likes (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can delete their own comment likes" ON public.comment_likes;
CREATE POLICY "Users can delete their own comment likes"
  ON public.comment_likes
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can insert their own comment likes" ON public.comment_likes;
CREATE POLICY "Users can insert their own comment likes"
  ON public.comment_likes
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: comments (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "Authenticated users can create comments" ON public.comments;
CREATE POLICY "Authenticated users can create comments"
  ON public.comments
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = author_id)
  );

DROP POLICY IF EXISTS "Users can delete their own comments" ON public.comments;
CREATE POLICY "Users can delete their own comments"
  ON public.comments
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = author_id)
  );

DROP POLICY IF EXISTS "Users can update their own comments" ON public.comments;
CREATE POLICY "Users can update their own comments"
  ON public.comments
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    ((SELECT auth.uid()) = author_id)
  )
  WITH CHECK (
    ((SELECT auth.uid()) = author_id)
  );

-- ============================================================
-- Table: content_reports (4 policies)
-- ============================================================

DROP POLICY IF EXISTS "Admins can update reports" ON public.content_reports;
CREATE POLICY "Admins can update reports"
  ON public.content_reports
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = (SELECT auth.uid())) AND (user_profiles.role = 'admin'::text))))
  );

DROP POLICY IF EXISTS "Admins can view all reports" ON public.content_reports;
CREATE POLICY "Admins can view all reports"
  ON public.content_reports
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = (SELECT auth.uid())) AND (user_profiles.role = 'admin'::text))))
  );

DROP POLICY IF EXISTS "Users can create reports" ON public.content_reports;
CREATE POLICY "Users can create reports"
  ON public.content_reports
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = reporter_id)
  );

DROP POLICY IF EXISTS "Users can view own reports" ON public.content_reports;
CREATE POLICY "Users can view own reports"
  ON public.content_reports
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = reporter_id)
  );

-- ============================================================
-- Table: conversation_members (4 policies)
-- ============================================================

DROP POLICY IF EXISTS "conversation_members_delete_policy" ON public.conversation_members;
CREATE POLICY "conversation_members_delete_policy"
  ON public.conversation_members
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "conversation_members_insert_policy" ON public.conversation_members;
CREATE POLICY "conversation_members_insert_policy"
  ON public.conversation_members
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "conversation_members_select_policy" ON public.conversation_members;
CREATE POLICY "conversation_members_select_policy"
  ON public.conversation_members
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "conversation_members_update_policy" ON public.conversation_members;
CREATE POLICY "conversation_members_update_policy"
  ON public.conversation_members
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  )
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: conversations (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can create conversations" ON public.conversations;
CREATE POLICY "Users can create conversations"
  ON public.conversations
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    (((SELECT auth.uid()) = user1_id) OR ((SELECT auth.uid()) = user2_id))
  );

DROP POLICY IF EXISTS "Users can update their own conversations" ON public.conversations;
CREATE POLICY "Users can update their own conversations"
  ON public.conversations
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    (((SELECT auth.uid()) = user1_id) OR ((SELECT auth.uid()) = user2_id))
  );

DROP POLICY IF EXISTS "Users can view their own conversations" ON public.conversations;
CREATE POLICY "Users can view their own conversations"
  ON public.conversations
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    (((SELECT auth.uid()) = user1_id) OR ((SELECT auth.uid()) = user2_id))
  );

-- ============================================================
-- Table: copy_trade_configs (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "用户只能访问自己的跟单配置" ON public.copy_trade_configs;
CREATE POLICY "用户只能访问自己的跟单配置"
  ON public.copy_trade_configs
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: copy_trade_logs (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "用户只能访问自己的跟单日志" ON public.copy_trade_logs;
CREATE POLICY "用户只能访问自己的跟单日志"
  ON public.copy_trade_logs
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (
    (config_id IN ( SELECT copy_trade_configs.id
   FROM copy_trade_configs
  WHERE (copy_trade_configs.user_id = (SELECT auth.uid()))))
  );

-- ============================================================
-- Table: direct_messages (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can send messages" ON public.direct_messages;
CREATE POLICY "Users can send messages"
  ON public.direct_messages
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = sender_id)
  );

DROP POLICY IF EXISTS "Users can update their own received messages" ON public.direct_messages;
CREATE POLICY "Users can update their own received messages"
  ON public.direct_messages
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    ((SELECT auth.uid()) = receiver_id)
  );

DROP POLICY IF EXISTS "Users can view their own messages" ON public.direct_messages;
CREATE POLICY "Users can view their own messages"
  ON public.direct_messages
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    (((SELECT auth.uid()) = sender_id) OR ((SELECT auth.uid()) = receiver_id))
  );

-- ============================================================
-- Table: directory_ratings (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "Auth users can insert ratings" ON public.directory_ratings;
CREATE POLICY "Auth users can insert ratings"
  ON public.directory_ratings
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can delete own ratings" ON public.directory_ratings;
CREATE POLICY "Users can delete own ratings"
  ON public.directory_ratings
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can update own ratings" ON public.directory_ratings;
CREATE POLICY "Users can update own ratings"
  ON public.directory_ratings
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: exp_transactions (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "users_read_own_exp" ON public.exp_transactions;
CREATE POLICY "users_read_own_exp"
  ON public.exp_transactions
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: feedback (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "Authenticated users can insert feedback" ON public.feedback;
CREATE POLICY "Authenticated users can insert feedback"
  ON public.feedback
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    ((SELECT auth.uid()) IS NOT NULL)
  );

-- ============================================================
-- Table: flash_news (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "Only admins can manage flash news" ON public.flash_news;
CREATE POLICY "Only admins can manage flash news"
  ON public.flash_news
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (
    (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = (SELECT auth.uid())) AND (user_profiles.role = 'admin'::text))))
  );

-- ============================================================
-- Table: follows (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "follows_delete_self" ON public.follows;
CREATE POLICY "follows_delete_self"
  ON public.follows
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "follows_write_self" ON public.follows;
CREATE POLICY "follows_write_self"
  ON public.follows
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: gifts (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "gifts_insert_auth" ON public.gifts;
CREATE POLICY "gifts_insert_auth"
  ON public.gifts
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (from_user_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "gifts_read_self_or_admin" ON public.gifts;
CREATE POLICY "gifts_read_self_or_admin"
  ON public.gifts
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    ((from_user_id = (SELECT auth.uid())) OR is_group_admin(group_id, (SELECT auth.uid())))
  );

-- ============================================================
-- Table: group_applications (4 policies)
-- ============================================================

DROP POLICY IF EXISTS "Admins can update applications" ON public.group_applications;
CREATE POLICY "Admins can update applications"
  ON public.group_applications
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = (SELECT auth.uid())) AND (user_profiles.role = 'admin'::text))))
  );

DROP POLICY IF EXISTS "Admins can view all applications" ON public.group_applications;
CREATE POLICY "Admins can view all applications"
  ON public.group_applications
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = (SELECT auth.uid())) AND (user_profiles.role = 'admin'::text))))
  );

DROP POLICY IF EXISTS "Users can create applications" ON public.group_applications;
CREATE POLICY "Users can create applications"
  ON public.group_applications
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = applicant_id)
  );

DROP POLICY IF EXISTS "Users can view their own applications" ON public.group_applications;
CREATE POLICY "Users can view their own applications"
  ON public.group_applications
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = applicant_id)
  );

-- ============================================================
-- Table: group_audit_log (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "group_audit_log_select_admin" ON public.group_audit_log;
CREATE POLICY "group_audit_log_select_admin"
  ON public.group_audit_log
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    (EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = group_audit_log.group_id) AND (gm.user_id = (SELECT auth.uid())) AND (gm.role = ANY (ARRAY['admin'::member_role, 'owner'::member_role])))))
  );

-- ============================================================
-- Table: group_bans (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "group_bans_delete_admin" ON public.group_bans;
CREATE POLICY "group_bans_delete_admin"
  ON public.group_bans
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    (EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = group_bans.group_id) AND (gm.user_id = (SELECT auth.uid())) AND (gm.role = ANY (ARRAY['admin'::member_role, 'owner'::member_role])))))
  );

DROP POLICY IF EXISTS "group_bans_insert_admin" ON public.group_bans;
CREATE POLICY "group_bans_insert_admin"
  ON public.group_bans
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    (EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = group_bans.group_id) AND (gm.user_id = (SELECT auth.uid())) AND (gm.role = ANY (ARRAY['admin'::member_role, 'owner'::member_role])))))
  );

DROP POLICY IF EXISTS "group_bans_select_member" ON public.group_bans;
CREATE POLICY "group_bans_select_member"
  ON public.group_bans
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    (((SELECT auth.uid()) = user_id) OR (EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = group_bans.group_id) AND (gm.user_id = (SELECT auth.uid())) AND (gm.role = ANY (ARRAY['admin'::member_role, 'owner'::member_role]))))))
  );

-- ============================================================
-- Table: group_edit_applications (4 policies)
-- ============================================================

DROP POLICY IF EXISTS "Admins can update edit applications" ON public.group_edit_applications;
CREATE POLICY "Admins can update edit applications"
  ON public.group_edit_applications
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = (SELECT auth.uid())) AND (user_profiles.role = 'admin'::text))))
  );

DROP POLICY IF EXISTS "Admins can view all edit applications" ON public.group_edit_applications;
CREATE POLICY "Admins can view all edit applications"
  ON public.group_edit_applications
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = (SELECT auth.uid())) AND (user_profiles.role = 'admin'::text))))
  );

DROP POLICY IF EXISTS "Users can create edit applications" ON public.group_edit_applications;
CREATE POLICY "Users can create edit applications"
  ON public.group_edit_applications
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = applicant_id)
  );

DROP POLICY IF EXISTS "Users can view their own edit applications" ON public.group_edit_applications;
CREATE POLICY "Users can view their own edit applications"
  ON public.group_edit_applications
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = applicant_id)
  );

-- ============================================================
-- Table: group_invites (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "group_invites_delete_admin" ON public.group_invites;
CREATE POLICY "group_invites_delete_admin"
  ON public.group_invites
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    (((SELECT auth.uid()) = created_by) OR (EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = group_invites.group_id) AND (gm.user_id = (SELECT auth.uid())) AND (gm.role = ANY (ARRAY['admin'::member_role, 'owner'::member_role]))))))
  );

DROP POLICY IF EXISTS "group_invites_insert_admin" ON public.group_invites;
CREATE POLICY "group_invites_insert_admin"
  ON public.group_invites
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    (EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = group_invites.group_id) AND (gm.user_id = (SELECT auth.uid())) AND (gm.role = ANY (ARRAY['admin'::member_role, 'owner'::member_role])))))
  );

DROP POLICY IF EXISTS "group_invites_select_admin" ON public.group_invites;
CREATE POLICY "group_invites_select_admin"
  ON public.group_invites
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    (((SELECT auth.uid()) = created_by) OR (EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = group_invites.group_id) AND (gm.user_id = (SELECT auth.uid())) AND (gm.role = ANY (ARRAY['admin'::member_role, 'owner'::member_role]))))))
  );

-- ============================================================
-- Table: group_join_requests (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "joinreq_insert_auth" ON public.group_join_requests;
CREATE POLICY "joinreq_insert_auth"
  ON public.group_join_requests
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    ((user_id = (SELECT auth.uid())) AND (EXISTS ( SELECT 1
   FROM groups g
  WHERE ((g.id = group_join_requests.group_id) AND (g.visibility = 'apply'::group_visibility)))))
  );

DROP POLICY IF EXISTS "joinreq_read_owner_or_admin" ON public.group_join_requests;
CREATE POLICY "joinreq_read_owner_or_admin"
  ON public.group_join_requests
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    ((user_id = (SELECT auth.uid())) OR is_group_admin(group_id, (SELECT auth.uid())))
  );

DROP POLICY IF EXISTS "joinreq_update_admin" ON public.group_join_requests;
CREATE POLICY "joinreq_update_admin"
  ON public.group_join_requests
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (
    is_group_admin(group_id, (SELECT auth.uid()))
  )
  WITH CHECK (
    is_group_admin(group_id, (SELECT auth.uid()))
  );

-- ============================================================
-- Table: group_members (4 policies)
-- ============================================================

DROP POLICY IF EXISTS "Group admins can update members" ON public.group_members;
CREATE POLICY "Group admins can update members"
  ON public.group_members
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    (EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = group_members.group_id) AND (gm.user_id = (SELECT auth.uid())) AND (gm.role = ANY (ARRAY['admin'::member_role, 'owner'::member_role])))))
  )
  WITH CHECK (
    (EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = group_members.group_id) AND (gm.user_id = (SELECT auth.uid())) AND (gm.role = ANY (ARRAY['admin'::member_role, 'owner'::member_role])))))
  );

DROP POLICY IF EXISTS "Users can join groups" ON public.group_members;
CREATE POLICY "Users can join groups"
  ON public.group_members
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can leave groups" ON public.group_members;
CREATE POLICY "Users can leave groups"
  ON public.group_members
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "members_join_open" ON public.group_members;
CREATE POLICY "members_join_open"
  ON public.group_members
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    ((user_id = (SELECT auth.uid())) AND (EXISTS ( SELECT 1
   FROM groups g
  WHERE ((g.id = group_members.group_id) AND (g.visibility = 'open'::group_visibility)))))
  );

-- ============================================================
-- Table: group_rules (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "rules_write_admin" ON public.group_rules;
CREATE POLICY "rules_write_admin"
  ON public.group_rules
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (
    is_group_admin(group_id, (SELECT auth.uid()))
  )
  WITH CHECK (
    is_group_admin(group_id, (SELECT auth.uid()))
  );

-- ============================================================
-- Table: group_subscriptions (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "Group owners can view group subscriptions" ON public.group_subscriptions;
CREATE POLICY "Group owners can view group subscriptions"
  ON public.group_subscriptions
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    (EXISTS ( SELECT 1
   FROM groups g
  WHERE ((g.id = group_subscriptions.group_id) AND (g.created_by = (SELECT auth.uid())))))
  );

DROP POLICY IF EXISTS "Users can create their own subscriptions" ON public.group_subscriptions;
CREATE POLICY "Users can create their own subscriptions"
  ON public.group_subscriptions
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can view their own subscriptions" ON public.group_subscriptions;
CREATE POLICY "Users can view their own subscriptions"
  ON public.group_subscriptions
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: groups (4 policies)
-- ============================================================

DROP POLICY IF EXISTS "Group admins can update their groups" ON public.groups;
CREATE POLICY "Group admins can update their groups"
  ON public.groups
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    (EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = groups.id) AND (gm.user_id = (SELECT auth.uid())) AND (gm.role = ANY (ARRAY['admin'::member_role, 'owner'::member_role])))))
  )
  WITH CHECK (
    (EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = groups.id) AND (gm.user_id = (SELECT auth.uid())) AND (gm.role = ANY (ARRAY['admin'::member_role, 'owner'::member_role])))))
  );

DROP POLICY IF EXISTS "Group creators can delete their groups" ON public.groups;
CREATE POLICY "Group creators can delete their groups"
  ON public.groups
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = created_by)
  );

DROP POLICY IF EXISTS "Group creators can update their groups" ON public.groups;
CREATE POLICY "Group creators can update their groups"
  ON public.groups
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    ((SELECT auth.uid()) = created_by)
  )
  WITH CHECK (
    ((SELECT auth.uid()) = created_by)
  );

DROP POLICY IF EXISTS "groups_insert_auth" ON public.groups;
CREATE POLICY "groups_insert_auth"
  ON public.groups
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    ((SELECT auth.uid()) = created_by)
  );

-- ============================================================
-- Table: kol_applications (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "users_insert_own_kol_app" ON public.kol_applications;
CREATE POLICY "users_insert_own_kol_app"
  ON public.kol_applications
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "users_read_own_kol_app" ON public.kol_applications;
CREATE POLICY "users_read_own_kol_app"
  ON public.kol_applications
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: ledger_entries (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "ledger_read_self" ON public.ledger_entries;
CREATE POLICY "ledger_read_self"
  ON public.ledger_entries
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    (user_id = (SELECT auth.uid()))
  );

-- ============================================================
-- Table: login_sessions (4 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can delete own sessions" ON public.login_sessions;
CREATE POLICY "Users can delete own sessions"
  ON public.login_sessions
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can insert own sessions" ON public.login_sessions;
CREATE POLICY "Users can insert own sessions"
  ON public.login_sessions
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can update own sessions" ON public.login_sessions;
CREATE POLICY "Users can update own sessions"
  ON public.login_sessions
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  )
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can view own sessions" ON public.login_sessions;
CREATE POLICY "Users can view own sessions"
  ON public.login_sessions
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: manipulation_alert_history (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "Admins can view alert history" ON public.manipulation_alert_history;
CREATE POLICY "Admins can view alert history"
  ON public.manipulation_alert_history
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    (((SELECT auth.jwt()) ->> 'role'::text) = 'admin'::text)
  );

-- ============================================================
-- Table: manipulation_alerts (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "Admins can manage alerts" ON public.manipulation_alerts;
CREATE POLICY "Admins can manage alerts"
  ON public.manipulation_alerts
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (
    (((SELECT auth.jwt()) ->> 'role'::text) = 'admin'::text)
  );

DROP POLICY IF EXISTS "Admins can view all alerts" ON public.manipulation_alerts;
CREATE POLICY "Admins can view all alerts"
  ON public.manipulation_alerts
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    (((SELECT auth.jwt()) ->> 'role'::text) = 'admin'::text)
  );

-- ============================================================
-- Table: notification_history (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "Users can view own notification history" ON public.notification_history;
CREATE POLICY "Users can view own notification history"
  ON public.notification_history
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: notifications (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can delete their own notifications" ON public.notifications;
CREATE POLICY "Users can delete their own notifications"
  ON public.notifications
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can read own notifications" ON public.notifications;
CREATE POLICY "Users can read own notifications"
  ON public.notifications
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can update own notifications" ON public.notifications;
CREATE POLICY "Users can update own notifications"
  ON public.notifications
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: oauth_states (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can delete own oauth states" ON public.oauth_states;
CREATE POLICY "Users can delete own oauth states"
  ON public.oauth_states
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can insert own oauth states" ON public.oauth_states;
CREATE POLICY "Users can insert own oauth states"
  ON public.oauth_states
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can view own oauth states" ON public.oauth_states;
CREATE POLICY "Users can view own oauth states"
  ON public.oauth_states
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: pipeline_logs (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "Admins can view pipeline_logs" ON public.pipeline_logs;
CREATE POLICY "Admins can view pipeline_logs"
  ON public.pipeline_logs
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = (SELECT auth.uid())) AND (user_profiles.role = 'admin'::text))))
  );

DROP POLICY IF EXISTS "Service role can manage pipeline_logs" ON public.pipeline_logs;
CREATE POLICY "Service role can manage pipeline_logs"
  ON public.pipeline_logs
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (
    (((SELECT auth.jwt()) ->> 'role'::text) = 'service_role'::text)
  );

-- ============================================================
-- Table: poll_votes (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can delete own vote" ON public.poll_votes;
CREATE POLICY "Users can delete own vote"
  ON public.poll_votes
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can vote" ON public.poll_votes;
CREATE POLICY "Users can vote"
  ON public.poll_votes
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: polls (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "Authenticated users can create polls" ON public.polls;
CREATE POLICY "Authenticated users can create polls"
  ON public.polls
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (EXISTS ( SELECT 1
   FROM posts p
  WHERE ((p.id = polls.post_id) AND (p.author_id = (SELECT auth.uid())))))
  );

-- ============================================================
-- Table: post_bookmarks (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "post_bookmarks_delete_own" ON public.post_bookmarks;
CREATE POLICY "post_bookmarks_delete_own"
  ON public.post_bookmarks
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "post_bookmarks_insert_own" ON public.post_bookmarks;
CREATE POLICY "post_bookmarks_insert_own"
  ON public.post_bookmarks
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "post_bookmarks_select_own" ON public.post_bookmarks;
CREATE POLICY "post_bookmarks_select_own"
  ON public.post_bookmarks
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: post_comments (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "comments_insert_member" ON public.post_comments;
CREATE POLICY "comments_insert_member"
  ON public.post_comments
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    ((author_id = (SELECT auth.uid())) AND ((group_id IS NULL) OR (EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = post_comments.group_id) AND (gm.user_id = (SELECT auth.uid())))))))
  );

-- ============================================================
-- Table: post_likes (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can delete their own likes" ON public.post_likes;
CREATE POLICY "Users can delete their own likes"
  ON public.post_likes
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can insert their own likes" ON public.post_likes;
CREATE POLICY "Users can insert their own likes"
  ON public.post_likes
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can update their own likes" ON public.post_likes;
CREATE POLICY "Users can update their own likes"
  ON public.post_likes
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: post_reactions (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "post_reactions_delete_own" ON public.post_reactions;
CREATE POLICY "post_reactions_delete_own"
  ON public.post_reactions
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "post_reactions_insert_own" ON public.post_reactions;
CREATE POLICY "post_reactions_insert_own"
  ON public.post_reactions
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: post_votes (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can delete their own votes" ON public.post_votes;
CREATE POLICY "Users can delete their own votes"
  ON public.post_votes
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can insert their own votes" ON public.post_votes;
CREATE POLICY "Users can insert their own votes"
  ON public.post_votes
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can update their own votes" ON public.post_votes;
CREATE POLICY "Users can update their own votes"
  ON public.post_votes
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: posts (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "posts_delete_self" ON public.posts;
CREATE POLICY "posts_delete_self"
  ON public.posts
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = author_id)
  );

DROP POLICY IF EXISTS "posts_insert_member" ON public.posts;
CREATE POLICY "posts_insert_member"
  ON public.posts
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    ((author_id = (SELECT auth.uid())) AND (EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = gm.group_id) AND (gm.user_id = (SELECT auth.uid()))))))
  );

DROP POLICY IF EXISTS "posts_update_author_or_admin" ON public.posts;
CREATE POLICY "posts_update_author_or_admin"
  ON public.posts
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (
    ((author_id = (SELECT auth.uid())) OR is_group_admin(group_id, (SELECT auth.uid())))
  )
  WITH CHECK (
    ((author_id = (SELECT auth.uid())) OR is_group_admin(group_id, (SELECT auth.uid())))
  );

-- ============================================================
-- Table: push_subscriptions (4 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can create own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Users can create own push subscriptions"
  ON public.push_subscriptions
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can delete own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Users can delete own push subscriptions"
  ON public.push_subscriptions
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can update own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Users can update own push subscriptions"
  ON public.push_subscriptions
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can view own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Users can view own push subscriptions"
  ON public.push_subscriptions
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: ranking_snapshots (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can delete own snapshots" ON public.ranking_snapshots;
CREATE POLICY "Users can delete own snapshots"
  ON public.ranking_snapshots
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    (created_by = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "Users can update own snapshots" ON public.ranking_snapshots;
CREATE POLICY "Users can update own snapshots"
  ON public.ranking_snapshots
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    (created_by = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "Users can view own snapshots" ON public.ranking_snapshots;
CREATE POLICY "Users can view own snapshots"
  ON public.ranking_snapshots
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    (created_by = (SELECT auth.uid()))
  );

-- ============================================================
-- Table: reading_progress (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can read own progress" ON public.reading_progress;
CREATE POLICY "Users can read own progress"
  ON public.reading_progress
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can upsert own progress" ON public.reading_progress;
CREATE POLICY "Users can upsert own progress"
  ON public.reading_progress
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: reading_statistics (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can read own stats" ON public.reading_statistics;
CREATE POLICY "Users can read own stats"
  ON public.reading_statistics
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can upsert own stats" ON public.reading_statistics;
CREATE POLICY "Users can upsert own stats"
  ON public.reading_statistics
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: reports (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "reports_insert_auth" ON public.reports;
CREATE POLICY "reports_insert_auth"
  ON public.reports
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (reporter_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "reports_read_admin" ON public.reports;
CREATE POLICY "reports_read_admin"
  ON public.reports
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    is_group_admin(group_id, (SELECT auth.uid()))
  );

-- ============================================================
-- Table: reposts (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "reposts_delete_own" ON public.reposts;
CREATE POLICY "reposts_delete_own"
  ON public.reposts
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "reposts_insert_own" ON public.reposts;
CREATE POLICY "reposts_insert_own"
  ON public.reposts
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: reviews (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can create own reviews" ON public.reviews;
CREATE POLICY "Users can create own reviews"
  ON public.reviews
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can delete own reviews" ON public.reviews;
CREATE POLICY "Users can delete own reviews"
  ON public.reviews
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can update own reviews" ON public.reviews;
CREATE POLICY "Users can update own reviews"
  ON public.reviews
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: search_analytics (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can insert own searches" ON public.search_analytics;
CREATE POLICY "Users can insert own searches"
  ON public.search_analytics
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can view own searches" ON public.search_analytics;
CREATE POLICY "Users can view own searches"
  ON public.search_analytics
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: snapshot_traders (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "Snapshot traders viewable with snapshot" ON public.snapshot_traders;
CREATE POLICY "Snapshot traders viewable with snapshot"
  ON public.snapshot_traders
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    (EXISTS ( SELECT 1
   FROM ranking_snapshots rs
  WHERE ((rs.id = snapshot_traders.snapshot_id) AND ((rs.is_public = true) OR (rs.created_by = (SELECT auth.uid()))) AND ((rs.expires_at IS NULL) OR (rs.expires_at > now())))))
  );

-- ============================================================
-- Table: subscriptions (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "Service role can manage subscriptions" ON public.subscriptions;
CREATE POLICY "Service role can manage subscriptions"
  ON public.subscriptions
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (
    (((SELECT auth.jwt()) ->> 'role'::text) = 'service_role'::text)
  );

DROP POLICY IF EXISTS "Users can view own subscription" ON public.subscriptions;
CREATE POLICY "Users can view own subscription"
  ON public.subscriptions
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: trader_alerts (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "Users can manage own alerts" ON public.trader_alerts;
CREATE POLICY "Users can manage own alerts"
  ON public.trader_alerts
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: trader_anomalies (4 policies)
-- ============================================================

DROP POLICY IF EXISTS "Admins can insert anomalies" ON public.trader_anomalies;
CREATE POLICY "Admins can insert anomalies"
  ON public.trader_anomalies
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = (SELECT auth.uid())) AND (user_profiles.role = 'admin'::text))))
  );

DROP POLICY IF EXISTS "Admins can update anomalies" ON public.trader_anomalies;
CREATE POLICY "Admins can update anomalies"
  ON public.trader_anomalies
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = (SELECT auth.uid())) AND (user_profiles.role = 'admin'::text))))
  );

DROP POLICY IF EXISTS "Admins can view all anomalies" ON public.trader_anomalies;
CREATE POLICY "Admins can view all anomalies"
  ON public.trader_anomalies
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = (SELECT auth.uid())) AND (user_profiles.role = 'admin'::text))))
  );

DROP POLICY IF EXISTS "Service role can manage anomalies" ON public.trader_anomalies;
CREATE POLICY "Service role can manage anomalies"
  ON public.trader_anomalies
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (
    (((SELECT auth.jwt()) ->> 'role'::text) = 'service_role'::text)
  );

-- ============================================================
-- Table: trader_authorizations (4 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can create their own authorizations" ON public.trader_authorizations;
CREATE POLICY "Users can create their own authorizations"
  ON public.trader_authorizations
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can delete their own authorizations" ON public.trader_authorizations;
CREATE POLICY "Users can delete their own authorizations"
  ON public.trader_authorizations
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can update their own authorizations" ON public.trader_authorizations;
CREATE POLICY "Users can update their own authorizations"
  ON public.trader_authorizations
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can view their own authorizations" ON public.trader_authorizations;
CREATE POLICY "Users can view their own authorizations"
  ON public.trader_authorizations
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: trader_claims (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can delete their own pending claims" ON public.trader_claims;
CREATE POLICY "Users can delete their own pending claims"
  ON public.trader_claims
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    (((SELECT auth.uid()) = user_id) AND (status = 'pending'::text))
  );

DROP POLICY IF EXISTS "Users can insert their own claims" ON public.trader_claims;
CREATE POLICY "Users can insert their own claims"
  ON public.trader_claims
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can view their own claims" ON public.trader_claims;
CREATE POLICY "Users can view their own claims"
  ON public.trader_claims
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: trader_flags (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "Admins can manage flags" ON public.trader_flags;
CREATE POLICY "Admins can manage flags"
  ON public.trader_flags
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (
    (((SELECT auth.jwt()) ->> 'role'::text) = 'admin'::text)
  );

DROP POLICY IF EXISTS "Admins can view all flags" ON public.trader_flags;
CREATE POLICY "Admins can view all flags"
  ON public.trader_flags
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    (((SELECT auth.jwt()) ->> 'role'::text) = 'admin'::text)
  );

-- ============================================================
-- Table: trader_follows (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can follow traders" ON public.trader_follows;
CREATE POLICY "Users can follow traders"
  ON public.trader_follows
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can unfollow traders" ON public.trader_follows;
CREATE POLICY "Users can unfollow traders"
  ON public.trader_follows
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: trader_links (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can delete own links" ON public.trader_links;
CREATE POLICY "Users can delete own links"
  ON public.trader_links
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can insert own links" ON public.trader_links;
CREATE POLICY "Users can insert own links"
  ON public.trader_links
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can view own links" ON public.trader_links;
CREATE POLICY "Users can view own links"
  ON public.trader_links
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: user_activities (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "user_activities_insert_own" ON public.user_activities;
CREATE POLICY "user_activities_insert_own"
  ON public.user_activities
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: user_activity (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "user_activity_insert_own" ON public.user_activity;
CREATE POLICY "user_activity_insert_own"
  ON public.user_activity
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "user_activity_select_own" ON public.user_activity;
CREATE POLICY "user_activity_select_own"
  ON public.user_activity
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: user_collections (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "public_collections_viewable" ON public.user_collections;
CREATE POLICY "public_collections_viewable"
  ON public.user_collections
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((is_public = true) OR (user_id = (SELECT auth.uid())))
  );

DROP POLICY IF EXISTS "users_manage_own_collections" ON public.user_collections;
CREATE POLICY "users_manage_own_collections"
  ON public.user_collections
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (
    (user_id = (SELECT auth.uid()))
  );

-- ============================================================
-- Table: user_exchange_connections (5 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can delete their own connections" ON public.user_exchange_connections;
CREATE POLICY "Users can delete their own connections"
  ON public.user_exchange_connections
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can insert their own connections" ON public.user_exchange_connections;
CREATE POLICY "Users can insert their own connections"
  ON public.user_exchange_connections
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can manage their own connections" ON public.user_exchange_connections;
CREATE POLICY "Users can manage their own connections"
  ON public.user_exchange_connections
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  )
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can update their own connections" ON public.user_exchange_connections;
CREATE POLICY "Users can update their own connections"
  ON public.user_exchange_connections
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can view their own connections" ON public.user_exchange_connections;
CREATE POLICY "Users can view their own connections"
  ON public.user_exchange_connections
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: user_follows (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can follow others" ON public.user_follows;
CREATE POLICY "Users can follow others"
  ON public.user_follows
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = follower_id)
  );

DROP POLICY IF EXISTS "Users can unfollow others" ON public.user_follows;
CREATE POLICY "Users can unfollow others"
  ON public.user_follows
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = follower_id)
  );

-- ============================================================
-- Table: user_interactions (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can create own interactions" ON public.user_interactions;
CREATE POLICY "Users can create own interactions"
  ON public.user_interactions
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can read own interactions" ON public.user_interactions;
CREATE POLICY "Users can read own interactions"
  ON public.user_interactions
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: user_linked_traders (4 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can delete own linked traders" ON public.user_linked_traders;
CREATE POLICY "Users can delete own linked traders"
  ON public.user_linked_traders
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can insert own linked traders" ON public.user_linked_traders;
CREATE POLICY "Users can insert own linked traders"
  ON public.user_linked_traders
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can update own linked traders" ON public.user_linked_traders;
CREATE POLICY "Users can update own linked traders"
  ON public.user_linked_traders
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can view own linked traders" ON public.user_linked_traders;
CREATE POLICY "Users can view own linked traders"
  ON public.user_linked_traders
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: user_portfolio_snapshots (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "Users can view own snapshots" ON public.user_portfolio_snapshots;
CREATE POLICY "Users can view own snapshots"
  ON public.user_portfolio_snapshots
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (
    (portfolio_id IN ( SELECT user_portfolios.id
   FROM user_portfolios
  WHERE (user_portfolios.user_id = (SELECT auth.uid()))))
  )
  WITH CHECK (
    (portfolio_id IN ( SELECT user_portfolios.id
   FROM user_portfolios
  WHERE (user_portfolios.user_id = (SELECT auth.uid()))))
  );

-- ============================================================
-- Table: user_portfolios (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "Users can manage own portfolios" ON public.user_portfolios;
CREATE POLICY "Users can manage own portfolios"
  ON public.user_portfolios
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  )
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: user_positions (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "Users can view own positions" ON public.user_positions;
CREATE POLICY "Users can view own positions"
  ON public.user_positions
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (
    (portfolio_id IN ( SELECT user_portfolios.id
   FROM user_portfolios
  WHERE (user_portfolios.user_id = (SELECT auth.uid()))))
  )
  WITH CHECK (
    (portfolio_id IN ( SELECT user_portfolios.id
   FROM user_portfolios
  WHERE (user_portfolios.user_id = (SELECT auth.uid()))))
  );

-- ============================================================
-- Table: user_preferences (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can insert own preferences" ON public.user_preferences;
CREATE POLICY "Users can insert own preferences"
  ON public.user_preferences
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can read own preferences" ON public.user_preferences;
CREATE POLICY "Users can read own preferences"
  ON public.user_preferences
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "Users can update own preferences" ON public.user_preferences;
CREATE POLICY "Users can update own preferences"
  ON public.user_preferences
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  )
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: user_profiles (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can delete their own profile" ON public.user_profiles;
CREATE POLICY "Users can delete their own profile"
  ON public.user_profiles
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (
    ((SELECT auth.uid()) = id)
  );

DROP POLICY IF EXISTS "Users can insert their own profile" ON public.user_profiles;
CREATE POLICY "Users can insert their own profile"
  ON public.user_profiles
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = id)
  );

DROP POLICY IF EXISTS "Users can update own profile (restricted columns)" ON public.user_profiles;
CREATE POLICY "Users can update own profile (restricted columns)"
  ON public.user_profiles
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    ((SELECT auth.uid()) = id)
  )
  WITH CHECK (
    (((SELECT auth.uid()) = id) AND (NOT (role IS DISTINCT FROM ( SELECT up.role
   FROM user_profiles up
  WHERE (up.id = (SELECT auth.uid()))))) AND (NOT (subscription_tier IS DISTINCT FROM ( SELECT up.subscription_tier
   FROM user_profiles up
  WHERE (up.id = (SELECT auth.uid()))))))
  );

-- ============================================================
-- Table: user_streaks (2 policies)
-- ============================================================

DROP POLICY IF EXISTS "user_streaks_insert_own" ON public.user_streaks;
CREATE POLICY "user_streaks_insert_own"
  ON public.user_streaks
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "user_streaks_update_own" ON public.user_streaks;
CREATE POLICY "user_streaks_update_own"
  ON public.user_streaks
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

-- ============================================================
-- Table: users (3 policies)
-- ============================================================

DROP POLICY IF EXISTS "Users can insert own profile" ON public.users;
CREATE POLICY "Users can insert own profile"
  ON public.users
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    ((SELECT auth.uid()) = id)
  );

DROP POLICY IF EXISTS "Users can read own profile" ON public.users;
CREATE POLICY "Users can read own profile"
  ON public.users
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = id)
  );

DROP POLICY IF EXISTS "Users can update own profile" ON public.users;
CREATE POLICY "Users can update own profile"
  ON public.users
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    ((SELECT auth.uid()) = id)
  );

-- ============================================================
-- Table: verified_traders (1 policy)
-- ============================================================

DROP POLICY IF EXISTS "Users can update their own verified profile" ON public.verified_traders;
CREATE POLICY "Users can update their own verified profile"
  ON public.verified_traders
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (
    ((SELECT auth.uid()) = user_id)
  );

COMMIT;