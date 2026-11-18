-- Migration: 20261118115310_phemex_attempt_bound_capture_contract.sql
-- Description: Register attempt-bound V3 capture for `phemex_futures`, whose
--   adapter now implements captureLeaderboard (reported-total mode).
--
-- Every row mirrors the code registry exactly:
--   * arena.metric_source_contracts     <- lib/metric-trust.ts `phemex_futures`
--     (one roi/pnl pair per native window: the board response carries both
--     30d and 90d variants and each window reads its own field)
--   * arena.leaderboard_capture_contracts (manifest@3)
--
-- The capture pages GET v3/user/recommend by pageNum and binds data.total
-- (the board population) as the reported total. RAW is the verbatim,
-- window-agnostic response; the parser selects the variant from the Tier-A
-- window (ParseCtx.timeframe). The house AI carousel (v3/ai-trader/list)
-- is no longer appended: it is not part of the board population and would
-- break the reported total. meta.house_ai_traders is left as is: it
-- describes the site, and no code reads it; AI traders the recommend board
-- itself lists are still captured (tagged bot/ai by the parser).
--
-- Source configuration the capture requires (guarded on the seeded value;
-- anything else is left alone and the preflight refuses it):
--   * phemex_futures page_size 12 (seed) -> 50 (the server cap): fewer
--     requests per crawl, so the reported total is less likely to move
--     mid-crawl. Production already holds 50 (read-only 2026-11-18); the
--     update then changes nothing and the check below only confirms 50.
--   * phemex_futures expected_count 323 -> NULL: a survey count that
--     included the appended AI carousel; the reported total (229 at the
--     2026-06-11 capture) is the completeness proof, and against 323 the
--     board would fail the ±30% day-one count gate, whose downward shift
--     needs a manual ack. NULL lets the rolling baseline of real passing
--     crawls govern (as okx_web3_solana).
--
-- NOT PROBED LIVE: the API answers only a page-warmed browser session (bare
-- requests get a CloudFront 403 from the reachable hosts), so the response
-- shape rests on the 2026-06-11 capture. A board that moves during the crawl
-- fails closed (the total does not bind), never publishes.
--
-- POSTDEPLOY, after 20261115160917 and before 20261111192134: registered
-- before the worker release that ships the phemex capture, every Tier-A run
-- of phemex_futures would fail. An absent source is skipped. An existing one
-- must use adapter phemex, currency USDT, native windows within {30,90}, and
-- must not already be registered; otherwise the whole migration refuses.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

LOCK TABLE arena.sources IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.metric_source_contracts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.leaderboard_capture_contracts IN SHARE ROW EXCLUSIVE MODE;

-- Session-local seeds (pg_temp); they disappear with the applying session.
CREATE TEMPORARY TABLE capture_source_seed (
  source_slug text PRIMARY KEY,
  adapter_slug text NOT NULL,
  page_size integer NOT NULL
);

INSERT INTO capture_source_seed VALUES
  ('phemex_futures', 'phemex', 50);

CREATE TEMPORARY TABLE board_metric_contract_seed (
  source_slug text NOT NULL,
  adapter_slug text NOT NULL,
  contract_version text NOT NULL,
  metric text NOT NULL,
  field_path text NOT NULL,
  provenance text NOT NULL,
  methodology_version text NOT NULL,
  metric_set_id text NOT NULL,
  timeframes smallint[] NOT NULL,
  value_unit text NOT NULL,
  currencies text[] NOT NULL
);

