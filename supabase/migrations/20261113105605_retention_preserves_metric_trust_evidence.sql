-- Retention must never cascade-delete metric-trust provenance.
--
-- 20260721120000 declared every evidence edge into RAW objects, snapshots and
-- snapshot entries ON DELETE CASCADE. The worker's routine retention
-- (cleanupRawObjects(30), downsampleSnapshotEntries(7)) therefore silently
-- deleted trust runs, observations and artifacts together with the RAW objects
-- / entries they prove, including the batch behind the current serving head
-- once a source stops crawling for 30 days. The audit/replay chain broke.
--
-- Each of those edges becomes ON DELETE RESTRICT (same name, same columns,
-- same referenced key; only the delete action changes). Retention code now
-- skips evidence-pinned rows (lib/ingest/raw.ts rawObjectRetentionCandidateSql,
-- lib/ingest/serving/series.ts snapshotEntryDownsampleSql), and any other
-- delete of pinned evidence fails loudly instead of erasing provenance.
-- Internal edges (observation -> run, artifact -> observation) stay CASCADE:
-- removing a trust run on purpose still removes its own observations.
--
-- Lookup indexes for the new retention predicates are added.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '10min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.metric_trust_runs') IS NULL
     OR pg_catalog.to_regclass('arena.metric_trust_observations') IS NULL
     OR pg_catalog.to_regclass('arena.metric_trust_artifacts') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_snapshots') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_entries') IS NULL THEN
    RAISE EXCEPTION 'trust evidence retention requires the metric-trust substrate (20260721120000)';
  END IF;
END
$preflight$;

DO $restrict_evidence_edges$
DECLARE
  v_edge record;
  v_constraint record;
  v_definition text;
  v_changed integer := 0;
BEGIN
  FOR v_edge IN
    SELECT *
    FROM (VALUES
      ('arena.metric_trust_runs', 'arena.raw_objects', ARRAY['population_raw_object_id']),
      ('arena.metric_trust_runs', 'arena.raw_objects', ARRAY['manifest_raw_object_id']),
      ('arena.metric_trust_runs', 'arena.leaderboard_snapshots', ARRAY['snapshot_id']),
      ('arena.metric_trust_observations', 'arena.leaderboard_snapshots', ARRAY['snapshot_id']),
      ('arena.metric_trust_observations', 'arena.leaderboard_entries',
        ARRAY['snapshot_scraped_at', 'snapshot_id', 'trader_id']),
      ('arena.metric_trust_artifacts', 'arena.raw_objects', ARRAY['raw_object_id'])
    ) AS edge(child, parent, columns)
  LOOP
    SELECT constraint_row.conname, constraint_row.confdeltype
    INTO v_constraint
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = v_edge.child::pg_catalog.regclass
      AND constraint_row.confrelid = v_edge.parent::pg_catalog.regclass
      AND constraint_row.conparentid = 0
      AND (
        SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY key.ordinality)
        FROM pg_catalog.unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = constraint_row.conrelid
         AND attribute.attnum = key.attnum
      ) = v_edge.columns;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'evidence edge %(%) -> % not found', v_edge.child, v_edge.columns, v_edge.parent;
    END IF;
    IF v_constraint.confdeltype = 'r' THEN
      CONTINUE; -- already RESTRICT (idempotent replay)
    END IF;
    IF v_constraint.confdeltype <> 'c' THEN
      RAISE EXCEPTION 'evidence edge % has unexpected delete action %',
        v_constraint.conname, v_constraint.confdeltype;
    END IF;

    SELECT pg_catalog.pg_get_constraintdef(constraint_row.oid)
    INTO STRICT v_definition
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_edge.child::pg_catalog.regclass
      AND constraint_row.conname = v_constraint.conname;
    IF pg_catalog.strpos(v_definition, 'ON DELETE CASCADE') = 0 THEN
      RAISE EXCEPTION 'evidence edge % definition drifted: %', v_constraint.conname, v_definition;
    END IF;

    EXECUTE pg_catalog.format(
      'ALTER TABLE %s DROP CONSTRAINT %I',
      v_edge.child,
      v_constraint.conname
    );
    EXECUTE pg_catalog.format(
      'ALTER TABLE %s ADD CONSTRAINT %I %s',
      v_edge.child,
      v_constraint.conname,
      pg_catalog.replace(v_definition, 'ON DELETE CASCADE', 'ON DELETE RESTRICT')
    );
    v_changed := v_changed + 1;
  END LOOP;
  RAISE NOTICE 'metric-trust evidence edges switched to RESTRICT: %', v_changed;
END
$restrict_evidence_edges$;

CREATE INDEX IF NOT EXISTS idx_arena_metric_trust_runs_population_raw
  ON arena.metric_trust_runs (population_raw_object_id);
CREATE INDEX IF NOT EXISTS idx_arena_metric_trust_runs_manifest_raw
  ON arena.metric_trust_runs (manifest_raw_object_id);
CREATE INDEX IF NOT EXISTS idx_arena_metric_trust_observations_entry
  ON arena.metric_trust_observations (snapshot_id, trader_id, snapshot_scraped_at);

DO $postflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conparentid = 0
      AND constraint_row.conrelid IN (
        'arena.metric_trust_runs'::pg_catalog.regclass,
        'arena.metric_trust_observations'::pg_catalog.regclass,
        'arena.metric_trust_artifacts'::pg_catalog.regclass
      )
      AND constraint_row.confrelid IN (
        'arena.raw_objects'::pg_catalog.regclass,
        'arena.leaderboard_snapshots'::pg_catalog.regclass,
        'arena.leaderboard_entries'::pg_catalog.regclass
      )
      AND constraint_row.confdeltype <> 'r'
  ) THEN
    RAISE EXCEPTION 'a metric-trust evidence edge still cascades';
  END IF;
END
$postflight$;

COMMIT;
