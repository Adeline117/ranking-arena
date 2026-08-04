-- Short, base-RAW-compatible admission boundary for verified position history.
--
-- This migration intentionally depends only on the original eleven-column
-- arena.raw_objects shape. It does not scan or index the large RAW table.

BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR current_user IS DISTINCT FROM 'postgres'
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION
      'verified position-history RAW admission requires PG17, the base Arena RAW/source/trader tables, and all API roles';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS table_row
    WHERE table_row.oid = 'arena.raw_objects'::pg_catalog.regclass
      AND table_row.relkind = 'r'
      AND table_row.relowner = 'postgres'::pg_catalog.regrole
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS table_row
    WHERE table_row.oid = 'arena.sources'::pg_catalog.regclass
      AND table_row.relkind = 'r'
      AND table_row.relowner = 'postgres'::pg_catalog.regrole
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS table_row
    WHERE table_row.oid = 'arena.traders'::pg_catalog.regclass
      AND table_row.relkind = 'r'
      AND table_row.relowner = 'postgres'::pg_catalog.regrole
  ) THEN
    RAISE EXCEPTION 'Arena RAW/source/trader ownership or table kind drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND attname = 'id'
      AND atttypid = 'pg_catalog.int8'::pg_catalog.regtype
      AND attidentity = 'a'
      AND attnotnull
      AND attnum > 0
      AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND attname = 'source_id'
      AND atttypid = 'pg_catalog.int2'::pg_catalog.regtype
      AND attnotnull
      AND attnum > 0
      AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND attname = 'job_type'
      AND atttypid = 'pg_catalog.text'::pg_catalog.regtype
      AND attnotnull
      AND attnum > 0
      AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND attname = 'trader_id'
      AND atttypid = 'pg_catalog.int8'::pg_catalog.regtype
      AND NOT attnotnull
      AND attnum > 0
      AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND attname = 'timeframe'
      AND atttypid = 'pg_catalog.int2'::pg_catalog.regtype
      AND NOT attnotnull
      AND attnum > 0
      AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND attname = 'fetched_at'
      AND atttypid = 'pg_catalog.timestamptz'::pg_catalog.regtype
      AND attnotnull
      AND attnum > 0
      AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND attname = 'storage_path'
      AND atttypid = 'pg_catalog.text'::pg_catalog.regtype
      AND attnotnull
      AND attnum > 0
      AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND attname = 'bytes'
      AND atttypid = 'pg_catalog.int4'::pg_catalog.regtype
      AND attnotnull
      AND attnum > 0
      AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND attname = 'content_hash'
      AND atttypid = 'pg_catalog.text'::pg_catalog.regtype
      AND attnotnull
      AND attnum > 0
      AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND attname = 'quarantined'
      AND atttypid = 'pg_catalog.bool'::pg_catalog.regtype
      AND attnotnull
      AND attnum > 0
      AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND attname = 'meta'
      AND atttypid = 'pg_catalog.jsonb'::pg_catalog.regtype
      AND attnotnull
      AND attnum > 0
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'the eleven-column Arena RAW contract is absent or drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_attribute AS indexed_attribute
      ON indexed_attribute.attrelid = index_row.indrelid
     AND indexed_attribute.attname = 'id'
     AND indexed_attribute.attnum = index_row.indkey[0]
    WHERE index_row.indrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND index_row.indisprimary
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indislive
      AND index_row.indnkeyatts = 1
      AND index_row.indnatts = 1
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_attribute AS indexed_attribute
      ON indexed_attribute.attrelid = index_row.indrelid
     AND indexed_attribute.attname = 'storage_path'
     AND indexed_attribute.attnum = index_row.indkey[0]
    WHERE index_row.indrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indislive
      AND index_row.indnkeyatts = 1
      AND index_row.indnatts = 1
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NULL
  ) THEN
    RAISE EXCEPTION 'Arena RAW primary/storage identity indexes drifted';
  END IF;

  IF pg_catalog.to_regclass(
       'arena.position_history_raw_admissions'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.position_history_raw_is_eligible(text,jsonb)'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.position_history_raw_meta_sha256(jsonb)'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.position_history_raw_snapshot_sha256(bigint,smallint,text,bigint,smallint,timestamp with time zone,text,integer,text,text)'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.admit_position_history_raw()'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.require_position_history_raw_admission_context()'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.protect_position_history_raw_evidence()'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.reject_position_history_raw_truncate()'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.reject_position_history_raw_admission_mutation()'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.protect_position_history_registry_identity()'
     ) IS NOT NULL
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE (
         trigger_row.tgrelid = 'arena.raw_objects'::pg_catalog.regclass
         AND trigger_row.tgname IN (
           'admit_position_history_raw_after_insert',
           'protect_position_history_raw_evidence_before_write',
           'reject_position_history_raw_truncate'
         )
       ) OR (
         trigger_row.tgrelid IN (
           'arena.sources'::pg_catalog.regclass,
           'arena.traders'::pg_catalog.regclass
         )
         AND trigger_row.tgname IN (
           'protect_position_history_source_identity',
           'protect_position_history_trader_identity',
           'reject_position_history_source_truncate',
           'reject_position_history_trader_truncate'
         )
       )
     ) THEN
    RAISE EXCEPTION
      'verified position-history RAW admission is already or partially installed';
  END IF;
END
$preflight$;

CREATE FUNCTION arena.position_history_raw_is_eligible(
  p_job_type text,
  p_meta jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT p_job_type = 'history:position_history'
    AND pg_catalog.jsonb_typeof(p_meta) = 'object'
    AND pg_catalog.jsonb_typeof(p_meta->'data_contract') = 'string'
    AND p_meta->>'data_contract' =
      'arena.ingest.history-acquisition-artifact@1'
    AND pg_catalog.jsonb_typeof(
      p_meta->'history_evidence_contract'
    ) = 'string'
    AND p_meta->>'history_evidence_contract' =
      'arena.position-history-publication-evidence@2'
$function$;

CREATE FUNCTION arena.position_history_raw_meta_sha256(p_meta jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(p_meta::text, 'UTF8')
    ),
    'hex'
  )
