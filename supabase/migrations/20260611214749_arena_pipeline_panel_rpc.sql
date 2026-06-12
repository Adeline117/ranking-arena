-- Migration: 20260611214749_arena_pipeline_panel_rpc.sql
-- Created: 2026-06-12T04:47:49Z
-- Description: Admin observability RPC for the new ingest pipeline
--   (/admin/monitoring arena pipeline panel). One row per
--   (active source × timeframe):
--     - latest PASSED snapshot age + actual_count (publish-gate health)
--     - staging_rejects count over the last 24h (source-level, repeated)
--     - serving_mode / phase (cutover state)
--     - compat row count in public.trader_latest for the source's legacy
--       platform + window (shadow dual-write health)
--   SECURITY DEFINER, service_role-only: functions are private-by-default
--   now (20260611191644) and this reads arena.staging_rejects, which has
--   no public SELECT policy — the explicit GRANT goes to service_role
--   only, the admin API route calls it with the service-role client.

CREATE OR REPLACE FUNCTION public.arena_pipeline_panel()
RETURNS TABLE (
  slug text,
  serving_mode text,
  status text,
  phase int,
  timeframe int,
  last_passed_at timestamptz,
  actual_count int,
  rejects_24h bigint,
  compat_platform text,
  compat_rows bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = arena, public
AS $$
  WITH src AS (
    SELECT s.id, s.slug, s.serving_mode, s.status, s.phase::int AS phase,
           -- Mirror compat-trader-latest.ts semantics exactly: an explicit
           -- meta.legacy_platform overrides the slug; explicit null
           -- disables compat writes (→ NULL platform matches no rows).
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
         COALESCE(cm.cnt, 0) AS compat_rows
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
    LEFT JOIN LATERAL (
      SELECT count(*) AS cnt
        FROM public.trader_latest tl
       WHERE src.compat_platform IS NOT NULL
         AND tl.platform = src.compat_platform
         AND tl."window" = CASE src.timeframe
                             WHEN 7 THEN '7D' WHEN 30 THEN '30D' WHEN 90 THEN '90D'
                           END
    ) cm ON true
   ORDER BY src.slug, src.timeframe;
$$;

-- Private-by-default already revokes for future functions; be explicit
-- anyway (same pattern as arena_latest_snapshot_at).
REVOKE EXECUTE ON FUNCTION public.arena_pipeline_panel() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arena_pipeline_panel() TO service_role;
