-- Private, immutable publication substrate for verified copier artifact@2 evidence.
--
-- This migration intentionally creates no publisher, RPC, policy, or public
-- projection. A later versioned publisher must replay the locked RAW evidence
-- and PostgreSQL tuple/multiset hashes before it can insert into these tables.
-- Neither table can represent completeness or rank eligibility.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $foundations$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.current_setting('server_encoding') <> 'UTF8'
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regnamespace('supabase_migrations') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL
     OR pg_catalog.to_regclass('arena.copier_snapshot_publications') IS NULL
     OR pg_catalog.to_regclass('arena.copier_snapshot_rows') IS NULL
     OR pg_catalog.to_regclass(
          'supabase_migrations.schema_migrations'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.publish_copier_snapshot(smallint,bigint,text,bigint,text,text,timestamp with time zone,boolean,integer,integer,jsonb)'
        ) IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION
      'copier snapshot trust publication substrate requires PG17 UTF8, exact v1 copier foundations, migration ledger, and API roles';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_roles AS role_row
     WHERE role_row.oid = 'postgres'::pg_catalog.regrole
       AND (role_row.rolsuper OR role_row.rolbypassrls)
  ) THEN
    RAISE EXCEPTION
      'copier snapshot trust RAW protection owner must bypass private RLS';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute_row
     WHERE attribute_row.attrelid =
           'supabase_migrations.schema_migrations'::pg_catalog.regclass
       AND attribute_row.attname = 'name'
       AND attribute_row.atttypid = 'pg_catalog.text'::pg_catalog.regtype
       AND attribute_row.attnum > 0
       AND NOT attribute_row.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute_row
     WHERE attribute_row.attrelid =
           'supabase_migrations.schema_migrations'::pg_catalog.regclass
       AND attribute_row.attname = 'statements'
       AND attribute_row.atttypid = 'pg_catalog._text'::pg_catalog.regtype
       AND attribute_row.attnum > 0
       AND NOT attribute_row.attisdropped
  ) THEN
    RAISE EXCEPTION 'Supabase migration ledger identity columns drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation_row
     WHERE relation_row.oid IN (
             'arena.raw_objects'::pg_catalog.regclass,
             'arena.copier_snapshot_publications'::pg_catalog.regclass,
             'arena.copier_snapshot_rows'::pg_catalog.regclass
           )
       AND relation_row.relrowsecurity
     HAVING pg_catalog.count(*) = 3
  ) THEN
    RAISE EXCEPTION 'private RAW or v1 copier row-security boundary is missing';
  END IF;
END
$foundations$;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    '20260808020000-copier-snapshot-trust-publication-substrate',
    0
  )
);

LOCK TABLE supabase_migrations.schema_migrations
  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.sources IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.traders IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.raw_objects IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_predecessor_count bigint;
  v_raw_role_constraint_sha256 text;
