-- Register attempt-bound V3 capture (arena.ingest.leaderboard-acquisition-
-- manifest@3) for the public Tier-A sources whose adapters now implement
-- captureLeaderboard. Once registered, Tier-A for the source runs begin
-- attempt -> capture -> attempt-bound RAW + manifest -> terminal outcome ->
-- trusted publication, so a PASSED board carries the evidence that
-- public.rank_publication_trust_evidence (PR #476) requires.
--
-- POSTDEPLOY: a registered source whose deployed adapter has no capture
-- implementation fails every Tier-A run, so this must follow the worker that
-- ships the captures. It requires 20261114211033 (board metric contracts) and,
-- for binance_spot, 20260722053000.
--
-- A listed source that does not exist is skipped. An existing one must match
-- its reviewed adapter, must not already be registered for V3, and must carry
-- an active population metric contract for every native window in its own
-- currency (Tier-A refuses an attempt-bound V3 window without one).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

LOCK TABLE arena.sources IN SHARE MODE;
LOCK TABLE arena.leaderboard_capture_contracts IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMPORARY TABLE attempt_bound_capture_seed (
  source_slug text PRIMARY KEY,
  adapter_slug text NOT NULL
) ON COMMIT DROP;

INSERT INTO attempt_bound_capture_seed VALUES
  ('binance_spot', 'binance'),
  ('bitunix_futures', 'bitunix'),
  ('blofin_futures', 'blofin'),
  ('blofin_spot', 'blofin'),
  ('btcc_futures', 'btcc'),
  ('bybit_copytrade', 'bybit_copytrade'),
  ('bybit_mt5', 'bybit_mt5'),
  ('coinex_futures', 'coinex'),
  ('gate_cfd', 'gate'),
  ('gate_futures', 'gate'),
  ('htx_futures', 'htx'),
  ('htx_spot', 'htx'),
  ('kucoin_futures', 'kucoin'),
  ('lbank_futures', 'lbank'),
  ('okx_web3_solana', 'okx_web3');

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF pg_catalog.to_regclass('arena.leaderboard_capture_contracts') IS NULL
     OR pg_catalog.to_regclass('arena.metric_source_contracts') IS NULL THEN
    RAISE EXCEPTION 'attempt-bound capture registration foundations are missing';
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

  SELECT pg_catalog.string_agg(source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM attempt_bound_capture_seed AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
   WHERE source_row.adapter_slug IS DISTINCT FROM seed.adapter_slug;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'attempt-bound capture adapter drift: %', v_bad;
  END IF;

  SELECT pg_catalog.string_agg(source_row.slug, ', ' ORDER BY source_row.slug)
    INTO v_bad
    FROM attempt_bound_capture_seed AS seed
    JOIN arena.sources AS source_row
      ON source_row.slug = seed.source_slug
    JOIN arena.leaderboard_capture_contracts AS capture
      ON capture.source_id = source_row.id
     AND capture.capture_contract = 'arena.ingest.leaderboard-acquisition-manifest@3';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'attempt-bound V3 capture already registered for: %', v_bad;
  END IF;

  SELECT pg_catalog.string_agg(
           source_row.slug || ':' || window_days::text || 'd',
           ', ' ORDER BY source_row.slug, window_days
         )
    INTO v_bad
    FROM attempt_bound_capture_seed AS seed
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
$preflight$;

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
FROM attempt_bound_capture_seed AS seed
JOIN arena.sources AS source_row
  ON source_row.slug = seed.source_slug
 AND source_row.adapter_slug = seed.adapter_slug
ORDER BY source_row.slug;

DO $postflight$
BEGIN
  IF (
       SELECT pg_catalog.count(*)
         FROM arena.leaderboard_capture_contracts AS capture
         JOIN arena.sources AS source_row
           ON source_row.id = capture.source_id
         JOIN attempt_bound_capture_seed AS seed
           ON seed.source_slug = source_row.slug
        WHERE capture.capture_contract = 'arena.ingest.leaderboard-acquisition-manifest@3'
          AND capture.adapter_slug = seed.adapter_slug
          AND capture.attempt_binding_contract =
              'arena.ingest.leaderboard-acquisition-attempt-binding@1'
          AND capture.requires_runner_git_sha
     ) <> (
       SELECT pg_catalog.count(*)
         FROM attempt_bound_capture_seed AS seed
         JOIN arena.sources AS source_row
           ON source_row.slug = seed.source_slug
     ) THEN
    RAISE EXCEPTION 'attempt-bound capture registration postflight failed';
  END IF;
END
$postflight$;

COMMIT;
