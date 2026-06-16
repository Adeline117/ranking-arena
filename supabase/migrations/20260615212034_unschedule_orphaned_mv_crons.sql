-- Migration: 20260615212034_unschedule_orphaned_mv_crons.sql
-- Created: 2026-06-16T04:20:34Z
-- Description: Unschedule two orphaned pg_cron jobs that refresh materialized
--   views which no longer exist. mv_daily_rankings + mv_hourly_prices were
--   dropped in 20260319ab_drop_unused_mvs.sql (no code references them), but
--   20260507125804_pg_cron_mv_refresh_concurrently.sql re-scheduled refresh jobs
--   for them. Verified via cron.job_run_details: both fail EVERY run with
--   "relation ... does not exist". Remove the dead jobs (idempotent).

-- Up
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-mv-daily-rankings') THEN
    PERFORM cron.unschedule('refresh-mv-daily-rankings');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-mv-hourly-prices') THEN
    PERFORM cron.unschedule('refresh-mv-hourly-prices');
  END IF;
END $$;