BEGIN
  SELECT pg_catalog.count(*)
    INTO STRICT v_predecessor_count
    FROM supabase_migrations.schema_migrations AS ledger
   WHERE ledger.name = 'copier_snapshot_trust_raw_role';

  -- Supabase may assign a server-side version. Bind the prerequisite to the
  -- unique reviewed name and exact UTF-8 migration body instead of a version.
  IF v_predecessor_count <> 1
     OR NOT EXISTS (
       SELECT 1
         FROM supabase_migrations.schema_migrations AS ledger
        WHERE ledger.name = 'copier_snapshot_trust_raw_role'
          AND pg_catalog.array_length(ledger.statements, 1) = 1
          AND pg_catalog.encode(
                pg_catalog.sha256(
                  pg_catalog.convert_to(ledger.statements[1], 'UTF8')
                ),
                'hex'
              ) =
              '37929ff0398005969dc415e82488c8d1654492b6e5588824b2c73f98c16765ef'
     ) THEN
    RAISE EXCEPTION
      'copier snapshot trust publication substrate requires one exact copier_snapshot_trust_raw_role migration ledger name and body';
  END IF;

  SELECT pg_catalog.encode(
           pg_catalog.sha256(
             pg_catalog.convert_to(
               pg_catalog.pg_get_constraintdef(constraint_row.oid),
               'UTF8'
             )
           ),
           'hex'
         )
    INTO STRICT v_raw_role_constraint_sha256
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = 'arena.raw_objects'::pg_catalog.regclass
     AND constraint_row.conname = 'raw_objects_metric_trust_binding'
     AND constraint_row.contype = 'c'
     AND constraint_row.convalidated
     AND NOT constraint_row.connoinherit;

  IF v_raw_role_constraint_sha256 IS DISTINCT FROM
     'b38e9396fc8e7198376dc261f8192fe48b636687796b9bc48f3c23dca24d21d8' THEN
    RAISE EXCEPTION 'copier_snapshot_trust RAW role constraint drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index AS index_row
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = index_row.indexrelid
      JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = index_relation.relam
     WHERE index_row.indexrelid =
           'arena.uidx_raw_copier_snapshot_trust_per_run'::pg_catalog.regclass
       AND index_row.indrelid = 'arena.raw_objects'::pg_catalog.regclass
       AND index_row.indisunique
       AND index_row.indisvalid
       AND index_row.indisready
       AND index_row.indimmediate
       AND index_row.indnkeyatts = 1
       AND index_row.indnatts = 1
       AND access_method.amname = 'btree'
       AND index_row.indkey[0] = (
         SELECT attribute_row.attnum
           FROM pg_catalog.pg_attribute AS attribute_row
          WHERE attribute_row.attrelid = index_row.indrelid
            AND attribute_row.attname = 'source_run_id'
            AND attribute_row.attnum > 0
            AND NOT attribute_row.attisdropped
       )
       AND pg_catalog.pg_get_expr(
             index_row.indpred,
             index_row.indrelid
           ) =
           '((source_run_id IS NOT NULL) AND (trust_artifact_role = ''copier_snapshot_trust''::text))'
  ) THEN
    RAISE EXCEPTION 'copier_snapshot_trust RAW identity index drifted';
  END IF;

  IF pg_catalog.to_regclass(
       'arena.copier_snapshot_trust_publications'
     ) IS NOT NULL
     OR pg_catalog.to_regclass(
          'arena.copier_snapshot_trust_publications_publication_id_seq'
        ) IS NOT NULL
     OR pg_catalog.to_regclass(
          'arena.copier_snapshot_trust_rows'
        ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
          'arena.validate_copier_snapshot_trust_publication_insert()'
        ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
          'arena.reject_copier_snapshot_trust_publication_mutation()'
        ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
          'arena.reject_copier_snapshot_trust_row_mutation()'
        ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
          'arena.protect_copier_snapshot_trust_raw_object()'
        ) IS NOT NULL THEN
    RAISE EXCEPTION
      'copier snapshot trust publication substrate is already or partially installed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute_row
     WHERE attribute_row.attrelid = 'arena.sources'::pg_catalog.regclass
       AND attribute_row.attname = 'slug'
       AND attribute_row.atttypid = 'pg_catalog.text'::pg_catalog.regtype
       AND attribute_row.attnum > 0
       AND NOT attribute_row.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute_row
     WHERE attribute_row.attrelid = 'arena.traders'::pg_catalog.regclass
       AND attribute_row.attname = 'exchange_trader_id'
       AND attribute_row.atttypid = 'pg_catalog.text'::pg_catalog.regtype
       AND attribute_row.attnum > 0
       AND NOT attribute_row.attisdropped
  ) OR EXISTS (
    SELECT required_column.name
      FROM pg_catalog.unnest(ARRAY[
        'job_type', 'trader_id', 'timeframe', 'fetched_at', 'storage_path',
        'bytes', 'content_hash', 'quarantined', 'meta', 'source_run_id',
        'trust_artifact_role'
      ]::text[]) AS required_column(name)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_attribute AS attribute_row
        WHERE attribute_row.attrelid = 'arena.raw_objects'::pg_catalog.regclass
          AND attribute_row.attname = required_column.name
          AND attribute_row.attnum > 0
          AND NOT attribute_row.attisdropped
     )
  ) THEN
    RAISE EXCEPTION 'copier snapshot trust publication identity columns drifted';
  END IF;
END
$preflight$;

