-- Migration: 20260728122000_bitget_bots_canonical_timeframe.sql
-- Created: 2026-07-28T12:20:00Z
-- Description: Bitget's bot leaderboard is one timeframe-less cumulative
--   board exposed through two numeric POST partitions per product. Converge
--   its active source rows from the historical 7/30/90 + infinite-scroll
--   seed to one canonical 30-day Tier-A trigger with truthful pagination,
--   and keep that production contract fail-closed for future changes.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Freeze registry writers before the first source snapshot. SHARE remains
-- compatible with publication's source FOR SHARE read, so in-flight publishers
-- can finish while no concurrent INSERT/UPDATE/DELETE can cross convergence.
LOCK TABLE arena.sources IN SHARE MODE;

DO $foundations$
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.exchanges') IS NULL THEN
    RAISE EXCEPTION 'Bitget bot canonical timeframe foundations are missing';
  END IF;
END
$foundations$;

-- Drain any publication already holding the per-source lock and serialize the
-- registry change with current publication critical sections. The procedural
-- loop makes lock acquisition order explicit rather than relying on target-list
-- evaluation order around a SQL ORDER BY.
DO $publication_locks$
DECLARE
  v_source_id smallint;
BEGIN
  FOR v_source_id IN
    SELECT source.id
      FROM arena.sources AS source
     WHERE source.slug = ANY (
       ARRAY['bitget_bots_futures', 'bitget_bots_spot']::text[]
     )
     ORDER BY source.id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'arena.publish-board-series:' || v_source_id::text,
        0
      )
    );
  END LOOP;
END
$publication_locks$;

-- Both target publication lanes are now drained and held by this transaction;
-- upgrade before the registry rewrite and constraint replacement.
LOCK TABLE arena.sources IN SHARE ROW EXCLUSIVE MODE;

DO $converge$
DECLARE
  v_bitget_exchange_id smallint;
  v_expected_updates integer;
  v_source_count integer;
  v_updated integer;
BEGIN
  SELECT exchange.id
    INTO STRICT v_bitget_exchange_id
    FROM arena.exchanges AS exchange
   WHERE exchange.slug = 'bitget'
   FOR SHARE;

  SELECT pg_catalog.count(*)::integer
    INTO v_source_count
    FROM arena.sources AS source
   WHERE source.slug = ANY (
     ARRAY['bitget_bots_futures', 'bitget_bots_spot']::text[]
   );

  IF v_source_count <> 2 THEN
    RAISE EXCEPTION 'expected exactly two Bitget bot source rows, found %', v_source_count;
  END IF;

  -- The migration may converge only the reviewed historical seed or replay
  -- its already-converged state. Any other source identity/window drift needs
  -- an explicit follow-up migration rather than a broad corrective UPDATE.
  IF EXISTS (
    SELECT 1
      FROM (
        VALUES
          ('bitget_bots_futures'::text, 'futures'::text),
          ('bitget_bots_spot'::text, 'spot'::text)
      ) AS target(slug, product_type)
      LEFT JOIN arena.sources AS source ON source.slug = target.slug
     WHERE source.id IS NULL
        OR source.exchange_id IS DISTINCT FROM v_bitget_exchange_id
        OR source.product_type IS DISTINCT FROM target.product_type
        OR source.adapter_slug IS DISTINCT FROM 'bitget_bots'
        OR source.trader_kind_scope IS DISTINCT FROM 'bot'
        OR source.status IS DISTINCT FROM 'active'
        OR source.serving_mode IS DISTINCT FROM 'serving'
        OR source.currency IS DISTINCT FROM 'USDT'
        OR source.timeframes_derived IS DISTINCT FROM ARRAY[]::integer[]
        OR source.meta->'boards' IS DISTINCT FROM CASE target.slug
          WHEN 'bitget_bots_futures' THEN
            '["futures_grid", "futures_martingale"]'::jsonb
          ELSE '["spot_grid", "spot_martingale"]'::jsonb
        END
        OR NOT (
          (
            source.timeframes_native IS NOT DISTINCT FROM ARRAY[7, 30, 90]::integer[]
            AND source.page_size IS NULL
            AND source.pagination_kind IS NOT DISTINCT FROM 'infinite_scroll'
          )
          OR (
            source.timeframes_native IS NOT DISTINCT FROM ARRAY[30]::integer[]
            AND source.page_size IS NOT DISTINCT FROM 20
            AND source.pagination_kind IS NOT DISTINCT FROM 'numeric'
          )
        )
  ) THEN
    RAISE EXCEPTION 'Bitget bot source registry drifted from the reviewed board contract';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM arena.sources AS source
     WHERE source.status = 'active'
       AND source.adapter_slug = 'bitget_bots'
       AND source.slug <> ALL (
         ARRAY['bitget_bots_futures', 'bitget_bots_spot']::text[]
       )
  ) THEN
    RAISE EXCEPTION 'unexpected active Bitget bot source requires an explicit canonical timeframe review';
  END IF;

  SELECT pg_catalog.count(*) FILTER (
           WHERE source.timeframes_native IS DISTINCT FROM ARRAY[30]::integer[]
              OR source.page_size IS DISTINCT FROM 20
              OR source.pagination_kind IS DISTINCT FROM 'numeric'
         )::integer
    INTO v_expected_updates
    FROM arena.sources AS source
   WHERE source.slug = ANY (
     ARRAY['bitget_bots_futures', 'bitget_bots_spot']::text[]
   );

  UPDATE arena.sources AS source
     SET timeframes_native = ARRAY[30]::integer[],
         page_size = 20,
         pagination_kind = 'numeric'
    FROM (
      VALUES
        ('bitget_bots_futures'::text, 'futures'::text),
        ('bitget_bots_spot'::text, 'spot'::text)
    ) AS target(slug, product_type)
   WHERE source.slug = target.slug
     AND source.product_type = target.product_type
     AND (
       source.timeframes_native IS DISTINCT FROM ARRAY[30]::integer[]
       OR source.page_size IS DISTINCT FROM 20
       OR source.pagination_kind IS DISTINCT FROM 'numeric'
     );

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> v_expected_updates THEN
    RAISE EXCEPTION 'Bitget bot canonical timeframe updated % of % expected rows',
      v_updated,
      v_expected_updates;
  END IF;
