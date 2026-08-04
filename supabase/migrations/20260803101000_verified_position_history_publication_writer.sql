-- Atomic, evidence-bound writer for verified position history.
--
-- The worker must first persist the immutable Storage object and raw_objects
-- pointer in its caller-owned transaction. This RPC then validates that exact
-- pointer, advances one authoritative receipt chain, binds only exact parsed
-- rows, and updates the compatibility cursor in the same transaction.
-- This receipt proves acquisition termination and exact atomic publication;
-- it does not by itself prove parser coverage, price/cost basis, or ranking
-- eligibility. Those remain separate fail-closed gates.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('20260803-verified-position-history-writer', 0)
);

DO $preflight$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.to_regclass('arena.record_surface_publications') IS NULL
     OR pg_catalog.to_regclass('arena.position_history') IS NULL
     OR pg_catalog.to_regclass('arena.ingest_cursors') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'verified position-history writer requires PG17 and the exact publication substrate';
  END IF;

  IF pg_catalog.to_regprocedure(
       'arena.get_position_history_publication_checkpoint(smallint,bigint)'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.position_history_publication_chain_healthy(bigint,smallint,bigint)'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.publish_verified_position_history(bigint,bigint,timestamptz,jsonb,text,text)'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'arena.protect_verified_position_history_row()'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'verified position-history writer is already or partially installed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute_row
    WHERE attribute_row.attrelid = 'arena.position_history'::pg_catalog.regclass
      AND attribute_row.attname = 'verified_publication_id'
      AND attribute_row.atttypid = 'pg_catalog.int8'::pg_catalog.regtype
      AND NOT attribute_row.attnotnull
      AND attribute_row.attnum > 0
      AND NOT attribute_row.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'arena.position_history'::pg_catalog.regclass
      AND constraint_row.conname = 'position_history_verified_publication_fkey'
      AND constraint_row.confrelid =
          'arena.record_surface_publications'::pg_catalog.regclass
      AND constraint_row.confdeltype = 'r'
      AND constraint_row.convalidated
  ) THEN
    RAISE EXCEPTION 'verified position-history row binding drifted';
  END IF;

  IF pg_catalog.has_table_privilege('anon', 'arena.position_history', 'SELECT')
     OR pg_catalog.has_table_privilege(
       'authenticated', 'arena.position_history', 'SELECT'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy_row
       WHERE policy_row.polrelid IN (
         'arena.position_history'::pg_catalog.regclass,
         'arena.record_surface_publications'::pg_catalog.regclass
       )
     ) THEN
    RAISE EXCEPTION 'verified position-history private read boundary drifted';
  END IF;
END
$preflight$;

LOCK TABLE ONLY arena.sources IN ACCESS SHARE MODE;
LOCK TABLE ONLY arena.traders IN ACCESS SHARE MODE;
LOCK TABLE ONLY arena.raw_objects IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.record_surface_publications IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.position_history IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.ingest_cursors IN SHARE ROW EXCLUSIVE MODE;

-- service_role historically receives ALL on new Arena tables. TRUNCATE does
-- not run the partitioned parent's statement trigger when a child is named
-- directly, so remove that capability from both the current tree and future
-- postgres-owned partitions. The owner remains the trusted break-glass role.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA arena
  REVOKE TRUNCATE ON TABLES FROM service_role;
REVOKE TRUNCATE ON TABLE arena.position_history
  FROM PUBLIC, anon, authenticated, service_role;

DO $lock_down_position_history_truncate$
DECLARE
  v_partition pg_catalog.regclass;
BEGIN
  FOR v_partition IN
    WITH RECURSIVE descendants(relation_oid) AS (
      SELECT inheritance.inhrelid
      FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhparent =
          'arena.position_history'::pg_catalog.regclass
      UNION ALL
      SELECT inheritance.inhrelid
      FROM pg_catalog.pg_inherits AS inheritance
      JOIN descendants
        ON descendants.relation_oid = inheritance.inhparent
    )
    SELECT descendants.relation_oid::pg_catalog.regclass
    FROM descendants
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE TRUNCATE ON TABLE %s FROM PUBLIC, anon, authenticated, service_role',
      v_partition
    );
  END LOOP;
END
$lock_down_position_history_truncate$;

