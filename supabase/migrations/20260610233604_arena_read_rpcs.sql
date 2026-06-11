-- Migration: 20260610233604_arena_read_rpcs.sql
-- Created: 2026-06-11T06:36:04Z
-- Description: ARENA_DATA_SPEC v1.2 — M7: public-schema read RPCs for the
--   serving layer. PostgREST exposes public.* functions out of the box, so
--   the frontend can read arena.* through these WITHOUT the hosted
--   "exposed schemas" dashboard change (removes that deploy dependency
--   entirely). SECURITY DEFINER but read-only, and they return ONLY data
--   that already has public SELECT policies — copier rows, caches, cursors
--   and secrets are never touched.

-- ============================================================
-- First screen (spec §2.4-1): everything a profile page needs to render
-- instantly from Tier-A data. One indexed lookup per timeframe.
-- ============================================================
CREATE OR REPLACE FUNCTION public.arena_first_screen(
  p_source text,
  p_trader text
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = arena, public
AS $$
  SELECT jsonb_build_object(
    'source', s.slug,
    'exchangeTraderId', t.exchange_trader_id,
    'nickname', t.nickname,
    'avatarMirrorUrl', t.avatar_url_mirror,
    'avatarOriginUrl', t.avatar_url_origin,
    'walletAddress', t.wallet_address,
    'traderKind', t.trader_kind,
    'botStrategy', t.bot_strategy,
    'currency', s.currency,
    'entries', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'timeframe', e.timeframe,
               'rank', e.rank,
               'headlineRoi', e.headline_roi,
               'headlinePnl', e.headline_pnl,
               'headlineWinRate', e.headline_win_rate,
               'currency', e.currency,
               'extras', COALESCE(e.raw, '{}'::jsonb),
               'asOf', e.scraped_at
             ) ORDER BY e.timeframe)
        FROM (
          SELECT DISTINCT ON (e.timeframe) e.*
            FROM arena.leaderboard_entries e
            JOIN arena.leaderboard_snapshots ls ON ls.id = e.snapshot_id
           WHERE e.trader_id = t.id AND ls.count_check_passed
           ORDER BY e.timeframe, e.scraped_at DESC
        ) e
    ), '[]'::jsonb)
  )
    FROM arena.traders t
    JOIN arena.sources s ON s.id = t.source_id
   WHERE s.slug = p_source AND t.exchange_trader_id = p_trader;
$$;

