-- Lane-bound copier snapshot publication authority.
--
-- 054000 remains temporarily executable for rolling Tier-C workers, but it
-- accepts only the legacy event_history RAW role and always writes tier_c.
-- This forward authority admits the strict whole-wrapper copier_snapshot RAW
-- role, derives the stored lane from that immutable RAW metadata, and binds
-- the wrapper digest, nested acquisition digest, request digest, receipt row,
-- and returned receipt to the same lane-aware contract.

BEGIN;

SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    '20260804-copier-snapshot-lane-v2-authority',
    0
  )
);

DO $foundation_preflight$
DECLARE
  v_v1 oid := pg_catalog.to_regprocedure(
    'public.publish_copier_snapshot_v1(jsonb)'
  );
  v_v2 oid := pg_catalog.to_regprocedure(
    'public.publish_copier_snapshot_v2(jsonb)'
  );
  v_reader oid := pg_catalog.to_regprocedure(
    'public.arena_copier_aggregate(text,text)'
  );
  v_raw_binding text;
  v_raw_binding_count integer;
  v_audit_binding text;
  v_audit_binding_count integer;
  v_evidence_binding text;
  v_evidence_binding_count integer;
  v_data_binding text;
  v_data_binding_count integer;
  v_publisher_binding text;
  v_publisher_binding_count integer;
  v_authority_binding text;
  v_authority_binding_count integer;
  v_raw_old constant text :=
    'CHECK ((((source_run_id IS NULL) AND (trust_artifact_role IS NULL)) OR ((source_run_id ~ ''^[0-9a-f]{64}$''::text) AND (trust_artifact_role = ANY (ARRAY[''source_payload''::text, ''population_manifest''::text, ''normalization_components''::text, ''event_history''::text, ''price_history''::text, ''opening_inventory''::text])))))';
  v_raw_target constant text :=
    'CHECK (((((source_run_id IS NULL) AND (trust_artifact_role IS NULL)) OR ((source_run_id ~ ''^[0-9a-f]{64}$''::text) AND (trust_artifact_role = ANY (ARRAY[''source_payload''::text, ''population_manifest''::text, ''normalization_components''::text, ''event_history''::text, ''price_history''::text, ''opening_inventory''::text, ''copier_audit''::text, ''copier_snapshot''::text])))) IS TRUE))';
  v_audit_target constant text :=
    'CHECK (((trust_artifact_role IS DISTINCT FROM ''copier_audit''::text) OR ((NOT (jsonb_typeof(meta) IS DISTINCT FROM ''object''::text)) AND (NOT ((meta ->> ''surface''::text) IS DISTINCT FROM ''copiers_audit''::text)) AND (NOT ((meta -> ''publication_eligible''::text) IS DISTINCT FROM ''false''::jsonb)) AND (NOT ((meta ->> ''history_evidence_contract''::text) IS DISTINCT FROM ''arena.ingest.copier-audit-raw-evidence@1''::text)) AND (NOT ((meta ->> ''data_contract''::text) IS DISTINCT FROM ''arena.ingest.history-acquisition-artifact@1''::text)))))';
  v_evidence_old constant text :=
    'CHECK ((evidence_contract = ''arena.copier-snapshot-publication@1''::text))';
  v_evidence_target constant text :=
    'CHECK ((evidence_contract = ANY (ARRAY[''arena.copier-snapshot-publication@1''::text, ''arena.copier-snapshot-publication@2''::text])))';
  v_data_old constant text :=
    'CHECK ((data_contract = ANY (ARRAY[''arena.ingest.copier-snapshot-artifact@1''::text, ''arena.ingest.history-acquisition-artifact@1''::text])))';
  v_data_target constant text :=
    'CHECK ((data_contract = ANY (ARRAY[''arena.ingest.copier-snapshot-artifact@1''::text, ''arena.ingest.history-acquisition-artifact@1''::text, ''arena.ingest.copier-publication-lane-artifact@1''::text])))';
  v_publisher_old constant text :=
    'CHECK ((publisher_contract = ''arena.ingest.copier-snapshot-publisher@1''::text))';
  v_publisher_target constant text :=
    'CHECK ((publisher_contract = ANY (ARRAY[''arena.ingest.copier-snapshot-publisher@1''::text, ''arena.ingest.copier-snapshot-publisher@2''::text])))';
  v_authority_target constant text :=
    'CHECK (((((evidence_contract = ''arena.copier-snapshot-publication@1''::text) AND (publisher_contract = ''arena.ingest.copier-snapshot-publisher@1''::text) AND (data_contract = ANY (ARRAY[''arena.ingest.copier-snapshot-artifact@1''::text, ''arena.ingest.history-acquisition-artifact@1''::text])) AND (acquisition_source_run_id IS NULL) AND (raw_trust_artifact_role_at_publication IS NULL) AND (raw_evidence_contract_at_publication IS NULL)) OR ((evidence_contract = ''arena.copier-snapshot-publication@2''::text) AND (publisher_contract = ''arena.ingest.copier-snapshot-publisher@2''::text) AND (data_contract = ''arena.ingest.copier-publication-lane-artifact@1''::text) AND (acquisition_source_run_id ~ ''^[0-9a-f]{64}$''::text) AND (acquisition_source_run_id <> repeat(''0''::text, 64)) AND (acquisition_source_run_id <> source_run_id) AND (raw_trust_artifact_role_at_publication = ''copier_snapshot''::text) AND (raw_evidence_contract_at_publication = ''arena.ingest.copier-publication-lane-raw-evidence@1''::text))) IS TRUE))';
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR current_user IS DISTINCT FROM 'postgres'
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL
     OR pg_catalog.to_regclass(
       'arena.copier_snapshot_publications'
     ) IS NULL
     OR pg_catalog.to_regclass('arena.copier_snapshot_rows') IS NULL
     OR v_v1 IS NULL
     OR v_reader IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.guard_copier_snapshot_publication_insert_v1()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.normalize_copier_snapshot_row_source_event_v1()'
     ) IS NULL THEN
    RAISE EXCEPTION 'copier lane V2 authority requires PG17 and the complete 054200 authority';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_v1
      AND procedure.proowner = 'postgres'::pg_catalog.regrole
      AND procedure.prosecdef
      AND procedure.provolatile = 'v'
      AND procedure.proconfig IS NOT DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND pg_catalog.strpos(
        procedure.prosrc,
        'INSERT INTO arena.copier_snapshot_publications'
      ) > 0
      AND pg_catalog.strpos(
        procedure.prosrc,
        '''tier_c'''
      ) > 0
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', v_v1, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege('anon', v_v1, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', v_v1, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'copier V1 rolling authority lineage or ACL drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_reader
      AND procedure.proowner = 'postgres'::pg_catalog.regrole
      AND procedure.prosecdef
      AND procedure.provolatile = 's'
      AND procedure.proconfig IS NOT DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND (
        (
          v_v2 IS NULL
          AND pg_catalog.strpos(
            procedure.prosrc,
            'arena.copier-snapshot-receipt-reader@1'
          ) > 0
          AND pg_catalog.strpos(
            procedure.prosrc,
            'arena.copier-snapshot-receipt-reader@3'
          ) = 0
        )
        OR (
          v_v2 IS NOT NULL
          AND pg_catalog.strpos(
            procedure.prosrc,
            'arena.copier-snapshot-receipt-reader@3'
          ) > 0
          AND pg_catalog.strpos(
            procedure.prosrc,
            'arena.copier-snapshot-receipt-reader@1'
          ) = 0
        )
      )
      AND pg_catalog.strpos(
        procedure.prosrc,
        'arena.copier-snapshot-receipt-reader@2'
      ) = 0
  ) THEN
    RAISE EXCEPTION 'copier reader is not the 054000 bridge or exact lane-aware replay state; current 055000 is held';
  END IF;

  SELECT
    pg_catalog.count(*),
    pg_catalog.min(pg_catalog.pg_get_constraintdef(
      constraint_row.oid, false
    ))
  INTO v_raw_binding_count, v_raw_binding
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'arena.raw_objects'::pg_catalog.regclass
    AND constraint_row.conname = 'raw_objects_metric_trust_binding'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated
    AND NOT constraint_row.condeferrable;
  IF v_raw_binding_count IS DISTINCT FROM 1
     OR v_raw_binding IS NULL
     OR (
       v_v2 IS NULL
       AND v_raw_binding IS DISTINCT FROM v_raw_old
     )
     OR (
       v_v2 IS NOT NULL
       AND v_raw_binding IS DISTINCT FROM v_raw_target
     ) THEN
    RAISE EXCEPTION 'RAW metric-trust binding is not the exact old or lane-aware contract';
  END IF;

  SELECT
    pg_catalog.count(*),
    pg_catalog.min(pg_catalog.pg_get_constraintdef(
      constraint_row.oid, false
    ))
  INTO v_audit_binding_count, v_audit_binding
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'arena.raw_objects'::pg_catalog.regclass
    AND constraint_row.conname = 'raw_objects_copier_audit_contract'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated
    AND NOT constraint_row.condeferrable;
  IF v_v2 IS NULL THEN
    IF v_audit_binding_count IS DISTINCT FROM 0
       OR v_audit_binding IS NOT NULL THEN
      RAISE EXCEPTION 'copier audit RAW contract is partially installed';
    END IF;
  ELSE
    IF v_audit_binding_count IS DISTINCT FROM 1
       OR v_audit_binding IS DISTINCT FROM v_audit_target THEN
      RAISE EXCEPTION 'copier audit RAW contract is not the exact lane-aware replay state';
    END IF;
  END IF;

  SELECT
    pg_catalog.count(*) FILTER (
      WHERE constraint_row.conname =
        'copier_snapshot_publications_evidence_contract_check'
    ),
    pg_catalog.max(pg_catalog.pg_get_constraintdef(
      constraint_row.oid, false
    )) FILTER (
      WHERE constraint_row.conname =
        'copier_snapshot_publications_evidence_contract_check'
    ),
    pg_catalog.count(*) FILTER (
      WHERE constraint_row.conname =
        'copier_snapshot_publications_data_contract_check'
    ),
    pg_catalog.max(pg_catalog.pg_get_constraintdef(
      constraint_row.oid, false
    )) FILTER (
      WHERE constraint_row.conname =
        'copier_snapshot_publications_data_contract_check'
    ),
    pg_catalog.count(*) FILTER (
      WHERE constraint_row.conname =
        'copier_snapshot_publications_publisher_contract_check'
    ),
    pg_catalog.max(pg_catalog.pg_get_constraintdef(
      constraint_row.oid, false
    )) FILTER (
      WHERE constraint_row.conname =
        'copier_snapshot_publications_publisher_contract_check'
    ),
    pg_catalog.count(*) FILTER (
      WHERE constraint_row.conname =
        'copier_snapshot_publication_authority_version'
    ),
    pg_catalog.max(pg_catalog.pg_get_constraintdef(
      constraint_row.oid, false
    )) FILTER (
      WHERE constraint_row.conname =
        'copier_snapshot_publication_authority_version'
    )
  INTO
    v_evidence_binding_count,
    v_evidence_binding,
    v_data_binding_count,
    v_data_binding,
    v_publisher_binding_count,
    v_publisher_binding,
    v_authority_binding_count,
    v_authority_binding
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid =
      'arena.copier_snapshot_publications'::pg_catalog.regclass
    AND constraint_row.conname IN (
      'copier_snapshot_publications_evidence_contract_check',
      'copier_snapshot_publications_data_contract_check',
      'copier_snapshot_publications_publisher_contract_check',
      'copier_snapshot_publication_authority_version'
    )
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated
    AND NOT constraint_row.condeferrable;

  IF v_v2 IS NULL THEN
    IF v_evidence_binding_count IS DISTINCT FROM 1
       OR v_data_binding_count IS DISTINCT FROM 1
       OR v_publisher_binding_count IS DISTINCT FROM 1
       OR v_authority_binding_count IS DISTINCT FROM 0
       OR v_evidence_binding IS DISTINCT FROM v_evidence_old
       OR v_data_binding IS DISTINCT FROM v_data_old
       OR v_publisher_binding IS DISTINCT FROM v_publisher_old
       OR v_authority_binding IS NOT NULL THEN
      RAISE EXCEPTION 'copier publication constraints are not the exact 054000 pre-state';
    END IF;
  ELSE
    IF v_evidence_binding_count IS DISTINCT FROM 1
       OR v_data_binding_count IS DISTINCT FROM 1
       OR v_publisher_binding_count IS DISTINCT FROM 1
       OR v_authority_binding_count IS DISTINCT FROM 1
       OR v_evidence_binding IS DISTINCT FROM v_evidence_target
       OR v_data_binding IS DISTINCT FROM v_data_target
       OR v_publisher_binding IS DISTINCT FROM v_publisher_target
       OR v_authority_binding IS DISTINCT FROM v_authority_target THEN
      RAISE EXCEPTION 'copier publication constraints are not the exact lane-aware replay state';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND attribute.attname = 'meta'
      AND attribute.atttypid = 'pg_catalog.jsonb'::pg_catalog.regtype
      AND attribute.attnotnull
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
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
        'arena.copier_snapshot_rows'::pg_catalog.regclass
      AND attribute.attname = 'source_event_at'
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'copier lane V2 RAW or 054200 provenance shape drifted';
  END IF;

  IF v_v2 IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid =
          'arena.copier_snapshot_publications'::pg_catalog.regclass
        AND attribute.attname IN (
          'acquisition_source_run_id',
          'raw_trust_artifact_role_at_publication',
          'raw_evidence_contract_at_publication'
        )
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) OR pg_catalog.to_regprocedure(
      'public.publish_copier_snapshot_v2(jsonb)'
    ) IS NOT NULL THEN
      RAISE EXCEPTION 'copier lane V2 authority is partially installed';
    END IF;
  ELSE
    IF (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid =
          'arena.copier_snapshot_publications'::pg_catalog.regclass
        AND attribute.attname IN (
          'acquisition_source_run_id',
          'raw_trust_artifact_role_at_publication',
          'raw_evidence_contract_at_publication'
        )
        AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
        AND NOT attribute.attnotnull
        AND NOT attribute.atthasdef
        AND attribute.attidentity = ''
        AND attribute.attgenerated = ''
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) <> 3
       OR NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS procedure
         WHERE procedure.oid = v_v2
           AND procedure.proowner = 'postgres'::pg_catalog.regrole
           AND procedure.prosecdef
           AND procedure.provolatile = 'v'
           AND procedure.proconfig IS NOT DISTINCT FROM
               ARRAY['search_path=pg_catalog, pg_temp']::text[]
           AND pg_catalog.strpos(
             procedure.prosrc,
             'arena.copier-snapshot-publication@2'
           ) > 0
           AND pg_catalog.strpos(
             procedure.prosrc,
             'arena.ingest.copier-publication-lane-artifact@1'
           ) > 0
           AND pg_catalog.strpos(
             procedure.prosrc,
             'public.publish_copier_snapshot_v1'
           ) = 0
       )
       OR NOT pg_catalog.has_function_privilege(
         'service_role', v_v2, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_v2, 'EXECUTE')
       OR pg_catalog.has_function_privilege(
         'authenticated', v_v2, 'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'copier lane V2 authority replay state drifted';
    END IF;
  END IF;
END
$foundation_preflight$;

-- READ COMMITTED prevents the catalog preflight from pinning a stale snapshot.
-- These locks drain both old and new publishers before the zero-evidence gate.
LOCK TABLE ONLY arena.sources IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.traders IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.raw_objects IN ACCESS EXCLUSIVE MODE;
LOCK TABLE ONLY arena.copier_snapshot_publications IN ACCESS EXCLUSIVE MODE;
LOCK TABLE ONLY arena.copier_snapshot_rows IN ACCESS EXCLUSIVE MODE;

DO $locked_preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM arena.copier_snapshot_publications LIMIT 1
  ) OR EXISTS (
    SELECT 1 FROM arena.copier_snapshot_rows LIMIT 1
  ) THEN
    RAISE EXCEPTION 'copier lane V2 authority requires zero existing receipts and rows';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger
    WHERE trigger.tgrelid IN (
      'arena.copier_snapshot_publications'::pg_catalog.regclass,
      'arena.copier_snapshot_rows'::pg_catalog.regclass
    )
      AND NOT trigger.tgisinternal
      AND trigger.tgenabled = 'O'
      AND trigger.tgname IN (
        'copier_snapshot_publication_guard_insert_v1',
        'copier_snapshot_row_normalize_source_event_v1',
        'copier_snapshot_publication_reject_update_delete',
        'copier_snapshot_publication_reject_truncate',
        'copier_snapshot_row_reject_update_delete',
        'copier_snapshot_row_reject_truncate'
      )
  ) <> 6 THEN
    RAISE EXCEPTION 'copier lane V2 immutable/admission trigger lineage drifted';
  END IF;
