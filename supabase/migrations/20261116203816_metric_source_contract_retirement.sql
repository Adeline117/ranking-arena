-- Migration: 20261116203816_metric_source_contract_retirement.sql
-- Created: 2026-11-16T20:38:16Z
-- Description: A reviewed, append-only way to retire a metric source contract
--   version.
--
-- arena.metric_source_contracts is append-only (20260721120000): its rows can
-- never be updated or deleted, so a superseded version stayed active forever
-- and a v2 registration drifted from the single version the code registry
-- (lib/metric-trust.ts) holds per source. Retirement is therefore recorded as
-- its own append-only fact; nothing is ever updated or deleted.
--
-- * arena.metric_source_contract_retirements: one row per retired
--   (source_id, contract_version), naming the version that supersedes it.
--   The retired version must have active rows; the successor must have
--   active, unretired rows. A second retirement of the same version violates
--   the primary key. retired_at is the inserting transaction's time.
-- * A version is current when its rows are active and it is not retired.
--   The worker's contract resolution (loadMetricContracts) reads only current
--   rows.
-- * A deferred constraint trigger refuses, at commit, a source with more than
--   one current version: a new version commits only together with the
--   retirement of the old one, in one reviewed migration.
-- * A retired version can no longer gain rows, and a new metric-trust
--   observation can no longer cite it. Observations recorded before the
--   retirement are untouched and keep their contract.
--
-- PREDEPLOY. Inert until a version is retired: no retirement rows exist, the
-- current set equals the active set, and the deployed worker never reads the
-- new table. The worker that resolves contracts through it needs the table
-- before it ships. The preflight refuses if any source already holds two
-- active versions.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.metric_source_contracts') IS NULL
     OR pg_catalog.to_regclass('arena.metric_trust_observations') IS NULL
     OR pg_catalog.to_regprocedure('arena.reject_direct_metric_trust_mutation()') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'metric source contract retirement requires the metric-trust shadow gate (20260721120000)';
  END IF;

  IF pg_catalog.to_regclass('arena.metric_source_contract_retirements') IS NOT NULL THEN
    RAISE EXCEPTION 'metric source contract retirement already exists';
  END IF;
END
$preflight$;

LOCK TABLE arena.metric_source_contracts IN SHARE ROW EXCLUSIVE MODE;

DO $existing_versions$
DECLARE
  v_source_id smallint;
BEGIN
  SELECT contract.source_id
    INTO v_source_id
    FROM arena.metric_source_contracts AS contract
   WHERE contract.active
   GROUP BY contract.source_id
  HAVING pg_catalog.count(DISTINCT contract.contract_version) > 1
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'source % already holds more than one active metric contract version', v_source_id;
  END IF;
END
$existing_versions$;

CREATE TABLE arena.metric_source_contract_retirements (
  source_id smallint NOT NULL REFERENCES arena.sources(id) ON DELETE RESTRICT,
  contract_version text NOT NULL CHECK (pg_catalog.btrim(contract_version) <> ''),
  superseded_by_version text NOT NULL CHECK (pg_catalog.btrim(superseded_by_version) <> ''),
  reason text NOT NULL CHECK (pg_catalog.btrim(reason) <> ''),
  retired_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (source_id, contract_version),
  CHECK (superseded_by_version <> contract_version)
);

COMMENT ON TABLE arena.metric_source_contract_retirements IS
  'Append-only retirement of a metric source contract version. A version is current when its arena.metric_source_contracts rows are active and it has no row here.';

-- ── Retirement validation ──

CREATE FUNCTION arena.validate_metric_source_contract_retirement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  -- An observation insert that is already running commits first; later ones
  -- wait for this retirement and then see it.
  LOCK TABLE arena.metric_trust_observations IN SHARE MODE;

  IF NOT EXISTS (
    SELECT 1
      FROM arena.metric_source_contracts AS contract
     WHERE contract.source_id = NEW.source_id
       AND contract.contract_version = NEW.contract_version
       AND contract.active
  ) THEN
    RAISE EXCEPTION 'metric source contract version % of source % is not registered',
      NEW.contract_version, NEW.source_id
      USING ERRCODE = '23503';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM arena.metric_source_contracts AS contract
     WHERE contract.source_id = NEW.source_id
       AND contract.contract_version = NEW.superseded_by_version
       AND contract.active
  ) OR EXISTS (
    SELECT 1
      FROM arena.metric_source_contract_retirements AS retirement
     WHERE retirement.source_id = NEW.source_id
       AND retirement.contract_version = NEW.superseded_by_version
  ) THEN
    RAISE EXCEPTION 'superseding metric source contract version % of source % is not current',
      NEW.superseded_by_version, NEW.source_id
      USING ERRCODE = '23503';
  END IF;

  NEW.retired_at := pg_catalog.now();
  RETURN NEW;