CREATE TABLE arena.copier_snapshot_trust_publications (
  publication_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL
    REFERENCES arena.sources(id) ON DELETE RESTRICT,
  trader_id bigint NOT NULL
    REFERENCES arena.traders(id) ON DELETE RESTRICT,
  lane text NOT NULL CHECK (lane IN ('tier_b', 'tier_c')),
  outer_source_run_id text NOT NULL CHECK (
    outer_source_run_id ~ '^[0-9a-f]{64}$'
    AND outer_source_run_id <> pg_catalog.repeat('0', 64)
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
      AND published_at <= pg_catalog.statement_timestamp() + interval '5 minutes'
      AND observed_at <= published_at + interval '5 minutes'
      AND raw_fetched_at <= published_at + interval '5 minutes'
    ),
  previous_publication_id bigint,
  source_slug_at_publication text NOT NULL CHECK (
    source_slug_at_publication ~ '^[a-z0-9][a-z0-9_]{0,127}$'
  ),
  exchange_trader_id_at_publication text NOT NULL CHECK (
    exchange_trader_id_at_publication =
      pg_catalog.btrim(exchange_trader_id_at_publication)
    AND pg_catalog.char_length(exchange_trader_id_at_publication)
        BETWEEN 1 AND 512
  ),
  adapter_slug text NOT NULL CHECK (
    adapter_slug IN (
      'binance', 'bingx', 'bitget', 'bitget_bots', 'bitunix', 'blofin',
      'btcc', 'bybit_copytrade', 'coinex', 'gate', 'kucoin', 'lbank',
      'mexc', 'okx', 'toobit', 'xt'
    )
  ),
  product_type text NOT NULL CHECK (
    product_type IN ('spot', 'futures', 'cfd', 'onchain')
  ),
  currency text NOT NULL CHECK (
    currency IN ('USDT', 'USDx', 'USDC', 'USD')
  ),
  source_depth_at_publication text NOT NULL CHECK (
    source_depth_at_publication IN ('full', 'top10', 'top3_preview')
  ),
  request_timeframe smallint CHECK (
    (lane = 'tier_b' AND request_timeframe IS NULL)
    OR (lane = 'tier_c' AND request_timeframe IN (0, 7, 30, 90))
  ),
  scan_terminal_state text NOT NULL CHECK (
    scan_terminal_state IN ('stream_exhausted_unverified', 'caller_limited')
  ),
  caller_limited boolean NOT NULL,
  source_reported_row_count integer CHECK (
    source_reported_row_count IS NULL
  ),
  page_count integer NOT NULL CHECK (
    page_count BETWEEN 1 AND 100000
  ),
  observed_candidate_count integer NOT NULL CHECK (
    observed_candidate_count BETWEEN 0 AND 10000000
  ),
  parsed_row_count integer NOT NULL CHECK (
    parsed_row_count BETWEEN 0 AND 10000000
  ),
  snapshot_source_run_id text NOT NULL CHECK (
    snapshot_source_run_id ~ '^[0-9a-f]{64}$'
  ),
  candidate_ledger_sha256 text NOT NULL CHECK (
    candidate_ledger_sha256 ~ '^[0-9a-f]{64}$'
  ),
  parser_conservation_sha256 text NOT NULL CHECK (
    parser_conservation_sha256 ~ '^[0-9a-f]{64}$'
  ),
  projection_ledger_sha256 text NOT NULL CHECK (
    projection_ledger_sha256 ~ '^[0-9a-f]{64}$'
  ),
  source_candidate_fixed_multiset_sha256 text NOT NULL CHECK (
    source_candidate_fixed_multiset_sha256 ~ '^[0-9a-f]{64}$'
  ),
  candidate_projection_fixed_multiset_sha256 text NOT NULL CHECK (
    candidate_projection_fixed_multiset_sha256 ~ '^[0-9a-f]{64}$'
  ),
  raw_artifact_role text NOT NULL CHECK (
    raw_artifact_role = 'copier_snapshot_trust'
  ),
  evidence_contract text NOT NULL CHECK (
    evidence_contract = 'arena.copier-snapshot-publication-evidence@2'
  ),
  serialization_contract text NOT NULL CHECK (
    serialization_contract = 'arena.strict-canonical-json@1'
  ),
  data_contract text NOT NULL CHECK (
    data_contract = 'arena.ingest.copier-snapshot-artifact@2'
  ),
  snapshot_artifact_contract text NOT NULL CHECK (
    snapshot_artifact_contract = 'arena.ingest.copier-snapshot-artifact@1'
  ),
  candidate_ledger_contract text NOT NULL CHECK (
    candidate_ledger_contract = 'arena.ingest.copier-candidate-ledger@1'
  ),
  parser_conservation_contract text NOT NULL CHECK (
    parser_conservation_contract =
      'arena.ingest.copier-parser-conservation@1'
  ),
  projection_ledger_contract text NOT NULL CHECK (
    projection_ledger_contract = 'arena.ingest.copier-projection-ledger@1'
  ),
  candidate_locator_contract text NOT NULL CHECK (
    candidate_locator_contract ~
      '^arena\.ingest\.copier-candidate-locator\.[a-z0-9_.]+@[1-9][0-9]*$'
  ),
  parser_contract text NOT NULL CHECK (
    parser_contract =
      'arena.ingest.copier-parser.' || adapter_slug || '@1'
  ),
  projection_tuple_contract text NOT NULL CHECK (
    projection_tuple_contract = 'arena.ingest.copier-projection-tuple@1'
  ),
  projection_encoding_contract text NOT NULL CHECK (
    projection_encoding_contract =
      'arena.ingest.length-prefixed-utf8.nonnegative-int32be@1'
  ),
  source_candidate_fixed_multiset_contract text NOT NULL CHECK (
    source_candidate_fixed_multiset_contract =
      'arena.ingest.copier-source-candidate-sha256-multiset.domain-count-fixed-bytes@1'
  ),
  candidate_projection_fixed_multiset_contract text NOT NULL CHECK (
    candidate_projection_fixed_multiset_contract =
      'arena.ingest.copier-candidate-projection-sha256-multiset.domain-count-fixed-bytes@1'
  ),
  occurrence_policy_contract text NOT NULL CHECK (
    occurrence_policy_contract =
      'arena.ingest.copier-occurrence-uniqueness.reject-batch@1'
  ),
  publisher_contract text NOT NULL CHECK (
    publisher_contract = 'arena.ingest.copier-snapshot-publisher@2'
  ),
  coverage_state text NOT NULL CHECK (
    coverage_state IN ('partial', 'unknown')
  ),
  rank_eligible boolean NOT NULL DEFAULT false CHECK (NOT rank_eligible),
  CONSTRAINT copier_snapshot_trust_publication_not_self_predecessor CHECK (
    previous_publication_id IS NULL
    OR previous_publication_id <> publication_id
  ),
  CONSTRAINT copier_snapshot_trust_publication_raw_identity CHECK (
    raw_content_hash = outer_source_run_id
    AND raw_fetched_at = observed_at
    AND (
      live_raw_object_id IS NULL
      OR live_raw_object_id = raw_object_id_at_publication
    )
  ),
  CONSTRAINT copier_snapshot_trust_publication_storage_identity CHECK (
    raw_storage_path =
      source_slug_at_publication || '/copier_snapshot_trust/' || lane || '/' ||
      outer_source_run_id || '/copier_snapshot_trust_' ||
      outer_source_run_id || '.json.gz'
  ),
  CONSTRAINT copier_snapshot_trust_publication_capture_shape CHECK (
    caller_limited = (scan_terminal_state = 'caller_limited')
    AND observed_candidate_count = parsed_row_count
    AND (lane <> 'tier_b' OR NOT caller_limited)
  ),
  CONSTRAINT copier_snapshot_trust_publication_coverage_shape CHECK (
    coverage_state = CASE
      WHEN caller_limited OR source_depth_at_publication <> 'full'
        THEN 'partial'
      ELSE 'unknown'
    END
  ),
  CONSTRAINT uq_copier_snapshot_trust_publication_lane_identity UNIQUE (
    publication_id, source_id, trader_id, lane
  ),
  CONSTRAINT fk_copier_snapshot_trust_publication_predecessor
    FOREIGN KEY (previous_publication_id, source_id, trader_id, lane)
    REFERENCES arena.copier_snapshot_trust_publications (
      publication_id, source_id, trader_id, lane
    ) ON DELETE RESTRICT,
  CONSTRAINT uq_copier_snapshot_trust_publication_outer UNIQUE (
    outer_source_run_id
  ),
  CONSTRAINT uq_copier_snapshot_trust_publication_raw_at_capture UNIQUE (
    raw_object_id_at_publication
  ),
  CONSTRAINT uq_copier_snapshot_trust_publication_lane_observation UNIQUE (
    source_id, trader_id, lane, observed_at
  )
);

