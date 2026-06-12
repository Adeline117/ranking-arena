-- Migration: 20260611214501_arena_score_features_rpc.sql
-- Created: 2026-06-12T04:45:01Z
-- Description: ARENA_DATA_SPEC v1.2 §12.2 — Arena Score v2 feature read RPC.
--   Returns traders.meta + per-timeframe trader_stats.extras for ONE trader,
--   consumed by lib/scoring/arena-score-v2-features.ts (extractFeatureVector).
--   SERVICE_ROLE ONLY: extras/meta carry scraped enrichment (style tags,
--   radar percentiles, risk ratings, KOL/wallet labels) that feeds scoring —
--   it is not public-board data, so unlike the arena_* read RPCs this one is
--   explicitly NOT granted to anon/authenticated. Functions default to
--   EXECUTE for PUBLIC in Postgres, hence the explicit REVOKE.

-- Up
CREATE OR REPLACE FUNCTION public.arena_score_features(
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
    'traderKind', t.trader_kind,
    'meta', COALESCE(t.meta, '{}'::jsonb),
    'byTimeframe', COALESCE((
      SELECT jsonb_object_agg(
               st.timeframe::text,
               jsonb_build_object(
                 'asOf', st.as_of,
                 'extras', COALESCE(st.extras, '{}'::jsonb)
               ))
        FROM arena.trader_stats st
       WHERE st.trader_id = t.id
    ), '{}'::jsonb)
  )
    FROM arena.traders t
    JOIN arena.sources s ON s.id = t.source_id
   WHERE s.slug = p_source AND t.exchange_trader_id = p_trader;
$$;

REVOKE ALL ON FUNCTION public.arena_score_features(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.arena_score_features(text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arena_score_features(text, text) TO service_role;
