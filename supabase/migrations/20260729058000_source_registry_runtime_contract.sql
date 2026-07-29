-- Migration: 20260729058000_source_registry_runtime_contract.sql
-- Description: Make the reviewed adapter/source runtime contract replayable.
--
-- Several source rows were corrected directly in production while their
-- historical seed remained unchanged. A fresh database or a later accidental
-- edit could therefore schedule an unsupported native window, run a geo-bound
-- adapter in the wrong region, or label literal USD as USDT. This migration
-- converges only fields that are attested by adapter code, fixtures, and the
-- checked-in field-coverage evidence. It never activates a source and never
-- changes serving_mode.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '45s';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'arena.sources:adapter-runtime-contract:v1',
    0
  )
);

DO $foundations$
DECLARE
  v_sources pg_catalog.regclass := pg_catalog.to_regclass('arena.sources');
  v_exchanges pg_catalog.regclass := pg_catalog.to_regclass('arena.exchanges');
BEGIN
  IF v_sources IS NULL OR v_exchanges IS NULL THEN
    RAISE EXCEPTION 'source registry runtime contract foundations are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation_row
    WHERE relation_row.oid IN (v_sources, v_exchanges)
      AND (
        relation_row.relkind <> 'r'
        OR relation_row.relpersistence <> 'p'
        OR relation_row.relispartition
      )
  ) THEN
    RAISE EXCEPTION 'source registry runtime contract requires ordinary permanent tables';
  END IF;
END
$foundations$;

-- Freeze registry writers while publications already inside their source
-- critical sections drain. SHARE remains compatible with publication reads.
LOCK TABLE arena.sources IN SHARE MODE;

DO $publication_locks$
DECLARE
  v_source_id smallint;
BEGIN
  FOR v_source_id IN
    SELECT source.id
    FROM arena.sources AS source
    WHERE source.slug = ANY (
      ARRAY[
        'bitfinex',
        'bitmart_futures',
        'hyperliquid',
        'kucoin_futures',
        'okx_futures',
        'okx_spot',
        'toobit_futures'
      ]::text[]
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

LOCK TABLE arena.sources IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_source_count integer;
BEGIN
  SELECT pg_catalog.count(*)::integer
  INTO v_source_count
  FROM arena.sources AS source
  WHERE source.slug = ANY (
    ARRAY[
      'bitfinex',
      'bitmart_futures',
      'hyperliquid',
      'kucoin_futures',
      'okx_futures',
      'okx_spot',
      'toobit_futures'
    ]::text[]
  );

  IF v_source_count <> 7 THEN
    RAISE EXCEPTION 'expected exactly seven reviewed source rows, found %', v_source_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('bitfinex'::text, 'bitfinex'::text, 'bitfinex'::text, 'futures'::text, 'human'::text),
        ('bitmart_futures', 'bitmart', 'bitmart', 'futures', 'mixed'),
        ('hyperliquid', 'hyperliquid', 'hyperliquid', 'onchain', 'human'),
        ('kucoin_futures', 'kucoin', 'kucoin', 'futures', 'mixed'),
        ('okx_futures', 'okx', 'okx', 'futures', 'human'),
        ('okx_spot', 'okx', 'okx', 'spot', 'human'),
        ('toobit_futures', 'toobit', 'toobit', 'futures', 'human')
    ) AS target(slug, adapter_slug, exchange_slug, product_type, trader_kind_scope)
    LEFT JOIN arena.sources AS source
      ON source.slug = target.slug
    LEFT JOIN arena.exchanges AS exchange
      ON exchange.id = source.exchange_id
    WHERE source.id IS NULL
      OR source.adapter_slug IS DISTINCT FROM target.adapter_slug
      OR exchange.slug IS DISTINCT FROM target.exchange_slug
      OR source.product_type IS DISTINCT FROM target.product_type
      OR source.trader_kind_scope IS DISTINCT FROM target.trader_kind_scope
      OR pg_catalog.jsonb_typeof(source.meta) IS DISTINCT FROM 'object'
  ) THEN
    RAISE EXCEPTION 'reviewed source identity drifted; refusing broad registry repair';
  END IF;
END
$preflight$;

-- Canonical board-window ownership. Tier A may crawl only native windows;
-- derived windows are synthesized from fresh profile stats.
UPDATE arena.sources AS source
SET
  timeframes_native = target.timeframes_native,
  timeframes_derived = target.timeframes_derived
