-- Migration: Schedule MV refreshes via pg_cron with CONCURRENTLY
-- Purpose: mv_daily_rankings and mv_hourly_prices block reads during refresh.
--          REFRESH CONCURRENTLY builds new data in background and swaps atomically.
--          Requires: unique index on each MV (created in 00077_materialized_views.sql)

-- Enable pg_cron (already enabled on Supabase, idempotent)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Unschedule if already exists (idempotent re-run)
SELECT cron.unschedule('refresh-mv-daily-rankings')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-mv-daily-rankings');
SELECT cron.unschedule('refresh-mv-hourly-prices')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-mv-hourly-prices');

-- Schedule CONCURRENTLY refresh for mv_daily_rankings (every 2h at :15)
-- Runs after compute-leaderboard (:01/:21/:41) finishes
SELECT cron.schedule(
  'refresh-mv-daily-rankings',
  '15 */2 * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_rankings$$
);

-- Schedule CONCURRENTLY refresh for mv_hourly_prices (every hour at :05)
SELECT cron.schedule(
  'refresh-mv-hourly-prices',
  '5 * * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY mv_hourly_prices$$
);
