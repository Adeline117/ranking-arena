-- Align public copier-depth claims with the reviewed adapter evidence.
-- Gate futures has a reported-total, fully paginated verifier. Every other
-- source below is either first-page/nonterminal or exposes no public copier
-- table at all, so retaining full/top10 would overstate serving authority.
-- LBank is intentionally absent: its public followers endpoint is capped at
-- top 100 and therefore cannot authorize a full-depth claim.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '1min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    '20260804-correct-reviewed-copier-depth-contracts',
    0
  )
);

DO $preflight$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR current_user IS DISTINCT FROM 'postgres'
     OR pg_catalog.to_regclass('arena.sources') IS NULL THEN
    RAISE EXCEPTION 'reviewed copier depth correction requires PG17 and arena.sources';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'arena.sources'::pg_catalog.regclass
      AND attribute.attname IN (
        'slug',
        'adapter_slug',
        'product_type',
        'trader_kind_scope',
        'currency',
        'copier_table_depth',
        'meta'
      )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 7 THEN
    RAISE EXCEPTION 'arena.sources copier contract columns drifted';
  END IF;
END
$preflight$;

LOCK TABLE ONLY arena.sources IN SHARE ROW EXCLUSIVE MODE;

DO $contract$
DECLARE
  v_expected constant jsonb := $json$
    [
      {"slug":"gate_futures","adapter":"gate","product":"futures","scope":"human","currency":"USDT","oldDepth":"top10","targetDepth":"full"},
      {"slug":"gate_cfd","adapter":"gate","product":"cfd","scope":"human","currency":"USDx","oldDepth":"top10","targetDepth":"none"},
      {"slug":"bybit_copytrade","adapter":"bybit_copytrade","product":"futures","scope":"mixed","currency":"USDT","oldDepth":"full","targetDepth":"none"},
      {"slug":"bingx_futures","adapter":"bingx","product":"futures","scope":"human","currency":"USDT","oldDepth":"full","targetDepth":"none"},
      {"slug":"bingx_spot","adapter":"bingx","product":"spot","scope":"human","currency":"USDT","oldDepth":"full","targetDepth":"none"},
      {"slug":"blofin_futures","adapter":"blofin","product":"futures","scope":"mixed","currency":"USDT","oldDepth":"full","targetDepth":"none"},
      {"slug":"blofin_spot","adapter":"blofin","product":"spot","scope":"human","currency":"USDT","oldDepth":"full","targetDepth":"none"},
      {"slug":"htx_futures","adapter":"htx","product":"futures","scope":"human","currency":"USDT","oldDepth":"full","targetDepth":"none"},
      {"slug":"htx_spot","adapter":"htx","product":"spot","scope":"human","currency":"USDT","oldDepth":"full","targetDepth":"none"},
      {"slug":"phemex_futures","adapter":"phemex","product":"futures","scope":"mixed","currency":"USDT","oldDepth":"full","targetDepth":"none"},
      {"slug":"bitmart_futures","adapter":"bitmart","product":"futures","scope":"mixed","currency":"USDT","oldDepth":"full","targetDepth":"none"}
    ]
  $json$::jsonb;
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM arena.sources AS source_row
    WHERE source_row.slug IN (
      SELECT expected.slug
      FROM pg_catalog.jsonb_to_recordset(v_expected) AS expected(slug text)
    )
  ) <> pg_catalog.jsonb_array_length(v_expected) THEN
    RAISE EXCEPTION 'reviewed copier depth correction requires exactly one canonical source per slug';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(v_expected) AS expected(
      slug text,
      adapter text,
      product text,
      scope text,
      currency text,
      "oldDepth" text,
      "targetDepth" text
    )
    LEFT JOIN arena.sources AS source_row
      ON source_row.slug = expected.slug
    WHERE source_row.slug IS NULL
       OR source_row.adapter_slug IS DISTINCT FROM expected.adapter
       OR source_row.product_type IS DISTINCT FROM expected.product
       OR source_row.trader_kind_scope IS DISTINCT FROM expected.scope
       OR source_row.currency IS DISTINCT FROM expected.currency
       OR (
         source_row.copier_table_depth IS DISTINCT FROM expected."oldDepth"
         AND source_row.copier_table_depth IS DISTINCT FROM expected."targetDepth"
       )
       OR pg_catalog.jsonb_typeof(source_row.meta) IS DISTINCT FROM 'object'
  ) THEN
    RAISE EXCEPTION 'reviewed copier source identity, currency, metadata, or depth pre-state drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM arena.sources AS source_row
    WHERE source_row.slug = 'gate_futures'
      AND (
        source_row.meta->>'boardKey' IS DISTINCT FROM 'futures'
        OR (
          source_row.meta ? 'endpoints'
          AND pg_catalog.jsonb_typeof(source_row.meta->'endpoints') IS DISTINCT FROM
            'object'
        )
        OR (
          source_row.meta->'endpoints' ? 'copiers'
          AND (
            pg_catalog.jsonb_typeof(
              source_row.meta->'endpoints'->'copiers'
            ) IS DISTINCT FROM 'string'
            OR source_row.meta->'endpoints'->>'copiers' IS DISTINCT FROM
              'https://www.gate.com/api/copytrade/copy_trading/trader/follow_user'
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'gate_futures reviewed board or copier endpoint drifted';
  END IF;
END
$contract$;

UPDATE arena.sources AS source_row
SET copier_table_depth = expected.target_depth
FROM (
  VALUES
    ('gate_futures', 'full'),
    ('gate_cfd', 'none'),
    ('bybit_copytrade', 'none'),
    ('bingx_futures', 'none'),
    ('bingx_spot', 'none'),
    ('blofin_futures', 'none'),
    ('blofin_spot', 'none'),
    ('htx_futures', 'none'),
    ('htx_spot', 'none'),
    ('phemex_futures', 'none'),
    ('bitmart_futures', 'none')
) AS expected(slug, target_depth)
WHERE source_row.slug = expected.slug
  AND source_row.copier_table_depth IS DISTINCT FROM expected.target_depth;

DO $postflight$
DECLARE
  v_targets constant jsonb := $json$
    [
      {"slug":"gate_futures","depth":"full"},
      {"slug":"gate_cfd","depth":"none"},
      {"slug":"bybit_copytrade","depth":"none"},
      {"slug":"bingx_futures","depth":"none"},
      {"slug":"bingx_spot","depth":"none"},
      {"slug":"blofin_futures","depth":"none"},
      {"slug":"blofin_spot","depth":"none"},
      {"slug":"htx_futures","depth":"none"},
      {"slug":"htx_spot","depth":"none"},
      {"slug":"phemex_futures","depth":"none"},
      {"slug":"bitmart_futures","depth":"none"}
    ]
  $json$::jsonb;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(v_targets) AS target(slug text, depth text)
    LEFT JOIN arena.sources AS source_row
      ON source_row.slug = target.slug
    WHERE source_row.slug IS NULL
       OR source_row.copier_table_depth IS DISTINCT FROM target.depth
  ) THEN
    RAISE EXCEPTION 'reviewed copier depth correction postflight failed';
  END IF;
END
$postflight$;

COMMIT;