FROM (
  VALUES
    ('bitfinex'::text, ARRAY[7, 30]::integer[], ARRAY[]::integer[]),
    ('bitmart_futures', ARRAY[7, 30]::integer[], ARRAY[90]::integer[]),
    ('hyperliquid', ARRAY[7, 30]::integer[], ARRAY[90]::integer[]),
    ('kucoin_futures', ARRAY[30]::integer[], ARRAY[7, 90]::integer[]),
    ('okx_futures', ARRAY[90]::integer[], ARRAY[7, 30]::integer[]),
    ('okx_spot', ARRAY[90]::integer[], ARRAY[7, 30]::integer[]),
    ('toobit_futures', ARRAY[7, 30, 90]::integer[], ARRAY[]::integer[])
) AS target(slug, timeframes_native, timeframes_derived)
WHERE source.slug = target.slug
  AND (
    source.timeframes_native IS DISTINCT FROM target.timeframes_native
    OR source.timeframes_derived IS DISTINCT FROM target.timeframes_derived
  );

-- Bitfinex's tGLOBAL:USD ranking values are literal USD.
UPDATE arena.sources AS source
SET currency = 'USD'
WHERE source.slug = 'bitfinex'
  AND source.currency IS DISTINCT FROM 'USD';

-- BitMart uses numeric gw-api pages and is reachable from the native SG
-- worker, not the local Mac egress. Its 90D board is profile-derived.
UPDATE arena.sources AS source
SET
  fetch_region = 'vps_sg',
  page_size = 20,
  pagination_kind = 'numeric',
  meta = source.meta || pg_catalog.jsonb_build_object(
    'derived_board_sort', 'roi',
    'derived_stats_max_age_hours', 168
  )
WHERE source.slug = 'bitmart_futures'
  AND (
    source.fetch_region IS DISTINCT FROM 'vps_sg'
    OR source.page_size IS DISTINCT FROM 20
    OR source.pagination_kind IS DISTINCT FROM 'numeric'
    OR source.meta->>'derived_board_sort' IS DISTINCT FROM 'roi'
    OR source.meta->>'derived_stats_max_age_hours' IS DISTINCT FROM '168'
  );

-- KuCoin's board request has no timeframe parameter; 7D/90D come from its
-- period-specific profile substrate.
UPDATE arena.sources AS source
SET meta = source.meta || pg_catalog.jsonb_build_object(
  'derived_board_sort', 'roi'
)
WHERE source.slug = 'kucoin_futures'
  AND source.meta->>'derived_board_sort' IS DISTINCT FROM 'roi';

-- OKX public-lead-traders is a 90D board. Both products share the adapter but
-- retain explicit product identity so SPOT never falls through to SWAP.
UPDATE arena.sources AS source
SET
  fetch_region = 'vps_sg',
  page_size = 20,
  pagination_kind = 'numeric',
  meta = source.meta || pg_catalog.jsonb_build_object(
    'inst_type',
    CASE source.slug WHEN 'okx_spot' THEN 'SPOT' ELSE 'SWAP' END,
    'derived_board_sort', 'roi',
    'derived_stats_max_age_hours', 168
  )
WHERE source.slug = ANY (ARRAY['okx_futures', 'okx_spot']::text[])
  AND (
    source.fetch_region IS DISTINCT FROM 'vps_sg'
    OR source.page_size IS DISTINCT FROM 20
    OR source.pagination_kind IS DISTINCT FROM 'numeric'
    OR source.meta->>'inst_type' IS DISTINCT FROM
      CASE source.slug WHEN 'okx_spot' THEN 'SPOT' ELSE 'SWAP' END
    OR source.meta->>'derived_board_sort' IS DISTINCT FROM 'roi'
    OR source.meta->>'derived_stats_max_age_hours' IS DISTINCT FROM '168'
  );

-- Toobit's origin pins six rows per numbered page even when a larger pageSize
-- is requested. Keeping page_size=6 preserves page/rank evidence.
UPDATE arena.sources AS source
SET
  fetch_region = 'vps_sg',
  page_size = 6,
  pagination_kind = 'numeric'
WHERE source.slug = 'toobit_futures'
  AND (
    source.fetch_region IS DISTINCT FROM 'vps_sg'
    OR source.page_size IS DISTINCT FROM 6
    OR source.pagination_kind IS DISTINCT FROM 'numeric'
  );

-- This exact Hyperliquid capacity contract was documented and applied
-- directly through INGEST_DATABASE_URL but never made replayable.
UPDATE arena.sources AS source
SET
  expected_count = 10000,
  page_size = 5000,
  rate_budget_ms = 1100,
  cadence_tier_a = interval '6 hours',
  deep_profile_topn = 500,
  meta = source.meta || pg_catalog.jsonb_build_object(
    'board_depth', 10000,
    'derived_board_sort', 'pnl'
  )
