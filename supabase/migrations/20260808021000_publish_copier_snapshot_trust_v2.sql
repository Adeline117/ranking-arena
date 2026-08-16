-- Atomic publisher for byte-anchored copier snapshot artifact@2 evidence.
--
-- The caller supplies the four strict-canonical child byte strings, never a
-- jsonb row set. PostgreSQL first hashes those original UTF-8 bytes, rebuilds
-- the complete outer @2 canonical preimage in its fixed ASCII key order, and
-- matches the independently supplied/locked RAW anchor. Only then are the
-- children parsed and replayed into the private immutable @2 substrate.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;
-- Regex source is parsed at function-compile time. Pin this before creating
-- any function body and again on every function that evaluates a regex so a
-- caller cannot reinterpret `\\.` as an unescaped wildcard.
SET LOCAL standard_conforming_strings = on;

DO $foundations$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.current_setting('server_encoding') <> 'UTF8'
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regnamespace('supabase_migrations') IS NULL
     OR pg_catalog.to_regclass(
          'supabase_migrations.schema_migrations'
        ) IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL
     OR pg_catalog.to_regclass('arena.raw_object_gc_queue') IS NULL
     OR pg_catalog.to_regclass(
          'arena.copier_snapshot_trust_publications'
        ) IS NULL
     OR pg_catalog.to_regclass('arena.copier_snapshot_trust_rows') IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION
      'copier snapshot trust publisher requires PG17 UTF8, exact @2 substrate, GC outbox, migration ledger, and API roles';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_roles AS role_row
     WHERE role_row.oid = 'postgres'::pg_catalog.regrole
       AND (role_row.rolsuper OR role_row.rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'copier snapshot trust publisher owner must bypass private RLS';
  END IF;
END
$foundations$;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    '20260808021000-publish-copier-snapshot-trust-v2',
    0
  )
);

LOCK TABLE supabase_migrations.schema_migrations
  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.sources IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.traders IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.raw_objects IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.raw_object_gc_queue IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.copier_snapshot_trust_publications
  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.copier_snapshot_trust_rows
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_predecessor_count bigint;
BEGIN
  SELECT pg_catalog.count(*)
    INTO STRICT v_predecessor_count
    FROM supabase_migrations.schema_migrations AS ledger
   WHERE ledger.name = 'copier_snapshot_trust_publication_substrate';

  -- Supabase may assign a server-side version. Pin the unique reviewed name
  -- and the exact UTF-8 migration body, not a mutable version coordinate.
  IF v_predecessor_count <> 1
     OR NOT EXISTS (
       SELECT 1
         FROM supabase_migrations.schema_migrations AS ledger
        WHERE ledger.name = 'copier_snapshot_trust_publication_substrate'
          AND pg_catalog.array_length(ledger.statements, 1) = 1
          AND pg_catalog.encode(
                pg_catalog.sha256(
                  pg_catalog.convert_to(ledger.statements[1], 'UTF8')
                ),
                'hex'
              ) =
              '2d86fc0a15fc8e75791e29da17f79b772a9d15ebd8f22702689d16599dbf16ae'
     ) THEN
    RAISE EXCEPTION
      'copier snapshot trust publisher requires one exact copier_snapshot_trust_publication_substrate migration ledger name and body';
  END IF;

  IF pg_catalog.to_regprocedure(
       'arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(jsonb,text[])'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
          'arena.copier_snapshot_trust_nullable_utf8_v2(text)'
        ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
          'arena.copier_snapshot_trust_float8_plain_decimal_v2(text)'
        ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
          'arena.publish_copier_snapshot_trust_v2(bigint,smallint,bigint,text,text,text,text,text,text)'
        ) IS NOT NULL THEN
    RAISE EXCEPTION 'copier snapshot trust publisher is already or partially installed';
  END IF;

  IF EXISTS (
    SELECT required_column.name
      FROM pg_catalog.unnest(ARRAY[
        'id', 'slug', 'adapter_slug', 'product_type', 'currency',
        'copier_table_depth', 'fetch_region', 'status', 'serving_mode', 'meta'
      ]::text[]) AS required_column(name)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_attribute AS attribute_row
        WHERE attribute_row.attrelid = 'arena.sources'::pg_catalog.regclass
          AND attribute_row.attname = required_column.name
          AND attribute_row.attnum > 0
          AND NOT attribute_row.attisdropped
     )
  ) OR EXISTS (
    SELECT required_column.name
      FROM pg_catalog.unnest(ARRAY[
        'id', 'source_id', 'exchange_trader_id', 'meta'
      ]::text[]) AS required_column(name)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_attribute AS attribute_row
        WHERE attribute_row.attrelid = 'arena.traders'::pg_catalog.regclass
          AND attribute_row.attname = required_column.name
          AND attribute_row.attnum > 0
          AND NOT attribute_row.attisdropped
     )
  ) OR EXISTS (
    SELECT required_column.name
      FROM pg_catalog.unnest(ARRAY[
        'id', 'source_id', 'job_type', 'trader_id', 'timeframe', 'fetched_at',
        'storage_path', 'bytes', 'content_hash', 'quarantined', 'meta',
        'source_run_id', 'trust_artifact_role'
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
    RAISE EXCEPTION 'copier snapshot trust publisher authority columns drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation_row
     WHERE relation_row.oid IN (
       'arena.copier_snapshot_trust_publications'::pg_catalog.regclass,
       'arena.copier_snapshot_trust_rows'::pg_catalog.regclass
     )
       AND relation_row.relowner = 'postgres'::pg_catalog.regrole
       AND relation_row.relrowsecurity
       AND relation_row.relforcerowsecurity
     HAVING pg_catalog.count(*) = 2
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_policy AS policy_row
     WHERE policy_row.polrelid IN (
       'arena.copier_snapshot_trust_publications'::pg_catalog.regclass,
       'arena.copier_snapshot_trust_rows'::pg_catalog.regclass
     )
  ) THEN
    RAISE EXCEPTION 'copier snapshot trust private substrate boundary drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid IN (
       'arena.copier_snapshot_trust_publications'::pg_catalog.regclass,
       'arena.copier_snapshot_trust_rows'::pg_catalog.regclass
     )
       AND constraint_row.convalidated
       AND constraint_row.conname IN (
         'fk_copier_snapshot_trust_publication_predecessor',
         'uq_copier_snapshot_trust_publication_outer',
         'uq_copier_snapshot_trust_publication_raw_at_capture',
         'uq_copier_snapshot_trust_publication_lane_observation',
         'uq_copier_snapshot_trust_row_coordinate',
         'uq_copier_snapshot_trust_row_source_candidate',
         'uq_copier_snapshot_trust_row_projection',
         'uq_copier_snapshot_trust_row_dedupe'
       )
  ) <> 8 OR (
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
  ) <> 6 THEN
    RAISE EXCEPTION 'copier snapshot trust constraints or triggers drifted';
  END IF;

  IF pg_catalog.has_table_privilege(
       'service_role', 'arena.copier_snapshot_trust_publications',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
     ) OR pg_catalog.has_table_privilege(
       'service_role', 'arena.copier_snapshot_trust_rows',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
     ) THEN
    RAISE EXCEPTION 'copier snapshot trust service role has direct substrate DML';
  END IF;
END
$preflight$;

