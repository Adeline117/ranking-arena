-- Migration: 20261120235710_register_blofin_spot_profile_capture_contract.sql
-- Description: Register the blofin_spot Tier-B profile capture contract of
--   the worker's code registry (BLOFIN_SPOT_PROFILE_CAPTURE,
--   lib/ingest/adapters/blofin/profile-capture-contract.ts) in
--   arena.profile_capture_contracts.
--
-- The spot board row has no win rate, and 20261117015119 deliberately left
-- blofin_spot unregistered because the adapter then read the futures copy
-- account for spot traders. The adapter now reads the spot detail endpoints
-- (/sapi/v1/spot_copy/trader/*), whose stat/indicators response supplies the
-- period win rate, trade count and drawdown. The row mirrors the code contract
-- exactly: capture_contract name, the strict-canonical sha256 of the contract
-- document (profileCaptureContractSha256), its timeframes and the sorted keys
-- of its metrics map:
--   blofin_spot  (lib/ingest/adapters/blofin)  mdd, total_positions, win_rate
--
-- POSTDEPLOY, after 20261117015119 and before 20261111192134: a registered
-- contract is only meaningful to the worker release that carries the same
-- contract document. A worker without the spot contract opens no spot profile
-- attempt (and does not crawl the spot profile at all); a worker whose
-- contract hash differs gets every start refused and publishes the profile
-- unattested. It requires the registry of predeploy 20261116215328. The
-- source must exist with its reviewed adapter and must not hold any registered
-- profile contract yet (so a replay or a drifted earlier registration is
-- refused); otherwise the whole migration refuses. It touches no table 192134
-- guards.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.profile_capture_contracts') IS NULL THEN
    RAISE EXCEPTION 'blofin_spot profile capture contract registration requires 20261116215328';
  END IF;
END
$preflight$;

LOCK TABLE arena.sources IN SHARE MODE;
LOCK TABLE arena.profile_capture_contracts IN SHARE ROW EXCLUSIVE MODE;

DO $register$
DECLARE
  c_source_slug constant text := 'blofin_spot';
  c_adapter_slug constant text := 'blofin';
  c_capture_contract constant text := 'blofin_spot-profile-capture@1';
  c_contract_sha256 constant text :=
    'de5d2067e3e331a874b6dcf65f89cb3f046c6dfae9e32bfe368664e940611ad7';
  c_timeframes constant smallint[] := '{7,30,90}';
  c_attestable_metrics constant text[] := '{mdd,total_positions,win_rate}';
  v_source arena.sources%ROWTYPE;
  v_landed integer;
BEGIN
  SELECT * INTO v_source FROM arena.sources WHERE slug = c_source_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile capture contract source % does not exist', c_source_slug;
  END IF;
  IF v_source.adapter_slug IS DISTINCT FROM c_adapter_slug THEN
    RAISE EXCEPTION 'profile capture contract source % uses adapter %, reviewed %',
      c_source_slug, v_source.adapter_slug, c_adapter_slug;
  END IF;
  IF EXISTS (
    SELECT 1 FROM arena.profile_capture_contracts AS contract
    WHERE contract.source_id = v_source.id
  ) THEN
    RAISE EXCEPTION 'source % already has a registered profile capture contract',
      c_source_slug;
  END IF;

  INSERT INTO arena.profile_capture_contracts
    (source_id, capture_contract, contract_sha256, timeframes, attestable_metrics)
  VALUES
    (v_source.id, c_capture_contract, c_contract_sha256, c_timeframes, c_attestable_metrics);

  SELECT pg_catalog.count(*) INTO v_landed
  FROM arena.profile_capture_contracts AS contract
  WHERE contract.source_id = v_source.id;
  IF v_landed <> 1 OR NOT EXISTS (
    SELECT 1
    FROM arena.profile_capture_contracts AS contract
    WHERE contract.source_id = v_source.id
      AND contract.capture_contract = c_capture_contract
      AND contract.contract_sha256 = c_contract_sha256
      AND contract.timeframes = c_timeframes
      AND contract.attestable_metrics = c_attestable_metrics
  ) THEN
    RAISE EXCEPTION 'profile capture contract registration did not land exactly: %',
      c_source_slug;
  END IF;
END
$register$;

COMMIT;