CREATE UNIQUE INDEX uidx_copier_snapshot_trust_publication_live_raw
  ON arena.copier_snapshot_trust_publications (live_raw_object_id)
  WHERE live_raw_object_id IS NOT NULL;

CREATE UNIQUE INDEX uidx_copier_snapshot_trust_publication_root
  ON arena.copier_snapshot_trust_publications (source_id, trader_id, lane)
  WHERE previous_publication_id IS NULL;

CREATE UNIQUE INDEX uidx_copier_snapshot_trust_publication_predecessor
  ON arena.copier_snapshot_trust_publications (previous_publication_id)
  WHERE previous_publication_id IS NOT NULL;

CREATE INDEX idx_copier_snapshot_trust_publication_latest
  ON arena.copier_snapshot_trust_publications (
    source_id, trader_id, lane, observed_at DESC, publication_id DESC
  );

CREATE TABLE arena.copier_snapshot_trust_rows (
  publication_id bigint NOT NULL
    REFERENCES arena.copier_snapshot_trust_publications(publication_id)
    ON DELETE RESTRICT,
  row_ordinal integer NOT NULL CHECK (
    row_ordinal BETWEEN 0 AND 9999999
  ),
  source_page_ordinal integer NOT NULL CHECK (
    source_page_ordinal BETWEEN 1 AND 100000
  ),
  candidate_ordinal integer NOT NULL CHECK (
    candidate_ordinal BETWEEN 1 AND 10000000
  ),
  source_candidate_sha256 text NOT NULL CHECK (
    source_candidate_sha256 ~ '^[0-9a-f]{64}$'
  ),
  projection_sha256 text NOT NULL CHECK (
    projection_sha256 ~ '^[0-9a-f]{64}$'
  ),
  source_event_at timestamptz CHECK (source_event_at IS NULL),
  copier_label text CHECK (
    copier_label IS NULL
    OR (
      copier_label = pg_catalog.btrim(
        copier_label,
        U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
      )
      AND pg_catalog.char_length(copier_label) BETWEEN 1 AND 512
    )
  ),
  copier_pnl_text text CHECK (
    copier_pnl_text IS NULL
    OR (
      pg_catalog.char_length(copier_pnl_text) BETWEEN 1 AND 400
      AND copier_pnl_text ~
        '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$'
      AND copier_pnl_text <> '-0'
      AND pg_catalog.abs(copier_pnl_text::numeric) <= 9007199254740991
      AND pg_catalog.trim_scale(copier_pnl_text::numeric)::text = copier_pnl_text
    )
  ),
  copier_invested_text text CHECK (
    copier_invested_text IS NULL
    OR (
      pg_catalog.char_length(copier_invested_text) BETWEEN 1 AND 400
      AND copier_invested_text ~
        '^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$'
      AND pg_catalog.abs(copier_invested_text::numeric) <= 9007199254740991
      AND pg_catalog.trim_scale(copier_invested_text::numeric)::text =
          copier_invested_text
    )
  ),
  copy_duration_days_text text CHECK (
    copy_duration_days_text IS NULL
    OR (
      copy_duration_days_text ~ '^(?:0|[1-9][0-9]*)$'
      AND pg_catalog.char_length(copy_duration_days_text) <= 10
      AND copy_duration_days_text::numeric <= 2147483647
    )
  ),
  dedupe_hash text NOT NULL CHECK (
    dedupe_hash = pg_catalog.btrim(
      dedupe_hash,
      U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
    )
    AND pg_catalog.char_length(dedupe_hash) BETWEEN 1 AND 512
  ),
  PRIMARY KEY (publication_id, row_ordinal),
  CONSTRAINT uq_copier_snapshot_trust_row_coordinate UNIQUE (
    publication_id, source_page_ordinal, candidate_ordinal
  ),
  CONSTRAINT uq_copier_snapshot_trust_row_source_candidate UNIQUE (
    publication_id, source_candidate_sha256
  ),
  CONSTRAINT uq_copier_snapshot_trust_row_projection UNIQUE (
    publication_id, projection_sha256
  ),
  CONSTRAINT uq_copier_snapshot_trust_row_dedupe UNIQUE (
    publication_id, dedupe_hash
  )
);

