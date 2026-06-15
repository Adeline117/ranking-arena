-- Migration: 20260615134432_optimize_arena_source_capabilities_single_pass.sql
-- Created: 2026-06-15T20:44:32Z
-- Description: arena_source_capabilities was ~10s → the trader-detail page races
--   it against a 2s timeout, so it almost always lost → capability resolved to
--   {} → null on the page → record tabs vanished + period default/disabling
--   broke for ALL serving sources on a cold data cache.
--
--   Two root costs, both fixed here:
--   1) metrics presence ran a CORRELATED subquery per active source, each a full
--      scan of arena.trader_stats (308k rows) → 35× scan. Now ONE GROUP BY pass.
--   2) surfaces ran 4 EXISTS per source (140 total), each merge-joining whole
--      partitioned record tables (order_records 409k…). Now 4 DISTINCT-source
--      passes (one per table).
--   Crucially the CTEs are MATERIALIZED: without it PG inlines them and
--   re-evaluates each EXISTS' CTE per source row (35×), keeping it at ~10s.
--   MATERIALIZED computes each once → 10s → ~1s. Output is byte-identical;
--   only the plan changes. Verified vs prod after apply; qa:schema green.

-- Up
CREATE OR REPLACE FUNCTION public.arena_source_capabilities()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'arena', 'public'
AS $function$
  WITH mp AS MATERIALIZED (
    SELECT t.source_id,
      count(st.roi)                  AS c_roi,
      count(st.pnl)                  AS c_pnl,
      count(st.sharpe)               AS c_sharpe,
      count(st.mdd)                  AS c_mdd,
      count(st.win_rate)             AS c_win_rate,
      count(st.win_positions)        AS c_win_positions,
      count(st.total_positions)      AS c_total_positions,
      count(st.copier_pnl)           AS c_copier_pnl,
      count(st.copier_count)         AS c_copier_count,
      count(st.aum)                  AS c_aum,
      count(st.volume)               AS c_volume,
      count(st.profit_share_rate)    AS c_profit_share_rate,
      count(st.holding_duration_avg) AS c_holding_duration_avg
    FROM arena.trader_stats st
    JOIN arena.traders t ON t.id = st.trader_id
    GROUP BY t.source_id
  ),
  ph_src  AS MATERIALIZED (SELECT DISTINCT t.source_id FROM arena.position_history ph JOIN arena.traders t ON t.id = ph.trader_id),
  ord_src AS MATERIALIZED (SELECT DISTINCT t.source_id FROM arena.order_records   o  JOIN arena.traders t ON t.id = o.trader_id),
  trf_src AS MATERIALIZED (SELECT DISTINCT t.source_id FROM arena.transfer_history tr JOIN arena.traders t ON t.id = tr.trader_id),
  pos_src AS MATERIALIZED (SELECT DISTINCT t.source_id FROM arena.positions_current pc JOIN arena.traders t ON t.id = pc.trader_id)
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
          CASE WHEN mp.c_roi                  > 0 THEN 'roi' END,
          CASE WHEN mp.c_pnl                  > 0 THEN 'pnl' END,
          CASE WHEN mp.c_sharpe               > 0 THEN 'sharpe' END,
          CASE WHEN mp.c_mdd                  > 0 THEN 'mdd' END,
          CASE WHEN mp.c_win_rate             > 0 THEN 'win_rate' END,
          CASE WHEN mp.c_win_positions        > 0 THEN 'win_positions' END,
          CASE WHEN mp.c_total_positions      > 0 THEN 'total_positions' END,
          CASE WHEN mp.c_copier_pnl           > 0 THEN 'copier_pnl' END,
          CASE WHEN mp.c_copier_count         > 0 THEN 'copier_count' END,
          CASE WHEN mp.c_aum                  > 0 THEN 'aum' END,
          CASE WHEN mp.c_volume               > 0 THEN 'volume' END,
          CASE WHEN mp.c_profit_share_rate    > 0 THEN 'profit_share_rate' END,
          CASE WHEN mp.c_holding_duration_avg > 0 THEN 'holding_duration_avg' END
        ]) AS metric
      ) m WHERE metric IS NOT NULL
    ), '[]'::jsonb),
    'surfaces', jsonb_build_object(
      'positions',        EXISTS(SELECT 1 FROM pos_src WHERE source_id = s.id),
      'position_history', EXISTS(SELECT 1 FROM ph_src  WHERE source_id = s.id),
      'orders',           EXISTS(SELECT 1 FROM ord_src WHERE source_id = s.id),
      'transfers',        EXISTS(SELECT 1 FROM trf_src WHERE source_id = s.id),
      'copiers',          s.copier_table_depth <> 'none'
    )
  )), '{}'::jsonb)
    FROM arena.sources s
    JOIN arena.exchanges x ON x.id = s.exchange_id
    LEFT JOIN mp ON mp.source_id = s.id
   WHERE s.status = 'active';
$function$;
