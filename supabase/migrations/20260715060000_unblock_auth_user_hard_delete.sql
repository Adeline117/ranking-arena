-- Remove the remaining FK blockers that could prevent the day-30 auth-user
-- deletion. Personal membership/read state cascades; durable moderation and
-- ownership audit fields retain their records but clear the deleted actor.

ALTER TABLE public.alert_config
  DROP CONSTRAINT alert_config_updated_by_fkey,
  ADD CONSTRAINT alert_config_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.channel_members
  DROP CONSTRAINT channel_members_user_id_fkey,
  ADD CONSTRAINT channel_members_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.channel_message_reads
  DROP CONSTRAINT channel_message_reads_user_id_fkey,
  ADD CONSTRAINT channel_message_reads_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.channel_messages
  DROP CONSTRAINT channel_messages_sender_id_fkey,
  ADD CONSTRAINT channel_messages_sender_id_fkey
    FOREIGN KEY (sender_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.chat_channels
  DROP CONSTRAINT chat_channels_created_by_fkey,
  ADD CONSTRAINT chat_channels_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.content_reports
  DROP CONSTRAINT content_reports_resolved_by_fkey,
  ADD CONSTRAINT content_reports_resolved_by_fkey
    FOREIGN KEY (resolved_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.group_applications
  DROP CONSTRAINT group_applications_reviewed_by_fkey,
  ADD CONSTRAINT group_applications_reviewed_by_fkey
    FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.group_edit_applications
  DROP CONSTRAINT group_edit_applications_reviewed_by_fkey,
  ADD CONSTRAINT group_edit_applications_reviewed_by_fkey
    FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.kol_applications
  DROP CONSTRAINT kol_applications_user_id_fkey,
  ADD CONSTRAINT kol_applications_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.manipulation_alert_history
  DROP CONSTRAINT manipulation_alert_history_performed_by_fkey,
  ADD CONSTRAINT manipulation_alert_history_performed_by_fkey
    FOREIGN KEY (performed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.manipulation_alerts
  DROP CONSTRAINT manipulation_alerts_resolved_by_fkey,
  ADD CONSTRAINT manipulation_alerts_resolved_by_fkey
    FOREIGN KEY (resolved_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.user_levels
  DROP CONSTRAINT user_levels_user_id_fkey,
  ADD CONSTRAINT user_levels_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.user_profiles
  DROP CONSTRAINT user_profiles_banned_by_fkey,
  ADD CONSTRAINT user_profiles_banned_by_fkey
    FOREIGN KEY (banned_by) REFERENCES auth.users(id) ON DELETE SET NULL;