CREATE FUNCTION arena.validate_copier_snapshot_trust_publication_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_source_slug text;
  v_trader_source_id smallint;
  v_exchange_trader_id text;
  v_raw arena.raw_objects%ROWTYPE;
  v_previous_observed_at timestamptz;
BEGIN
  IF NEW.live_raw_object_id IS NULL
     OR NEW.live_raw_object_id <> NEW.raw_object_id_at_publication THEN
    RAISE EXCEPTION
      'new copier snapshot trust publication requires one live RAW pointer'
      USING ERRCODE = '23514';
  END IF;

  SELECT source_row.slug,
         trader_row.source_id,
         trader_row.exchange_trader_id
    INTO v_source_slug, v_trader_source_id, v_exchange_trader_id
    FROM arena.sources AS source_row
    JOIN arena.traders AS trader_row
      ON trader_row.id = NEW.trader_id
   WHERE source_row.id = NEW.source_id
   FOR SHARE OF source_row, trader_row;

  IF NOT FOUND
     OR v_trader_source_id IS DISTINCT FROM NEW.source_id
     OR v_source_slug IS DISTINCT FROM NEW.source_slug_at_publication
     OR v_exchange_trader_id IS DISTINCT FROM
        NEW.exchange_trader_id_at_publication THEN
    RAISE EXCEPTION
      'copier snapshot trust publication live source/trader identity drifted'
      USING ERRCODE = '23503';
  END IF;

  SELECT raw_object.*
    INTO v_raw
    FROM arena.raw_objects AS raw_object
   WHERE raw_object.id = NEW.live_raw_object_id
   FOR SHARE;

  IF NOT FOUND
     OR v_raw.source_id IS DISTINCT FROM NEW.source_id
     OR v_raw.trader_id IS DISTINCT FROM NEW.trader_id
     OR v_raw.job_type IS DISTINCT FROM (CASE NEW.lane
          WHEN 'tier_b' THEN 'history:copiers'
          ELSE 'tier_c'
        END)
     OR v_raw.timeframe IS NOT NULL
     OR v_raw.fetched_at IS DISTINCT FROM NEW.raw_fetched_at
     OR v_raw.storage_path IS DISTINCT FROM NEW.raw_storage_path
     OR v_raw.content_hash IS DISTINCT FROM NEW.raw_content_hash
     OR v_raw.quarantined IS DISTINCT FROM false
     OR v_raw.source_run_id IS DISTINCT FROM NEW.outer_source_run_id
     OR v_raw.trust_artifact_role IS DISTINCT FROM 'copier_snapshot_trust' THEN
    RAISE EXCEPTION
      'copier snapshot trust publication RAW role or identity drifted'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.previous_publication_id IS NOT NULL THEN
    SELECT publication.observed_at
      INTO v_previous_observed_at
      FROM arena.copier_snapshot_trust_publications AS publication
     WHERE publication.publication_id = NEW.previous_publication_id
       AND publication.source_id = NEW.source_id
       AND publication.trader_id = NEW.trader_id
       AND publication.lane = NEW.lane
     FOR KEY SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'copier snapshot trust predecessor must belong to the same lane'
        USING ERRCODE = '23503';
    END IF;
    IF NEW.observed_at <= v_previous_observed_at THEN
      RAISE EXCEPTION
        'copier snapshot trust successor clock must increase'
        USING ERRCODE = '22007';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

