-- One database-owned authority boundary for a parsed copier snapshot.
--
-- The caller may upload RAW first, but it cannot publish a receipt or any
-- private row independently. This function rechecks the live source, trader,
-- RAW identity, capture metadata, row conservation, and publication order,
-- then commits the immutable header and rows as one statement transaction.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    '20260804-publish-copier-snapshot-atomically',
    0
  )
);

DO $preflight$
DECLARE
  old_unique_name text;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.to_regclass(
       'arena.copier_snapshot_publications'
     ) IS NULL
     OR pg_catalog.to_regclass('arena.copier_snapshot_rows') IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.publish_copier_snapshot(smallint,bigint,text,bigint,text,text,timestamp with time zone,boolean,integer,integer,jsonb)'
     ) IS NOT NULL
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'atomic copier publisher requires PG17, snapshot substrate, and API roles';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM arena.copier_snapshot_publications
  ) OR EXISTS (
    SELECT 1
    FROM arena.copier_snapshot_rows
  ) THEN
    RAISE EXCEPTION 'copier row-hash contract cannot change after publication';
  END IF;

  SELECT constraint_row.conname
    INTO old_unique_name
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid =
         'arena.copier_snapshot_publications'::pg_catalog.regclass
     AND constraint_row.contype = 'u'
     AND pg_catalog.pg_get_constraintdef(constraint_row.oid) =
         'UNIQUE (source_id, trader_id, lane, source_run_id, parser_contract)';

  IF old_unique_name IS NULL THEN
    RAISE EXCEPTION 'copier snapshot retry identity constraint drifted';
  END IF;

  EXECUTE pg_catalog.format(
    'ALTER TABLE arena.copier_snapshot_publications DROP CONSTRAINT %I',
    old_unique_name
  );
END
$preflight$;

ALTER TABLE arena.copier_snapshot_publications
  DROP CONSTRAINT copier_snapshot_publications_row_hash_contract_check,
  ADD CONSTRAINT copier_snapshot_publication_row_hash_contract CHECK (
    row_hash_contract = 'arena.ingest.copier-row-set.pg-jsonb-row-hashes@1'
  ),
  ADD CONSTRAINT uq_copier_snapshot_publication_raw_parser UNIQUE (
    source_id,
    trader_id,
    lane,
    raw_object_id_at_publication,
    parser_contract
  );

-- Copier capture is a snapshot artifact, not event history. Give it an exact
-- RAW role instead of overloading the ranking/event-history roles.
ALTER TABLE arena.raw_objects
  DROP CONSTRAINT raw_objects_metric_trust_binding,
  ADD CONSTRAINT raw_objects_metric_trust_binding CHECK (
    (source_run_id IS NULL AND trust_artifact_role IS NULL)
    OR (
      source_run_id ~ '^[0-9a-f]{64}$'
      AND trust_artifact_role IN (
        'source_payload',
        'population_manifest',
        'normalization_components',
        'event_history',
        'price_history',
        'opening_inventory',
        'copier_snapshot'
      )
    )
  );

-- Existing parsers expose one `ts` field but generally fill it with the
-- capture clock. V1 therefore refuses to fabricate per-row event provenance;
-- observed_at on the receipt remains the only snapshot clock.
ALTER TABLE arena.copier_snapshot_rows
  ALTER COLUMN source_event_at DROP NOT NULL;

COMMENT ON COLUMN arena.copier_snapshot_rows.source_event_at IS
  'Nullable, explicitly proven upstream event timestamp only. Copier publisher v1 stores NULL because current parser ts fields usually carry the capture clock.';

