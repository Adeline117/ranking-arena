-- Migration: 20260729061000_source_legacy_platform_alias_contract.sql
-- Description: Make the production source/legacy-platform identity map replayable.
--
-- The arena registry uses canonical product slugs while public ranking rows and
-- historical trader URLs still use thirteen legacy platform names. Those
-- legacy_platform values were written directly to production during the June
-- cutover, but never appeared in a migration. A fresh database therefore
-- silently emitted different score-input platform names and could lose whole
-- exchange families from rankings, trader resolution, follows, and claims.
--
-- The mappings below are limited to exact values recovered from production
-- read evidence and the checked-in cutover history. Existing exact values are
-- preserved. Any pre-existing conflicting value or protected-name collision
-- aborts the whole migration; this contract never overwrites unknown metadata,
-- changes source status, or changes serving_mode.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '45s';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'arena.sources:legacy-platform-alias-contract:v1',
    0
  )
);

DO $foundations$
DECLARE
  v_sources pg_catalog.regclass := pg_catalog.to_regclass('arena.sources');
  v_exchanges pg_catalog.regclass := pg_catalog.to_regclass('arena.exchanges');
BEGIN
  IF v_sources IS NULL OR v_exchanges IS NULL THEN
    RAISE EXCEPTION 'source legacy-platform alias contract foundations are missing';
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
    RAISE EXCEPTION 'source legacy-platform alias contract requires ordinary permanent tables';
  END IF;
END
$foundations$;

CREATE TEMPORARY TABLE pg_temp.required_source_aliases (
  slug text PRIMARY KEY,
  adapter_slug text NOT NULL,
  exchange_slug text NOT NULL,
  product_type text NOT NULL,
  trader_kind_scope text NOT NULL,
  legacy_platform text NOT NULL UNIQUE,
  CHECK (slug <> legacy_platform),
  CHECK (legacy_platform = pg_catalog.btrim(legacy_platform)),
  CHECK (legacy_platform <> ''),
  CHECK (legacy_platform <> 'null')
) ON COMMIT DROP;

INSERT INTO pg_temp.required_source_aliases (
  slug,
  adapter_slug,
  exchange_slug,
  product_type,
  trader_kind_scope,
  legacy_platform
)
VALUES
  ('mexc_futures', 'mexc', 'mexc', 'futures', 'mixed', 'mexc'),
  ('gate_futures', 'gate', 'gate', 'futures', 'human', 'gateio'),
  ('bingx_futures', 'bingx', 'bingx', 'futures', 'human', 'bingx'),
  ('bybit_copytrade', 'bybit_copytrade', 'bybit', 'futures', 'mixed', 'bybit'),
  ('binance_web3_bsc', 'binance_web3', 'binance_web3', 'onchain', 'human', 'binance_web3'),
  ('kucoin_futures', 'kucoin', 'kucoin', 'futures', 'mixed', 'kucoin'),
  ('bitunix_futures', 'bitunix', 'bitunix', 'futures', 'human', 'bitunix'),
  ('phemex_futures', 'phemex', 'phemex', 'futures', 'mixed', 'phemex'),
  ('btcc_futures', 'btcc', 'btcc', 'futures', 'human', 'btcc'),
  ('lbank_futures', 'lbank', 'lbank', 'futures', 'human', 'lbank'),
  ('blofin_futures', 'blofin', 'blofin', 'futures', 'mixed', 'blofin'),
  ('xt_futures', 'xt', 'xt', 'futures', 'human', 'xt'),
  ('coinex_futures', 'coinex', 'coinex', 'futures', 'human', 'coinex');

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
    JOIN pg_temp.required_source_aliases AS target
      ON target.slug = source.slug
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
  v_conflict_slug text;
