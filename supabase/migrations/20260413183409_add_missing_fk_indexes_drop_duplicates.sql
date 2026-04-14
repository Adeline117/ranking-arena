-- Migration: 20260413183409_add_missing_fk_indexes_drop_duplicates.sql
-- Created: 2026-04-14T01:34:09Z
-- Description: Add 44 missing foreign key indexes on public schema tables.
--
-- Root cause: Supabase advisors found 46 FK columns with no covering index,
-- causing full table scans on JOINs and CASCADE deletes. We skip auth/storage
-- schema tables (2 of 46), leaving 44 indexes to add.
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
-- Supabase migrations run each file outside a transaction when they detect
-- CONCURRENTLY, so this file must NOT contain BEGIN/COMMIT.

-- alert_config
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_alert_config_updated_by ON public.alert_config(updated_by);

-- alert_history
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_alert_history_condition_id ON public.alert_history(condition_id);

-- chat_channels
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_channels_conversation_id ON public.chat_channels(conversation_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_channels_created_by ON public.chat_channels(created_by);

-- content_reports
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_content_reports_resolved_by ON public.content_reports(resolved_by);

-- feedback
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_feedback_user_id ON public.feedback(user_id);

-- funding_hubs
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_funding_hubs_cluster_id ON public.funding_hubs(cluster_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_funding_hubs_wallet_id ON public.funding_hubs(wallet_id);

-- gifts
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gifts_group_id ON public.gifts(group_id);

-- group_applications
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_group_applications_applicant_id ON public.group_applications(applicant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_group_applications_reviewed_by ON public.group_applications(reviewed_by);

-- group_bans
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_group_bans_banned_by ON public.group_bans(banned_by);

-- group_edit_applications
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_group_edit_applications_applicant_id ON public.group_edit_applications(applicant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_group_edit_applications_group_id ON public.group_edit_applications(group_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_group_edit_applications_reviewed_by ON public.group_edit_applications(reviewed_by);

-- group_invites
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_group_invites_created_by ON public.group_invites(created_by);

-- group_members
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_group_members_muted_by ON public.group_members(muted_by);

-- group_rules
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_group_rules_group_id ON public.group_rules(group_id);

-- interactions
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_interactions_project_id ON public.interactions(project_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_interactions_wallet_id ON public.interactions(wallet_id);

-- kol_applications
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_kol_applications_user_id ON public.kol_applications(user_id);

-- ledger_entries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_entries_gift_id ON public.ledger_entries(gift_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_entries_group_id ON public.ledger_entries(group_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ledger_entries_post_id ON public.ledger_entries(post_id);

-- manipulation_alert_history
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_manipulation_alert_history_performed_by ON public.manipulation_alert_history(performed_by);

-- manipulation_alerts
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_manipulation_alerts_resolved_by ON public.manipulation_alerts(resolved_by);

-- notifications
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_actor_id ON public.notifications(actor_id);

-- post_comments
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_comments_group_id ON public.post_comments(group_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_comments_parent_id ON public.post_comments(parent_id);

-- search_analytics
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_search_analytics_user_id ON public.search_analytics(user_id);

-- tasks
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_project_id ON public.tasks(project_id);

-- trader_anomalies
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_anomalies_resolved_by ON public.trader_anomalies(resolved_by);

-- trader_attestations
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_attestations_minted_by ON public.trader_attestations(minted_by);

-- trader_claims
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_claims_reviewed_by ON public.trader_claims(reviewed_by);

-- trader_flags
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_flags_flagged_by ON public.trader_flags(flagged_by);

-- trader_merges
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_merges_from_trader_id ON public.trader_merges(from_trader_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_merges_to_trader_id ON public.trader_merges(to_trader_id);

-- trader_snapshots
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_snapshots_authorization_id ON public.trader_snapshots(authorization_id);

-- trader_sources
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_sources_trader_id ON public.trader_sources(trader_id);

-- traders_legacy
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_traders_legacy_merged_to ON public.traders_legacy(merged_to);

-- transactions
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_wallet_id ON public.transactions(wallet_id);

-- transfers
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transfers_to_wallet_id ON public.transfers(to_wallet_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transfers_from_wallet_id ON public.transfers(from_wallet_id);

-- user_profiles
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_profiles_banned_by ON public.user_profiles(banned_by);