$function$;

CREATE FUNCTION arena.position_history_raw_snapshot_sha256(
  p_raw_object_id bigint,
  p_source_id smallint,
  p_job_type text,
  p_trader_id bigint,
  p_timeframe smallint,
  p_fetched_at timestamptz,
  p_storage_path text,
  p_bytes integer,
  p_content_hash text,
  p_raw_meta_sha256 text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'bytes', p_bytes,
          'content_hash', p_content_hash,
          'fetched_at_epoch_microseconds',
            EXTRACT(epoch FROM p_fetched_at) * 1000000,
          'job_type', p_job_type,
          'raw_meta_sha256', p_raw_meta_sha256,
          'raw_object_id', p_raw_object_id,
          'source_id', p_source_id,
          'storage_path', p_storage_path,
          'timeframe', p_timeframe,
          'trader_id', p_trader_id
        )::text,
        'UTF8'
      )
    ),
    'hex'
  )
$function$;

CREATE TABLE arena.position_history_raw_admissions (
  raw_object_id bigint PRIMARY KEY CHECK (raw_object_id > 0),
  source_id smallint NOT NULL CHECK (source_id > 0),
  job_type text NOT NULL CHECK (job_type = 'history:position_history'),
  trader_id bigint NOT NULL CHECK (trader_id > 0),
  timeframe smallint CHECK (timeframe IS NULL),
  fetched_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(fetched_at)),
  storage_path text NOT NULL UNIQUE,
  bytes integer NOT NULL CHECK (bytes > 0),
  content_hash text NOT NULL,
  source_run_id text NOT NULL UNIQUE CHECK (
    source_run_id ~ '^[0-9a-f]{64}$'
    AND source_run_id <> pg_catalog.repeat('0', 64)
    AND content_hash = source_run_id
  ),
  source_slug text NOT NULL CHECK (
    source_slug ~ '^[a-z0-9_]{1,128}$'
  ),
  exchange_trader_id text NOT NULL CHECK (
    pg_catalog.char_length(exchange_trader_id) BETWEEN 1 AND 512
    AND (
      source_slug = 'bitget_futures'
      OR pg_catalog.strpos(exchange_trader_id, '|') = 0
    )
  ),
  raw_meta_sha256 text NOT NULL CHECK (
    raw_meta_sha256 ~ '^[0-9a-f]{64}$'
  ),
  raw_snapshot_sha256 text NOT NULL UNIQUE CHECK (
    raw_snapshot_sha256 ~ '^[0-9a-f]{64}$'
    AND raw_snapshot_sha256 = arena.position_history_raw_snapshot_sha256(
      raw_object_id,
      source_id,
      job_type,
      trader_id,
      timeframe,
      fetched_at,
      storage_path,
      bytes,
      content_hash,
      raw_meta_sha256
    )
  ),
  admitted_transaction_id xid8 NOT NULL,
  admitted_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(admitted_at))
);

-- Registry guards resolve admission authority by both registry identities.
-- These indexes are created while the ledger is new and empty, so they do not
-- extend the short existing-table lock window at the end of this migration.
CREATE INDEX position_history_raw_admissions_source_id_idx
  ON arena.position_history_raw_admissions (source_id);
CREATE INDEX position_history_raw_admissions_trader_id_idx
  ON arena.position_history_raw_admissions (trader_id);

ALTER TABLE arena.position_history_raw_admissions OWNER TO postgres;
ALTER TABLE arena.position_history_raw_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.position_history_raw_admissions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE arena.position_history_raw_admissions
  FROM PUBLIC, anon, authenticated, service_role;

CREATE POLICY owner_position_history_raw_admission_read
ON arena.position_history_raw_admissions
FOR SELECT TO postgres
USING (true);

CREATE POLICY owner_position_history_raw_admission_insert
ON arena.position_history_raw_admissions
FOR INSERT TO postgres
WITH CHECK (true);

-- PostgreSQL applies UPDATE RLS visibility to SELECT ... FOR SHARE/UPDATE.
-- Permit the postgres-owned publisher to lock an admitted row while making
-- every actual UPDATE fail closed (the ALWAYS mutation trigger is a second,
-- independent write barrier).
CREATE POLICY owner_position_history_raw_admission_lock
ON arena.position_history_raw_admissions
FOR UPDATE TO postgres
USING (true)
WITH CHECK (false);

CREATE FUNCTION arena.require_position_history_raw_admission_context()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF pg_catalog.pg_trigger_depth() <> 2
     OR NEW.admitted_transaction_id IS DISTINCT FROM
       pg_catalog.pg_current_xact_id()
     OR pg_catalog.current_setting(
          'arena.position_history_raw_admission_context',
          true
        ) IS DISTINCT FROM
        pg_catalog.pg_current_xact_id()::text || ':' ||
        NEW.raw_object_id::text || ':' || NEW.raw_snapshot_sha256
     OR NOT EXISTS (
       SELECT 1
       FROM arena.raw_objects AS raw_row
       WHERE raw_row.id = NEW.raw_object_id
         AND arena.position_history_raw_is_eligible(
           raw_row.job_type,
           raw_row.meta
         )
         AND raw_row.source_id IS NOT DISTINCT FROM NEW.source_id
         AND raw_row.job_type IS NOT DISTINCT FROM NEW.job_type
         AND raw_row.trader_id IS NOT DISTINCT FROM NEW.trader_id
         AND raw_row.timeframe IS NOT DISTINCT FROM NEW.timeframe
         AND raw_row.fetched_at IS NOT DISTINCT FROM NEW.fetched_at
         AND raw_row.storage_path IS NOT DISTINCT FROM NEW.storage_path
         AND raw_row.bytes IS NOT DISTINCT FROM NEW.bytes
         AND raw_row.content_hash IS NOT DISTINCT FROM NEW.content_hash
         AND NOT raw_row.quarantined
         AND raw_row.meta->>'source_run_id'
               IS NOT DISTINCT FROM NEW.source_run_id
         AND raw_row.meta->>'source_slug'
               IS NOT DISTINCT FROM NEW.source_slug
         AND raw_row.meta->>'exchange_trader_id'
               IS NOT DISTINCT FROM NEW.exchange_trader_id
         AND arena.position_history_raw_meta_sha256(raw_row.meta)
               IS NOT DISTINCT FROM NEW.raw_meta_sha256
         AND arena.position_history_raw_snapshot_sha256(
               raw_row.id,
               raw_row.source_id,
               raw_row.job_type,
               raw_row.trader_id,
               raw_row.timeframe,
               raw_row.fetched_at,
               raw_row.storage_path,
               raw_row.bytes,
               raw_row.content_hash,
               arena.position_history_raw_meta_sha256(raw_row.meta)
             ) IS NOT DISTINCT FROM NEW.raw_snapshot_sha256
     ) THEN
    RAISE EXCEPTION
      'position-history RAW admission requires its guarded INSERT transaction'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION arena.reject_position_history_raw_admission_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'position-history RAW admissions are immutable'
    USING ERRCODE = '55000';