BEGIN
  SELECT pg_catalog.count(*)::integer
  INTO v_source_count
  FROM arena.sources AS source
  JOIN pg_temp.required_source_aliases AS target
    ON target.slug = source.slug;

  IF v_source_count <> 13 THEN
    RAISE EXCEPTION 'expected exactly thirteen legacy-platform source rows, found %',
      v_source_count;
  END IF;

  SELECT target.slug
  INTO v_conflict_slug
  FROM pg_temp.required_source_aliases AS target
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
  ORDER BY target.slug
  LIMIT 1;

  IF v_conflict_slug IS NOT NULL THEN
    RAISE EXCEPTION
      'legacy-platform source identity drifted for %; refusing alias repair',
      v_conflict_slug;
  END IF;

  -- A present key is production state, including empty strings, JSON null, and
  -- the historical string "null". Only an absent key may be initialized.
  SELECT target.slug
  INTO v_conflict_slug
  FROM pg_temp.required_source_aliases AS target
  JOIN arena.sources AS source
    ON source.slug = target.slug
  WHERE source.meta ? 'legacy_platform'
    AND source.meta->>'legacy_platform' IS DISTINCT FROM target.legacy_platform
  ORDER BY target.slug
  LIMIT 1;

  IF v_conflict_slug IS NOT NULL THEN
    RAISE EXCEPTION
      'existing legacy_platform conflicts with the reviewed alias for %',
      v_conflict_slug;
  END IF;

  -- Protect both sides of each resolver identity. An unrelated source may not
  -- own a reviewed alias, nor may its alias shadow a reviewed canonical slug.
  SELECT target.slug
  INTO v_conflict_slug
  FROM pg_temp.required_source_aliases AS target
  JOIN arena.sources AS other_source
    ON other_source.slug <> target.slug
   AND (
     other_source.slug = target.legacy_platform
     OR (
       other_source.meta ? 'legacy_platform'
       AND other_source.meta->>'legacy_platform' = target.legacy_platform
     )
     OR (
       other_source.meta ? 'legacy_platform'
       AND other_source.meta->>'legacy_platform' = target.slug
     )
   )
  ORDER BY target.slug
  LIMIT 1;

  IF v_conflict_slug IS NOT NULL THEN
    RAISE EXCEPTION
      'protected legacy-platform namespace conflict for %',
      v_conflict_slug;
  END IF;
END
$preflight$;

-- Initialize only absent keys. jsonb_set preserves every unrelated metadata
-- field, while preflight prevents a conflicting present value from being
-- silently replaced.
UPDATE arena.sources AS source
SET meta = pg_catalog.jsonb_set(
  source.meta,
  ARRAY['legacy_platform']::text[],
  pg_catalog.to_jsonb(target.legacy_platform),
  true
)
FROM pg_temp.required_source_aliases AS target
WHERE source.slug = target.slug
  AND NOT (source.meta ? 'legacy_platform');

-- Inactive rows remain reversible operational state. They may be edited while
-- investigating an upstream outage, but cannot be reactivated with a missing
-- or mismatched public identity.
ALTER TABLE arena.sources
  DROP CONSTRAINT IF EXISTS sources_active_legacy_platform_alias_contract;

