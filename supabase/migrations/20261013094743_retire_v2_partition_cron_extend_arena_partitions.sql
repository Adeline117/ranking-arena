-- Migration: 20261013094743_retire_v2_partition_cron_extend_arena_partitions.sql
-- Created: 2026-10-13T16:47:43Z
-- Description:
--   1. Unschedule the dead pg_cron job 'auto-create-v2-partitions'
--      (20260507155251). It calls ensure_future_partitions(3) for
--      trader_snapshots_v2, which was dropped 2026-06-16, so it can only fail.
--   2. Pre-create monthly partitions for arena.leaderboard_entries and
--      arena.trader_series through at least 2027-03, reusing the canonical
--      arena.ensure_month_partitions(text, integer, integer)
--      (latest definition: 20260718135000). That function is idempotent:
--      existing attached partitions are left in place (only RLS/ACL are
--      re-converged), and a name collision with an unattached relation raises.
--
-- Not applied by the authoring agent (V1 NO-GO). Generated for review only.
-- Rollback: the cron job is dead (its target table no longer exists), so no
-- re-schedule is needed. Empty future partitions can be dropped individually
-- if ever required (DROP TABLE arena.<parent>_yYYYYmMM).

-- Up

DO $retire_v2_partition_cron$
DECLARE
  v_jobid bigint;
BEGIN
  -- pg_cron may be absent (local/fixture databases): skip silently there.
  IF pg_catalog.to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron not installed; nothing to unschedule';
    RETURN;
  END IF;

  FOR v_jobid IN
    EXECUTE 'SELECT jobid FROM cron.job WHERE jobname = $1'
    USING 'auto-create-v2-partitions'
  LOOP
    EXECUTE 'SELECT cron.unschedule($1)' USING v_jobid;
  END LOOP;
END
$retire_v2_partition_cron$;

DO $extend_arena_partitions$
DECLARE
  v_now date := pg_catalog.date_trunc('month', pg_catalog.statement_timestamp())::date;
  -- Months from the current month to 2027-03 inclusive; never fewer than the
  -- worker's 3-month lookahead, capped at the function's 24-month ceiling.
  v_months_ahead integer;
  v_table text;
BEGIN
  v_months_ahead := (2027 * 12 + 3)
    - (EXTRACT(YEAR FROM v_now)::integer * 12 + EXTRACT(MONTH FROM v_now)::integer);
  v_months_ahead := LEAST(24, GREATEST(3, v_months_ahead));

  FOREACH v_table IN ARRAY ARRAY['leaderboard_entries', 'trader_series'] LOOP
    PERFORM arena.ensure_month_partitions(v_table, v_months_ahead, 0);
  END LOOP;
END
$extend_arena_partitions$;