END
$function$;

CREATE TRIGGER require_position_history_raw_admission_context
BEFORE INSERT ON arena.position_history_raw_admissions
FOR EACH ROW
EXECUTE FUNCTION arena.require_position_history_raw_admission_context();

CREATE TRIGGER reject_position_history_raw_admission_row_mutation
BEFORE UPDATE OR DELETE ON arena.position_history_raw_admissions
FOR EACH ROW
EXECUTE FUNCTION arena.reject_position_history_raw_admission_mutation();

CREATE TRIGGER reject_position_history_raw_admission_truncate
BEFORE TRUNCATE ON arena.position_history_raw_admissions
FOR EACH STATEMENT
EXECUTE FUNCTION arena.reject_position_history_raw_admission_mutation();

ALTER TABLE arena.position_history_raw_admissions
  ENABLE ALWAYS TRIGGER require_position_history_raw_admission_context;
ALTER TABLE arena.position_history_raw_admissions
  ENABLE ALWAYS TRIGGER reject_position_history_raw_admission_row_mutation;
ALTER TABLE arena.position_history_raw_admissions
  ENABLE ALWAYS TRIGGER reject_position_history_raw_admission_truncate;

CREATE FUNCTION arena.admit_position_history_raw()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_adapter_slug text;
  v_exchange_trader_id text;
  v_source_currency text;
  v_raw_meta_sha256 text;
  v_raw_snapshot_sha256 text;
  v_source_run_id text;
  v_source_slug text;
BEGIN
  IF NOT arena.position_history_raw_is_eligible(NEW.job_type, NEW.meta) THEN
    RETURN NEW;
  END IF;

  IF NEW.id <= 0
     OR NEW.trader_id IS NULL
     OR NEW.trader_id <= 0
     OR NEW.timeframe IS NOT NULL
     OR NOT pg_catalog.isfinite(NEW.fetched_at)
     OR NEW.fetched_at >
       pg_catalog.clock_timestamp() + INTERVAL '5 minutes'
     OR NEW.bytes <= 0
     OR NEW.quarantined
     OR NOT (
       ARRAY(
         SELECT object_key
         FROM pg_catalog.jsonb_object_keys(NEW.meta) AS object_key
         ORDER BY object_key COLLATE "C"
       ) IS NOT DISTINCT FROM ARRAY[
         'attempt_started_at',
         'capture_config',
         'data_contract',
         'exchange_trader_id',
         'history_evidence_contract',
         'history_kind',
         'observed_at',
         'page_count',
         'page_manifest',
         'parser_contract',
         'raw_integrity',
         'source_contract',
         'source_run_id',
         'source_slug',
         'starting_cursor',
         'termination',
         'verifier_contract'
       ]::text[]
     )
     OR pg_catalog.jsonb_typeof(NEW.meta->'source_run_id') <> 'string'
     OR NEW.meta->>'source_run_id' !~ '^[0-9a-f]{64}$'
     OR NEW.meta->>'source_run_id' = pg_catalog.repeat('0', 64)
     OR pg_catalog.jsonb_typeof(NEW.meta->'source_slug') <> 'string'
     OR pg_catalog.jsonb_typeof(
       NEW.meta->'exchange_trader_id'
     ) <> 'string'
     OR pg_catalog.jsonb_typeof(NEW.meta->'history_kind') <> 'string'
     OR NEW.meta->>'history_kind' <> 'position_history' THEN
    RAISE EXCEPTION 'position-history RAW admission shape is not exact'
      USING ERRCODE = '22023';
  END IF;

  v_source_run_id := NEW.meta->>'source_run_id';
  v_source_slug := NEW.meta->>'source_slug';
  v_exchange_trader_id := NEW.meta->>'exchange_trader_id';

  SELECT
    trader_row.exchange_trader_id,
    source_row.adapter_slug,
    source_row.currency
  INTO v_exchange_trader_id, v_adapter_slug, v_source_currency
  FROM arena.sources AS source_row
  JOIN arena.traders AS trader_row
    ON trader_row.source_id = source_row.id
   AND trader_row.id = NEW.trader_id
  WHERE source_row.id = NEW.source_id
    AND source_row.slug = v_source_slug
    AND trader_row.exchange_trader_id = v_exchange_trader_id
    AND (source_row.slug, source_row.adapter_slug, source_row.currency) IN (
      ('binance_futures', 'binance', 'USDT'),
      ('bitget_futures', 'bitget', 'USDT'),
      ('okx_futures', 'okx', 'USDT')
    )
  FOR SHARE OF source_row, trader_row;

  IF NOT FOUND
     OR NEW.content_hash IS DISTINCT FROM v_source_run_id
     OR NEW.storage_path IS DISTINCT FROM
       v_source_slug || '/history_trust/position_history/' ||
       v_source_run_id || '/event_history_' || v_source_run_id || '.json.gz'
  THEN
    RAISE EXCEPTION
      'position-history RAW source, trader, path, or content identity is not exact'
      USING ERRCODE = '22023';
  END IF;

  v_raw_meta_sha256 := arena.position_history_raw_meta_sha256(NEW.meta);
  v_raw_snapshot_sha256 := arena.position_history_raw_snapshot_sha256(
    NEW.id,
    NEW.source_id,
    NEW.job_type,
    NEW.trader_id,
    NEW.timeframe,
    NEW.fetched_at,
    NEW.storage_path,
    NEW.bytes,
    NEW.content_hash,
    v_raw_meta_sha256
  );

  PERFORM pg_catalog.set_config(
    'arena.position_history_raw_admission_context',
    pg_catalog.pg_current_xact_id()::text || ':' || NEW.id::text || ':' ||
      v_raw_snapshot_sha256,
    true
  );

  INSERT INTO arena.position_history_raw_admissions (
    raw_object_id,
    source_id,
    job_type,
    trader_id,
    timeframe,
    fetched_at,
    storage_path,
    bytes,
    content_hash,
    source_run_id,
    source_slug,
    exchange_trader_id,
    raw_meta_sha256,
    raw_snapshot_sha256,
    admitted_transaction_id,
    admitted_at
  ) VALUES (
    NEW.id,
    NEW.source_id,
    NEW.job_type,
    NEW.trader_id,
    NEW.timeframe,
    NEW.fetched_at,
    NEW.storage_path,
    NEW.bytes,
    NEW.content_hash,
    v_source_run_id,
    v_source_slug,
    v_exchange_trader_id,
    v_raw_meta_sha256,
    v_raw_snapshot_sha256,
    pg_catalog.pg_current_xact_id(),
    pg_catalog.clock_timestamp()
  );

  PERFORM pg_catalog.set_config(
    'arena.position_history_raw_admission_context',
    '',
    true
  );

  RETURN NEW;
