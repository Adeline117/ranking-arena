-- Migration: 20260629203649_clamp_arena_core_modules_metrics.sql
-- Created: 2026-06-29T20:36:49Z (ledger version 20260629203649)
-- Description: Clamp roi/mdd/win_rate in arena_core_modules (trader profile RPC).
--
-- Data-read audit (2026-06-29): arena.trader_stats is the RAW ingest layer and
-- holds unclamped source values that the validate-before-write guard catches on
-- the leaderboard_ranks write path — but the trader PROFILE reads trader_stats
-- via arena_core_modules, which emitted st.roi/st.mdd/st.win_rate verbatim with
-- NO clamp. So while leaderboards are clean, a profile page could display
-- garbage like "140665% max drawdown" (gate/bitget/htx/btcc futures: ~1250 rows
-- mdd>100, max 140665) or "219,604,443,778% ROI" (kucoin: roi vs ~0 principal).
--
-- Fix: apply the SAME canonical bounds the rest of the serving layer uses, so the
-- profile agrees with the leaderboard:
--   roi      -> clamp to [-10000, 10000]  (matches arena.score_inputs)
--   mdd      -> NULL when outside [0,100]  (definitional; jsonb_strip_nulls drops
--               it so the frontend NULL-collapses instead of showing a fake DD)
--   win_rate -> NULL when outside [0,100]  (definitional)
-- This is a display-correctness fix; it does NOT change scoring (score_inputs
-- clamps independently) and does NOT alter the raw trader_stats rows. Per-source
-- MDD-scale and KuCoin ROI parser root-causes are tracked separately.

-- Up
CREATE OR REPLACE FUNCTION public.arena_core_modules(p_source text, p_trader text, p_timeframe integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'arena', 'public'
AS $function$
  SELECT jsonb_build_object(
    'timeframe', st.timeframe,
    'asOf', st.as_of,
    'currency', st.currency,
    'stats', jsonb_strip_nulls(jsonb_build_object(
      'roi', LEAST(10000, GREATEST(-10000, st.roi)),
      'pnl', st.pnl, 'sharpe', st.sharpe,
      'mdd', CASE WHEN st.mdd >= 0 AND st.mdd <= 100 THEN st.mdd END,
      'win_rate', CASE WHEN st.win_rate >= 0 AND st.win_rate <= 100 THEN st.win_rate END,
      'win_positions', st.win_positions,
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
$function$;
