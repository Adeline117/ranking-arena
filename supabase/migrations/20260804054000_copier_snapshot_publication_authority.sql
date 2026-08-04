-- Atomic copier-snapshot writer and receipt-first aggregate reader.
--
-- The 053000 substrate intentionally created only private immutable storage.
-- This migration admits only verified, adapter-exhausted acquisitions, derives
-- every aggregate from the exact JSON row array inside PostgreSQL, and keeps
-- the prior containment reader only as a rolling-deploy fallback.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    '20260804-copier-snapshot-publication-authority',
    0
  )
);

DO $preflight$
DECLARE
  v_aggregate oid := pg_catalog.to_regprocedure(
    'public.arena_copier_aggregate(text,text)'
  );
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR current_user IS DISTINCT FROM 'postgres'
     OR pg_catalog.to_regclass(
       'arena.copier_snapshot_publications'
     ) IS NULL
     OR pg_catalog.to_regclass('arena.copier_snapshot_rows') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass('arena.copier_records') IS NULL
     OR v_aggregate IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'copier snapshot authority requires PG17 and the complete 053000 substrate';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_aggregate
      AND procedure.proowner = 'postgres'::pg_catalog.regrole
      AND procedure.prosecdef
      AND procedure.provolatile = 's'
      AND procedure.proconfig IS NOT DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND pg_catalog.strpos(
        procedure.prosrc,
        'arena.copier-aggregate-containment@1'
      ) > 0
  ) AND pg_catalog.to_regprocedure(
    'arena.copier_aggregate_legacy_containment_v1(text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'copier containment reader lineage drifted before receipt cutover';
  END IF;
END
$preflight$;

LOCK TABLE ONLY arena.sources IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.traders IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.raw_objects IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.copier_snapshot_publications IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.copier_snapshot_rows IN SHARE ROW EXCLUSIVE MODE;

-- Existing 053000 rows are intentionally left nullable and remain
-- non-serving. Only a complete projection written by the authority below may
-- become a public receipt.
ALTER TABLE arena.copier_snapshot_publications
  ADD COLUMN IF NOT EXISTS evidence_state text,
  ADD COLUMN IF NOT EXISTS blocker_reasons jsonb,
  ADD COLUMN IF NOT EXISTS terminal_verifier_contract text,
  ADD COLUMN IF NOT EXISTS request_sha256 text,
  ADD COLUMN IF NOT EXISTS copier_count integer,
  ADD COLUMN IF NOT EXISTS total_copier_pnl numeric,
  ADD COLUMN IF NOT EXISTS pnl_distribution jsonb;

ALTER TABLE arena.copier_snapshot_rows
  ADD COLUMN IF NOT EXISTS raw jsonb;

ALTER TABLE arena.copier_snapshot_publications
  DROP CONSTRAINT IF EXISTS copier_snapshot_publications_scan_terminal_state_check;
ALTER TABLE arena.copier_snapshot_publications
  ADD CONSTRAINT copier_snapshot_publications_scan_terminal_state_check
  CHECK (
    scan_terminal_state IN (
      'stream_exhausted_unverified',
      'caller_limited',
      'exhausted'
    )
  );

ALTER TABLE arena.copier_snapshot_publications
  DROP CONSTRAINT IF EXISTS copier_snapshot_tier_b_not_caller_limited;
ALTER TABLE arena.copier_snapshot_publications
  ADD CONSTRAINT copier_snapshot_tier_b_not_caller_limited
  CHECK (
    lane <> 'tier_b'
    OR scan_terminal_state IN ('stream_exhausted_unverified', 'exhausted')
  );

ALTER TABLE arena.copier_snapshot_publications
  DROP CONSTRAINT IF EXISTS copier_snapshot_publications_data_contract_check;
ALTER TABLE arena.copier_snapshot_publications
  ADD CONSTRAINT copier_snapshot_publications_data_contract_check
  CHECK (
    data_contract IN (
      'arena.ingest.copier-snapshot-artifact@1',
      'arena.ingest.history-acquisition-artifact@1'
    )
  );

ALTER TABLE arena.copier_snapshot_publications
  DROP CONSTRAINT IF EXISTS copier_snapshot_publications_row_hash_contract_check;
ALTER TABLE arena.copier_snapshot_publications
  ADD CONSTRAINT copier_snapshot_publications_row_hash_contract_check
  CHECK (
    row_hash_contract IN (
      'arena.ingest.copier-row-set.strict-canonical-json@1',
      'arena.ingest.copier-row-set.postgresql-jsonb@1'
    )
  );

DO $projection_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'arena.copier_snapshot_publications'::pg_catalog.regclass
      AND constraint_row.conname =
        'copier_snapshot_publication_verified_projection'
  ) THEN
    ALTER TABLE arena.copier_snapshot_publications
      ADD CONSTRAINT copier_snapshot_publication_verified_projection
      CHECK (
        (
          evidence_state IS NULL
          AND blocker_reasons IS NULL
          AND terminal_verifier_contract IS NULL
          AND request_sha256 IS NULL
          AND copier_count IS NULL
          AND total_copier_pnl IS NULL
          AND pnl_distribution IS NULL
        )
        OR (
          evidence_state = 'verified'
          AND scan_terminal_state = 'exhausted'
          AND NOT caller_limited
          AND blocker_reasons IS NOT NULL
          AND blocker_reasons = '[]'::pg_catalog.jsonb
          AND terminal_verifier_contract IS NOT NULL
          AND terminal_verifier_contract ~
            '^arena\.ingest\.history-terminal-verifier\.[a-z0-9_]+(?:\.[a-z0-9_]+)*\.copiers@[1-9][0-9]*$'
          AND request_sha256 IS NOT NULL
          AND request_sha256 ~ '^[0-9a-f]{64}$'
          AND copier_count IS NOT NULL
          AND copier_count = parsed_row_count
          AND copier_count >= 0
          AND (
            (copier_count = 0 AND total_copier_pnl = 0)
            OR (
              copier_count > 0
              AND (
                total_copier_pnl IS NULL
                OR total_copier_pnl NOT IN (
                  'NaN'::numeric,
                  'Infinity'::numeric,
                  '-Infinity'::numeric
                )
              )
            )
          )
          AND pnl_distribution IS NOT NULL
          AND pg_catalog.jsonb_typeof(pnl_distribution) = 'array'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'arena.copier_snapshot_rows'::pg_catalog.regclass
      AND constraint_row.conname = 'copier_snapshot_row_raw_object'
  ) THEN
    ALTER TABLE arena.copier_snapshot_rows
      ADD CONSTRAINT copier_snapshot_row_raw_object
      CHECK (
        raw IS NULL OR pg_catalog.jsonb_typeof(raw) = 'object'
      );
  END IF;
END
$projection_constraints$;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_copier_snapshot_verified_source_run
  ON arena.copier_snapshot_publications (source_run_id)
  WHERE evidence_state = 'verified';

-- Preserve the exact 052000 containment reader as a private fallback. Moving
-- the function retains its body/owner while removing the extra public RPC
-- name. Replays skip this block once the helper exists.
DO $preserve_legacy_reader$
BEGIN
  IF pg_catalog.to_regprocedure(
       'arena.copier_aggregate_legacy_containment_v1(text,text)'
     ) IS NULL THEN
    ALTER FUNCTION public.arena_copier_aggregate(text, text)
      SET SCHEMA arena;
    ALTER FUNCTION arena.arena_copier_aggregate(text, text)
      RENAME TO copier_aggregate_legacy_containment_v1;
  END IF;
END
$preserve_legacy_reader$;

ALTER FUNCTION arena.copier_aggregate_legacy_containment_v1(text, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION
  arena.copier_aggregate_legacy_containment_v1(text, text)
FROM PUBLIC, anon, authenticated, service_role;

-- This marker is created once. 055000 replaces its result with false; replay
-- of 054000 must never reopen the fallback after that irreversible cutover.
DO $create_fallback_marker$
BEGIN
  IF pg_catalog.to_regprocedure(
       'arena.copier_snapshot_legacy_fallback_enabled()'
     ) IS NULL THEN
    EXECUTE $ddl$
      CREATE FUNCTION arena.copier_snapshot_legacy_fallback_enabled()
      RETURNS boolean
      LANGUAGE sql
      IMMUTABLE
      PARALLEL SAFE
      SET search_path = pg_catalog, pg_temp
      AS 'SELECT true'
    $ddl$;
  END IF;
END
$create_fallback_marker$;

ALTER FUNCTION arena.copier_snapshot_legacy_fallback_enabled()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.copier_snapshot_legacy_fallback_enabled()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.publish_copier_snapshot_v1(
  p_request jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_expected_keys constant text[] := ARRAY[
    'blockerReasons',
    'contract',
    'currency',
    'evidenceState',
    'observedAt',
    'rawObjectId',
    'rows',
    'scanTerminalState',
    'sourceId',
    'sourceRunId',
    'traderId'
  ]::text[];
  v_expected_row_keys constant text[] := ARRAY[
    'copierInvested',
    'copierLabel',
    'copierPnl',
    'copyDurationDays',
    'dedupeHash',
    'raw',
    'ts'
  ]::text[];
  v_expected_termination_keys constant text[] := ARRAY[
    'blocker_reasons',
    'claim_observations',
    'evidence_state',
    'overlap_event_at',
    'scan_terminal_state',
    'terminal_cursor_value',
    'verifier_contract'
  ]::text[];
  v_expected_observation_keys constant text[] := ARRAY[
    'page_ordinal',
    'reason',
    'segment_id'
  ]::text[];
  v_actual_keys text[];
  v_source_id smallint;
  v_trader_id bigint;
  v_raw_object_id bigint;
  v_source_run_id text;
  v_observed_at timestamptz;
  v_currency text;
  v_depth text;
  v_source_slug text;
  v_exchange_trader_id text;
  v_raw arena.raw_objects%ROWTYPE;
  v_terminal_verifier_contract text;
  v_page_count integer;
  v_row_count integer;
  v_request_sha256 text;
  v_row_set_sha256 text;
  v_total_copier_pnl numeric;
  v_distribution jsonb;
  v_publication_id bigint;
  v_previous_publication_id bigint;
  v_published_at timestamptz;
  v_existing arena.copier_snapshot_publications%ROWTYPE;
  v_row jsonb;
  v_observation jsonb;
  v_ordinal bigint;
  v_row_ts timestamptz;
  v_duration numeric;
  v_page_ordinal numeric;
  v_previous_page_ordinal numeric := 0;
  v_seen_terminal_segments text[] := ARRAY[]::text[];
  v_rows_written integer;
BEGIN
  IF p_request IS NULL
     OR pg_catalog.jsonb_typeof(p_request) <> 'object' THEN
    RAISE EXCEPTION 'copier snapshot request must be an exact JSON object'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(key_name ORDER BY key_name)
  INTO v_actual_keys
  FROM pg_catalog.jsonb_object_keys(p_request) AS key_name;
  IF v_actual_keys IS DISTINCT FROM v_expected_keys THEN
    RAISE EXCEPTION 'copier snapshot request keys are not exact'
      USING ERRCODE = '22023';
  END IF;

  IF p_request->>'contract' IS DISTINCT FROM
       'arena.copier-snapshot-publication@1'
     OR p_request->>'evidenceState' IS DISTINCT FROM 'verified'
     OR p_request->>'scanTerminalState' IS DISTINCT FROM 'exhausted'
     OR p_request->'blockerReasons' IS DISTINCT FROM '[]'::jsonb
     OR pg_catalog.jsonb_typeof(p_request->'rows') <> 'array'
     OR pg_catalog.jsonb_typeof(p_request->'sourceId') <> 'number'
     OR pg_catalog.jsonb_typeof(p_request->'traderId') <> 'number'
     OR pg_catalog.jsonb_typeof(p_request->'rawObjectId') <> 'number'
     OR pg_catalog.jsonb_typeof(p_request->'sourceRunId') <> 'string'
     OR pg_catalog.jsonb_typeof(p_request->'observedAt') <> 'string'
     OR pg_catalog.jsonb_typeof(p_request->'currency') <> 'string' THEN
    RAISE EXCEPTION 'copier snapshot request evidence or value types are invalid'
      USING ERRCODE = '22023';
  END IF;

  IF p_request->>'sourceId' !~ '^[1-9][0-9]*$'
     OR p_request->>'traderId' !~ '^[1-9][0-9]*$'
     OR p_request->>'rawObjectId' !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'copier snapshot identifiers must be positive JSON integers'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_source_id := (p_request->>'sourceId')::smallint;
    v_trader_id := (p_request->>'traderId')::bigint;
    v_raw_object_id := (p_request->>'rawObjectId')::bigint;
    v_observed_at := (p_request->>'observedAt')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'copier snapshot coordinates are invalid'
      USING ERRCODE = '22023';
  END;

  v_source_run_id := p_request->>'sourceRunId';
  v_currency := p_request->>'currency';
  IF v_source_id <= 0
     OR v_trader_id <= 0
     OR v_raw_object_id <= 0
     OR NOT pg_catalog.isfinite(v_observed_at)
     OR v_source_run_id !~ '^[0-9a-f]{64}$'
     OR v_source_run_id = pg_catalog.repeat('0', 64)
     OR p_request->>'observedAt' IS DISTINCT FROM pg_catalog.to_char(
       v_observed_at AT TIME ZONE 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
     ) THEN
    RAISE EXCEPTION 'copier snapshot coordinates are outside their contract'
      USING ERRCODE = '22023';
  END IF;

  v_row_count := pg_catalog.jsonb_array_length(p_request->'rows');
  IF v_row_count > 10000000 THEN
    RAISE EXCEPTION 'copier snapshot row count exceeds the contract maximum'
      USING ERRCODE = '54000';
  END IF;

  FOR v_row, v_ordinal IN
    SELECT row_value, row_number
    FROM pg_catalog.jsonb_array_elements(p_request->'rows')
      WITH ORDINALITY AS item(row_value, row_number)
  LOOP
    IF pg_catalog.jsonb_typeof(v_row) <> 'object' THEN
      RAISE EXCEPTION 'copier snapshot row % is not an object', v_ordinal
        USING ERRCODE = '22023';
    END IF;
    SELECT pg_catalog.array_agg(key_name ORDER BY key_name)
    INTO v_actual_keys
    FROM pg_catalog.jsonb_object_keys(v_row) AS key_name;
    IF v_actual_keys IS DISTINCT FROM v_expected_row_keys
       OR pg_catalog.jsonb_typeof(v_row->'ts') <> 'string'
       OR pg_catalog.jsonb_typeof(v_row->'dedupeHash') <> 'string'
       OR pg_catalog.jsonb_typeof(v_row->'raw') <> 'object'
       OR pg_catalog.jsonb_typeof(v_row->'copierLabel') NOT IN ('string', 'null')
       OR pg_catalog.jsonb_typeof(v_row->'copierPnl') NOT IN ('number', 'null')
       OR pg_catalog.jsonb_typeof(v_row->'copierInvested') NOT IN ('number', 'null')
       OR pg_catalog.jsonb_typeof(v_row->'copyDurationDays') NOT IN ('number', 'null')
       OR v_row->>'dedupeHash' IS DISTINCT FROM
            pg_catalog.btrim(v_row->>'dedupeHash')
       OR pg_catalog.char_length(v_row->>'dedupeHash') NOT BETWEEN 1 AND 512
       OR (
         pg_catalog.jsonb_typeof(v_row->'copierLabel') = 'string'
         AND (
           v_row->>'copierLabel' IS DISTINCT FROM
             pg_catalog.btrim(v_row->>'copierLabel')
           OR pg_catalog.char_length(v_row->>'copierLabel') NOT BETWEEN 1 AND 512
         )
       ) THEN
      RAISE EXCEPTION 'copier snapshot row % shape is invalid', v_ordinal
        USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_row_ts := (v_row->>'ts')::timestamptz;
      IF NOT pg_catalog.isfinite(v_row_ts)
         OR v_row->>'ts' IS DISTINCT FROM pg_catalog.to_char(
           v_row_ts AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
         )
         OR v_row_ts > v_observed_at + interval '5 minutes' THEN
        RAISE EXCEPTION 'non-finite row timestamp';
      END IF;
      IF pg_catalog.jsonb_typeof(v_row->'copyDurationDays') = 'number' THEN
        v_duration := (v_row->>'copyDurationDays')::numeric;
        IF v_duration < 0
           OR v_duration > 2147483647
           OR v_duration <> pg_catalog.trunc(v_duration) THEN
          RAISE EXCEPTION 'invalid copy duration';
        END IF;
      END IF;
      IF pg_catalog.jsonb_typeof(v_row->'copierInvested') = 'number'
         AND (v_row->>'copierInvested')::numeric < 0 THEN
        RAISE EXCEPTION 'negative copier investment';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'copier snapshot row % numeric or clock value is invalid', v_ordinal
        USING ERRCODE = '22023';
    END;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*) <> pg_catalog.count(DISTINCT row_value->>'dedupeHash')
    FROM pg_catalog.jsonb_array_elements(p_request->'rows') AS row_value
  ) THEN
    RAISE EXCEPTION 'copier snapshot dedupeHash values must be unique'
      USING ERRCODE = '23505';
  END IF;

  v_request_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_request::text, 'UTF8')),
    'hex'
  );
  v_row_set_sha256 := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to((p_request->'rows')::text, 'UTF8')
    ),
    'hex'
  );

  SELECT CASE
    WHEN v_row_count = 0 THEN 0::numeric
    WHEN pg_catalog.count(*) FILTER (
      WHERE pg_catalog.jsonb_typeof(row_value->'copierPnl') = 'number'
    ) = 0 THEN NULL::numeric
    ELSE pg_catalog.sum((row_value->>'copierPnl')::numeric)
      FILTER (
        WHERE pg_catalog.jsonb_typeof(row_value->'copierPnl') = 'number'
      )
    END
  INTO v_total_copier_pnl
  FROM pg_catalog.jsonb_array_elements(p_request->'rows') AS row_value;

  WITH bucketed AS (
    SELECT CASE
      WHEN (row_value->>'copierPnl')::numeric < -1000 THEN '<-1000'
      WHEN (row_value->>'copierPnl')::numeric < 0 THEN '-1000~0'
      WHEN (row_value->>'copierPnl')::numeric < 1000 THEN '0~1000'
      WHEN (row_value->>'copierPnl')::numeric < 10000 THEN '1000~10000'
      ELSE '>10000'
    END AS bucket,
    CASE
      WHEN (row_value->>'copierPnl')::numeric < -1000 THEN 0
      WHEN (row_value->>'copierPnl')::numeric < 0 THEN 1
      WHEN (row_value->>'copierPnl')::numeric < 1000 THEN 2
      WHEN (row_value->>'copierPnl')::numeric < 10000 THEN 3
      ELSE 4
    END AS ordinal
    FROM pg_catalog.jsonb_array_elements(p_request->'rows') AS row_value
    WHERE pg_catalog.jsonb_typeof(row_value->'copierPnl') = 'number'
  ), counts AS (
    SELECT bucket, ordinal, pg_catalog.count(*)::integer AS bucket_count
    FROM bucketed
    GROUP BY bucket, ordinal
  )
  SELECT CASE
    WHEN v_row_count >= 10
     AND NOT EXISTS (
       SELECT 1 FROM counts WHERE bucket_count < 5
     )
    THEN COALESCE(
      (
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'bucket', bucket,
            'count', bucket_count
          )
          ORDER BY ordinal
        )
        FROM counts
      ),
      '[]'::jsonb
    )
    ELSE '[]'::jsonb
  END
  INTO v_distribution;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena-copier-source-run:' || v_source_run_id,
      0
    )
  );

  SELECT publication.*
  INTO v_existing
  FROM arena.copier_snapshot_publications AS publication
  WHERE publication.source_run_id = v_source_run_id
    AND publication.evidence_state = 'verified'
  ORDER BY publication.publication_id
  LIMIT 1;

  IF FOUND THEN
    IF v_existing.request_sha256 IS DISTINCT FROM v_request_sha256
       OR v_existing.source_id IS DISTINCT FROM v_source_id
       OR v_existing.trader_id IS DISTINCT FROM v_trader_id
       OR v_existing.raw_object_id_at_publication IS DISTINCT FROM v_raw_object_id
       OR v_existing.observed_at IS DISTINCT FROM v_observed_at
       OR v_existing.parsed_row_count IS DISTINCT FROM v_row_count
       OR v_existing.row_set_sha256 IS DISTINCT FROM v_row_set_sha256 THEN
      RAISE EXCEPTION 'copier snapshot sourceRunId replay conflicts with its immutable request'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena-copier-subject:' || v_source_id::text || ':' || v_trader_id::text,
      0
    )
  );

  SELECT
    source_row.copier_table_depth,
    source_row.currency,
    source_row.slug,
    trader_row.exchange_trader_id
  INTO v_depth, v_currency, v_source_slug, v_exchange_trader_id
  FROM arena.sources AS source_row
  JOIN arena.traders AS trader_row
    ON trader_row.source_id = source_row.id
  WHERE source_row.id = v_source_id
    AND trader_row.id = v_trader_id
    AND source_row.status = 'active'
    AND source_row.serving_mode = 'serving'
    AND source_row.copier_table_depth IN ('full', 'top10', 'top3_preview')
    AND source_row.currency = p_request->>'currency'
  FOR KEY SHARE OF source_row, trader_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copier snapshot subject is not active serving or its source contract drifted'
      USING ERRCODE = '55000';
  END IF;

  -- RAW GC is permitted to tombstone only the live FK after the immutable
  -- path, hash, identity, clocks and request digest have been frozen. Preserve
  -- exact replay for that case. A still-live replay continues through the RAW
  -- validation below so quarantine or evidence drift cannot return success.
  IF v_existing.publication_id IS NOT NULL
     AND v_existing.live_raw_object_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'receiptId', v_existing.publication_id,
      'sourceRunId', v_existing.source_run_id,
      'observedAt', pg_catalog.to_char(
        v_existing.observed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'publishedAt', pg_catalog.to_char(
        v_existing.published_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'rowCount', v_existing.parsed_row_count
    );
  END IF;
  IF v_existing.publication_id IS NOT NULL
     AND v_existing.live_raw_object_id IS DISTINCT FROM v_raw_object_id THEN
    RAISE EXCEPTION 'copier snapshot replay no longer has its exact live RAW evidence'
      USING ERRCODE = '55000';
  END IF;

  SELECT raw_object.*
  INTO v_raw
  FROM arena.raw_objects AS raw_object
  WHERE raw_object.id = v_raw_object_id
  FOR KEY SHARE;
  IF NOT FOUND
     OR v_raw.source_id IS DISTINCT FROM v_source_id
     OR v_raw.trader_id IS DISTINCT FROM v_trader_id
     OR v_raw.job_type IS DISTINCT FROM 'history:copiers'
     OR v_raw.timeframe IS NOT NULL
     OR v_raw.quarantined
     OR v_raw.source_run_id IS DISTINCT FROM v_source_run_id
     OR v_raw.content_hash IS DISTINCT FROM v_source_run_id
     OR v_raw.trust_artifact_role IS DISTINCT FROM 'event_history'
     OR v_raw.fetched_at IS DISTINCT FROM v_observed_at
     OR v_raw.meta->>'data_contract' IS DISTINCT FROM
        'arena.ingest.history-acquisition-artifact@1'
     OR v_raw.meta->>'history_evidence_contract' IS DISTINCT FROM
        'arena.event-history-publication-evidence@1'
     OR v_raw.meta->>'source_run_id' IS DISTINCT FROM v_source_run_id
     OR v_raw.meta->>'source_slug' IS DISTINCT FROM v_source_slug
     OR v_raw.meta->>'exchange_trader_id' IS DISTINCT FROM
        v_exchange_trader_id
     OR v_raw.meta->>'observed_at' IS DISTINCT FROM
        p_request->>'observedAt'
     OR v_raw.meta->>'history_kind' IS DISTINCT FROM 'copiers'
     OR v_raw.meta->'starting_cursor' IS DISTINCT FROM 'null'::pg_catalog.jsonb
     OR v_raw.meta->'capture_config' IS DISTINCT FROM
        '{"caller_page_cap":null}'::pg_catalog.jsonb
     OR v_raw.meta->>'terminal_evidence_state' IS DISTINCT FROM 'verified'
     OR v_raw.meta->>'scan_terminal_state' IS DISTINCT FROM 'exhausted'
     OR v_raw.meta->>'verifier_contract' !~
       '^arena\.ingest\.history-terminal-verifier\.[a-z0-9_]+(?:\.[a-z0-9_]+)*\.copiers@[1-9][0-9]*$'
     OR v_raw.meta->'termination'->>'evidence_state' IS DISTINCT FROM
        v_raw.meta->>'terminal_evidence_state'
     OR v_raw.meta->'termination'->>'scan_terminal_state' IS DISTINCT FROM
        v_raw.meta->>'scan_terminal_state'
     OR v_raw.meta->'termination'->>'verifier_contract' IS DISTINCT FROM
        v_raw.meta->>'verifier_contract'
     OR v_raw.meta->'termination'->'terminal_cursor_value' IS DISTINCT FROM
        'null'::pg_catalog.jsonb
     OR v_raw.meta->'termination'->'overlap_event_at' IS DISTINCT FROM
        'null'::pg_catalog.jsonb
     OR v_raw.meta->'termination'->'blocker_reasons' IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'copier snapshot RAW pointer does not prove the exact verified acquisition'
      USING ERRCODE = '55000';
  END IF;
  v_terminal_verifier_contract := v_raw.meta->>'verifier_contract';

  IF pg_catalog.jsonb_typeof(v_raw.meta->'termination') IS DISTINCT FROM
       'object'
     OR pg_catalog.jsonb_typeof(
       v_raw.meta->'termination'->'claim_observations'
     ) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(
       v_raw.meta->'termination'->'claim_observations'
     ) NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'copier snapshot RAW terminal claim shape is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(key_name ORDER BY key_name)
  INTO v_actual_keys
  FROM pg_catalog.jsonb_object_keys(
    v_raw.meta->'termination'
  ) AS key_name;
  IF v_actual_keys IS DISTINCT FROM v_expected_termination_keys THEN
    RAISE EXCEPTION 'copier snapshot RAW terminal claim keys are not exact'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_page_count := (v_raw.meta->>'page_count')::integer;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'copier snapshot RAW page count is invalid'
      USING ERRCODE = '22023';
  END;
  IF v_page_count <= 0 OR v_page_count > 100000 THEN
    RAISE EXCEPTION 'copier snapshot RAW has no bounded response page evidence'
      USING ERRCODE = '22023';
  END IF;

  FOR v_observation IN
    SELECT observation
    FROM pg_catalog.jsonb_array_elements(
      v_raw.meta->'termination'->'claim_observations'
    ) AS observation
  LOOP
    IF pg_catalog.jsonb_typeof(v_observation) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'copier snapshot RAW terminal observation is not an object'
        USING ERRCODE = '22023';
    END IF;
    SELECT pg_catalog.array_agg(key_name ORDER BY key_name)
    INTO v_actual_keys
    FROM pg_catalog.jsonb_object_keys(v_observation) AS key_name;
    IF v_actual_keys IS DISTINCT FROM v_expected_observation_keys
       OR pg_catalog.jsonb_typeof(v_observation->'segment_id') IS DISTINCT FROM
          'string'
       OR v_observation->>'segment_id' !~ '^[a-z0-9][a-z0-9_]{0,63}$'
       OR pg_catalog.jsonb_typeof(v_observation->'reason') IS DISTINCT FROM
          'string'
       OR v_observation->>'reason' NOT IN (
         'empty_page',
         'short_page',
         'reported_end',
         'snapshot_complete'
       )
       OR pg_catalog.jsonb_typeof(v_observation->'page_ordinal') IS DISTINCT FROM
          'number' THEN
      RAISE EXCEPTION 'copier snapshot RAW terminal observation shape is invalid'
        USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_page_ordinal := (v_observation->>'page_ordinal')::numeric;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'copier snapshot RAW terminal observation ordinal is invalid'
        USING ERRCODE = '22023';
    END;
    IF v_page_ordinal <> pg_catalog.trunc(v_page_ordinal)
       OR v_page_ordinal < 1
       OR v_page_ordinal > v_page_count
       OR v_page_ordinal <= v_previous_page_ordinal
       OR v_observation->>'segment_id' = ANY(v_seen_terminal_segments) THEN
      RAISE EXCEPTION 'copier snapshot RAW terminal observation is outside captured pages'
        USING ERRCODE = '22023';
    END IF;
    v_previous_page_ordinal := v_page_ordinal;
    v_seen_terminal_segments := pg_catalog.array_append(
      v_seen_terminal_segments,
      v_observation->>'segment_id'
    );
  END LOOP;

  -- A live pointer has just been revalidated against the same non-quarantined
  -- RAW object, so its exact replay may succeed. The earlier branch separately
  -- permits legitimate GC tombstones to replay from the frozen receipt;
  -- quarantine never clears the pointer and therefore always fails validation.
  IF v_existing.publication_id IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'receiptId', v_existing.publication_id,
      'sourceRunId', v_existing.source_run_id,
      'observedAt', pg_catalog.to_char(
        v_existing.observed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'publishedAt', pg_catalog.to_char(
        v_existing.published_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'rowCount', v_existing.parsed_row_count
    );
  END IF;

  SELECT publication.publication_id
  INTO v_previous_publication_id
  FROM arena.copier_snapshot_publications AS publication
  WHERE publication.source_id = v_source_id
    AND publication.trader_id = v_trader_id
  ORDER BY publication.publication_id DESC
  LIMIT 1;

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
    publisher_contract,
    evidence_state,
    blocker_reasons,
    terminal_verifier_contract,
    request_sha256,
    copier_count,
    total_copier_pnl,
    pnl_distribution
  ) VALUES (
    v_source_id,
    v_trader_id,
    'tier_c',
    v_source_run_id,
    v_raw_object_id,
    v_raw_object_id,
    v_raw.storage_path,
    v_raw.content_hash,
    v_raw.fetched_at,
    v_observed_at,
    v_previous_publication_id,
    'exhausted',
    false,
    v_page_count,
    v_row_count,
    NULL,
    v_depth,
    v_currency,
    v_row_set_sha256,
    'arena.copier-snapshot-publication@1',
    'arena.copier-histogram-k-anonymity@1',
    'arena.ingest.history-acquisition-artifact@1',
    'arena.ingest.copier-parser@1',
    'arena.ingest.copier-row-set.postgresql-jsonb@1',
    'arena.ingest.copier-snapshot-publisher@1',
    'verified',
    '[]'::jsonb,
    v_terminal_verifier_contract,
    v_request_sha256,
    v_row_count,
    v_total_copier_pnl,
    v_distribution
  )
  RETURNING publication_id, published_at
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
    row_sha256,
    raw
  )
  SELECT
    v_publication_id,
    (item.row_number - 1)::integer,
    (item.row_value->>'ts')::timestamptz,
    CASE
      WHEN pg_catalog.jsonb_typeof(item.row_value->'copierLabel') = 'string'
      THEN item.row_value->>'copierLabel'
      ELSE NULL
    END,
    CASE
      WHEN pg_catalog.jsonb_typeof(item.row_value->'copierPnl') = 'number'
      THEN (item.row_value->>'copierPnl')::numeric
      ELSE NULL
    END,
    CASE
      WHEN pg_catalog.jsonb_typeof(item.row_value->'copierInvested') = 'number'
      THEN (item.row_value->>'copierInvested')::numeric
      ELSE NULL
    END,
    CASE
      WHEN pg_catalog.jsonb_typeof(item.row_value->'copyDurationDays') = 'number'
      THEN (item.row_value->>'copyDurationDays')::integer
      ELSE NULL
    END,
    item.row_value->>'dedupeHash',
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(item.row_value::text, 'UTF8')
      ),
      'hex'
    ),
    item.row_value->'raw'
  FROM pg_catalog.jsonb_array_elements(p_request->'rows')
    WITH ORDINALITY AS item(row_value, row_number);
  GET DIAGNOSTICS v_rows_written = ROW_COUNT;
  IF v_rows_written IS DISTINCT FROM v_row_count THEN
    RAISE EXCEPTION 'copier snapshot private row count did not match its receipt'
      USING ERRCODE = '55000';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'receiptId', v_publication_id,
    'sourceRunId', v_source_run_id,
    'observedAt', pg_catalog.to_char(
      v_observed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'publishedAt', pg_catalog.to_char(
      v_published_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'rowCount', v_row_count
  );
END
$function$;

ALTER FUNCTION public.publish_copier_snapshot_v1(jsonb)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.publish_copier_snapshot_v1(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.publish_copier_snapshot_v1(jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.arena_copier_aggregate(
  p_source text,
  p_trader text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  -- arena.copier-snapshot-receipt-reader@1
  WITH resolved AS (
    SELECT
      source_row.id AS source_id,
      trader_row.id AS trader_id,
      source_row.copier_table_depth,
      source_row.currency
    FROM arena.sources AS source_row
    JOIN arena.traders AS trader_row
      ON trader_row.source_id = source_row.id
    WHERE source_row.slug = p_source
      AND trader_row.exchange_trader_id = p_trader
      AND source_row.status = 'active'
      AND source_row.serving_mode = 'serving'
  ), latest_receipt_candidate AS (
    SELECT publication.*
    FROM arena.copier_snapshot_publications AS publication
    CROSS JOIN resolved
    WHERE publication.source_id = resolved.source_id
      AND publication.trader_id = resolved.trader_id
    ORDER BY publication.observed_at DESC, publication.publication_id DESC
    LIMIT 1
  ), latest_receipt AS (
    SELECT publication.*
    FROM latest_receipt_candidate AS publication
    WHERE publication.evidence_contract =
          'arena.copier-snapshot-publication@1'
      AND publication.evidence_state = 'verified'
      AND publication.scan_terminal_state = 'exhausted'
      AND NOT publication.caller_limited
      AND publication.blocker_reasons = '[]'::pg_catalog.jsonb
      AND publication.terminal_verifier_contract ~
          '^arena\.ingest\.history-terminal-verifier\.[a-z0-9_]+(?:\.[a-z0-9_]+)*\.copiers@[1-9][0-9]*$'
      AND publication.request_sha256 IS NOT NULL
      AND publication.copier_count IS NOT NULL
      AND publication.copier_count = publication.parsed_row_count
      AND publication.pnl_distribution IS NOT NULL
      AND (
        publication.live_raw_object_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM arena.raw_objects AS raw_object
          WHERE raw_object.id = publication.live_raw_object_id
            AND NOT raw_object.quarantined
        )
      )
  ), receipt_payload AS (
    SELECT pg_catalog.jsonb_build_object(
      'copierCount', receipt.copier_count,
      'copierCountMax', NULL,
      'totalCopierPnl', receipt.total_copier_pnl,
      'currency', receipt.currency,
      'depth', receipt.source_depth,
      'asOf', pg_catalog.to_char(
        receipt.observed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'sourceAsOf', NULL,
      'observedAt', pg_catalog.to_char(
        receipt.observed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'publishedAt', pg_catalog.to_char(
        receipt.published_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'pnlDistribution', receipt.pnl_distribution,
      'receiptBound', true,
      'receiptId', receipt.publication_id,
      'sourceRunId', receipt.source_run_id,
      'evidenceState', receipt.evidence_state,
      'scanTerminalState', receipt.scan_terminal_state,
      'blockerReasons', receipt.blocker_reasons
    ) AS payload
    FROM latest_receipt AS receipt
    CROSS JOIN resolved
    WHERE receipt.source_depth = resolved.copier_table_depth
      AND receipt.currency = resolved.currency
  ), legacy_payload AS (
    SELECT
      arena.copier_aggregate_legacy_containment_v1(
        p_source,
        p_trader
      ) || pg_catalog.jsonb_build_object(
        'receiptBound', false,
        'receiptId', NULL,
        'sourceRunId', NULL,
        'evidenceState', NULL,
        'scanTerminalState', NULL,
        'blockerReasons', '[]'::pg_catalog.jsonb
      ) AS payload
    WHERE arena.copier_snapshot_legacy_fallback_enabled()
      AND NOT EXISTS (SELECT 1 FROM latest_receipt_candidate)
  )
  SELECT payload FROM receipt_payload
  UNION ALL
  SELECT payload FROM legacy_payload
  WHERE payload IS NOT NULL
  LIMIT 1;
$function$;

ALTER FUNCTION public.arena_copier_aggregate(text, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arena_copier_aggregate(text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_copier_aggregate(text, text)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.publish_copier_snapshot_v1(jsonb) IS
  'Service-only exact-input authority: validates one verified exhausted copier acquisition and atomically commits its private rows and immutable receipt.';
COMMENT ON FUNCTION public.arena_copier_aggregate(text, text) IS
  'Receipt-first aggregate-only copier reader. During the rolling bridge only, no-receipt subjects may use the quarantined profile-only containment fallback.';

DO $postflight$
DECLARE
  v_publisher oid := pg_catalog.to_regprocedure(
    'public.publish_copier_snapshot_v1(jsonb)'
  );
  v_aggregate oid := pg_catalog.to_regprocedure(
    'public.arena_copier_aggregate(text,text)'
  );
BEGIN
  IF v_publisher IS NULL
     OR v_aggregate IS NULL
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_publisher, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('anon', v_publisher, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', v_publisher, 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege('anon', v_aggregate, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege(
       'authenticated', v_aggregate, 'EXECUTE'
     )
     OR pg_catalog.has_table_privilege(
       'anon', 'arena.copier_snapshot_publications', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'arena.copier_snapshot_rows', 'SELECT'
     ) THEN
    RAISE EXCEPTION 'copier snapshot authority ACL postflight failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_publisher
      AND procedure.proowner = 'postgres'::pg_catalog.regrole
      AND procedure.prosecdef
      AND procedure.provolatile = 'v'
      AND procedure.proconfig IS NOT DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND pg_catalog.strpos(
        procedure.prosrc,
        'copier snapshot private row count did not match its receipt'
      ) > 0
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_aggregate
      AND procedure.proowner = 'postgres'::pg_catalog.regrole
      AND procedure.prosecdef
      AND procedure.provolatile = 's'
      AND procedure.proconfig IS NOT DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND pg_catalog.strpos(
        procedure.prosrc,
        'arena.copier-snapshot-receipt-reader@1'
      ) > 0
  ) THEN
    RAISE EXCEPTION 'copier snapshot authority function postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
