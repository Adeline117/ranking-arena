-- Migration: 20260630185152_arena_score_features_add_typed_risk_cols.sql
-- Created: 2026-07-01T01:51:52Z
-- Description: arena_score_features RPC now returns the typed risk columns
-- (sharpe, mdd, roi, pnl, win_rate) alongside extras, so the Arena Score v2
-- FeatureVector (lib/scoring/arena-score-v2-features.ts) can read the risk-control
-- block. sortino/calmar/pnl_ratio already live in extras; sharpe/mdd are typed
-- trader_stats columns (DEX Tier-0 writes them there), so the extractor had no way
-- to see them until now. CREATE OR REPLACE only — no table/grant changes;
-- service_role-only (SECURITY DEFINER, not granted to anon/authenticated), same as
-- the original (20260611214501).

-- Up
CREATE OR REPLACE FUNCTION public.arena_score_features(p_source text, p_trader text)
  RETURNS jsonb
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'arena', 'public'
AS $function$
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
                 'sharpe', st.sharpe,
                 'mdd', st.mdd,
                 'roi', st.roi,
                 'pnl', st.pnl,
                 'win_rate', st.win_rate,
                 'extras', COALESCE(st.extras, '{}'::jsonb)
               ))
        FROM arena.trader_stats st
       WHERE st.trader_id = t.id
    ), '{}'::jsonb)
  )
    FROM arena.traders t
    JOIN arena.sources s ON s.id = t.source_id
   WHERE s.slug = p_source AND t.exchange_trader_id = p_trader;
$function$;
