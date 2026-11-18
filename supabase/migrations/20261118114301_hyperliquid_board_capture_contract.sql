-- Migration: 20261118114301_hyperliquid_board_capture_contract.sql
-- Description: Register hyperliquid for attempt-bound V3 Tier-A capture in
--   exhaustion mode, in one reviewed step.
--
-- Every row mirrors the code registry exactly:
--   * arena.metric_source_contracts          <- lib/metric-trust.ts (hyperliquid)
--   * arena.leaderboard_exhaustion_contracts <- HYPERLIQUID_LEADERBOARD_EXHAUSTION
--     (lib/ingest/adapters/hyperliquid)
--   * arena.leaderboard_capture_contracts (manifest@3)
--
-- The board is ONE public document (stats-data.hyperliquid.xyz/Mainnet/
-- leaderboard, 48,027 rows when probed read-only on 2026-11-18) with no total
-- and no pagination. 20261115160917 left hyperliquid out because no reported
-- end signal existed and the adapter truncated the sorted file to its top
-- 10,000. The adapter now captures the document verbatim per window and the
-- parser ranks the whole population, so exhaustion mode binds it:
--   end signal    short_page: the single page holds fewer rows than
--                 sources.page_size, set below to a declared 250,000-row
--                 ceiling; a document at the ceiling stops at the one-request
--                 safety cap and can never verify
--   board version first_page_reread: the document is re-read after the
--                 capture and must yield identical row keys
-- The numeric capture binds every request to a page index, so the request
-- carries page=1 (the endpoint ignores it); pagination_kind becomes 'numeric'
-- because the manifest only accepts page_index positions for numeric sources.
--
-- Board metric contracts cover 7D (week) and 30D (month) only, in USDC. The
-- document's allTime window is not a 90-day window; a native 90D window makes
-- the whole migration refuse instead of registering a mislabelled contract.
--
-- POSTDEPLOY: a registered source whose deployed adapter has no capture
-- fails every Tier-A run, so this follows the worker release that ships the
-- hyperliquid capture and ParseCtx.timeframe. It requires the exhaustion
-- registry (20261115141050). A missing hyperliquid row is skipped. An existing
-- one must use the hyperliquid adapter and currency USDC, must not already be
-- registered, and every native window must end up with an active population
-- metric contract; otherwise the whole migration refuses.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

LOCK TABLE arena.sources IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.metric_source_contracts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.leaderboard_capture_contracts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.leaderboard_exhaustion_contracts IN SHARE ROW EXCLUSIVE MODE;

-- Session-local seeds (pg_temp); they disappear with the applying session.
CREATE TEMPORARY TABLE hyperliquid_exhaustion_seed (
  source_slug text PRIMARY KEY,
  adapter_slug text NOT NULL,
  declaration jsonb NOT NULL
);

INSERT INTO hyperliquid_exhaustion_seed VALUES
  ('hyperliquid', 'hyperliquid',
   '{"completeness_mode": "exhausted", "list_path": ["leaderboardRows"], "row_key_path": ["ethAddress"], "end_signal": {"kind": "short_page"}, "board_version": {"kind": "first_page_reread"}, "max_duplicate_rows": 0}');

