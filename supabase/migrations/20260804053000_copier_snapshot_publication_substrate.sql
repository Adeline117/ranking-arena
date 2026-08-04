-- Private, immutable snapshot evidence for copier tables.
--
-- Copier rows are snapshots, not append-only history events. Keep this sibling
-- contract separate from record_surface_publications, whose verified terminal
-- semantics are intentionally restricted to position_history.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    '20260804-copier-snapshot-publication-substrate',
    0
  )
);

DO $preflight$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL
     OR pg_catalog.to_regclass('arena.copier_records') IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'copier snapshot substrate requires PG17 and Arena identity, RAW, copier, and API-role foundations';
  END IF;

  IF pg_catalog.to_regclass(
       'arena.copier_snapshot_publications'
     ) IS NOT NULL
     OR pg_catalog.to_regclass('arena.copier_snapshot_rows') IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.reject_copier_snapshot_publication_mutation()'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.reject_copier_snapshot_row_mutation()'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.protect_copier_snapshot_raw_object()'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'copier snapshot substrate is already or partially installed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND attribute.attname = 'storage_path'
      AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND attribute.attname = 'content_hash'
      AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND attribute.attname = 'fetched_at'
      AND attribute.atttypid =
          'pg_catalog.timestamptz'::pg_catalog.regtype
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND attribute.attname = 'quarantined'
      AND attribute.atttypid = 'pg_catalog.bool'::pg_catalog.regtype
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND attribute.attname = 'source_run_id'
      AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND attribute.attname = 'trust_artifact_role'
      AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'copier snapshot substrate requires RAW identity, clock, and quarantine columns';
  END IF;

  IF pg_catalog.has_table_privilege(
       'anon', 'arena.copier_records', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'arena.copier_records', 'SELECT'
     ) THEN
    RAISE EXCEPTION 'legacy copier row privacy boundary drifted';
  END IF;
END
$preflight$;

LOCK TABLE ONLY arena.sources IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.traders IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.raw_objects IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE arena.copier_snapshot_publications (
  publication_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL
    REFERENCES arena.sources(id) ON DELETE RESTRICT,
  trader_id bigint NOT NULL
    REFERENCES arena.traders(id) ON DELETE RESTRICT,
  lane text NOT NULL CHECK (lane IN ('tier_b', 'tier_c')),
  source_run_id text NOT NULL CHECK (
    source_run_id ~ '^[0-9a-f]{64}$'
    AND source_run_id <> pg_catalog.repeat('0', 64)
  ),
  live_raw_object_id bigint
    REFERENCES arena.raw_objects(id) ON DELETE SET NULL,
  raw_object_id_at_publication bigint NOT NULL CHECK (
    raw_object_id_at_publication > 0
  ),
  raw_storage_path text NOT NULL CHECK (
    raw_storage_path = pg_catalog.btrim(raw_storage_path)
    AND pg_catalog.char_length(raw_storage_path) BETWEEN 1 AND 1024
  ),
  raw_content_hash text NOT NULL CHECK (
    raw_content_hash ~ '^[0-9a-f]{64}$'
  ),
  raw_fetched_at timestamptz NOT NULL CHECK (
    pg_catalog.isfinite(raw_fetched_at)
  ),
  observed_at timestamptz NOT NULL CHECK (
    pg_catalog.isfinite(observed_at)
  ),
  published_at timestamptz NOT NULL
    DEFAULT pg_catalog.statement_timestamp()
    CHECK (
      pg_catalog.isfinite(published_at)
      AND observed_at <= published_at + interval '5 minutes'
      AND raw_fetched_at <= published_at + interval '5 minutes'
    ),
  previous_publication_id bigint
    REFERENCES arena.copier_snapshot_publications(publication_id)
    ON DELETE RESTRICT,
  scan_terminal_state text NOT NULL CHECK (
    scan_terminal_state IN (
      'stream_exhausted_unverified',
      'caller_limited'
    )
  ),
  caller_limited boolean NOT NULL,
  page_count integer NOT NULL CHECK (
    page_count > 0 AND page_count <= 100000
  ),
  parsed_row_count integer NOT NULL CHECK (
    parsed_row_count >= 0 AND parsed_row_count <= 10000000
  ),
  source_reported_row_count integer CHECK (
    source_reported_row_count IS NULL
    OR source_reported_row_count >= parsed_row_count
  ),
  source_depth text NOT NULL CHECK (
    source_depth IN ('full', 'top10', 'top3_preview')
  ),
  currency text NOT NULL CHECK (
    currency IN ('USDT', 'USDx', 'USDC', 'USD')
  ),
  row_set_sha256 text NOT NULL CHECK (
    row_set_sha256 ~ '^[0-9a-f]{64}$'
  ),
  evidence_contract text NOT NULL CHECK (
    evidence_contract = 'arena.copier-snapshot-publication@1'
  ),
  privacy_contract text NOT NULL CHECK (
    privacy_contract = 'arena.copier-histogram-k-anonymity@1'
  ),
  data_contract text NOT NULL CHECK (
    data_contract = 'arena.ingest.copier-snapshot-artifact@1'
  ),
  parser_contract text NOT NULL CHECK (
    parser_contract = 'arena.ingest.copier-parser@1'
  ),
  row_hash_contract text NOT NULL CHECK (
    row_hash_contract = 'arena.ingest.copier-row-set.strict-canonical-json@1'
  ),
  publisher_contract text NOT NULL CHECK (
    publisher_contract = 'arena.ingest.copier-snapshot-publisher@1'
  ),
  histogram_min_cohort smallint NOT NULL DEFAULT 10 CHECK (
    histogram_min_cohort = 10
  ),
  histogram_min_bucket smallint NOT NULL DEFAULT 5 CHECK (
    histogram_min_bucket = 5
  ),
  CONSTRAINT copier_snapshot_publication_not_self_predecessor CHECK (
    previous_publication_id IS NULL
    OR previous_publication_id <> publication_id
  ),
  CONSTRAINT copier_snapshot_publication_raw_identity CHECK (
    raw_content_hash = source_run_id
    AND (
      live_raw_object_id IS NULL
      OR live_raw_object_id = raw_object_id_at_publication
    )
  ),
  CONSTRAINT copier_snapshot_publication_terminal_shape CHECK (
    caller_limited = (scan_terminal_state = 'caller_limited')
  ),
  CONSTRAINT copier_snapshot_tier_b_not_caller_limited CHECK (
    lane <> 'tier_b'
    OR scan_terminal_state = 'stream_exhausted_unverified'
  ),
  UNIQUE (
    source_id,
    trader_id,
    lane,
    source_run_id,
    parser_contract
  )
);

