-- Migration: 20260611190924_revoke_admin_definer_functions_from_public.sql
-- Created: 2026-06-12T02:09:24Z
-- Description: Security advisor (2026-06-12) flagged operational/admin
--   SECURITY DEFINER functions executable by anon+authenticated via
--   PostgREST /rpc. Worst case: update_user_api_tier — an anonymous caller
--   could rewrite a user's paid API tier (privilege escalation). All
--   callers verified server-side only (Stripe webhooks, cron routes,
--   admin monitoring, inline jobs — service_role client), so revoking
--   public EXECUTE breaks nothing.
--   NOT touched: user-facing RPCs (arena_* read RPCs, feeds, notifications,
--   DM permission checks) which are intentionally public.

DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'update_user_api_tier',        -- Stripe webhook only — PRIVILEGE ESCALATION if public
         'rerank_leaderboard',          -- cron compute-leaderboard
         'cleanup_stale_platform_rows', -- cron compute-leaderboard
         'acquire_leaderboard_lock',    -- cron compute-leaderboard
         'release_leaderboard_lock',    -- cron compute-leaderboard
         'recount_all_follow_counts',   -- cron recount-follow-counts
         'expire_group_subscriptions',  -- scheduled job
         'cleanup_old_heartbeats',      -- scheduled job
         'refresh_hot_scores_incremental', -- inline cron job
         'rls_auto_enable',             -- ops tooling
         'find_data_gaps',              -- cron data-reconciliation
         'get_data_gap_summary',        -- cron + admin monitoring
         'get_monitoring_freshness_summary', -- admin monitoring
         'get_expected_platform_counts',     -- pipeline internals
         'verify_group_member_counts',  -- ops verification
         'update_user_streak'           -- trigger/internal
       )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated', fn.sig);
  END LOOP;
END;
$$;