END
$function$;

CREATE FUNCTION arena.protect_position_history_raw_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_admission arena.position_history_raw_admissions%ROWTYPE;
  v_has_admission boolean;
  v_new_eligible boolean;
  v_old_eligible boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF arena.position_history_raw_is_eligible(OLD.job_type, OLD.meta) THEN
      SELECT admission.*
      INTO v_admission
      FROM arena.position_history_raw_admissions AS admission
      WHERE admission.raw_object_id = OLD.id;
      v_has_admission := FOUND;

      IF v_has_admission AND (
        v_admission.source_id IS DISTINCT FROM OLD.source_id
        OR v_admission.job_type IS DISTINCT FROM OLD.job_type
        OR v_admission.trader_id IS DISTINCT FROM OLD.trader_id
        OR v_admission.timeframe IS DISTINCT FROM OLD.timeframe
        OR v_admission.fetched_at IS DISTINCT FROM OLD.fetched_at
        OR v_admission.storage_path IS DISTINCT FROM OLD.storage_path
        OR v_admission.bytes IS DISTINCT FROM OLD.bytes
        OR v_admission.content_hash IS DISTINCT FROM OLD.content_hash
        OR v_admission.source_run_id
             IS DISTINCT FROM OLD.meta->>'source_run_id'
        OR v_admission.source_slug
             IS DISTINCT FROM OLD.meta->>'source_slug'
        OR v_admission.exchange_trader_id
             IS DISTINCT FROM OLD.meta->>'exchange_trader_id'
        OR v_admission.raw_meta_sha256 IS DISTINCT FROM
          arena.position_history_raw_meta_sha256(OLD.meta)
        OR v_admission.raw_snapshot_sha256 IS DISTINCT FROM
          arena.position_history_raw_snapshot_sha256(
            OLD.id,
            OLD.source_id,
            OLD.job_type,
            OLD.trader_id,
            OLD.timeframe,
            OLD.fetched_at,
            OLD.storage_path,
            OLD.bytes,
            OLD.content_hash,
            arena.position_history_raw_meta_sha256(OLD.meta)
          )
      ) THEN
        RAISE EXCEPTION
          'position-history RAW admission authority drifted'
          USING ERRCODE = '55000';
      END IF;

      IF NOT v_has_admission AND OLD.quarantined THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION
        'unpublished position-history RAW evidence cannot be deleted'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  v_old_eligible := arena.position_history_raw_is_eligible(
    OLD.job_type,
    OLD.meta
  );
  v_new_eligible := arena.position_history_raw_is_eligible(
    NEW.job_type,
    NEW.meta
  );

  IF v_old_eligible OR v_new_eligible THEN
    IF NOT v_old_eligible
       OR NOT v_new_eligible
       OR OLD.quarantined
       OR NOT NEW.quarantined
       OR (pg_catalog.to_jsonb(NEW) - 'quarantined')
            IS DISTINCT FROM
          (pg_catalog.to_jsonb(OLD) - 'quarantined') THEN
      RAISE EXCEPTION 'position-history RAW evidence cannot be mutated'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

CREATE FUNCTION arena.reject_position_history_raw_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'arena.raw_objects cannot be truncated after RAW admission'
    USING ERRCODE = '55000';
END
$function$;

