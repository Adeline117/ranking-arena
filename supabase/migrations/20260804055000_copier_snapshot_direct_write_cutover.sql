-- Irreversible copier snapshot read/write cutover.
--
-- Run only after the receipt-capable worker is serving the same release and
-- the required receipt coverage gate has passed. Public aggregates become
-- receipt-only and every legacy copier_records insert fails closed.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    '20260804-copier-snapshot-direct-write-cutover',
    0
  )
);

DO $preflight$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR current_user IS DISTINCT FROM 'postgres'
     OR pg_catalog.current_setting(
       'arena.copier_snapshot_direct_write_cutover_attestation',
       true
     ) IS DISTINCT FROM
       'RECEIPT_CAPABLE_TIER_C_FULLY_DEPLOYED_LEGACY_DRAINED_COVERAGE_APPROVED'
     OR pg_catalog.to_regclass(
       'arena.copier_snapshot_publications'
     ) IS NULL
     OR pg_catalog.to_regclass('arena.copier_snapshot_rows') IS NULL
     OR pg_catalog.to_regclass('arena.copier_records') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.publish_copier_snapshot_v1(jsonb)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.arena_copier_aggregate(text,text)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.copier_snapshot_legacy_fallback_enabled()'
     ) IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'copier direct-write cutover requires complete 054000 authority and explicit receipt coverage attestation';
  END IF;
END
$preflight$;

LOCK TABLE ONLY arena.copier_records IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.copier_snapshot_publications IN SHARE MODE;
LOCK TABLE ONLY arena.copier_snapshot_rows IN SHARE MODE;

CREATE OR REPLACE FUNCTION arena.copier_snapshot_legacy_fallback_enabled()
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT false;
$function$;

ALTER FUNCTION arena.copier_snapshot_legacy_fallback_enabled()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.copier_snapshot_legacy_fallback_enabled()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION arena.reject_unbound_copier_record_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'legacy unbound copier_records inserts are retired; use publish_copier_snapshot_v1'
    USING ERRCODE = '55000';
END
$function$;

ALTER FUNCTION arena.reject_unbound_copier_record_insert()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.reject_unbound_copier_record_insert()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS reject_unbound_copier_record_insert
  ON arena.copier_records;
CREATE TRIGGER reject_unbound_copier_record_insert
BEFORE INSERT ON arena.copier_records
FOR EACH ROW EXECUTE FUNCTION arena.reject_unbound_copier_record_insert();

REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON TABLE arena.copier_records
  FROM PUBLIC, anon, authenticated, service_role;

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
  -- arena.copier-snapshot-receipt-reader@2
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
  ), not_applicable AS (
    SELECT pg_catalog.jsonb_build_object(
      'copierCount', NULL,
      'copierCountMax', NULL,
      'totalCopierPnl', NULL,
      'currency', resolved.currency,
      'depth', 'none',
      'asOf', NULL,
      'sourceAsOf', NULL,
      'observedAt', NULL,
      'publishedAt', NULL,
      'pnlDistribution', '[]'::pg_catalog.jsonb,
      'receiptBound', false,
      'receiptId', NULL,
      'sourceRunId', NULL,
      'evidenceState', NULL,
      'scanTerminalState', NULL,
      'blockerReasons', '[]'::pg_catalog.jsonb
    ) AS payload
    FROM resolved
    WHERE resolved.copier_table_depth = 'none'
  )
  SELECT payload FROM receipt_payload
  UNION ALL
  SELECT payload FROM not_applicable
  LIMIT 1;
$function$;

ALTER FUNCTION public.arena_copier_aggregate(text, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arena_copier_aggregate(text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_copier_aggregate(text, text)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.arena_copier_aggregate(text, text) IS
  'Receipt-only aggregate copier reader. Missing, legacy, partial, mismatched-depth, and unverified snapshots fail closed.';
COMMENT ON FUNCTION arena.reject_unbound_copier_record_insert() IS
  'Postdeploy guard that permanently rejects direct legacy copier row insertion.';

DO $postflight$
DECLARE
  v_aggregate oid := pg_catalog.to_regprocedure(
    'public.arena_copier_aggregate(text,text)'
  );
BEGIN
  IF arena.copier_snapshot_legacy_fallback_enabled()
     OR NOT EXISTS (
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
           'arena.copier-snapshot-receipt-reader@2'
         ) > 0
         AND pg_catalog.strpos(
           procedure.prosrc,
           'copier_aggregate_legacy_containment_v1'
         ) = 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid =
           'arena.copier_records'::pg_catalog.regclass
         AND trigger_row.tgname = 'reject_unbound_copier_record_insert'
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.copier_records', 'INSERT,UPDATE,DELETE,TRUNCATE'
     )
     OR pg_catalog.has_table_privilege(
       'anon', 'arena.copier_snapshot_rows', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'arena.copier_snapshot_publications', 'SELECT'
     ) THEN
    RAISE EXCEPTION 'copier snapshot direct-write cutover postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