WHERE source.slug = 'hyperliquid'
  AND (
    source.expected_count IS DISTINCT FROM 10000
    OR source.page_size IS DISTINCT FROM 5000
    OR source.rate_budget_ms IS DISTINCT FROM 1100
    OR source.cadence_tier_a IS DISTINCT FROM interval '6 hours'
    OR source.deep_profile_topn IS DISTINCT FROM 500
    OR source.meta->>'board_depth' IS DISTINCT FROM '10000'
    OR source.meta->>'derived_board_sort' IS DISTINCT FROM 'pnl'
  );

-- Inactive/blocked rows remain editable during rollout. The exact reviewed
-- contract becomes mandatory before any of these adapter identities is active.
ALTER TABLE arena.sources
  DROP CONSTRAINT IF EXISTS sources_active_adapter_runtime_contract;

ALTER TABLE arena.sources
  ADD CONSTRAINT sources_active_adapter_runtime_contract
  CHECK (
    status <> 'active'
    OR COALESCE((
      CASE
      WHEN slug = 'bitfinex' OR adapter_slug = 'bitfinex' THEN
        slug = 'bitfinex'
        AND adapter_slug = 'bitfinex'
        AND product_type = 'futures'
        AND trader_kind_scope = 'human'
        AND currency = 'USD'
        AND fetch_region = 'local'
        AND timeframes_native IS NOT DISTINCT FROM ARRAY[7, 30]::integer[]
        AND timeframes_derived IS NOT DISTINCT FROM ARRAY[]::integer[]
      WHEN slug = 'bitmart_futures' OR adapter_slug = 'bitmart' THEN
        slug = 'bitmart_futures'
        AND adapter_slug = 'bitmart'
        AND product_type = 'futures'
        AND currency = 'USDT'
        AND fetch_region = 'vps_sg'
        AND timeframes_native IS NOT DISTINCT FROM ARRAY[7, 30]::integer[]
        AND timeframes_derived IS NOT DISTINCT FROM ARRAY[90]::integer[]
        AND page_size IS NOT DISTINCT FROM 20
        AND pagination_kind IS NOT DISTINCT FROM 'numeric'
        AND meta->>'derived_board_sort' IS NOT DISTINCT FROM 'roi'
        AND meta->>'derived_stats_max_age_hours' IS NOT DISTINCT FROM '168'
      WHEN slug = 'hyperliquid' OR adapter_slug = 'hyperliquid' THEN
        slug = 'hyperliquid'
        AND adapter_slug = 'hyperliquid'
        AND product_type = 'onchain'
        AND currency = 'USDC'
        AND fetch_region = 'local'
        AND timeframes_native IS NOT DISTINCT FROM ARRAY[7, 30]::integer[]
        AND timeframes_derived IS NOT DISTINCT FROM ARRAY[90]::integer[]
        AND expected_count IS NOT DISTINCT FROM 10000
        AND page_size IS NOT DISTINCT FROM 5000
        AND rate_budget_ms IS NOT DISTINCT FROM 1100
        AND cadence_tier_a IS NOT DISTINCT FROM interval '6 hours'
        AND deep_profile_topn IS NOT DISTINCT FROM 500
        AND meta->>'board_depth' IS NOT DISTINCT FROM '10000'
        AND meta->>'derived_board_sort' IS NOT DISTINCT FROM 'pnl'
      WHEN slug = 'kucoin_futures' OR adapter_slug = 'kucoin' THEN
        slug = 'kucoin_futures'
        AND adapter_slug = 'kucoin'
        AND product_type = 'futures'
        AND currency = 'USDT'
        AND timeframes_native IS NOT DISTINCT FROM ARRAY[30]::integer[]
        AND timeframes_derived IS NOT DISTINCT FROM ARRAY[7, 90]::integer[]
        AND meta->>'derived_board_sort' IS NOT DISTINCT FROM 'roi'
      WHEN slug = ANY (ARRAY['okx_futures', 'okx_spot']::text[])
        OR adapter_slug = 'okx' THEN
        adapter_slug = 'okx'
        AND fetch_region = 'vps_sg'
        AND currency = 'USDT'
        AND timeframes_native IS NOT DISTINCT FROM ARRAY[90]::integer[]
        AND timeframes_derived IS NOT DISTINCT FROM ARRAY[7, 30]::integer[]
        AND page_size IS NOT DISTINCT FROM 20
        AND pagination_kind IS NOT DISTINCT FROM 'numeric'
        AND meta->>'derived_board_sort' IS NOT DISTINCT FROM 'roi'
        AND meta->>'derived_stats_max_age_hours' IS NOT DISTINCT FROM '168'
        AND (
          (
            slug = 'okx_futures'
            AND product_type = 'futures'
            AND meta->>'inst_type' IS NOT DISTINCT FROM 'SWAP'
          )
          OR (
            slug = 'okx_spot'
            AND product_type = 'spot'
            AND meta->>'inst_type' IS NOT DISTINCT FROM 'SPOT'
          )
        )
      WHEN slug = 'toobit_futures' OR adapter_slug = 'toobit' THEN
        slug = 'toobit_futures'
        AND adapter_slug = 'toobit'
        AND product_type = 'futures'
        AND currency = 'USDT'
        AND fetch_region = 'vps_sg'
        AND timeframes_native IS NOT DISTINCT FROM ARRAY[7, 30, 90]::integer[]
        AND timeframes_derived IS NOT DISTINCT FROM ARRAY[]::integer[]
        AND page_size IS NOT DISTINCT FROM 6
        AND pagination_kind IS NOT DISTINCT FROM 'numeric'
      ELSE true
      END
    ), false)
  ) NOT VALID;

