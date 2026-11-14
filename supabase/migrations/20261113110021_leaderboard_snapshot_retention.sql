-- Retention policy for arena.leaderboard_snapshots.
--
-- Snapshots were never deleted (no DELETE anywhere), so the table and the
-- daily-kept entries grow without bound, and any ad-hoc cleanup would trip the
-- RESTRICT edges from tier_a_execution_window_receipts and metric-trust
-- evidence (20261113105605). arena.prune_leaderboard_snapshots deletes, in
-- bounded batches, snapshots older than the retention window together with
-- their entries, and never deletes a snapshot that is still evidence:
--   * the latest count-check-passed snapshot of each (source, timeframe);
--   * a board some sealed public publication was built from — the
--     (filter_source, source_as_of) of any arena.leaderboard_rank_publications
--     proof or current public.leaderboard_source_freshness row equals the
--     snapshot's (source alias, scraped_at);
--   * a snapshot referenced by metric-trust runs/observations or by a Tier-A
--     execution window receipt (those edges are RESTRICT).
-- Owner-only definer; EXECUTE for service_role (the ingest worker's
-- maintenance job calls it). Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.leaderboard_snapshots') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_entries') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_rank_publications') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_source_freshness') IS NULL
     OR pg_catalog.to_regclass('arena.metric_trust_runs') IS NULL
     OR pg_catalog.to_regclass('arena.metric_trust_observations') IS NULL
     OR pg_catalog.to_regclass('arena.tier_a_execution_window_receipts') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION
      'snapshot retention requires snapshots, publications, freshness, trust evidence and Tier-A receipts';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION arena.prune_leaderboard_snapshots(
  p_retention_days integer DEFAULT 180,
  p_limit integer DEFAULT 5000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_deleted_snapshots bigint;
  v_deleted_entries bigint;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 90 OR p_retention_days > 3650 THEN
    RAISE EXCEPTION 'snapshot retention must be between 90 and 3650 days'
      USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50000 THEN
    RAISE EXCEPTION 'snapshot prune batch must be between 1 and 50000'
      USING ERRCODE = '22023';
  END IF;

  WITH sealed_evidence AS MATERIALIZED (
    SELECT DISTINCT proof.value->>'source' AS filter_source,
           (proof.value->>'source_as_of')::timestamptz AS source_as_of
    FROM arena.leaderboard_rank_publications AS publication
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(publication.proofs) AS proof(value)
    WHERE pg_catalog.jsonb_typeof(proof.value->'source_as_of') = 'string'
    UNION
    SELECT freshness.source, freshness.source_as_of
    FROM public.leaderboard_source_freshness AS freshness
  ),
  latest_passed AS MATERIALIZED (
    SELECT DISTINCT ON (snapshot.source_id, snapshot.timeframe) snapshot.id
    FROM arena.leaderboard_snapshots AS snapshot
    WHERE snapshot.count_check_passed
    ORDER BY snapshot.source_id, snapshot.timeframe, snapshot.scraped_at DESC, snapshot.id DESC
  ),
  victims AS MATERIALIZED (
    SELECT snapshot.id, snapshot.scraped_at
    FROM arena.leaderboard_snapshots AS snapshot
    JOIN arena.sources AS source_row ON source_row.id = snapshot.source_id
    WHERE snapshot.scraped_at <
            pg_catalog.statement_timestamp() - pg_catalog.make_interval(days => p_retention_days)
      AND NOT EXISTS (SELECT 1 FROM latest_passed WHERE latest_passed.id = snapshot.id)
      AND NOT EXISTS (
        SELECT 1 FROM sealed_evidence
        WHERE sealed_evidence.source_as_of = snapshot.scraped_at
          AND sealed_evidence.filter_source = COALESCE(
            NULLIF(pg_catalog.btrim(source_row.meta->>'legacy_platform'), ''),
            source_row.slug
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM arena.metric_trust_runs AS run WHERE run.snapshot_id = snapshot.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM arena.metric_trust_observations AS observation
        WHERE observation.snapshot_id = snapshot.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM arena.tier_a_execution_window_receipts AS receipt
        WHERE receipt.snapshot_id = snapshot.id
      )
    ORDER BY snapshot.scraped_at, snapshot.id
    LIMIT p_limit
    FOR UPDATE OF snapshot SKIP LOCKED
  ),
  deleted_entries AS (
    DELETE FROM arena.leaderboard_entries AS entry
    USING victims
    WHERE entry.snapshot_id = victims.id
      AND entry.scraped_at = victims.scraped_at
    RETURNING 1
  ),
  deleted_snapshots AS (
    DELETE FROM arena.leaderboard_snapshots AS snapshot
    USING victims
    WHERE snapshot.id = victims.id
    RETURNING 1
  )
  SELECT (SELECT pg_catalog.count(*) FROM deleted_snapshots),
         (SELECT pg_catalog.count(*) FROM deleted_entries)
  INTO v_deleted_snapshots, v_deleted_entries;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-snapshot-retention@1',
    'retention_days', p_retention_days,
    'deleted_snapshots', v_deleted_snapshots,
    'deleted_entries', v_deleted_entries
  );
END;
$function$;

ALTER FUNCTION arena.prune_leaderboard_snapshots(integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.prune_leaderboard_snapshots(integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION arena.prune_leaderboard_snapshots(integer, integer) TO service_role;

CREATE INDEX IF NOT EXISTS idx_arena_lb_snapshots_retention
  ON arena.leaderboard_snapshots (scraped_at, id);

COMMIT;
