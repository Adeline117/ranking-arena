-- Migration: 20260611120850_exchange_rankings_rpc.sql
-- Created: 2026-06-11T19:08:50Z
-- Description: ARENA_DATA_SPEC v1.2 §6.1 — Exchange Rankings read RPC.
--   Per active non-legacy serving source, aggregates the latest PASSED
--   leaderboard snapshot (+ trader_stats for copier PnL) into board-level
--   metrics: ranked traders, median / top-decile ROI, % profitable,
--   total copier PnL (per source currency — NEVER summed across
--   currencies, spec §5.8), bot share (traders.trader_kind = 'bot').
--   Also returns the serving gate count (sources with serving_mode <>
--   'legacy') so the page can notFound() below the 3-source threshold.
--   Follows the M7 read-RPC pattern: SECURITY DEFINER, read-only, public
--   board data only — copier rows, caches and secrets are never touched.

CREATE OR REPLACE FUNCTION public.arena_exchange_rankings(p_timeframe int)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = arena, public
AS $$
  SELECT jsonb_build_object(
    'nonLegacyCount', (
      SELECT count(*) FROM arena.sources
       WHERE serving_mode <> 'legacy' AND status = 'active'
    ),
    'timeframe', p_timeframe,
    'rows', CASE WHEN p_timeframe NOT IN (7, 30, 90) THEN '[]'::jsonb
    ELSE COALESCE((
      SELECT jsonb_agg(row_obj ORDER BY ranked_traders DESC)
        FROM (
          SELECT
            jsonb_build_object(
              'source', s.slug,
              'exchangeSlug', x.slug,
              'exchangeName', x.name,
              'productType', s.product_type,
              'currency', s.currency,
              'derived', p_timeframe = ANY(s.timeframes_derived),
              'asOf', agg.as_of,
              'rankedTraders', agg.ranked_traders,
              'medianRoi', agg.median_roi,
              'topDecileRoi', agg.top_decile_roi,
              'pctProfitable', agg.pct_profitable,
              -- per-currency money object (spec §5.8) — callers must never
              -- add these across sources with different currencies.
              'copierPnl', CASE WHEN agg.copier_pnl IS NULL THEN NULL
                                ELSE jsonb_build_object(
                                  'value', agg.copier_pnl,
                                  'currency', s.currency) END,
              'botShare', agg.bot_share
            ) AS row_obj,
            agg.ranked_traders
            FROM arena.sources s
            JOIN arena.exchanges x ON x.id = s.exchange_id
            CROSS JOIN LATERAL (
              SELECT
                ls.scraped_at AS as_of,
                count(*) AS ranked_traders,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY e.headline_roi)
                  FILTER (WHERE e.headline_roi IS NOT NULL) AS median_roi,
                percentile_cont(0.9) WITHIN GROUP (ORDER BY e.headline_roi)
                  FILTER (WHERE e.headline_roi IS NOT NULL) AS top_decile_roi,
                CASE WHEN count(e.headline_roi) = 0 THEN NULL
                     ELSE round(100.0 * count(*) FILTER (WHERE e.headline_roi > 0)
                                / count(e.headline_roi), 1) END AS pct_profitable,
                sum(st.copier_pnl) AS copier_pnl,
                round(100.0 * count(*) FILTER (WHERE t.trader_kind = 'bot')
                      / count(*), 1) AS bot_share
                FROM (
                  SELECT id, scraped_at FROM arena.leaderboard_snapshots
                   WHERE source_id = s.id AND timeframe = p_timeframe
                     AND count_check_passed
                   ORDER BY scraped_at DESC LIMIT 1
                ) ls
                JOIN arena.leaderboard_entries e ON e.snapshot_id = ls.id
                JOIN arena.traders t ON t.id = e.trader_id
                LEFT JOIN arena.trader_stats st
                  ON st.trader_id = t.id AND st.timeframe = p_timeframe
               GROUP BY ls.scraped_at
            ) agg
           WHERE s.serving_mode <> 'legacy' AND s.status = 'active'
        ) src_rows
    ), '[]'::jsonb) END
  );
$$;

GRANT EXECUTE ON FUNCTION public.arena_exchange_rankings(int) TO anon, authenticated;