INSERT INTO board_metric_contract_seed VALUES
    ('phemex_futures', 'phemex', '1', 'roi', 'data.rows[].pnlRate30d', 'source_normalized', 'phemex-board-roi@1', 'phemex-board-roi-pnl@1', ARRAY[30]::smallint[], 'percent', ARRAY['USDT']::text[]),
    ('phemex_futures', 'phemex', '1', 'pnl', 'data.rows[].pnl30d', 'source_reported', 'phemex-board-pnl@1', 'phemex-board-roi-pnl@1', ARRAY[30]::smallint[], 'currency', ARRAY['USDT']::text[]),
    ('phemex_futures', 'phemex', '1', 'roi', 'data.rows[].pnlRate90d', 'source_normalized', 'phemex-board-roi@1', 'phemex-board-roi-pnl@1', ARRAY[90]::smallint[], 'percent', ARRAY['USDT']::text[]),
    ('phemex_futures', 'phemex', '1', 'pnl', 'data.rows[].pnl90d', 'source_reported', 'phemex-board-pnl@1', 'phemex-board-roi-pnl@1', ARRAY[90]::smallint[], 'currency', ARRAY['USDT']::text[]);

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.metric_source_contracts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_capture_contracts') IS NULL THEN
    RAISE EXCEPTION 'phemex capture registration requires the capture and metric-contract registries';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'arena.leaderboard_capture_contracts'::pg_catalog.regclass
       AND constraint_row.conname = 'leaderboard_capture_contracts_capture_contract_check'
       AND pg_catalog.strpos(
             pg_catalog.pg_get_constraintdef(constraint_row.oid),
             'arena.ingest.leaderboard-acquisition-manifest@3'
           ) > 0
  ) THEN
    RAISE EXCEPTION 'capture registry does not admit manifest V3';
  END IF;

  SELECT pg_catalog.string_agg(DISTINCT source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM (
      SELECT seed.source_slug, seed.adapter_slug FROM capture_source_seed AS seed
      UNION ALL
      SELECT seed.source_slug, seed.adapter_slug FROM board_metric_contract_seed AS seed
    ) AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
   WHERE source_row.adapter_slug IS DISTINCT FROM seed.adapter_slug;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'phemex capture adapter drift: %', v_bad;
  END IF;

  -- The board serves 30d and 90d only; a 7d native window has no contract.
  SELECT pg_catalog.string_agg(source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM capture_source_seed AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
   WHERE NOT (source_row.timeframes_native <@ ARRAY[30, 90]::integer[])
      OR pg_catalog.cardinality(source_row.timeframes_native) = 0;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'phemex capture requires native windows within {30,90}: %', v_bad;
  END IF;

  SELECT pg_catalog.string_agg(DISTINCT source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM arena.metric_source_contracts AS contract
    JOIN arena.sources AS source_row
      ON source_row.id = contract.source_id
   WHERE contract.active
     AND source_row.slug IN (SELECT seed.source_slug FROM board_metric_contract_seed AS seed);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'board metric source contracts already registered for: %', v_bad;
  END IF;

  SELECT pg_catalog.string_agg(source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM capture_source_seed AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
    JOIN arena.leaderboard_capture_contracts AS capture
      ON capture.source_id = source_row.id
     AND capture.capture_contract = 'arena.ingest.leaderboard-acquisition-manifest@3';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'attempt-bound V3 capture already registered for: %', v_bad;
  END IF;
END
$preflight$;

-- Source configuration the reviewed capture requires (seeded value only).
UPDATE arena.sources AS source_row
   SET page_size = seed.page_size
  FROM capture_source_seed AS seed
 WHERE source_row.slug = seed.source_slug
   AND source_row.adapter_slug = seed.adapter_slug
   AND source_row.page_size = 12;

UPDATE arena.sources AS source_row
   SET expected_count = NULL
  FROM capture_source_seed AS seed
 WHERE source_row.slug = seed.source_slug
   AND source_row.adapter_slug = seed.adapter_slug
   AND source_row.expected_count = 323;

DO $configuration$
DECLARE
  v_bad text;
BEGIN
  SELECT pg_catalog.string_agg(DISTINCT source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM capture_source_seed AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
   WHERE source_row.page_size IS DISTINCT FROM seed.page_size;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'phemex capture page_size drift: %', v_bad;
  END IF;

  SELECT pg_catalog.string_agg(DISTINCT source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM capture_source_seed AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
   WHERE source_row.expected_count IS NOT NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'phemex capture expected_count drift: %', v_bad;
  END IF;

  SELECT pg_catalog.string_agg(DISTINCT source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM board_metric_contract_seed AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
   WHERE NOT (source_row.currency = ANY (seed.currencies));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'board metric source contract currency drift: %', v_bad;
  END IF;
END
$configuration$;

INSERT INTO arena.metric_source_contracts (
  source_id,
  contract_version,
  metric,
  field_path,
  provenance,
  methodology_version,
  metric_set_id,
  timeframes,
  value_unit,
  currencies,
  required_raw_roles,
  source_payload_scope,
  max_freshness,
  max_window_end_lag
)
SELECT
  source_row.id,
  seed.contract_version,
  seed.metric,
  seed.field_path,
  seed.provenance,
  seed.methodology_version,
  seed.metric_set_id,
  seed.timeframes,
  seed.value_unit,
  seed.currencies,
  ARRAY['source_payload', 'population_manifest']::text[],
  'population_snapshot',
  interval '6 hours',
  interval '5 minutes'
FROM board_metric_contract_seed AS seed
JOIN arena.sources AS source_row
  ON source_row.slug = seed.source_slug
 AND source_row.adapter_slug = seed.adapter_slug
ORDER BY seed.source_slug, seed.metric;

-- Tier-A refuses an attempt-bound V3 window without a reviewed population
-- contract in the source's currency, so every native window must be covered.
DO $windows$
DECLARE
  v_bad text;
BEGIN
  SELECT pg_catalog.string_agg(
           source_row.slug || ':' || window_days::text || 'd',
           ', ' ORDER BY source_row.slug, window_days
         )
    INTO v_bad
    FROM capture_source_seed AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
    CROSS JOIN LATERAL pg_catalog.unnest(source_row.timeframes_native) AS window_days
   WHERE NOT EXISTS (
     SELECT 1
       FROM arena.metric_source_contracts AS contract
      WHERE contract.source_id = source_row.id
        AND contract.active
        AND contract.source_payload_scope = 'population_snapshot'
        AND window_days::smallint = ANY (contract.timeframes)
        AND source_row.currency = ANY (contract.currencies)
   );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'attempt-bound capture needs a population metric contract for: %', v_bad;
  END IF;
END
$windows$;

INSERT INTO arena.leaderboard_capture_contracts (
  source_id,
  capture_contract,
  adapter_slug,
  attempt_binding_contract,
  requires_runner_git_sha
)
SELECT
  source_row.id,
  'arena.ingest.leaderboard-acquisition-manifest@3',
  source_row.adapter_slug,
  'arena.ingest.leaderboard-acquisition-attempt-binding@1',
  true
FROM capture_source_seed AS seed
JOIN arena.sources AS source_row
  ON source_row.slug = seed.source_slug
 AND source_row.adapter_slug = seed.adapter_slug
ORDER BY source_row.slug;

DO $postflight$
BEGIN
  IF (
       SELECT pg_catalog.count(*)
         FROM arena.metric_source_contracts AS contract
         JOIN arena.sources AS source_row
           ON source_row.id = contract.source_id
         JOIN board_metric_contract_seed AS seed
           ON seed.source_slug = source_row.slug
          AND seed.metric = contract.metric
          AND seed.field_path = contract.field_path
          AND seed.methodology_version = contract.methodology_version
        WHERE contract.active
     ) <> (
       SELECT pg_catalog.count(*)
         FROM board_metric_contract_seed AS seed
         JOIN arena.sources AS source_row
           ON source_row.slug = seed.source_slug
     )
     OR (
       SELECT pg_catalog.count(*)
         FROM arena.leaderboard_capture_contracts AS capture
         JOIN arena.sources AS source_row
           ON source_row.id = capture.source_id
         JOIN capture_source_seed AS seed
           ON seed.source_slug = source_row.slug
        WHERE capture.capture_contract = 'arena.ingest.leaderboard-acquisition-manifest@3'
          AND capture.adapter_slug = seed.adapter_slug
          AND capture.attempt_binding_contract =
              'arena.ingest.leaderboard-acquisition-attempt-binding@1'
          AND capture.requires_runner_git_sha
     ) <> (
       SELECT pg_catalog.count(*)
         FROM capture_source_seed AS seed
         JOIN arena.sources AS source_row
           ON source_row.slug = seed.source_slug
     ) THEN
    RAISE EXCEPTION 'phemex capture registration postflight failed';
  END IF;
END
$postflight$;

COMMIT;
