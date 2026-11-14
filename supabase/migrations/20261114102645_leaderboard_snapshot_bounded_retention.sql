-- Bounded retention for arena.leaderboard_snapshots and its evidence.
--
-- 20261113110021 (+ the 20261113110430 pin) never deletes a snapshot that a
-- metric-trust run/observation or a Tier-A execution receipt references, nor
-- any board any sealed publication was ever built from. With attempt-bound
-- capture on, nearly every snapshot has a receipt and trust evidence, and
-- nearly every passed board is sealed at least once, so almost nothing was
-- deletable: the table, its entries and the evidence still grew without bound.
--
-- The evidence chain decides what must stay:
--   public rank -> sealed publication (leaderboard_rank_publications, proofs
--   by (source, source_as_of), permanent) -> publication source evidence
--   (snapshot / RAW / run ids) -> snapshot -> entries, trust runs/observations,
--   Tier-A receipt, RAW object.
-- Everything a CURRENTLY served cohort or a current board depends on is kept
-- forever; historical detail below the permanent seal receipt is kept for the
-- retention window (default 180 days, at least 90) and then retired together,
-- so no surviving row ever points at a deleted one:
--   1. publication source evidence rows older than the window whose cohort is
--      no season's serving head are deleted (the seal receipt itself stays);
--   2. a snapshot older than the window is deleted with its entries, trust
--      runs/observations/artifacts and Tier-A receipt unless it is the latest
--      count-check-passed board of its (source, timeframe), the board a
--      current public.leaderboard_source_freshness row names, or still bound
--      by a remaining publication evidence row.
-- RAW objects referenced by a snapshot are kept by the worker's RAW GC while
-- the snapshot exists (lib/ingest/raw.ts), and retire after it.
--
-- The trust, receipt and evidence tables keep their append-only triggers; the
-- prune disables exactly those four triggers inside its own transaction and
-- re-enables them before returning (ALTER TABLE ... DISABLE TRIGGER is
-- transactional and holds a SHARE ROW EXCLUSIVE lock, so no other session
-- ever observes or writes past a disabled trigger, and the committed trigger
-- catalog the worker readiness check pins is unchanged).
-- Owner-only definer; EXECUTE for service_role (worker maintenance).
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid =
              pg_catalog.to_regprocedure('arena.prune_leaderboard_snapshots(integer,integer)')
          AND pg_catalog.strpos(function_row.prosrc,
                'leaderboard_rank_publication_source_evidence') > 0
     )
     OR pg_catalog.to_regclass('arena.public_ranked_leaderboard_serving_heads') IS NULL
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE NOT trigger_row.tgisinternal
         AND (trigger_row.tgrelid, trigger_row.tgname) IN (
           ('arena.metric_trust_runs'::pg_catalog.regclass,
            'metric_trust_runs_reject_direct_mutation'),
           ('arena.metric_trust_observations'::pg_catalog.regclass,
            'metric_trust_observations_reject_direct_mutation'),
           ('arena.tier_a_execution_window_receipts'::pg_catalog.regclass,
            'tier_a_execution_window_receipts_immutable'),
           ('arena.leaderboard_rank_publication_source_evidence'::pg_catalog.regclass,
            'rank_publication_evidence_immutable')
         )
     ) <> 4 THEN
    RAISE EXCEPTION
      'bounded snapshot retention requires 20261113110430 and the four evidence immutability triggers';
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
  v_cutoff timestamptz;
  v_victims bigint[];
  v_deleted_evidence bigint;
  v_deleted_runs bigint;
  v_deleted_observations bigint;
  v_deleted_receipts bigint;
  v_deleted_entries bigint;
  v_deleted_snapshots bigint;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 90 OR p_retention_days > 3650 THEN
    RAISE EXCEPTION 'snapshot retention must be between 90 and 3650 days'
      USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50000 THEN
    RAISE EXCEPTION 'snapshot prune batch must be between 1 and 50000'
      USING ERRCODE = '22023';
  END IF;
  v_cutoff := pg_catalog.statement_timestamp()
    - pg_catalog.make_interval(days => p_retention_days);

  ALTER TABLE arena.leaderboard_rank_publication_source_evidence
    DISABLE TRIGGER rank_publication_evidence_immutable;
  ALTER TABLE arena.metric_trust_runs
    DISABLE TRIGGER metric_trust_runs_reject_direct_mutation;
  ALTER TABLE arena.metric_trust_observations
    DISABLE TRIGGER metric_trust_observations_reject_direct_mutation;
  ALTER TABLE arena.tier_a_execution_window_receipts
    DISABLE TRIGGER tier_a_execution_window_receipts_immutable;

  -- 1. Historical publication detail past the window (never a serving head).
  DELETE FROM arena.leaderboard_rank_publication_source_evidence AS evidence
  WHERE evidence.recorded_at < v_cutoff
    AND NOT EXISTS (
      SELECT 1 FROM ONLY arena.public_ranked_leaderboard_serving_heads AS head
      WHERE head.score_cohort_id = evidence.score_cohort_id
    );
  GET DIAGNOSTICS v_deleted_evidence = ROW_COUNT;

  -- 2. Snapshots past the window that nothing current depends on.
  WITH latest_passed AS MATERIALIZED (
    SELECT DISTINCT ON (snapshot.source_id, snapshot.timeframe) snapshot.id
    FROM arena.leaderboard_snapshots AS snapshot
    WHERE snapshot.count_check_passed
    ORDER BY snapshot.source_id, snapshot.timeframe, snapshot.scraped_at DESC, snapshot.id DESC
  )
  SELECT pg_catalog.array_agg(victim.id)
  INTO v_victims
  FROM (
    SELECT snapshot.id
    FROM arena.leaderboard_snapshots AS snapshot
    JOIN arena.sources AS source_row ON source_row.id = snapshot.source_id
    WHERE snapshot.scraped_at < v_cutoff
      AND NOT EXISTS (SELECT 1 FROM latest_passed WHERE latest_passed.id = snapshot.id)
      AND NOT EXISTS (
        SELECT 1 FROM public.leaderboard_source_freshness AS freshness
        WHERE freshness.source_as_of = snapshot.scraped_at
          AND freshness.source = COALESCE(
            NULLIF(pg_catalog.btrim(source_row.meta->>'legacy_platform'), ''),
            source_row.slug
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM arena.leaderboard_rank_publication_source_evidence AS evidence
        WHERE evidence.snapshot_ids @> ARRAY[snapshot.id]
      )
    ORDER BY snapshot.scraped_at, snapshot.id
    LIMIT p_limit
    FOR UPDATE OF snapshot SKIP LOCKED
  ) AS victim;
  v_victims := COALESCE(v_victims, ARRAY[]::bigint[]);

  -- Runs cascade to their observations and artifacts.
  DELETE FROM arena.metric_trust_runs AS run WHERE run.snapshot_id = ANY (v_victims);
  GET DIAGNOSTICS v_deleted_runs = ROW_COUNT;
  DELETE FROM arena.metric_trust_observations AS observation
  WHERE observation.snapshot_id = ANY (v_victims);
  GET DIAGNOSTICS v_deleted_observations = ROW_COUNT;
  DELETE FROM arena.tier_a_execution_window_receipts AS receipt
  WHERE receipt.snapshot_id = ANY (v_victims);
  GET DIAGNOSTICS v_deleted_receipts = ROW_COUNT;
  DELETE FROM arena.leaderboard_entries AS entry
  WHERE entry.snapshot_id = ANY (v_victims)
    AND entry.scraped_at < v_cutoff;
  GET DIAGNOSTICS v_deleted_entries = ROW_COUNT;
  DELETE FROM arena.leaderboard_snapshots AS snapshot WHERE snapshot.id = ANY (v_victims);
  GET DIAGNOSTICS v_deleted_snapshots = ROW_COUNT;

  ALTER TABLE arena.leaderboard_rank_publication_source_evidence
    ENABLE TRIGGER rank_publication_evidence_immutable;
  ALTER TABLE arena.metric_trust_runs
    ENABLE TRIGGER metric_trust_runs_reject_direct_mutation;
  ALTER TABLE arena.metric_trust_observations
    ENABLE TRIGGER metric_trust_observations_reject_direct_mutation;
  ALTER TABLE arena.tier_a_execution_window_receipts
    ENABLE TRIGGER tier_a_execution_window_receipts_immutable;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-snapshot-retention@2',
    'retention_days', p_retention_days,
    'deleted_snapshots', v_deleted_snapshots,
    'deleted_entries', v_deleted_entries,
    'deleted_trust_runs', v_deleted_runs,
    'deleted_trust_observations', v_deleted_observations,
    'deleted_receipts', v_deleted_receipts,
    'deleted_publication_evidence', v_deleted_evidence
  );
END;
$function$;

ALTER FUNCTION arena.prune_leaderboard_snapshots(integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.prune_leaderboard_snapshots(integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION arena.prune_leaderboard_snapshots(integer, integer) TO service_role;

-- Lookups for the RAW GC's snapshot pin and the receipt delete (trust runs and
-- observations are already indexed by snapshot_id).
CREATE INDEX IF NOT EXISTS idx_arena_lb_snapshots_raw_object
  ON arena.leaderboard_snapshots (raw_object_id) WHERE raw_object_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_arena_tier_a_receipts_snapshot
  ON arena.tier_a_execution_window_receipts (snapshot_id);

COMMIT;