CREATE FUNCTION arena.reject_copier_snapshot_trust_publication_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  -- Ordinary RAW retention may tombstone only the live FK. All publication-time
  -- RAW coordinates, evidence hashes, contracts, and trust state remain fixed.
  IF TG_OP = 'UPDATE'
     AND pg_catalog.pg_trigger_depth() > 1
     AND OLD.live_raw_object_id IS NOT NULL
     AND NEW.live_raw_object_id IS NULL
     AND (pg_catalog.to_jsonb(NEW) - 'live_raw_object_id') =
         (pg_catalog.to_jsonb(OLD) - 'live_raw_object_id') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'copier snapshot trust publication receipts are immutable'
    USING ERRCODE = '55000';
END
$function$;

CREATE FUNCTION arena.reject_copier_snapshot_trust_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'copier snapshot trust publication rows are immutable'
    USING ERRCODE = '55000';
END
$function$;

CREATE FUNCTION arena.protect_copier_snapshot_trust_raw_object()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM arena.copier_snapshot_trust_publications AS publication
     WHERE publication.live_raw_object_id = OLD.id
  ) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.quarantined THEN
      RAISE EXCEPTION
        'quarantined copier snapshot trust RAW evidence cannot be deleted'
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
    RAISE EXCEPTION
      'copier snapshot trust RAW evidence % cannot be mutated', OLD.id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER copier_snapshot_trust_publication_validate_insert
BEFORE INSERT ON arena.copier_snapshot_trust_publications
FOR EACH ROW EXECUTE FUNCTION
  arena.validate_copier_snapshot_trust_publication_insert();

CREATE TRIGGER copier_snapshot_trust_publication_reject_update_delete
BEFORE UPDATE OR DELETE ON arena.copier_snapshot_trust_publications
FOR EACH ROW EXECUTE FUNCTION
  arena.reject_copier_snapshot_trust_publication_mutation();

CREATE TRIGGER copier_snapshot_trust_publication_reject_truncate
BEFORE TRUNCATE ON arena.copier_snapshot_trust_publications
FOR EACH STATEMENT EXECUTE FUNCTION
  arena.reject_copier_snapshot_trust_publication_mutation();

CREATE TRIGGER copier_snapshot_trust_row_reject_update_delete
BEFORE UPDATE OR DELETE ON arena.copier_snapshot_trust_rows
FOR EACH ROW EXECUTE FUNCTION arena.reject_copier_snapshot_trust_row_mutation();

CREATE TRIGGER copier_snapshot_trust_row_reject_truncate
BEFORE TRUNCATE ON arena.copier_snapshot_trust_rows
FOR EACH STATEMENT EXECUTE FUNCTION
  arena.reject_copier_snapshot_trust_row_mutation();

CREATE TRIGGER protect_copier_snapshot_trust_raw_before_write
BEFORE UPDATE OR DELETE ON arena.raw_objects
FOR EACH ROW EXECUTE FUNCTION arena.protect_copier_snapshot_trust_raw_object();

ALTER TABLE arena.copier_snapshot_trust_publications
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.copier_snapshot_trust_publications
  FORCE ROW LEVEL SECURITY;
ALTER TABLE arena.copier_snapshot_trust_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.copier_snapshot_trust_rows FORCE ROW LEVEL SECURITY;

ALTER TABLE arena.copier_snapshot_trust_publications OWNER TO postgres;
ALTER TABLE arena.copier_snapshot_trust_rows OWNER TO postgres;
ALTER FUNCTION arena.validate_copier_snapshot_trust_publication_insert()
  OWNER TO postgres;
ALTER FUNCTION arena.reject_copier_snapshot_trust_publication_mutation()
  OWNER TO postgres;
ALTER FUNCTION arena.reject_copier_snapshot_trust_row_mutation()
  OWNER TO postgres;
ALTER FUNCTION arena.protect_copier_snapshot_trust_raw_object()
  OWNER TO postgres;