CREATE FUNCTION arena.protect_position_history_registry_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_has_bound_identity boolean := false;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION
      'position-history source/trader registries cannot be truncated'
      USING ERRCODE = '55000';
  END IF;

  -- Ordinary profile/status updates must stay O(1).  Publication identity is
  -- checked only when an identity field can actually change (or on DELETE).
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'sources'
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.slug IS NOT DISTINCT FROM OLD.slug
     AND NEW.adapter_slug IS NOT DISTINCT FROM OLD.adapter_slug
     AND NEW.currency IS NOT DISTINCT FROM OLD.currency THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'traders'
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.source_id IS NOT DISTINCT FROM OLD.source_id
     AND NEW.exchange_trader_id IS NOT DISTINCT FROM OLD.exchange_trader_id THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'sources' THEN
    -- Freeze the three reviewed registry identities from the prerequisite
    -- boundary itself. This closes the no-admission window while the main
    -- repeatable-read migration seeds immutable source contracts.
    v_has_bound_identity :=
      (OLD.slug, OLD.adapter_slug, OLD.currency) IN (
        ('binance_futures', 'binance', 'USDT'),
        ('bitget_futures', 'bitget', 'USDT'),
        ('okx_futures', 'okx', 'USDT')
      ) OR EXISTS (
        SELECT 1
        FROM arena.position_history_raw_admissions AS admission
        WHERE admission.source_id = OLD.id
      );

    IF v_has_bound_identity AND (
      EXISTS (
        SELECT 1
        FROM arena.position_history_raw_admissions AS admission
        WHERE admission.source_id = OLD.id
          AND admission.source_slug IS DISTINCT FROM OLD.slug
      ) OR (OLD.slug, OLD.adapter_slug, OLD.currency) NOT IN (
        ('binance_futures', 'binance', 'USDT'),
        ('bitget_futures', 'bitget', 'USDT'),
        ('okx_futures', 'okx', 'USDT')
      )
    ) THEN
      RAISE EXCEPTION
        'position-history source registry authority drifted'
        USING ERRCODE = '55000';
    END IF;

    IF v_has_bound_identity THEN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
          'admitted position-history source identity is immutable'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.slug IS DISTINCT FROM OLD.slug
         OR NEW.adapter_slug IS DISTINCT FROM OLD.adapter_slug
         OR NEW.currency IS DISTINCT FROM OLD.currency THEN
        RAISE EXCEPTION
          'admitted position-history source identity is immutable'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'traders' THEN
    v_has_bound_identity := EXISTS (
      SELECT 1
      FROM arena.position_history_raw_admissions AS admission
      WHERE admission.trader_id = OLD.id
    );

    IF v_has_bound_identity AND EXISTS (
      SELECT 1
      FROM arena.position_history_raw_admissions AS admission
      WHERE admission.trader_id = OLD.id
        AND (
          admission.source_id IS DISTINCT FROM OLD.source_id
          OR admission.exchange_trader_id
               IS DISTINCT FROM OLD.exchange_trader_id
        )
    ) THEN
      RAISE EXCEPTION
        'position-history trader registry authority drifted'
        USING ERRCODE = '55000';
    END IF;

    IF v_has_bound_identity THEN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
          'admitted position-history trader identity is immutable'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.source_id IS DISTINCT FROM OLD.source_id
         OR NEW.exchange_trader_id IS DISTINCT FROM OLD.exchange_trader_id THEN
        RAISE EXCEPTION
          'admitted position-history trader identity is immutable'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION arena.position_history_raw_is_eligible(text,jsonb)
  OWNER TO postgres;
ALTER FUNCTION arena.position_history_raw_meta_sha256(jsonb)
  OWNER TO postgres;
ALTER FUNCTION arena.position_history_raw_snapshot_sha256(
  bigint,smallint,text,bigint,smallint,timestamptz,text,integer,text,text
) OWNER TO postgres;
ALTER FUNCTION arena.require_position_history_raw_admission_context()
  OWNER TO postgres;
ALTER FUNCTION arena.reject_position_history_raw_admission_mutation()
  OWNER TO postgres;
ALTER FUNCTION arena.admit_position_history_raw() OWNER TO postgres;
ALTER FUNCTION arena.protect_position_history_raw_evidence() OWNER TO postgres;
ALTER FUNCTION arena.reject_position_history_raw_truncate() OWNER TO postgres;
ALTER FUNCTION arena.protect_position_history_registry_identity()
  OWNER TO postgres;

