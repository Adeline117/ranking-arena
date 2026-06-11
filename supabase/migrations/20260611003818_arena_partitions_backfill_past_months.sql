-- Migration: 20260611003818_arena_partitions_backfill_past_months.sql
-- Created: 2026-06-11T07:38:18Z
-- Description: arena partitions — backfill PAST months.
--
-- Why: trader_series / history tables are RANGE-partitioned but
-- ensure_month_partitions() only created current month + 2 ahead.
-- Profile chart series carry 30-90d of HISTORY (e.g. Bitget cycleData
-- roiRows/pnlRows) and Bitget balance history backfills 180d — inserts of
-- those points fail with "no partition of relation found for row"
-- (verified live 2026-06-11 on trader_series, ts = 2026-05-12).
--
-- Fix: teach the helper to also create months_back past partitions, then
-- backfill 7 months back for every partitioned arena table (covers the
-- 180d transfer backfill rule with margin). Idempotent.

-- Up

CREATE OR REPLACE FUNCTION arena.ensure_month_partitions(
  parent_table text,
  months_ahead int DEFAULT 2,
  months_back int DEFAULT 0
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = arena, public
AS $$
DECLARE
  m date;
  part_name text;
  created int := 0;
BEGIN
  IF parent_table NOT IN ('leaderboard_entries', 'trader_series',
                          'position_history', 'order_records',
                          'transfer_history', 'copier_records') THEN
    RAISE EXCEPTION 'ensure_month_partitions: unsupported table %', parent_table;
  END IF;

  FOR i IN -months_back..months_ahead LOOP
    m := (date_trunc('month', now()) + (i || ' months')::interval)::date;
    part_name := format('%s_y%sm%s', parent_table,
                        to_char(m, 'YYYY'), to_char(m, 'MM'));
    IF to_regclass('arena.' || part_name) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE arena.%I PARTITION OF arena.%I FOR VALUES FROM (%L) TO (%L)',
        part_name, parent_table, m, (m + interval '1 month')::date
      );
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END;
$$;

REVOKE EXECUTE ON FUNCTION arena.ensure_month_partitions(text, int, int)
  FROM anon, authenticated;

-- Drop the old 2-arg signature (superseded by the 3-arg one with defaults;
-- keeping both would make ensure_month_partitions('x', 2) ambiguous).
DROP FUNCTION IF EXISTS arena.ensure_month_partitions(text, int);

-- Backfill: 7 months back covers 180d balance-history retention + margin.
SELECT arena.ensure_month_partitions('leaderboard_entries', 2, 7);
SELECT arena.ensure_month_partitions('trader_series', 2, 7);
SELECT arena.ensure_month_partitions('position_history', 2, 7);
SELECT arena.ensure_month_partitions('order_records', 2, 7);
SELECT arena.ensure_month_partitions('transfer_history', 2, 7);
SELECT arena.ensure_month_partitions('copier_records', 2, 7);