CREATE FUNCTION arena.publish_copier_snapshot(
  p_source_id smallint,
  p_trader_id bigint,
  p_lane text,
  p_raw_object_id bigint,
  p_raw_storage_path text,
  p_raw_content_hash text,
  p_observed_at timestamptz,
  p_caller_limited boolean,
  p_page_count integer,
  p_source_reported_row_count integer,
  p_rows jsonb
)
RETURNS TABLE (
  publication_id bigint,
  published_at timestamptz,
  parsed_row_count integer,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_currency text;
  v_source_depth text;
  v_source_slug text;
  v_fetch_region text;
  v_exchange_trader_id text;
  v_raw arena.raw_objects%ROWTYPE;
  v_row_count integer;
  v_rows_with_hash jsonb;
  v_row_set_sha256 text;
  v_previous_publication_id bigint;
  v_previous_observed_at timestamptz;
  v_publication_id bigint;
  v_published_at timestamptz;
  v_existing arena.copier_snapshot_publications%ROWTYPE;
  v_stored_row_count integer;
  v_stored_min_ordinal integer;
  v_stored_max_ordinal integer;
  v_stored_row_set_sha256 text;
  v_inserted integer;
  v_expected_job_type text;
  v_scan_terminal_state text;
BEGIN
  IF p_source_id IS NULL
     OR p_trader_id IS NULL
     OR p_raw_object_id IS NULL
     OR p_source_id <= 0
     OR p_trader_id <= 0
     OR p_raw_object_id <= 0
     OR p_lane IS NULL
     OR p_lane NOT IN ('tier_b', 'tier_c')
     OR p_raw_storage_path IS NULL
     OR p_raw_storage_path <> pg_catalog.btrim(p_raw_storage_path)
     OR pg_catalog.char_length(p_raw_storage_path) NOT BETWEEN 1 AND 1024
     OR p_raw_content_hash IS NULL
     OR p_raw_content_hash !~ '^[0-9a-f]{64}$'
     OR p_observed_at IS NULL
     OR NOT pg_catalog.isfinite(p_observed_at)
     OR p_caller_limited IS NULL
     OR p_page_count IS NULL
     OR p_page_count NOT BETWEEN 1 AND 100000
     OR p_source_reported_row_count < 0
     OR pg_catalog.jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid copier snapshot publication input'
      USING ERRCODE = '22023';
  END IF;

  IF p_lane = 'tier_b' AND p_caller_limited THEN
    RAISE EXCEPTION 'Tier-B copier publication cannot be caller-limited'
      USING ERRCODE = '22023';
  END IF;

  v_row_count := pg_catalog.jsonb_array_length(p_rows);
  IF v_row_count > 10000000
     OR (
       p_source_reported_row_count IS NOT NULL
       AND p_source_reported_row_count < v_row_count
     ) THEN
    RAISE EXCEPTION 'copier snapshot row count contract failed'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(p_rows) AS input_row(value)
     WHERE pg_catalog.jsonb_typeof(input_row.value) IS DISTINCT FROM 'object'
        OR NOT input_row.value ?& ARRAY[
          'row_ordinal',
          'source_event_at',
          'copier_label',
          'copier_pnl',
          'copier_invested',
          'copy_duration_days',
          'dedupe_hash'
        ]::text[]
        OR input_row.value - ARRAY[
          'row_ordinal',
          'source_event_at',
          'copier_label',
          'copier_pnl',
          'copier_invested',
          'copy_duration_days',
          'dedupe_hash'
        ]::text[] <> '{}'::jsonb
  ) THEN
    RAISE EXCEPTION 'copier snapshot rows do not match the exact input shape'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize Tier-B, Tier-C, and future replay attempts for one subject.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena.publish-copier-snapshot:' || p_source_id::text || ':' ||
        p_trader_id::text,
      0
    )
  );

  SELECT source_row.slug, source_row.currency,
         source_row.copier_table_depth, source_row.fetch_region
    INTO v_source_slug, v_currency, v_source_depth, v_fetch_region
    FROM arena.sources AS source_row
   WHERE source_row.id = p_source_id
     AND source_row.status = 'active'
     AND source_row.serving_mode = 'serving'
     AND source_row.copier_table_depth IN (
       'full',
       'top10',
       'top3_preview'
     )
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copier snapshot source is not active serving or has no copier surface'
      USING ERRCODE = '55000';
  END IF;

  SELECT trader.exchange_trader_id
    INTO v_exchange_trader_id
    FROM arena.traders AS trader
   WHERE trader.id = p_trader_id
     AND trader.source_id = p_source_id
     AND NOT COALESCE(trader.meta, '{}'::jsonb) @>
             '{"claimed":true}'::jsonb
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copier snapshot trader is not an unclaimed source subject'
      USING ERRCODE = '55000';
  END IF;

  SELECT raw_row.*
    INTO v_raw
    FROM arena.raw_objects AS raw_row
   WHERE raw_row.id = p_raw_object_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copier snapshot RAW object is missing'
      USING ERRCODE = '55000';
  END IF;

  v_expected_job_type := CASE p_lane
    WHEN 'tier_b' THEN 'history:copiers'
    ELSE 'tier_c'
  END;
  v_scan_terminal_state := CASE
    WHEN p_caller_limited THEN 'caller_limited'
    ELSE 'stream_exhausted_unverified'
  END;

  IF v_raw.source_id IS DISTINCT FROM p_source_id
     OR v_raw.trader_id IS DISTINCT FROM p_trader_id
     OR v_raw.job_type IS DISTINCT FROM v_expected_job_type
     OR v_raw.timeframe IS NOT NULL
     OR v_raw.storage_path IS DISTINCT FROM p_raw_storage_path
     OR v_raw.content_hash IS DISTINCT FROM p_raw_content_hash
     OR v_raw.bytes <= 0
     OR v_raw.quarantined
     OR NOT pg_catalog.isfinite(v_raw.fetched_at)
     OR p_observed_at IS DISTINCT FROM v_raw.fetched_at
     OR p_observed_at > pg_catalog.statement_timestamp() + interval '5 minutes'
     OR pg_catalog.jsonb_typeof(v_raw.meta) IS DISTINCT FROM 'object'
     OR v_raw.meta->>'surface' IS DISTINCT FROM 'copiers'
     OR v_raw.meta->>'lane' IS DISTINCT FROM p_lane
     OR (v_raw.meta->>'page_count')::integer IS DISTINCT FROM p_page_count
     OR (v_raw.meta->>'observed_at')::timestamptz IS DISTINCT FROM p_observed_at
     OR v_raw.meta->'caller_limited' IS DISTINCT FROM
          pg_catalog.to_jsonb(p_caller_limited)
     OR v_raw.meta->'fetch_failed' IS DISTINCT FROM 'false'::jsonb
     OR v_raw.source_run_id IS DISTINCT FROM p_raw_content_hash
     OR v_raw.trust_artifact_role IS DISTINCT FROM 'copier_snapshot'
     OR v_raw.meta->>'data_contract' IS DISTINCT FROM
          'arena.ingest.copier-snapshot-artifact@1'
     OR v_raw.meta->>'source_run_id' IS DISTINCT FROM p_raw_content_hash
     OR (v_raw.meta->>'source_id')::smallint IS DISTINCT FROM p_source_id
     OR (v_raw.meta->>'trader_id')::bigint IS DISTINCT FROM p_trader_id
     OR v_raw.meta->>'source_slug' IS DISTINCT FROM v_source_slug
     OR v_raw.meta->>'exchange_trader_id' IS DISTINCT FROM
          v_exchange_trader_id
     OR v_raw.meta->>'source_depth' IS DISTINCT FROM v_source_depth
     OR v_raw.meta->>'currency' IS DISTINCT FROM v_currency
     OR v_raw.meta->>'fetch_region' IS DISTINCT FROM v_fetch_region
     OR v_raw.meta->>'scan_terminal_state' IS DISTINCT FROM
          v_scan_terminal_state
     OR (
       p_source_reported_row_count IS NULL
       AND v_raw.meta->'source_reported_row_count' IS DISTINCT FROM
             'null'::jsonb
     )
     OR (
       p_source_reported_row_count IS NOT NULL
       AND v_raw.meta->'source_reported_row_count' IS DISTINCT FROM
             pg_catalog.to_jsonb(p_source_reported_row_count)
     )
     OR v_raw.meta->'raw_integrity'->>'content_type' IS DISTINCT FROM
          'application/json'
     OR v_raw.meta->'raw_integrity'->>'encoding' IS DISTINCT FROM 'utf-8'
     OR v_raw.meta->'raw_integrity'->>'hash_algorithm' IS DISTINCT FROM 'sha256'
     OR v_raw.meta->'raw_integrity'->>'hash_scope' IS DISTINCT FROM 'json_utf8'
     OR v_raw.meta->'raw_integrity'->>'compression' IS DISTINCT FROM 'gzip'
     OR v_raw.meta->'raw_integrity'->>'serialization_contract' IS DISTINCT FROM
          'arena.strict-canonical-json@1'
     OR (v_raw.meta->'raw_integrity'->>'compressed_bytes')::integer IS DISTINCT FROM
          v_raw.bytes
     OR (v_raw.meta->'raw_integrity'->>'uncompressed_bytes')::integer <= 0 THEN
    RAISE EXCEPTION 'copier snapshot RAW identity or capture metadata mismatch'
      USING ERRCODE = '55000';
  END IF;

  -- Cast and validate once, then let PostgreSQL own the canonical row hashes.
  -- jsonb_build_object has a stable database representation for this fixed
  -- contract; the set digest hashes the concatenation of fixed-width row
  -- digests in ordinal order (empty input hashes the empty UTF-8 string).
  WITH parsed AS (
    SELECT input_row.row_ordinal,
           input_row.source_event_at::timestamptz AS source_event_at,
           input_row.copier_label,
           input_row.copier_pnl,
           input_row.copier_invested,
           input_row.copy_duration_days,
           input_row.dedupe_hash
      FROM pg_catalog.jsonb_to_recordset(p_rows) AS input_row(
        row_ordinal integer,
        source_event_at text,
        copier_label text,
        copier_pnl numeric,
        copier_invested numeric,
        copy_duration_days integer,
        dedupe_hash text
      )
  ),
  hashed AS (
    SELECT parsed.*,
           pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(
                 pg_catalog.jsonb_build_object(
                   'contract', 'arena.ingest.copier-snapshot-row@1',
                   'row_ordinal', parsed.row_ordinal,
                   'source_event_at', parsed.source_event_at,
                   'copier_label', parsed.copier_label,
                   'copier_pnl', parsed.copier_pnl,
                   'copier_invested', parsed.copier_invested,
                   'copy_duration_days', parsed.copy_duration_days,
                   'dedupe_hash', parsed.dedupe_hash
                 )::text,
                 'UTF8'
               )
             ),
             'hex'
           ) AS row_sha256
      FROM parsed
  )
  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'row_ordinal', hashed.row_ordinal,
               'source_event_at', hashed.source_event_at,
               'copier_label', hashed.copier_label,
               'copier_pnl', hashed.copier_pnl,
               'copier_invested', hashed.copier_invested,
               'copy_duration_days', hashed.copy_duration_days,
               'dedupe_hash', hashed.dedupe_hash,
               'row_sha256', hashed.row_sha256
             ) ORDER BY hashed.row_ordinal
           ),
           '[]'::jsonb
         ),
         pg_catalog.encode(
           pg_catalog.sha256(
             pg_catalog.convert_to(
               COALESCE(
                 pg_catalog.string_agg(
                   hashed.row_sha256,
                   '' ORDER BY hashed.row_ordinal
                 ),
                 ''
               ),
               'UTF8'
             )
           ),
           'hex'
         )
    INTO v_rows_with_hash, v_row_set_sha256
    FROM hashed;

  SELECT pg_catalog.count(*)::integer,
         pg_catalog.min(row_value.row_ordinal),
         pg_catalog.max(row_value.row_ordinal)
    INTO v_stored_row_count, v_stored_min_ordinal, v_stored_max_ordinal
    FROM pg_catalog.jsonb_to_recordset(v_rows_with_hash) AS row_value(
      row_ordinal integer,
      source_event_at timestamptz,
      copier_label text,
      copier_pnl numeric,
      copier_invested numeric,
      copy_duration_days integer,
      dedupe_hash text,
      row_sha256 text
    );

  IF v_stored_row_count IS DISTINCT FROM v_row_count
     OR (
       v_row_count > 0
       AND (
         v_stored_min_ordinal IS DISTINCT FROM 0
         OR v_stored_max_ordinal IS DISTINCT FROM v_row_count - 1
       )
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_to_recordset(v_rows_with_hash) AS row_value(
           row_ordinal integer,
           source_event_at timestamptz,
           copier_label text,
           copier_pnl numeric,
           copier_invested numeric,
           copy_duration_days integer,
           dedupe_hash text,
           row_sha256 text
         )
        WHERE row_value.row_ordinal < 0
           OR row_value.source_event_at IS NOT NULL
           OR (
             row_value.copier_label IS NOT NULL
             AND (
               row_value.copier_label <> pg_catalog.btrim(row_value.copier_label)
               OR pg_catalog.char_length(row_value.copier_label) NOT BETWEEN 1 AND 512
             )
           )
           OR row_value.dedupe_hash IS NULL
           OR row_value.dedupe_hash <> pg_catalog.btrim(row_value.dedupe_hash)
           OR pg_catalog.char_length(row_value.dedupe_hash) NOT BETWEEN 1 AND 512
           OR row_value.copier_pnl IN (
             'NaN'::numeric,
             'Infinity'::numeric,
             '-Infinity'::numeric
           )
           OR row_value.copier_invested < 0
           OR row_value.copier_invested IN (
             'NaN'::numeric,
             'Infinity'::numeric,
             '-Infinity'::numeric
           )
           OR row_value.copy_duration_days < 0
     )
     OR (
       SELECT pg_catalog.count(DISTINCT row_value.row_ordinal)
         FROM pg_catalog.jsonb_to_recordset(v_rows_with_hash) AS row_value(
           row_ordinal integer,
           source_event_at timestamptz,
           copier_label text,
           copier_pnl numeric,
           copier_invested numeric,
           copy_duration_days integer,
           dedupe_hash text,
           row_sha256 text
         )
     ) <> v_row_count
     OR (
       SELECT pg_catalog.count(DISTINCT row_value.dedupe_hash)
         FROM pg_catalog.jsonb_to_recordset(v_rows_with_hash) AS row_value(
           row_ordinal integer,
           source_event_at timestamptz,
           copier_label text,
           copier_pnl numeric,
           copier_invested numeric,
           copy_duration_days integer,
           dedupe_hash text,
           row_sha256 text
         )
     ) <> v_row_count THEN
    RAISE EXCEPTION 'copier snapshot row conservation or value contract failed'
      USING ERRCODE = '22023';
  END IF;

  SELECT publication.*
    INTO v_existing
    FROM arena.copier_snapshot_publications AS publication
   WHERE publication.source_id = p_source_id
     AND publication.trader_id = p_trader_id
     AND publication.lane = p_lane
     AND publication.raw_object_id_at_publication = p_raw_object_id
     AND publication.parser_contract = 'arena.ingest.copier-parser@1'
   FOR SHARE;

  IF FOUND THEN
    IF v_existing.live_raw_object_id IS DISTINCT FROM p_raw_object_id
       OR v_existing.raw_storage_path IS DISTINCT FROM p_raw_storage_path
       OR v_existing.raw_content_hash IS DISTINCT FROM p_raw_content_hash
       OR v_existing.raw_fetched_at IS DISTINCT FROM v_raw.fetched_at
       OR v_existing.observed_at IS DISTINCT FROM p_observed_at
       OR v_existing.scan_terminal_state IS DISTINCT FROM v_scan_terminal_state
       OR v_existing.caller_limited IS DISTINCT FROM p_caller_limited
       OR v_existing.page_count IS DISTINCT FROM p_page_count
       OR v_existing.parsed_row_count IS DISTINCT FROM v_row_count
       OR v_existing.source_reported_row_count IS DISTINCT FROM
            p_source_reported_row_count
       OR v_existing.source_depth IS DISTINCT FROM v_source_depth
       OR v_existing.currency IS DISTINCT FROM v_currency
       OR v_existing.row_set_sha256 IS DISTINCT FROM v_row_set_sha256
       OR v_existing.row_hash_contract IS DISTINCT FROM
            'arena.ingest.copier-row-set.pg-jsonb-row-hashes@1' THEN
      RAISE EXCEPTION 'copier snapshot retry conflicts with immutable receipt'
        USING ERRCODE = '55000';
    END IF;

    SELECT pg_catalog.count(*)::integer,
           pg_catalog.min(snapshot_row.row_ordinal),
           pg_catalog.max(snapshot_row.row_ordinal),
           pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(
                 COALESCE(
                   pg_catalog.string_agg(
                     snapshot_row.row_sha256,
                     '' ORDER BY snapshot_row.row_ordinal
                   ),
                   ''
                 ),
                 'UTF8'
               )
             ),
             'hex'
           )
      INTO v_stored_row_count, v_stored_min_ordinal,
           v_stored_max_ordinal, v_stored_row_set_sha256
      FROM arena.copier_snapshot_rows AS snapshot_row
     WHERE snapshot_row.publication_id = v_existing.publication_id;
    IF v_stored_row_count IS DISTINCT FROM v_existing.parsed_row_count
       OR v_stored_row_set_sha256 IS DISTINCT FROM v_existing.row_set_sha256
       OR (
         v_stored_row_count > 0
         AND (
           v_stored_min_ordinal IS DISTINCT FROM 0
           OR v_stored_max_ordinal IS DISTINCT FROM v_stored_row_count - 1
         )
       ) THEN
      RAISE EXCEPTION 'stored copier snapshot receipt no longer conserves rows'
        USING ERRCODE = '55000';
    END IF;

    RETURN QUERY SELECT v_existing.publication_id,
                        v_existing.published_at,
                        v_existing.parsed_row_count,
                        true;
    RETURN;
  END IF;

  SELECT publication.publication_id, publication.observed_at
    INTO v_previous_publication_id, v_previous_observed_at
    FROM arena.copier_snapshot_publications AS publication
   WHERE publication.source_id = p_source_id
     AND publication.trader_id = p_trader_id
   ORDER BY publication.observed_at DESC, publication.publication_id DESC
   LIMIT 1
   FOR UPDATE;

  IF v_previous_observed_at IS NOT NULL
     AND p_observed_at <= v_previous_observed_at THEN
    RAISE EXCEPTION 'stale copier snapshot publication rejected'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO arena.copier_snapshot_publications (
    source_id,
    trader_id,
    lane,
    source_run_id,
    live_raw_object_id,
    raw_object_id_at_publication,
    raw_storage_path,
    raw_content_hash,
    raw_fetched_at,
    observed_at,
    previous_publication_id,
    scan_terminal_state,
    caller_limited,
    page_count,
    parsed_row_count,
    source_reported_row_count,
    source_depth,
    currency,
    row_set_sha256,
    evidence_contract,
    privacy_contract,
    data_contract,
    parser_contract,
    row_hash_contract,
    publisher_contract
  ) VALUES (
    p_source_id,
    p_trader_id,
    p_lane,
    p_raw_content_hash,
    p_raw_object_id,
    p_raw_object_id,
    p_raw_storage_path,
    p_raw_content_hash,
    v_raw.fetched_at,
    p_observed_at,
    v_previous_publication_id,
    v_scan_terminal_state,
    p_caller_limited,
    p_page_count,
    v_row_count,
    p_source_reported_row_count,
    v_source_depth,
    v_currency,
    v_row_set_sha256,
    'arena.copier-snapshot-publication@1',
    'arena.copier-histogram-k-anonymity@1',
    'arena.ingest.copier-snapshot-artifact@1',
    'arena.ingest.copier-parser@1',
    'arena.ingest.copier-row-set.pg-jsonb-row-hashes@1',
    'arena.ingest.copier-snapshot-publisher@1'
  )
  RETURNING copier_snapshot_publications.publication_id,
            copier_snapshot_publications.published_at
       INTO v_publication_id, v_published_at;

  INSERT INTO arena.copier_snapshot_rows (
    publication_id,
    row_ordinal,
    source_event_at,
    copier_label,
    copier_pnl,
    copier_invested,
    copy_duration_days,
    dedupe_hash,
    row_sha256
  )
  SELECT v_publication_id,
         row_value.row_ordinal,
         row_value.source_event_at,
         row_value.copier_label,
         row_value.copier_pnl,
         row_value.copier_invested,
         row_value.copy_duration_days,
         row_value.dedupe_hash,
         row_value.row_sha256
    FROM pg_catalog.jsonb_to_recordset(v_rows_with_hash) AS row_value(
      row_ordinal integer,
      source_event_at timestamptz,
      copier_label text,
      copier_pnl numeric,
      copier_invested numeric,
      copy_duration_days integer,
      dedupe_hash text,
      row_sha256 text
    )
   ORDER BY row_value.row_ordinal;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  SELECT pg_catalog.count(*)::integer,
         pg_catalog.min(snapshot_row.row_ordinal),
         pg_catalog.max(snapshot_row.row_ordinal),
         pg_catalog.encode(
           pg_catalog.sha256(
             pg_catalog.convert_to(
               COALESCE(
                 pg_catalog.string_agg(
                   snapshot_row.row_sha256,
                   '' ORDER BY snapshot_row.row_ordinal
                 ),
                 ''
               ),
               'UTF8'
             )
           ),
           'hex'
         )
    INTO v_stored_row_count, v_stored_min_ordinal,
         v_stored_max_ordinal, v_stored_row_set_sha256
    FROM arena.copier_snapshot_rows AS snapshot_row
   WHERE snapshot_row.publication_id = v_publication_id;

  IF v_inserted IS DISTINCT FROM v_row_count
     OR v_stored_row_count IS DISTINCT FROM v_row_count
     OR v_stored_row_set_sha256 IS DISTINCT FROM v_row_set_sha256
     OR (
       v_row_count > 0
       AND (
         v_stored_min_ordinal IS DISTINCT FROM 0
         OR v_stored_max_ordinal IS DISTINCT FROM v_row_count - 1
       )
     ) THEN
    RAISE EXCEPTION 'copier snapshot atomic row verification failed'
      USING ERRCODE = '55000';
  END IF;

  RETURN QUERY SELECT v_publication_id, v_published_at, v_row_count, false;
