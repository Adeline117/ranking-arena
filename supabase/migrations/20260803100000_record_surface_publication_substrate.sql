-- Private, immutable publication evidence for record surfaces.
--
-- This first phase deliberately exposes no writer or reader RPC. Existing
-- position-history rows remain unverified (verified_publication_id IS NULL),
-- and the existing SECURITY DEFINER records RPC remains the only public read
-- path. A later migration installs the atomic evidence-bound writer.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('20260803-record-surface-publication-substrate', 0)
);

DO $preflight$
DECLARE
  v_public_policy_roles oid[];
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL
     OR pg_catalog.to_regclass('arena.position_history') IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'record publication substrate requires PG17 and the Arena identity, RAW, history, and API-role substrate';
  END IF;

  IF pg_catalog.to_regclass('arena.record_surface_publications') IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.reject_record_surface_publication_mutation()'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.protect_record_surface_publication_raw_object()'
     ) IS NOT NULL
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute_row
       WHERE attribute_row.attrelid =
           'arena.position_history'::pg_catalog.regclass
         AND attribute_row.attname = 'verified_publication_id'
         AND attribute_row.attnum > 0
         AND NOT attribute_row.attisdropped
     ) THEN
    RAISE EXCEPTION 'record publication substrate is already or partially installed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute_row
    WHERE attribute_row.attrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND attribute_row.attname = 'source_run_id'
      AND attribute_row.atttypid = 'pg_catalog.text'::pg_catalog.regtype
      AND attribute_row.attnum > 0
      AND NOT attribute_row.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute_row
    WHERE attribute_row.attrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND attribute_row.attname = 'trust_artifact_role'
      AND attribute_row.atttypid = 'pg_catalog.text'::pg_catalog.regtype
      AND attribute_row.attnum > 0
      AND NOT attribute_row.attisdropped
  ) THEN
    RAISE EXCEPTION 'record publication substrate requires RAW trust identity columns';
  END IF;

  SELECT policy_row.polroles
  INTO STRICT v_public_policy_roles
  FROM pg_catalog.pg_policy AS policy_row
  WHERE policy_row.polrelid = 'arena.position_history'::pg_catalog.regclass
    AND policy_row.polname = 'Public read position_history';

  IF v_public_policy_roles IS DISTINCT FROM ARRAY[
       'anon'::pg_catalog.regrole::oid,
       'authenticated'::pg_catalog.regrole::oid
     ]::oid[]
     OR NOT pg_catalog.has_table_privilege(
       'anon', 'arena.position_history', 'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'authenticated', 'arena.position_history', 'SELECT'
     ) THEN
    RAISE EXCEPTION 'position-history public read boundary drifted';
  END IF;
END
$preflight$;

LOCK TABLE ONLY arena.sources IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.traders IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.raw_objects IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.position_history IN ACCESS EXCLUSIVE MODE;

-- Future Arena tables and runtime-created partitions must be private until a
-- migration grants an intentional API surface. Existing grants are unchanged
-- except for position_history below.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA arena
  REVOKE SELECT ON TABLES FROM anon, authenticated;