REVOKE ALL ON TABLE arena.copier_snapshot_trust_publications
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE arena.copier_snapshot_trust_rows
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE
  arena.copier_snapshot_trust_publications_publication_id_seq
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  arena.validate_copier_snapshot_trust_publication_insert()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  arena.reject_copier_snapshot_trust_publication_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.reject_copier_snapshot_trust_row_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.protect_copier_snapshot_trust_raw_object()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE arena.copier_snapshot_trust_publications IS
  'Private immutable artifact@2 evidence receipts. No completeness claim, rank grant, or API DML authority; coverage is only partial/unknown.';
COMMENT ON TABLE arena.copier_snapshot_trust_rows IS
  'Private ordered artifact@2 projection evidence. Canonical text is retained for later exact PostgreSQL tuple replay; duplicate occurrences reject the whole transaction.';
COMMENT ON COLUMN
  arena.copier_snapshot_trust_publications.live_raw_object_id IS
  'Live copier_snapshot_trust RAW FK; ordinary retention may tombstone only this pointer while publication-time identity remains immutable.';
COMMENT ON COLUMN arena.copier_snapshot_trust_rows.source_event_at IS
  'Projection tuple @1 has no reviewed per-copier event clock; this value must remain NULL.';

DO $postflight$
DECLARE
  v_relation record;
  v_function record;
  v_sequence_acl record;