END
$function$;

CREATE TRIGGER metric_source_contract_retirements_validate_before_insert
BEFORE INSERT ON arena.metric_source_contract_retirements
FOR EACH ROW EXECUTE FUNCTION arena.validate_metric_source_contract_retirement();

CREATE TRIGGER metric_source_contract_retirements_reject_direct_mutation
BEFORE UPDATE OR DELETE ON arena.metric_source_contract_retirements
FOR EACH ROW EXECUTE FUNCTION arena.reject_direct_metric_trust_mutation();
CREATE TRIGGER metric_source_contract_retirements_reject_truncate
BEFORE TRUNCATE ON arena.metric_source_contract_retirements
FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_direct_metric_trust_mutation();

-- ── A retired version gains no rows ──

CREATE FUNCTION arena.reject_retired_metric_source_contract_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM arena.metric_source_contract_retirements AS retirement
     WHERE retirement.source_id = NEW.source_id
       AND retirement.contract_version = NEW.contract_version
  ) THEN
    RAISE EXCEPTION 'metric source contract version % of source % is retired',
      NEW.contract_version, NEW.source_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER metric_source_contracts_reject_retired_version
BEFORE INSERT ON arena.metric_source_contracts
FOR EACH ROW EXECUTE FUNCTION arena.reject_retired_metric_source_contract_row();

-- ── One current version per source, checked at commit ──

CREATE FUNCTION arena.assert_single_current_metric_source_contract_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_versions text[];
BEGIN
  -- Serialize concurrent registrations so each check sees the other's rows.
  LOCK TABLE arena.metric_source_contracts IN SHARE ROW EXCLUSIVE MODE;

  SELECT pg_catalog.array_agg(DISTINCT contract.contract_version ORDER BY contract.contract_version)
    INTO v_versions
    FROM arena.metric_source_contracts AS contract
   WHERE contract.source_id = NEW.source_id
     AND contract.active
     AND NOT EXISTS (
       SELECT 1
         FROM arena.metric_source_contract_retirements AS retirement
        WHERE retirement.source_id = contract.source_id
          AND retirement.contract_version = contract.contract_version
     );

  IF pg_catalog.cardinality(v_versions) > 1 THEN
    RAISE EXCEPTION 'code/database contract drift: source % has current metric contract versions %; retire the superseded version in the same transaction',
      NEW.source_id, v_versions
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER metric_source_contracts_single_current_version
AFTER INSERT ON arena.metric_source_contracts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION arena.assert_single_current_metric_source_contract_version();

-- ── New evidence cannot cite a retired version ──

CREATE FUNCTION arena.reject_retired_metric_contract_observation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM arena.metric_source_contracts AS contract
      JOIN arena.metric_source_contract_retirements AS retirement
        ON retirement.source_id = contract.source_id
       AND retirement.contract_version = contract.contract_version
     WHERE contract.id = NEW.contract_id
  ) THEN
    RAISE EXCEPTION 'metric trust observation cites retired metric source contract %', NEW.contract_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER metric_trust_observations_reject_retired_contract
BEFORE INSERT ON arena.metric_trust_observations
FOR EACH ROW EXECUTE FUNCTION arena.reject_retired_metric_contract_observation();

-- ── Access ──

ALTER TABLE arena.metric_source_contract_retirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.metric_source_contract_retirements FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE arena.metric_source_contract_retirements
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE arena.metric_source_contract_retirements TO service_role;
CREATE POLICY metric_source_contract_retirements_service_read
  ON arena.metric_source_contract_retirements
  FOR SELECT TO service_role USING (true);

REVOKE ALL ON FUNCTION arena.validate_metric_source_contract_retirement()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.reject_retired_metric_source_contract_row()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.assert_single_current_metric_source_contract_version()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.reject_retired_metric_contract_observation()
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
