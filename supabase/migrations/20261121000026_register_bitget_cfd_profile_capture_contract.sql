-- Migration: 20261121000026_register_bitget_cfd_profile_capture_contract.sql
-- Description: Register the bitget_cfd Tier-B profile capture contract of the
--   worker's code registry (PROFILE_CAPTURE_CONTRACTS,
--   lib/ingest/profile-capture/contract.ts) in arena.profile_capture_contracts.
--
-- The row mirrors its code contract exactly: capture_contract name, the
-- strict-canonical sha256 of the contract document
-- (profileCaptureContractSha256), its timeframes and the sorted keys of its
-- metrics map.
--   bitget_cfd  (lib/ingest/adapters/bitget)  mdd, pnl, roi, total_positions, win_rate
--
-- The CFD board row carries no drawdown; the trader page's performance
-- response (POST /v1/trace/mt5/public/performance {portfolioId, cycleTime})
-- carries the exchange's own per-window maxDrawDown. Without this row the
-- worker's profile attempts for bitget_cfd are refused and its drawdown stays
-- unevidenced, so no bitget_cfd trader is publicly eligible.
--
-- Deliberately not registered: bitget_spot. Its trader page shows no drawdown
-- and its performance response has no drawdown field for any window (public
-- probe 2026-11-20), so there is no exchange value to attest.
--
-- POSTDEPLOY, after 20261117015119 and before 20261111192134: a registered
-- contract is only meaningful to the worker release that carries the same
-- contract document; the deployed worker fetches no CFD profile, and a worker
-- whose contract hash differs from the registered one gets every start
-- refused. It requires the registry of predeploy 20261116215328. bitget_cfd
-- must exist with its reviewed adapter and must not hold any registered
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
    RAISE EXCEPTION 'bitget_cfd profile capture contract registration requires 20261116215328';
  END IF;
END
$preflight$;

LOCK TABLE arena.sources IN SHARE MODE;
LOCK TABLE arena.profile_capture_contracts IN SHARE ROW EXCLUSIVE MODE;

DO $register$
DECLARE
  c_source_slug CONSTANT text := 'bitget_cfd';
  c_adapter_slug CONSTANT text := 'bitget';
  c_capture_contract CONSTANT text := 'bitget_cfd-profile-capture@1';
  c_contract_sha256 CONSTANT text :=
    '7ddc65e64c24019f5f6c29074f1a5495865f2b66fa884c6123fdf824adebff18';
  c_timeframes CONSTANT smallint[] := '{7,30,90}';
  c_attestable_metrics CONSTANT text[] := '{mdd,pnl,roi,total_positions,win_rate}';
  v_source arena.sources%ROWTYPE;
  v_registered integer;
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

  SELECT pg_catalog.count(*) INTO v_registered
  FROM arena.profile_capture_contracts AS contract
  WHERE contract.source_id = v_source.id
    AND contract.capture_contract = c_capture_contract
    AND contract.contract_sha256 = c_contract_sha256
    AND contract.timeframes = c_timeframes
    AND contract.attestable_metrics = c_attestable_metrics;
  IF v_registered <> 1 OR (
    SELECT pg_catalog.count(*) FROM arena.profile_capture_contracts AS contract
    WHERE contract.source_id = v_source.id
  ) <> 1 THEN
    RAISE EXCEPTION 'profile capture contract registration did not land exactly: %',
      c_source_slug;
  END IF;
END
$register$;

COMMIT;