END
$locked_preflight$;

ALTER TABLE arena.raw_objects
  DROP CONSTRAINT raw_objects_metric_trust_binding;
ALTER TABLE arena.raw_objects
  ADD CONSTRAINT raw_objects_metric_trust_binding
  CHECK (
    (
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
          'copier_audit',
          'copier_snapshot'
        )
      )
    ) IS TRUE
  );

ALTER TABLE arena.raw_objects
  DROP CONSTRAINT IF EXISTS raw_objects_copier_audit_contract;
ALTER TABLE arena.raw_objects
  ADD CONSTRAINT raw_objects_copier_audit_contract
  CHECK (
    trust_artifact_role IS DISTINCT FROM 'copier_audit'
    OR (
      pg_catalog.jsonb_typeof(meta) IS NOT DISTINCT FROM 'object'
      AND meta->>'surface' IS NOT DISTINCT FROM 'copiers_audit'
      AND meta->'publication_eligible' IS NOT DISTINCT FROM
          'false'::pg_catalog.jsonb
      AND meta->>'history_evidence_contract' IS NOT DISTINCT FROM
          'arena.ingest.copier-audit-raw-evidence@1'
      AND meta->>'data_contract' IS NOT DISTINCT FROM
          'arena.ingest.history-acquisition-artifact@1'
    )
  );