CREATE FUNCTION arena.position_history_publication_chain_healthy(
  p_root_publication_id bigint,
  p_source_id smallint,
  p_trader_id bigint
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '10s'
SET TimeZone = 'UTC'
AS $function$
  WITH RECURSIVE publication_chain AS (
    SELECT
      publication.publication_id,
      publication.previous_publication_id,
      publication.source_id,
      publication.trader_id,
      publication.surface,
      publication.source_run_id,
      publication.raw_object_id,
      publication.raw_storage_path,
      publication.raw_content_hash,
      publication.raw_fetched_at,
      publication.observed_at,
      publication.scan_terminal_state,
      publication.starting_cursor,
      publication.effective_cursor_after,
      ARRAY[publication.publication_id]::bigint[] AS visited,
      false AS cycle,
      true AS valid_successor_link
    FROM arena.record_surface_publications AS publication
    WHERE publication.publication_id = p_root_publication_id

    UNION ALL

    SELECT
      predecessor.publication_id,
      predecessor.previous_publication_id,
      predecessor.source_id,
      predecessor.trader_id,
      predecessor.surface,
      predecessor.source_run_id,
      predecessor.raw_object_id,
      predecessor.raw_storage_path,
      predecessor.raw_content_hash,
      predecessor.raw_fetched_at,
      predecessor.observed_at,
      predecessor.scan_terminal_state,
      predecessor.starting_cursor,
      predecessor.effective_cursor_after,
      publication_chain.visited || predecessor.publication_id,
      predecessor.publication_id = ANY(publication_chain.visited),
      publication_chain.observed_at > predecessor.observed_at
        AND CASE
          WHEN predecessor.effective_cursor_after IS NULL THEN
            publication_chain.starting_cursor IS NULL
            AND publication_chain.scan_terminal_state = 'exhausted'
          ELSE
            publication_chain.starting_cursor IS NOT DISTINCT FROM
              predecessor.effective_cursor_after
            AND publication_chain.scan_terminal_state = 'cursor_overlap'
        END
    FROM publication_chain
    JOIN arena.record_surface_publications AS predecessor
      ON predecessor.publication_id =
          publication_chain.previous_publication_id
    WHERE NOT publication_chain.cycle
  )
  SELECT COALESCE(
    pg_catalog.bool_and(
      COALESCE(
        NOT publication_chain.cycle
        AND publication_chain.valid_successor_link
        AND publication_chain.source_id = p_source_id
        AND publication_chain.trader_id = p_trader_id
        AND publication_chain.surface = 'position_history'
        AND (
          publication_chain.previous_publication_id IS NOT NULL
          OR (
            publication_chain.starting_cursor IS NULL
            AND publication_chain.scan_terminal_state = 'exhausted'
          )
        )
        AND (
          publication_chain.previous_publication_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM arena.record_surface_publications AS predecessor
            WHERE predecessor.publication_id =
                publication_chain.previous_publication_id
          )
        )
        AND (
          publication_chain.raw_object_id IS NULL
          OR (
            raw_object.id IS NOT NULL
            AND raw_object.quarantined = false
            AND raw_object.source_id = publication_chain.source_id
            AND raw_object.trader_id = publication_chain.trader_id
            AND raw_object.job_type = 'history:position_history'
            AND raw_object.timeframe IS NULL
            AND raw_object.source_run_id = publication_chain.source_run_id
            AND raw_object.trust_artifact_role = 'event_history'
            AND raw_object.storage_path = publication_chain.raw_storage_path
            AND raw_object.content_hash = publication_chain.raw_content_hash
            AND raw_object.fetched_at = publication_chain.raw_fetched_at
          )
        ),
        false
      )
    ),
    false
  )
  FROM publication_chain
  LEFT JOIN arena.raw_objects AS raw_object
    ON raw_object.id = publication_chain.raw_object_id;
$function$;

CREATE FUNCTION arena.get_position_history_publication_checkpoint(
  p_source_id smallint,
  p_trader_id bigint
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '10s'
SET TimeZone = 'UTC'
AS $function$
DECLARE
  v_publication arena.record_surface_publications%ROWTYPE;
BEGIN
  IF p_source_id IS NULL OR p_source_id <= 0
     OR p_trader_id IS NULL OR p_trader_id <= 0
     OR NOT EXISTS (
       SELECT 1
       FROM arena.traders AS trader
       WHERE trader.id = p_trader_id
         AND trader.source_id = p_source_id
     ) THEN
    RAISE EXCEPTION 'position-history checkpoint identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT publication.*
  INTO v_publication
  FROM arena.record_surface_publications AS publication
  WHERE publication.source_id = p_source_id
    AND publication.trader_id = p_trader_id
    AND publication.surface = 'position_history'
  ORDER BY publication.observed_at DESC, publication.publication_id DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'publicationId', NULL::bigint,
      'cursor', NULL::timestamptz,
      'observedAt', NULL::timestamptz
    );
  END IF;

  IF NOT arena.position_history_publication_chain_healthy(
    v_publication.publication_id,
    p_source_id,
    p_trader_id
  ) THEN
    RAISE EXCEPTION 'latest position-history publication evidence is unavailable or quarantined, or its chain is invalid'
      USING ERRCODE = '55000';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'publicationId', v_publication.publication_id,
    'cursor', v_publication.effective_cursor_after,
    'observedAt', v_publication.observed_at
  );
END
$function$;

CREATE FUNCTION arena.protect_verified_position_history_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_authorized_publication text := pg_catalog.current_setting(
    'arena.verified_position_history_publication_id',
    true
  );
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'verified position-history rows cannot be truncated'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.verified_publication_id IS NOT NULL THEN
      RAISE EXCEPTION 'verified position-history rows are immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.verified_publication_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSIF OLD.verified_publication_id IS NULL
        AND NEW.verified_publication_id IS NULL THEN
    RETURN NEW;
  ELSIF (pg_catalog.to_jsonb(NEW) - 'verified_publication_id') IS DISTINCT FROM
        (pg_catalog.to_jsonb(OLD) - 'verified_publication_id') THEN
    RAISE EXCEPTION 'verified position-history row content is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.verified_publication_id IS NULL
     OR CURRENT_USER <> 'postgres'
     OR v_authorized_publication IS NULL
     OR v_authorized_publication !~ '^[1-9][0-9]*$'
     OR v_authorized_publication::bigint IS DISTINCT FROM
          NEW.verified_publication_id THEN
    RAISE EXCEPTION 'verified position-history binding is writer-owned'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER protect_verified_position_history_before_write
BEFORE INSERT OR UPDATE OR DELETE ON arena.position_history
FOR EACH ROW EXECUTE FUNCTION arena.protect_verified_position_history_row();

CREATE TRIGGER protect_verified_position_history_before_truncate
BEFORE TRUNCATE ON arena.position_history
FOR EACH STATEMENT EXECUTE FUNCTION arena.protect_verified_position_history_row();

