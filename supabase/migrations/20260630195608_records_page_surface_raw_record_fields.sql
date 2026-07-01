-- Migration: 20260630195608_records_page_surface_raw_record_fields.sql
-- Created: 2026-07-01T02:56:08Z
-- Description: arena_records_page now surfaces record-level fields that were
-- captured in `raw` jsonb but never returned (逐图核对 2026-06-30 found them
-- shown in the exchange UIs but invisible on our trader pages). ZERO ingest
-- change — the data is already stored in raw; we just read it out per-source
-- via COALESCE across the observed key spellings.
--   orders:           realized_pnl (Binance totalPnl / KuCoin realizedPnl /
--                     bitmart+gtrade pnl / gtrade pnl_net), notional value
--   positions:        margin, margin_mode (Cross/Isolated), notional, roe%
--                     (derived unrealized_pnl / margin)
--   position_history: max_open_interest, margin_mode, roi, closing_value
-- SECURITY DEFINER / STABLE preserved from the original (20260611000309).

-- Up

-- Safe jsonb-text → numeric: returns NULL for non-numeric strings (bools,
-- formatted labels) instead of raising, so a garbage raw value never breaks the RPC.
CREATE OR REPLACE FUNCTION arena.jnum(t text) RETURNS numeric
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN t ~ '^-?[0-9]+(\.[0-9]+)?$' THEN t::numeric END;
$$;

-- Margin mode label from the per-source raw shape (Binance isolated bool,
-- others marginType text). NULL when neither present.
CREATE OR REPLACE FUNCTION arena.jmargin_mode(r jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(
    NULLIF(lower(r->>'marginType'), ''),
    CASE WHEN r->>'isolated' = 'true' THEN 'isolated'
         WHEN r->>'isolated' = 'false' THEN 'cross' END
  );
$$;

CREATE OR REPLACE FUNCTION public.arena_records_page(
  p_source text,
  p_trader text,
  p_kind text,
  p_tf int DEFAULT NULL,
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
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'symbol', symbol, 'side', side, 'leverage', leverage,
             'size', size, 'entry_price', entry_price,
             'mark_price', mark_price, 'unrealized_pnl', unrealized_pnl,
             -- 逐图核对: margin / mode / notional (raw), roe% derived
             'margin', COALESCE(arena.jnum(raw->>'collateral'),
                                arena.jnum(raw->>'isolatedWallet'),
                                arena.jnum(raw->>'marginBalance'),
                                arena.jnum(raw->>'margin')),
             'margin_mode', arena.jmargin_mode(raw),
             'notional', COALESCE(arena.jnum(raw->>'notionalValue'),
                                  arena.jnum(raw->>'notional')),
             'roe', CASE WHEN COALESCE(arena.jnum(raw->>'collateral'),
                                       arena.jnum(raw->>'isolatedWallet'),
                                       arena.jnum(raw->>'marginBalance')) > 0
                         THEN round(unrealized_pnl / COALESCE(arena.jnum(raw->>'collateral'),
                                       arena.jnum(raw->>'isolatedWallet'),
                                       arena.jnum(raw->>'marginBalance')) * 100, 2) END,
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
             -- 逐图核对: max open interest / mode / roi / closing value (raw)
             'max_open_interest', COALESCE(arena.jnum(raw->>'maxOpenInterest'),
                                           arena.jnum(raw->>'max_open_interest')),
             'margin_mode', arena.jmargin_mode(raw),
             'roi', COALESCE(arena.jnum(raw->>'roi'), arena.jnum(raw->>'roiRate')),
             'closing_value', COALESCE(arena.jnum(raw->>'closingValue'),
                                       arena.jnum(raw->>'closeValue')),
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
             'price', price, 'qty', qty, 'currency', currency,
             -- 逐图核对: realized pnl + notional value (raw, per-source spellings)
             'realized_pnl', COALESCE(arena.jnum(raw->>'totalPnl'),
                                      arena.jnum(raw->>'realizedPnl'),
                                      arena.jnum(raw->>'pnl'),
                                      arena.jnum(raw->>'pnl_net')),
             'notional', COALESCE(arena.jnum(raw->>'totalAmount'),
                                  arena.jnum(raw->>'notionalValue'),
                                  arena.jnum(raw->>'indexValue'))
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
