-- Migration: arena_health_freshness_rpc
-- Description: Health-check freshness signal for the NEW pipeline — newest
--   passed snapshot across active sources. /api/health ORs this with the
--   legacy trader_latest signal (serving-only sources never write
--   trader_latest, which made them invisible to the uptime monitor).
--   service_role-only (functions are private-by-default now).

CREATE OR REPLACE FUNCTION public.arena_latest_snapshot_at()
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = arena, public
AS $$
  SELECT max(ls.scraped_at)
    FROM arena.leaderboard_snapshots ls
   WHERE ls.count_check_passed;
$$;

REVOKE EXECUTE ON FUNCTION public.arena_latest_snapshot_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arena_latest_snapshot_at() TO service_role;
