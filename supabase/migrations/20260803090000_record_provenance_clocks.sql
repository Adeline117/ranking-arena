-- Migration: 20260803090000_record_provenance_clocks.sql
-- Description: Stop record readers from presenting request time, event time,
-- or a mixed scraper timestamp as data freshness. Keep source, observation,
-- and publication clocks separate; unknown evidence remains SQL/JSON null.
-- The deprecated asOf key remains nullable during the rolling web cutover.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('20260803-record-provenance-clocks', 0)
);

LOCK TABLE
  arena.exchanges,
  arena.sources,
  arena.traders,
  arena.positions_current,
  arena.position_history,
  arena.order_records,
  arena.transfer_history,
  arena.trader_stats,
  arena.copier_records
IN ACCESS SHARE MODE;

DO $preflight$
DECLARE
  v_records oid := pg_catalog.to_regprocedure(
    'public.arena_records_page(text,text,text,integer,text,integer)'
  );
  v_copier oid := pg_catalog.to_regprocedure(
    'public.arena_copier_aggregate(text,text)'
  );
  v_records_row pg_catalog.pg_proc%ROWTYPE;
  v_copier_row pg_catalog.pg_proc%ROWTYPE;
  v_records_language text;
  v_copier_language text;
  v_records_hash text;
  v_copier_hash text;
  v_named_count integer;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'record provenance clocks require PostgreSQL 14 or newer';
  END IF;

  IF pg_catalog.to_regclass('arena.exchanges') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass('arena.positions_current') IS NULL
     OR pg_catalog.to_regclass('arena.position_history') IS NULL
     OR pg_catalog.to_regclass('arena.order_records') IS NULL
     OR pg_catalog.to_regclass('arena.transfer_history') IS NULL
     OR pg_catalog.to_regclass('arena.trader_stats') IS NULL
     OR pg_catalog.to_regclass('arena.copier_records') IS NULL
     OR pg_catalog.to_regprocedure('arena.jnum(text)') IS NULL
     OR pg_catalog.to_regprocedure('arena.jmargin_mode(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'record provenance substrate is incomplete';
  END IF;

  IF v_records IS NULL OR v_copier IS NULL THEN
    RAISE EXCEPTION 'record provenance reader is missing';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'record provenance runtime roles are missing';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_named_count
  FROM pg_catalog.pg_proc AS function_row
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = function_row.pronamespace
  WHERE namespace_row.nspname = 'public'
    AND function_row.proname IN ('arena_records_page', 'arena_copier_aggregate');
  IF v_named_count <> 2 THEN
    RAISE EXCEPTION 'record provenance reader overload set drifted';
  END IF;

  SELECT function_row.* INTO STRICT v_records_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_records;
  SELECT function_row.* INTO STRICT v_copier_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_copier;
  SELECT language_row.lanname INTO STRICT v_records_language
  FROM pg_catalog.pg_language AS language_row
  WHERE language_row.oid = v_records_row.prolang;
  SELECT language_row.lanname INTO STRICT v_copier_language
  FROM pg_catalog.pg_language AS language_row
  WHERE language_row.oid = v_copier_row.prolang;

  v_records_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_records_row.prosrc, 'UTF8')), 'hex'
  );
  v_copier_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_copier_row.prosrc, 'UTF8')), 'hex'
  );

  IF v_records_row.prokind <> 'f'
     OR v_records_row.proowner <> 'postgres'::pg_catalog.regrole
     OR NOT v_records_row.prosecdef
     OR v_records_row.provolatile <> 's'
     OR v_records_row.proparallel <> 'u'
     OR v_records_row.proretset
     OR v_records_row.prorettype <> 'pg_catalog.jsonb'::pg_catalog.regtype
     OR v_records_row.proisstrict
     OR v_records_row.proleakproof
     OR v_records_language <> 'plpgsql'
     OR v_records_row.proargnames IS DISTINCT FROM
          ARRAY['p_source','p_trader','p_kind','p_tf','p_cursor','p_limit']::pg_catalog.text[]
     OR v_records_row.pronargdefaults <> 3
     OR NOT (
       (
         v_records_hash =
           '07b2356e65a8280af27bc7d524130293115b1b4a4d56a8f140a721472521ee31'
         AND v_records_row.proconfig =
           ARRAY['search_path=arena, public']::pg_catalog.text[]
       )
       OR (
         v_records_hash =
           '85ab861ceef850c6d19154c3c519d44326780cccfc6773002a108a75941388b3'
         AND v_records_row.proconfig =
           ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
       )
     ) THEN
    RAISE EXCEPTION 'records page callable contract drifted: %', v_records_hash;
  END IF;

  IF v_copier_row.prokind <> 'f'
     OR v_copier_row.proowner <> 'postgres'::pg_catalog.regrole
     OR NOT v_copier_row.prosecdef
     OR v_copier_row.provolatile <> 's'
     OR v_copier_row.proparallel <> 'u'
     OR v_copier_row.proretset
     OR v_copier_row.prorettype <> 'pg_catalog.jsonb'::pg_catalog.regtype
     OR v_copier_row.proisstrict
     OR v_copier_row.proleakproof
     OR v_copier_language <> 'sql'
     OR v_copier_row.proargnames IS DISTINCT FROM
          ARRAY['p_source','p_trader']::pg_catalog.text[]
     OR v_copier_row.pronargdefaults <> 0
     OR v_copier_row.proconfig IS DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
     OR v_copier_hash NOT IN (
       '267bac4cf6a3c9f51e2a2b3f61aa29f22549bc39f69c20c59f438a3663ab68de',
       '32879cff833594969c2cf3c09b7fdea921a624338b03b2c9c4f717f8bfbf7cf4'
     ) THEN
    RAISE EXCEPTION 'copier aggregate callable contract drifted: %', v_copier_hash;
  END IF;
