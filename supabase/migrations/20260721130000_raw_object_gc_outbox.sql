-- Durable RAW object garbage-collection handoff.
--
-- PostgreSQL is the ranking trust boundary while Supabase Storage is an
-- external system. Removing Storage first can leave a still-rankable RAW
-- pointer whose evidence blob no longer exists if the subsequent SQL DELETE
-- fails. The maintenance worker now atomically copies each eligible pointer
-- into this queue and deletes arena.raw_objects before touching Storage.
-- Storage failures therefore cost bytes only; they can never preserve a false
-- database claim that evidence remains recoverable.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.raw_objects') IS NULL THEN
    RAISE EXCEPTION 'arena.raw_objects is missing';
  END IF;

  IF pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'PostgREST roles are missing';
  END IF;

  IF pg_catalog.to_regclass('arena.raw_object_gc_queue') IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.protect_raw_object_gc_queue_update()'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'RAW object GC outbox already exists';
  END IF;
END
$preflight$;

CREATE TABLE arena.raw_object_gc_queue (
  -- Deliberately no FK to arena.raw_objects: the pointer and all dependent
  -- metric-trust rows are deleted in the same transaction that enqueues this
  -- durable Storage deletion obligation.
  raw_object_id bigint NOT NULL UNIQUE CHECK (raw_object_id > 0),
  storage_path text PRIMARY KEY CHECK (pg_catalog.btrim(storage_path) <> ''),
  content_hash text NOT NULL CHECK (
    content_hash ~ '^([0-9a-f]{32}|[0-9a-f]{64})$'
  ),
  enqueued_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz,
  last_error text,
  CONSTRAINT raw_object_gc_queue_attempt_shape CHECK (
    (
      attempts = 0
      AND last_attempt_at IS NULL
      AND last_error IS NULL
    )
    OR (
      attempts > 0
      AND last_attempt_at IS NOT NULL
      AND NULLIF(pg_catalog.btrim(last_error), '') IS NOT NULL
      AND last_attempt_at >= enqueued_at
    )
  )
);

-- New/unattempted work sorts first. Failed objects rotate behind work that has
-- not yet been tried, while enqueued_at + storage_path make every batch stable.
CREATE INDEX idx_arena_raw_object_gc_queue_retry
  ON arena.raw_object_gc_queue (
    (COALESCE(last_attempt_at, enqueued_at)),
    enqueued_at,
    storage_path
  );

CREATE FUNCTION arena.protect_raw_object_gc_queue_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.raw_object_id IS DISTINCT FROM OLD.raw_object_id
     OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.enqueued_at IS DISTINCT FROM OLD.enqueued_at THEN
    RAISE EXCEPTION 'RAW object GC identity cannot be mutated';
  END IF;

  IF NEW.attempts <> OLD.attempts + 1 THEN
    RAISE EXCEPTION 'RAW object GC attempts must increase exactly once per failure';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER protect_raw_object_gc_queue_before_update
BEFORE UPDATE ON arena.raw_object_gc_queue
FOR EACH ROW EXECUTE FUNCTION arena.protect_raw_object_gc_queue_update();

COMMENT ON TABLE arena.raw_object_gc_queue IS
  'Private durable obligations to remove already-detached RAW blobs from Storage.';
COMMENT ON COLUMN arena.raw_object_gc_queue.raw_object_id IS
  'Former arena.raw_objects identity retained without an FK after DB-first deletion.';
COMMENT ON COLUMN arena.raw_object_gc_queue.attempts IS
  'Number of failed Storage removal attempts; successful removals delete the queue row.';

ALTER TABLE arena.raw_object_gc_queue ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE arena.raw_object_gc_queue
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.protect_raw_object_gc_queue_update()
  FROM PUBLIC, anon, authenticated, service_role;

-- The worker may inspect work, enqueue immutable identities, record a failed
-- attempt, and acknowledge success by deleting the obligation. It cannot
-- rewrite the path/hash identity through its service-role database boundary.
GRANT SELECT, DELETE ON TABLE arena.raw_object_gc_queue TO service_role;
GRANT INSERT (raw_object_id, storage_path, content_hash)
  ON TABLE arena.raw_object_gc_queue TO service_role;
GRANT UPDATE (attempts, last_attempt_at, last_error)
  ON TABLE arena.raw_object_gc_queue TO service_role;

DO $postflight$
DECLARE
  v_service_role oid := pg_catalog.to_regrole('service_role');
