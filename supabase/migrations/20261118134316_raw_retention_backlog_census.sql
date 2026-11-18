-- Migration: 20261118134316_raw_retention_backlog_census.sql
-- Created: 2026-11-18T21:43:16Z
-- Description: Count-first RAW retention backlog census and an orphan-object
--   GC path for the raw-snapshots bucket.
--
-- Why. The raw-snapshots bucket holds millions of objects while
-- arena.raw_object_gc_queue is empty. The existing chain
-- (lib/ingest/raw.ts cleanupRawObjects, worker maintenance every 6h) is wired
-- end to end, but:
--   * it only runs inside the ingest worker, whose startup readiness gates
--     must pass before any job (maintenance included) is consumed;
--   * it retires at most 500 pointer rows per 6h run (2,000/day), far below
--     the ingest rate;
--   * it only sees objects that still have an arena.raw_objects pointer. An
--     object uploaded before its pointer INSERT (writeRawObject uploads first)
--     whose INSERT failed or whose transaction rolled back has no pointer and
--     can never enter the queue (raw_object_gc_queue.raw_object_id is NOT
--     NULL), so it stays in Storage forever.
--
-- What. Nothing here deletes anything by default.
--   * arena.raw_retention_settings: singleton; delete_enabled defaults false.
--     Flipping it is an owner/launch-driver production action. It also keeps
--     the resumable orphan-scan cursor and the tallies of the current pass.
--   * arena.raw_retention_census(days): count-only pointer-side census
--     (expired / pinned / eligible rows and bytes, queue depths).
--   * arena.scan_raw_storage_orphans(page, days, enqueue): walks
--     storage.objects of bucket raw-snapshots in name order, one bounded page
--     per call, and counts objects older than the window with no pointer row
--     and no queued GC obligation. Only with enqueue = true AND the switch on
--     does it record them in arena.raw_orphan_gc_queue (capped backlog).
--   * arena.claim_raw_orphan_gc_batch(limit): switch-gated; re-checks every
--     claimed path against arena.raw_objects and retires paths that regained
--     a pointer instead of handing them to Storage removal.
-- Storage objects are removed only by the worker through the Storage API,
-- from a queue row, exactly like the existing pointer GC outbox; nothing here
-- touches storage.objects rows.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.raw_objects') IS NULL
     OR pg_catalog.to_regclass('arena.raw_object_gc_queue') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_snapshots') IS NULL
     OR pg_catalog.to_regclass('arena.metric_trust_runs') IS NULL
     OR pg_catalog.to_regclass('arena.metric_trust_artifacts') IS NULL
     OR pg_catalog.to_regclass('storage.objects') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION
      'RAW retention census requires raw_objects, the GC outbox, snapshots, metric-trust evidence and storage.objects';
  END IF;
  IF NOT pg_catalog.has_table_privilege('storage.objects', 'SELECT') THEN
    RAISE EXCEPTION 'the migration owner cannot read storage.objects';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS arena.raw_retention_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  delete_enabled boolean NOT NULL DEFAULT false,
  orphan_scan_after text NOT NULL DEFAULT '',
  orphan_pass_started_at timestamptz,
  orphan_pass_objects bigint NOT NULL DEFAULT 0 CHECK (orphan_pass_objects >= 0),
  orphan_pass_bytes bigint NOT NULL DEFAULT 0 CHECK (orphan_pass_bytes >= 0),
  orphan_pass_orphans bigint NOT NULL DEFAULT 0 CHECK (orphan_pass_orphans >= 0),
  orphan_pass_orphan_bytes bigint NOT NULL DEFAULT 0 CHECK (orphan_pass_orphan_bytes >= 0),
  last_completed_orphan_pass jsonb,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp()
);

