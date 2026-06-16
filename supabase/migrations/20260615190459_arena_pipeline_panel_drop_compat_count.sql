-- Migration: 20260615190459_arena_pipeline_panel_drop_compat_count.sql
-- Created: 2026-06-16T02:04:59Z
-- Description: TODO — explain what this migration does and why

-- Concurrency Safety Checklist (delete after reviewing):
-- [ ] New tables with one-per-user rows: add UNIQUE or partial unique index
-- [ ] Counter columns: use atomic RPC (lib 00021), NOT trigger-based count+1
-- [ ] Check-then-act patterns: use pg_advisory_xact_lock or SELECT FOR UPDATE
-- [ ] FK to parent: include ON DELETE CASCADE
-- [ ] New functions: add SET search_path = public, SECURITY DEFINER if needed
-- [ ] 应用后跑 npm run qa:schema 核对落地 —— "写进仓库 ≠ 应用到生产"(2026-06 漂移教训)

-- Up
-- Remove the public.trader_latest dependency from arena_pipeline_panel before
-- trader_latest is dropped. compat_rows was the shadow dual-write health count;
-- the compat bridge is being retired, so it's always 0 now (column kept so the
-- typed RPC return shape + admin panel are unchanged).
CREATE OR REPLACE FUNCTION public.arena_pipeline_panel()
 RETURNS TABLE(slug text, serving_mode text, status text, phase integer, timeframe integer, last_passed_at timestamp with time zone, actual_count integer, rejects_24h bigint, compat_platform text, compat_rows bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'arena', 'public'
AS $function$
  WITH src AS (
    SELECT s.id, s.slug, s.serving_mode, s.status, s.phase::int AS phase,
           CASE WHEN s.meta ? 'legacy_platform'
                THEN s.meta->>'legacy_platform'
                ELSE s.slug
           END AS compat_platform,
           tf.timeframe
      FROM arena.sources s
     CROSS JOIN LATERAL (
       SELECT DISTINCT t.t AS timeframe
         FROM unnest(s.timeframes_native || s.timeframes_derived) AS t(t)
     ) tf
     WHERE s.status = 'active'
  ),
  rejects AS (
    SELECT r.source_id, count(*) AS cnt
      FROM arena.staging_rejects r
     WHERE r.created_at > now() - interval '24 hours'
     GROUP BY r.source_id
  )
  SELECT src.slug, src.serving_mode, src.status, src.phase,
         src.timeframe,
         ls.scraped_at AS last_passed_at,
         ls.actual_count,
         COALESCE(rj.cnt, 0) AS rejects_24h,
         src.compat_platform,
         0::bigint AS compat_rows
    FROM src
    LEFT JOIN LATERAL (
      SELECT s2.scraped_at, s2.actual_count
        FROM arena.leaderboard_snapshots s2
       WHERE s2.source_id = src.id
         AND s2.timeframe = src.timeframe
         AND s2.count_check_passed
       ORDER BY s2.scraped_at DESC
       LIMIT 1
    ) ls ON true
    LEFT JOIN rejects rj ON rj.source_id = src.id
   ORDER BY src.slug, src.timeframe;
$function$;