ALTER TABLE arena.sources
  VALIDATE CONSTRAINT sources_active_adapter_runtime_contract;

DO $postflight$
DECLARE
  v_exact_sources integer;
  v_constraint_count integer;
BEGIN
  SELECT pg_catalog.count(*)::integer
  INTO v_exact_sources
  FROM arena.sources AS source
  WHERE
    (
      source.slug = 'bitfinex'
      AND source.currency = 'USD'
      AND source.fetch_region = 'local'
      AND source.timeframes_native = ARRAY[7, 30]::integer[]
      AND source.timeframes_derived = ARRAY[]::integer[]
    )
    OR (
      source.slug = 'bitmart_futures'
      AND source.fetch_region = 'vps_sg'
      AND source.timeframes_native = ARRAY[7, 30]::integer[]
      AND source.timeframes_derived = ARRAY[90]::integer[]
      AND source.page_size = 20
      AND source.pagination_kind = 'numeric'
      AND source.meta->>'derived_stats_max_age_hours' = '168'
    )
    OR (
      source.slug = 'hyperliquid'
      AND source.expected_count = 10000
      AND source.page_size = 5000
      AND source.rate_budget_ms = 1100
      AND source.cadence_tier_a = interval '6 hours'
      AND source.deep_profile_topn = 500
      AND source.timeframes_native = ARRAY[7, 30]::integer[]
      AND source.timeframes_derived = ARRAY[90]::integer[]
      AND source.meta->>'board_depth' = '10000'
    )
    OR (
      source.slug = 'kucoin_futures'
      AND source.timeframes_native = ARRAY[30]::integer[]
      AND source.timeframes_derived = ARRAY[7, 90]::integer[]
    )
    OR (
      source.slug = 'okx_futures'
      AND source.fetch_region = 'vps_sg'
      AND source.timeframes_native = ARRAY[90]::integer[]
      AND source.timeframes_derived = ARRAY[7, 30]::integer[]
      AND source.page_size = 20
      AND source.pagination_kind = 'numeric'
      AND source.meta->>'inst_type' = 'SWAP'
      AND source.meta->>'derived_stats_max_age_hours' = '168'
    )
    OR (
      source.slug = 'okx_spot'
      AND source.fetch_region = 'vps_sg'
      AND source.timeframes_native = ARRAY[90]::integer[]
      AND source.timeframes_derived = ARRAY[7, 30]::integer[]
      AND source.page_size = 20
      AND source.pagination_kind = 'numeric'
      AND source.meta->>'inst_type' = 'SPOT'
      AND source.meta->>'derived_stats_max_age_hours' = '168'
    )
    OR (
      source.slug = 'toobit_futures'
      AND source.fetch_region = 'vps_sg'
      AND source.timeframes_native = ARRAY[7, 30, 90]::integer[]
      AND source.timeframes_derived = ARRAY[]::integer[]
      AND source.page_size = 6
      AND source.pagination_kind = 'numeric'
    );

  SELECT pg_catalog.count(*)::integer
  INTO v_constraint_count
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'arena.sources'::pg_catalog.regclass
    AND constraint_row.conname = 'sources_active_adapter_runtime_contract'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated;

  IF v_exact_sources <> 7 OR v_constraint_count <> 1 THEN
    RAISE EXCEPTION
      'source registry runtime contract postflight failed: sources %, constraints %',
      v_exact_sources,
      v_constraint_count;
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