-- ============================================================
-- Core modules (spec §2.4-2): stats block + chart series for one TF.
-- Returns NULL when nothing is cached → the API route triggers Tier-C.
-- ============================================================
CREATE OR REPLACE FUNCTION public.arena_core_modules(
  p_source text,
  p_trader text,
  p_timeframe int
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = arena, public
AS $$
  SELECT jsonb_build_object(
    'timeframe', st.timeframe,
    'asOf', st.as_of,
    'currency', st.currency,
    'stats', jsonb_strip_nulls(jsonb_build_object(
      'roi', st.roi, 'pnl', st.pnl, 'sharpe', st.sharpe, 'mdd', st.mdd,
      'win_rate', st.win_rate, 'win_positions', st.win_positions,
      'total_positions', st.total_positions, 'copier_pnl', st.copier_pnl,
      'copier_count', st.copier_count, 'aum', st.aum, 'volume', st.volume,
      'profit_share_rate', st.profit_share_rate,
      'holding_duration_avg',
        EXTRACT(EPOCH FROM st.holding_duration_avg) / 3600,
      'trading_preferences', st.trading_preferences
    )),
    'extras', st.extras,
    'series', COALESCE((
      SELECT jsonb_object_agg(metric, points)
        FROM (
          SELECT metric,
                 jsonb_agg(jsonb_build_object('ts', ts, 'value', value)
                           ORDER BY ts) AS points
            FROM (
              SELECT metric, ts, value
                FROM arena.trader_series
               WHERE trader_id = t.id AND timeframe = st.timeframe
               ORDER BY ts DESC
               LIMIT 1000
            ) recent
           GROUP BY metric
        ) m
    ), '{}'::jsonb)
  )
    FROM arena.traders t
    JOIN arena.sources s ON s.id = t.source_id
    JOIN arena.trader_stats st ON st.trader_id = t.id AND st.timeframe = p_timeframe
   WHERE s.slug = p_source AND t.exchange_trader_id = p_trader;
$$;

-- ============================================================
-- Capability matrix (spec §6 "capability matrix is data, not code"):
-- per-source TF availability + exposed metrics (observed non-NULL
-- coverage over trader_stats) + record surfaces.
-- ============================================================
CREATE OR REPLACE FUNCTION public.arena_source_capabilities()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = arena, public
AS $$
  SELECT COALESCE(jsonb_object_agg(s.slug, jsonb_build_object(
    'exchangeName', x.name,
    'currency', s.currency,
    'productType', s.product_type,
    'isOnchain', s.product_type = 'onchain',
    'copierDepth', s.copier_table_depth,
    'timeframesNative', s.timeframes_native,
    'timeframesDerived', s.timeframes_derived,
    'servingMode', s.serving_mode,
    'metrics', COALESCE((
      SELECT jsonb_agg(metric) FROM (
        SELECT unnest(ARRAY[
          CASE WHEN count(roi) > 0 THEN 'roi' END,
          CASE WHEN count(pnl) > 0 THEN 'pnl' END,
          CASE WHEN count(sharpe) > 0 THEN 'sharpe' END,
          CASE WHEN count(mdd) > 0 THEN 'mdd' END,
          CASE WHEN count(win_rate) > 0 THEN 'win_rate' END,
          CASE WHEN count(win_positions) > 0 THEN 'win_positions' END,
          CASE WHEN count(total_positions) > 0 THEN 'total_positions' END,
          CASE WHEN count(copier_pnl) > 0 THEN 'copier_pnl' END,
          CASE WHEN count(copier_count) > 0 THEN 'copier_count' END,
          CASE WHEN count(aum) > 0 THEN 'aum' END,
          CASE WHEN count(volume) > 0 THEN 'volume' END,
          CASE WHEN count(profit_share_rate) > 0 THEN 'profit_share_rate' END,
          CASE WHEN count(holding_duration_avg) > 0 THEN 'holding_duration_avg' END
        ]) AS metric
          FROM arena.trader_stats st
          JOIN arena.traders t ON t.id = st.trader_id
         WHERE t.source_id = s.id
      ) m WHERE metric IS NOT NULL
    ), '[]'::jsonb),
    'surfaces', jsonb_build_object(
      'positions', EXISTS(
        SELECT 1 FROM arena.positions_current pc
          JOIN arena.traders t ON t.id = pc.trader_id
         WHERE t.source_id = s.id LIMIT 1),
      'position_history', EXISTS(
        SELECT 1 FROM arena.position_history ph
          JOIN arena.traders t ON t.id = ph.trader_id
         WHERE t.source_id = s.id LIMIT 1),
      'orders', EXISTS(
        SELECT 1 FROM arena.order_records o
          JOIN arena.traders t ON t.id = o.trader_id
         WHERE t.source_id = s.id LIMIT 1),
      'transfers', EXISTS(
        SELECT 1 FROM arena.transfer_history tr
          JOIN arena.traders t ON t.id = tr.trader_id
         WHERE t.source_id = s.id LIMIT 1),
      'copiers', s.copier_table_depth <> 'none'
    )
  )), '{}'::jsonb)
    FROM arena.sources s
    JOIN arena.exchanges x ON x.id = s.exchange_id
   WHERE s.status = 'active';
$$;

GRANT EXECUTE ON FUNCTION public.arena_first_screen(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arena_core_modules(text, text, int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arena_source_capabilities() TO anon, authenticated;