BEGIN
  IF NOT (
    SELECT role.rolbypassrls
      FROM pg_catalog.pg_roles AS role
     WHERE role.oid = v_service_role
  ) THEN
    RAISE EXCEPTION 'service_role must bypass RLS for the private RAW object GC queue';
  END IF;

  IF NOT (
    SELECT relation.relrowsecurity
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid = 'arena.raw_object_gc_queue'::regclass
  ) THEN
    RAISE EXCEPTION 'RAW object GC queue RLS is not enabled';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
       v_service_role,
       'arena.raw_object_gc_queue',
       'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       v_service_role,
       'arena.raw_object_gc_queue',
       'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       v_service_role,
       'arena.raw_object_gc_queue',
       'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       v_service_role,
       'arena.raw_object_gc_queue',
       'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       v_service_role,
       'arena.raw_object_gc_queue',
       'TRUNCATE'
     )
     OR pg_catalog.has_table_privilege(
       v_service_role,
       'arena.raw_object_gc_queue',
       'REFERENCES'
     )
     OR pg_catalog.has_table_privilege(
       v_service_role,
       'arena.raw_object_gc_queue',
       'TRIGGER'
     ) THEN
    RAISE EXCEPTION 'RAW object GC queue table privileges drifted';
  END IF;

  IF NOT pg_catalog.has_column_privilege(
       v_service_role,
       'arena.raw_object_gc_queue',
       'raw_object_id',
       'INSERT'
     )
     OR NOT pg_catalog.has_column_privilege(
       v_service_role,
       'arena.raw_object_gc_queue',
       'storage_path',
       'INSERT'
     )
     OR NOT pg_catalog.has_column_privilege(
       v_service_role,
       'arena.raw_object_gc_queue',
       'content_hash',
       'INSERT'
     )
     OR pg_catalog.has_column_privilege(
       v_service_role,
       'arena.raw_object_gc_queue',
       'enqueued_at',
       'INSERT'
     ) THEN
    RAISE EXCEPTION 'RAW object GC queue insert privileges drifted';
  END IF;

  IF NOT pg_catalog.has_column_privilege(
       v_service_role,
       'arena.raw_object_gc_queue',
       'attempts',
       'UPDATE'
     )
     OR NOT pg_catalog.has_column_privilege(
       v_service_role,
       'arena.raw_object_gc_queue',
       'last_attempt_at',
       'UPDATE'
     )
     OR NOT pg_catalog.has_column_privilege(
       v_service_role,
       'arena.raw_object_gc_queue',
       'last_error',
       'UPDATE'
     )
     OR pg_catalog.has_column_privilege(
       v_service_role,
       'arena.raw_object_gc_queue',
       'storage_path',
       'UPDATE'
     ) THEN
    RAISE EXCEPTION 'RAW object GC queue update privileges drifted';
  END IF;

  IF pg_catalog.has_any_column_privilege(
       'anon',
       'arena.raw_object_gc_queue',
       'SELECT'
     )
     OR pg_catalog.has_any_column_privilege(
       'anon',
       'arena.raw_object_gc_queue',
       'INSERT'
     )
     OR pg_catalog.has_any_column_privilege(
       'anon',
       'arena.raw_object_gc_queue',
       'UPDATE'
     )
     OR pg_catalog.has_any_column_privilege(
       'anon',
       'arena.raw_object_gc_queue',
       'REFERENCES'
     )
     OR pg_catalog.has_any_column_privilege(
       'authenticated',
       'arena.raw_object_gc_queue',
       'SELECT'
     )
     OR pg_catalog.has_any_column_privilege(
       'authenticated',
       'arena.raw_object_gc_queue',
       'INSERT'
     )
     OR pg_catalog.has_any_column_privilege(
       'authenticated',
       'arena.raw_object_gc_queue',
       'UPDATE'
     )
     OR pg_catalog.has_any_column_privilege(
       'authenticated',
       'arena.raw_object_gc_queue',
       'REFERENCES'
     )
     OR pg_catalog.has_table_privilege(
       'anon',
       'arena.raw_object_gc_queue',
       'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'anon',
       'arena.raw_object_gc_queue',
       'TRUNCATE'
     )
     OR pg_catalog.has_table_privilege(
       'anon',
       'arena.raw_object_gc_queue',
       'TRIGGER'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated',
       'arena.raw_object_gc_queue',
       'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated',
       'arena.raw_object_gc_queue',
       'TRUNCATE'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated',
       'arena.raw_object_gc_queue',
       'TRIGGER'
     ) THEN
    RAISE EXCEPTION 'RAW object GC queue leaked to a public role';
  END IF;
END
$postflight$;

COMMIT;