END
$function$;

ALTER FUNCTION arena.publish_copier_snapshot(
  smallint,
  bigint,
  text,
  bigint,
  text,
  text,
  timestamptz,
  boolean,
  integer,
  integer,
  jsonb
) OWNER TO postgres;

REVOKE ALL ON FUNCTION arena.publish_copier_snapshot(
  smallint,
  bigint,
  text,
  bigint,
  text,
  text,
  timestamptz,
  boolean,
  integer,
  integer,
  jsonb
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION arena.publish_copier_snapshot(
  smallint,
  bigint,
  text,
  bigint,
  text,
  text,
  timestamptz,
  boolean,
  integer,
  integer,
  jsonb
) TO service_role;

COMMENT ON FUNCTION arena.publish_copier_snapshot(
  smallint,
  bigint,
  text,
  bigint,
  text,
  text,
  timestamptz,
  boolean,
  integer,
  integer,
  jsonb
) IS
  'Atomically binds one active-serving, unclaimed copier capture to immutable RAW evidence and private conserved rows; exact RAW retries are idempotent and stale observations fail closed.';

DO $postflight$
DECLARE
  writer_oid oid := pg_catalog.to_regprocedure(
    'arena.publish_copier_snapshot(smallint,bigint,text,bigint,text,text,timestamp with time zone,boolean,integer,integer,jsonb)'
  );
BEGIN
  IF writer_oid IS NULL
     OR (
       SELECT NOT procedure_row.prosecdef
          OR procedure_row.proowner <> 'postgres'::pg_catalog.regrole
          OR procedure_row.proconfig IS NULL
          OR NOT procedure_row.proconfig @> ARRAY[
            'search_path=pg_catalog, pg_temp',
            'row_security=off'
          ]::text[]
       FROM pg_catalog.pg_proc AS procedure_row
       WHERE procedure_row.oid = writer_oid
     )
     OR pg_catalog.has_function_privilege(
       'anon', writer_oid, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', writer_oid, 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role', writer_oid, 'EXECUTE'
     )
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_proc AS procedure_row
       WHERE procedure_row.pronamespace = 'arena'::pg_catalog.regnamespace
         AND procedure_row.proname = 'publish_copier_snapshot'
     ) <> 1 THEN
    RAISE EXCEPTION 'atomic copier publisher postflight failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'arena.raw_objects'::pg_catalog.regclass
       AND constraint_row.conname = 'raw_objects_metric_trust_binding'
       AND pg_catalog.pg_get_constraintdef(constraint_row.oid) ~
           'copier_snapshot'
  ) THEN
    RAISE EXCEPTION 'copier snapshot RAW role postflight failed';
  END IF;
END
$postflight$;

COMMIT;