CREATE TABLE arena.record_surface_publications (
  publication_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL
    REFERENCES arena.sources(id) ON DELETE RESTRICT,
  trader_id bigint NOT NULL
    REFERENCES arena.traders(id) ON DELETE RESTRICT,
  surface text NOT NULL CHECK (surface = 'position_history'),
  lane text NOT NULL CHECK (lane IN ('tier_b', 'history_backfill', 'replay')),
  source_run_id text NOT NULL CHECK (
    source_run_id ~ '^[0-9a-f]{64}$'
    AND source_run_id <> pg_catalog.repeat('0', 64)
  ),
  raw_object_id bigint
    REFERENCES arena.raw_objects(id) ON DELETE SET NULL,
  raw_storage_path text NOT NULL CHECK (
    raw_storage_path = pg_catalog.btrim(raw_storage_path)
    AND pg_catalog.char_length(raw_storage_path) BETWEEN 1 AND 1024
  ),
  raw_content_hash text NOT NULL CHECK (
    raw_content_hash ~ '^[0-9a-f]{64}$'
    AND raw_content_hash = source_run_id
  ),
  raw_fetched_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(raw_fetched_at)),
  observed_at timestamptz NOT NULL CHECK (
    pg_catalog.isfinite(observed_at)
    AND observed_at = raw_fetched_at
  ),
  source_as_of timestamptz CHECK (source_as_of IS NULL),
  published_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp()
    CHECK (
      pg_catalog.isfinite(published_at)
      AND observed_at <= published_at + interval '5 minutes'
    ),
  previous_publication_id bigint
    REFERENCES arena.record_surface_publications(publication_id)
    ON DELETE RESTRICT,
  evidence_contract text NOT NULL CHECK (
    evidence_contract = 'arena.position-history-publication-evidence@1'
  ),
  data_contract text NOT NULL CHECK (
    data_contract = 'arena.ingest.history-acquisition-artifact@1'
  ),
  verifier_contract text NOT NULL CHECK (
    verifier_contract ~
      '^arena\.ingest\.history-terminal-verifier\.[a-z0-9_]+(?:\.[a-z0-9_]+)*@[1-9][0-9]*$'
  ),
  publisher_contract text NOT NULL CHECK (
    publisher_contract ~
      '^arena\.ingest\.position-history-publisher\.[a-z0-9_]+(?:\.[a-z0-9_]+)*@[1-9][0-9]*$'
  ),
  scan_terminal_state text NOT NULL CHECK (
    scan_terminal_state IN ('exhausted', 'cursor_overlap')
  ),
  starting_cursor timestamptz CHECK (
    starting_cursor IS NULL OR pg_catalog.isfinite(starting_cursor)
  ),
  effective_cursor_after timestamptz CHECK (
    effective_cursor_after IS NULL OR pg_catalog.isfinite(effective_cursor_after)
  ),
  overlap_event_at timestamptz CHECK (
    overlap_event_at IS NULL OR pg_catalog.isfinite(overlap_event_at)
  ),
  page_count integer NOT NULL CHECK (page_count > 0 AND page_count <= 100000),
  parsed_row_count integer NOT NULL CHECK (
    parsed_row_count >= 0 AND parsed_row_count <= 10000000
  ),
  row_set_sha256 text NOT NULL CHECK (
    row_set_sha256 ~ '^[0-9a-f]{64}$'
  ),
  termination jsonb NOT NULL CHECK (
    pg_catalog.jsonb_typeof(termination) = 'object'
    AND termination->>'evidence_state' IS NOT DISTINCT FROM 'verified'
    AND termination->'blocker_reasons' IS NOT DISTINCT FROM '[]'::jsonb
    AND termination->>'scan_terminal_state' IS NOT DISTINCT FROM scan_terminal_state
    AND termination->>'verifier_contract' IS NOT DISTINCT FROM verifier_contract
  ),
  CONSTRAINT record_surface_publication_not_self_predecessor
    CHECK (previous_publication_id IS NULL OR previous_publication_id <> publication_id),
  CONSTRAINT record_surface_publication_terminal_shape CHECK (
    (
      scan_terminal_state = 'exhausted'
      AND starting_cursor IS NULL
      AND overlap_event_at IS NULL
      AND termination->'terminal_cursor_value' IS NOT DISTINCT FROM 'null'::jsonb
      AND termination->'overlap_event_at' IS NOT DISTINCT FROM 'null'::jsonb
    )
    OR
    (
      scan_terminal_state = 'cursor_overlap'
      AND starting_cursor IS NOT NULL
      AND effective_cursor_after IS NOT NULL
      AND overlap_event_at IS NOT NULL
      AND overlap_event_at <= starting_cursor
      AND (termination->>'terminal_cursor_value')::timestamptz
          IS NOT DISTINCT FROM starting_cursor
      AND (termination->>'overlap_event_at')::timestamptz
          IS NOT DISTINCT FROM overlap_event_at
    )
  ),
  CONSTRAINT record_surface_publication_cursor_monotonic CHECK (
    effective_cursor_after IS NULL
    OR starting_cursor IS NULL
    OR effective_cursor_after >= starting_cursor
  ),
  UNIQUE (source_id, trader_id, surface, source_run_id)
);

CREATE UNIQUE INDEX uidx_record_surface_publication_raw_object
  ON arena.record_surface_publications (raw_object_id)
  WHERE raw_object_id IS NOT NULL;

CREATE INDEX idx_record_surface_publication_latest
  ON arena.record_surface_publications (
    source_id,
    trader_id,
    surface,
    observed_at DESC,
    publication_id DESC
  );

ALTER TABLE arena.position_history
  ADD COLUMN verified_publication_id bigint,
  ADD CONSTRAINT position_history_verified_publication_fkey
    FOREIGN KEY (verified_publication_id)
    REFERENCES arena.record_surface_publications(publication_id)
    ON DELETE RESTRICT;

CREATE INDEX idx_arena_position_history_verified_trader_page
  ON arena.position_history (trader_id, closed_at DESC, dedupe_hash DESC)
  WHERE verified_publication_id IS NOT NULL;

