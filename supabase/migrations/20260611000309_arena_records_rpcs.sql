-- Migration: 20260611000309_arena_records_rpcs.sql
-- Created: 2026-06-11T07:03:09Z
-- Description: ARENA_DATA_SPEC v1.2 Workstream E — heavy-tab record RPCs
--   (spec §2.4-3). arena_records_page serves keyset-paginated warm reads
--   for positions/position_history/orders/transfers; the copiers kind is
--   HARD-BLOCKED here and served exclusively by arena_copier_aggregate,
--   which never selects copier_label (spec §6 PII rule — enforced in SQL,
--   not just in the serializer).

-- Up

-- ============================================================
-- Keyset-paginated record pages. Cursor format: '{ts}|{dedupe_hash}'
-- (opaque to clients). DESC ordering, so the keyset condition is
-- (ts, dedupe_hash) < (cursor_ts, cursor_hash).
-- ============================================================
CREATE OR REPLACE FUNCTION public.arena_records_page(
  p_source text,
  p_trader text,
  p_kind text,
  p_tf int DEFAULT NULL,        -- reserved: record surfaces are not TF-scoped yet
  p_cursor text DEFAULT NULL,
  p_limit int DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = arena, public
AS $$
DECLARE
  v_trader_id bigint;
  v_currency text;
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_cursor_ts timestamptz;
  v_cursor_hash text;
  v_rows jsonb;
  v_count int;
  v_last_ts timestamptz;
  v_last_hash text;
  v_as_of timestamptz;
BEGIN
  IF p_kind = 'copiers' THEN
    -- Spec §6: copier data is aggregate-only; row access is not available
    -- through any public surface.
    RAISE EXCEPTION 'copier records are aggregate-only; use arena_copier_aggregate';
  END IF;
  IF p_kind NOT IN ('positions', 'position_history', 'orders', 'transfers') THEN
    RAISE EXCEPTION 'unknown record kind: %', p_kind;
  END IF;

  SELECT t.id, s.currency INTO v_trader_id, v_currency
    FROM arena.traders t
    JOIN arena.sources s ON s.id = t.source_id
   WHERE s.slug = p_source AND t.exchange_trader_id = p_trader;
  IF v_trader_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_cursor IS NOT NULL AND p_cursor <> '' THEN
    v_cursor_ts := split_part(p_cursor, '|', 1)::timestamptz;
    v_cursor_hash := split_part(p_cursor, '|', 2);
  END IF;

  IF p_kind = 'positions' THEN
    -- Snapshot table (fully replaced per Tier-D cycle): one page, no cursor.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'symbol', symbol, 'side', side, 'leverage', leverage,
             'size', size, 'entry_price', entry_price,
             'mark_price', mark_price, 'unrealized_pnl', unrealized_pnl,
             'currency', currency, 'as_of', as_of
           ) ORDER BY abs(COALESCE(unrealized_pnl, 0)) DESC),
           '[]'::jsonb),
           count(*), max(as_of)
      INTO v_rows, v_count, v_as_of
      FROM (SELECT * FROM arena.positions_current
             WHERE trader_id = v_trader_id
             LIMIT v_limit) pc;
    RETURN jsonb_build_object(
      'rows', v_rows, 'nextCursor', NULL,
      'asOf', COALESCE(v_as_of, now()), 'currency', v_currency);

  ELSIF p_kind = 'position_history' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'symbol', symbol, 'side', side, 'leverage', leverage,
             'size', size, 'entry_price', entry_price, 'exit_price', exit_price,
             'realized_pnl', realized_pnl, 'currency', currency,
             'opened_at', opened_at, 'closed_at', closed_at
           ) ORDER BY closed_at DESC, dedupe_hash DESC), '[]'::jsonb),
           count(*),
           (array_agg(closed_at ORDER BY closed_at ASC, dedupe_hash ASC))[1],
           (array_agg(dedupe_hash ORDER BY closed_at ASC, dedupe_hash ASC))[1]
      INTO v_rows, v_count, v_last_ts, v_last_hash
      FROM (SELECT * FROM arena.position_history
             WHERE trader_id = v_trader_id
               AND closed_at IS NOT NULL
               AND (v_cursor_ts IS NULL
                    OR (closed_at, dedupe_hash) < (v_cursor_ts, v_cursor_hash))
             ORDER BY closed_at DESC, dedupe_hash DESC
             LIMIT v_limit) ph;

  ELSIF p_kind = 'orders' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'ts', ts, 'kind', kind, 'symbol', symbol, 'side', side,
             'price', price, 'qty', qty, 'currency', currency
           ) ORDER BY ts DESC, dedupe_hash DESC), '[]'::jsonb),
           count(*),
           (array_agg(ts ORDER BY ts ASC, dedupe_hash ASC))[1],
           (array_agg(dedupe_hash ORDER BY ts ASC, dedupe_hash ASC))[1]
      INTO v_rows, v_count, v_last_ts, v_last_hash
      FROM (SELECT * FROM arena.order_records
             WHERE trader_id = v_trader_id
               AND (v_cursor_ts IS NULL
                    OR (ts, dedupe_hash) < (v_cursor_ts, v_cursor_hash))
             ORDER BY ts DESC, dedupe_hash DESC
             LIMIT v_limit) o;

  ELSE -- transfers
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'ts', ts, 'direction', direction, 'asset', asset,
             'amount', amount, 'currency', currency
           ) ORDER BY ts DESC, dedupe_hash DESC), '[]'::jsonb),
           count(*),
           (array_agg(ts ORDER BY ts ASC, dedupe_hash ASC))[1],
           (array_agg(dedupe_hash ORDER BY ts ASC, dedupe_hash ASC))[1]
      INTO v_rows, v_count, v_last_ts, v_last_hash
      FROM (SELECT * FROM arena.transfer_history
             WHERE trader_id = v_trader_id
               AND (v_cursor_ts IS NULL
                    OR (ts, dedupe_hash) < (v_cursor_ts, v_cursor_hash))
             ORDER BY ts DESC, dedupe_hash DESC
             LIMIT v_limit) tr;
  END IF;

  RETURN jsonb_build_object(
    'rows', v_rows,
    'nextCursor', CASE WHEN v_count = v_limit
                       THEN v_last_ts::text || '|' || v_last_hash
                       ELSE NULL END,
    'asOf', now(),
    'currency', v_currency);
