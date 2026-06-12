-- Migration: 20260611215532_arena_weekly_leaders_rpc.sql
-- Created: 2026-06-12T04:55:32Z
-- Description: ARENA_DATA_SPEC v1.2 §12.6 counter-feature — Weekly
--   Cross-Exchange ROI Arena read RPC. BitMart runs a single-exchange weekly
--   "ROI Arena"; Arena's moat is the SAME competition across every tracked
--   exchange. Per active non-legacy serving source, takes the latest PASSED
--   7d leaderboard snapshot and returns the top headline-ROI traders pooled
--   across sources (p_limit clamped 1-100), plus BitMart's official weekly
--   results (sources.meta.weekly_arena_latest) as the reference panel and
--   the serving gate count (page notFound()s below 3 sources).
--   M7 read-RPC pattern: SECURITY DEFINER, read-only, public board data only.

-- Up
CREATE OR REPLACE FUNCTION public.arena_weekly_leaders(p_limit int DEFAULT 25)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = arena, public
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (ls.source_id) ls.id, ls.source_id, ls.scraped_at
      FROM arena.leaderboard_snapshots ls
      JOIN arena.sources s ON s.id = ls.source_id
     WHERE ls.timeframe = 7 AND ls.count_check_passed
       AND s.serving_mode <> 'legacy' AND s.status = 'active'
     ORDER BY ls.source_id, ls.scraped_at DESC
  ),
  pooled AS (
    SELECT e.headline_roi, e.headline_pnl, e.headline_win_rate, e.rank,
           COALESCE(e.currency, s.currency) AS currency,
           l.scraped_at AS as_of,
           t.exchange_trader_id, t.nickname, t.trader_kind,
           t.avatar_url_mirror, t.avatar_url_origin,
           s.slug AS source, s.product_type,
           x.slug AS exchange_slug, x.name AS exchange_name,
           (7 = ANY(s.timeframes_derived)) AS derived
      FROM latest l
      JOIN arena.leaderboard_entries e ON e.snapshot_id = l.id
      JOIN arena.traders t ON t.id = e.trader_id
      JOIN arena.sources s ON s.id = l.source_id
      JOIN arena.exchanges x ON x.id = s.exchange_id
     WHERE e.headline_roi IS NOT NULL
     ORDER BY e.headline_roi DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100)
  )
  SELECT jsonb_build_object(
    'nonLegacyCount', (
      SELECT count(*) FROM arena.sources
       WHERE serving_mode <> 'legacy' AND status = 'active'
    ),
    'rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'source', source,
               'exchangeSlug', exchange_slug,
               'exchangeName', exchange_name,
               'productType', product_type,
               'exchangeTraderId', exchange_trader_id,
               'nickname', nickname,
               'traderKind', trader_kind,
               'avatarMirrorUrl', avatar_url_mirror,
               'avatarOriginUrl', avatar_url_origin,
               'sourceRank', rank,
               'roi', headline_roi,
               -- per-currency money object (spec §5.8): never summed
               -- across sources with different settlement currencies.
               'pnl', CASE WHEN headline_pnl IS NULL THEN NULL
                           ELSE jsonb_build_object(
                             'value', headline_pnl, 'currency', currency) END,
               'winRate', headline_win_rate,
               'derived', derived,
               'asOf', as_of
             ) ORDER BY headline_roi DESC)
        FROM pooled
    ), '[]'::jsonb),
    'bitmartWeekly', (
      SELECT meta->'weekly_arena_latest'
        FROM arena.sources
       WHERE slug = 'bitmart_futures'
         AND (meta->>'weekly_arena_surface')::boolean IS TRUE
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.arena_weekly_leaders(int) TO anon, authenticated;
