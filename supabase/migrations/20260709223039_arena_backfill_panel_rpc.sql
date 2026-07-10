-- Migration: 20260709223039_arena_backfill_panel_rpc.sql
-- Created: 2026-07-09T22:30:39Z (PT)
-- Description: arena_backfill_panel RPC — admin 面板一眼看回填进度(游标/带宽/填充率)
--
-- 此前回填进度只能手查 SQL(2026-07-09 全天实操痛点)。数据全部现成:
-- ingest_cursors(series_backfill 游标) + metric_fill_trend(每日填充率快照,
-- fill-rate 哨兵在写)。本 RPC 只做聚合,零新采集。

-- Up
CREATE OR REPLACE FUNCTION public.arena_backfill_panel()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = arena, public
AS $$
SELECT jsonb_build_object(
  'cursors', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'slug', s.slug,
      'cursor', NULLIF(ic.cursor_value, '')::int,
      'topn', (s.meta->>'series_backfill_topn')::int,
      'updated_at', ic.updated_at
    ) ORDER BY s.slug)
    FROM arena.ingest_cursors ic
    JOIN arena.sources s ON s.id = -ic.trader_id
    WHERE ic.kind = 'series_backfill'
  ), '[]'::jsonb),
  'fill', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'slug', f.slug, 'metric', f.metric,
      'filled', f.filled, 'total', f.total, 'taken_on', f.taken_on
    ) ORDER BY f.slug, f.metric)
    FROM (
      SELECT DISTINCT ON (slug, metric) slug, metric, filled, total, taken_on
        FROM arena.metric_fill_trend
       ORDER BY slug, metric, taken_on DESC
    ) f
  ), '[]'::jsonb)
);
$$;
REVOKE EXECUTE ON FUNCTION public.arena_backfill_panel() FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.arena_backfill_panel() TO service_role;