CREATE FUNCTION arena.reject_record_surface_publication_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  -- The RAW GC foreign key may tombstone only the live pointer. The receipt's
  -- denormalized path, digest, source run, and clocks remain immutable.
  IF TG_OP = 'UPDATE'
     AND pg_catalog.pg_trigger_depth() > 1
     AND OLD.raw_object_id IS NOT NULL
     AND NEW.raw_object_id IS NULL
     AND (pg_catalog.to_jsonb(NEW) - 'raw_object_id') =
         (pg_catalog.to_jsonb(OLD) - 'raw_object_id') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'record surface publication receipts are immutable'
    USING ERRCODE = '55000';
END
$function$;

CREATE TRIGGER record_surface_publication_reject_update_delete
BEFORE UPDATE OR DELETE ON arena.record_surface_publications
FOR EACH ROW EXECUTE FUNCTION arena.reject_record_surface_publication_mutation();

CREATE TRIGGER record_surface_publication_reject_truncate
BEFORE TRUNCATE ON arena.record_surface_publications
FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_record_surface_publication_mutation();

CREATE FUNCTION arena.protect_record_surface_publication_raw_object()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM arena.record_surface_publications AS publication
    WHERE publication.raw_object_id = OLD.id
  ) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.quarantined THEN
      RAISE EXCEPTION 'quarantined record publication RAW evidence cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.job_type IS DISTINCT FROM OLD.job_type
     OR NEW.trader_id IS DISTINCT FROM OLD.trader_id
     OR NEW.timeframe IS DISTINCT FROM OLD.timeframe
     OR NEW.fetched_at IS DISTINCT FROM OLD.fetched_at
     OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
     OR NEW.bytes IS DISTINCT FROM OLD.bytes
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.meta IS DISTINCT FROM OLD.meta
     OR NEW.source_run_id IS DISTINCT FROM OLD.source_run_id
     OR NEW.trust_artifact_role IS DISTINCT FROM OLD.trust_artifact_role
     OR (
       NEW.quarantined IS DISTINCT FROM OLD.quarantined
       AND NOT (NOT OLD.quarantined AND NEW.quarantined)
     ) THEN
    RAISE EXCEPTION 'record publication RAW evidence % cannot be mutated', OLD.id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER protect_record_surface_publication_raw_before_write
BEFORE UPDATE OR DELETE ON arena.raw_objects
FOR EACH ROW EXECUTE FUNCTION arena.protect_record_surface_publication_raw_object();

ALTER TABLE arena.record_surface_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.record_surface_publications FORCE ROW LEVEL SECURITY;

DROP POLICY "Public read position_history" ON arena.position_history;
REVOKE SELECT ON TABLE arena.position_history FROM PUBLIC, anon, authenticated;

DO $lock_down_partitions$
DECLARE
  v_partition regclass;
BEGIN
  FOR v_partition IN
    SELECT inheritance.inhrelid::pg_catalog.regclass
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhparent = 'arena.position_history'::pg_catalog.regclass
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE SELECT ON TABLE %s FROM PUBLIC, anon, authenticated',
      v_partition
    );
    EXECUTE pg_catalog.format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', v_partition);
  END LOOP;
END
$lock_down_partitions$;

ALTER TABLE arena.record_surface_publications OWNER TO postgres;
ALTER FUNCTION arena.reject_record_surface_publication_mutation() OWNER TO postgres;
ALTER FUNCTION arena.protect_record_surface_publication_raw_object() OWNER TO postgres;

REVOKE ALL ON TABLE arena.record_surface_publications
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE arena.record_surface_publications_publication_id_seq
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.reject_record_surface_publication_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.protect_record_surface_publication_raw_object()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE arena.record_surface_publications IS
  'Private immutable proof that one verified RAW acquisition was atomically published. Not public API; normal RAW GC tombstones raw_object_id while retaining denormalized evidence.';
COMMENT ON COLUMN arena.position_history.verified_publication_id IS
  'NULL means unverified/legacy and must never be served as complete or used for ranking. Non-NULL bindings are written only by the evidence-bound publication RPC.';

DO $postflight$
BEGIN
  IF pg_catalog.has_table_privilege(
       'anon', 'arena.position_history', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'arena.position_history', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.record_surface_publications', 'SELECT'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS table_row
       WHERE table_row.oid =
           'arena.record_surface_publications'::pg_catalog.regclass
         AND table_row.relowner = 'postgres'::pg_catalog.regrole
         AND table_row.relrowsecurity
         AND table_row.relforcerowsecurity
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy_row
       WHERE policy_row.polrelid IN (
         'arena.record_surface_publications'::pg_catalog.regclass,
         'arena.position_history'::pg_catalog.regclass
       )
     ) THEN
    RAISE EXCEPTION 'record publication substrate privacy postflight failed';
  END IF;
END
$postflight$;

COMMIT;
