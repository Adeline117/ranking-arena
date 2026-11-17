-- Migration: 20261117015119_register_profile_capture_contracts.sql
-- Description: Register every Tier-B profile capture contract of the worker's
--   code registry (PROFILE_CAPTURE_CONTRACTS, lib/ingest/profile-capture/
--   contract.ts) in arena.profile_capture_contracts, in one reviewed step.
--
-- Each row mirrors its code contract exactly: capture_contract name, the
-- strict-canonical sha256 of the contract document
-- (profileCaptureContractSha256), its timeframes and the sorted keys of its
-- metrics map.
--   binance_futures  (lib/ingest/adapters/binance)          mdd, total_positions
--   binance_spot     (lib/ingest/adapters/binance)          mdd
--   bybit_copytrade  (lib/ingest/adapters/bybit-copytrade)  mdd, pnl, roi, sharpe, sortino, win_rate
--   blofin_futures   (lib/ingest/adapters/blofin)           total_positions, win_rate
--   toobit_futures   (lib/ingest/adapters/toobit)           mdd
--
-- Deliberately not registered (no contract in the code registry): blofin_spot
-- (the adapter's profile endpoints return the futures account; its profile
-- surface is off), bitget_spot and bitget_cfd (the adapter's profile
-- endpoints carry no data for spot/CFD portfolios). Their profile values stay
-- unevidenced.
--
-- POSTDEPLOY, after 20261116215329 and before 20261111192134: a registered
-- contract is only meaningful to the worker release that carries the same
-- contract document; the deployed worker records no profile attempts, and a
-- worker whose contract hash differs from the registered one gets every start
-- refused. It requires the registry of predeploy 20261116215328. Each listed
-- source must exist with its reviewed adapter and must not hold any registered
-- profile contract yet (so a replay or a drifted earlier registration is
-- refused); otherwise the whole migration refuses. It touches no table
-- 192134 guards.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.profile_capture_contracts') IS NULL THEN
    RAISE EXCEPTION 'profile capture contract registration requires 20261116215328';
  END IF;
END
$preflight$;

LOCK TABLE arena.sources IN SHARE MODE;
LOCK TABLE arena.profile_capture_contracts IN SHARE ROW EXCLUSIVE MODE;

-- Session-local seed (pg_temp); it disappears with the applying session.
CREATE TEMPORARY TABLE profile_capture_contract_seed (
  source_slug text PRIMARY KEY,
  adapter_slug text NOT NULL,
  capture_contract text NOT NULL,
  contract_sha256 text NOT NULL,
  timeframes smallint[] NOT NULL,
  attestable_metrics text[] NOT NULL
) ON COMMIT DROP;

INSERT INTO profile_capture_contract_seed VALUES
  ('binance_futures', 'binance', 'binance_futures-profile-capture@1',
   '5696e1805b3633e23d99f39710e680e511f172013abe4463335235f222a9726d',
   '{7,30,90}', '{mdd,total_positions}'),
  ('binance_spot', 'binance', 'binance_spot-profile-capture@1',
   '6396d1e0416474081964670075b5256e09a48123a0bd271aea3ee2af58295e12',
   '{7,30,90}', '{mdd}'),
  ('bybit_copytrade', 'bybit_copytrade', 'bybit_copytrade-profile-capture@1',
   'b9e04adab7fe2d1d31c54dadba418f71e56ba72a66c44abef8efd89bfa5bb212',
   '{7,30,90}', '{mdd,pnl,roi,sharpe,sortino,win_rate}'),
  ('blofin_futures', 'blofin', 'blofin_futures-profile-capture@1',
   'a7e735ea53fa5021291fd46dc3613909c99e782ccfa6bf151359fbc6ea8808cd',
   '{7,30,90}', '{total_positions,win_rate}'),
  ('toobit_futures', 'toobit', 'toobit_futures-profile-capture@1',
   'db50788a5a83b231d7e8a71145ec683e6fa2ed77b088f38a62b2e9261e46b9f8',
   '{7,30,90}', '{mdd}');

DO $register$
DECLARE
  v_seed record;
  v_source arena.sources%ROWTYPE;
BEGIN
  FOR v_seed IN SELECT * FROM profile_capture_contract_seed ORDER BY source_slug LOOP
    SELECT * INTO v_source FROM arena.sources WHERE slug = v_seed.source_slug;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'profile capture contract source % does not exist', v_seed.source_slug;
    END IF;
    IF v_source.adapter_slug IS DISTINCT FROM v_seed.adapter_slug THEN
      RAISE EXCEPTION 'profile capture contract source % uses adapter %, reviewed %',
        v_seed.source_slug, v_source.adapter_slug, v_seed.adapter_slug;
    END IF;
    IF EXISTS (
      SELECT 1 FROM arena.profile_capture_contracts AS contract
      WHERE contract.source_id = v_source.id
    ) THEN
      RAISE EXCEPTION 'source % already has a registered profile capture contract',
        v_seed.source_slug;
    END IF;

    INSERT INTO arena.profile_capture_contracts
      (source_id, capture_contract, contract_sha256, timeframes, attestable_metrics)
    VALUES
      (v_source.id, v_seed.capture_contract, v_seed.contract_sha256, v_seed.timeframes,
       v_seed.attestable_metrics);
  END LOOP;
END
$register$;

DO $postcheck$
DECLARE
  v_mismatch text;
BEGIN
  SELECT pg_catalog.string_agg(seed.source_slug, ', ' ORDER BY seed.source_slug)
  INTO v_mismatch
  FROM profile_capture_contract_seed AS seed
  JOIN arena.sources AS source ON source.slug = seed.source_slug
  WHERE (
    SELECT pg_catalog.count(*)
    FROM arena.profile_capture_contracts AS contract
    WHERE contract.source_id = source.id
  ) <> 1
  OR NOT EXISTS (
    SELECT 1
    FROM arena.profile_capture_contracts AS contract
    WHERE contract.source_id = source.id
      AND contract.capture_contract = seed.capture_contract
      AND contract.contract_sha256 = seed.contract_sha256
      AND contract.timeframes = seed.timeframes
      AND contract.attestable_metrics = seed.attestable_metrics
  );
  IF v_mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'profile capture contract registration did not land exactly: %', v_mismatch;
  END IF;
END
$postcheck$;

COMMIT;