ALTER TABLE arena.sources
  ADD CONSTRAINT sources_active_legacy_platform_alias_contract
  CHECK (
    status <> 'active'
    OR COALESCE((
      CASE slug
        WHEN 'mexc_futures' THEN
          adapter_slug = 'mexc'
          AND product_type = 'futures'
          AND trader_kind_scope = 'mixed'
          AND meta->>'legacy_platform' IS NOT DISTINCT FROM 'mexc'
        WHEN 'gate_futures' THEN
          adapter_slug = 'gate'
          AND product_type = 'futures'
          AND trader_kind_scope = 'human'
          AND meta->>'legacy_platform' IS NOT DISTINCT FROM 'gateio'
        WHEN 'bingx_futures' THEN
          adapter_slug = 'bingx'
          AND product_type = 'futures'
          AND trader_kind_scope = 'human'
          AND meta->>'legacy_platform' IS NOT DISTINCT FROM 'bingx'
        WHEN 'bybit_copytrade' THEN
          adapter_slug = 'bybit_copytrade'
          AND product_type = 'futures'
          AND trader_kind_scope = 'mixed'
          AND meta->>'legacy_platform' IS NOT DISTINCT FROM 'bybit'
        WHEN 'binance_web3_bsc' THEN
          adapter_slug = 'binance_web3'
          AND product_type = 'onchain'
          AND trader_kind_scope = 'human'
          AND meta->>'legacy_platform' IS NOT DISTINCT FROM 'binance_web3'
        WHEN 'kucoin_futures' THEN
          adapter_slug = 'kucoin'
          AND product_type = 'futures'
          AND trader_kind_scope = 'mixed'
          AND meta->>'legacy_platform' IS NOT DISTINCT FROM 'kucoin'
        WHEN 'bitunix_futures' THEN
          adapter_slug = 'bitunix'
          AND product_type = 'futures'
          AND trader_kind_scope = 'human'
          AND meta->>'legacy_platform' IS NOT DISTINCT FROM 'bitunix'
        WHEN 'phemex_futures' THEN
          adapter_slug = 'phemex'
          AND product_type = 'futures'
          AND trader_kind_scope = 'mixed'
          AND meta->>'legacy_platform' IS NOT DISTINCT FROM 'phemex'
        WHEN 'btcc_futures' THEN
          adapter_slug = 'btcc'
          AND product_type = 'futures'
          AND trader_kind_scope = 'human'
          AND meta->>'legacy_platform' IS NOT DISTINCT FROM 'btcc'
        WHEN 'lbank_futures' THEN
          adapter_slug = 'lbank'
          AND product_type = 'futures'
          AND trader_kind_scope = 'human'
          AND meta->>'legacy_platform' IS NOT DISTINCT FROM 'lbank'
        WHEN 'blofin_futures' THEN
          adapter_slug = 'blofin'
          AND product_type = 'futures'
          AND trader_kind_scope = 'mixed'
          AND meta->>'legacy_platform' IS NOT DISTINCT FROM 'blofin'
        WHEN 'xt_futures' THEN
          adapter_slug = 'xt'
          AND product_type = 'futures'
          AND trader_kind_scope = 'human'
          AND meta->>'legacy_platform' IS NOT DISTINCT FROM 'xt'
        WHEN 'coinex_futures' THEN
          adapter_slug = 'coinex'
          AND product_type = 'futures'
          AND trader_kind_scope = 'human'
          AND meta->>'legacy_platform' IS NOT DISTINCT FROM 'coinex'
        ELSE true
      END
    ), false)
  ) NOT VALID;

ALTER TABLE arena.sources
  VALIDATE CONSTRAINT sources_active_legacy_platform_alias_contract;

DO $postflight$
DECLARE
  v_exact_sources integer;
  v_constraint_count integer;
BEGIN
  SELECT pg_catalog.count(*)::integer
  INTO v_exact_sources
  FROM pg_temp.required_source_aliases AS target
  JOIN arena.sources AS source
    ON source.slug = target.slug
   AND source.adapter_slug = target.adapter_slug
   AND source.product_type = target.product_type
   AND source.trader_kind_scope = target.trader_kind_scope
   AND source.meta->>'legacy_platform' = target.legacy_platform
  JOIN arena.exchanges AS exchange
    ON exchange.id = source.exchange_id
   AND exchange.slug = target.exchange_slug;

  SELECT pg_catalog.count(*)::integer
  INTO v_constraint_count
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'arena.sources'::pg_catalog.regclass
    AND constraint_row.conname = 'sources_active_legacy_platform_alias_contract'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated;

  IF v_exact_sources <> 13 THEN
    RAISE EXCEPTION 'legacy-platform alias contract count drifted: %', v_exact_sources;
  END IF;

  IF v_constraint_count <> 1 THEN
    RAISE EXCEPTION 'legacy-platform alias constraint is missing or unvalidated';
  END IF;
END
$postflight$;

COMMIT;