CREATE UNIQUE INDEX uidx_copier_snapshot_publication_raw_object
  ON arena.copier_snapshot_publications (live_raw_object_id, parser_contract)
  WHERE live_raw_object_id IS NOT NULL;

CREATE UNIQUE INDEX uidx_copier_snapshot_publication_predecessor
  ON arena.copier_snapshot_publications (previous_publication_id)
  WHERE previous_publication_id IS NOT NULL;

CREATE INDEX idx_copier_snapshot_publication_latest
  ON arena.copier_snapshot_publications (
    source_id,
    trader_id,
    observed_at DESC,
    publication_id DESC
  );

CREATE TABLE arena.copier_snapshot_rows (
  publication_id bigint NOT NULL
    REFERENCES arena.copier_snapshot_publications(publication_id)
    ON DELETE RESTRICT,
  row_ordinal integer NOT NULL CHECK (
    row_ordinal >= 0 AND row_ordinal <= 9999999
  ),
  source_event_at timestamptz NOT NULL CHECK (
    pg_catalog.isfinite(source_event_at)
  ),
  copier_label text CHECK (
    copier_label IS NULL
    OR (
      copier_label = pg_catalog.btrim(copier_label)
      AND pg_catalog.char_length(copier_label) BETWEEN 1 AND 512
    )
  ),
  copier_pnl numeric CHECK (
    copier_pnl IS NULL
    OR copier_pnl NOT IN (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
  ),
  copier_invested numeric CHECK (
    copier_invested IS NULL
    OR (
      copier_invested >= 0
      AND copier_invested NOT IN (
        'NaN'::numeric,
        'Infinity'::numeric,
        '-Infinity'::numeric
      )
    )
  ),
  copy_duration_days integer CHECK (
    copy_duration_days IS NULL OR copy_duration_days >= 0
  ),
  dedupe_hash text NOT NULL CHECK (
    dedupe_hash = pg_catalog.btrim(dedupe_hash)
    AND pg_catalog.char_length(dedupe_hash) BETWEEN 1 AND 512
  ),
  row_sha256 text NOT NULL CHECK (
    row_sha256 ~ '^[0-9a-f]{64}$'
  ),
  PRIMARY KEY (publication_id, row_ordinal),
  UNIQUE (publication_id, dedupe_hash)
);

CREATE FUNCTION arena.reject_copier_snapshot_publication_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  -- RAW GC may tombstone only the live pointer. The denormalized path, digest,
  -- clocks, capture shape, row hash, and privacy contract remain immutable.
  IF TG_OP = 'UPDATE'
     AND pg_catalog.pg_trigger_depth() > 1
     AND OLD.live_raw_object_id IS NOT NULL
     AND NEW.live_raw_object_id IS NULL
     AND (pg_catalog.to_jsonb(NEW) - 'live_raw_object_id') =
         (pg_catalog.to_jsonb(OLD) - 'live_raw_object_id') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'copier snapshot publication receipts are immutable'
    USING ERRCODE = '55000';
END
$function$;

CREATE FUNCTION arena.reject_copier_snapshot_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'copier snapshot rows are immutable'
    USING ERRCODE = '55000';
END
$function$;

CREATE FUNCTION arena.protect_copier_snapshot_raw_object()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM arena.copier_snapshot_publications AS publication
    WHERE publication.live_raw_object_id = OLD.id
  ) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.quarantined THEN
      RAISE EXCEPTION 'quarantined copier snapshot RAW evidence cannot be deleted'
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
    RAISE EXCEPTION 'copier snapshot RAW evidence % cannot be mutated', OLD.id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER copier_snapshot_publication_reject_update_delete