ALTER TABLE arena.copier_snapshot_publications
  ADD COLUMN IF NOT EXISTS acquisition_source_run_id text,
  ADD COLUMN IF NOT EXISTS raw_trust_artifact_role_at_publication text,
  ADD COLUMN IF NOT EXISTS raw_evidence_contract_at_publication text;

ALTER TABLE arena.copier_snapshot_publications
  DROP CONSTRAINT copier_snapshot_publications_evidence_contract_check;
ALTER TABLE arena.copier_snapshot_publications
  ADD CONSTRAINT copier_snapshot_publications_evidence_contract_check
  CHECK (
    evidence_contract IN (
      'arena.copier-snapshot-publication@1',
      'arena.copier-snapshot-publication@2'
    )
  );

ALTER TABLE arena.copier_snapshot_publications
  DROP CONSTRAINT copier_snapshot_publications_data_contract_check;
ALTER TABLE arena.copier_snapshot_publications
  ADD CONSTRAINT copier_snapshot_publications_data_contract_check
  CHECK (
    data_contract IN (
      'arena.ingest.copier-snapshot-artifact@1',
      'arena.ingest.history-acquisition-artifact@1',
      'arena.ingest.copier-publication-lane-artifact@1'
    )
  );

ALTER TABLE arena.copier_snapshot_publications
  DROP CONSTRAINT copier_snapshot_publications_publisher_contract_check;
ALTER TABLE arena.copier_snapshot_publications
  ADD CONSTRAINT copier_snapshot_publications_publisher_contract_check
  CHECK (
    publisher_contract IN (
      'arena.ingest.copier-snapshot-publisher@1',
      'arena.ingest.copier-snapshot-publisher@2'
    )
  );

ALTER TABLE arena.copier_snapshot_publications
  DROP CONSTRAINT IF EXISTS copier_snapshot_publication_authority_version;
ALTER TABLE arena.copier_snapshot_publications
  ADD CONSTRAINT copier_snapshot_publication_authority_version
  CHECK (
    (
      (
        evidence_contract = 'arena.copier-snapshot-publication@1'
        AND publisher_contract = 'arena.ingest.copier-snapshot-publisher@1'
        AND data_contract IN (
          'arena.ingest.copier-snapshot-artifact@1',
          'arena.ingest.history-acquisition-artifact@1'
        )
        AND acquisition_source_run_id IS NULL
        AND raw_trust_artifact_role_at_publication IS NULL
        AND raw_evidence_contract_at_publication IS NULL
      )
      OR (
        evidence_contract = 'arena.copier-snapshot-publication@2'
        AND publisher_contract = 'arena.ingest.copier-snapshot-publisher@2'
        AND data_contract =
            'arena.ingest.copier-publication-lane-artifact@1'
        AND acquisition_source_run_id ~ '^[0-9a-f]{64}$'
        AND acquisition_source_run_id <> pg_catalog.repeat('0', 64)
        AND acquisition_source_run_id <> source_run_id
        AND raw_trust_artifact_role_at_publication = 'copier_snapshot'
        AND raw_evidence_contract_at_publication =
            'arena.ingest.copier-publication-lane-raw-evidence@1'
      )
    ) IS TRUE
  );

COMMENT ON COLUMN
  arena.copier_snapshot_publications.acquisition_source_run_id IS
  'For V2 only: strict-canonical SHA-256 of the complete nested HistoryAcquisitionArtifact; distinct from the lane-wrapper source_run_id.';
COMMENT ON COLUMN
  arena.copier_snapshot_publications.raw_trust_artifact_role_at_publication IS
  'For V2 only: frozen copier_snapshot RAW role retained after live RAW GC.';
COMMENT ON COLUMN
  arena.copier_snapshot_publications.raw_evidence_contract_at_publication IS
  'For V2 only: frozen lane-aware RAW evidence contract retained after live RAW GC.';