CREATE TEMPORARY TABLE hyperliquid_metric_contract_seed (
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

INSERT INTO hyperliquid_metric_contract_seed VALUES
    ('hyperliquid', 'hyperliquid', '1', 'roi', 'leaderboardRows[].windowPerformances[week].roi', 'source_reported', 'hyperliquid-board-roi@1', 'hyperliquid-board-roi-pnl@1', ARRAY[7]::smallint[], 'percent', ARRAY['USDC']::text[]),
    ('hyperliquid', 'hyperliquid', '1', 'pnl', 'leaderboardRows[].windowPerformances[week].pnl', 'source_reported', 'hyperliquid-board-pnl@1', 'hyperliquid-board-roi-pnl@1', ARRAY[7]::smallint[], 'currency', ARRAY['USDC']::text[]),
    ('hyperliquid', 'hyperliquid', '1', 'roi', 'leaderboardRows[].windowPerformances[month].roi', 'source_reported', 'hyperliquid-board-roi@1', 'hyperliquid-board-roi-pnl@1', ARRAY[30]::smallint[], 'percent', ARRAY['USDC']::text[]),
    ('hyperliquid', 'hyperliquid', '1', 'pnl', 'leaderboardRows[].windowPerformances[month].pnl', 'source_reported', 'hyperliquid-board-pnl@1', 'hyperliquid-board-roi-pnl@1', ARRAY[30]::smallint[], 'currency', ARRAY['USDC']::text[]);

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.metric_source_contracts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_capture_contracts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_exhaustion_contracts') IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.leaderboard_exhaustion_declaration_valid(jsonb)'
     ) IS NULL THEN
    RAISE EXCEPTION 'hyperliquid capture registration requires the capture, metric-contract and exhaustion registries (20261115141050)';
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
      SELECT seed.source_slug, seed.adapter_slug FROM hyperliquid_exhaustion_seed AS seed
      UNION ALL
      SELECT seed.source_slug, seed.adapter_slug FROM hyperliquid_metric_contract_seed AS seed
    ) AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
   WHERE source_row.adapter_slug IS DISTINCT FROM seed.adapter_slug;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'hyperliquid capture adapter drift: %', v_bad;
  END IF;

  SELECT pg_catalog.string_agg(DISTINCT source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM hyperliquid_metric_contract_seed AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
   WHERE NOT (source_row.currency = ANY (seed.currencies));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'hyperliquid board metric contract currency drift: %', v_bad;
  END IF;

  SELECT pg_catalog.string_agg(DISTINCT source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM arena.metric_source_contracts AS contract
    JOIN arena.sources AS source_row
      ON source_row.id = contract.source_id
   WHERE contract.active
     AND source_row.slug IN (SELECT seed.source_slug FROM hyperliquid_metric_contract_seed AS seed);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'board metric source contracts already registered for: %', v_bad;
  END IF;

  SELECT pg_catalog.string_agg(source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM hyperliquid_exhaustion_seed AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
    JOIN arena.leaderboard_capture_contracts AS capture
      ON capture.source_id = source_row.id;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'attempt-bound capture already registered for: %', v_bad;
  END IF;

  SELECT pg_catalog.string_agg(source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM hyperliquid_exhaustion_seed AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
    JOIN arena.leaderboard_exhaustion_contracts AS contract
      ON contract.source_id = source_row.id;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'leaderboard exhaustion contract already registered for: %', v_bad;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM hyperliquid_exhaustion_seed AS seed
     WHERE NOT arena.leaderboard_exhaustion_declaration_valid(seed.declaration)
  ) THEN
    RAISE EXCEPTION 'exhaustion contract seed is malformed';
  END IF;
END
$preflight$;

-- Capture mechanics the reviewed contract requires: one numeric page whose
-- row ceiling is the short-page bound.
UPDATE arena.sources
   SET page_size = 250000,
       pagination_kind = 'numeric'
 WHERE slug = 'hyperliquid'
   AND adapter_slug = 'hyperliquid'
   AND (page_size IS DISTINCT FROM 250000 OR pagination_kind IS DISTINCT FROM 'numeric');

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
FROM hyperliquid_metric_contract_seed AS seed
JOIN arena.sources AS source_row
  ON source_row.slug = seed.source_slug
 AND source_row.adapter_slug = seed.adapter_slug
ORDER BY seed.timeframes[1], seed.metric;

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
    FROM hyperliquid_exhaustion_seed AS seed
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

INSERT INTO arena.leaderboard_exhaustion_contracts (
  source_id,
  completeness_contract,
  declaration
)
SELECT
  source_row.id,
  'arena.ingest.leaderboard-exhaustion-completeness@1',
  seed.declaration
FROM hyperliquid_exhaustion_seed AS seed
JOIN arena.sources AS source_row
  ON source_row.slug = seed.source_slug
 AND source_row.adapter_slug = seed.adapter_slug;

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
FROM hyperliquid_exhaustion_seed AS seed
JOIN arena.sources AS source_row
  ON source_row.slug = seed.source_slug
 AND source_row.adapter_slug = seed.adapter_slug;

DO $postflight$
BEGIN
  IF (
       SELECT pg_catalog.count(*)
         FROM arena.metric_source_contracts AS contract
         JOIN arena.sources AS source_row
           ON source_row.id = contract.source_id
         JOIN hyperliquid_metric_contract_seed AS seed
           ON seed.source_slug = source_row.slug
          AND seed.metric = contract.metric
          AND seed.field_path = contract.field_path
          AND seed.methodology_version = contract.methodology_version
          AND seed.timeframes = contract.timeframes
        WHERE contract.active
     ) <> (
       SELECT pg_catalog.count(*)
         FROM hyperliquid_metric_contract_seed AS seed
         JOIN arena.sources AS source_row
           ON source_row.slug = seed.source_slug
     )
     OR (
       SELECT pg_catalog.count(*)
         FROM arena.leaderboard_exhaustion_contracts AS contract
         JOIN arena.sources AS source_row
           ON source_row.id = contract.source_id
         JOIN hyperliquid_exhaustion_seed AS seed
           ON seed.source_slug = source_row.slug
          AND seed.declaration = contract.declaration
     ) <> (
       SELECT pg_catalog.count(*)
         FROM hyperliquid_exhaustion_seed AS seed
         JOIN arena.sources AS source_row
           ON source_row.slug = seed.source_slug
     )
     OR (
       SELECT pg_catalog.count(*)
         FROM arena.leaderboard_capture_contracts AS capture
         JOIN arena.sources AS source_row
           ON source_row.id = capture.source_id
         JOIN hyperliquid_exhaustion_seed AS seed
           ON seed.source_slug = source_row.slug
        WHERE capture.capture_contract = 'arena.ingest.leaderboard-acquisition-manifest@3'
          AND capture.adapter_slug = seed.adapter_slug
          AND capture.attempt_binding_contract =
              'arena.ingest.leaderboard-acquisition-attempt-binding@1'
          AND capture.requires_runner_git_sha
          AND source_row.page_size = 250000
          AND source_row.pagination_kind = 'numeric'
     ) <> (
       SELECT pg_catalog.count(*)
         FROM hyperliquid_exhaustion_seed AS seed
         JOIN arena.sources AS source_row
           ON source_row.slug = seed.source_slug
     ) THEN
    RAISE EXCEPTION 'hyperliquid capture registration postflight failed';
  END IF;
END
$postflight$;

COMMIT;