INSERT INTO arena.raw_retention_settings (singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS arena.raw_orphan_gc_queue (
  storage_path text PRIMARY KEY CHECK (pg_catalog.btrim(storage_path) <> ''),
  object_created_at timestamptz NOT NULL,
  object_bytes bigint CHECK (object_bytes IS NULL OR object_bytes >= 0),
  enqueued_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz,
  last_error text,
  CONSTRAINT raw_orphan_gc_queue_attempt_shape CHECK (
    (attempts = 0 AND last_attempt_at IS NULL AND last_error IS NULL)
    OR (
      attempts > 0
      AND last_attempt_at IS NOT NULL
      AND NULLIF(pg_catalog.btrim(last_error), '') IS NOT NULL
      AND last_attempt_at >= enqueued_at
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_arena_raw_orphan_gc_queue_retry
  ON arena.raw_orphan_gc_queue ((COALESCE(last_attempt_at, enqueued_at)), storage_path);

COMMENT ON TABLE arena.raw_retention_settings IS
  'RAW retention switch (delete_enabled, default false; owner-only) and the resumable orphan-scan cursor.';
COMMENT ON TABLE arena.raw_orphan_gc_queue IS
  'Durable obligations to remove raw-snapshots objects that never had (or no longer have) an arena.raw_objects pointer.';

-- Count-only pointer-side census. The eligibility predicate mirrors
-- lib/ingest/raw.ts rawObjectRetentionCandidateSql (trust evidence present).
CREATE OR REPLACE FUNCTION arena.raw_retention_census(p_retention_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_cutoff timestamptz;
  v_result jsonb;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 30 OR p_retention_days > 3650 THEN
    RAISE EXCEPTION 'RAW retention window must be between 30 and 3650 days'
      USING ERRCODE = '22023';
  END IF;
  v_cutoff := pg_catalog.statement_timestamp() - pg_catalog.make_interval(days => p_retention_days);

  WITH expired AS MATERIALIZED (
    SELECT raw.id,
           raw.bytes::bigint AS bytes,
           EXISTS (
             SELECT 1 FROM arena.leaderboard_snapshots AS snapshot
              WHERE snapshot.raw_object_id = raw.id
           ) AS snapshot_pinned,
           (
             EXISTS (
               SELECT 1 FROM arena.metric_trust_runs AS run
                WHERE run.population_raw_object_id = raw.id
                   OR run.manifest_raw_object_id = raw.id
             )
             OR EXISTS (
               SELECT 1 FROM arena.metric_trust_artifacts AS artifact
                WHERE artifact.raw_object_id = raw.id
             )
           ) AS trust_pinned
      FROM arena.raw_objects AS raw
     WHERE NOT raw.quarantined
       AND raw.fetched_at < v_cutoff
  )
  SELECT pg_catalog.jsonb_build_object(
    'contract', 'arena.raw-retention-census@1',
    'retention_days', p_retention_days,
    'cutoff', v_cutoff,
    'pointer_rows', (SELECT pg_catalog.count(*) FROM arena.raw_objects),
    'pointer_bytes', (SELECT COALESCE(pg_catalog.sum(bytes::bigint), 0) FROM arena.raw_objects),
    'quarantined_rows', (SELECT pg_catalog.count(*) FROM arena.raw_objects WHERE quarantined),
    'oldest_pointer_fetched_at', (SELECT pg_catalog.min(fetched_at) FROM arena.raw_objects),
    'expired_rows', (SELECT pg_catalog.count(*) FROM expired),
    'expired_bytes', (SELECT COALESCE(pg_catalog.sum(bytes), 0) FROM expired),
    'expired_snapshot_pinned_rows', (SELECT pg_catalog.count(*) FROM expired WHERE snapshot_pinned),
    'expired_trust_pinned_rows', (SELECT pg_catalog.count(*) FROM expired WHERE trust_pinned),
    'eligible_rows',
      (SELECT pg_catalog.count(*) FROM expired WHERE NOT snapshot_pinned AND NOT trust_pinned),
    'eligible_bytes',
      (SELECT COALESCE(pg_catalog.sum(bytes), 0) FROM expired
        WHERE NOT snapshot_pinned AND NOT trust_pinned),
    'gc_queue_rows', (SELECT pg_catalog.count(*) FROM arena.raw_object_gc_queue),
    'gc_queue_failed_rows',
      (SELECT pg_catalog.count(*) FROM arena.raw_object_gc_queue WHERE attempts > 0),
    'orphan_queue_rows', (SELECT pg_catalog.count(*) FROM arena.raw_orphan_gc_queue),
    'orphan_queue_failed_rows',
      (SELECT pg_catalog.count(*) FROM arena.raw_orphan_gc_queue WHERE attempts > 0),
    'delete_enabled', (SELECT settings.delete_enabled FROM arena.raw_retention_settings AS settings)
  )
  INTO v_result;
  RETURN v_result;
END;
$function$;

-- One bounded page of the orphan walk. Count-only unless p_enqueue, which
-- requires the switch. The cursor advances in both modes so a count-only pass
-- covers the whole bucket; an enqueue page that would overflow the backlog cap
-- leaves the cursor in place.
CREATE OR REPLACE FUNCTION arena.scan_raw_storage_orphans(
  p_page_size integer DEFAULT 50000,
  p_retention_days integer DEFAULT 30,
  p_enqueue boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  c_backlog_cap constant bigint := 200000;
  v_settings arena.raw_retention_settings%ROWTYPE;
  v_cutoff timestamptz;
  v_objects bigint;
  v_bytes bigint;
  v_orphans bigint;
  v_orphan_bytes bigint;
  v_last_name text;
  v_enqueued bigint := 0;
  v_backlog bigint;
  v_pass_complete boolean;
  v_completed jsonb;
BEGIN
  IF p_page_size IS NULL OR p_page_size < 1 OR p_page_size > 200000 THEN
    RAISE EXCEPTION 'orphan scan page must be between 1 and 200000 objects'
      USING ERRCODE = '22023';
  END IF;
  IF p_retention_days IS NULL OR p_retention_days < 30 OR p_retention_days > 3650 THEN
    RAISE EXCEPTION 'RAW retention window must be between 30 and 3650 days'
      USING ERRCODE = '22023';
  END IF;
  IF p_enqueue IS NULL THEN
    RAISE EXCEPTION 'orphan scan mode must be explicit' USING ERRCODE = '22023';
  END IF;
  v_cutoff := pg_catalog.statement_timestamp() - pg_catalog.make_interval(days => p_retention_days);

  SELECT settings.* INTO STRICT v_settings
    FROM arena.raw_retention_settings AS settings
   WHERE settings.singleton
   FOR UPDATE;

  IF p_enqueue THEN
    IF NOT v_settings.delete_enabled THEN
      RAISE EXCEPTION 'RAW retention delete switch is off' USING ERRCODE = '55000';
    END IF;
    SELECT pg_catalog.count(*) INTO v_backlog
      FROM (SELECT 1 FROM arena.raw_orphan_gc_queue LIMIT c_backlog_cap) AS capped;
    IF v_backlog + p_page_size > c_backlog_cap THEN
      RETURN pg_catalog.jsonb_build_object(
        'contract', 'arena.raw-storage-orphan-scan@1',
        'mode', 'enqueue',
        'skipped', 'orphan_backlog_cap',
        'orphan_queue_rows', v_backlog,
        'cursor', v_settings.orphan_scan_after
      );
    END IF;
  END IF;

  WITH page AS MATERIALIZED (
    SELECT object_row.name,
           object_row.created_at,
           CASE WHEN object_row.metadata->>'size' ~ '^[0-9]{1,18}$'
                THEN (object_row.metadata->>'size')::bigint END AS bytes
      FROM storage.objects AS object_row
     WHERE object_row.bucket_id = 'raw-snapshots'
       AND object_row.name > v_settings.orphan_scan_after
     ORDER BY object_row.name
     LIMIT p_page_size
  ),
  orphan AS MATERIALIZED (
    SELECT page.name, page.created_at, page.bytes
      FROM page
     WHERE page.created_at < v_cutoff
       AND NOT EXISTS (
         SELECT 1 FROM arena.raw_objects AS raw WHERE raw.storage_path = page.name
       )
       AND NOT EXISTS (
         SELECT 1 FROM arena.raw_object_gc_queue AS gc WHERE gc.storage_path = page.name
       )
  ),
  queued AS (
    INSERT INTO arena.raw_orphan_gc_queue (storage_path, object_created_at, object_bytes)
    SELECT orphan.name, orphan.created_at, orphan.bytes
      FROM orphan
     WHERE p_enqueue
    ON CONFLICT (storage_path) DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT pg_catalog.count(*) FROM page),
         (SELECT COALESCE(pg_catalog.sum(page.bytes), 0) FROM page),
         (SELECT pg_catalog.count(*) FROM orphan),
         (SELECT COALESCE(pg_catalog.sum(orphan.bytes), 0) FROM orphan),
         (SELECT pg_catalog.max(page.name) FROM page),
         (SELECT pg_catalog.count(*) FROM queued)
    INTO v_objects, v_bytes, v_orphans, v_orphan_bytes, v_last_name, v_enqueued;

  v_pass_complete := v_objects < p_page_size;

  UPDATE arena.raw_retention_settings AS settings
     SET orphan_pass_started_at = COALESCE(settings.orphan_pass_started_at, pg_catalog.statement_timestamp()),
         orphan_pass_objects = settings.orphan_pass_objects + v_objects,
         orphan_pass_bytes = settings.orphan_pass_bytes + v_bytes,
         orphan_pass_orphans = settings.orphan_pass_orphans + v_orphans,
         orphan_pass_orphan_bytes = settings.orphan_pass_orphan_bytes + v_orphan_bytes,
         orphan_scan_after = COALESCE(v_last_name, settings.orphan_scan_after),
         updated_at = pg_catalog.statement_timestamp()
   WHERE settings.singleton
  RETURNING pg_catalog.jsonb_build_object(
    'started_at', settings.orphan_pass_started_at,
    'completed_at', pg_catalog.statement_timestamp(),
    'retention_days', p_retention_days,
    'objects', settings.orphan_pass_objects,
    'bytes', settings.orphan_pass_bytes,
    'orphans', settings.orphan_pass_orphans,
    'orphan_bytes', settings.orphan_pass_orphan_bytes
  )
  INTO v_completed;

  IF v_pass_complete THEN
    UPDATE arena.raw_retention_settings AS settings
       SET last_completed_orphan_pass = v_completed,
           orphan_scan_after = '',
           orphan_pass_started_at = NULL,
           orphan_pass_objects = 0,
           orphan_pass_bytes = 0,
           orphan_pass_orphans = 0,
           orphan_pass_orphan_bytes = 0,
           updated_at = pg_catalog.statement_timestamp()
     WHERE settings.singleton;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'arena.raw-storage-orphan-scan@1',
    'mode', CASE WHEN p_enqueue THEN 'enqueue' ELSE 'count' END,
    'retention_days', p_retention_days,
    'page_objects', v_objects,
    'page_bytes', v_bytes,
    'page_orphans', v_orphans,
    'page_orphan_bytes', v_orphan_bytes,
    'enqueued', v_enqueued,
    'pass_complete', v_pass_complete,
    'pass', v_completed
  );
END;
$function$;

-- Switch-gated claim of one orphan batch. Paths that regained a pointer since
-- they were queued are retired here and never reach Storage removal.
CREATE OR REPLACE FUNCTION arena.claim_raw_orphan_gc_batch(p_limit integer DEFAULT 500)
RETURNS TABLE (storage_path text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'orphan GC batch must be between 1 and 1000' USING ERRCODE = '22023';
  END IF;
  IF NOT COALESCE(
       (SELECT settings.delete_enabled FROM arena.raw_retention_settings AS settings
         WHERE settings.singleton),
       false
     ) THEN
    RAISE EXCEPTION 'RAW retention delete switch is off' USING ERRCODE = '55000';
  END IF;

  RETURN QUERY
  WITH batch AS MATERIALIZED (
    SELECT queue_row.storage_path
      FROM arena.raw_orphan_gc_queue AS queue_row
     ORDER BY COALESCE(queue_row.last_attempt_at, queue_row.enqueued_at), queue_row.storage_path
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  ),
  repointed AS (
    DELETE FROM arena.raw_orphan_gc_queue AS queue_row
     USING batch
     WHERE queue_row.storage_path = batch.storage_path
       AND EXISTS (
         SELECT 1 FROM arena.raw_objects AS raw WHERE raw.storage_path = batch.storage_path
       )
    RETURNING queue_row.storage_path
  )
  SELECT batch.storage_path
    FROM batch
   WHERE NOT EXISTS (
     SELECT 1 FROM repointed WHERE repointed.storage_path = batch.storage_path
   )
   ORDER BY batch.storage_path;
END;
$function$;

ALTER TABLE arena.raw_retention_settings OWNER TO postgres;
ALTER TABLE arena.raw_orphan_gc_queue OWNER TO postgres;
ALTER FUNCTION arena.raw_retention_census(integer) OWNER TO postgres;
ALTER FUNCTION arena.scan_raw_storage_orphans(integer, integer, boolean) OWNER TO postgres;
ALTER FUNCTION arena.claim_raw_orphan_gc_batch(integer) OWNER TO postgres;

ALTER TABLE arena.raw_retention_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.raw_orphan_gc_queue ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE arena.raw_retention_settings, arena.raw_orphan_gc_queue
  FROM PUBLIC, anon, authenticated, service_role;
-- The worker reads the switch and, after a successful Storage removal,
-- retires the queue row or records the failure. The switch itself is owner-only.
GRANT SELECT ON TABLE arena.raw_retention_settings TO service_role;
GRANT SELECT, DELETE ON TABLE arena.raw_orphan_gc_queue TO service_role;
GRANT UPDATE (attempts, last_attempt_at, last_error)
  ON TABLE arena.raw_orphan_gc_queue TO service_role;

REVOKE ALL ON FUNCTION arena.raw_retention_census(integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.scan_raw_storage_orphans(integer, integer, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.claim_raw_orphan_gc_batch(integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION arena.raw_retention_census(integer) TO service_role;
GRANT EXECUTE ON FUNCTION arena.scan_raw_storage_orphans(integer, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION arena.claim_raw_orphan_gc_batch(integer) TO service_role;

DO $postflight$
BEGIN
  IF pg_catalog.has_table_privilege('service_role', 'arena.raw_retention_settings', 'UPDATE')
     OR pg_catalog.has_table_privilege('service_role', 'arena.raw_orphan_gc_queue', 'INSERT') THEN
    RAISE EXCEPTION 'service_role must not flip the switch or enqueue orphans directly';
  END IF;
END
$postflight$;

COMMIT;
