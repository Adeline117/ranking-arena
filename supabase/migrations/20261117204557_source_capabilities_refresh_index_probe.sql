-- Migration: 20261117204557_source_capabilities_refresh_index_probe.sql
--
-- WHY: the pg_cron job refresh-mv-source-capabilities (*/30) has run into the
-- statement timeout on every run since at least 2026-11-17 22:00Z. The view
-- (20260703004045) answers "does this source have any row on a record
-- surface" with SELECT DISTINCT source_id over a join of the WHOLE
-- position_history / order_records / transfer_history / copier_records /
-- positions_current tables, so its cost grows with every ingested row (24s in
-- July). While it runs it holds ACCESS SHARE on those partitioned parents,
-- which blocks the ingest worker's startup ensurePartitions (CREATE TABLE ...
-- PARTITION OF needs ACCESS EXCLUSIVE on the parent) for 20 minutes per hour.
--
-- FIX: same columns, same JSON. Each surface flag becomes a per-trader index
-- probe on the existing (trader_id, ...) index that stops at the first hit, so
-- the cost is bounded by traders × partitions instead of by table size. The
-- LATERAL ... LIMIT 1 keeps the planner from turning the probe back into a
-- whole-table hash join. The refresh waits at most 5s for a lock and runs
-- hourly at :17, away from the :00/:30 marks.

BEGIN;

SET LOCAL lock_timeout = '5s';
-- The definition ran 43s on a cold production cache (read-only EXPLAIN ANALYZE,
-- 2026-11-18); the old one never finished inside 600s.
SET LOCAL statement_timeout = '300s';

-- The definition of a materialized view cannot be altered in place. The old
-- view is kept under a legacy name (nothing is destroyed; renaming it back is
-- the rollback) and is no longer refreshed.
ALTER MATERIALIZED VIEW arena.mv_source_capabilities
  RENAME TO mv_source_capabilities_legacy_20260703;
ALTER INDEX arena.idx_mv_source_capabilities_slug
  RENAME TO idx_mv_source_capabilities_legacy_20260703_slug;

CREATE MATERIALIZED VIEW arena.mv_source_capabilities AS
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
  )
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
        'positions', EXISTS (
          SELECT 1 FROM arena.traders AS t
          CROSS JOIN LATERAL (
            SELECT 1 FROM arena.positions_current AS record WHERE record.trader_id = t.id LIMIT 1
          ) AS hit
          WHERE t.source_id = s.id
        ),
        'position_history', EXISTS (
          SELECT 1 FROM arena.traders AS t
          CROSS JOIN LATERAL (
            SELECT 1 FROM arena.position_history AS record WHERE record.trader_id = t.id LIMIT 1
          ) AS hit
          WHERE t.source_id = s.id
        ),
        'orders', EXISTS (
          SELECT 1 FROM arena.traders AS t
          CROSS JOIN LATERAL (
            SELECT 1 FROM arena.order_records AS record WHERE record.trader_id = t.id LIMIT 1
          ) AS hit
          WHERE t.source_id = s.id
        ),
        'transfers', EXISTS (
          SELECT 1 FROM arena.traders AS t
          CROSS JOIN LATERAL (
            SELECT 1 FROM arena.transfer_history AS record WHERE record.trader_id = t.id LIMIT 1
          ) AS hit
          WHERE t.source_id = s.id
        ),
        'copiers', EXISTS (
          SELECT 1 FROM arena.traders AS t
          CROSS JOIN LATERAL (
            SELECT 1 FROM arena.copier_records AS record WHERE record.trader_id = t.id LIMIT 1
          ) AS hit
          WHERE t.source_id = s.id
        )
      )
    ) AS cap
  FROM arena.sources s
  JOIN arena.exchanges x ON x.id = s.exchange_id
  LEFT JOIN mp ON mp.source_id = s.id
  WHERE s.status = 'active';

CREATE UNIQUE INDEX idx_mv_source_capabilities_slug
  ON arena.mv_source_capabilities (slug);

-- Read only through public.arena_source_capabilities() (SECURITY DEFINER).
REVOKE ALL ON TABLE arena.mv_source_capabilities FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.refresh_source_capabilities_mv()
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO 'arena', 'public'
  SET lock_timeout TO '5s'
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

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-mv-source-capabilities') THEN
    PERFORM cron.unschedule('refresh-mv-source-capabilities');
  END IF;
END $$;

SELECT cron.schedule(
  'refresh-mv-source-capabilities',
  '17 * * * *',
  $$SELECT public.refresh_source_capabilities_mv()$$
);

COMMIT;