END
$preflight$;

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
SET search_path = pg_catalog, pg_temp
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
  v_source_as_of timestamptz;
  v_published_at timestamptz;
  v_source_meta jsonb;
  v_positions_delay_hours numeric;
BEGIN
  IF p_kind = 'copiers' THEN
    RAISE EXCEPTION 'copier records are aggregate-only; use arena_copier_aggregate';
  END IF;
  IF p_kind NOT IN ('positions', 'position_history', 'orders', 'transfers') THEN
    RAISE EXCEPTION 'unknown record kind: %', p_kind;
  END IF;

  SELECT t.id, s.currency, s.meta
    INTO v_trader_id, v_currency, v_source_meta
    FROM arena.traders t
    JOIN arena.sources s ON s.id = t.source_id
   WHERE s.slug = p_source AND t.exchange_trader_id = p_trader;
  IF v_trader_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Only an explicit numeric, non-negative source contract makes the stored
  -- effective time safe to expose as source time. Older Tier-D writers used
  -- observation time as the fallback `as_of` when this key was absent.
  IF pg_catalog.jsonb_typeof(v_source_meta->'positions_delay_hours') = 'number' THEN
    v_positions_delay_hours :=
      (v_source_meta->>'positions_delay_hours')::pg_catalog.numeric;
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
           count(*), max(as_of), max(snapshot_at)
      INTO v_rows, v_count, v_as_of, v_published_at
      FROM (SELECT * FROM arena.positions_current
             WHERE trader_id = v_trader_id
             LIMIT v_limit) pc;
    v_source_as_of := CASE
      WHEN v_positions_delay_hours >= 0 THEN v_as_of
      ELSE NULL
    END;
    RETURN jsonb_build_object(
      'rows', v_rows,
      'nextCursor', NULL,
      -- Deprecated compatibility alias. It is nullable and never a request clock.
      'asOf', v_source_as_of,
      'sourceAsOf', v_source_as_of,
      'observedAt', NULL::pg_catalog.timestamptz,
      'publishedAt', v_published_at,
      'currency', v_currency);

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
    -- Event time is row identity, not evidence of capture/publication time.
    'asOf', NULL::pg_catalog.timestamptz,
    'sourceAsOf', NULL::pg_catalog.timestamptz,
    'observedAt', NULL::pg_catalog.timestamptz,
    'publishedAt', NULL::pg_catalog.timestamptz,
    'currency', v_currency);
END;
$$;