BEGIN
  FOR v_relation IN
    SELECT relation_row.relname,
           relation_row.relowner,
           relation_row.relrowsecurity,
           relation_row.relforcerowsecurity,
           (
             SELECT pg_catalog.array_agg(
                      acl_row.privilege_type ORDER BY acl_row.privilege_type
                    )
               FROM pg_catalog.aclexplode(relation_row.relacl) AS acl_row
           ) AS acl_privileges,
           (
             SELECT pg_catalog.bool_and(
                      acl_row.grantor = 'postgres'::pg_catalog.regrole
                      AND acl_row.grantee = 'postgres'::pg_catalog.regrole
                      AND NOT acl_row.is_grantable
                    )
               FROM pg_catalog.aclexplode(relation_row.relacl) AS acl_row
           ) AS acl_principals
      FROM pg_catalog.pg_class AS relation_row
     WHERE relation_row.oid IN (
       'arena.copier_snapshot_trust_publications'::pg_catalog.regclass,
       'arena.copier_snapshot_trust_rows'::pg_catalog.regclass
     )
  LOOP
    IF v_relation.relowner IS DISTINCT FROM 'postgres'::pg_catalog.regrole
       OR v_relation.relrowsecurity IS DISTINCT FROM true
       OR v_relation.relforcerowsecurity IS DISTINCT FROM true
       OR v_relation.acl_privileges IS DISTINCT FROM ARRAY[
            'DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER',
            'TRUNCATE', 'UPDATE'
          ]::text[]
       OR v_relation.acl_principals IS DISTINCT FROM true THEN
      RAISE EXCEPTION
        'copier snapshot trust private relation ACL fingerprint failed for % (owner %, rls %, force %, privileges %, principals %)',
        v_relation.relname,
        v_relation.relowner,
        v_relation.relrowsecurity,
        v_relation.relforcerowsecurity,
        v_relation.acl_privileges,
        v_relation.acl_principals;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_class AS relation_row
     WHERE relation_row.oid IN (
       'arena.copier_snapshot_trust_publications'::pg_catalog.regclass,
       'arena.copier_snapshot_trust_rows'::pg_catalog.regclass
     )
  ) <> 2 OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_policy AS policy_row
     WHERE policy_row.polrelid IN (
       'arena.copier_snapshot_trust_publications'::pg_catalog.regclass,
       'arena.copier_snapshot_trust_rows'::pg_catalog.regclass
     )
  ) THEN
    RAISE EXCEPTION 'copier snapshot trust RLS/policy postflight failed';
  END IF;

  SELECT (
           SELECT pg_catalog.array_agg(
                    acl_row.privilege_type ORDER BY acl_row.privilege_type
                  )
             FROM pg_catalog.aclexplode(sequence_row.relacl) AS acl_row
         ) AS privileges,
         (
           SELECT pg_catalog.bool_and(
                    acl_row.grantor = 'postgres'::pg_catalog.regrole
                    AND acl_row.grantee = 'postgres'::pg_catalog.regrole
                    AND NOT acl_row.is_grantable
                  )
             FROM pg_catalog.aclexplode(sequence_row.relacl) AS acl_row
         ) AS principals
    INTO STRICT v_sequence_acl
    FROM pg_catalog.pg_class AS sequence_row
   WHERE sequence_row.oid =
         'arena.copier_snapshot_trust_publications_publication_id_seq'::pg_catalog.regclass
     AND sequence_row.relkind = 'S'
     AND sequence_row.relowner = 'postgres'::pg_catalog.regrole;

  IF v_sequence_acl.privileges IS DISTINCT FROM
       ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]
     OR v_sequence_acl.principals IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'copier snapshot trust identity sequence ACL fingerprint failed';
  END IF;

  FOR v_function IN
    SELECT procedure_row.proname,
           procedure_row.proowner,
           procedure_row.prosecdef,
           (
             SELECT pg_catalog.array_agg(
                      acl_row.privilege_type ORDER BY acl_row.privilege_type
                    )
               FROM pg_catalog.aclexplode(procedure_row.proacl) AS acl_row
           ) AS acl_privileges,
           (
             SELECT pg_catalog.bool_and(
                      acl_row.grantor = 'postgres'::pg_catalog.regrole
                      AND acl_row.grantee = 'postgres'::pg_catalog.regrole
                      AND NOT acl_row.is_grantable
                    )
               FROM pg_catalog.aclexplode(procedure_row.proacl) AS acl_row
           ) AS acl_principals,
           procedure_row.proconfig
      FROM pg_catalog.pg_proc AS procedure_row
     WHERE procedure_row.oid IN (
       'arena.validate_copier_snapshot_trust_publication_insert()'::pg_catalog.regprocedure,
       'arena.reject_copier_snapshot_trust_publication_mutation()'::pg_catalog.regprocedure,
       'arena.reject_copier_snapshot_trust_row_mutation()'::pg_catalog.regprocedure,
       'arena.protect_copier_snapshot_trust_raw_object()'::pg_catalog.regprocedure
     )
  LOOP
    IF v_function.proowner IS DISTINCT FROM 'postgres'::pg_catalog.regrole
       OR v_function.prosecdef IS DISTINCT FROM
          (v_function.proname = 'protect_copier_snapshot_trust_raw_object')
       OR v_function.acl_privileges IS DISTINCT FROM ARRAY['EXECUTE']::text[]
       OR v_function.acl_principals IS DISTINCT FROM true
       OR v_function.proconfig IS DISTINCT FROM (CASE
            WHEN v_function.proname =
                 'protect_copier_snapshot_trust_raw_object' THEN
              ARRAY[
                'search_path=pg_catalog, pg_temp',
                'row_security=off'
              ]::text[]
            ELSE ARRAY['search_path=pg_catalog, pg_temp']::text[]
          END) THEN
      RAISE EXCEPTION
        'copier snapshot trust function ACL/config fingerprint failed for %',
        v_function.proname;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_proc AS procedure_row
     WHERE procedure_row.oid IN (
       'arena.validate_copier_snapshot_trust_publication_insert()'::pg_catalog.regprocedure,
       'arena.reject_copier_snapshot_trust_publication_mutation()'::pg_catalog.regprocedure,
       'arena.reject_copier_snapshot_trust_row_mutation()'::pg_catalog.regprocedure,
       'arena.protect_copier_snapshot_trust_raw_object()'::pg_catalog.regprocedure
     )
  ) <> 4 THEN
    RAISE EXCEPTION 'copier snapshot trust function postflight failed';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_trigger AS trigger_row
     WHERE NOT trigger_row.tgisinternal
       AND trigger_row.tgenabled = 'O'
       AND trigger_row.tgname IN (
         'copier_snapshot_trust_publication_validate_insert',
         'copier_snapshot_trust_publication_reject_update_delete',
         'copier_snapshot_trust_publication_reject_truncate',
         'copier_snapshot_trust_row_reject_update_delete',
         'copier_snapshot_trust_row_reject_truncate',
         'protect_copier_snapshot_trust_raw_before_write'
       )
       AND trigger_row.tgrelid IN (
         'arena.copier_snapshot_trust_publications'::pg_catalog.regclass,
         'arena.copier_snapshot_trust_rows'::pg_catalog.regclass,
         'arena.raw_objects'::pg_catalog.regclass
       )
  ) <> 6 THEN
    RAISE EXCEPTION 'copier snapshot trust trigger postflight failed';
  END IF;

  IF pg_catalog.has_table_privilege(
       'anon', 'arena.copier_snapshot_trust_publications',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
     ) OR pg_catalog.has_table_privilege(
       'authenticated', 'arena.copier_snapshot_trust_publications',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
     ) OR pg_catalog.has_table_privilege(
       'service_role', 'arena.copier_snapshot_trust_publications',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
     ) OR pg_catalog.has_table_privilege(
       'anon', 'arena.copier_snapshot_trust_rows',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
     ) OR pg_catalog.has_table_privilege(
       'authenticated', 'arena.copier_snapshot_trust_rows',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
     ) OR pg_catalog.has_table_privilege(
       'service_role', 'arena.copier_snapshot_trust_rows',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
     ) THEN
    RAISE EXCEPTION 'copier snapshot trust API table privilege postflight failed';
  END IF;
END
$postflight$;

COMMIT;