REVOKE ALL ON FUNCTION arena.position_history_raw_is_eligible(text,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.position_history_raw_meta_sha256(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.position_history_raw_snapshot_sha256(
  bigint,smallint,text,bigint,smallint,timestamptz,text,integer,text,text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.require_position_history_raw_admission_context()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.reject_position_history_raw_admission_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.admit_position_history_raw()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.protect_position_history_raw_evidence()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.reject_position_history_raw_truncate()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.protect_position_history_registry_identity()
  FROM PUBLIC, anon, authenticated, service_role;

-- Existing-table locks are deliberately last, dependency-reverse ordered, and
-- short.  Writers that already hold the child RAW/trader lock cannot deadlock
-- with this migration while subsequently checking their parent registry row.
-- They drain current registry/RAW writers, install the ALWAYS guards, then
-- the migration immediately performs catalog-only postflight and commits.
LOCK TABLE ONLY arena.raw_objects IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.traders IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.sources IN SHARE ROW EXCLUSIVE MODE;

CREATE TRIGGER admit_position_history_raw_after_insert
AFTER INSERT ON arena.raw_objects
FOR EACH ROW
EXECUTE FUNCTION arena.admit_position_history_raw();

CREATE TRIGGER protect_position_history_raw_evidence_before_write
BEFORE UPDATE OR DELETE ON arena.raw_objects
FOR EACH ROW
EXECUTE FUNCTION arena.protect_position_history_raw_evidence();

CREATE TRIGGER reject_position_history_raw_truncate
BEFORE TRUNCATE ON arena.raw_objects
FOR EACH STATEMENT
EXECUTE FUNCTION arena.reject_position_history_raw_truncate();

ALTER TABLE arena.raw_objects
  ENABLE ALWAYS TRIGGER admit_position_history_raw_after_insert;
ALTER TABLE arena.raw_objects
  ENABLE ALWAYS TRIGGER protect_position_history_raw_evidence_before_write;
ALTER TABLE arena.raw_objects
  ENABLE ALWAYS TRIGGER reject_position_history_raw_truncate;

CREATE TRIGGER protect_position_history_source_identity
BEFORE UPDATE OR DELETE ON arena.sources
FOR EACH ROW
EXECUTE FUNCTION arena.protect_position_history_registry_identity();

CREATE TRIGGER reject_position_history_source_truncate
BEFORE TRUNCATE ON arena.sources
FOR EACH STATEMENT
EXECUTE FUNCTION arena.protect_position_history_registry_identity();

CREATE TRIGGER protect_position_history_trader_identity
BEFORE UPDATE OR DELETE ON arena.traders
FOR EACH ROW
EXECUTE FUNCTION arena.protect_position_history_registry_identity();

CREATE TRIGGER reject_position_history_trader_truncate
BEFORE TRUNCATE ON arena.traders
FOR EACH STATEMENT
EXECUTE FUNCTION arena.protect_position_history_registry_identity();

ALTER TABLE arena.sources
  ENABLE ALWAYS TRIGGER protect_position_history_source_identity;
ALTER TABLE arena.sources
  ENABLE ALWAYS TRIGGER reject_position_history_source_truncate;
ALTER TABLE arena.traders
  ENABLE ALWAYS TRIGGER protect_position_history_trader_identity;
ALTER TABLE arena.traders
  ENABLE ALWAYS TRIGGER reject_position_history_trader_truncate;

DO $postflight$
DECLARE
  v_expected record;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS table_row
    WHERE table_row.oid =
        'arena.position_history_raw_admissions'::pg_catalog.regclass
      AND table_row.relkind = 'r'
      AND table_row.relowner = 'postgres'::pg_catalog.regrole
      AND table_row.relrowsecurity
      AND table_row.relforcerowsecurity
  ) OR pg_catalog.has_table_privilege(
       'anon', 'arena.position_history_raw_admissions', 'SELECT'
     ) OR pg_catalog.has_table_privilege(
       'authenticated', 'arena.position_history_raw_admissions', 'SELECT'
     ) OR pg_catalog.has_table_privilege(
       'service_role', 'arena.position_history_raw_admissions', 'SELECT'
  ) THEN
    RAISE EXCEPTION 'position-history RAW admission table authority drifted';
  END IF;

  FOR v_expected IN
    SELECT role_name
    FROM (VALUES ('anon'::text), ('authenticated'::text),
                 ('service_role'::text)) AS api_role(role_name)
  LOOP
    IF pg_catalog.has_table_privilege(
         v_expected.role_name,
         'arena.position_history_raw_admissions',
         'INSERT'
       ) OR pg_catalog.has_table_privilege(
         v_expected.role_name,
         'arena.position_history_raw_admissions',
         'UPDATE'
       ) OR pg_catalog.has_table_privilege(
         v_expected.role_name,
         'arena.position_history_raw_admissions',
         'DELETE'
       ) OR pg_catalog.has_table_privilege(
         v_expected.role_name,
         'arena.position_history_raw_admissions',
         'TRUNCATE'
       ) THEN
      RAISE EXCEPTION
        'position-history RAW admission write ACL drifted for %',
        v_expected.role_name;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_array(
        attribute_row.attname,
        pg_catalog.format_type(
          attribute_row.atttypid,
          attribute_row.atttypmod
        ),
        attribute_row.attnotnull,
        attribute_row.attidentity
      )
      ORDER BY attribute_row.attnum
    )
    FROM pg_catalog.pg_attribute AS attribute_row
    WHERE attribute_row.attrelid =
        'arena.position_history_raw_admissions'::pg_catalog.regclass
      AND attribute_row.attnum > 0
      AND NOT attribute_row.attisdropped
  ) IS DISTINCT FROM
    '[
      ["raw_object_id","bigint",true,""],
      ["source_id","smallint",true,""],
      ["job_type","text",true,""],
      ["trader_id","bigint",true,""],
      ["timeframe","smallint",false,""],
      ["fetched_at","timestamp with time zone",true,""],
      ["storage_path","text",true,""],
      ["bytes","integer",true,""],
      ["content_hash","text",true,""],
      ["source_run_id","text",true,""],
      ["source_slug","text",true,""],
      ["exchange_trader_id","text",true,""],
      ["raw_meta_sha256","text",true,""],
      ["raw_snapshot_sha256","text",true,""],
      ["admitted_transaction_id","xid8",true,""],
      ["admitted_at","timestamp with time zone",true,""]
    ]'::jsonb THEN
    RAISE EXCEPTION 'position-history RAW admission columns drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'arena.position_history_raw_admissions'::pg_catalog.regclass
      AND constraint_row.conname =
        'position_history_raw_admissions_pkey'
      AND constraint_row.contype = 'p'
      AND constraint_row.convalidated
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) =
        'PRIMARY KEY (raw_object_id)'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'arena.position_history_raw_admissions'::pg_catalog.regclass
      AND constraint_row.conname =
        'position_history_raw_admissions_storage_path_key'
      AND constraint_row.contype = 'u'
      AND constraint_row.convalidated
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) =
        'UNIQUE (storage_path)'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'arena.position_history_raw_admissions'::pg_catalog.regclass
      AND constraint_row.conname =
        'position_history_raw_admissions_source_run_id_key'
      AND constraint_row.contype = 'u'
      AND constraint_row.convalidated
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) =
        'UNIQUE (source_run_id)'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'arena.position_history_raw_admissions'::pg_catalog.regclass
      AND constraint_row.conname =
        'position_history_raw_admissions_raw_snapshot_sha256_key'
      AND constraint_row.contype = 'u'
      AND constraint_row.convalidated
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) =
        'UNIQUE (raw_snapshot_sha256)'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'arena.position_history_raw_admissions'::pg_catalog.regclass
      AND NOT constraint_row.convalidated
  ) THEN
    RAISE EXCEPTION 'position-history RAW admission constraints drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
      'arena.position_history_raw_admissions'::pg_catalog.regclass
  ) <> 6 THEN
    RAISE EXCEPTION 'position-history RAW admission index set drifted';
  END IF;

  FOR v_expected IN
    SELECT *
    FROM (
      VALUES
      (
        'position_history_raw_admissions_source_id_idx'::text,
        'source_id'::name,
        'int2_ops'::name
      ),
      (
        'position_history_raw_admissions_trader_id_idx'::text,
        'trader_id'::name,
        'int8_ops'::name
      )
    ) AS expected(index_name, attribute_name, opclass_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index AS index_row
      JOIN pg_catalog.pg_class AS index_class
        ON index_class.oid = index_row.indexrelid
      JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = index_class.relam
      JOIN pg_catalog.pg_attribute AS attribute_row
        ON attribute_row.attrelid = index_row.indrelid
       AND attribute_row.attname = v_expected.attribute_name
      JOIN pg_catalog.pg_opclass AS opclass_row
        ON opclass_row.oid = index_row.indclass[0]
      WHERE index_row.indrelid =
          'arena.position_history_raw_admissions'::pg_catalog.regclass
        AND index_class.relname = v_expected.index_name
        AND index_class.relnamespace =
          'arena'::pg_catalog.regnamespace
        AND index_class.relowner = 'postgres'::pg_catalog.regrole
        AND index_class.relkind = 'i'
        AND index_class.relpersistence = 'p'
        AND index_class.reloptions IS NULL
        AND index_class.reltablespace = 0
        AND access_method.amname = 'btree'
        AND index_row.indnatts = 1
        AND index_row.indnkeyatts = 1
        AND index_row.indkey[0] = attribute_row.attnum
        AND index_row.indcollation[0] = 0
        AND index_row.indoption[0] = 0
        AND opclass_row.opcname = v_expected.opclass_name
        AND index_row.indexprs IS NULL
        AND index_row.indpred IS NULL
        AND NOT index_row.indisunique
        AND NOT index_row.indisprimary
        AND NOT index_row.indisexclusion
        AND index_row.indimmediate
        AND index_row.indisvalid
        AND index_row.indisready
        AND index_row.indislive
        AND NOT index_row.indisclustered
        AND NOT index_row.indisreplident
        AND NOT index_row.indnullsnotdistinct
    ) THEN
      RAISE EXCEPTION
        'position-history RAW admission registry index drifted: %',
        v_expected.index_name;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid =
      'arena.position_history_raw_admissions'::pg_catalog.regclass
  ) <> 3 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid =
        'arena.position_history_raw_admissions'::pg_catalog.regclass
      AND policy_row.polname = 'owner_position_history_raw_admission_read'
      AND policy_row.polcmd = 'r'
      AND policy_row.polpermissive
      AND policy_row.polroles =
        ARRAY['postgres'::pg_catalog.regrole]::oid[]
      AND pg_catalog.pg_get_expr(
        policy_row.polqual,
        policy_row.polrelid,
        true
      ) = 'true'
      AND policy_row.polwithcheck IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid =
        'arena.position_history_raw_admissions'::pg_catalog.regclass
      AND policy_row.polname = 'owner_position_history_raw_admission_insert'
      AND policy_row.polcmd = 'a'
      AND policy_row.polpermissive
      AND policy_row.polroles =
        ARRAY['postgres'::pg_catalog.regrole]::oid[]
      AND policy_row.polqual IS NULL
      AND pg_catalog.pg_get_expr(
        policy_row.polwithcheck,
        policy_row.polrelid,
        true
      ) = 'true'
  ) THEN
    RAISE EXCEPTION 'position-history RAW admission policies drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid =
        'arena.position_history_raw_admissions'::pg_catalog.regclass
      AND policy_row.polname = 'owner_position_history_raw_admission_lock'
      AND policy_row.polcmd = 'w'
      AND policy_row.polpermissive
      AND policy_row.polroles =
        ARRAY['postgres'::pg_catalog.regrole]::oid[]
      AND pg_catalog.pg_get_expr(
        policy_row.polqual,
        policy_row.polrelid,
        true
      ) = 'true'
      AND pg_catalog.pg_get_expr(
        policy_row.polwithcheck,
        policy_row.polrelid,
        true
      ) = 'false'
  ) THEN
    RAISE EXCEPTION 'position-history RAW admission lock policy drifted';
  END IF;

  FOR v_expected IN
    SELECT *
    FROM (
      VALUES
      (
        'arena.position_history_raw_is_eligible(text,jsonb)'::pg_catalog.regprocedure,
        false, 'i'::"char", 's'::"char", false,
        'pg_catalog.bool'::pg_catalog.regtype,
        'sql'::text
      ),
      (
        'arena.position_history_raw_meta_sha256(jsonb)'::pg_catalog.regprocedure,
        false, 'i'::"char", 's'::"char", true,
        'pg_catalog.text'::pg_catalog.regtype,
        'sql'::text
      ),
      (
        'arena.position_history_raw_snapshot_sha256(bigint,smallint,text,bigint,smallint,timestamp with time zone,text,integer,text,text)'::pg_catalog.regprocedure,
        false, 'i'::"char", 's'::"char", false,
        'pg_catalog.text'::pg_catalog.regtype,
        'sql'::text
      ),
      (
        'arena.require_position_history_raw_admission_context()'::pg_catalog.regprocedure,
        true, 'v'::"char", 'u'::"char", false,
        'pg_catalog.trigger'::pg_catalog.regtype,
        'plpgsql'::text
      ),
      (
        'arena.reject_position_history_raw_admission_mutation()'::pg_catalog.regprocedure,
        false, 'v'::"char", 'u'::"char", false,
        'pg_catalog.trigger'::pg_catalog.regtype,
        'plpgsql'::text
      ),
      (
        'arena.admit_position_history_raw()'::pg_catalog.regprocedure,
        true, 'v'::"char", 'u'::"char", false,
        'pg_catalog.trigger'::pg_catalog.regtype,
        'plpgsql'::text
      ),
      (
        'arena.protect_position_history_raw_evidence()'::pg_catalog.regprocedure,
        true, 'v'::"char", 'u'::"char", false,
        'pg_catalog.trigger'::pg_catalog.regtype,
        'plpgsql'::text
      ),
      (
        'arena.reject_position_history_raw_truncate()'::pg_catalog.regprocedure,
        false, 'v'::"char", 'u'::"char", false,
        'pg_catalog.trigger'::pg_catalog.regtype,
        'plpgsql'::text
      ),
      (
        'arena.protect_position_history_registry_identity()'::pg_catalog.regprocedure,
        true, 'v'::"char", 'u'::"char", false,
        'pg_catalog.trigger'::pg_catalog.regtype,
        'plpgsql'::text
      )
    ) AS expected(
      function_oid,
      security_definer,
      volatility,
      parallel_safety,
      is_strict,
      return_type,
      language_name
    )
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_expected.function_oid
        AND function_row.proowner = 'postgres'::pg_catalog.regrole
        AND function_row.prosecdef = v_expected.security_definer
        AND NOT function_row.proleakproof
        AND function_row.provolatile = v_expected.volatility
        AND function_row.proparallel = v_expected.parallel_safety
        AND function_row.proisstrict = v_expected.is_strict
        AND function_row.prokind = 'f'
        AND function_row.prorettype = v_expected.return_type
        AND function_row.prolang = (
          SELECT language_row.oid
          FROM pg_catalog.pg_language AS language_row
          WHERE language_row.lanname = v_expected.language_name
        )
        AND function_row.proconfig IS NOT DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
    ) OR pg_catalog.has_function_privilege(
      'anon', v_expected.function_oid, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticated', v_expected.function_oid, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'service_role', v_expected.function_oid, 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'position-history RAW admission function drifted: %',
        v_expected.function_oid;
    END IF;
  END LOOP;

  FOR v_expected IN
    SELECT *
    FROM (
      VALUES
      (
        'arena.raw_objects'::pg_catalog.regclass,
        'admit_position_history_raw_after_insert',
        'arena.admit_position_history_raw()'::pg_catalog.regprocedure,
        5::smallint
      ),
      (
        'arena.raw_objects'::pg_catalog.regclass,
        'protect_position_history_raw_evidence_before_write',
        'arena.protect_position_history_raw_evidence()'::pg_catalog.regprocedure,
        27::smallint
      ),
      (
        'arena.raw_objects'::pg_catalog.regclass,
        'reject_position_history_raw_truncate',
        'arena.reject_position_history_raw_truncate()'::pg_catalog.regprocedure,
        34::smallint
      ),
      (
        'arena.position_history_raw_admissions'::pg_catalog.regclass,
        'require_position_history_raw_admission_context',
        'arena.require_position_history_raw_admission_context()'::pg_catalog.regprocedure,
        7::smallint
      ),
      (
        'arena.position_history_raw_admissions'::pg_catalog.regclass,
        'reject_position_history_raw_admission_row_mutation',
        'arena.reject_position_history_raw_admission_mutation()'::pg_catalog.regprocedure,
        27::smallint
      ),
      (
        'arena.position_history_raw_admissions'::pg_catalog.regclass,
        'reject_position_history_raw_admission_truncate',
        'arena.reject_position_history_raw_admission_mutation()'::pg_catalog.regprocedure,
        34::smallint
      ),
      (
        'arena.sources'::pg_catalog.regclass,
        'protect_position_history_source_identity',
        'arena.protect_position_history_registry_identity()'::pg_catalog.regprocedure,
        27::smallint
      ),
      (
        'arena.sources'::pg_catalog.regclass,
        'reject_position_history_source_truncate',
        'arena.protect_position_history_registry_identity()'::pg_catalog.regprocedure,
        34::smallint
      ),
      (
        'arena.traders'::pg_catalog.regclass,
        'protect_position_history_trader_identity',
        'arena.protect_position_history_registry_identity()'::pg_catalog.regprocedure,
        27::smallint
      ),
      (
        'arena.traders'::pg_catalog.regclass,
        'reject_position_history_trader_truncate',
        'arena.protect_position_history_registry_identity()'::pg_catalog.regprocedure,
        34::smallint
      )
    ) AS expected(table_oid, trigger_name, function_oid, trigger_type)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_expected.table_oid
        AND trigger_row.tgname = v_expected.trigger_name
        AND trigger_row.tgfoid = v_expected.function_oid
        AND trigger_row.tgtype = v_expected.trigger_type
        AND trigger_row.tgenabled = 'A'
        AND NOT trigger_row.tgisinternal
        AND NOT trigger_row.tgdeferrable
        AND NOT trigger_row.tginitdeferred
        AND trigger_row.tgnargs = 0
        AND trigger_row.tgattr::text = ''
        AND trigger_row.tgconstraint = 0
    ) THEN
      RAISE EXCEPTION 'position-history RAW admission trigger drifted: %.%',
        v_expected.table_oid, v_expected.trigger_name;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE NOT trigger_row.tgisinternal
      AND (
        trigger_row.tgrelid = 'arena.raw_objects'::pg_catalog.regclass
        AND trigger_row.tgname IN (
          'admit_position_history_raw_after_insert',
          'protect_position_history_raw_evidence_before_write',
          'reject_position_history_raw_truncate'
        )
        OR trigger_row.tgrelid =
          'arena.position_history_raw_admissions'::pg_catalog.regclass
        AND trigger_row.tgname IN (
          'require_position_history_raw_admission_context',
          'reject_position_history_raw_admission_row_mutation',
          'reject_position_history_raw_admission_truncate'
        )
        OR trigger_row.tgrelid = 'arena.sources'::pg_catalog.regclass
        AND trigger_row.tgname IN (
          'protect_position_history_source_identity',
          'reject_position_history_source_truncate'
        )
        OR trigger_row.tgrelid = 'arena.traders'::pg_catalog.regclass
        AND trigger_row.tgname IN (
          'protect_position_history_trader_identity',
          'reject_position_history_trader_truncate'
        )
      )
  ) <> 10 THEN
    RAISE EXCEPTION 'position-history RAW admission trigger set drifted';
  END IF;
END
$postflight$;

COMMIT;