CREATE OR REPLACE FUNCTION public.arena_copier_aggregate(
  p_source text,
  p_trader text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH resolved AS (
    SELECT
      trader.id,
      source_row.copier_table_depth,
      source_row.currency,
      (
        source_row.slug = ANY (
          ARRAY[
            'bitget_bots_futures',
            'bitget_bots_spot'
          ]::pg_catalog.text[]
        )
        OR source_row.adapter_slug = 'bitget_bots'
        OR (
          exchange_row.slug = 'bitget'
          AND (
            trader.trader_kind = 'bot'
            OR source_row.trader_kind_scope = 'bot'
          )
        )
      ) AS is_bitget_bot,
      (
        trader.trader_kind = 'bot'
        AND exchange_row.slug = 'bitget'
        AND source_row.adapter_slug = 'bitget_bots'
        AND source_row.trader_kind_scope = 'bot'
        AND source_row.status = 'active'
        AND source_row.serving_mode = 'serving'
        AND source_row.currency = 'USDT'
        AND source_row.timeframes_native = ARRAY[30]::integer[]
        AND source_row.timeframes_derived = ARRAY[]::integer[]
        AND source_row.page_size = 20
        AND source_row.pagination_kind = 'numeric'
        AND source_row.copier_table_depth = 'top10'
        AND (
          (
            source_row.slug = 'bitget_bots_futures'
            AND source_row.product_type = 'futures'
            AND source_row.meta->'boards' =
              '["futures_grid", "futures_martingale"]'::pg_catalog.jsonb
          )
          OR (
            source_row.slug = 'bitget_bots_spot'
            AND source_row.product_type = 'spot'
            AND source_row.meta->'boards' =
              '["spot_grid", "spot_martingale"]'::pg_catalog.jsonb
          )
        )
        AND COALESCE(
          NULLIF(
            pg_catalog.btrim(
              source_row.meta->>'legacy_platform'
            ),
            ''
          ),
          source_row.slug
        ) = source_row.slug
      ) AS canonical_bitget_bot
    FROM arena.traders AS trader
    JOIN arena.sources AS source_row
      ON source_row.id = trader.source_id
    JOIN arena.exchanges AS exchange_row
      ON exchange_row.id = source_row.exchange_id
    WHERE source_row.slug = p_source
      AND trader.exchange_trader_id = p_trader
      AND source_row.status = 'active'
      AND source_row.serving_mode = 'serving'
  ), latest_candidate AS (
    SELECT pg_catalog.max(copier.ts) AS ts
    FROM arena.copier_records AS copier
    CROSS JOIN resolved
    WHERE copier.trader_id = resolved.id
      AND (
        NOT resolved.is_bitget_bot
        OR resolved.canonical_bitget_bot
      )
  ), batch_candidate AS (
    SELECT copier.copier_pnl
    FROM arena.copier_records AS copier
    CROSS JOIN resolved
    CROSS JOIN latest_candidate
    WHERE copier.trader_id = resolved.id
      AND copier.ts = latest_candidate.ts
      AND (
        NOT resolved.is_bitget_bot
        OR resolved.canonical_bitget_bot
      )
  ), batch_contract AS (
    SELECT pg_catalog.count(*) AS row_count
    FROM batch_candidate
  ), latest AS (
    SELECT latest_candidate.ts
    FROM latest_candidate
    CROSS JOIN resolved
    CROSS JOIN batch_contract
    WHERE latest_candidate.ts IS NOT NULL
      AND (
        NOT resolved.is_bitget_bot
        OR (
          resolved.canonical_bitget_bot
          AND batch_contract.row_count BETWEEN 1 AND 10
        )
      )
  ), batch AS (
    SELECT batch_candidate.copier_pnl
    FROM batch_candidate
    CROSS JOIN resolved
    CROSS JOIN batch_contract
    WHERE NOT resolved.is_bitget_bot
       OR (
         resolved.canonical_bitget_bot
         AND batch_contract.row_count BETWEEN 1 AND 10
       )
  ), legacy_stats AS (
    SELECT stats.copier_count, stats.copier_pnl, stats.as_of
    FROM arena.trader_stats AS stats
    CROSS JOIN resolved
    WHERE stats.trader_id = resolved.id
      AND NOT resolved.is_bitget_bot
    ORDER BY stats.as_of DESC
    LIMIT 1
  ), trusted_bot_stats AS (
    SELECT stats.copier_count, stats.copier_pnl, stats.as_of
    FROM arena.trader_stats AS stats
    CROSS JOIN resolved
    WHERE stats.trader_id = resolved.id
      AND resolved.is_bitget_bot
      AND resolved.canonical_bitget_bot
      AND stats.timeframe = 0
      AND pg_catalog.jsonb_typeof(
        stats.extras -> '_arena_profile_publication_epoch_ms'
      ) = 'number'
      AND (
        stats.extras ->> '_arena_profile_publication_epoch_ms'
      )::pg_catalog.numeric =
        EXTRACT(EPOCH FROM stats.as_of) * 1000
  )
  SELECT pg_catalog.jsonb_build_object(
    'copierCount', CASE
      WHEN resolved.is_bitget_bot
      THEN (SELECT stats.copier_count FROM trusted_bot_stats AS stats)
      ELSE COALESCE(
        (SELECT stats.copier_count FROM legacy_stats AS stats),
        NULLIF((SELECT pg_catalog.count(*) FROM batch), 0)
      )
    END,
    'copierCountMax', NULL,
    'totalCopierPnl', CASE
      WHEN resolved.is_bitget_bot
      THEN (SELECT stats.copier_pnl FROM trusted_bot_stats AS stats)
      ELSE COALESCE(
        (SELECT stats.copier_pnl FROM legacy_stats AS stats),
        (SELECT pg_catalog.sum(batch.copier_pnl) FROM batch)
      )
    END,
    'currency', resolved.currency,
    'depth', resolved.copier_table_depth,
    -- Copier row/profile clocks have mixed upstream and scrape semantics.
    -- Keep every provenance clock unknown until an atomic receipt binds them.
    'asOf', NULL::pg_catalog.timestamptz,
    'sourceAsOf', NULL::pg_catalog.timestamptz,
    'observedAt', NULL::pg_catalog.timestamptz,
    'publishedAt', NULL::pg_catalog.timestamptz,
    'pnlDistribution', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'bucket', distribution.bucket,
            'count', distribution.count
          )
          ORDER BY distribution.ord
        )
        FROM (
          SELECT bucketed.bucket, bucketed.ord,
                 pg_catalog.count(*) AS count
          FROM (
            SELECT
              CASE
                WHEN batch.copier_pnl < -1000 THEN '<-1000'
                WHEN batch.copier_pnl < 0 THEN '-1000~0'
                WHEN batch.copier_pnl < 1000 THEN '0~1000'
                WHEN batch.copier_pnl < 10000 THEN '1000~10000'
                ELSE '>10000'
              END AS bucket,
              CASE
                WHEN batch.copier_pnl < -1000 THEN 0
                WHEN batch.copier_pnl < 0 THEN 1
                WHEN batch.copier_pnl < 1000 THEN 2
                WHEN batch.copier_pnl < 10000 THEN 3
                ELSE 4
              END AS ord
            FROM batch
            WHERE batch.copier_pnl IS NOT NULL
          ) AS bucketed
          GROUP BY bucketed.bucket, bucketed.ord
        ) AS distribution
      ), '[]'::pg_catalog.jsonb)
  )
  FROM resolved
  WHERE NOT resolved.is_bitget_bot
     OR (
       resolved.canonical_bitget_bot
       AND (
         (SELECT latest.ts FROM latest) IS NOT NULL
         OR (SELECT stats.as_of FROM trusted_bot_stats AS stats) IS NOT NULL
       )
     );