CREATE FUNCTION arena.publish_verified_position_history(
  p_raw_object_id bigint,
  p_previous_publication_id bigint,
  p_effective_cursor_after timestamptz,
  p_rows jsonb,
  p_lane text,
  p_publisher_contract text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '10s'
SET statement_timeout = '2min'
SET TimeZone = 'UTC'
AS $function$
DECLARE
  v_raw arena.raw_objects%ROWTYPE;
  v_source arena.sources%ROWTYPE;
  v_trader arena.traders%ROWTYPE;
  v_head arena.record_surface_publications%ROWTYPE;
  v_existing arena.record_surface_publications%ROWTYPE;
  v_termination jsonb;
  v_claim_observations jsonb;
  v_scan_terminal_state text;
  v_verifier_contract text;
  v_starting_cursor timestamptz;
  v_terminal_cursor timestamptz;
  v_overlap_event_at timestamptz;
  v_observed_at timestamptz;
  v_attempt_started_at timestamptz;
  v_page_count integer;
  v_parsed_row_count integer;
  v_row_set_sha256 text;
  v_newest_event_at timestamptz;
  v_expected_cursor_after timestamptz;
  v_publication_id bigint;
  v_published_at timestamptz;
  v_bound_count integer;
  v_raw_identity_source_id smallint;
  v_raw_identity_trader_id bigint;
  v_canonical_timestamp_pattern constant text :=
    '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$';
BEGIN
  IF p_raw_object_id IS NULL OR p_raw_object_id <= 0
     OR p_lane IS NULL OR p_lane NOT IN ('tier_b', 'history_backfill', 'replay')
     OR p_publisher_contract IS NULL
     OR p_publisher_contract !~
       '^arena\.ingest\.position-history-publisher\.[a-z0-9_]+(?:\.[a-z0-9_]+)*@[1-9][0-9]*$'
     OR p_rows IS NULL
     OR pg_catalog.jsonb_typeof(p_rows) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(p_rows) > 100000
     OR (
       p_effective_cursor_after IS NOT NULL
       AND NOT pg_catalog.isfinite(p_effective_cursor_after)
     ) THEN
    RAISE EXCEPTION 'verified position-history publication input is invalid'
      USING ERRCODE = '22023';
  END IF;

  -- Every publication for one source/trader takes the identity lock before
  -- any RAW row lock. The second, locked read must still match the snapshot;
  -- this closes identity mutation races without deadlocking a successor
  -- against an exact replay of its predecessor RAW row.
  SELECT raw_object.source_id, raw_object.trader_id
  INTO v_raw_identity_source_id, v_raw_identity_trader_id
  FROM arena.raw_objects AS raw_object
  WHERE raw_object.id = p_raw_object_id;

  IF NOT FOUND OR v_raw_identity_trader_id IS NULL THEN
    RAISE EXCEPTION 'verified position-history RAW pointer is missing or traderless'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena.position-history-publication:' ||
      v_raw_identity_source_id::text || ':' || v_raw_identity_trader_id::text,
      0
    )
  );

  SELECT raw_object.*
  INTO v_raw
  FROM arena.raw_objects AS raw_object
  WHERE raw_object.id = p_raw_object_id
  FOR UPDATE;

  IF NOT FOUND OR v_raw.trader_id IS NULL THEN
    RAISE EXCEPTION 'verified position-history RAW pointer is missing or traderless'
      USING ERRCODE = '22023';
  END IF;
  IF v_raw.source_id IS DISTINCT FROM v_raw_identity_source_id
     OR v_raw.trader_id IS DISTINCT FROM v_raw_identity_trader_id THEN
    RAISE EXCEPTION 'verified position-history RAW identity changed during publication'
      USING ERRCODE = '40001';
  END IF;

  IF v_raw.trader_id IS NULL
     OR v_raw.quarantined IS DISTINCT FROM false
     OR v_raw.job_type IS DISTINCT FROM 'history:position_history'
     OR v_raw.timeframe IS NOT NULL
     OR v_raw.trust_artifact_role IS DISTINCT FROM 'event_history'
     OR v_raw.source_run_id IS NULL
     OR v_raw.source_run_id !~ '^[0-9a-f]{64}$'
     OR v_raw.source_run_id = pg_catalog.repeat('0', 64)
     OR v_raw.content_hash IS DISTINCT FROM v_raw.source_run_id
     OR v_raw.bytes <= 0
     OR NOT pg_catalog.isfinite(v_raw.fetched_at)
     OR v_raw.fetched_at > pg_catalog.statement_timestamp() + interval '5 minutes'
     OR pg_catalog.jsonb_typeof(v_raw.meta) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'verified position-history RAW pointer contract is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT source_row.* INTO v_source
  FROM arena.sources AS source_row
  WHERE source_row.id = v_raw.source_id;
  SELECT trader_row.* INTO v_trader
  FROM arena.traders AS trader_row
  WHERE trader_row.id = v_raw.trader_id;

  IF v_source.id IS NULL
     OR v_trader.id IS NULL
     OR v_trader.source_id IS DISTINCT FROM v_source.id
     OR v_raw.meta->>'surface' IS DISTINCT FROM 'position_history'
     OR v_raw.meta->>'history_kind' IS DISTINCT FROM 'position_history'
     OR v_raw.meta->>'data_contract' IS DISTINCT FROM
          'arena.ingest.history-acquisition-artifact@1'
     OR v_raw.meta->>'history_evidence_contract' IS DISTINCT FROM
          'arena.position-history-publication-evidence@1'
     OR v_raw.meta->>'source_run_id' IS DISTINCT FROM v_raw.source_run_id
     OR v_raw.meta->>'source_slug' IS DISTINCT FROM v_source.slug
     OR v_raw.meta->>'exchange_trader_id' IS DISTINCT FROM
          v_trader.exchange_trader_id
     OR v_raw.meta->>'terminal_evidence_state' IS DISTINCT FROM 'verified'
     OR v_raw.meta->'capture_config' IS DISTINCT FROM
          '{"caller_page_cap":null}'::jsonb
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_object_keys(v_raw.meta) AS member(key)
       WHERE member.key <> ALL (ARRAY[
         'surface', 'data_contract', 'history_evidence_contract',
         'source_run_id', 'source_slug', 'exchange_trader_id', 'history_kind',
         'attempt_started_at', 'starting_cursor', 'capture_config',
         'observed_at', 'page_count', 'terminal_evidence_state',
         'scan_terminal_state', 'verifier_contract', 'termination',
         'raw_integrity'
       ]::text[])
     )
     OR v_raw.meta->'starting_cursor' IS NULL
     OR pg_catalog.jsonb_typeof(v_raw.meta->'observed_at') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(v_raw.meta->'attempt_started_at') IS DISTINCT FROM 'string'
     OR v_raw.meta->>'observed_at' !~ v_canonical_timestamp_pattern
     OR v_raw.meta->>'attempt_started_at' !~ v_canonical_timestamp_pattern
     OR pg_catalog.jsonb_typeof(v_raw.meta->'page_count') IS DISTINCT FROM 'number'
     OR pg_catalog.jsonb_typeof(v_raw.meta->'termination') IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_raw.meta->'raw_integrity') IS DISTINCT FROM 'object'
     OR v_raw.meta->'raw_integrity'->>'serialization_contract' IS DISTINCT FROM
          'arena.strict-canonical-json@1'
     OR v_raw.meta->'raw_integrity'->>'hash_algorithm' IS DISTINCT FROM 'sha256'
     OR v_raw.meta->'raw_integrity'->>'hash_scope' IS DISTINCT FROM 'json_utf8'
     OR v_raw.meta->'raw_integrity'->>'compression' IS DISTINCT FROM 'gzip'
     OR v_raw.meta->'raw_integrity'->>'encoding' IS DISTINCT FROM 'utf-8'
     OR v_raw.meta->'raw_integrity'->>'content_type' IS DISTINCT FROM
          'application/json'
     OR pg_catalog.jsonb_typeof(
          v_raw.meta->'raw_integrity'->'version'
        ) IS DISTINCT FROM 'number'
     OR v_raw.meta->'raw_integrity'->'version' IS DISTINCT FROM '1'::jsonb
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_object_keys(
         v_raw.meta->'raw_integrity'
       ) AS member(key)
       WHERE member.key <> ALL (ARRAY[
         'version', 'content_type', 'encoding', 'compression',
         'hash_algorithm', 'hash_scope', 'serialization_contract',
         'compressed_bytes', 'uncompressed_bytes'
       ]::text[])
     )
     OR pg_catalog.jsonb_typeof(
          v_raw.meta->'raw_integrity'->'compressed_bytes'
        ) IS DISTINCT FROM 'number'
     OR v_raw.meta->'raw_integrity'->'compressed_bytes' IS DISTINCT FROM
          pg_catalog.to_jsonb(v_raw.bytes)
     OR pg_catalog.jsonb_typeof(
          v_raw.meta->'raw_integrity'->'uncompressed_bytes'
        ) IS DISTINCT FROM 'number'
     OR (v_raw.meta->'raw_integrity'->>'uncompressed_bytes')::numeric <= 0
     OR (v_raw.meta->'raw_integrity'->>'uncompressed_bytes')::numeric <>
          pg_catalog.trunc(
            (v_raw.meta->'raw_integrity'->>'uncompressed_bytes')::numeric
          ) THEN
    RAISE EXCEPTION 'verified position-history RAW evidence binding is invalid'
      USING ERRCODE = '22023';
  END IF;

  v_termination := v_raw.meta->'termination';
  v_claim_observations := v_termination->'claim_observations';
  v_scan_terminal_state := v_termination->>'scan_terminal_state';
  v_verifier_contract := v_termination->>'verifier_contract';
  v_observed_at := (v_raw.meta->>'observed_at')::timestamptz;
  v_attempt_started_at := (v_raw.meta->>'attempt_started_at')::timestamptz;
  v_page_count := (v_raw.meta->>'page_count')::integer;

  IF NOT pg_catalog.isfinite(v_observed_at)
     OR NOT pg_catalog.isfinite(v_attempt_started_at)
     OR v_observed_at IS DISTINCT FROM v_raw.fetched_at
     OR v_attempt_started_at > v_observed_at
     OR v_page_count <= 0
     OR v_page_count > 100000
     OR v_raw.meta->>'scan_terminal_state' IS DISTINCT FROM v_scan_terminal_state
     OR v_raw.meta->>'verifier_contract' IS DISTINCT FROM v_verifier_contract
     OR v_termination->>'evidence_state' IS DISTINCT FROM 'verified'
     OR v_termination->'blocker_reasons' IS DISTINCT FROM '[]'::jsonb
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_object_keys(v_termination) AS member(key)
       WHERE member.key <> ALL (ARRAY[
         'evidence_state', 'claim_observations', 'verifier_contract',
         'scan_terminal_state', 'terminal_cursor_value', 'overlap_event_at',
         'blocker_reasons'
       ]::text[])
     )
     OR v_scan_terminal_state NOT IN ('exhausted', 'cursor_overlap')
     OR v_verifier_contract IS NULL
     OR v_verifier_contract !~
       '^arena\.ingest\.history-terminal-verifier\.[a-z0-9_]+(?:\.[a-z0-9_]+)*@[1-9][0-9]*$'
     OR pg_catalog.jsonb_typeof(v_claim_observations) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(v_claim_observations) NOT BETWEEN 1 AND 8
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements(v_claim_observations) AS claim(value)
       WHERE pg_catalog.jsonb_typeof(claim.value) IS DISTINCT FROM 'object'
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_object_keys(claim.value) AS member(key)
            WHERE member.key <> ALL (ARRAY[
              'segment_id', 'reason', 'page_ordinal'
            ]::text[])
          )
          OR pg_catalog.jsonb_typeof(claim.value->'segment_id') IS DISTINCT FROM 'string'
          OR claim.value->>'segment_id' !~ '^[a-z0-9][a-z0-9_]{0,63}$'
          OR pg_catalog.jsonb_typeof(claim.value->'reason') IS DISTINCT FROM 'string'
          OR claim.value->>'reason' NOT IN (
            'empty_page', 'short_page', 'reported_end',
            'cursor_overlap', 'snapshot_complete'
          )
          OR pg_catalog.jsonb_typeof(claim.value->'page_ordinal') IS DISTINCT FROM
               'number'
          OR (claim.value->>'page_ordinal')::numeric < 1
          OR (claim.value->>'page_ordinal')::numeric > v_page_count
          OR (claim.value->>'page_ordinal')::numeric <>
               pg_catalog.trunc((claim.value->>'page_ordinal')::numeric)
     )
     OR EXISTS (
       SELECT 1
       FROM (
         SELECT
           claim.value->>'segment_id' AS segment_id,
           pg_catalog.count(*) AS copies
         FROM pg_catalog.jsonb_array_elements(v_claim_observations) AS claim(value)
         GROUP BY claim.value->>'segment_id'
       ) AS grouped
       WHERE grouped.copies <> 1
     )
     OR EXISTS (
       SELECT 1
       FROM (
         SELECT
           ordinal,
           (claim.value->>'page_ordinal')::integer AS page_ordinal,
           pg_catalog.lag((claim.value->>'page_ordinal')::integer)
             OVER (ORDER BY ordinal) AS previous_page_ordinal
         FROM pg_catalog.jsonb_array_elements(v_claim_observations)
           WITH ORDINALITY AS claim(value, ordinal)
       ) AS ordered_claim
       WHERE ordered_claim.previous_page_ordinal IS NOT NULL
         AND ordered_claim.page_ordinal <= ordered_claim.previous_page_ordinal
     ) THEN
    RAISE EXCEPTION 'verified position-history terminal evidence is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF v_raw.meta->'starting_cursor' = 'null'::jsonb THEN
    v_starting_cursor := NULL;
  ELSIF pg_catalog.jsonb_typeof(v_raw.meta->'starting_cursor') = 'string' THEN
    IF v_raw.meta->>'starting_cursor' !~ v_canonical_timestamp_pattern THEN
      RAISE EXCEPTION 'verified position-history starting cursor is invalid'
        USING ERRCODE = '22023';
    END IF;
    v_starting_cursor := (v_raw.meta->>'starting_cursor')::timestamptz;
    IF NOT pg_catalog.isfinite(v_starting_cursor) THEN
      RAISE EXCEPTION 'verified position-history starting cursor is invalid'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    RAISE EXCEPTION 'verified position-history starting cursor is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF v_scan_terminal_state = 'cursor_overlap' THEN
    IF v_starting_cursor IS NULL
       OR pg_catalog.jsonb_typeof(v_termination->'terminal_cursor_value')
            IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_termination->'overlap_event_at')
            IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'verified cursor-overlap evidence is incomplete'
        USING ERRCODE = '22023';
    END IF;
    v_terminal_cursor :=
      (v_termination->>'terminal_cursor_value')::timestamptz;
    v_overlap_event_at := (v_termination->>'overlap_event_at')::timestamptz;
    IF v_termination->>'terminal_cursor_value' !~
         v_canonical_timestamp_pattern
       OR v_termination->>'overlap_event_at' !~
            v_canonical_timestamp_pattern
       OR NOT pg_catalog.isfinite(v_terminal_cursor)
       OR NOT pg_catalog.isfinite(v_overlap_event_at)
       OR v_terminal_cursor IS DISTINCT FROM v_starting_cursor
       OR v_overlap_event_at > v_starting_cursor
       OR NOT EXISTS (
         SELECT 1
         FROM pg_catalog.jsonb_array_elements(v_claim_observations) AS claim(value)
         WHERE claim.value->>'reason' = 'cursor_overlap'
       ) THEN
      RAISE EXCEPTION 'verified cursor-overlap evidence does not bind the starting cursor'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    IF v_starting_cursor IS NOT NULL
       OR v_termination->'terminal_cursor_value' IS DISTINCT FROM 'null'::jsonb
       OR v_termination->'overlap_event_at' IS DISTINCT FROM 'null'::jsonb
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.jsonb_array_elements(v_claim_observations) AS claim(value)
         WHERE claim.value->>'reason' = 'cursor_overlap'
       ) THEN
      RAISE EXCEPTION 'verified exhaustion evidence cannot depend on a cursor'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
    WHERE pg_catalog.jsonb_typeof(item.value) IS DISTINCT FROM 'object'
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.jsonb_object_keys(item.value) AS member(key)
         WHERE member.key <> ALL (ARRAY[
           'opened_at', 'closed_at', 'symbol', 'side', 'leverage', 'size',
           'entry_price', 'exit_price', 'realized_pnl', 'dedupe_hash', 'raw'
         ]::text[])
       )
       OR pg_catalog.jsonb_typeof(item.value->'closed_at') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(item.value->'symbol') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(item.value->'dedupe_hash') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(item.value->'raw') IS DISTINCT FROM 'object'
       OR (
         item.value ? 'opened_at'
         AND pg_catalog.jsonb_typeof(item.value->'opened_at') NOT IN ('string', 'null')
       )
       OR (
         item.value ? 'side'
         AND pg_catalog.jsonb_typeof(item.value->'side') NOT IN ('string', 'null')
       )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(ARRAY[
           'leverage', 'size', 'entry_price', 'exit_price', 'realized_pnl'
         ]::text[]) AS numeric_member(key)
         WHERE item.value ? numeric_member.key
           AND pg_catalog.jsonb_typeof(item.value->numeric_member.key)
               NOT IN ('number', 'null')
       )
  ) THEN
    RAISE EXCEPTION 'verified position-history row envelope is invalid'
      USING ERRCODE = '22023';
  END IF;

  v_parsed_row_count := pg_catalog.jsonb_array_length(p_rows);
  v_row_set_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_rows::text, 'UTF8')),
    'hex'
  );

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(p_rows) AS row_value(
      opened_at text,
      closed_at text,
      symbol text,
      side text,
      leverage numeric,
      size numeric,
      entry_price numeric,
      exit_price numeric,
      realized_pnl numeric,
      dedupe_hash text,
      raw jsonb
    )
    WHERE row_value.closed_at IS NULL
       OR row_value.closed_at !~ v_canonical_timestamp_pattern
       OR NOT pg_catalog.isfinite(row_value.closed_at::timestamptz)
       OR row_value.closed_at::timestamptz > v_observed_at + interval '5 minutes'
       OR (
         row_value.opened_at IS NOT NULL
         AND (
           row_value.opened_at !~ v_canonical_timestamp_pattern
           OR NOT pg_catalog.isfinite(row_value.opened_at::timestamptz)
           OR row_value.opened_at::timestamptz > row_value.closed_at::timestamptz
         )
       )
       OR row_value.symbol IS NULL
       OR row_value.symbol <> pg_catalog.btrim(row_value.symbol)
       OR pg_catalog.char_length(row_value.symbol) NOT BETWEEN 1 AND 128
       OR (
         row_value.side IS NOT NULL
         AND (
           row_value.side <> pg_catalog.btrim(row_value.side)
           OR pg_catalog.char_length(row_value.side) NOT BETWEEN 1 AND 32
         )
       )
       OR row_value.dedupe_hash IS NULL
       OR row_value.dedupe_hash <> pg_catalog.btrim(row_value.dedupe_hash)
       OR pg_catalog.char_length(row_value.dedupe_hash) NOT BETWEEN 1 AND 512
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(p_rows) AS row_value(
      closed_at text,
      dedupe_hash text
    )
    GROUP BY row_value.closed_at::timestamptz, row_value.dedupe_hash
    HAVING pg_catalog.count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'verified position-history parsed rows are invalid or duplicated'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.max(row_value.closed_at::timestamptz)
  INTO v_newest_event_at
  FROM pg_catalog.jsonb_to_recordset(p_rows) AS row_value(closed_at text);

  v_expected_cursor_after := CASE
    WHEN v_starting_cursor IS NULL THEN v_newest_event_at
    WHEN v_newest_event_at IS NULL THEN v_starting_cursor
    ELSE GREATEST(v_starting_cursor, v_newest_event_at)
  END;

  IF p_effective_cursor_after IS DISTINCT FROM v_expected_cursor_after
     OR (
       v_scan_terminal_state = 'cursor_overlap'
       AND NOT EXISTS (
         SELECT 1
         FROM pg_catalog.jsonb_to_recordset(p_rows) AS row_value(closed_at text)
         WHERE row_value.closed_at::timestamptz = v_overlap_event_at
       )
     ) THEN
    RAISE EXCEPTION 'verified position-history effective cursor does not match parsed rows'
      USING ERRCODE = '22023';
  END IF;

  -- Freeze dimension fields only for the short publication section, then
  -- repeat every identity/evidence comparison that depends on those rows.
  SELECT source_row.* INTO v_source
  FROM arena.sources AS source_row
  WHERE source_row.id = v_raw.source_id
  FOR SHARE;
  SELECT trader_row.* INTO v_trader
  FROM arena.traders AS trader_row
  WHERE trader_row.id = v_raw.trader_id
  FOR SHARE;

  IF v_source.id IS NULL
     OR v_trader.id IS NULL
     OR v_trader.source_id IS DISTINCT FROM v_source.id
     OR v_raw.meta->>'source_slug' IS DISTINCT FROM v_source.slug
     OR v_raw.meta->>'exchange_trader_id' IS DISTINCT FROM
          v_trader.exchange_trader_id THEN
    RAISE EXCEPTION 'verified position-history source or trader identity changed during publication'
      USING ERRCODE = '40001';
  END IF;

  SELECT publication.*
  INTO v_existing
  FROM arena.record_surface_publications AS publication
  WHERE publication.source_id = v_source.id
    AND publication.trader_id = v_trader.id
    AND publication.surface = 'position_history'
    AND publication.source_run_id = v_raw.source_run_id;

  IF FOUND THEN
    IF v_existing.lane IS DISTINCT FROM p_lane
       OR v_existing.previous_publication_id IS DISTINCT FROM
            p_previous_publication_id
       OR v_existing.raw_object_id IS NOT NULL
          AND v_existing.raw_object_id IS DISTINCT FROM v_raw.id
       OR v_existing.raw_storage_path IS DISTINCT FROM v_raw.storage_path
       OR v_existing.raw_content_hash IS DISTINCT FROM v_raw.content_hash
       OR v_existing.raw_fetched_at IS DISTINCT FROM v_raw.fetched_at
       OR v_existing.observed_at IS DISTINCT FROM v_observed_at
       OR v_existing.publisher_contract IS DISTINCT FROM p_publisher_contract
       OR v_existing.scan_terminal_state IS DISTINCT FROM v_scan_terminal_state
       OR v_existing.starting_cursor IS DISTINCT FROM v_starting_cursor
       OR v_existing.effective_cursor_after IS DISTINCT FROM
            p_effective_cursor_after
       OR v_existing.overlap_event_at IS DISTINCT FROM v_overlap_event_at
       OR v_existing.page_count IS DISTINCT FROM v_page_count
       OR v_existing.parsed_row_count IS DISTINCT FROM v_parsed_row_count
       OR v_existing.row_set_sha256 IS DISTINCT FROM v_row_set_sha256
       OR v_existing.termination IS DISTINCT FROM v_termination THEN
      RAISE EXCEPTION 'verified position-history replay conflicts with its frozen receipt'
        USING ERRCODE = '23505';
    END IF;

    IF NOT arena.position_history_publication_chain_healthy(
      v_existing.publication_id,
      v_source.id,
      v_trader.id
    ) THEN
      RAISE EXCEPTION 'replayed position-history publication evidence is unavailable or quarantined, or its chain is invalid'
        USING ERRCODE = '55000';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'publicationId', v_existing.publication_id,
      'rowsWritten', 0,
      'parsedRowCount', v_existing.parsed_row_count,
      'cursor', v_existing.effective_cursor_after,
      'observedAt', v_existing.observed_at,
      'publishedAt', v_existing.published_at,
      'replayed', true
    );
  END IF;

  SELECT publication.*
  INTO v_head
  FROM arena.record_surface_publications AS publication
  WHERE publication.source_id = v_source.id
    AND publication.trader_id = v_trader.id
    AND publication.surface = 'position_history'
  ORDER BY publication.observed_at DESC, publication.publication_id DESC
  LIMIT 1;

  IF FOUND THEN
    -- Freeze every still-live RAW pointer for this receipt identity while the
    -- lineage gate and successor insert run. Quarantine/GC may proceed after
    -- commit, at which point future reads fail closed.
    PERFORM raw_object.id
    FROM arena.record_surface_publications AS publication
    JOIN arena.raw_objects AS raw_object
      ON raw_object.id = publication.raw_object_id
    WHERE publication.source_id = v_source.id
      AND publication.trader_id = v_trader.id
      AND publication.surface = 'position_history'
    ORDER BY raw_object.id
    FOR UPDATE OF raw_object;

    IF NOT arena.position_history_publication_chain_healthy(
      v_head.publication_id,
      v_source.id,
      v_trader.id
    ) THEN
      RAISE EXCEPTION 'latest position-history publication evidence is unavailable or quarantined, or its chain is invalid'
        USING ERRCODE = '55000';
    END IF;

    IF p_previous_publication_id IS DISTINCT FROM v_head.publication_id
       OR v_observed_at <= v_head.observed_at THEN
      RAISE EXCEPTION 'verified position-history publication is stale or not based on the current head'
        USING ERRCODE = '40001';
    END IF;

    IF v_head.effective_cursor_after IS NULL THEN
      IF v_starting_cursor IS NOT NULL
         OR v_scan_terminal_state IS DISTINCT FROM 'exhausted' THEN
        RAISE EXCEPTION 'cursorless position-history head requires a fresh exhaustive successor'
          USING ERRCODE = '22023';
      END IF;
    ELSIF v_starting_cursor IS DISTINCT FROM v_head.effective_cursor_after
       OR v_scan_terminal_state IS DISTINCT FROM 'cursor_overlap' THEN
      RAISE EXCEPTION 'position-history successor does not continue the authoritative cursor'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    IF p_previous_publication_id IS NOT NULL
       OR v_starting_cursor IS NOT NULL
       OR v_scan_terminal_state IS DISTINCT FROM 'exhausted' THEN
      RAISE EXCEPTION 'first position-history publication requires a cursorless exhaustive capture'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO arena.record_surface_publications (
    source_id,
    trader_id,
    surface,
    lane,
    source_run_id,
    raw_object_id,
    raw_storage_path,
    raw_content_hash,
    raw_fetched_at,
    observed_at,
    source_as_of,
    previous_publication_id,
    evidence_contract,
    data_contract,
    verifier_contract,
    publisher_contract,
    scan_terminal_state,
    starting_cursor,
    effective_cursor_after,
    overlap_event_at,
    page_count,
    parsed_row_count,
    row_set_sha256,
    termination
  ) VALUES (
    v_source.id,
    v_trader.id,
    'position_history',
    p_lane,
    v_raw.source_run_id,
    v_raw.id,
    v_raw.storage_path,
    v_raw.content_hash,
    v_raw.fetched_at,
    v_observed_at,
    NULL,
    p_previous_publication_id,
    'arena.position-history-publication-evidence@1',
    'arena.ingest.history-acquisition-artifact@1',
    v_verifier_contract,
    p_publisher_contract,
    v_scan_terminal_state,
    v_starting_cursor,
    p_effective_cursor_after,
    v_overlap_event_at,
    v_page_count,
    v_parsed_row_count,
    v_row_set_sha256,
    v_termination
  )
  RETURNING publication_id, published_at
  INTO v_publication_id, v_published_at;

  PERFORM pg_catalog.set_config(
    'arena.verified_position_history_publication_id',
    v_publication_id::text,
    true
  );

  WITH upserted AS (
    INSERT INTO arena.position_history (
      trader_id,
      opened_at,
      closed_at,
      symbol,
      side,
      leverage,
      size,
      entry_price,
      exit_price,
      realized_pnl,
      currency,
      dedupe_hash,
      raw,
      verified_publication_id
    )
    SELECT
      v_trader.id,
      row_value.opened_at::timestamptz,
      row_value.closed_at::timestamptz,
      row_value.symbol,
      row_value.side,
      row_value.leverage,
      row_value.size,
      row_value.entry_price,
      row_value.exit_price,
      row_value.realized_pnl,
      v_source.currency,
      row_value.dedupe_hash,
      row_value.raw,
      v_publication_id
    FROM pg_catalog.jsonb_to_recordset(p_rows) AS row_value(
      opened_at text,
      closed_at text,
      symbol text,
      side text,
      leverage numeric,
      size numeric,
      entry_price numeric,
      exit_price numeric,
      realized_pnl numeric,
      dedupe_hash text,
      raw jsonb
    )
    ON CONFLICT (closed_at, dedupe_hash) DO UPDATE SET
      verified_publication_id = EXCLUDED.verified_publication_id
    WHERE arena.position_history.trader_id = EXCLUDED.trader_id
      AND arena.position_history.opened_at IS NOT DISTINCT FROM EXCLUDED.opened_at
      AND arena.position_history.symbol IS NOT DISTINCT FROM EXCLUDED.symbol
      AND arena.position_history.side IS NOT DISTINCT FROM EXCLUDED.side
      AND arena.position_history.leverage IS NOT DISTINCT FROM EXCLUDED.leverage
      AND arena.position_history.size IS NOT DISTINCT FROM EXCLUDED.size
      AND arena.position_history.entry_price IS NOT DISTINCT FROM EXCLUDED.entry_price
      AND arena.position_history.exit_price IS NOT DISTINCT FROM EXCLUDED.exit_price
      AND arena.position_history.realized_pnl IS NOT DISTINCT FROM EXCLUDED.realized_pnl
      AND arena.position_history.currency IS NOT DISTINCT FROM EXCLUDED.currency
      AND arena.position_history.raw IS NOT DISTINCT FROM EXCLUDED.raw
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_bound_count
  FROM upserted;

  PERFORM pg_catalog.set_config(
    'arena.verified_position_history_publication_id',
    '',
    true
  );

  IF v_bound_count IS DISTINCT FROM v_parsed_row_count THEN
    RAISE EXCEPTION 'verified position-history rows conflict with existing typed data'
      USING ERRCODE = '23505';
  END IF;

  IF p_effective_cursor_after IS NULL THEN
    DELETE FROM arena.ingest_cursors
    WHERE trader_id = v_trader.id
      AND kind = 'position_history';
  ELSE
    INSERT INTO arena.ingest_cursors (
      trader_id,
      kind,
      cursor_value,
      updated_at
    ) VALUES (
      v_trader.id,
      'position_history',
      p_effective_cursor_after::text,
      pg_catalog.statement_timestamp()
    )
    ON CONFLICT (trader_id, kind) DO UPDATE SET
      cursor_value = EXCLUDED.cursor_value,
      updated_at = EXCLUDED.updated_at;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'publicationId', v_publication_id,
    'rowsWritten', v_bound_count,
    'parsedRowCount', v_parsed_row_count,
    'cursor', p_effective_cursor_after,
    'observedAt', v_observed_at,
    'publishedAt', v_published_at,
    'replayed', false
  );
