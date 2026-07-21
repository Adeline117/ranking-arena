-- Give the two population-level RAW roles one durable identity per canonical
-- acquisition run. Metric-level source payloads may remain one-to-many, but a
-- Tier-A population snapshot and its canonical manifest must be replayable
-- without creating a second competing pointer.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.raw_objects') IS NULL
     OR pg_catalog.to_regclass('arena.metric_trust_runs') IS NULL THEN
    RAISE EXCEPTION 'metric trust RAW foundations are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'arena'
       AND table_name = 'raw_objects'
       AND column_name = 'source_run_id'
  ) OR NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'arena'
       AND table_name = 'raw_objects'
       AND column_name = 'trust_artifact_role'
  ) THEN
    RAISE EXCEPTION 'metric trust RAW binding columns are missing';
  END IF;

  IF pg_catalog.to_regclass('arena.uidx_raw_population_manifest_per_run') IS NOT NULL
     OR pg_catalog.to_regclass('arena.uidx_raw_tier_a_population_per_run') IS NOT NULL THEN
    RAISE EXCEPTION 'metric trust RAW artifact identity indexes already exist';
  END IF;

  IF EXISTS (
    SELECT source_run_id
      FROM arena.raw_objects
     WHERE source_run_id IS NOT NULL
       AND trust_artifact_role = 'population_manifest'
     GROUP BY source_run_id
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate population manifests already exist';
  END IF;

  IF EXISTS (
    SELECT source_run_id
      FROM arena.raw_objects
     WHERE source_run_id IS NOT NULL
       AND trust_artifact_role = 'source_payload'
       AND job_type = 'tier_a'
       AND trader_id IS NULL
     GROUP BY source_run_id
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate Tier-A population payloads already exist';
  END IF;
END
$preflight$;

CREATE UNIQUE INDEX uidx_raw_population_manifest_per_run
  ON arena.raw_objects (source_run_id)
  WHERE source_run_id IS NOT NULL
    AND trust_artifact_role = 'population_manifest';

CREATE UNIQUE INDEX uidx_raw_tier_a_population_per_run
  ON arena.raw_objects (source_run_id)
  WHERE source_run_id IS NOT NULL
    AND trust_artifact_role = 'source_payload'
    AND job_type = 'tier_a'
    AND trader_id IS NULL;

COMMENT ON INDEX arena.uidx_raw_population_manifest_per_run IS
  'One canonical population manifest pointer per acquisition source_run_id.';

COMMENT ON INDEX arena.uidx_raw_tier_a_population_per_run IS
  'One population-level Tier-A source payload pointer per acquisition source_run_id.';

COMMIT;