-- Exact-key checks occur only after the byte anchors have matched. Duplicate
-- JSON keys cannot be introduced by a legitimate strict-canonical producer;
-- changing the byte string would change its locked child and outer digests.
CREATE FUNCTION arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(
  p_value jsonb,
  p_expected_keys text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
RETURN pg_catalog.jsonb_typeof(p_value) = 'object'
  AND (
    SELECT COALESCE(
             pg_catalog.array_agg(key_row.key ORDER BY key_row.key COLLATE "C"),
             ARRAY[]::text[]
           )
      FROM pg_catalog.jsonb_object_keys(p_value) AS key_row(key)
  ) = (
    SELECT COALESCE(
             pg_catalog.array_agg(expected_key ORDER BY expected_key COLLATE "C"),
             ARRAY[]::text[]
           )
      FROM pg_catalog.unnest(p_expected_keys) AS expected(expected_key)
  );

-- `00` is NULL; non-NULL text is `01 || int32be(octets) || UTF8(text)`.
CREATE FUNCTION arena.copier_snapshot_trust_nullable_utf8_v2(p_value text)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
RETURN CASE
  WHEN p_value IS NULL THEN pg_catalog.decode('00', 'hex')
  ELSE pg_catalog.decode('01', 'hex') ||
       pg_catalog.int4send(pg_catalog.octet_length(p_value)) ||
       pg_catalog.convert_to(p_value, 'UTF8')
END;

-- PostgreSQL 17 and ECMAScript both use a shortest-round-tripping binary64
-- rendering. Expand PostgreSQL's optional exponent into the projection @1
-- plain-decimal spelling, then require byte equality with the supplied text.
-- This rejects numerically plausible but non-JavaScript-canonical values such
-- as 0.10000000000000001.
CREATE FUNCTION arena.copier_snapshot_trust_float8_plain_decimal_v2(p_value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
SET extra_float_digits = 3
SET standard_conforming_strings = on
AS $decimal$
DECLARE
  v_rendered text;
  v_match text[];
  v_sign text;
  v_integer text;
  v_fraction text;
  v_digits text;
  v_exponent integer;
  v_decimal_index integer;
BEGIN
  v_rendered := (p_value::double precision)::text;
  IF v_rendered !~ '[eE]' THEN
    RETURN v_rendered;
  END IF;

  v_match := pg_catalog.regexp_match(
    v_rendered,
    '^(-?)([0-9]+)(?:\.([0-9]+))?[eE]([+-]?[0-9]+)$'
  );
  IF v_match IS NULL THEN
    RETURN NULL;
  END IF;
  v_sign := v_match[1];
  v_integer := v_match[2];
  v_fraction := COALESCE(v_match[3], '');
  v_exponent := v_match[4]::integer;
  v_digits := v_integer || v_fraction;
  v_decimal_index := pg_catalog.char_length(v_integer) + v_exponent;

  IF v_decimal_index <= 0 THEN
    RETURN v_sign || '0.' || pg_catalog.repeat('0', -v_decimal_index) ||
      v_digits;
  END IF;
  IF v_decimal_index >= pg_catalog.char_length(v_digits) THEN
    RETURN v_sign || v_digits || pg_catalog.repeat(
      '0',
      v_decimal_index - pg_catalog.char_length(v_digits)
    );
  END IF;
  RETURN v_sign || pg_catalog.substr(v_digits, 1, v_decimal_index) || '.' ||
    pg_catalog.substr(v_digits, v_decimal_index + 1);
END
$decimal$;

CREATE FUNCTION arena.publish_copier_snapshot_trust_v2(
  p_raw_object_id bigint,
  p_source_id smallint,
  p_trader_id bigint,
  p_lane text,
  p_outer_source_run_id text,
  p_snapshot_strict_canonical_json text,
  p_candidate_ledger_strict_canonical_json text,
  p_parser_conservation_strict_canonical_json text,
  p_projection_ledger_strict_canonical_json text
)
RETURNS TABLE (
  publication_id bigint,
  published_at timestamptz,
  source_id smallint,
  trader_id bigint,
  lane text,
  raw_object_id_at_publication bigint,
  outer_source_run_id text,
  observed_at timestamptz,
  snapshot_source_run_id text,
  candidate_ledger_sha256 text,
  parser_conservation_sha256 text,
  projection_ledger_sha256 text,
  parsed_row_count integer,
  coverage_state text,
  rank_eligible boolean,
  replayed boolean,
  is_current_head boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET standard_conforming_strings = on
AS $function$
DECLARE
  v_raw arena.raw_objects%ROWTYPE;
  v_live_source arena.sources%ROWTYPE;
  v_live_trader arena.traders%ROWTYPE;
  v_snapshot jsonb;
  v_candidate jsonb;
  v_parser jsonb;
  v_projection jsonb;
  v_snapshot_sha256 text;
  v_candidate_sha256 text;
  v_parser_sha256 text;
  v_projection_sha256 text;
  v_outer_preimage text;
  v_outer_sha256 text;
  v_outer_octets integer;
  v_source_slug text;
  v_adapter_slug text;
  v_product_type text;
  v_currency text;
  v_source_depth text;
  v_fetch_region text;
  v_exchange_trader_id text;
  v_observed_at_text text;
  v_observed_at timestamptz;
  v_request_timeframe smallint;
  v_scan_terminal_state text;
  v_caller_limited boolean;
  v_page_count integer;
  v_observed_candidate_count integer;
  v_row_count integer;
  v_candidate_locator_contract text;
  v_parser_contract text;
  v_source_fixed_sha256 text;
  v_pair_fixed_sha256 text;
  v_replayed_source_fixed_sha256 text;
  v_replayed_pair_fixed_sha256 text;
  v_candidate_json_multiset_sha256 text;
  v_previous_publication_id bigint;
  v_previous_observed_at timestamptz;
  v_publication_id bigint;
  v_published_at timestamptz;
  v_existing arena.copier_snapshot_trust_publications%ROWTYPE;
  v_stored_row_count integer;
  v_stored_min_ordinal integer;
  v_stored_max_ordinal integer;
  v_inserted integer;
  v_coverage_state text;
  v_is_current_head boolean;
  v_expected_meta jsonb;
  v_was_replayed boolean := false;
  v_evidence_validated boolean := false;
BEGIN
  IF p_raw_object_id IS NULL
     OR p_raw_object_id <= 0
     OR p_source_id IS NULL
     OR p_source_id <= 0
     OR p_trader_id IS NULL
     OR p_trader_id <= 0
     OR p_lane IS NULL
     OR p_lane NOT IN ('tier_b', 'tier_c')
     OR p_outer_source_run_id IS NULL
     OR p_outer_source_run_id !~ '^[0-9a-f]{64}$'
     OR p_outer_source_run_id = pg_catalog.repeat('0', 64)
     OR p_snapshot_strict_canonical_json IS NULL
     OR p_candidate_ledger_strict_canonical_json IS NULL
     OR p_parser_conservation_strict_canonical_json IS NULL
     OR p_projection_ledger_strict_canonical_json IS NULL THEN
    RAISE EXCEPTION 'invalid copier snapshot trust publisher input'
      USING ERRCODE = '22023';
  END IF;

  -- Bound all attacker-controlled text before hashing, concatenation, or JSON
  -- parsing. The complete outer artifact has the same 256 MiB reader limit.
  IF pg_catalog.octet_length(p_snapshot_strict_canonical_json) <= 0
     OR pg_catalog.octet_length(p_candidate_ledger_strict_canonical_json) <= 0
     OR pg_catalog.octet_length(p_parser_conservation_strict_canonical_json) <= 0
     OR pg_catalog.octet_length(p_projection_ledger_strict_canonical_json) <= 0
     OR pg_catalog.octet_length(p_snapshot_strict_canonical_json)::bigint +
          pg_catalog.octet_length(p_candidate_ledger_strict_canonical_json)::bigint +
          pg_catalog.octet_length(p_parser_conservation_strict_canonical_json)::bigint +
          pg_catalog.octet_length(p_projection_ledger_strict_canonical_json)::bigint >
          268435456 THEN
    RAISE EXCEPTION 'copier snapshot trust canonical evidence exceeds byte limit'
      USING ERRCODE = '54000';
  END IF;

  v_snapshot_sha256 := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(p_snapshot_strict_canonical_json, 'UTF8')
    ),
    'hex'
  );
  v_candidate_sha256 := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(p_candidate_ledger_strict_canonical_json, 'UTF8')
    ),
    'hex'
  );
  v_parser_sha256 := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(p_parser_conservation_strict_canonical_json, 'UTF8')
    ),
    'hex'
  );
  v_projection_sha256 := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(p_projection_ledger_strict_canonical_json, 'UTF8')
    ),
    'hex'
  );

  -- Exact arena.strict-canonical-json@1 outer key order (ASCII keys are also
  -- raw UTF-16 order). Child values are inserted as their original byte
  -- strings; no jsonb rendering participates in this preimage.
  v_outer_preimage :=
    '{"candidate_ledger":' || p_candidate_ledger_strict_canonical_json ||
    ',"candidate_ledger_sha256":"' || v_candidate_sha256 || '"' ||
    ',"contract":"arena.ingest.copier-snapshot-artifact@2"' ||
    ',"parser_conservation":' || p_parser_conservation_strict_canonical_json ||
    ',"parser_conservation_sha256":"' || v_parser_sha256 || '"' ||
    ',"projection_ledger":' || p_projection_ledger_strict_canonical_json ||
    ',"projection_ledger_sha256":"' || v_projection_sha256 || '"' ||
    ',"serialization_contract":"arena.strict-canonical-json@1"' ||
    ',"snapshot":' || p_snapshot_strict_canonical_json ||
    ',"snapshot_source_run_id":"' || v_snapshot_sha256 || '"}';
  v_outer_octets := pg_catalog.octet_length(v_outer_preimage);
  IF v_outer_octets > 268435456 THEN
    RAISE EXCEPTION 'copier snapshot trust outer artifact exceeds byte limit'
      USING ERRCODE = '54000';
  END IF;
  v_outer_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_outer_preimage, 'UTF8')),
    'hex'
  );

  -- Serialize exact retries for one immutable outer identity before taking the
  -- wider lane lock. This also prevents two callers from racing the RAW read
  -- for the same artifact.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena.publish-copier-snapshot-trust-v2:outer:' ||
        p_outer_source_run_id,
      0
    )
  );

  <<publish_after_validation>>
  LOOP
  IF v_evidence_validated THEN
  v_coverage_state := CASE
    WHEN v_caller_limited OR v_source_depth <> 'full' THEN 'partial'
    ELSE 'unknown'
  END;

  -- Exact retry identity is global by outer artifact. It is resolved only
  -- after all current RAW/source/trader/evidence checks, and before stale-head
  -- checks so an older exact artifact remains idempotent.
  SELECT stored_publication.*
    INTO v_existing
    FROM arena.copier_snapshot_trust_publications AS stored_publication
   WHERE stored_publication.outer_source_run_id = p_outer_source_run_id
   FOR KEY SHARE;

  IF FOUND THEN
    v_was_replayed := true;
    v_publication_id := v_existing.publication_id;
    v_published_at := v_existing.published_at;
  ELSE
    v_previous_publication_id := NULL;
    v_previous_observed_at := NULL;
    SELECT previous_publication.publication_id,
           previous_publication.observed_at
      INTO v_previous_publication_id, v_previous_observed_at
      FROM arena.copier_snapshot_trust_publications AS previous_publication
     WHERE previous_publication.source_id = p_source_id
       AND previous_publication.trader_id = p_trader_id
       AND previous_publication.lane = p_lane
     ORDER BY previous_publication.observed_at DESC,
              previous_publication.publication_id DESC
     LIMIT 1
     FOR UPDATE;

    IF v_previous_publication_id IS NOT NULL
       AND v_observed_at <= v_previous_observed_at THEN
      RAISE EXCEPTION 'copier snapshot trust publication clock is stale'
        USING ERRCODE = '22007';
    END IF;

    INSERT INTO arena.copier_snapshot_trust_publications (
      source_id,
      trader_id,
      lane,
      outer_source_run_id,
      live_raw_object_id,
      raw_object_id_at_publication,
      raw_storage_path,
      raw_content_hash,
      raw_fetched_at,
      observed_at,
      previous_publication_id,
      source_slug_at_publication,
      exchange_trader_id_at_publication,
      adapter_slug,
      product_type,
      currency,
      source_depth_at_publication,
      request_timeframe,
      scan_terminal_state,
      caller_limited,
      source_reported_row_count,
      page_count,
      observed_candidate_count,
      parsed_row_count,
      snapshot_source_run_id,
      candidate_ledger_sha256,
      parser_conservation_sha256,
      projection_ledger_sha256,
      source_candidate_fixed_multiset_sha256,
      candidate_projection_fixed_multiset_sha256,
      raw_artifact_role,
      evidence_contract,
      serialization_contract,
      data_contract,
      snapshot_artifact_contract,
      candidate_ledger_contract,
      parser_conservation_contract,
      projection_ledger_contract,
      candidate_locator_contract,
      parser_contract,
      projection_tuple_contract,
      projection_encoding_contract,
      source_candidate_fixed_multiset_contract,
      candidate_projection_fixed_multiset_contract,
      occurrence_policy_contract,
      publisher_contract,
      coverage_state,
      rank_eligible
    ) VALUES (
      p_source_id,
      p_trader_id,
      p_lane,
      p_outer_source_run_id,
      p_raw_object_id,
      p_raw_object_id,
      v_raw.storage_path,
      p_outer_source_run_id,
      v_observed_at,
      v_observed_at,
      v_previous_publication_id,
      v_source_slug,
      v_exchange_trader_id,
      v_adapter_slug,
      v_product_type,
      v_currency,
      v_source_depth,
      v_request_timeframe,
      v_scan_terminal_state,
      v_caller_limited,
      NULL,
      v_page_count,
      v_observed_candidate_count,
      v_row_count,
      v_snapshot_sha256,
      v_candidate_sha256,
      v_parser_sha256,
      v_projection_sha256,
      v_source_fixed_sha256,
      v_pair_fixed_sha256,
      'copier_snapshot_trust',
      'arena.copier-snapshot-publication-evidence@2',
      'arena.strict-canonical-json@1',
      'arena.ingest.copier-snapshot-artifact@2',
      'arena.ingest.copier-snapshot-artifact@1',
      'arena.ingest.copier-candidate-ledger@1',
      'arena.ingest.copier-parser-conservation@1',
      'arena.ingest.copier-projection-ledger@1',
      v_candidate_locator_contract,
      v_parser_contract,
      'arena.ingest.copier-projection-tuple@1',
      'arena.ingest.length-prefixed-utf8.nonnegative-int32be@1',
      'arena.ingest.copier-source-candidate-sha256-multiset.domain-count-fixed-bytes@1',
      'arena.ingest.copier-candidate-projection-sha256-multiset.domain-count-fixed-bytes@1',
      'arena.ingest.copier-occurrence-uniqueness.reject-batch@1',
      'arena.ingest.copier-snapshot-publisher@2',
      v_coverage_state,
      false
    )
    RETURNING
      copier_snapshot_trust_publications.publication_id,
      copier_snapshot_trust_publications.published_at
      INTO v_publication_id, v_published_at;

    INSERT INTO arena.copier_snapshot_trust_rows (
      publication_id,
      row_ordinal,
      source_page_ordinal,
      candidate_ordinal,
      source_candidate_sha256,
      projection_sha256,
      source_event_at,
      copier_label,
      copier_pnl_text,
      copier_invested_text,
      copy_duration_days_text,
      dedupe_hash
    )
    SELECT v_publication_id,
           (projection_row.value->>'row_ordinal')::integer,
           (projection_row.value->>'source_page_ordinal')::integer,
           (projection_row.value->>'candidate_ordinal')::integer,
           projection_row.value->>'source_candidate_sha256',
           projection_row.value->>'projection_sha256',
           NULL::timestamptz,
           projection_row.value->'projection'->>'copier_label',
           projection_row.value->'projection'->>'copier_pnl',
           projection_row.value->'projection'->>'copier_invested',
           projection_row.value->'projection'->>'copy_duration_days',
           projection_row.value->'projection'->>'dedupe_hash'
      FROM pg_catalog.jsonb_array_elements(v_projection->'rows') AS
           projection_row(value)
     ORDER BY (projection_row.value->>'row_ordinal')::integer;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted IS DISTINCT FROM v_row_count THEN
      RAISE EXCEPTION 'copier snapshot trust row insertion count drifted'
        USING ERRCODE = '55000';
    END IF;

    SELECT stored_publication.*
      INTO STRICT v_existing
      FROM arena.copier_snapshot_trust_publications AS stored_publication
     WHERE stored_publication.publication_id = v_publication_id;
  END IF;

  -- Header equality is checked for both first publication and exact retry.
  -- Every returned receipt field below is read from this stored row.
  IF v_existing.source_id IS DISTINCT FROM p_source_id
     OR v_existing.trader_id IS DISTINCT FROM p_trader_id
     OR v_existing.lane IS DISTINCT FROM p_lane
     OR v_existing.outer_source_run_id IS DISTINCT FROM p_outer_source_run_id
     OR v_existing.live_raw_object_id IS DISTINCT FROM p_raw_object_id
     OR v_existing.raw_object_id_at_publication IS DISTINCT FROM p_raw_object_id
     OR v_existing.raw_storage_path IS DISTINCT FROM v_raw.storage_path
     OR v_existing.raw_content_hash IS DISTINCT FROM p_outer_source_run_id
     OR v_existing.raw_fetched_at IS DISTINCT FROM v_observed_at
     OR v_existing.observed_at IS DISTINCT FROM v_observed_at
     OR v_existing.source_slug_at_publication IS DISTINCT FROM v_source_slug
     OR v_existing.exchange_trader_id_at_publication IS DISTINCT FROM
          v_exchange_trader_id
     OR v_existing.adapter_slug IS DISTINCT FROM v_adapter_slug
     OR v_existing.product_type IS DISTINCT FROM v_product_type
     OR v_existing.currency IS DISTINCT FROM v_currency
     OR v_existing.source_depth_at_publication IS DISTINCT FROM v_source_depth
     OR v_existing.request_timeframe IS DISTINCT FROM v_request_timeframe
     OR v_existing.scan_terminal_state IS DISTINCT FROM v_scan_terminal_state
     OR v_existing.caller_limited IS DISTINCT FROM v_caller_limited
     OR v_existing.source_reported_row_count IS NOT NULL
     OR v_existing.page_count IS DISTINCT FROM v_page_count
     OR v_existing.observed_candidate_count IS DISTINCT FROM
          v_observed_candidate_count
     OR v_existing.parsed_row_count IS DISTINCT FROM v_row_count
     OR v_existing.snapshot_source_run_id IS DISTINCT FROM v_snapshot_sha256
     OR v_existing.candidate_ledger_sha256 IS DISTINCT FROM v_candidate_sha256
     OR v_existing.parser_conservation_sha256 IS DISTINCT FROM v_parser_sha256
     OR v_existing.projection_ledger_sha256 IS DISTINCT FROM v_projection_sha256
     OR v_existing.source_candidate_fixed_multiset_sha256 IS DISTINCT FROM
          v_source_fixed_sha256
     OR v_existing.candidate_projection_fixed_multiset_sha256 IS DISTINCT FROM
          v_pair_fixed_sha256
     OR v_existing.raw_artifact_role IS DISTINCT FROM 'copier_snapshot_trust'
     OR v_existing.evidence_contract IS DISTINCT FROM
          'arena.copier-snapshot-publication-evidence@2'
     OR v_existing.serialization_contract IS DISTINCT FROM
          'arena.strict-canonical-json@1'
     OR v_existing.data_contract IS DISTINCT FROM
          'arena.ingest.copier-snapshot-artifact@2'
     OR v_existing.snapshot_artifact_contract IS DISTINCT FROM
          'arena.ingest.copier-snapshot-artifact@1'
     OR v_existing.candidate_ledger_contract IS DISTINCT FROM
          'arena.ingest.copier-candidate-ledger@1'
     OR v_existing.parser_conservation_contract IS DISTINCT FROM
          'arena.ingest.copier-parser-conservation@1'
     OR v_existing.projection_ledger_contract IS DISTINCT FROM
          'arena.ingest.copier-projection-ledger@1'
     OR v_existing.candidate_locator_contract IS DISTINCT FROM
          v_candidate_locator_contract
     OR v_existing.parser_contract IS DISTINCT FROM v_parser_contract
     OR v_existing.projection_tuple_contract IS DISTINCT FROM
          'arena.ingest.copier-projection-tuple@1'
     OR v_existing.projection_encoding_contract IS DISTINCT FROM
          'arena.ingest.length-prefixed-utf8.nonnegative-int32be@1'
     OR v_existing.source_candidate_fixed_multiset_contract IS DISTINCT FROM
          'arena.ingest.copier-source-candidate-sha256-multiset.domain-count-fixed-bytes@1'
     OR v_existing.candidate_projection_fixed_multiset_contract IS DISTINCT FROM
          'arena.ingest.copier-candidate-projection-sha256-multiset.domain-count-fixed-bytes@1'
     OR v_existing.occurrence_policy_contract IS DISTINCT FROM
          'arena.ingest.copier-occurrence-uniqueness.reject-batch@1'
     OR v_existing.publisher_contract IS DISTINCT FROM
          'arena.ingest.copier-snapshot-publisher@2'
     OR v_existing.coverage_state IS DISTINCT FROM v_coverage_state
     OR v_existing.rank_eligible IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'copier snapshot trust exact retry header mismatch'
      USING ERRCODE = '55000';
  END IF;

  SELECT pg_catalog.count(*)::integer,
         pg_catalog.min(stored_row.row_ordinal),
         pg_catalog.max(stored_row.row_ordinal)
    INTO v_stored_row_count, v_stored_min_ordinal, v_stored_max_ordinal
    FROM arena.copier_snapshot_trust_rows AS stored_row
   WHERE stored_row.publication_id = v_publication_id;

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
         FROM pg_catalog.jsonb_array_elements(v_projection->'rows') AS
              projection_row(value)
         LEFT JOIN arena.copier_snapshot_trust_rows AS stored_row
           ON stored_row.publication_id = v_publication_id
          AND stored_row.row_ordinal =
                (projection_row.value->>'row_ordinal')::integer
        WHERE stored_row.publication_id IS NULL
           OR stored_row.source_page_ordinal IS DISTINCT FROM
                (projection_row.value->>'source_page_ordinal')::integer
           OR stored_row.candidate_ordinal IS DISTINCT FROM
                (projection_row.value->>'candidate_ordinal')::integer
           OR stored_row.source_candidate_sha256 IS DISTINCT FROM
                projection_row.value->>'source_candidate_sha256'
           OR stored_row.projection_sha256 IS DISTINCT FROM
                projection_row.value->>'projection_sha256'
           OR stored_row.source_event_at IS NOT NULL
           OR stored_row.copier_label IS DISTINCT FROM
                projection_row.value->'projection'->>'copier_label'
           OR stored_row.copier_pnl_text IS DISTINCT FROM
                projection_row.value->'projection'->>'copier_pnl'
           OR stored_row.copier_invested_text IS DISTINCT FROM
                projection_row.value->'projection'->>'copier_invested'
           OR stored_row.copy_duration_days_text IS DISTINCT FROM
                projection_row.value->'projection'->>'copy_duration_days'
           OR stored_row.dedupe_hash IS DISTINCT FROM
                projection_row.value->'projection'->>'dedupe_hash'
     ) THEN
    RAISE EXCEPTION 'copier snapshot trust stored row replay mismatch'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM arena.copier_snapshot_trust_rows AS stored_row
     WHERE stored_row.publication_id = v_publication_id
       AND stored_row.projection_sha256 IS DISTINCT FROM pg_catalog.encode(
         pg_catalog.sha256(
           arena.copier_snapshot_trust_nullable_utf8_v2(
             'arena.ingest.copier-projection-tuple@1'
           ) ||
           arena.copier_snapshot_trust_nullable_utf8_v2(
             stored_row.source_candidate_sha256
           ) ||
           arena.copier_snapshot_trust_nullable_utf8_v2(NULL::text) ||
           arena.copier_snapshot_trust_nullable_utf8_v2(stored_row.copier_label) ||
           arena.copier_snapshot_trust_nullable_utf8_v2(stored_row.copier_pnl_text) ||
           arena.copier_snapshot_trust_nullable_utf8_v2(
             stored_row.copier_invested_text
           ) ||
           arena.copier_snapshot_trust_nullable_utf8_v2(
             stored_row.copy_duration_days_text
           ) ||
           arena.copier_snapshot_trust_nullable_utf8_v2(stored_row.dedupe_hash)
         ),
         'hex'
       )
  ) THEN
    RAISE EXCEPTION 'copier snapshot trust stored tuple hash replay failed'
      USING ERRCODE = '55000';
  END IF;

  WITH stored_members AS (
    SELECT pg_catalog.decode(stored_row.source_candidate_sha256, 'hex') AS member
      FROM arena.copier_snapshot_trust_rows AS stored_row
     WHERE stored_row.publication_id = v_publication_id
  ), encoded AS (
    SELECT arena.copier_snapshot_trust_nullable_utf8_v2(
             'arena.ingest.copier-source-candidate-sha256-multiset.domain-count-fixed-bytes@1'
           ) || pg_catalog.int8send(pg_catalog.count(*)) ||
           COALESCE(
             pg_catalog.string_agg(
               member,
               pg_catalog.decode('', 'hex') ORDER BY member
             ),
             pg_catalog.decode('', 'hex')
           ) AS value
      FROM stored_members
  )
  SELECT pg_catalog.encode(pg_catalog.sha256(value), 'hex')
    INTO STRICT v_replayed_source_fixed_sha256
    FROM encoded;

  WITH stored_members AS (
    SELECT pg_catalog.decode(stored_row.source_candidate_sha256, 'hex') ||
           pg_catalog.decode(stored_row.projection_sha256, 'hex') AS member
      FROM arena.copier_snapshot_trust_rows AS stored_row
     WHERE stored_row.publication_id = v_publication_id
  ), encoded AS (
    SELECT arena.copier_snapshot_trust_nullable_utf8_v2(
             'arena.ingest.copier-candidate-projection-sha256-multiset.domain-count-fixed-bytes@1'
           ) || pg_catalog.int8send(pg_catalog.count(*)) ||
           COALESCE(
             pg_catalog.string_agg(
               member,
               pg_catalog.decode('', 'hex') ORDER BY member
             ),
             pg_catalog.decode('', 'hex')
           ) AS value
      FROM stored_members
  )
  SELECT pg_catalog.encode(pg_catalog.sha256(value), 'hex')
    INTO STRICT v_replayed_pair_fixed_sha256
    FROM encoded;

  IF v_replayed_source_fixed_sha256 IS DISTINCT FROM
       v_existing.source_candidate_fixed_multiset_sha256
     OR v_replayed_pair_fixed_sha256 IS DISTINCT FROM
       v_existing.candidate_projection_fixed_multiset_sha256 THEN
    RAISE EXCEPTION 'copier snapshot trust stored fixed multiset replay failed'
      USING ERRCODE = '55000';
  END IF;

  SELECT NOT EXISTS (
           SELECT 1
             FROM arena.copier_snapshot_trust_publications AS successor
            WHERE successor.previous_publication_id = v_publication_id
         )
    INTO STRICT v_is_current_head;
  IF NOT v_was_replayed AND NOT v_is_current_head THEN
    RAISE EXCEPTION 'copier snapshot trust post-insert head verification failed'
      USING ERRCODE = '55000';
  END IF;

  RETURN QUERY
  SELECT v_existing.publication_id,
         v_existing.published_at,
         v_existing.source_id,
         v_existing.trader_id,
         v_existing.lane,
         v_existing.raw_object_id_at_publication,
         v_existing.outer_source_run_id,
         v_existing.observed_at,
         v_existing.snapshot_source_run_id,
         v_existing.candidate_ledger_sha256,
         v_existing.parser_conservation_sha256,
         v_existing.projection_ledger_sha256,
         v_existing.parsed_row_count,
         v_existing.coverage_state,
         v_existing.rank_eligible,
         v_was_replayed,
         v_is_current_head;
  EXIT publish_after_validation;
  END IF;


  -- Lock the independently addressed RAW evidence before parsing any child.
  -- FOR SHARE blocks all UPDATE/DELETE forms, including NO KEY UPDATE.
  SELECT raw_object.*
    INTO v_raw
    FROM arena.raw_objects AS raw_object
   WHERE raw_object.id = p_raw_object_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copier snapshot trust RAW object is missing'
      USING ERRCODE = '55000';
  END IF;

  IF v_outer_sha256 IS DISTINCT FROM p_outer_source_run_id
     OR v_raw.source_id IS DISTINCT FROM p_source_id
     OR v_raw.trader_id IS DISTINCT FROM p_trader_id
     OR v_raw.job_type IS DISTINCT FROM (CASE p_lane
          WHEN 'tier_b' THEN 'history:copiers'
          ELSE 'tier_c'
        END)
     OR v_raw.timeframe IS NOT NULL
     OR v_raw.bytes <= 0
     OR v_raw.bytes::bigint > LEAST(
          2147483647::bigint,
          v_outer_octets::bigint + GREATEST(
            65536::bigint,
            pg_catalog.ceil(v_outer_octets::numeric / 16384)::bigint * 16
          )
        )
     OR v_raw.content_hash IS DISTINCT FROM p_outer_source_run_id
     OR v_raw.source_run_id IS DISTINCT FROM p_outer_source_run_id
     OR v_raw.trust_artifact_role IS DISTINCT FROM 'copier_snapshot_trust'
     OR v_raw.quarantined IS DISTINCT FROM false
     OR pg_catalog.jsonb_typeof(v_raw.meta) IS DISTINCT FROM 'object'
     OR v_raw.meta->>'surface' IS DISTINCT FROM 'copiers'
     OR v_raw.meta->>'data_contract' IS DISTINCT FROM
          'arena.ingest.copier-snapshot-artifact@2'
     OR v_raw.meta->>'source_run_id' IS DISTINCT FROM p_outer_source_run_id
     OR v_raw.meta->'source_id' IS DISTINCT FROM pg_catalog.to_jsonb(p_source_id)
     OR v_raw.meta->'trader_id' IS DISTINCT FROM pg_catalog.to_jsonb(p_trader_id)
     OR v_raw.meta->>'lane' IS DISTINCT FROM p_lane
     OR v_raw.meta->>'snapshot_artifact_contract' IS DISTINCT FROM
          'arena.ingest.copier-snapshot-artifact@1'
     OR v_raw.meta->>'snapshot_source_run_id' IS DISTINCT FROM v_snapshot_sha256
     OR v_raw.meta->>'candidate_ledger_contract' IS DISTINCT FROM
          'arena.ingest.copier-candidate-ledger@1'
     OR v_raw.meta->>'candidate_ledger_sha256' IS DISTINCT FROM v_candidate_sha256
     OR v_raw.meta->>'parser_conservation_contract' IS DISTINCT FROM
          'arena.ingest.copier-parser-conservation@1'
     OR v_raw.meta->>'parser_conservation_sha256' IS DISTINCT FROM v_parser_sha256
     OR v_raw.meta->>'projection_ledger_contract' IS DISTINCT FROM
          'arena.ingest.copier-projection-ledger@1'
     OR v_raw.meta->>'projection_ledger_sha256' IS DISTINCT FROM v_projection_sha256
     OR v_raw.meta->'raw_integrity' IS NULL
     OR v_raw.meta->'raw_integrity'->'version' IS DISTINCT FROM '1'::jsonb
     OR v_raw.meta->'raw_integrity'->>'content_type' IS DISTINCT FROM
          'application/json'
     OR v_raw.meta->'raw_integrity'->>'encoding' IS DISTINCT FROM 'utf-8'
     OR v_raw.meta->'raw_integrity'->>'compression' IS DISTINCT FROM 'gzip'
     OR v_raw.meta->'raw_integrity'->>'hash_algorithm' IS DISTINCT FROM 'sha256'
     OR v_raw.meta->'raw_integrity'->>'hash_scope' IS DISTINCT FROM 'json_utf8'
     OR v_raw.meta->'raw_integrity'->>'serialization_contract' IS DISTINCT FROM
          'arena.strict-canonical-json@1'
     OR v_raw.meta->'raw_integrity'->'compressed_bytes' IS DISTINCT FROM
          pg_catalog.to_jsonb(v_raw.bytes)
     OR v_raw.meta->'raw_integrity'->'uncompressed_bytes' IS DISTINCT FROM
          pg_catalog.to_jsonb(v_outer_octets)
     OR EXISTS (
       SELECT 1
         FROM arena.raw_object_gc_queue AS gc_row
        WHERE gc_row.raw_object_id = v_raw.id
           OR gc_row.storage_path = v_raw.storage_path
     ) THEN
    RAISE EXCEPTION
      'copier snapshot trust RAW byte anchor, child anchors, role, or retention state mismatch'
      USING ERRCODE = '55000';
  END IF;

  -- Hash/RAW comparisons above deliberately precede all ::jsonb casts.
  BEGIN
    v_snapshot := p_snapshot_strict_canonical_json::jsonb;
    v_candidate := p_candidate_ledger_strict_canonical_json::jsonb;
    v_parser := p_parser_conservation_strict_canonical_json::jsonb;
    v_projection := p_projection_ledger_strict_canonical_json::jsonb;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'copier snapshot trust child evidence is not valid JSON'
        USING ERRCODE = '22023';
  END;

  IF NOT arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(
       v_snapshot,
       ARRAY[
         'contract', 'source', 'trader', 'lane', 'request_timeframe',
         'observed_at', 'page_count', 'scan_terminal_state', 'caller_limited',
         'source_reported_row_count', 'pages'
       ]::text[]
     )
     OR NOT arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(
       v_snapshot->'source',
       ARRAY[
         'id', 'slug', 'currency', 'copier_table_depth', 'fetch_region'
       ]::text[]
     )
     OR NOT arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(
       v_snapshot->'trader',
       ARRAY['id', 'exchange_trader_id']::text[]
     )
     OR v_snapshot->>'contract' IS DISTINCT FROM
          'arena.ingest.copier-snapshot-artifact@1'
     OR pg_catalog.jsonb_typeof(v_snapshot->'source'->'id') IS DISTINCT FROM
          'number'
     OR (v_snapshot->'source'->>'id') !~ '^[1-9][0-9]*$'
     OR pg_catalog.jsonb_typeof(v_snapshot->'source'->'slug') IS DISTINCT FROM
          'string'
     OR (v_snapshot->'source'->>'slug') !~ '^[a-z0-9][a-z0-9_]{0,127}$'
     OR pg_catalog.jsonb_typeof(v_snapshot->'source'->'currency') IS DISTINCT FROM
          'string'
     OR v_snapshot->'source'->>'currency' NOT IN ('USDT', 'USDx', 'USDC', 'USD')
     OR pg_catalog.jsonb_typeof(
          v_snapshot->'source'->'copier_table_depth'
        ) IS DISTINCT FROM 'string'
     OR v_snapshot->'source'->>'copier_table_depth' NOT IN (
          'full', 'top10', 'top3_preview'
        )
     OR pg_catalog.jsonb_typeof(v_snapshot->'source'->'fetch_region') IS DISTINCT FROM
          'string'
     OR v_snapshot->'source'->>'fetch_region' NOT IN (
          'local', 'vps_sg', 'vps_jp'
        )
     OR pg_catalog.jsonb_typeof(v_snapshot->'trader'->'id') IS DISTINCT FROM
          'number'
     OR (v_snapshot->'trader'->>'id') !~ '^[1-9][0-9]*$'
     OR pg_catalog.jsonb_typeof(
          v_snapshot->'trader'->'exchange_trader_id'
        ) IS DISTINCT FROM 'string'
     OR v_snapshot->'trader'->>'exchange_trader_id' IS DISTINCT FROM
          pg_catalog.btrim(v_snapshot->'trader'->>'exchange_trader_id')
     OR pg_catalog.char_length(
          v_snapshot->'trader'->>'exchange_trader_id'
        ) NOT BETWEEN 1 AND 512
     OR pg_catalog.jsonb_typeof(v_snapshot->'lane') IS DISTINCT FROM 'string'
     OR v_snapshot->>'lane' NOT IN ('tier_b', 'tier_c')
     OR pg_catalog.jsonb_typeof(v_snapshot->'observed_at') IS DISTINCT FROM
          'string'
     OR (v_snapshot->>'observed_at') !~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
     OR pg_catalog.jsonb_typeof(v_snapshot->'page_count') IS DISTINCT FROM
          'number'
     OR (v_snapshot->>'page_count') !~ '^[1-9][0-9]*$'
     OR pg_catalog.jsonb_typeof(v_snapshot->'scan_terminal_state') IS DISTINCT FROM
          'string'
     OR v_snapshot->>'scan_terminal_state' NOT IN (
          'stream_exhausted_unverified', 'caller_limited'
        )
     OR pg_catalog.jsonb_typeof(v_snapshot->'caller_limited') IS DISTINCT FROM
          'boolean'
     OR v_snapshot->'source_reported_row_count' IS DISTINCT FROM 'null'::jsonb
     OR pg_catalog.jsonb_typeof(v_snapshot->'pages') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(v_snapshot->'pages') NOT BETWEEN 1 AND 100000
     OR pg_catalog.jsonb_typeof(v_snapshot->'request_timeframe') NOT IN (
          'number', 'null'
        ) THEN
    RAISE EXCEPTION 'copier snapshot trust snapshot contract shape failed'
      USING ERRCODE = '22023';
  END IF;

  IF (v_snapshot->'source'->>'id')::numeric > 32767
     OR (v_snapshot->'trader'->>'id')::numeric > 9007199254740991
     OR (v_snapshot->>'page_count')::numeric > 100000 THEN
    RAISE EXCEPTION 'copier snapshot trust snapshot coordinate bounds failed'
      USING ERRCODE = '22023';
  END IF;

  v_source_slug := v_snapshot->'source'->>'slug';
  v_currency := v_snapshot->'source'->>'currency';
  v_source_depth := v_snapshot->'source'->>'copier_table_depth';
  v_fetch_region := v_snapshot->'source'->>'fetch_region';
  v_exchange_trader_id := v_snapshot->'trader'->>'exchange_trader_id';
  v_observed_at_text := v_snapshot->>'observed_at';
  v_page_count := (v_snapshot->>'page_count')::integer;
  v_scan_terminal_state := v_snapshot->>'scan_terminal_state';
  v_caller_limited := (v_snapshot->>'caller_limited')::boolean;

  BEGIN
    v_observed_at := v_observed_at_text::timestamptz;
  EXCEPTION
    WHEN datetime_field_overflow OR invalid_datetime_format THEN
      RAISE EXCEPTION 'copier snapshot trust snapshot clock is invalid'
        USING ERRCODE = '22007';
  END;
  IF NOT pg_catalog.isfinite(v_observed_at)
     OR pg_catalog.to_char(
          v_observed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) IS DISTINCT FROM v_observed_at_text
     OR v_observed_at > pg_catalog.statement_timestamp() + interval '5 minutes'
     OR (v_snapshot->'source'->>'id')::smallint IS DISTINCT FROM p_source_id
     OR (v_snapshot->'trader'->>'id')::bigint IS DISTINCT FROM p_trader_id
     OR v_snapshot->>'lane' IS DISTINCT FROM p_lane
     OR v_page_count IS DISTINCT FROM pg_catalog.jsonb_array_length(
          v_snapshot->'pages'
        )
     OR v_caller_limited IS DISTINCT FROM
          (v_scan_terminal_state = 'caller_limited') THEN
    RAISE EXCEPTION 'copier snapshot trust snapshot binding failed'
      USING ERRCODE = '22023';
  END IF;

  IF p_lane = 'tier_b' THEN
    IF v_snapshot->'request_timeframe' IS DISTINCT FROM 'null'::jsonb
       OR v_caller_limited THEN
      RAISE EXCEPTION 'copier snapshot trust Tier-B capture shape failed'
        USING ERRCODE = '22023';
    END IF;
    v_request_timeframe := NULL;
  ELSE
    IF pg_catalog.jsonb_typeof(v_snapshot->'request_timeframe') IS DISTINCT FROM
         'number'
       OR (v_snapshot->>'request_timeframe') !~ '^(0|7|30|90)$' THEN
      RAISE EXCEPTION 'copier snapshot trust Tier-C timeframe failed'
        USING ERRCODE = '22023';
    END IF;
    v_request_timeframe := (v_snapshot->>'request_timeframe')::smallint;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_snapshot->'pages')
             WITH ORDINALITY AS page_row(value, ordinal)
     WHERE NOT arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(
             page_row.value,
             ARRAY['pageIndex', 'payload', 'url', 'fetchedAt']::text[]
           )
        OR pg_catalog.jsonb_typeof(page_row.value->'pageIndex') IS DISTINCT FROM
             'number'
        OR (page_row.value->>'pageIndex') !~ '^[1-9][0-9]*$'
        OR (page_row.value->>'pageIndex')::numeric > 9007199254740991
        OR (page_row.value->>'pageIndex')::numeric IS DISTINCT FROM page_row.ordinal
        OR page_row.value->'payload' IS NULL
        OR pg_catalog.jsonb_typeof(page_row.value->'url') IS DISTINCT FROM 'string'
        OR page_row.value->>'url' IS DISTINCT FROM pg_catalog.btrim(
             page_row.value->>'url',
             U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
           )
        OR pg_catalog.char_length(page_row.value->>'url') NOT BETWEEN 1 AND 4096
        OR pg_catalog.jsonb_typeof(page_row.value->'fetchedAt') IS DISTINCT FROM
             'string'
        OR (page_row.value->>'fetchedAt') !~
             '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  ) THEN
    RAISE EXCEPTION 'copier snapshot trust page contract shape failed'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    IF EXISTS (
      SELECT 1
        FROM (
          SELECT page_row.ordinal,
                 page_row.value->>'fetchedAt' AS fetched_at_text,
                 (page_row.value->>'fetchedAt')::timestamptz AS fetched_at,
                 pg_catalog.lag(
                   (page_row.value->>'fetchedAt')::timestamptz
                 ) OVER (ORDER BY page_row.ordinal) AS previous_fetched_at
            FROM pg_catalog.jsonb_array_elements(v_snapshot->'pages')
                   WITH ORDINALITY AS page_row(value, ordinal)
        ) AS page_clock
       WHERE NOT pg_catalog.isfinite(page_clock.fetched_at)
          OR pg_catalog.to_char(
               page_clock.fetched_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             ) IS DISTINCT FROM page_clock.fetched_at_text
          OR page_clock.fetched_at < page_clock.previous_fetched_at
    ) OR (
      v_snapshot->'pages'->(v_page_count - 1)->>'fetchedAt'
    ) IS DISTINCT FROM v_observed_at_text THEN
      RAISE EXCEPTION 'copier snapshot trust page clocks failed'
        USING ERRCODE = '22007';
    END IF;
  EXCEPTION
    WHEN datetime_field_overflow OR invalid_datetime_format THEN
      RAISE EXCEPTION 'copier snapshot trust page clock is invalid'
        USING ERRCODE = '22007';
  END;

  IF NOT arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(
       v_candidate,
       ARRAY[
         'contract', 'serialization_contract', 'multiset_contract', 'source',
         'exchange_trader_id', 'page_count', 'observed_candidate_count',
         'candidate_multiset_sha256', 'pages'
       ]::text[]
     )
     OR NOT arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(
       v_candidate->'source',
       ARRAY['id', 'slug', 'adapter_slug']::text[]
     )
     OR v_candidate->>'contract' IS DISTINCT FROM
          'arena.ingest.copier-candidate-ledger@1'
     OR v_candidate->>'serialization_contract' IS DISTINCT FROM
          'arena.strict-canonical-json@1'
     OR v_candidate->>'multiset_contract' IS DISTINCT FROM
          'arena.ingest.copier-candidate-multiset@1'
     OR pg_catalog.jsonb_typeof(v_candidate->'source'->'id') IS DISTINCT FROM
          'number'
     OR (v_candidate->'source'->>'id') !~ '^[1-9][0-9]*$'
     OR pg_catalog.jsonb_typeof(v_candidate->'source'->'slug') IS DISTINCT FROM
          'string'
     OR pg_catalog.jsonb_typeof(v_candidate->'source'->'adapter_slug') IS DISTINCT FROM
          'string'
     OR v_candidate->'source'->>'adapter_slug' NOT IN (
          'binance', 'bingx', 'bitget', 'bitget_bots', 'bitunix', 'blofin',
          'btcc', 'bybit_copytrade', 'coinex', 'gate', 'kucoin', 'lbank',
          'mexc', 'okx', 'toobit', 'xt'
        )
     OR pg_catalog.jsonb_typeof(v_candidate->'exchange_trader_id') IS DISTINCT FROM
          'string'
     OR pg_catalog.jsonb_typeof(v_candidate->'page_count') IS DISTINCT FROM
          'number'
     OR (v_candidate->>'page_count') !~ '^[1-9][0-9]*$'
     OR pg_catalog.jsonb_typeof(
          v_candidate->'observed_candidate_count'
        ) IS DISTINCT FROM 'number'
     OR (v_candidate->>'observed_candidate_count') !~ '^(0|[1-9][0-9]*)$'
     OR pg_catalog.jsonb_typeof(
          v_candidate->'candidate_multiset_sha256'
        ) IS DISTINCT FROM 'string'
     OR (v_candidate->>'candidate_multiset_sha256') !~ '^[0-9a-f]{64}$'
     OR pg_catalog.jsonb_typeof(v_candidate->'pages') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(v_candidate->'pages') NOT BETWEEN 1 AND 100000
     OR (v_candidate->>'page_count')::numeric > 100000
     OR (v_candidate->>'observed_candidate_count')::numeric > 10000000 THEN
    RAISE EXCEPTION 'copier snapshot trust candidate ledger shape failed'
      USING ERRCODE = '22023';
  END IF;

  v_adapter_slug := v_candidate->'source'->>'adapter_slug';
  v_observed_candidate_count :=
    (v_candidate->>'observed_candidate_count')::integer;

  IF (v_candidate->'source'->>'id')::numeric > 32767
     OR (v_candidate->'source'->>'id')::smallint IS DISTINCT FROM p_source_id
     OR v_candidate->'source'->>'slug' IS DISTINCT FROM v_source_slug
     OR v_candidate->>'exchange_trader_id' IS DISTINCT FROM v_exchange_trader_id
     OR (v_candidate->>'page_count')::integer IS DISTINCT FROM v_page_count THEN
    RAISE EXCEPTION 'copier snapshot trust candidate source binding failed'
      USING ERRCODE = '22023';
  END IF;

  IF (v_candidate->>'page_count')::integer IS DISTINCT FROM
       pg_catalog.jsonb_array_length(v_candidate->'pages') THEN
    RAISE EXCEPTION 'copier snapshot trust candidate page count failed'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_candidate->'pages')
             WITH ORDINALITY AS page_row(value, ordinal)
     WHERE NOT arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(
             page_row.value,
             ARRAY[
               'page_ordinal', 'source_page_index', 'locator_contract',
               'candidate_count', 'occurrences'
             ]::text[]
           )
        OR pg_catalog.jsonb_typeof(page_row.value->'page_ordinal') IS DISTINCT FROM
             'number'
        OR (page_row.value->>'page_ordinal') !~ '^[1-9][0-9]*$'
        OR (page_row.value->>'page_ordinal')::numeric IS DISTINCT FROM page_row.ordinal
        OR pg_catalog.jsonb_typeof(
             page_row.value->'source_page_index'
           ) IS DISTINCT FROM 'number'
        OR (page_row.value->>'source_page_index') !~ '^[1-9][0-9]*$'
        OR (page_row.value->>'source_page_index')::numeric IS DISTINCT FROM
             page_row.ordinal
        OR (page_row.value->>'source_page_index')::numeric IS DISTINCT FROM
             (v_snapshot->'pages'->((page_row.ordinal - 1)::integer)->>'pageIndex')::numeric
        OR pg_catalog.jsonb_typeof(
             page_row.value->'locator_contract'
           ) IS DISTINCT FROM 'string'
        OR (page_row.value->>'locator_contract') !~
             '^arena\.ingest\.copier-candidate-locator\.[a-z0-9_.]+@[1-9][0-9]*$'
        OR pg_catalog.jsonb_typeof(
             page_row.value->'candidate_count'
           ) IS DISTINCT FROM 'number'
        OR (page_row.value->>'candidate_count') !~ '^(0|[1-9][0-9]*)$'
        OR (page_row.value->>'candidate_count')::numeric > 10000000
        OR pg_catalog.jsonb_typeof(page_row.value->'occurrences') IS DISTINCT FROM
             'array'
        OR (page_row.value->>'candidate_count')::numeric IS DISTINCT FROM
             pg_catalog.jsonb_array_length(page_row.value->'occurrences')
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_candidate->'pages')
             WITH ORDINALITY AS page_row(value, page_ordinal)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
        page_row.value->'occurrences'
      ) WITH ORDINALITY AS occurrence(value, occurrence_ordinal)
     WHERE NOT arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(
             occurrence.value,
             ARRAY['candidate_ordinal', 'raw_candidate_sha256']::text[]
           )
        OR pg_catalog.jsonb_typeof(
             occurrence.value->'candidate_ordinal'
           ) IS DISTINCT FROM 'number'
        OR (occurrence.value->>'candidate_ordinal') !~ '^[1-9][0-9]*$'
        OR (occurrence.value->>'candidate_ordinal')::numeric IS DISTINCT FROM
             occurrence.occurrence_ordinal
        OR pg_catalog.jsonb_typeof(
             occurrence.value->'raw_candidate_sha256'
           ) IS DISTINCT FROM 'string'
        OR (occurrence.value->>'raw_candidate_sha256') !~ '^[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'copier snapshot trust candidate page ledger failed'
      USING ERRCODE = '22023';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.jsonb_array_elements(v_candidate->'pages') AS page_row(value)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
        page_row.value->'occurrences'
      ) AS occurrence(value)
  ) IS DISTINCT FROM v_observed_candidate_count::bigint THEN
    RAISE EXCEPTION 'copier snapshot trust candidate occurrence count failed'
      USING ERRCODE = '22023';
  END IF;

  WITH occurrence_hashes AS (
    SELECT occurrence.value->>'raw_candidate_sha256' AS candidate_sha256
      FROM pg_catalog.jsonb_array_elements(v_candidate->'pages') AS page_row(value)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
        page_row.value->'occurrences'
      ) AS occurrence(value)
  ), canonical_preimage AS (
    SELECT '{"candidate_count":' || v_observed_candidate_count::text ||
           ',"contract":"arena.ingest.copier-candidate-multiset@1"' ||
           ',"raw_candidate_sha256":[' ||
           COALESCE(
             pg_catalog.string_agg(
               '"' || candidate_sha256 || '"',
               ',' ORDER BY candidate_sha256 COLLATE "C"
             ),
             ''
           ) || ']}' AS value
      FROM occurrence_hashes
  )
  SELECT pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(value, 'UTF8')),
           'hex'
         )
    INTO STRICT v_candidate_json_multiset_sha256
    FROM canonical_preimage;

  IF v_candidate_json_multiset_sha256 IS DISTINCT FROM
       v_candidate->>'candidate_multiset_sha256' THEN
    RAISE EXCEPTION 'copier snapshot trust candidate canonical multiset failed'
      USING ERRCODE = '22023';
  END IF;

  IF NOT arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(
       v_parser,
       ARRAY[
         'contract', 'serialization_contract', 'candidate_ledger_sha256',
         'source', 'exchange_trader_id', 'observed_candidate_count',
         'parsed_row_count', 'candidate_multiset_sha256',
         'parsed_raw_multiset_sha256', 'rows'
       ]::text[]
     )
     OR NOT arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(
       v_parser->'source',
       ARRAY['id', 'slug', 'adapter_slug']::text[]
     )
     OR v_parser->>'contract' IS DISTINCT FROM
          'arena.ingest.copier-parser-conservation@1'
     OR v_parser->>'serialization_contract' IS DISTINCT FROM
          'arena.strict-canonical-json@1'
     OR pg_catalog.jsonb_typeof(v_parser->'candidate_ledger_sha256') IS DISTINCT FROM
          'string'
     OR (v_parser->>'candidate_ledger_sha256') !~ '^[0-9a-f]{64}$'
     OR pg_catalog.jsonb_typeof(v_parser->'source'->'id') IS DISTINCT FROM
          'number'
     OR (v_parser->'source'->>'id') !~ '^[1-9][0-9]*$'
     OR (v_parser->'source'->>'id')::numeric > 32767
     OR pg_catalog.jsonb_typeof(v_parser->'source'->'slug') IS DISTINCT FROM
          'string'
     OR pg_catalog.jsonb_typeof(v_parser->'source'->'adapter_slug') IS DISTINCT FROM
          'string'
     OR pg_catalog.jsonb_typeof(v_parser->'exchange_trader_id') IS DISTINCT FROM
          'string'
     OR pg_catalog.jsonb_typeof(
          v_parser->'observed_candidate_count'
        ) IS DISTINCT FROM 'number'
     OR (v_parser->>'observed_candidate_count') !~ '^(0|[1-9][0-9]*)$'
     OR (v_parser->>'observed_candidate_count')::numeric > 10000000
     OR pg_catalog.jsonb_typeof(v_parser->'parsed_row_count') IS DISTINCT FROM
          'number'
     OR (v_parser->>'parsed_row_count') !~ '^(0|[1-9][0-9]*)$'
     OR (v_parser->>'parsed_row_count')::numeric > 10000000
     OR pg_catalog.jsonb_typeof(
          v_parser->'candidate_multiset_sha256'
        ) IS DISTINCT FROM 'string'
     OR (v_parser->>'candidate_multiset_sha256') !~ '^[0-9a-f]{64}$'
     OR pg_catalog.jsonb_typeof(
          v_parser->'parsed_raw_multiset_sha256'
        ) IS DISTINCT FROM 'string'
     OR (v_parser->>'parsed_raw_multiset_sha256') !~ '^[0-9a-f]{64}$'
     OR pg_catalog.jsonb_typeof(v_parser->'rows') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(v_parser->'rows') > 10000000 THEN
    RAISE EXCEPTION 'copier snapshot trust parser conservation shape failed'
      USING ERRCODE = '22023';
  END IF;

  v_row_count := (v_parser->>'parsed_row_count')::integer;
  IF v_parser->>'candidate_ledger_sha256' IS DISTINCT FROM v_candidate_sha256
     OR (v_parser->'source'->>'id')::smallint IS DISTINCT FROM p_source_id
     OR v_parser->'source'->>'slug' IS DISTINCT FROM v_source_slug
     OR v_parser->'source'->>'adapter_slug' IS DISTINCT FROM v_adapter_slug
     OR v_parser->>'exchange_trader_id' IS DISTINCT FROM v_exchange_trader_id
     OR (v_parser->>'observed_candidate_count')::integer IS DISTINCT FROM
          v_observed_candidate_count
     OR v_row_count IS DISTINCT FROM v_observed_candidate_count
     OR v_row_count IS DISTINCT FROM pg_catalog.jsonb_array_length(v_parser->'rows')
     OR v_parser->>'candidate_multiset_sha256' IS DISTINCT FROM
          v_candidate_json_multiset_sha256
     OR v_parser->>'parsed_raw_multiset_sha256' IS DISTINCT FROM
          v_candidate_json_multiset_sha256 THEN
    RAISE EXCEPTION 'copier snapshot trust parser conservation binding failed'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_parser->'rows')
             WITH ORDINALITY AS parser_row(value, ordinal)
     WHERE NOT arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(
             parser_row.value,
             ARRAY['row_ordinal', 'raw_candidate_sha256']::text[]
           )
        OR pg_catalog.jsonb_typeof(parser_row.value->'row_ordinal') IS DISTINCT FROM
             'number'
        OR (parser_row.value->>'row_ordinal') !~ '^(0|[1-9][0-9]*)$'
        OR (parser_row.value->>'row_ordinal')::numeric IS DISTINCT FROM
             parser_row.ordinal - 1
        OR pg_catalog.jsonb_typeof(
             parser_row.value->'raw_candidate_sha256'
           ) IS DISTINCT FROM 'string'
        OR (parser_row.value->>'raw_candidate_sha256') !~ '^[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'copier snapshot trust parser row ledger failed'
      USING ERRCODE = '22023';
  END IF;

  WITH parser_hashes AS (
    SELECT parser_row.value->>'raw_candidate_sha256' AS candidate_sha256
      FROM pg_catalog.jsonb_array_elements(v_parser->'rows') AS parser_row(value)
  ), canonical_preimage AS (
    SELECT '{"candidate_count":' || v_row_count::text ||
           ',"contract":"arena.ingest.copier-candidate-multiset@1"' ||
           ',"raw_candidate_sha256":[' ||
           COALESCE(
             pg_catalog.string_agg(
               '"' || candidate_sha256 || '"',
               ',' ORDER BY candidate_sha256 COLLATE "C"
             ),
             ''
           ) || ']}' AS value
      FROM parser_hashes
  )
  SELECT pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(value, 'UTF8')),
           'hex'
         )
    INTO STRICT v_candidate_json_multiset_sha256
    FROM canonical_preimage;

  IF v_candidate_json_multiset_sha256 IS DISTINCT FROM
       v_candidate->>'candidate_multiset_sha256'
     OR v_candidate_json_multiset_sha256 IS DISTINCT FROM
       v_parser->>'parsed_raw_multiset_sha256' THEN
    RAISE EXCEPTION 'copier snapshot trust parser canonical multiset replay failed'
      USING ERRCODE = '22023';
  END IF;

  IF NOT arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(
       v_projection,
       ARRAY[
         'contract', 'serialization_contract', 'snapshot_artifact_contract',
         'snapshot_source_run_id', 'candidate_ledger_sha256',
         'parser_conservation_sha256', 'binding', 'parser_context',
         'projection_tuple_contract', 'projection_encoding_contract',
         'source_candidate_fixed_multiset_contract',
         'candidate_projection_fixed_multiset_contract', 'row_count',
         'source_candidate_fixed_multiset_sha256',
         'candidate_projection_fixed_multiset_sha256', 'rows'
       ]::text[]
     )
     OR NOT arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(
       v_projection->'binding',
       ARRAY[
         'contract', 'adapter_slug', 'product_type',
         'candidate_locator_contract', 'parser_contract'
       ]::text[]
     )
     OR NOT arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(
       v_projection->'parser_context',
       ARRAY['sourceSlug', 'currency', 'tfLabelMap', 'scrapedAt', 'meta']::text[]
     )
     OR v_projection->>'contract' IS DISTINCT FROM
          'arena.ingest.copier-projection-ledger@1'
     OR v_projection->>'serialization_contract' IS DISTINCT FROM
          'arena.strict-canonical-json@1'
     OR v_projection->>'snapshot_artifact_contract' IS DISTINCT FROM
          'arena.ingest.copier-snapshot-artifact@1'
     OR pg_catalog.jsonb_typeof(
          v_projection->'snapshot_source_run_id'
        ) IS DISTINCT FROM 'string'
     OR (v_projection->>'snapshot_source_run_id') !~ '^[0-9a-f]{64}$'
     OR pg_catalog.jsonb_typeof(
          v_projection->'candidate_ledger_sha256'
        ) IS DISTINCT FROM 'string'
     OR (v_projection->>'candidate_ledger_sha256') !~ '^[0-9a-f]{64}$'
     OR pg_catalog.jsonb_typeof(
          v_projection->'parser_conservation_sha256'
        ) IS DISTINCT FROM 'string'
     OR (v_projection->>'parser_conservation_sha256') !~ '^[0-9a-f]{64}$'
     OR v_projection->'binding'->>'contract' IS DISTINCT FROM
          'arena.ingest.copier-parser-replay-binding@1'
     OR pg_catalog.jsonb_typeof(
          v_projection->'binding'->'adapter_slug'
        ) IS DISTINCT FROM 'string'
     OR v_projection->'binding'->>'adapter_slug' NOT IN (
          'binance', 'bingx', 'bitget', 'bitget_bots', 'bitunix', 'blofin',
          'btcc', 'bybit_copytrade', 'coinex', 'gate', 'kucoin', 'lbank',
          'mexc', 'okx', 'toobit', 'xt'
        )
     OR pg_catalog.jsonb_typeof(
          v_projection->'binding'->'product_type'
        ) IS DISTINCT FROM 'string'
     OR v_projection->'binding'->>'product_type' NOT IN (
          'spot', 'futures', 'cfd', 'onchain'
        )
     OR pg_catalog.jsonb_typeof(
          v_projection->'binding'->'candidate_locator_contract'
        ) IS DISTINCT FROM 'string'
     OR (v_projection->'binding'->>'candidate_locator_contract') !~
          '^arena\.ingest\.copier-candidate-locator\.[a-z0-9_.]+@[1-9][0-9]*$'
     OR pg_catalog.jsonb_typeof(
          v_projection->'binding'->'parser_contract'
        ) IS DISTINCT FROM 'string'
     OR v_projection->>'projection_tuple_contract' IS DISTINCT FROM
          'arena.ingest.copier-projection-tuple@1'
     OR v_projection->>'projection_encoding_contract' IS DISTINCT FROM
          'arena.ingest.length-prefixed-utf8.nonnegative-int32be@1'
     OR v_projection->>'source_candidate_fixed_multiset_contract' IS DISTINCT FROM
          'arena.ingest.copier-source-candidate-sha256-multiset.domain-count-fixed-bytes@1'
     OR v_projection->>'candidate_projection_fixed_multiset_contract' IS DISTINCT FROM
          'arena.ingest.copier-candidate-projection-sha256-multiset.domain-count-fixed-bytes@1'
     OR pg_catalog.jsonb_typeof(v_projection->'row_count') IS DISTINCT FROM
          'number'
     OR (v_projection->>'row_count') !~ '^(0|[1-9][0-9]*)$'
     OR (v_projection->>'row_count')::numeric > 10000000
     OR pg_catalog.jsonb_typeof(
          v_projection->'source_candidate_fixed_multiset_sha256'
        ) IS DISTINCT FROM 'string'
     OR (v_projection->>'source_candidate_fixed_multiset_sha256') !~
          '^[0-9a-f]{64}$'
     OR pg_catalog.jsonb_typeof(
          v_projection->'candidate_projection_fixed_multiset_sha256'
        ) IS DISTINCT FROM 'string'
     OR (v_projection->>'candidate_projection_fixed_multiset_sha256') !~
          '^[0-9a-f]{64}$'
     OR pg_catalog.jsonb_typeof(v_projection->'rows') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(v_projection->'rows') > 10000000 THEN
    RAISE EXCEPTION 'copier snapshot trust projection ledger shape failed'
      USING ERRCODE = '22023';
  END IF;

  v_product_type := v_projection->'binding'->>'product_type';
  v_candidate_locator_contract :=
    v_projection->'binding'->>'candidate_locator_contract';
  v_parser_contract := v_projection->'binding'->>'parser_contract';
  v_source_fixed_sha256 :=
    v_projection->>'source_candidate_fixed_multiset_sha256';
  v_pair_fixed_sha256 :=
    v_projection->>'candidate_projection_fixed_multiset_sha256';

  IF v_projection->>'snapshot_source_run_id' IS DISTINCT FROM v_snapshot_sha256
     OR v_projection->>'candidate_ledger_sha256' IS DISTINCT FROM v_candidate_sha256
     OR v_projection->>'parser_conservation_sha256' IS DISTINCT FROM v_parser_sha256
     OR v_projection->'binding'->>'adapter_slug' IS DISTINCT FROM v_adapter_slug
     OR v_parser_contract IS DISTINCT FROM
          'arena.ingest.copier-parser.' || v_adapter_slug || '@1'
     OR (v_projection->>'row_count')::integer IS DISTINCT FROM v_row_count
     OR pg_catalog.jsonb_array_length(v_projection->'rows') IS DISTINCT FROM
          v_row_count
     OR v_projection->'parser_context' IS DISTINCT FROM
          pg_catalog.jsonb_build_object(
            'sourceSlug', v_source_slug,
            'currency', v_currency,
            'tfLabelMap', '{}'::jsonb,
            'scrapedAt', v_observed_at_text,
            'meta', CASE
              WHEN v_adapter_slug = 'gate' THEN
                pg_catalog.jsonb_build_object('boardKey', v_product_type)
              ELSE '{}'::jsonb
            END
          ) THEN
    RAISE EXCEPTION 'copier snapshot trust projection child binding failed'
      USING ERRCODE = '22023';
  END IF;

  -- Retained locator registry @1. Gate has two product-specific identities;
  -- all other retained adapters use their adapter identity directly.
  IF (
       v_adapter_slug = 'gate'
       AND NOT (
         (v_product_type = 'futures' AND v_candidate_locator_contract =
           'arena.ingest.copier-candidate-locator.gate.futures@1')
         OR
         (v_product_type = 'cfd' AND v_candidate_locator_contract =
           'arena.ingest.copier-candidate-locator.gate.cfd@1')
       )
     ) OR (
       v_adapter_slug <> 'gate'
       AND v_candidate_locator_contract IS DISTINCT FROM
         'arena.ingest.copier-candidate-locator.' || v_adapter_slug || '@1'
     ) OR EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_array_elements(v_candidate->'pages') AS page_row(value)
        WHERE page_row.value->>'locator_contract' IS DISTINCT FROM
              v_candidate_locator_contract
     ) THEN
    RAISE EXCEPTION 'copier snapshot trust retained locator binding failed'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_projection->'rows')
             WITH ORDINALITY AS projection_row(value, ordinal)
     WHERE NOT arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(
             projection_row.value,
             ARRAY[
               'row_ordinal', 'source_page_ordinal', 'candidate_ordinal',
               'source_candidate_sha256', 'projection_sha256', 'projection'
             ]::text[]
           )
        OR NOT arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(
             projection_row.value->'projection',
             ARRAY[
               'contract', 'source_candidate_sha256', 'source_event_at',
               'copier_label', 'copier_pnl', 'copier_invested',
               'copy_duration_days', 'dedupe_hash'
             ]::text[]
           )
        OR pg_catalog.jsonb_typeof(
             projection_row.value->'row_ordinal'
           ) IS DISTINCT FROM 'number'
        OR (projection_row.value->>'row_ordinal') !~ '^(0|[1-9][0-9]*)$'
        OR (projection_row.value->>'row_ordinal')::numeric IS DISTINCT FROM
             projection_row.ordinal - 1
        OR pg_catalog.jsonb_typeof(
             projection_row.value->'source_page_ordinal'
           ) IS DISTINCT FROM 'number'
        OR (projection_row.value->>'source_page_ordinal') !~ '^[1-9][0-9]*$'
        OR (projection_row.value->>'source_page_ordinal')::numeric > 100000
        OR pg_catalog.jsonb_typeof(
             projection_row.value->'candidate_ordinal'
           ) IS DISTINCT FROM 'number'
        OR (projection_row.value->>'candidate_ordinal') !~ '^[1-9][0-9]*$'
        OR (projection_row.value->>'candidate_ordinal')::numeric > 10000000
        OR pg_catalog.jsonb_typeof(
             projection_row.value->'source_candidate_sha256'
           ) IS DISTINCT FROM 'string'
        OR (projection_row.value->>'source_candidate_sha256') !~ '^[0-9a-f]{64}$'
        OR pg_catalog.jsonb_typeof(
             projection_row.value->'projection_sha256'
           ) IS DISTINCT FROM 'string'
        OR (projection_row.value->>'projection_sha256') !~ '^[0-9a-f]{64}$'
        OR projection_row.value->'projection'->>'contract' IS DISTINCT FROM
             'arena.ingest.copier-projection-tuple@1'
        OR pg_catalog.jsonb_typeof(
             projection_row.value->'projection'->'source_candidate_sha256'
           ) IS DISTINCT FROM 'string'
        OR (projection_row.value->'projection'->>'source_candidate_sha256') !~
             '^[0-9a-f]{64}$'
        OR projection_row.value->'projection'->'source_event_at' IS DISTINCT FROM
             'null'::jsonb
        OR pg_catalog.jsonb_typeof(
             projection_row.value->'projection'->'copier_label'
           ) NOT IN ('string', 'null')
        OR pg_catalog.jsonb_typeof(
             projection_row.value->'projection'->'copier_pnl'
           ) NOT IN ('string', 'null')
        OR pg_catalog.jsonb_typeof(
             projection_row.value->'projection'->'copier_invested'
           ) NOT IN ('string', 'null')
        OR pg_catalog.jsonb_typeof(
             projection_row.value->'projection'->'copy_duration_days'
           ) NOT IN ('string', 'null')
        OR pg_catalog.jsonb_typeof(
             projection_row.value->'projection'->'dedupe_hash'
           ) IS DISTINCT FROM 'string'
  ) THEN
    RAISE EXCEPTION 'copier snapshot trust projection row shape failed'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_projection->'rows') AS projection_row(value)
      CROSS JOIN LATERAL (
        SELECT projection_row.value->'projection' AS value
      ) AS tuple_row
     WHERE (
             tuple_row.value->'copier_pnl' <> 'null'::jsonb
             AND (
               (tuple_row.value->>'copier_pnl') !~
                 '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$'
               OR tuple_row.value->>'copier_pnl' = '-0'
               OR pg_catalog.char_length(tuple_row.value->>'copier_pnl')
                    NOT BETWEEN 1 AND 400
             )
           )
        OR (
             tuple_row.value->'copier_invested' <> 'null'::jsonb
             AND (
               (tuple_row.value->>'copier_invested') !~
                 '^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$'
               OR pg_catalog.char_length(tuple_row.value->>'copier_invested')
                    NOT BETWEEN 1 AND 400
             )
           )
        OR (
             tuple_row.value->'copy_duration_days' <> 'null'::jsonb
             AND (
               (tuple_row.value->>'copy_duration_days') !~ '^(?:0|[1-9][0-9]*)$'
               OR pg_catalog.char_length(
                    tuple_row.value->>'copy_duration_days'
                  ) > 10
             )
           )
  ) THEN
    RAISE EXCEPTION 'copier snapshot trust projection scalar syntax failed'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_projection->'rows') AS projection_row(value)
      CROSS JOIN LATERAL (
        SELECT projection_row.value->'projection' AS value
      ) AS tuple_row
     WHERE (
             tuple_row.value->'copier_label' <> 'null'::jsonb
             AND (
               tuple_row.value->>'copier_label' IS DISTINCT FROM pg_catalog.btrim(
                 tuple_row.value->>'copier_label',
                 U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
               )
               OR pg_catalog.char_length(tuple_row.value->>'copier_label')
                    NOT BETWEEN 1 AND 512
             )
           )
        OR (
             tuple_row.value->'copier_pnl' <> 'null'::jsonb
             AND (
               (tuple_row.value->>'copier_pnl') !~
                 '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$'
               OR tuple_row.value->>'copier_pnl' = '-0'
               OR pg_catalog.char_length(tuple_row.value->>'copier_pnl')
                    NOT BETWEEN 1 AND 400
               OR pg_catalog.abs((tuple_row.value->>'copier_pnl')::numeric) >
                    9007199254740991
               OR pg_catalog.trim_scale(
                    (tuple_row.value->>'copier_pnl')::numeric
                  )::text IS DISTINCT FROM tuple_row.value->>'copier_pnl'
               OR arena.copier_snapshot_trust_float8_plain_decimal_v2(
                    tuple_row.value->>'copier_pnl'
                  ) IS DISTINCT FROM tuple_row.value->>'copier_pnl'
             )
           )
        OR (
             tuple_row.value->'copier_invested' <> 'null'::jsonb
             AND (
               (tuple_row.value->>'copier_invested') !~
                 '^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$'
               OR pg_catalog.char_length(tuple_row.value->>'copier_invested')
                    NOT BETWEEN 1 AND 400
               OR pg_catalog.abs(
                    (tuple_row.value->>'copier_invested')::numeric
                  ) > 9007199254740991
               OR pg_catalog.trim_scale(
                    (tuple_row.value->>'copier_invested')::numeric
                  )::text IS DISTINCT FROM tuple_row.value->>'copier_invested'
               OR arena.copier_snapshot_trust_float8_plain_decimal_v2(
                    tuple_row.value->>'copier_invested'
                  ) IS DISTINCT FROM tuple_row.value->>'copier_invested'
             )
           )
        OR (
             tuple_row.value->'copy_duration_days' <> 'null'::jsonb
             AND (
               (tuple_row.value->>'copy_duration_days') !~ '^(?:0|[1-9][0-9]*)$'
               OR pg_catalog.char_length(
                    tuple_row.value->>'copy_duration_days'
                  ) > 10
               OR (tuple_row.value->>'copy_duration_days')::numeric > 2147483647
             )
           )
        OR tuple_row.value->>'dedupe_hash' IS DISTINCT FROM pg_catalog.btrim(
             tuple_row.value->>'dedupe_hash',
             U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
           )
        OR pg_catalog.char_length(tuple_row.value->>'dedupe_hash')
             NOT BETWEEN 1 AND 512
  ) THEN
    RAISE EXCEPTION 'copier snapshot trust projection canonical text failed'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    WITH projection_rows AS (
      SELECT projection_row.value,
             (projection_row.value->>'row_ordinal')::integer AS row_ordinal,
             (projection_row.value->>'source_page_ordinal')::integer AS
               source_page_ordinal,
             (projection_row.value->>'candidate_ordinal')::integer AS
               candidate_ordinal,
             projection_row.value->'projection' AS tuple_value
        FROM pg_catalog.jsonb_array_elements(v_projection->'rows') AS
             projection_row(value)
    ), replayed AS (
      SELECT projection_rows.*,
             pg_catalog.encode(
               pg_catalog.sha256(
                 arena.copier_snapshot_trust_nullable_utf8_v2(
                   tuple_value->>'contract'
                 ) ||
                 arena.copier_snapshot_trust_nullable_utf8_v2(
                   tuple_value->>'source_candidate_sha256'
                 ) ||
                 arena.copier_snapshot_trust_nullable_utf8_v2(NULL::text) ||
                 arena.copier_snapshot_trust_nullable_utf8_v2(
                   tuple_value->>'copier_label'
                 ) ||
                 arena.copier_snapshot_trust_nullable_utf8_v2(
                   tuple_value->>'copier_pnl'
                 ) ||
                 arena.copier_snapshot_trust_nullable_utf8_v2(
                   tuple_value->>'copier_invested'
                 ) ||
                 arena.copier_snapshot_trust_nullable_utf8_v2(
                   tuple_value->>'copy_duration_days'
                 ) ||
                 arena.copier_snapshot_trust_nullable_utf8_v2(
                   tuple_value->>'dedupe_hash'
                 )
               ),
               'hex'
             ) AS replayed_projection_sha256
        FROM projection_rows
    )
    SELECT 1
      FROM replayed
     WHERE replayed.value->>'source_candidate_sha256' IS DISTINCT FROM
             replayed.tuple_value->>'source_candidate_sha256'
        OR replayed.value->>'projection_sha256' IS DISTINCT FROM
             replayed.replayed_projection_sha256
        OR v_parser->'rows'->replayed.row_ordinal->>'raw_candidate_sha256'
             IS DISTINCT FROM replayed.value->>'source_candidate_sha256'
        OR v_candidate->'pages'->(replayed.source_page_ordinal - 1)->
             'occurrences'->(replayed.candidate_ordinal - 1)->>
             'raw_candidate_sha256' IS DISTINCT FROM
             replayed.value->>'source_candidate_sha256'
  ) THEN
    RAISE EXCEPTION
      'copier snapshot trust tuple hash, parser ordinal, or candidate coordinate replay failed'
      USING ERRCODE = '22023';
  END IF;

  -- The public-facing product deliberately rejects all repeated occurrences.
  -- Detect every duplicate domain before the header insert so the entire
  -- statement rolls back as one batch, rather than relying on a later row
  -- unique violation.
  IF EXISTS (
    SELECT occurrence.value->>'raw_candidate_sha256'
      FROM pg_catalog.jsonb_array_elements(v_candidate->'pages') AS page_row(value)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
        page_row.value->'occurrences'
      ) AS occurrence(value)
     GROUP BY occurrence.value->>'raw_candidate_sha256'
    HAVING pg_catalog.count(*) > 1
  ) OR EXISTS (
    SELECT projection_row.value->>'source_page_ordinal',
           projection_row.value->>'candidate_ordinal'
      FROM pg_catalog.jsonb_array_elements(v_projection->'rows') AS
           projection_row(value)
     GROUP BY projection_row.value->>'source_page_ordinal',
              projection_row.value->>'candidate_ordinal'
    HAVING pg_catalog.count(*) > 1
  ) OR EXISTS (
    SELECT projection_row.value->>'source_candidate_sha256'
      FROM pg_catalog.jsonb_array_elements(v_projection->'rows') AS
           projection_row(value)
     GROUP BY projection_row.value->>'source_candidate_sha256'
    HAVING pg_catalog.count(*) > 1
  ) OR EXISTS (
    SELECT projection_row.value->>'projection_sha256'
      FROM pg_catalog.jsonb_array_elements(v_projection->'rows') AS
           projection_row(value)
     GROUP BY projection_row.value->>'projection_sha256'
    HAVING pg_catalog.count(*) > 1
  ) OR EXISTS (
    SELECT projection_row.value->'projection'->>'dedupe_hash'
      FROM pg_catalog.jsonb_array_elements(v_projection->'rows') AS
           projection_row(value)
     GROUP BY projection_row.value->'projection'->>'dedupe_hash'
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate copier occurrence rejects the entire publication batch'
      USING ERRCODE = '23505';
  END IF;

  WITH candidate_members AS (
    SELECT pg_catalog.decode(
             occurrence.value->>'raw_candidate_sha256',
             'hex'
           ) AS member
      FROM pg_catalog.jsonb_array_elements(v_candidate->'pages') AS page_row(value)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
        page_row.value->'occurrences'
      ) AS occurrence(value)
  ), encoded AS (
    SELECT arena.copier_snapshot_trust_nullable_utf8_v2(
             'arena.ingest.copier-source-candidate-sha256-multiset.domain-count-fixed-bytes@1'
           ) ||
           pg_catalog.int8send(pg_catalog.count(*)) ||
           COALESCE(
             pg_catalog.string_agg(
               member,
               pg_catalog.decode('', 'hex') ORDER BY member
             ),
             pg_catalog.decode('', 'hex')
           ) AS value
      FROM candidate_members
  )
  SELECT pg_catalog.encode(pg_catalog.sha256(value), 'hex')
    INTO STRICT v_replayed_source_fixed_sha256
    FROM encoded;

  WITH pair_members AS (
    SELECT pg_catalog.decode(
             projection_row.value->>'source_candidate_sha256',
             'hex'
           ) || pg_catalog.decode(
             projection_row.value->>'projection_sha256',
             'hex'
           ) AS member
      FROM pg_catalog.jsonb_array_elements(v_projection->'rows') AS
           projection_row(value)
  ), encoded AS (
    SELECT arena.copier_snapshot_trust_nullable_utf8_v2(
             'arena.ingest.copier-candidate-projection-sha256-multiset.domain-count-fixed-bytes@1'
           ) ||
           pg_catalog.int8send(pg_catalog.count(*)) ||
           COALESCE(
             pg_catalog.string_agg(
               member,
               pg_catalog.decode('', 'hex') ORDER BY member
             ),
             pg_catalog.decode('', 'hex')
           ) AS value
      FROM pair_members
  )
  SELECT pg_catalog.encode(pg_catalog.sha256(value), 'hex')
    INTO STRICT v_replayed_pair_fixed_sha256
    FROM encoded;

  IF v_replayed_source_fixed_sha256 IS DISTINCT FROM v_source_fixed_sha256
     OR v_replayed_pair_fixed_sha256 IS DISTINCT FROM v_pair_fixed_sha256 THEN
    RAISE EXCEPTION 'copier snapshot trust fixed-byte multiset replay failed'
      USING ERRCODE = '22023';
  END IF;

  -- Lock mutable authority rows with FOR SHARE, not FOR KEY SHARE: adapter,
  -- product, surface, claim, currency, and identity are all non-key fields.
  SELECT source_row.*
    INTO v_live_source
    FROM arena.sources AS source_row
   WHERE source_row.id = p_source_id
   FOR SHARE;
  IF NOT FOUND
     OR v_live_source.status IS DISTINCT FROM 'active'
     OR v_live_source.serving_mode IS DISTINCT FROM 'serving'
     OR v_live_source.copier_table_depth NOT IN (
          'full', 'top10', 'top3_preview'
        )
     OR v_live_source.slug IS DISTINCT FROM v_source_slug
     OR v_live_source.adapter_slug IS DISTINCT FROM v_adapter_slug
     OR v_live_source.product_type IS DISTINCT FROM v_product_type
     OR v_live_source.currency IS DISTINCT FROM v_currency
     OR v_live_source.copier_table_depth IS DISTINCT FROM v_source_depth
     OR v_live_source.fetch_region IS DISTINCT FROM v_fetch_region
     OR (
       v_adapter_slug = 'gate'
       AND (
         v_product_type NOT IN ('futures', 'cfd')
         OR v_live_source.meta->>'boardKey' IS DISTINCT FROM v_product_type
       )
     )
     OR (
       v_adapter_slug = 'okx'
       AND (
         v_product_type IS DISTINCT FROM 'futures'
         OR pg_catalog.upper(
              COALESCE(v_live_source.meta->>'inst_type', 'SWAP')
            ) IS DISTINCT FROM 'SWAP'
       )
     ) THEN
    RAISE EXCEPTION
      'copier snapshot trust source is not the active serving copier authority'
      USING ERRCODE = '55000';
  END IF;

  SELECT trader_row.*
    INTO v_live_trader
    FROM arena.traders AS trader_row
   WHERE trader_row.id = p_trader_id
   FOR SHARE;
  IF NOT FOUND
     OR v_live_trader.source_id IS DISTINCT FROM p_source_id
     OR v_live_trader.exchange_trader_id IS DISTINCT FROM v_exchange_trader_id
     -- Historical source rows use both JSON boolean true and string "true".
     -- `->>` intentionally normalizes both forms before the fail-closed gate.
     OR (v_live_trader.meta->>'claimed') IS NOT DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'copier snapshot trust trader is not an unclaimed source subject'
      USING ERRCODE = '55000';
  END IF;

  v_expected_meta := pg_catalog.jsonb_build_object(
    'surface', 'copiers',
    'data_contract', 'arena.ingest.copier-snapshot-artifact@2',
    'source_run_id', p_outer_source_run_id,
    'source_id', p_source_id,
    'source_slug', v_source_slug,
    'trader_id', p_trader_id,
    'lane', p_lane,
    'observed_at', v_observed_at_text,
    'snapshot_artifact_contract', 'arena.ingest.copier-snapshot-artifact@1',
    'snapshot_source_run_id', v_snapshot_sha256,
    'candidate_ledger_contract', 'arena.ingest.copier-candidate-ledger@1',
    'candidate_ledger_sha256', v_candidate_sha256,
    'parser_conservation_contract', 'arena.ingest.copier-parser-conservation@1',
    'parser_conservation_sha256', v_parser_sha256,
    'projection_ledger_contract', 'arena.ingest.copier-projection-ledger@1',
    'projection_ledger_sha256', v_projection_sha256,
    'raw_integrity', pg_catalog.jsonb_build_object(
      'version', 1,
      'content_type', 'application/json',
      'encoding', 'utf-8',
      'compression', 'gzip',
      'hash_algorithm', 'sha256',
      'hash_scope', 'json_utf8',
      'serialization_contract', 'arena.strict-canonical-json@1',
      'compressed_bytes', v_raw.bytes,
      'uncompressed_bytes', v_outer_octets
    )
  );

  IF v_raw.fetched_at IS DISTINCT FROM v_observed_at
     OR NOT pg_catalog.isfinite(v_raw.fetched_at)
     OR v_raw.fetched_at > pg_catalog.statement_timestamp() + interval '5 minutes'
     OR v_raw.storage_path IS DISTINCT FROM
          v_source_slug || '/copier_snapshot_trust/' || p_lane || '/' ||
          p_outer_source_run_id || '/copier_snapshot_trust_' ||
          p_outer_source_run_id || '.json.gz'
     OR v_raw.meta IS DISTINCT FROM v_expected_meta THEN
    RAISE EXCEPTION 'copier snapshot trust RAW path, time, or exact metadata failed'
      USING ERRCODE = '55000';
  END IF;

  -- One lane key exists even before its first row, so concurrent roots cannot
  -- both observe an empty chain. The outer lock above always precedes this.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena.publish-copier-snapshot-trust-v2:lane:' ||
        p_source_id::text || ':' || p_trader_id::text || ':' || p_lane,
      0
    )
  );
  v_evidence_validated := true;
  CONTINUE publish_after_validation;
  END LOOP publish_after_validation;