$function$;

ALTER FUNCTION public.arena_records_page(text, text, text, int, text, int)
  OWNER TO postgres;
ALTER FUNCTION public.arena_copier_aggregate(text, text)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.arena_records_page(text, text, text, int, text, int)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.arena_copier_aggregate(text, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.arena_records_page(text, text, text, int, text, int)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_copier_aggregate(text, text)
  TO anon, authenticated, service_role;

DO $postflight$
DECLARE
  v_records oid := pg_catalog.to_regprocedure(
    'public.arena_records_page(text,text,text,integer,text,integer)'
  );
  v_copier oid := pg_catalog.to_regprocedure(
    'public.arena_copier_aggregate(text,text)'
  );
  v_records_row pg_catalog.pg_proc%ROWTYPE;
  v_copier_row pg_catalog.pg_proc%ROWTYPE;
  v_records_language text;
  v_copier_language text;
  v_records_hash text;
  v_copier_hash text;
BEGIN
  SELECT function_row.* INTO STRICT v_records_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_records;
  SELECT function_row.* INTO STRICT v_copier_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_copier;
  SELECT language_row.lanname INTO STRICT v_records_language
  FROM pg_catalog.pg_language AS language_row
  WHERE language_row.oid = v_records_row.prolang;
  SELECT language_row.lanname INTO STRICT v_copier_language
  FROM pg_catalog.pg_language AS language_row
  WHERE language_row.oid = v_copier_row.prolang;

  v_records_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_records_row.prosrc, 'UTF8')), 'hex'
  );
  v_copier_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_copier_row.prosrc, 'UTF8')), 'hex'
  );

  IF v_records_row.prokind <> 'f'
     OR v_records_row.proowner <> 'postgres'::pg_catalog.regrole
     OR NOT v_records_row.prosecdef
     OR v_records_row.provolatile <> 's'
     OR v_records_row.proparallel <> 'u'
     OR v_records_row.proretset
     OR v_records_row.prorettype <> 'pg_catalog.jsonb'::pg_catalog.regtype
     OR v_records_row.proisstrict
     OR v_records_row.proleakproof
     OR v_records_language <> 'plpgsql'
     OR v_records_row.proargnames IS DISTINCT FROM
          ARRAY['p_source','p_trader','p_kind','p_tf','p_cursor','p_limit']::pg_catalog.text[]
     OR v_records_row.pronargdefaults <> 3
     OR v_records_row.proconfig IS DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
     OR v_records_hash <>
          '85ab861ceef850c6d19154c3c519d44326780cccfc6773002a108a75941388b3' THEN
    RAISE EXCEPTION 'records page provenance postflight failed: %', v_records_hash;
  END IF;

  IF v_copier_row.prokind <> 'f'
     OR v_copier_row.proowner <> 'postgres'::pg_catalog.regrole
     OR NOT v_copier_row.prosecdef
     OR v_copier_row.provolatile <> 's'
     OR v_copier_row.proparallel <> 'u'
     OR v_copier_row.proretset
     OR v_copier_row.prorettype <> 'pg_catalog.jsonb'::pg_catalog.regtype
     OR v_copier_row.proisstrict
     OR v_copier_row.proleakproof
     OR v_copier_language <> 'sql'
     OR v_copier_row.proargnames IS DISTINCT FROM
          ARRAY['p_source','p_trader']::pg_catalog.text[]
     OR v_copier_row.pronargdefaults <> 0
     OR v_copier_row.proconfig IS DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
     OR v_copier_hash <>
          '32879cff833594969c2cf3c09b7fdea921a624338b03b2c9c4f717f8bfbf7cf4' THEN
    RAISE EXCEPTION 'copier aggregate provenance postflight failed: %', v_copier_hash;
  END IF;

  IF NOT pg_catalog.has_function_privilege('anon', v_records, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', v_records, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_records, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('anon', v_copier, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', v_copier, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_copier, 'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM (
         SELECT v_records AS function_oid, v_records_row.proowner AS function_owner,
                v_records_row.proacl AS function_acl
         UNION ALL
         SELECT v_copier, v_copier_row.proowner, v_copier_row.proacl
       ) AS callable
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(callable.function_acl, pg_catalog.acldefault('f', callable.function_owner))
       ) AS privilege
       WHERE privilege.privilege_type = 'EXECUTE'
         AND (
           privilege.is_grantable
           OR privilege.grantee = 0::oid
           OR privilege.grantee <> ALL (
             ARRAY[
               callable.function_owner,
               'anon'::pg_catalog.regrole::oid,
               'authenticated'::pg_catalog.regrole::oid,
               'service_role'::pg_catalog.regrole::oid
             ]::oid[]
           )
         )
     )
     OR EXISTS (
       SELECT 1
       FROM (
         SELECT v_records AS function_oid, v_records_row.proowner AS function_owner,
                v_records_row.proacl AS function_acl
         UNION ALL
         SELECT v_copier, v_copier_row.proowner, v_copier_row.proacl
       ) AS callable
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(callable.function_acl, pg_catalog.acldefault('f', callable.function_owner))
       ) AS privilege
       WHERE privilege.privilege_type = 'EXECUTE'
       GROUP BY callable.function_oid
       HAVING pg_catalog.count(*) <> 4
     ) THEN
    RAISE EXCEPTION 'record provenance function ACL drifted';
  END IF;
END
$postflight$;

COMMENT ON FUNCTION public.arena_records_page(text, text, text, int, text, int) IS
  'Record page reader with separate nullable source, observation, and publication clocks. Event surfaces remain unknown until an atomic publication receipt is bound.';
COMMENT ON FUNCTION public.arena_copier_aggregate(text, text) IS
  'Aggregate-only copier reader. Metrics retain strict Bitget bot authority; provenance remains unknown until an atomic publication receipt is bound.';

NOTIFY pgrst, 'reload schema';

COMMIT;