END
$converge$;

-- Recreate under the source-table lock so replay is convergent and no session
-- can observe a gap. Active target slugs must retain the reviewed identity,
-- while any future active bitget_bots/bot source requires a forward migration.
ALTER TABLE arena.sources
  DROP CONSTRAINT IF EXISTS sources_active_bitget_bots_canonical_board_contract;

ALTER TABLE arena.sources
  ADD CONSTRAINT sources_active_bitget_bots_canonical_board_contract
  CHECK (
    status <> 'active'
    OR (
      (
        slug <> ALL (
          ARRAY['bitget_bots_futures', 'bitget_bots_spot']::text[]
        )
        AND adapter_slug IS DISTINCT FROM 'bitget_bots'
      )
      OR (
        adapter_slug = 'bitget_bots'
        AND trader_kind_scope = 'bot'
        AND serving_mode = 'serving'
        AND currency = 'USDT'
        AND timeframes_native IS NOT DISTINCT FROM ARRAY[30]::integer[]
        AND timeframes_derived IS NOT DISTINCT FROM ARRAY[]::integer[]
        AND page_size IS NOT DISTINCT FROM 20
        AND pagination_kind IS NOT DISTINCT FROM 'numeric'
        AND (
          (
            slug = 'bitget_bots_futures'
            AND product_type = 'futures'
            AND meta->'boards' IS NOT DISTINCT FROM
              '["futures_grid", "futures_martingale"]'::jsonb
          )
          OR (
            slug = 'bitget_bots_spot'
            AND product_type = 'spot'
            AND meta->'boards' IS NOT DISTINCT FROM
              '["spot_grid", "spot_martingale"]'::jsonb
          )
        )
      )
    )
  ) NOT VALID;

ALTER TABLE arena.sources
  VALIDATE CONSTRAINT sources_active_bitget_bots_canonical_board_contract;

DO $postflight$
DECLARE
  v_constraint_count integer;
  v_exact_sources integer;
BEGIN
  SELECT pg_catalog.count(*)::integer
    INTO v_exact_sources
    FROM (
      VALUES
        ('bitget_bots_futures'::text, 'futures'::text),
        ('bitget_bots_spot'::text, 'spot'::text)
    ) AS target(slug, product_type)
    JOIN arena.sources AS source
      ON source.slug = target.slug
     AND source.product_type = target.product_type
    JOIN arena.exchanges AS exchange
      ON exchange.id = source.exchange_id
   WHERE exchange.slug = 'bitget'
     AND source.adapter_slug = 'bitget_bots'
     AND source.trader_kind_scope = 'bot'
     AND source.status = 'active'
     AND source.serving_mode = 'serving'
     AND source.currency = 'USDT'
     AND source.timeframes_native = ARRAY[30]::integer[]
     AND source.timeframes_derived = ARRAY[]::integer[]
     AND source.page_size = 20
     AND source.pagination_kind = 'numeric'
     AND source.meta->'boards' = CASE target.slug
       WHEN 'bitget_bots_futures' THEN
         '["futures_grid", "futures_martingale"]'::jsonb
       ELSE '["spot_grid", "spot_martingale"]'::jsonb
     END;

  SELECT pg_catalog.count(*)::integer
    INTO v_constraint_count
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = 'arena.sources'::pg_catalog.regclass
     AND constraint_row.conname =
       'sources_active_bitget_bots_canonical_board_contract'
     AND constraint_row.contype = 'c'
     AND constraint_row.convalidated;

  IF v_exact_sources <> 2 OR v_constraint_count <> 1 THEN
    RAISE EXCEPTION 'Bitget bot canonical timeframe postflight failed';
  END IF;
END
$postflight$;

COMMIT;