CREATE OR REPLACE FUNCTION public.publish_copier_snapshot_v2(
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
    'acquisitionSourceRunId',
    'blockerReasons',
    'contract',
    'currency',
    'evidenceState',
    'lane',
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
  v_expected_meta_keys constant text[] := ARRAY[
    'acquisition_contract',
    'acquisition_source_run_id',
    'attempt_started_at',
    'capture_config',
    'data_contract',
    'exchange_trader_id',
    'history_kind',
    'observed_at',
    'page_count',
    'publication_eligible',
    'publication_evidence_contract',
    'publication_lane',
    'raw_integrity',
    'scan_terminal_state',
    'source_id',
    'source_run_id',
    'source_slug',
    'starting_cursor',
    'surface',
    'terminal_evidence_state',
    'termination',
    'trader_id',
    'verifier_contract'
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
  v_expected_integrity_keys constant text[] := ARRAY[
    'compressed_bytes',
    'compression',
    'content_type',
    'encoding',
    'hash_algorithm',
    'hash_scope',
    'serialization_contract',
    'uncompressed_bytes',
    'version'
  ]::text[];
  v_actual_keys text[];
  v_source_id smallint;
  v_trader_id bigint;
  v_raw_object_id bigint;
  v_source_run_id text;
  v_acquisition_source_run_id text;
  v_request_lane text;
  v_trusted_lane text;
  v_expected_job_type text;
  v_observed_at timestamptz;
  v_attempt_started_at timestamptz;
  v_currency text;
  v_depth text;
  v_source_slug text;
  v_exchange_trader_id text;
  v_trader_meta jsonb;
  v_raw arena.raw_objects%ROWTYPE;
  v_terminal_verifier_contract text;
  v_page_count integer;
  v_compressed_bytes integer;
  v_uncompressed_bytes numeric;
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
    RAISE EXCEPTION 'copier lane V2 request must be an exact JSON object'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(key_name ORDER BY key_name)
  INTO v_actual_keys
  FROM pg_catalog.jsonb_object_keys(p_request) AS key_name;
  IF v_actual_keys IS DISTINCT FROM v_expected_keys THEN
    RAISE EXCEPTION 'copier lane V2 request keys are not exact'
      USING ERRCODE = '22023';
  END IF;

  IF p_request->>'contract' IS DISTINCT FROM
       'arena.copier-snapshot-publication@2'
     OR p_request->>'evidenceState' IS DISTINCT FROM 'verified'
     OR p_request->>'scanTerminalState' IS DISTINCT FROM 'exhausted'
     OR p_request->'blockerReasons' IS DISTINCT FROM '[]'::jsonb
     OR pg_catalog.jsonb_typeof(p_request->'rows') <> 'array'
     OR pg_catalog.jsonb_typeof(p_request->'sourceId') <> 'number'
     OR pg_catalog.jsonb_typeof(p_request->'traderId') <> 'number'
     OR pg_catalog.jsonb_typeof(p_request->'rawObjectId') <> 'number'
     OR pg_catalog.jsonb_typeof(p_request->'sourceRunId') <> 'string'
     OR pg_catalog.jsonb_typeof(
       p_request->'acquisitionSourceRunId'
     ) <> 'string'
     OR pg_catalog.jsonb_typeof(p_request->'lane') <> 'string'
     OR pg_catalog.jsonb_typeof(p_request->'observedAt') <> 'string'
     OR pg_catalog.jsonb_typeof(p_request->'currency') <> 'string' THEN
    RAISE EXCEPTION 'copier lane V2 request evidence or value types are invalid'
      USING ERRCODE = '22023';
  END IF;

  IF p_request->>'sourceId' !~ '^[1-9][0-9]*$'
     OR p_request->>'traderId' !~ '^[1-9][0-9]*$'
     OR p_request->>'rawObjectId' !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'copier lane V2 identifiers must be positive JSON integers'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_source_id := (p_request->>'sourceId')::smallint;
    v_trader_id := (p_request->>'traderId')::bigint;
    v_raw_object_id := (p_request->>'rawObjectId')::bigint;
    v_observed_at := (p_request->>'observedAt')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'copier lane V2 coordinates are invalid'
      USING ERRCODE = '22023';
  END;

  v_source_run_id := p_request->>'sourceRunId';
  v_acquisition_source_run_id := p_request->>'acquisitionSourceRunId';
  v_request_lane := p_request->>'lane';
  v_currency := p_request->>'currency';
  IF v_source_id <= 0
     OR v_trader_id <= 0
     OR v_raw_object_id <= 0
     OR NOT pg_catalog.isfinite(v_observed_at)
     OR v_observed_at >
        pg_catalog.statement_timestamp() + interval '5 minutes'
     OR v_source_run_id !~ '^[0-9a-f]{64}$'
     OR v_source_run_id = pg_catalog.repeat('0', 64)
     OR v_acquisition_source_run_id !~ '^[0-9a-f]{64}$'
     OR v_acquisition_source_run_id = pg_catalog.repeat('0', 64)
     OR v_acquisition_source_run_id = v_source_run_id
     OR v_request_lane NOT IN ('tier_b', 'tier_c')
     OR p_request->>'observedAt' IS DISTINCT FROM pg_catalog.to_char(
       v_observed_at AT TIME ZONE 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
     ) THEN
    RAISE EXCEPTION 'copier lane V2 coordinates are outside their contract'
      USING ERRCODE = '22023';
  END IF;

  v_row_count := pg_catalog.jsonb_array_length(p_request->'rows');
  IF v_row_count > 10000000 THEN
    RAISE EXCEPTION 'copier lane V2 row count exceeds the contract maximum'
      USING ERRCODE = '54000';
  END IF;

  FOR v_row, v_ordinal IN
    SELECT row_value, row_number
    FROM pg_catalog.jsonb_array_elements(p_request->'rows')
      WITH ORDINALITY AS item(row_value, row_number)
  LOOP
    IF pg_catalog.jsonb_typeof(v_row) <> 'object' THEN
      RAISE EXCEPTION 'copier lane V2 row % is not an object', v_ordinal
        USING ERRCODE = '22023';
    END IF;
    SELECT pg_catalog.array_agg(key_name ORDER BY key_name)
    INTO v_actual_keys
    FROM pg_catalog.jsonb_object_keys(v_row) AS key_name;
    IF v_actual_keys IS DISTINCT FROM v_expected_row_keys
       OR pg_catalog.jsonb_typeof(v_row->'ts') <> 'string'
       OR pg_catalog.jsonb_typeof(v_row->'dedupeHash') <> 'string'
       OR pg_catalog.jsonb_typeof(v_row->'raw') <> 'object'
       OR pg_catalog.jsonb_typeof(v_row->'copierLabel') NOT IN (
         'string', 'null'
       )
       OR pg_catalog.jsonb_typeof(v_row->'copierPnl') NOT IN (
         'number', 'null'
       )
       OR pg_catalog.jsonb_typeof(v_row->'copierInvested') NOT IN (
         'number', 'null'
       )
       OR pg_catalog.jsonb_typeof(v_row->'copyDurationDays') NOT IN (
         'number', 'null'
       )
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
      RAISE EXCEPTION 'copier lane V2 row % shape is invalid', v_ordinal
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
      RAISE EXCEPTION 'copier lane V2 row % numeric or clock value is invalid', v_ordinal
        USING ERRCODE = '22023';
    END;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*) <>
           pg_catalog.count(DISTINCT row_value->>'dedupeHash')
    FROM pg_catalog.jsonb_array_elements(p_request->'rows') AS row_value
  ) THEN
    RAISE EXCEPTION 'copier lane V2 dedupeHash values must be unique'
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
       OR v_existing.raw_object_id_at_publication IS DISTINCT FROM
          v_raw_object_id
       OR v_existing.lane IS DISTINCT FROM v_request_lane
       OR v_existing.acquisition_source_run_id IS DISTINCT FROM
          v_acquisition_source_run_id
       OR v_existing.observed_at IS DISTINCT FROM v_observed_at
       OR v_existing.parsed_row_count IS DISTINCT FROM v_row_count
       OR v_existing.row_set_sha256 IS DISTINCT FROM v_row_set_sha256
       OR v_existing.evidence_contract IS DISTINCT FROM
          'arena.copier-snapshot-publication@2'
       OR v_existing.publisher_contract IS DISTINCT FROM
          'arena.ingest.copier-snapshot-publisher@2' THEN
      RAISE EXCEPTION 'copier lane V2 sourceRunId replay conflicts with its immutable request'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'arena-copier-subject:' ||
      v_source_id::text || ':' || v_trader_id::text,
      0
    )
  );

  SELECT
    source_row.copier_table_depth,
    source_row.currency,
    source_row.slug,
    trader_row.exchange_trader_id,
    trader_row.meta
  INTO
    v_depth,
    v_currency,
    v_source_slug,
    v_exchange_trader_id,
    v_trader_meta
  FROM arena.sources AS source_row
  JOIN arena.traders AS trader_row
    ON trader_row.source_id = source_row.id
  WHERE source_row.id = v_source_id
    AND trader_row.id = v_trader_id
    AND source_row.status = 'active'
    AND source_row.serving_mode = 'serving'
    AND source_row.copier_table_depth IN (
      'full', 'top10', 'top3_preview'
    )
    AND source_row.currency = p_request->>'currency'
  FOR SHARE OF source_row, trader_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copier lane V2 subject is not active serving or its source contract drifted'
      USING ERRCODE = '55000';
  END IF;
  IF v_trader_meta->>'claimed' = 'true' THEN
    RAISE EXCEPTION 'claimed trader copier lane V2 snapshots cannot be published'
      USING ERRCODE = '55000';
  END IF;

  -- RAW GC may tombstone only the live FK. These V2 coordinates were frozen
  -- in the immutable receipt, so an exact replay does not need a live pointer.
  IF v_existing.publication_id IS NOT NULL
     AND v_existing.live_raw_object_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'receiptId', v_existing.publication_id,
      'sourceRunId', v_existing.source_run_id,
      'acquisitionSourceRunId', v_existing.acquisition_source_run_id,
      'lane', v_existing.lane,
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
    RAISE EXCEPTION 'copier lane V2 replay no longer has its exact live RAW evidence'
      USING ERRCODE = '55000';
  END IF;

  SELECT raw_object.*
  INTO v_raw
  FROM arena.raw_objects AS raw_object
  WHERE raw_object.id = v_raw_object_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copier lane V2 RAW pointer is missing'
      USING ERRCODE = '55000';
  END IF;

  IF v_raw.trust_artifact_role IS DISTINCT FROM 'copier_snapshot' THEN
    RAISE EXCEPTION 'copier lane V2 RAW role is audit-only or otherwise not publication eligible'
      USING ERRCODE = '55000';
  END IF;

  IF pg_catalog.jsonb_typeof(v_raw.meta) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'copier lane V2 RAW metadata is not an exact object'
      USING ERRCODE = '55000';
  END IF;
  SELECT pg_catalog.array_agg(key_name ORDER BY key_name)
  INTO v_actual_keys
  FROM pg_catalog.jsonb_object_keys(v_raw.meta) AS key_name;
  IF v_actual_keys IS DISTINCT FROM v_expected_meta_keys THEN
    RAISE EXCEPTION 'copier lane V2 RAW metadata keys are not exact'
      USING ERRCODE = '55000';
  END IF;

  IF pg_catalog.jsonb_typeof(
       v_raw.meta->'publication_lane'
     ) IS DISTINCT FROM 'string'
     OR v_raw.meta->>'publication_lane' NOT IN ('tier_b', 'tier_c') THEN
    RAISE EXCEPTION 'copier lane V2 RAW publication lane is invalid'
      USING ERRCODE = '55000';
  END IF;
  v_trusted_lane := v_raw.meta->>'publication_lane';
  v_expected_job_type := CASE v_trusted_lane
    WHEN 'tier_b' THEN 'history:copiers'
    WHEN 'tier_c' THEN 'tier_c'
  END;

  IF v_trusted_lane IS DISTINCT FROM v_request_lane
     OR v_raw.source_id IS DISTINCT FROM v_source_id
     OR v_raw.trader_id IS DISTINCT FROM v_trader_id
     OR v_raw.job_type IS DISTINCT FROM v_expected_job_type
     OR v_raw.timeframe IS NOT NULL
     OR v_raw.quarantined IS DISTINCT FROM false
     OR v_raw.source_run_id IS DISTINCT FROM v_source_run_id
     OR v_raw.content_hash IS DISTINCT FROM v_source_run_id
     OR v_raw.trust_artifact_role IS DISTINCT FROM 'copier_snapshot'
     OR v_raw.fetched_at IS DISTINCT FROM v_observed_at
     OR v_raw.storage_path IS DISTINCT FROM
        v_source_slug || '/copier_publication/' || v_trusted_lane || '/' ||
        v_source_run_id || '/copier_snapshot_' || v_source_run_id ||
        '.json.gz'
     OR v_raw.bytes IS NULL
     OR v_raw.bytes <= 0
     OR v_raw.meta->>'surface' IS DISTINCT FROM 'copiers'
     OR v_raw.meta->'publication_eligible' IS DISTINCT FROM 'true'::jsonb
     OR v_raw.meta->>'publication_evidence_contract' IS DISTINCT FROM
        'arena.ingest.copier-publication-lane-raw-evidence@1'
     OR v_raw.meta->>'data_contract' IS DISTINCT FROM
        'arena.ingest.copier-publication-lane-artifact@1'
     OR v_raw.meta->>'source_run_id' IS DISTINCT FROM v_source_run_id
     OR v_raw.meta->>'acquisition_contract' IS DISTINCT FROM
        'arena.ingest.history-acquisition-artifact@1'
     OR v_raw.meta->>'acquisition_source_run_id' IS DISTINCT FROM
        v_acquisition_source_run_id
     OR v_raw.meta->>'source_slug' IS DISTINCT FROM v_source_slug
     OR v_raw.meta->>'exchange_trader_id' IS DISTINCT FROM
        v_exchange_trader_id
     OR v_raw.meta->>'history_kind' IS DISTINCT FROM 'copiers'
     OR v_raw.meta->'starting_cursor' IS DISTINCT FROM 'null'::jsonb
     OR v_raw.meta->'capture_config' IS DISTINCT FROM
        '{"caller_page_cap":null}'::jsonb
     OR v_raw.meta->>'observed_at' IS DISTINCT FROM
        p_request->>'observedAt'
     OR v_raw.meta->>'terminal_evidence_state' IS DISTINCT FROM 'verified'
     OR v_raw.meta->>'scan_terminal_state' IS DISTINCT FROM 'exhausted'
     OR (
       v_raw.meta->>'verifier_contract' ~
         '^arena\.ingest\.history-terminal-verifier\.[a-z0-9_]+(?:\.[a-z0-9_]+)*\.copiers@[1-9][0-9]*$'
     ) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'copier lane V2 RAW pointer does not prove the exact wrapper, lane, subject, clock, and nested acquisition digest'
      USING ERRCODE = '55000';
  END IF;

  IF pg_catalog.jsonb_typeof(v_raw.meta->'source_id') IS DISTINCT FROM
       'number'
     OR pg_catalog.jsonb_typeof(v_raw.meta->'trader_id') IS DISTINCT FROM
       'number'
     OR v_raw.meta->>'source_id' !~ '^[1-9][0-9]*$'
     OR v_raw.meta->>'trader_id' !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'copier lane V2 RAW subject coordinates are invalid'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    IF (v_raw.meta->>'source_id')::smallint IS DISTINCT FROM v_source_id
       OR (v_raw.meta->>'trader_id')::bigint IS DISTINCT FROM v_trader_id THEN
      RAISE EXCEPTION 'subject mismatch';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'copier lane V2 RAW subject coordinates do not match the exact subject'
      USING ERRCODE = '55000';
  END;

  IF pg_catalog.jsonb_typeof(
       v_raw.meta->'attempt_started_at'
     ) IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'copier lane V2 RAW attempt clock is invalid'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    v_attempt_started_at :=
      (v_raw.meta->>'attempt_started_at')::timestamptz;
    IF NOT pg_catalog.isfinite(v_attempt_started_at)
       OR v_raw.meta->>'attempt_started_at' IS DISTINCT FROM
          pg_catalog.to_char(
            v_attempt_started_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
       OR v_attempt_started_at > v_observed_at THEN
      RAISE EXCEPTION 'attempt clock mismatch';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'copier lane V2 RAW attempt clock is outside the full-capture contract'
      USING ERRCODE = '55000';
  END;

  BEGIN
    IF pg_catalog.jsonb_typeof(v_raw.meta->'page_count') IS DISTINCT FROM
         'number'
       OR v_raw.meta->>'page_count' !~ '^[1-9][0-9]*$' THEN
      RAISE EXCEPTION 'invalid page count';
    END IF;
    v_page_count := (v_raw.meta->>'page_count')::integer;
    IF v_page_count <= 0 OR v_page_count > 100000 THEN
      RAISE EXCEPTION 'page count outside bound';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'copier lane V2 RAW has no bounded full-capture page evidence'
      USING ERRCODE = '55000';
  END;

  v_terminal_verifier_contract := v_raw.meta->>'verifier_contract';

  IF pg_catalog.jsonb_typeof(v_raw.meta->'termination') IS DISTINCT FROM
       'object'
     OR pg_catalog.jsonb_typeof(
       v_raw.meta->'termination'->'claim_observations'
     ) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(
       v_raw.meta->'termination'->'claim_observations'
     ) NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'copier lane V2 RAW terminal claim shape is invalid'
      USING ERRCODE = '55000';
  END IF;
  SELECT pg_catalog.array_agg(key_name ORDER BY key_name)
  INTO v_actual_keys
  FROM pg_catalog.jsonb_object_keys(
    v_raw.meta->'termination'
  ) AS key_name;
  IF v_actual_keys IS DISTINCT FROM v_expected_termination_keys
     OR v_raw.meta->'termination'->>'evidence_state' IS DISTINCT FROM
        'verified'
     OR v_raw.meta->'termination'->>'scan_terminal_state' IS DISTINCT FROM
        'exhausted'
     OR v_raw.meta->'termination'->>'verifier_contract' IS DISTINCT FROM
        v_terminal_verifier_contract
     OR v_raw.meta->'termination'->'terminal_cursor_value' IS DISTINCT FROM
        'null'::jsonb
     OR v_raw.meta->'termination'->'overlap_event_at' IS DISTINCT FROM
        'null'::jsonb
     OR v_raw.meta->'termination'->'blocker_reasons' IS DISTINCT FROM
        '[]'::jsonb THEN
    RAISE EXCEPTION 'copier lane V2 RAW terminal proof is not verified exhausted and blocker-free'
      USING ERRCODE = '55000';
  END IF;

  FOR v_observation IN
    SELECT observation
    FROM pg_catalog.jsonb_array_elements(
      v_raw.meta->'termination'->'claim_observations'
    ) AS observation
  LOOP
    IF pg_catalog.jsonb_typeof(v_observation) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'copier lane V2 RAW terminal observation is not an object'
        USING ERRCODE = '55000';
    END IF;
    SELECT pg_catalog.array_agg(key_name ORDER BY key_name)
    INTO v_actual_keys
    FROM pg_catalog.jsonb_object_keys(v_observation) AS key_name;
    IF v_actual_keys IS DISTINCT FROM v_expected_observation_keys
       OR pg_catalog.jsonb_typeof(
         v_observation->'segment_id'
       ) IS DISTINCT FROM 'string'
       OR v_observation->>'segment_id' !~
          '^[a-z0-9][a-z0-9_]{0,63}$'
       OR pg_catalog.jsonb_typeof(
         v_observation->'reason'
       ) IS DISTINCT FROM 'string'
       OR v_observation->>'reason' NOT IN (
         'empty_page',
         'short_page',
         'reported_end',
         'snapshot_complete'
       )
       OR pg_catalog.jsonb_typeof(
         v_observation->'page_ordinal'
       ) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'copier lane V2 RAW terminal observation shape is invalid'
        USING ERRCODE = '55000';
    END IF;
    BEGIN
      v_page_ordinal := (v_observation->>'page_ordinal')::numeric;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'copier lane V2 RAW terminal observation ordinal is invalid'
        USING ERRCODE = '55000';
    END;
    IF v_page_ordinal <> pg_catalog.trunc(v_page_ordinal)
       OR v_page_ordinal < 1
       OR v_page_ordinal > v_page_count
       OR v_page_ordinal <= v_previous_page_ordinal
       OR v_observation->>'segment_id' = ANY(v_seen_terminal_segments) THEN
      RAISE EXCEPTION 'copier lane V2 RAW terminal observation is outside captured pages'
        USING ERRCODE = '55000';
    END IF;
    v_previous_page_ordinal := v_page_ordinal;
    v_seen_terminal_segments := pg_catalog.array_append(
      v_seen_terminal_segments,
      v_observation->>'segment_id'
    );
  END LOOP;

  IF pg_catalog.jsonb_typeof(v_raw.meta->'raw_integrity') IS DISTINCT FROM
       'object' THEN
    RAISE EXCEPTION 'copier lane V2 RAW integrity metadata is invalid'
      USING ERRCODE = '55000';
  END IF;
  SELECT pg_catalog.array_agg(key_name ORDER BY key_name)
  INTO v_actual_keys
  FROM pg_catalog.jsonb_object_keys(
    v_raw.meta->'raw_integrity'
  ) AS key_name;
  IF v_actual_keys IS DISTINCT FROM v_expected_integrity_keys
     OR v_raw.meta->'raw_integrity'->'version' IS DISTINCT FROM '1'::jsonb
     OR v_raw.meta->'raw_integrity'->>'content_type' IS DISTINCT FROM
        'application/json'
     OR v_raw.meta->'raw_integrity'->>'encoding' IS DISTINCT FROM 'utf-8'
     OR v_raw.meta->'raw_integrity'->>'compression' IS DISTINCT FROM 'gzip'
     OR v_raw.meta->'raw_integrity'->>'hash_algorithm' IS DISTINCT FROM
        'sha256'
     OR v_raw.meta->'raw_integrity'->>'hash_scope' IS DISTINCT FROM
        'json_utf8'
     OR v_raw.meta->'raw_integrity'->>'serialization_contract' IS DISTINCT FROM
        'arena.strict-canonical-json@1'
     OR pg_catalog.jsonb_typeof(
       v_raw.meta->'raw_integrity'->'compressed_bytes'
     ) IS DISTINCT FROM 'number'
     OR pg_catalog.jsonb_typeof(
       v_raw.meta->'raw_integrity'->'uncompressed_bytes'
     ) IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'copier lane V2 RAW integrity contract is not exact'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    v_compressed_bytes :=
      (v_raw.meta->'raw_integrity'->>'compressed_bytes')::integer;
    v_uncompressed_bytes :=
      (v_raw.meta->'raw_integrity'->>'uncompressed_bytes')::numeric;
    IF v_compressed_bytes IS DISTINCT FROM v_raw.bytes
       OR v_compressed_bytes <= 0
       OR v_uncompressed_bytes <= 0
       OR v_uncompressed_bytes > 2147483647
       OR v_uncompressed_bytes <> pg_catalog.trunc(v_uncompressed_bytes) THEN
      RAISE EXCEPTION 'integrity byte count mismatch';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'copier lane V2 RAW integrity byte counts are invalid'
      USING ERRCODE = '55000';
  END;

  IF v_existing.publication_id IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'receiptId', v_existing.publication_id,
      'sourceRunId', v_existing.source_run_id,
      'acquisitionSourceRunId', v_existing.acquisition_source_run_id,
      'lane', v_existing.lane,
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
    pnl_distribution,
    acquisition_source_run_id,
    raw_trust_artifact_role_at_publication,
    raw_evidence_contract_at_publication
  ) VALUES (
    v_source_id,
    v_trader_id,
    v_trusted_lane,
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
    'arena.copier-snapshot-publication@2',
    'arena.copier-histogram-k-anonymity@1',
    'arena.ingest.copier-publication-lane-artifact@1',
    'arena.ingest.copier-parser@1',
    'arena.ingest.copier-row-set.postgresql-jsonb@1',
    'arena.ingest.copier-snapshot-publisher@2',
    'verified',
    '[]'::jsonb,
    v_terminal_verifier_contract,
    v_request_sha256,
    v_row_count,
    v_total_copier_pnl,
    v_distribution,
    v_acquisition_source_run_id,
    'copier_snapshot',
    'arena.ingest.copier-publication-lane-raw-evidence@1'
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
      WHEN pg_catalog.jsonb_typeof(item.row_value->'copierInvested') =
           'number'
      THEN (item.row_value->>'copierInvested')::numeric
      ELSE NULL
    END,
    CASE
      WHEN pg_catalog.jsonb_typeof(item.row_value->'copyDurationDays') =
           'number'
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
    RAISE EXCEPTION 'copier lane V2 private row count did not match its receipt'
      USING ERRCODE = '55000';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'receiptId', v_publication_id,
    'sourceRunId', v_source_run_id,
    'acquisitionSourceRunId', v_acquisition_source_run_id,
    'lane', v_trusted_lane,
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

ALTER FUNCTION public.publish_copier_snapshot_v2(jsonb)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.publish_copier_snapshot_v2(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.publish_copier_snapshot_v2(jsonb)
  TO service_role;

COMMENT ON FUNCTION public.publish_copier_snapshot_v2(jsonb) IS
  'Service-only lane-aware authority: validates one exact copier publication wrapper, its immutable RAW and nested acquisition digests, and atomically writes private rows plus a V2 receipt.';

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
  -- arena.copier-snapshot-receipt-reader@3
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
    WHERE publication.evidence_state = 'verified'
      AND publication.scan_terminal_state = 'exhausted'
      AND NOT publication.caller_limited
      AND publication.blocker_reasons = '[]'::pg_catalog.jsonb
      AND publication.terminal_verifier_contract ~
          '^arena\.ingest\.history-terminal-verifier\.[a-z0-9_]+(?:\.[a-z0-9_]+)*\.copiers@[1-9][0-9]*$'
      AND publication.request_sha256 ~ '^[0-9a-f]{64}$'
      AND publication.copier_count IS NOT NULL
      AND publication.copier_count = publication.parsed_row_count
      AND publication.pnl_distribution IS NOT NULL
      AND pg_catalog.jsonb_typeof(publication.pnl_distribution) = 'array'
      AND (
        (
          publication.evidence_contract =
            'arena.copier-snapshot-publication@1'
          AND publication.publisher_contract =
            'arena.ingest.copier-snapshot-publisher@1'
          AND publication.data_contract IN (
            'arena.ingest.copier-snapshot-artifact@1',
            'arena.ingest.history-acquisition-artifact@1'
          )
          AND publication.lane = 'tier_c'
          AND publication.acquisition_source_run_id IS NULL
          AND publication.raw_trust_artifact_role_at_publication IS NULL
          AND publication.raw_evidence_contract_at_publication IS NULL
        )
        OR (
          publication.evidence_contract =
            'arena.copier-snapshot-publication@2'
          AND publication.publisher_contract =
            'arena.ingest.copier-snapshot-publisher@2'
          AND publication.data_contract =
            'arena.ingest.copier-publication-lane-artifact@1'
          AND publication.lane IN ('tier_b', 'tier_c')
          AND publication.acquisition_source_run_id ~ '^[0-9a-f]{64}$'
          AND publication.acquisition_source_run_id <>
              pg_catalog.repeat('0', 64)
          AND publication.acquisition_source_run_id <>
              publication.source_run_id
          AND publication.raw_trust_artifact_role_at_publication =
              'copier_snapshot'
          AND publication.raw_evidence_contract_at_publication =
              'arena.ingest.copier-publication-lane-raw-evidence@1'
        )
      )
      AND (
        publication.live_raw_object_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM arena.raw_objects AS raw_object
          WHERE raw_object.id = publication.live_raw_object_id
            AND NOT raw_object.quarantined
            AND (
              publication.evidence_contract =
                'arena.copier-snapshot-publication@1'
              OR (
                raw_object.source_id = publication.source_id
                AND raw_object.trader_id = publication.trader_id
                AND raw_object.job_type = CASE publication.lane
                  WHEN 'tier_b' THEN 'history:copiers'
                  WHEN 'tier_c' THEN 'tier_c'
                END
                AND raw_object.timeframe IS NULL
                AND raw_object.source_run_id = publication.source_run_id
                AND raw_object.content_hash = publication.raw_content_hash
                AND raw_object.trust_artifact_role =
                    publication.raw_trust_artifact_role_at_publication
                AND raw_object.storage_path = publication.raw_storage_path
                AND raw_object.fetched_at = publication.raw_fetched_at
                AND raw_object.meta->>'source_run_id' =
                    publication.source_run_id
                AND raw_object.meta->>'publication_lane' = publication.lane
                AND raw_object.meta->>'acquisition_source_run_id' =
                    publication.acquisition_source_run_id
                AND raw_object.meta->>'data_contract' =
                    publication.data_contract
                AND raw_object.meta->>'publication_evidence_contract' =
                    publication.raw_evidence_contract_at_publication
              )
            )
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

COMMENT ON FUNCTION public.arena_copier_aggregate(text, text) IS
  'Receipt-first aggregate-only copier reader accepting exact legacy V1 and lane-bound V2 receipts; during the rolling bridge only, no-receipt subjects may use the quarantined profile-only containment fallback.';

DO $postflight$
DECLARE
  v_v1 oid := pg_catalog.to_regprocedure(
    'public.publish_copier_snapshot_v1(jsonb)'
  );
  v_v2 oid := pg_catalog.to_regprocedure(
    'public.publish_copier_snapshot_v2(jsonb)'
  );
  v_reader oid := pg_catalog.to_regprocedure(
    'public.arena_copier_aggregate(text,text)'
  );
  v_raw_binding text;
  v_raw_binding_count integer;
  v_audit_binding text;
  v_audit_binding_count integer;
  v_constraint_state text[];
  v_raw_target constant text :=
    'CHECK (((((source_run_id IS NULL) AND (trust_artifact_role IS NULL)) OR ((source_run_id ~ ''^[0-9a-f]{64}$''::text) AND (trust_artifact_role = ANY (ARRAY[''source_payload''::text, ''population_manifest''::text, ''normalization_components''::text, ''event_history''::text, ''price_history''::text, ''opening_inventory''::text, ''copier_audit''::text, ''copier_snapshot''::text])))) IS TRUE))';
  v_audit_target constant text :=
    'CHECK (((trust_artifact_role IS DISTINCT FROM ''copier_audit''::text) OR ((NOT (jsonb_typeof(meta) IS DISTINCT FROM ''object''::text)) AND (NOT ((meta ->> ''surface''::text) IS DISTINCT FROM ''copiers_audit''::text)) AND (NOT ((meta -> ''publication_eligible''::text) IS DISTINCT FROM ''false''::jsonb)) AND (NOT ((meta ->> ''history_evidence_contract''::text) IS DISTINCT FROM ''arena.ingest.copier-audit-raw-evidence@1''::text)) AND (NOT ((meta ->> ''data_contract''::text) IS DISTINCT FROM ''arena.ingest.history-acquisition-artifact@1''::text)))))';
  v_evidence_target constant text :=
    'CHECK ((evidence_contract = ANY (ARRAY[''arena.copier-snapshot-publication@1''::text, ''arena.copier-snapshot-publication@2''::text])))';
  v_data_target constant text :=
    'CHECK ((data_contract = ANY (ARRAY[''arena.ingest.copier-snapshot-artifact@1''::text, ''arena.ingest.history-acquisition-artifact@1''::text, ''arena.ingest.copier-publication-lane-artifact@1''::text])))';
  v_publisher_target constant text :=
    'CHECK ((publisher_contract = ANY (ARRAY[''arena.ingest.copier-snapshot-publisher@1''::text, ''arena.ingest.copier-snapshot-publisher@2''::text])))';
  v_authority_target constant text :=
    'CHECK (((((evidence_contract = ''arena.copier-snapshot-publication@1''::text) AND (publisher_contract = ''arena.ingest.copier-snapshot-publisher@1''::text) AND (data_contract = ANY (ARRAY[''arena.ingest.copier-snapshot-artifact@1''::text, ''arena.ingest.history-acquisition-artifact@1''::text])) AND (acquisition_source_run_id IS NULL) AND (raw_trust_artifact_role_at_publication IS NULL) AND (raw_evidence_contract_at_publication IS NULL)) OR ((evidence_contract = ''arena.copier-snapshot-publication@2''::text) AND (publisher_contract = ''arena.ingest.copier-snapshot-publisher@2''::text) AND (data_contract = ''arena.ingest.copier-publication-lane-artifact@1''::text) AND (acquisition_source_run_id ~ ''^[0-9a-f]{64}$''::text) AND (acquisition_source_run_id <> repeat(''0''::text, 64)) AND (acquisition_source_run_id <> source_run_id) AND (raw_trust_artifact_role_at_publication = ''copier_snapshot''::text) AND (raw_evidence_contract_at_publication = ''arena.ingest.copier-publication-lane-raw-evidence@1''::text))) IS TRUE))';
BEGIN
  SELECT
    pg_catalog.count(*),
    pg_catalog.min(pg_catalog.pg_get_constraintdef(
      constraint_row.oid, false
    ))
  INTO v_raw_binding_count, v_raw_binding
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'arena.raw_objects'::pg_catalog.regclass
    AND constraint_row.conname = 'raw_objects_metric_trust_binding'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated
    AND NOT constraint_row.condeferrable;

  SELECT
    pg_catalog.count(*),
    pg_catalog.min(pg_catalog.pg_get_constraintdef(
      constraint_row.oid, false
    ))
  INTO v_audit_binding_count, v_audit_binding
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'arena.raw_objects'::pg_catalog.regclass
    AND constraint_row.conname = 'raw_objects_copier_audit_contract'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated
    AND NOT constraint_row.condeferrable;

  SELECT pg_catalog.array_agg(
    constraint_row.conname || E'\n' ||
    pg_catalog.pg_get_constraintdef(constraint_row.oid, false)
    ORDER BY constraint_row.conname, constraint_row.oid
  )
  INTO v_constraint_state
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid =
      'arena.copier_snapshot_publications'::pg_catalog.regclass
    AND constraint_row.conname IN (
      'copier_snapshot_publications_evidence_contract_check',
      'copier_snapshot_publications_data_contract_check',
      'copier_snapshot_publications_publisher_contract_check',
      'copier_snapshot_publication_authority_version'
    )
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated
    AND NOT constraint_row.condeferrable;

  IF v_raw_binding_count IS DISTINCT FROM 1
     OR v_raw_binding IS DISTINCT FROM v_raw_target
     OR v_audit_binding_count IS DISTINCT FROM 1
     OR v_audit_binding IS DISTINCT FROM v_audit_target
     OR v_constraint_state IS DISTINCT FROM ARRAY[
       'copier_snapshot_publication_authority_version' || E'\n' ||
         v_authority_target,
       'copier_snapshot_publications_data_contract_check' || E'\n' ||
         v_data_target,
       'copier_snapshot_publications_evidence_contract_check' || E'\n' ||
         v_evidence_target,
       'copier_snapshot_publications_publisher_contract_check' || E'\n' ||
         v_publisher_target
     ]::text[]
     OR v_v1 IS NULL
     OR v_v2 IS NULL
     OR v_reader IS NULL
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_v1, 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_v2, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('anon', v_v1, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_v2, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', v_v1, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_v2, 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'anon', v_reader, 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'authenticated', v_reader, 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_reader, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'copier lane V2 authority ACL or RAW-binding postflight failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_v2
      AND procedure.proowner = 'postgres'::pg_catalog.regrole
      AND procedure.prosecdef
      AND procedure.provolatile = 'v'
      AND procedure.proconfig IS NOT DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND pg_catalog.strpos(
        procedure.prosrc,
        'arena.copier-snapshot-publication@2'
      ) > 0
      AND pg_catalog.strpos(
        procedure.prosrc,
        'arena.ingest.copier-publication-lane-artifact@1'
      ) > 0
      AND pg_catalog.strpos(
        procedure.prosrc,
        'v_trusted_lane'
      ) > 0
      AND pg_catalog.strpos(
        procedure.prosrc,
        'public.publish_copier_snapshot_v1'
      ) = 0
      AND pg_catalog.strpos(
        procedure.prosrc,
        'current_setting'
      ) = 0
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_reader
      AND procedure.proowner = 'postgres'::pg_catalog.regrole
      AND procedure.prosecdef
      AND procedure.provolatile = 's'
      AND procedure.proconfig IS NOT DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND pg_catalog.strpos(
        procedure.prosrc,
        'arena.copier-snapshot-receipt-reader@3'
      ) > 0
      AND pg_catalog.strpos(
        procedure.prosrc,
        'arena.copier-snapshot-publication@1'
      ) > 0
      AND pg_catalog.strpos(
        procedure.prosrc,
        'arena.copier-snapshot-publication@2'
      ) > 0
      AND pg_catalog.strpos(
        procedure.prosrc,
        'publication.acquisition_source_run_id'
      ) > 0
  ) THEN
    RAISE EXCEPTION 'copier lane V2 publisher or reader postflight failed';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
        'arena.copier_snapshot_publications'::pg_catalog.regclass
      AND attribute.attname IN (
        'acquisition_source_run_id',
        'raw_trust_artifact_role_at_publication',
        'raw_evidence_contract_at_publication'
      )
      AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
      AND NOT attribute.attnotnull
      AND NOT attribute.atthasdef
      AND attribute.attidentity = ''
      AND attribute.attgenerated = ''
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 3
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid =
           'arena.copier_snapshot_publications'::pg_catalog.regclass
         AND constraint_row.conname IN (
           'copier_snapshot_publications_evidence_contract_check',
           'copier_snapshot_publications_data_contract_check',
           'copier_snapshot_publications_publisher_contract_check',
           'copier_snapshot_publication_authority_version'
         )
         AND constraint_row.contype = 'c'
         AND constraint_row.convalidated
         AND NOT constraint_row.condeferrable
     ) <> 4
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid IN (
         'arena.copier_snapshot_publications'::pg_catalog.regclass,
         'arena.copier_snapshot_rows'::pg_catalog.regclass
       )
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         AND trigger_row.tgname IN (
           'copier_snapshot_publication_guard_insert_v1',
           'copier_snapshot_row_normalize_source_event_v1',
           'copier_snapshot_publication_reject_update_delete',
           'copier_snapshot_publication_reject_truncate',
           'copier_snapshot_row_reject_update_delete',
           'copier_snapshot_row_reject_truncate'
         )
     ) <> 6
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(
         ARRAY['anon', 'authenticated', 'service_role']::text[]
       ) AS runtime_role(role_name)
       CROSS JOIN pg_catalog.unnest(
         ARRAY[
           'arena.copier_snapshot_publications',
           'arena.copier_snapshot_rows'
         ]::text[]
       ) AS private_relation(relation_name)
       WHERE pg_catalog.has_table_privilege(
         runtime_role.role_name,
         private_relation.relation_name,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
       )
     ) THEN
    RAISE EXCEPTION 'copier lane V2 schema, trigger, or table privacy postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