BEFORE UPDATE OR DELETE ON arena.copier_snapshot_publications
FOR EACH ROW EXECUTE FUNCTION arena.reject_copier_snapshot_publication_mutation();

CREATE TRIGGER copier_snapshot_publication_reject_truncate
BEFORE TRUNCATE ON arena.copier_snapshot_publications
FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_copier_snapshot_publication_mutation();

CREATE TRIGGER copier_snapshot_row_reject_update_delete
BEFORE UPDATE OR DELETE ON arena.copier_snapshot_rows
FOR EACH ROW EXECUTE FUNCTION arena.reject_copier_snapshot_row_mutation();

CREATE TRIGGER copier_snapshot_row_reject_truncate
BEFORE TRUNCATE ON arena.copier_snapshot_rows
FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_copier_snapshot_row_mutation();

CREATE TRIGGER protect_copier_snapshot_raw_before_write
BEFORE UPDATE OR DELETE ON arena.raw_objects
FOR EACH ROW EXECUTE FUNCTION arena.protect_copier_snapshot_raw_object();

ALTER TABLE arena.copier_snapshot_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.copier_snapshot_publications FORCE ROW LEVEL SECURITY;
ALTER TABLE arena.copier_snapshot_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.copier_snapshot_rows FORCE ROW LEVEL SECURITY;

ALTER TABLE arena.copier_snapshot_publications OWNER TO postgres;
ALTER TABLE arena.copier_snapshot_rows OWNER TO postgres;
ALTER FUNCTION arena.reject_copier_snapshot_publication_mutation()
  OWNER TO postgres;
ALTER FUNCTION arena.reject_copier_snapshot_row_mutation()
  OWNER TO postgres;
ALTER FUNCTION arena.protect_copier_snapshot_raw_object()
  OWNER TO postgres;

REVOKE ALL ON TABLE arena.copier_snapshot_publications
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE arena.copier_snapshot_rows
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE arena.copier_snapshot_publications_publication_id_seq
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.reject_copier_snapshot_publication_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.reject_copier_snapshot_row_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.protect_copier_snapshot_raw_object()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE arena.copier_snapshot_publications IS
  'Private immutable evidence binding one copier snapshot to RAW identity, clocks, capture shape, depth, row hash, and privacy thresholds.';
COMMENT ON TABLE arena.copier_snapshot_rows IS
  'Private receipt-bound copier snapshot rows. Labels and per-copier values are never a public API surface.';
COMMENT ON COLUMN arena.copier_snapshot_rows.source_event_at IS
  'Upstream follower/event timestamp only; never a snapshot or publication clock.';

DO $postflight$
DECLARE
  relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'copier_snapshot_publications',
    'copier_snapshot_rows'
  ]::text[] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = pg_catalog.to_regclass(
        'arena.' || relation_name
      )
        AND relation.relowner = 'postgres'::pg_catalog.regrole
        AND relation.relrowsecurity
        AND relation.relforcerowsecurity
    )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_policy AS policy
         WHERE policy.polrelid = pg_catalog.to_regclass(
           'arena.' || relation_name
         )
       )
       OR pg_catalog.has_table_privilege(
         'anon', 'arena.' || relation_name, 'SELECT'
       )
       OR pg_catalog.has_table_privilege(
         'authenticated', 'arena.' || relation_name, 'SELECT'
       )
       OR pg_catalog.has_table_privilege(
         'service_role', 'arena.' || relation_name, 'SELECT,INSERT,UPDATE,DELETE'
       ) THEN
      RAISE EXCEPTION 'copier snapshot privacy postflight failed for %', relation_name;
    END IF;
  END LOOP;

  IF (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_trigger AS trigger
       WHERE trigger.tgrelid IN (
         'arena.copier_snapshot_publications'::pg_catalog.regclass,
         'arena.copier_snapshot_rows'::pg_catalog.regclass,
         'arena.raw_objects'::pg_catalog.regclass
       )
         AND NOT trigger.tgisinternal
         AND trigger.tgname IN (
           'copier_snapshot_publication_reject_update_delete',
           'copier_snapshot_publication_reject_truncate',
           'copier_snapshot_row_reject_update_delete',
           'copier_snapshot_row_reject_truncate',
           'protect_copier_snapshot_raw_before_write'
         )
     ) <> 5 THEN
    RAISE EXCEPTION 'copier snapshot immutability trigger postflight failed';
  END IF;
END
$postflight$;

COMMIT;