END
$function$;

ALTER FUNCTION arena.get_position_history_publication_checkpoint(smallint, bigint)
  OWNER TO postgres;
ALTER FUNCTION arena.position_history_publication_chain_healthy(bigint, smallint, bigint)
  OWNER TO postgres;
ALTER FUNCTION arena.protect_verified_position_history_row() OWNER TO postgres;
ALTER FUNCTION arena.publish_verified_position_history(
  bigint,
  bigint,
  timestamptz,
  jsonb,
  text,
  text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION arena.get_position_history_publication_checkpoint(
  smallint,
  bigint
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.position_history_publication_chain_healthy(
  bigint,
  smallint,
  bigint
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.protect_verified_position_history_row()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.publish_verified_position_history(
  bigint,
  bigint,
  timestamptz,
  jsonb,
  text,
  text
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION arena.get_position_history_publication_checkpoint(
  smallint,
  bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION arena.publish_verified_position_history(
  bigint,
  bigint,
  timestamptz,
  jsonb,
  text,
  text
) TO service_role;

COMMENT ON FUNCTION arena.get_position_history_publication_checkpoint(
  smallint,
  bigint
) IS 'Service-only authoritative position-history checkpoint. Never derives trust from legacy ingest_cursors.';
COMMENT ON FUNCTION arena.position_history_publication_chain_healthy(
  bigint,
  smallint,
  bigint
) IS 'Private fail-closed lineage validator for position-history publication receipts and their retained RAW pointers.';
COMMENT ON FUNCTION arena.publish_verified_position_history(
  bigint,
  bigint,
  timestamptz,
  jsonb,
  text,
  text
) IS 'Service-only atomic RAW receipt, verified typed-row binding, and cursor publication. Partial/Tier-C evidence is rejected.';

DO $postflight$
DECLARE
  v_checkpoint oid := pg_catalog.to_regprocedure(
    'arena.get_position_history_publication_checkpoint(smallint,bigint)'
  );
  v_writer oid := pg_catalog.to_regprocedure(
    'arena.publish_verified_position_history(bigint,bigint,timestamptz,jsonb,text,text)'
  );
  v_chain_guard oid := pg_catalog.to_regprocedure(
    'arena.position_history_publication_chain_healthy(bigint,smallint,bigint)'
  );
  v_row_guard oid := pg_catalog.to_regprocedure(
    'arena.protect_verified_position_history_row()'
  );
BEGIN
  IF v_checkpoint IS NULL OR v_writer IS NULL OR v_chain_guard IS NULL
     OR v_row_guard IS NULL
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_checkpoint, 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_writer, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('anon', v_checkpoint, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_checkpoint, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_writer, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_writer, 'EXECUTE')
     OR pg_catalog.has_function_privilege('service_role', v_chain_guard, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_chain_guard, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_chain_guard, 'EXECUTE')
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.position_history', 'TRUNCATE'
     )
     OR EXISTS (
       WITH RECURSIVE descendants(relation_oid) AS (
         SELECT inheritance.inhrelid
         FROM pg_catalog.pg_inherits AS inheritance
         WHERE inheritance.inhparent =
             'arena.position_history'::pg_catalog.regclass
         UNION ALL
         SELECT inheritance.inhrelid
         FROM pg_catalog.pg_inherits AS inheritance
         JOIN descendants
           ON descendants.relation_oid = inheritance.inhparent
       )
       SELECT 1
       FROM descendants
       WHERE pg_catalog.has_table_privilege(
         'service_role',
         descendants.relation_oid,
         'TRUNCATE'
       )
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_default_acl AS default_acl
       CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) AS privilege
       WHERE default_acl.defaclrole = 'postgres'::pg_catalog.regrole
         AND default_acl.defaclnamespace = 'arena'::pg_catalog.regnamespace
         AND default_acl.defaclobjtype = 'r'
         AND privilege.grantee = 'service_role'::pg_catalog.regrole
         AND privilege.privilege_type = 'TRUNCATE'
     )
     OR pg_catalog.has_function_privilege('service_role', v_row_guard, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_row_guard, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_row_guard, 'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS expanded
       WHERE function_row.oid IN (v_chain_guard, v_row_guard)
         AND expanded.grantee <> function_row.proowner
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS expanded
       WHERE function_row.oid IN (v_checkpoint, v_writer)
         AND expanded.privilege_type = 'EXECUTE'
         AND expanded.grantee <> function_row.proowner
         AND expanded.grantee <> 'service_role'::pg_catalog.regrole
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = v_row_guard
         AND function_row.proowner = 'postgres'::pg_catalog.regrole
         AND NOT function_row.prosecdef
         AND function_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = v_chain_guard
         AND function_row.proowner = 'postgres'::pg_catalog.regrole
         AND NOT function_row.prosecdef
         AND NOT function_row.proleakproof
         AND NOT function_row.proretset
         AND function_row.prorettype = 'pg_catalog.bool'::pg_catalog.regtype
         AND function_row.proconfig @>
           ARRAY[
             'search_path=pg_catalog, pg_temp',
             'TimeZone=UTC'
           ]::text[]
     )
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'arena.position_history'::pg_catalog.regclass
         AND trigger_row.tgname IN (
           'protect_verified_position_history_before_write',
           'protect_verified_position_history_before_truncate'
         )
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
     ) <> 2
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid IN (v_checkpoint, v_writer)
         AND (
           function_row.proowner <> 'postgres'::pg_catalog.regrole
           OR NOT function_row.prosecdef
           OR function_row.proleakproof
           OR function_row.proretset
           OR function_row.prorettype <> 'pg_catalog.jsonb'::pg_catalog.regtype
           OR function_row.proconfig IS NULL
           OR NOT function_row.proconfig @>
             ARRAY[
               'search_path=pg_catalog, pg_temp',
               'TimeZone=UTC'
             ]::text[]
         )
     ) THEN
    RAISE EXCEPTION 'verified position-history writer ACL or metadata postflight failed';
  END IF;
END
$postflight$;

COMMIT;
