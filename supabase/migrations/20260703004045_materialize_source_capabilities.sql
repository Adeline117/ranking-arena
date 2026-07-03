-- Migration: 20260703004045_materialize_source_capabilities.sql
--
-- WHY: arena_source_capabilities() scanned the full arena.trader_stats (~380K
-- rows) + 4 DISTINCT scans over partitioned record tables on EVERY trader-detail
-- page load → EXPLAIN ANALYZE 24.3s, always exceeding the SSR 2s wrapper AND the
-- /api/sources/capabilities PostgREST statement timeout (57014). The client
-- collapses that error to {} (capabilities.ts:36), capability resolves to null,
-- and ServingRecordsSection gates OFF every record surface (positions/history/
-- orders/transfers/copiers). Net: this session's record harvests exist in the DB
-- but render BLANK for ~every trader — a core-path blocker found by the
-- front-to-back audit 2026-07-03.
--
-- The capability matrix is NEAR-STATIC (changes only when a source starts/stops
-- producing a metric or record surface). Materialize it (same pattern as
-- mv_popular_tokens_90d) + refresh every 30 min via pg_cron. Also fixes the
-- config-derived copiers surface: was `copier_table_depth <> 'none'` (so 7
-- sources with zero copier_records advertised an empty Copiers tab) → now
-- EXISTS on real copier_records rows, consistent with every other surface.

-- 1) Materialized view — per-source capability object (one row per active source).
CREATE MATERIALIZED VIEW IF NOT EXISTS arena.mv_source_capabilities AS
  WITH mp AS (
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
  ph_src  AS (SELECT DISTINCT t.source_id FROM arena.position_history ph  JOIN arena.traders t ON t.id = ph.trader_id),
  ord_src AS (SELECT DISTINCT t.source_id FROM arena.order_records    o   JOIN arena.traders t ON t.id = o.trader_id),
  trf_src AS (SELECT DISTINCT t.source_id FROM arena.transfer_history  tr  JOIN arena.traders t ON t.id = tr.trader_id),
  pos_src AS (SELECT DISTINCT t.source_id FROM arena.positions_current pc  JOIN arena.traders t ON t.id = pc.trader_id),
  cop_src AS (SELECT DISTINCT t.source_id FROM arena.copier_records    cr  JOIN arena.traders t ON t.id = cr.trader_id)
  SELECT s.slug,
    jsonb_build_object(
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
        -- data-derived (was config `copier_table_depth <> 'none'` → empty tabs)
        'copiers',          EXISTS(SELECT 1 FROM cop_src WHERE source_id = s.id)
      )
    ) AS cap
  FROM arena.sources s
  JOIN arena.exchanges x ON x.id = s.exchange_id
  LEFT JOIN mp ON mp.source_id = s.id
  WHERE s.status = 'active';

-- Unique index required for REFRESH ... CONCURRENTLY (non-blocking reads).
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_source_capabilities_slug
  ON arena.mv_source_capabilities (slug);

-- 2) Repoint the RPC to read the matview + aggregate (~34 rows = instant). Same
--    signature + return (single jsonb keyed by slug) → zero code change at
--    lib/data/serving/capabilities.ts.
CREATE OR REPLACE FUNCTION public.arena_source_capabilities()
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'arena', 'public'
AS $function$
  SELECT COALESCE(jsonb_object_agg(slug, cap), '{}'::jsonb)
  FROM arena.mv_source_capabilities;
$function$;

-- 3) Bootstrap-aware refresh (CONCURRENTLY can't populate an empty matview).
CREATE OR REPLACE FUNCTION public.refresh_source_capabilities_mv()
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO 'arena', 'public'
AS $function$
BEGIN
  IF (SELECT ispopulated FROM pg_matviews
      WHERE schemaname = 'arena' AND matviewname = 'mv_source_capabilities') THEN
    REFRESH MATERIALIZED VIEW CONCURRENTLY arena.mv_source_capabilities;
  ELSE
    REFRESH MATERIALIZED VIEW arena.mv_source_capabilities;
  END IF;
END;
$function$;

-- 4) Schedule refresh every 30 min (capability matrix is near-static; the record
--    surfaces it gates tolerate ~30 min staleness). Idempotent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-mv-source-capabilities') THEN
    PERFORM cron.unschedule('refresh-mv-source-capabilities');
  END IF;
END $$;

SELECT cron.schedule(
  'refresh-mv-source-capabilities',
  '*/30 * * * *',
  $$SELECT public.refresh_source_capabilities_mv()$$
);
