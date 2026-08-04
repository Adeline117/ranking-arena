-- Correct the two canonical OKX source rows to the copier depth actually
-- proved by the reviewed adapter: futures exposes one aggregate plus top ten
-- copiers; spot exposes no copier surface. Refuse to reinterpret a drifted
-- source identity or endpoint as that canonical contract.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '1min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    '20260804-correct-okx-copier-depth-contract',
    0
  )
);

DO $preflight$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR current_user IS DISTINCT FROM 'postgres'
     OR pg_catalog.to_regclass('arena.sources') IS NULL THEN
    RAISE EXCEPTION 'OKX copier depth correction requires PG17 and arena.sources';
  END IF;
END
$preflight$;

LOCK TABLE ONLY arena.sources IN SHARE ROW EXCLUSIVE MODE;

DO $contract$
DECLARE
  v_futures arena.sources%ROWTYPE;
  v_spot arena.sources%ROWTYPE;
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM arena.sources AS source_row
    WHERE source_row.slug = 'okx_futures'
  ) <> 1
     OR (
       SELECT pg_catalog.count(*)
       FROM arena.sources AS source_row
       WHERE source_row.slug = 'okx_spot'
     ) <> 1 THEN
    RAISE EXCEPTION 'OKX copier depth correction requires exactly one futures and one spot source';
  END IF;

  SELECT source_row.*
  INTO STRICT v_futures
  FROM arena.sources AS source_row
  WHERE source_row.slug = 'okx_futures';

  SELECT source_row.*
  INTO STRICT v_spot
  FROM arena.sources AS source_row
  WHERE source_row.slug = 'okx_spot';

  IF v_futures.adapter_slug IS DISTINCT FROM 'okx'
     OR v_futures.product_type IS DISTINCT FROM 'futures'
     OR v_futures.currency IS DISTINCT FROM 'USDT'
     OR (
       v_futures.copier_table_depth IS DISTINCT FROM 'full'
       AND v_futures.copier_table_depth IS DISTINCT FROM 'top10'
     ) THEN
    RAISE EXCEPTION 'okx_futures identity, currency, or copier depth pre-state drifted';
  END IF;

  IF v_spot.adapter_slug IS DISTINCT FROM 'okx'
     OR v_spot.product_type IS DISTINCT FROM 'spot'
     OR v_spot.currency IS DISTINCT FROM 'USDT'
     OR (
       v_spot.copier_table_depth IS DISTINCT FROM 'full'
       AND v_spot.copier_table_depth IS DISTINCT FROM 'none'
     ) THEN
    RAISE EXCEPTION 'okx_spot identity, currency, or copier depth pre-state drifted';
  END IF;

  IF pg_catalog.jsonb_typeof(v_futures.meta) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_spot.meta) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'OKX source metadata must be JSON objects';
  END IF;

  IF (
       v_futures.meta ? 'inst_type'
       AND (
         pg_catalog.jsonb_typeof(v_futures.meta->'inst_type') IS DISTINCT FROM
           'string'
         OR v_futures.meta->>'inst_type' IS DISTINCT FROM 'SWAP'
       )
     )
     OR (
       v_spot.meta ? 'inst_type'
       AND (
         pg_catalog.jsonb_typeof(v_spot.meta->'inst_type') IS DISTINCT FROM
           'string'
         OR v_spot.meta->>'inst_type' IS DISTINCT FROM 'SPOT'
       )
     ) THEN
    RAISE EXCEPTION 'OKX inst_type metadata conflicts with the canonical product';
  END IF;

  IF (
       v_futures.meta ? 'endpoints'
       AND pg_catalog.jsonb_typeof(v_futures.meta->'endpoints') IS DISTINCT FROM
         'object'
     )
     OR (
       v_spot.meta ? 'endpoints'
       AND pg_catalog.jsonb_typeof(v_spot.meta->'endpoints') IS DISTINCT FROM
         'object'
     ) THEN
    RAISE EXCEPTION 'OKX endpoint metadata must be an object when present';
  END IF;

  IF (
       v_futures.meta->'endpoints' ? 'base'
       AND (
         pg_catalog.jsonb_typeof(
           v_futures.meta->'endpoints'->'base'
         ) IS DISTINCT FROM 'string'
         OR v_futures.meta->'endpoints'->>'base' IS DISTINCT FROM
           'https://www.okx.com/api/v5/copytrading'
       )
     )
     OR (
       v_spot.meta->'endpoints' ? 'base'
       AND (
         pg_catalog.jsonb_typeof(
           v_spot.meta->'endpoints'->'base'
         ) IS DISTINCT FROM 'string'
         OR v_spot.meta->'endpoints'->>'base' IS DISTINCT FROM
           'https://www.okx.com/api/v5/copytrading'
       )
     )
     OR v_futures.meta ?| ARRAY[
       'copier_endpoint',
       'copier_url',
       'copy_traders_endpoint'
     ]::text[]
     OR v_spot.meta ?| ARRAY[
       'copier_endpoint',
       'copier_url',
       'copy_traders_endpoint'
     ]::text[]
     OR v_futures.meta->'endpoints' ?| ARRAY[
       'copier',
       'copiers',
       'copy_traders',
       'public_copy_traders'
     ]::text[]
     OR v_spot.meta->'endpoints' ?| ARRAY[
       'copier',
       'copiers',
       'copy_traders',
       'public_copy_traders'
     ]::text[] THEN
    RAISE EXCEPTION 'OKX custom copier endpoint drifted from the reviewed public-copy-traders route';
  END IF;
END
$contract$;

UPDATE arena.sources
SET copier_table_depth = 'top10'
WHERE slug = 'okx_futures'
  AND copier_table_depth = 'full';

UPDATE arena.sources
SET copier_table_depth = 'none'
WHERE slug = 'okx_spot'
  AND copier_table_depth = 'full';

DO $postflight$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM arena.sources AS source_row
    WHERE source_row.slug = 'okx_futures'
      AND source_row.adapter_slug = 'okx'
      AND source_row.product_type = 'futures'
      AND source_row.currency = 'USDT'
      AND source_row.copier_table_depth = 'top10'
  ) <> 1
     OR (
       SELECT pg_catalog.count(*)
       FROM arena.sources AS source_row
       WHERE source_row.slug = 'okx_spot'
         AND source_row.adapter_slug = 'okx'
         AND source_row.product_type = 'spot'
         AND source_row.currency = 'USDT'
         AND source_row.copier_table_depth = 'none'
     ) <> 1 THEN
    RAISE EXCEPTION 'OKX copier depth correction postflight failed';
  END IF;
END
$postflight$;

COMMIT;