END
$function$;

ALTER FUNCTION arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(jsonb,text[])
  OWNER TO postgres;
ALTER FUNCTION arena.copier_snapshot_trust_nullable_utf8_v2(text)
  OWNER TO postgres;
ALTER FUNCTION arena.copier_snapshot_trust_float8_plain_decimal_v2(text)
  OWNER TO postgres;
ALTER FUNCTION arena.publish_copier_snapshot_trust_v2(
  bigint,smallint,bigint,text,text,text,text,text,text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION
  arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(jsonb,text[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.copier_snapshot_trust_nullable_utf8_v2(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.copier_snapshot_trust_float8_plain_decimal_v2(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.publish_copier_snapshot_trust_v2(
  bigint,smallint,bigint,text,text,text,text,text,text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION arena.publish_copier_snapshot_trust_v2(
  bigint,smallint,bigint,text,text,text,text,text,text
) TO service_role;

COMMENT ON FUNCTION arena.publish_copier_snapshot_trust_v2(
  bigint,smallint,bigint,text,text,text,text,text,text
) IS
  'Atomic artifact@2 copier evidence publisher. Its four TEXT children must come from the transaction-locked verified RAW reader; SQL replays byte/container/projection contracts but intentionally does not claim to reimplement sixteen JavaScript adapter parsers.';

DO $postflight$
DECLARE
  v_function record;
  v_expected_config text[];
  v_expected_acl_count integer;
BEGIN
  FOR v_function IN
    SELECT procedure_row.oid,
           procedure_row.proname,
           procedure_row.proowner,
           procedure_row.prosecdef,
           procedure_row.provolatile,
           procedure_row.proparallel,
           procedure_row.proconfig,
           procedure_row.proretset,
           (
             SELECT pg_catalog.count(*)::integer
               FROM pg_catalog.aclexplode(procedure_row.proacl) AS acl_row
           ) AS acl_count,
           (
             SELECT pg_catalog.bool_and(
                      acl_row.grantor = 'postgres'::pg_catalog.regrole
                      AND NOT acl_row.is_grantable
                      AND acl_row.privilege_type = 'EXECUTE'
                      AND (
                        acl_row.grantee = 'postgres'::pg_catalog.regrole
                        OR (
                          procedure_row.proname =
                            'publish_copier_snapshot_trust_v2'
                          AND acl_row.grantee =
                            'service_role'::pg_catalog.regrole
                        )
                      )
                    )
               FROM pg_catalog.aclexplode(procedure_row.proacl) AS acl_row
           ) AS acl_exact
      FROM pg_catalog.pg_proc AS procedure_row
     WHERE procedure_row.oid IN (
       'arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(jsonb,text[])'::pg_catalog.regprocedure,
       'arena.copier_snapshot_trust_nullable_utf8_v2(text)'::pg_catalog.regprocedure,
       'arena.copier_snapshot_trust_float8_plain_decimal_v2(text)'::pg_catalog.regprocedure,
       'arena.publish_copier_snapshot_trust_v2(bigint,smallint,bigint,text,text,text,text,text,text)'::pg_catalog.regprocedure
     )
  LOOP
    v_expected_config := CASE
      WHEN v_function.proname = 'publish_copier_snapshot_trust_v2' THEN
        ARRAY[
          'search_path=pg_catalog, pg_temp',
          'row_security=off',
          'standard_conforming_strings=on'
        ]::text[]
      WHEN v_function.proname =
           'copier_snapshot_trust_float8_plain_decimal_v2' THEN
        ARRAY[
          'search_path=pg_catalog, pg_temp',
          'extra_float_digits=3',
          'standard_conforming_strings=on'
        ]::text[]
      ELSE ARRAY['search_path=pg_catalog, pg_temp']::text[]
    END;
    v_expected_acl_count := CASE
      WHEN v_function.proname = 'publish_copier_snapshot_trust_v2' THEN 2
      ELSE 1
    END;

    IF v_function.proowner IS DISTINCT FROM 'postgres'::pg_catalog.regrole
       OR v_function.prosecdef IS DISTINCT FROM
            (v_function.proname = 'publish_copier_snapshot_trust_v2')
       OR v_function.provolatile IS DISTINCT FROM (CASE
            WHEN v_function.proname = 'publish_copier_snapshot_trust_v2'
              THEN 'v'::"char"
            ELSE 'i'::"char"
          END)
       OR v_function.proparallel IS DISTINCT FROM (CASE
            WHEN v_function.proname = 'publish_copier_snapshot_trust_v2'
              THEN 'u'::"char"
            ELSE 's'::"char"
          END)
       OR v_function.proconfig IS DISTINCT FROM v_expected_config
       OR v_function.proretset IS DISTINCT FROM
            (v_function.proname = 'publish_copier_snapshot_trust_v2')
       OR v_function.acl_count IS DISTINCT FROM v_expected_acl_count
       OR v_function.acl_exact IS DISTINCT FROM true THEN
      RAISE EXCEPTION
        'copier snapshot trust publisher function ACL/config fingerprint failed for %',
        v_function.proname;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_proc AS procedure_row
     WHERE procedure_row.oid IN (
       'arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(jsonb,text[])'::pg_catalog.regprocedure,
       'arena.copier_snapshot_trust_nullable_utf8_v2(text)'::pg_catalog.regprocedure,
       'arena.copier_snapshot_trust_float8_plain_decimal_v2(text)'::pg_catalog.regprocedure,
       'arena.publish_copier_snapshot_trust_v2(bigint,smallint,bigint,text,text,text,text,text,text)'::pg_catalog.regprocedure
     )
  ) <> 4
     OR pg_catalog.has_function_privilege(
          'anon',
          'arena.publish_copier_snapshot_trust_v2(bigint,smallint,bigint,text,text,text,text,text,text)',
          'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'authenticated',
          'arena.publish_copier_snapshot_trust_v2(bigint,smallint,bigint,text,text,text,text,text,text)',
          'EXECUTE'
        )
     OR NOT pg_catalog.has_function_privilege(
          'service_role',
          'arena.publish_copier_snapshot_trust_v2(bigint,smallint,bigint,text,text,text,text,text,text)',
          'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'service_role',
          'arena.copier_snapshot_trust_jsonb_has_exact_keys_v2(jsonb,text[])',
          'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'service_role',
          'arena.copier_snapshot_trust_nullable_utf8_v2(text)',
          'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'service_role',
          'arena.copier_snapshot_trust_float8_plain_decimal_v2(text)',
          'EXECUTE'
        ) THEN
    RAISE EXCEPTION 'copier snapshot trust publisher API function boundary failed';
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
    RAISE EXCEPTION 'copier snapshot trust publisher direct table ACL failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS procedure_row
     WHERE procedure_row.oid =
       'arena.protect_copier_snapshot_trust_raw_object()'::pg_catalog.regprocedure
       AND procedure_row.proowner = 'postgres'::pg_catalog.regrole
       AND procedure_row.prosecdef
       AND procedure_row.proconfig = ARRAY[
         'search_path=pg_catalog, pg_temp',
         'row_security=off'
       ]::text[]
  ) THEN
    RAISE EXCEPTION 'copier snapshot trust RAW protection boundary drifted';
  END IF;
END
$postflight$;

COMMIT;