END;
$$;

-- ============================================================
-- Copier aggregate (spec §6): counts, total PnL and a PnL distribution
-- histogram from the latest copier_records batch + trader_stats. The
-- copier_label column is NEVER referenced.
-- ============================================================
CREATE OR REPLACE FUNCTION public.arena_copier_aggregate(
  p_source text,
  p_trader text
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = arena, public
AS $$
  WITH t AS (
    SELECT t.id, s.copier_table_depth, s.currency
      FROM arena.traders t
      JOIN arena.sources s ON s.id = t.source_id
     WHERE s.slug = p_source AND t.exchange_trader_id = p_trader
  ), latest AS (
    SELECT max(cr.ts) AS ts FROM arena.copier_records cr, t WHERE cr.trader_id = t.id
  ), batch AS (
    SELECT cr.copier_pnl
      FROM arena.copier_records cr, t, latest
     WHERE cr.trader_id = t.id AND cr.ts = latest.ts
  ), stats AS (
    SELECT st.copier_count, st.copier_pnl
      FROM arena.trader_stats st, t
     WHERE st.trader_id = t.id
     ORDER BY st.as_of DESC
     LIMIT 1
  )
  SELECT jsonb_build_object(
    'copierCount', COALESCE((SELECT copier_count FROM stats),
                            NULLIF((SELECT count(*) FROM batch), 0)),
    'copierCountMax', NULL,
    'totalCopierPnl', COALESCE((SELECT copier_pnl FROM stats),
                               (SELECT sum(copier_pnl) FROM batch)),
    'currency', (SELECT currency FROM t),
    'depth', (SELECT copier_table_depth FROM t),
    'asOf', COALESCE((SELECT ts FROM latest), now()),
    'pnlDistribution', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('bucket', bucket, 'count', cnt) ORDER BY ord)
        FROM (
          SELECT bucket, ord, count(*) AS cnt
            FROM (
              SELECT CASE
                       WHEN copier_pnl < -1000 THEN '<-1000'
                       WHEN copier_pnl < 0     THEN '-1000~0'
                       WHEN copier_pnl < 1000  THEN '0~1000'
                       WHEN copier_pnl < 10000 THEN '1000~10000'
                       ELSE '>10000'
                     END AS bucket,
                     CASE
                       WHEN copier_pnl < -1000 THEN 0
                       WHEN copier_pnl < 0     THEN 1
                       WHEN copier_pnl < 1000  THEN 2
                       WHEN copier_pnl < 10000 THEN 3
                       ELSE 4
                     END AS ord
                FROM batch
               WHERE copier_pnl IS NOT NULL
            ) b
           GROUP BY bucket, ord
        ) g
    ), '[]'::jsonb)
  )
    FROM t;
$$;

GRANT EXECUTE ON FUNCTION public.arena_records_page(text, text, text, int, text, int)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arena_copier_aggregate(text, text)
  TO anon, authenticated;
