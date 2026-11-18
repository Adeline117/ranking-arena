-- Migration: 20261118135918_trust_evidence_retention.sql
-- Created: 2026-11-18T21:59:18Z
-- Description: Bounded, count-first retention for trust-evidenced leaderboard
--   snapshots (entries, metric-trust runs/observations/artifacts).
--
-- Every existing cleanup skips trust evidence: snapshot entry downsampling
-- skips entries with observations, arena.prune_leaderboard_snapshots skips
-- snapshots with runs/observations/receipts/publication evidence, RAW cleanup
-- skips RAW referenced by runs/artifacts, and nothing ever removes
-- arena.metric_trust_runs/observations/artifacts (append-only; since
-- 20261113105605 every parent edge into them is ON DELETE RESTRICT, so no
-- cleanup path exists at all). Evidence therefore grows without bound.
--
-- Approved policy (launch driver, 2026-11-18):
--   KEEP forever
--     * sealed publication rows and their small digests (publications,
--       publication source evidence, plans, manifests, attestations,
--       acquisition attempts/outcomes, Tier-A receipts) - never touched here;
--     * every snapshot referenced by a current publication or a serving head;
--     * per source x timeframe, the latest count-check-passed snapshot and all
--       of its evidence, however old.
--   ELIGIBLE
--     * superseded_success: count_check_passed, a newer passed snapshot of the
--       same source x timeframe exists, scraped more than N (>= 14) days ago,
--       and not referenced by any publication that is current or was sealed
--       within those N days (nor by a generation plan planned within them);
--     * unpublished_failure: NOT count_check_passed, scraped more than M
--       (>= 7) days ago, and never referenced by any publication or plan.
--   Disposition of an eligible snapshot:
--     * runs_only: a passed daily representative (the day's last passed
--       crawl per source x timeframe, same selection as
--       snapshotEntryDownsampleSql) scraped within p_daily_keep_days (180):
--       keeps its row and entries (rank trend), loses runs -> observations ->
--       artifacts;
--     * body_only: bound by an immutable Tier-A window receipt (RESTRICT):
--       keeps its row, loses runs/observations/artifacts and entries;
--     * snapshot: everything, including the row. Publications and plans that
--       still name it are recorded per purge (dangling_*_cohorts). Freed
--   RAW objects are not touched: they become ordinary candidates of the
--   existing cleanupRawObjects -> arena.raw_object_gc_queue path.
--
-- Mechanics
--   * arena.retain_trust_evidence(p_delete, ...) is the only delete path:
--     SECURITY DEFINER, pinned search_path, lock_timeout; refuses delete mode
--     unless arena.trust_evidence_retention_settings.delete_enabled (default
--     false, owner-only) is on and the caller bounded statement_timeout.
--     Default call counts only. Delete mode works off a ROW budget
--     (p_row_cap), not a snapshot count: it resumes purges left in progress,
--     then starts new ones oldest first, deleting observations (artifacts
--     cascade) and entries in chunks, so a snapshot with hundreds of
--     thousands of rows spans several batches. One call is one transaction:
--     a batch commits whole or (timeout, error) rolls back whole, and the
--     next call resumes from the last committed batch. The worker halves the
--     row cap after a timeout, so it never retries the same oversized batch.
--   * arena.reject_direct_metric_trust_mutation() keeps rejecting every
--     direct write, except DELETE of a run committed for purge in
--     arena.trust_evidence_retention_purged_runs, or of one of its
--     observations, by a transaction currently registered in
--     arena.trust_evidence_retention_active_xacts (only retain_trust_evidence
--     writes either table; no role is granted any write).
--   * arena.trust_evidence_retention_purges keeps one audit row per snapshot
--     and disposition (state, counts, run ids, dangling cohorts).
--   This migration grants no table-level write (DELETE included) to any role.
--
-- Generated only; not applied to any environment.

BEGIN;

-- The two plain (non-CONCURRENTLY) index builds below hold a SHARE lock on
-- their table while they run: give up after 5s if writers hold it, and bound
-- the build. If metric_trust_observations is too large for 30min, pre-build
-- the same index names CONCURRENTLY first; IF NOT EXISTS then skips them.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer < 170000 THEN
    RAISE EXCEPTION 'trust evidence retention requires PostgreSQL 17';
  END IF;
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_snapshots') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_entries') IS NULL
     OR pg_catalog.to_regclass('arena.metric_trust_runs') IS NULL
     OR pg_catalog.to_regclass('arena.metric_trust_observations') IS NULL
     OR pg_catalog.to_regclass('arena.metric_trust_artifacts') IS NULL
     OR pg_catalog.to_regclass('arena.tier_a_execution_window_receipts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_rank_publications') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_rank_publication_source_evidence') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_rank_generation_publication_plans') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_rank_generation_publication_plan_sources') IS NULL
     OR pg_catalog.to_regclass('arena.public_ranked_leaderboard_serving_heads') IS NULL
     OR pg_catalog.to_regclass('arena.public_ranked_leaderboard_serving_sources') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_source_freshness') IS NULL
     OR pg_catalog.to_regprocedure('arena.reject_direct_metric_trust_mutation()') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION
      'trust evidence retention requires the snapshot, metric-trust, Tier-A receipt and publication substrates';
  END IF;

  -- The purge relies on these exact delete actions: parent edges RESTRICT
  -- (20261113105605), internal edges CASCADE (20260721120000).
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('arena.metric_trust_runs', 'arena.leaderboard_snapshots', 'r'),
        ('arena.metric_trust_observations', 'arena.leaderboard_snapshots', 'r'),
        ('arena.metric_trust_observations', 'arena.leaderboard_entries', 'r'),
        ('arena.metric_trust_observations', 'arena.metric_trust_runs', 'c'),
        ('arena.metric_trust_artifacts', 'arena.metric_trust_observations', 'c'),
        ('arena.tier_a_execution_window_receipts', 'arena.leaderboard_snapshots', 'r')
      ) AS expected(child, parent, action)
     WHERE NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.contype = 'f'
          AND constraint_row.conparentid = 0
          AND constraint_row.conrelid = expected.child::pg_catalog.regclass
          AND constraint_row.confrelid = expected.parent::pg_catalog.regclass
          AND constraint_row.confdeltype = expected.action::"char"
     )
  ) THEN
    RAISE EXCEPTION 'trust evidence FK delete actions are not the reviewed RESTRICT/CASCADE shape';
  END IF;
END
$preflight$;

-- Run -> observation lookups (chunked purge, cascades) go by source_run_id;
-- the only existing index leads with source_id. Small receipts table:
-- snapshot lookup.
CREATE INDEX IF NOT EXISTS idx_arena_metric_trust_observations_source_run
  ON arena.metric_trust_observations (source_run_id, id);
CREATE INDEX IF NOT EXISTS idx_arena_tier_a_window_receipts_snapshot
  ON arena.tier_a_execution_window_receipts (snapshot_id);

CREATE TABLE IF NOT EXISTS arena.trust_evidence_retention_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  delete_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp()
);
INSERT INTO arena.trust_evidence_retention_settings (singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

-- One audit row per (snapshot, disposition). A purge may span several
-- batches (each batch is one atomic transaction); state says where it is.
CREATE TABLE IF NOT EXISTS arena.trust_evidence_retention_purges (
  snapshot_id bigint NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('snapshot', 'body_only', 'runs_only')),
  reason text NOT NULL CHECK (reason IN ('superseded_success', 'unpublished_failure')),
  state text NOT NULL CHECK (state IN ('in_progress', 'complete')),
  source_id smallint NOT NULL,
  timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL,
  count_check_passed boolean NOT NULL,
  raw_object_id bigint,
  source_run_ids text[] NOT NULL,
  -- Publications / generation plans whose snapshot_ids keep naming this
  -- snapshot after its row is gone (disposition snapshot). Kept on purpose.
  dangling_publication_cohorts uuid[] NOT NULL DEFAULT '{}',
  dangling_plan_cohorts uuid[] NOT NULL DEFAULT '{}',
  deleted_entries bigint NOT NULL DEFAULT 0 CHECK (deleted_entries >= 0),
  deleted_observations bigint NOT NULL DEFAULT 0 CHECK (deleted_observations >= 0),
  deleted_artifacts bigint NOT NULL DEFAULT 0 CHECK (deleted_artifacts >= 0),
  deleted_runs bigint NOT NULL DEFAULT 0 CHECK (deleted_runs >= 0),
  deleted_snapshot_rows bigint NOT NULL DEFAULT 0 CHECK (deleted_snapshot_rows IN (0, 1)),
  started_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (snapshot_id, disposition),
  CHECK ((state = 'complete') = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trust_evidence_retention_one_in_progress
  ON arena.trust_evidence_retention_purges (snapshot_id)
  WHERE state = 'in_progress';

-- Runs committed for purge. Deleting such a run (or one of its observations)
-- is allowed only inside a transaction registered in ..._active_xacts.
CREATE TABLE IF NOT EXISTS arena.trust_evidence_retention_purged_runs (
  source_run_id text PRIMARY KEY,
  snapshot_id bigint NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_trust_evidence_retention_purged_runs_snapshot
  ON arena.trust_evidence_retention_purged_runs (snapshot_id);

CREATE TABLE IF NOT EXISTS arena.trust_evidence_retention_active_xacts (
  xact pg_catalog.xid8 PRIMARY KEY
);

COMMENT ON TABLE arena.trust_evidence_retention_settings IS
  'Trust evidence retention delete switch (default off; owner-only production action).';
COMMENT ON TABLE arena.trust_evidence_retention_purges IS
  'Audit of trust evidence purges by arena.retain_trust_evidence, one row per snapshot and disposition.';
COMMENT ON TABLE arena.trust_evidence_retention_purged_runs IS
  'Metric-trust runs committed for purge by arena.retain_trust_evidence.';
COMMENT ON TABLE arena.trust_evidence_retention_active_xacts IS
  'Transactions currently inside arena.retain_trust_evidence (row exists only for the life of that transaction).';

CREATE OR REPLACE FUNCTION arena.metric_trust_run_purge_authorized(p_source_run_id text)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT EXISTS (
           SELECT 1 FROM arena.trust_evidence_retention_active_xacts AS active
            WHERE active.xact = pg_catalog.pg_current_xact_id()
         )
     AND EXISTS (
           SELECT 1 FROM arena.trust_evidence_retention_purged_runs AS purged
            WHERE purged.source_run_id = p_source_run_id
         )
$function$;

-- Same contract as 20260721120000 plus one exception: inside
-- arena.retain_trust_evidence, DELETE of a run committed for purge or of one
-- of its observations (artifacts follow by cascade, as before).
CREATE OR REPLACE FUNCTION arena.reject_direct_metric_trust_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE'
     AND TG_LEVEL = 'ROW'
     AND TG_TABLE_SCHEMA = 'arena'
     AND TG_TABLE_NAME IN ('metric_trust_runs', 'metric_trust_observations') THEN
    IF arena.metric_trust_run_purge_authorized(OLD.source_run_id) THEN
      RETURN OLD;
    END IF;
  END IF;

  IF TG_OP = 'TRUNCATE' OR pg_catalog.pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'metric trust records are append-only; insert a new run instead';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;

-- Eligible snapshots in purge order (oldest first), with their disposition.
-- Read-only; shared by count and delete mode.
CREATE OR REPLACE FUNCTION arena.trust_evidence_retention_candidates(
  p_superseded_days integer,
  p_failed_days integer,
  p_daily_keep_days integer,
  p_limit integer
)
RETURNS TABLE (
  snapshot_id bigint,
  scraped_at timestamptz,
  reason text,
  disposition text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH bounds AS (
    SELECT pg_catalog.statement_timestamp() - pg_catalog.make_interval(days => p_superseded_days)
             AS success_cutoff,
           pg_catalog.statement_timestamp() - pg_catalog.make_interval(days => p_failed_days)
             AS failed_cutoff,
           pg_catalog.statement_timestamp() - pg_catalog.make_interval(days => p_daily_keep_days)
             AS daily_cutoff
  ),
  pinned_cohort AS MATERIALIZED (
    SELECT publication.id
      FROM arena.leaderboard_rank_publications AS publication, bounds
     WHERE publication.published_at >= bounds.success_cutoff
    UNION
    SELECT head.score_cohort_id FROM arena.public_ranked_leaderboard_serving_heads AS head
    UNION
    SELECT witness.score_cohort_id FROM arena.public_ranked_leaderboard_serving_sources AS witness
    UNION
    SELECT freshness.score_cohort_id
      FROM public.leaderboard_source_freshness AS freshness
     WHERE freshness.score_cohort_id IS NOT NULL
  ),
  id_pin AS MATERIALIZED (
    SELECT bound.snapshot_id,
           evidence.score_cohort_id IN (SELECT pinned_cohort.id FROM pinned_cohort) AS current_pin
      FROM arena.leaderboard_rank_publication_source_evidence AS evidence
     CROSS JOIN LATERAL pg_catalog.unnest(evidence.snapshot_ids) AS bound(snapshot_id)
    UNION ALL
    SELECT (bound.value)::bigint,
           plan_source.score_cohort_id IN (SELECT pinned_cohort.id FROM pinned_cohort)
             OR plan.planned_at >= bounds.success_cutoff
      FROM arena.leaderboard_rank_generation_publication_plan_sources AS plan_source
      JOIN arena.leaderboard_rank_generation_publication_plans AS plan
        ON plan.season_id = plan_source.season_id
       AND plan.generation_seq = plan_source.generation_seq
     CROSS JOIN bounds
     CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(plan_source.snapshot_ids) AS bound(value)
  ),
  board_pin AS MATERIALIZED (
    SELECT proof.value->>'source' AS source,
           (proof.value->>'source_as_of')::timestamptz AS source_as_of,
           publication.id IN (SELECT pinned_cohort.id FROM pinned_cohort) AS current_pin
      FROM arena.leaderboard_rank_publications AS publication
     CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(publication.proofs) AS proof(value)
     WHERE pg_catalog.jsonb_typeof(proof.value->'source_as_of') = 'string'
    UNION ALL
    SELECT witness.source, witness.source_as_of, true
      FROM arena.public_ranked_leaderboard_serving_sources AS witness
    UNION ALL
    SELECT freshness.source, freshness.source_as_of, true
      FROM public.leaderboard_source_freshness AS freshness
  ),
  latest_passed AS MATERIALIZED (
    SELECT DISTINCT ON (snapshot.source_id, snapshot.timeframe) snapshot.id
      FROM arena.leaderboard_snapshots AS snapshot
     WHERE snapshot.count_check_passed
     ORDER BY snapshot.source_id, snapshot.timeframe, snapshot.scraped_at DESC, snapshot.id DESC
  ),
  -- Same selection as lib/ingest/serving/series.ts snapshotEntryDownsampleSql
  -- (the day's last passed crawl per source x timeframe; id breaks ties).
  daily_representative AS MATERIALIZED (
    SELECT DISTINCT ON (snapshot.source_id, snapshot.timeframe, snapshot.scraped_at::date) snapshot.id
      FROM arena.leaderboard_snapshots AS snapshot
     WHERE snapshot.count_check_passed
     ORDER BY snapshot.source_id, snapshot.timeframe, snapshot.scraped_at::date,
              snapshot.scraped_at DESC, snapshot.id DESC
  ),
  eligible AS MATERIALIZED (
    SELECT snapshot.id,
           snapshot.scraped_at,
           CASE WHEN snapshot.count_check_passed THEN 'superseded_success'
                ELSE 'unpublished_failure' END AS reason,
           CASE
             WHEN snapshot.count_check_passed
                  AND snapshot.scraped_at >= bounds.daily_cutoff
                  AND EXISTS (
                    SELECT 1 FROM daily_representative WHERE daily_representative.id = snapshot.id
                  )
               THEN 'runs_only'
             WHEN EXISTS (
                    SELECT 1 FROM arena.tier_a_execution_window_receipts AS receipt
                     WHERE receipt.snapshot_id = snapshot.id
                  )
               THEN 'body_only'
             ELSE 'snapshot'
           END AS disposition
      FROM arena.leaderboard_snapshots AS snapshot
      JOIN arena.sources AS source_row ON source_row.id = snapshot.source_id
     CROSS JOIN bounds
     CROSS JOIN LATERAL (
       SELECT COALESCE(
                NULLIF(pg_catalog.btrim(source_row.meta->>'legacy_platform'), ''),
                source_row.slug
              ) AS alias
     ) AS source_alias
     WHERE (
             snapshot.count_check_passed
             AND snapshot.scraped_at < bounds.success_cutoff
             AND NOT EXISTS (SELECT 1 FROM latest_passed WHERE latest_passed.id = snapshot.id)
             AND EXISTS (
               SELECT 1
                 FROM arena.leaderboard_snapshots AS newer
                WHERE newer.source_id = snapshot.source_id
                  AND newer.timeframe = snapshot.timeframe
                  AND newer.count_check_passed
                  AND (newer.scraped_at, newer.id) > (snapshot.scraped_at, snapshot.id)
             )
             AND NOT EXISTS (
               SELECT 1 FROM id_pin
                WHERE id_pin.snapshot_id = snapshot.id AND id_pin.current_pin
             )
             AND NOT EXISTS (
               SELECT 1 FROM board_pin
                WHERE board_pin.current_pin
                  AND board_pin.source = source_alias.alias
                  AND board_pin.source_as_of = snapshot.scraped_at
             )
           )
        OR (
             NOT snapshot.count_check_passed
             AND snapshot.scraped_at < bounds.failed_cutoff
             AND NOT EXISTS (SELECT 1 FROM id_pin WHERE id_pin.snapshot_id = snapshot.id)
             AND NOT EXISTS (
               SELECT 1 FROM board_pin
                WHERE board_pin.source = source_alias.alias
                  AND board_pin.source_as_of = snapshot.scraped_at
             )
           )
  )
  SELECT eligible.id, eligible.scraped_at, eligible.reason, eligible.disposition
    FROM eligible
   WHERE NOT EXISTS (
           SELECT 1 FROM arena.trust_evidence_retention_purges AS purge
            WHERE purge.snapshot_id = eligible.id AND purge.state = 'in_progress'
         )
     -- Something left for this disposition (keeps repeated runs idempotent).
     AND (
           EXISTS (
             SELECT 1 FROM arena.metric_trust_runs AS run WHERE run.snapshot_id = eligible.id
           )
           OR EXISTS (
             SELECT 1 FROM arena.metric_trust_observations AS observation
              WHERE observation.snapshot_id = eligible.id
           )
           OR (
             eligible.disposition <> 'runs_only'
             AND EXISTS (
               SELECT 1 FROM arena.leaderboard_entries AS entry
                WHERE entry.snapshot_id = eligible.id AND entry.scraped_at = eligible.scraped_at
             )
           )
           OR eligible.disposition = 'snapshot'
         )
   ORDER BY eligible.scraped_at, eligible.id
   LIMIT p_limit
$function$;

-- Remaining rows a purge of this snapshot/disposition still has to delete.
CREATE OR REPLACE FUNCTION arena.trust_evidence_retention_remaining(
  p_snapshot_id bigint,
  p_disposition text
)
RETURNS TABLE (
  observations bigint,
  artifacts bigint,
  runs bigint,
  entries bigint,
  snapshot_rows bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    (SELECT pg_catalog.count(*) FROM arena.metric_trust_observations AS observation
      WHERE observation.snapshot_id = p_snapshot_id),
    (SELECT pg_catalog.count(*)
       FROM arena.metric_trust_artifacts AS artifact
       JOIN arena.metric_trust_observations AS observation
         ON observation.id = artifact.observation_id
      WHERE observation.snapshot_id = p_snapshot_id),
    (SELECT pg_catalog.count(*) FROM arena.metric_trust_runs AS run
      WHERE run.snapshot_id = p_snapshot_id),
    CASE WHEN p_disposition = 'runs_only' THEN 0::bigint ELSE (
      SELECT pg_catalog.count(*)
        FROM arena.leaderboard_entries AS entry
        JOIN arena.leaderboard_snapshots AS snapshot ON snapshot.id = p_snapshot_id
       WHERE entry.snapshot_id = p_snapshot_id AND entry.scraped_at = snapshot.scraped_at
    ) END,
    CASE WHEN p_disposition = 'snapshot' THEN (
      SELECT pg_catalog.count(*) FROM arena.leaderboard_snapshots AS snapshot
       WHERE snapshot.id = p_snapshot_id
    ) ELSE 0::bigint END
$function$;

-- One bounded step of one registered purge, inside retain_trust_evidence's
-- transaction. Order: observations (artifacts cascade) in chunks -> runs ->
-- entries in chunks (snapshot/body_only) -> header (snapshot). Returns rows
-- used from the budget and whether the purge completed.
CREATE OR REPLACE FUNCTION arena.trust_evidence_retention_step(
  p_snapshot_id bigint,
  p_disposition text,
  p_budget bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_used bigint := 0;
  v_scraped_at timestamptz;
  v_observation_ids bigint[];
  v_artifacts bigint := 0;
  v_count bigint;
  v_observations_deleted bigint := 0;
  v_runs_deleted bigint := 0;
  v_entries_deleted bigint := 0;
  v_header_deleted bigint := 0;
  v_complete boolean := false;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM arena.trust_evidence_retention_active_xacts AS active
     WHERE active.xact = pg_catalog.pg_current_xact_id()
  ) THEN
    RAISE EXCEPTION 'trust evidence purge steps run only inside arena.retain_trust_evidence'
      USING ERRCODE = '42501';
  END IF;

  SELECT snapshot.scraped_at INTO v_scraped_at
    FROM arena.leaderboard_snapshots AS snapshot
   WHERE snapshot.id = p_snapshot_id
     FOR UPDATE;

  -- 1. Observations of the runs committed for purge, oldest id first, as many
  --    as fit the budget together with their artifacts (always at least one).
  SELECT pg_catalog.array_agg(sized.id ORDER BY sized.id),
         COALESCE(pg_catalog.sum(sized.artifacts), 0)
    INTO v_observation_ids, v_artifacts
    FROM (
      SELECT chunk.id, chunk.artifacts,
             pg_catalog.sum(1 + chunk.artifacts) OVER (ORDER BY chunk.id) AS through,
             pg_catalog.row_number() OVER (ORDER BY chunk.id) AS ordinal
        FROM (
          SELECT observation.id,
                 (SELECT pg_catalog.count(*) FROM arena.metric_trust_artifacts AS artifact
                   WHERE artifact.observation_id = observation.id) AS artifacts
            FROM arena.trust_evidence_retention_purged_runs AS purged
            JOIN arena.metric_trust_observations AS observation
              ON observation.source_run_id = purged.source_run_id
           WHERE purged.snapshot_id = p_snapshot_id
           ORDER BY observation.id
           LIMIT GREATEST(p_budget, 1)
        ) AS chunk
    ) AS sized
   WHERE sized.ordinal = 1 OR sized.through <= p_budget;

  IF v_observation_ids IS NOT NULL THEN
    DELETE FROM arena.metric_trust_observations AS observation
     WHERE observation.id = ANY (v_observation_ids);
    GET DIAGNOSTICS v_observations_deleted = ROW_COUNT;
    IF v_observations_deleted <> pg_catalog.cardinality(v_observation_ids) THEN
      RAISE EXCEPTION 'expected % observations, deleted %',
        pg_catalog.cardinality(v_observation_ids), v_observations_deleted
        USING ERRCODE = '55000';
    END IF;
    v_used := v_used + v_observations_deleted + v_artifacts;
  END IF;

  -- 2. Runs, once none of their observations remain.
  IF v_used < p_budget AND NOT EXISTS (
       SELECT 1
         FROM arena.trust_evidence_retention_purged_runs AS purged
         JOIN arena.metric_trust_observations AS observation
           ON observation.source_run_id = purged.source_run_id
        WHERE purged.snapshot_id = p_snapshot_id
     ) THEN
    DELETE FROM arena.metric_trust_runs AS run
     USING arena.trust_evidence_retention_purged_runs AS purged
     WHERE purged.snapshot_id = p_snapshot_id
       AND run.source_run_id = purged.source_run_id;
    GET DIAGNOSTICS v_runs_deleted = ROW_COUNT;
    v_used := v_used + v_runs_deleted;
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM arena.metric_trust_runs AS run WHERE run.snapshot_id = p_snapshot_id
     ) AND NOT EXISTS (
       SELECT 1 FROM arena.metric_trust_observations AS observation
        WHERE observation.snapshot_id = p_snapshot_id
     ) THEN
    IF p_disposition = 'runs_only' THEN
      v_complete := true;
    ELSE
      -- 3. Entries in chunks.
      IF v_used < p_budget THEN
        DELETE FROM arena.leaderboard_entries AS entry
         WHERE (entry.scraped_at, entry.snapshot_id, entry.trader_id) IN (
           SELECT candidate.scraped_at, candidate.snapshot_id, candidate.trader_id
             FROM arena.leaderboard_entries AS candidate
            WHERE candidate.snapshot_id = p_snapshot_id
              AND candidate.scraped_at = v_scraped_at
            ORDER BY candidate.trader_id
            LIMIT GREATEST(p_budget - v_used, 1)
         );
        GET DIAGNOSTICS v_entries_deleted = ROW_COUNT;
        v_used := v_used + v_entries_deleted;
      END IF;
      IF NOT EXISTS (
           SELECT 1 FROM arena.leaderboard_entries AS entry
            WHERE entry.snapshot_id = p_snapshot_id AND entry.scraped_at = v_scraped_at
         ) THEN
        IF p_disposition = 'snapshot' THEN
          -- 4. The header.
          IF v_used < p_budget THEN
            DELETE FROM arena.leaderboard_snapshots AS snapshot WHERE snapshot.id = p_snapshot_id;
            GET DIAGNOSTICS v_header_deleted = ROW_COUNT;
            IF v_header_deleted <> 1 THEN
              RAISE EXCEPTION 'snapshot % vanished during its purge', p_snapshot_id
                USING ERRCODE = '55000';
            END IF;
            v_used := v_used + 1;
            v_complete := true;
          END IF;
        ELSE
          v_complete := true;
        END IF;
      END IF;
    END IF;
  END IF;

  UPDATE arena.trust_evidence_retention_purges AS purge
     SET deleted_observations = purge.deleted_observations + v_observations_deleted,
         deleted_artifacts = purge.deleted_artifacts + v_artifacts,
         deleted_runs = purge.deleted_runs + v_runs_deleted,
         deleted_entries = purge.deleted_entries + v_entries_deleted,
         deleted_snapshot_rows = purge.deleted_snapshot_rows + v_header_deleted,
         state = CASE WHEN v_complete THEN 'complete' ELSE 'in_progress' END,
         completed_at = CASE WHEN v_complete THEN pg_catalog.statement_timestamp() END
   WHERE purge.snapshot_id = p_snapshot_id
     AND purge.disposition = p_disposition
     AND purge.state = 'in_progress';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'purge of snapshot % (%) is not in progress', p_snapshot_id, p_disposition
      USING ERRCODE = '55000';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'used', v_used,
    'complete', v_complete,
    'metric_trust_observations', v_observations_deleted,
    'metric_trust_artifacts', v_artifacts,
    'metric_trust_runs', v_runs_deleted,
    'leaderboard_entries', v_entries_deleted,
    'snapshot_rows', v_header_deleted
  );
END;
$function$;

-- The only entry point. Count-only by default. In delete mode it works off a
-- row budget (p_row_cap): first resumes purges left in progress, then starts
-- new ones oldest first, splitting a large snapshot across batches. Each call
-- is one transaction; a timeout rolls the whole batch back and the next call
-- (with a smaller p_row_cap) resumes from the last committed batch.
CREATE OR REPLACE FUNCTION arena.retain_trust_evidence(
  p_delete boolean DEFAULT false,
  p_row_cap integer DEFAULT 100000,
  p_superseded_days integer DEFAULT 14,
  p_failed_days integer DEFAULT 7,
  p_daily_keep_days integer DEFAULT 180
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  c_candidate_scan constant integer := 200;
  v_budget bigint;
  v_step jsonb;
  v_item record;
  v_remaining record;
  v_totals jsonb;
  v_eligible jsonb;
  v_scope jsonb := '[]'::jsonb;
  v_scope_rows bigint := 0;
  v_deleted jsonb := pg_catalog.jsonb_build_object(
    'metric_trust_observations', 0, 'metric_trust_artifacts', 0, 'metric_trust_runs', 0,
    'leaderboard_entries', 0, 'snapshot_rows', 0
  );
  v_started integer := 0;
  v_completed integer := 0;
  v_touched bigint[] := '{}';
  v_run_ids text[];
BEGIN
  IF p_delete IS NULL THEN
    RAISE EXCEPTION 'retention mode must be explicit' USING ERRCODE = '22023';
  END IF;
  IF p_row_cap IS NULL OR p_row_cap < 1000 OR p_row_cap > 2000000 THEN
    RAISE EXCEPTION 'row cap must be between 1000 and 2000000' USING ERRCODE = '22023';
  END IF;
  IF p_superseded_days IS NULL OR p_superseded_days < 14 OR p_superseded_days > 3650 THEN
    RAISE EXCEPTION 'superseded snapshot retention must be between 14 and 3650 days'
      USING ERRCODE = '22023';
  END IF;
  IF p_failed_days IS NULL OR p_failed_days < 7 OR p_failed_days > 3650 THEN
    RAISE EXCEPTION 'failed snapshot retention must be between 7 and 3650 days'
      USING ERRCODE = '22023';
  END IF;
  IF p_daily_keep_days IS NULL OR p_daily_keep_days < p_superseded_days
     OR p_daily_keep_days > 3650 THEN
    RAISE EXCEPTION 'daily representative retention must be between the superseded window and 3650 days'
      USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.current_setting('statement_timeout') IN ('0', '0ms') THEN
    RAISE EXCEPTION 'trust evidence retention requires a bounded statement_timeout'
      USING ERRCODE = '55000';
  END IF;

  SELECT pg_catalog.jsonb_build_object(
           'eligible_snapshots_total', pg_catalog.count(*),
           'eligible_superseded_success', pg_catalog.count(*) FILTER (WHERE candidate.reason = 'superseded_success'),
           'eligible_unpublished_failure', pg_catalog.count(*) FILTER (WHERE candidate.reason = 'unpublished_failure'),
           'eligible_disposition_snapshot', pg_catalog.count(*) FILTER (WHERE candidate.disposition = 'snapshot'),
           'eligible_disposition_body_only', pg_catalog.count(*) FILTER (WHERE candidate.disposition = 'body_only'),
           'eligible_disposition_runs_only', pg_catalog.count(*) FILTER (WHERE candidate.disposition = 'runs_only'),
           'in_progress_purges', (
             SELECT pg_catalog.count(*) FROM arena.trust_evidence_retention_purges AS purge
              WHERE purge.state = 'in_progress'
           )
         )
    INTO v_eligible
    FROM arena.trust_evidence_retention_candidates(
           p_superseded_days, p_failed_days, p_daily_keep_days, 2147483647
         ) AS candidate;

  IF NOT p_delete THEN
    -- Count mode: the snapshots the next delete batch would work on, with
    -- every row they still hold, until the row cap is covered.
    FOR v_item IN
      SELECT purge.snapshot_id, purge.disposition, purge.reason, 0 AS phase, purge.started_at AS sort_at
        FROM arena.trust_evidence_retention_purges AS purge
       WHERE purge.state = 'in_progress'
      UNION ALL
      SELECT candidate.snapshot_id, candidate.disposition, candidate.reason, 1, candidate.scraped_at
        FROM arena.trust_evidence_retention_candidates(
               p_superseded_days, p_failed_days, p_daily_keep_days, c_candidate_scan
             ) AS candidate
      ORDER BY 4, 5, 1
    LOOP
      EXIT WHEN v_scope_rows >= p_row_cap;
      SELECT * INTO v_remaining
        FROM arena.trust_evidence_retention_remaining(v_item.snapshot_id, v_item.disposition);
      v_scope := v_scope || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'snapshot_id', v_item.snapshot_id,
        'reason', v_item.reason,
        'disposition', v_item.disposition,
        'in_progress', v_item.phase = 0,
        'metric_trust_observations', v_remaining.observations,
        'metric_trust_artifacts', v_remaining.artifacts,
        'metric_trust_runs', v_remaining.runs,
        'leaderboard_entries', v_remaining.entries,
        'snapshot_rows', v_remaining.snapshot_rows
      ));
      v_scope_rows := v_scope_rows + v_remaining.observations + v_remaining.artifacts
        + v_remaining.runs + v_remaining.entries + v_remaining.snapshot_rows;
    END LOOP;

    RETURN pg_catalog.jsonb_build_object(
      'contract', 'arena.trust-evidence-retention@2',
      'mode', 'count',
      'row_cap', p_row_cap,
      'superseded_days', p_superseded_days,
      'failed_days', p_failed_days,
      'daily_keep_days', p_daily_keep_days
    ) || v_eligible || pg_catalog.jsonb_build_object(
      'would_delete', pg_catalog.jsonb_build_object(
        'rows_in_scope', v_scope_rows,
        'rows_next_batch', LEAST(v_scope_rows, p_row_cap::bigint),
        'snapshots_in_scope', pg_catalog.jsonb_array_length(v_scope),
        'metric_trust_observations', COALESCE((SELECT pg_catalog.sum((item->>'metric_trust_observations')::bigint) FROM pg_catalog.jsonb_array_elements(v_scope) AS item), 0),
        'metric_trust_artifacts', COALESCE((SELECT pg_catalog.sum((item->>'metric_trust_artifacts')::bigint) FROM pg_catalog.jsonb_array_elements(v_scope) AS item), 0),
        'metric_trust_runs', COALESCE((SELECT pg_catalog.sum((item->>'metric_trust_runs')::bigint) FROM pg_catalog.jsonb_array_elements(v_scope) AS item), 0),
        'leaderboard_entries', COALESCE((SELECT pg_catalog.sum((item->>'leaderboard_entries')::bigint) FROM pg_catalog.jsonb_array_elements(v_scope) AS item), 0),
        'snapshot_rows', COALESCE((SELECT pg_catalog.sum((item->>'snapshot_rows')::bigint) FROM pg_catalog.jsonb_array_elements(v_scope) AS item), 0),
        'snapshots', v_scope
      ),
      'deleted', NULL
    );
  END IF;

  -- ── Delete mode ──
  IF NOT COALESCE(
       (SELECT settings.delete_enabled
          FROM arena.trust_evidence_retention_settings AS settings
         WHERE settings.singleton),
       false
     ) THEN
    RAISE EXCEPTION 'trust evidence retention delete switch is off' USING ERRCODE = '55000';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
       pg_catalog.hashtextextended('arena.retain_trust_evidence', 0)
     ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'contract', 'arena.trust-evidence-retention@2',
      'mode', 'delete',
      'skipped', 'concurrent_purge'
    );
  END IF;

  INSERT INTO arena.trust_evidence_retention_active_xacts (xact)
  VALUES (pg_catalog.pg_current_xact_id());
  v_budget := p_row_cap;

  FOR v_item IN
    SELECT purge.snapshot_id, purge.disposition, purge.reason, 0 AS phase, purge.started_at AS sort_at
      FROM arena.trust_evidence_retention_purges AS purge
     WHERE purge.state = 'in_progress'
    UNION ALL
    SELECT candidate.snapshot_id, candidate.disposition, candidate.reason, 1, candidate.scraped_at
      FROM arena.trust_evidence_retention_candidates(
             p_superseded_days, p_failed_days, p_daily_keep_days, c_candidate_scan
           ) AS candidate
    ORDER BY 4, 5, 1
  LOOP
    EXIT WHEN v_budget <= 0;

    IF v_item.phase = 1 THEN
      -- Register a new purge: lock the snapshot, refuse cross-bound runs,
      -- commit its runs for purge and open the audit row.
      PERFORM 1 FROM arena.leaderboard_snapshots AS snapshot
        WHERE snapshot.id = v_item.snapshot_id FOR UPDATE;
      SELECT COALESCE(pg_catalog.array_agg(run.source_run_id ORDER BY run.source_run_id), '{}')
        INTO v_run_ids
        FROM arena.metric_trust_runs AS run
       WHERE run.snapshot_id = v_item.snapshot_id;
      IF EXISTS (
           SELECT 1 FROM arena.metric_trust_observations AS observation
            WHERE observation.snapshot_id = v_item.snapshot_id
              AND NOT (observation.source_run_id = ANY (v_run_ids))
         ) OR EXISTS (
           SELECT 1 FROM arena.metric_trust_observations AS observation
            WHERE observation.source_run_id = ANY (v_run_ids)
              AND observation.snapshot_id <> v_item.snapshot_id
         ) THEN
        RAISE EXCEPTION 'snapshot % shares metric-trust runs with another snapshot', v_item.snapshot_id
          USING ERRCODE = '55000';
      END IF;
      INSERT INTO arena.trust_evidence_retention_purged_runs (source_run_id, snapshot_id)
      SELECT run_id, v_item.snapshot_id FROM pg_catalog.unnest(v_run_ids) AS run_id;
      INSERT INTO arena.trust_evidence_retention_purges (
        snapshot_id, disposition, reason, state, source_id, timeframe, scraped_at,
        count_check_passed, raw_object_id, source_run_ids,
        dangling_publication_cohorts, dangling_plan_cohorts
      )
      SELECT snapshot.id, v_item.disposition, v_item.reason, 'in_progress', snapshot.source_id,
             snapshot.timeframe, snapshot.scraped_at, snapshot.count_check_passed,
             snapshot.raw_object_id, v_run_ids,
             CASE WHEN v_item.disposition = 'snapshot' THEN COALESCE((
               SELECT pg_catalog.array_agg(DISTINCT evidence.score_cohort_id)
                 FROM arena.leaderboard_rank_publication_source_evidence AS evidence
                WHERE evidence.snapshot_ids @> ARRAY[snapshot.id]
             ), '{}') ELSE '{}' END,
             CASE WHEN v_item.disposition = 'snapshot' THEN COALESCE((
               SELECT pg_catalog.array_agg(DISTINCT plan_source.score_cohort_id)
                 FROM arena.leaderboard_rank_generation_publication_plan_sources AS plan_source
                WHERE EXISTS (
                  SELECT 1 FROM pg_catalog.jsonb_array_elements_text(plan_source.snapshot_ids) AS bound(value)
                   WHERE bound.value = snapshot.id::text
                )
             ), '{}') ELSE '{}' END
        FROM arena.leaderboard_snapshots AS snapshot
       WHERE snapshot.id = v_item.snapshot_id;
      v_started := v_started + 1;
    END IF;

    v_step := arena.trust_evidence_retention_step(v_item.snapshot_id, v_item.disposition, v_budget);
    v_budget := v_budget - (v_step->>'used')::bigint;
    v_touched := v_touched || v_item.snapshot_id;
    IF (v_step->>'complete')::boolean THEN
      v_completed := v_completed + 1;
    END IF;
    SELECT pg_catalog.jsonb_object_agg(
             key,
             (v_deleted->>key)::bigint + COALESCE((v_step->>key)::bigint, 0)
           )
      INTO v_deleted
      FROM pg_catalog.jsonb_object_keys(v_deleted) AS key;

    -- An unfinished step means the budget ran out inside this snapshot.
    EXIT WHEN NOT (v_step->>'complete')::boolean;
  END LOOP;

  DELETE FROM arena.trust_evidence_retention_active_xacts AS active
   WHERE active.xact = pg_catalog.pg_current_xact_id();

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'arena.trust-evidence-retention@2',
    'mode', 'delete',
    'row_cap', p_row_cap,
    'superseded_days', p_superseded_days,
    'failed_days', p_failed_days,
    'daily_keep_days', p_daily_keep_days
  ) || v_eligible || pg_catalog.jsonb_build_object(
    'would_delete', NULL,
    'deleted', v_deleted || pg_catalog.jsonb_build_object(
      'rows', p_row_cap - v_budget,
      'snapshots_touched', pg_catalog.cardinality(v_touched),
      'purges_started', v_started,
      'purges_completed', v_completed
    )
  );
END;
$function$;

ALTER TABLE arena.trust_evidence_retention_settings OWNER TO postgres;
ALTER TABLE arena.trust_evidence_retention_purges OWNER TO postgres;
ALTER TABLE arena.trust_evidence_retention_purged_runs OWNER TO postgres;
ALTER TABLE arena.trust_evidence_retention_active_xacts OWNER TO postgres;
ALTER FUNCTION arena.metric_trust_run_purge_authorized(text) OWNER TO postgres;
ALTER FUNCTION arena.reject_direct_metric_trust_mutation() OWNER TO postgres;
ALTER FUNCTION arena.trust_evidence_retention_candidates(integer, integer, integer, integer) OWNER TO postgres;
ALTER FUNCTION arena.trust_evidence_retention_remaining(bigint, text) OWNER TO postgres;
ALTER FUNCTION arena.trust_evidence_retention_step(bigint, text, bigint) OWNER TO postgres;
ALTER FUNCTION arena.retain_trust_evidence(boolean, integer, integer, integer, integer) OWNER TO postgres;

ALTER TABLE arena.trust_evidence_retention_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.trust_evidence_retention_purges ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.trust_evidence_retention_purged_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.trust_evidence_retention_active_xacts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  arena.trust_evidence_retention_settings,
  arena.trust_evidence_retention_purges,
  arena.trust_evidence_retention_purged_runs,
  arena.trust_evidence_retention_active_xacts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE
  arena.trust_evidence_retention_settings,
  arena.trust_evidence_retention_purges
  TO service_role;

REVOKE ALL ON FUNCTION arena.metric_trust_run_purge_authorized(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.trust_evidence_retention_candidates(integer, integer, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.trust_evidence_retention_remaining(bigint, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.trust_evidence_retention_step(bigint, text, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.retain_trust_evidence(boolean, integer, integer, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION arena.retain_trust_evidence(boolean, integer, integer, integer, integer)
  TO service_role;

DO $postflight$
BEGIN
  -- This migration grants no write on any table. (Pre-existing grants on the
  -- evidence tables are left as they are; the ledger is read-only to APIs.)
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('arena.trust_evidence_retention_settings'),
        ('arena.trust_evidence_retention_purges'),
        ('arena.trust_evidence_retention_purged_runs'),
        ('arena.trust_evidence_retention_active_xacts')
      ) AS guarded(relation)
     CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS api(role_name)
     WHERE pg_catalog.has_table_privilege(api.role_name, guarded.relation, 'INSERT')
        OR pg_catalog.has_table_privilege(api.role_name, guarded.relation, 'UPDATE')
        OR pg_catalog.has_table_privilege(api.role_name, guarded.relation, 'DELETE')
        OR pg_catalog.has_table_privilege(api.role_name, guarded.relation, 'TRUNCATE')
  ) OR EXISTS (
    SELECT 1
      FROM (VALUES
        ('arena.metric_trust_run_purge_authorized(text)'),
        ('arena.trust_evidence_retention_step(bigint,text,bigint)'),
        ('arena.trust_evidence_retention_candidates(integer,integer,integer,integer)'),
        ('arena.trust_evidence_retention_remaining(bigint,text)')
      ) AS private_function(signature)
     WHERE pg_catalog.has_function_privilege('service_role', private_function.signature, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'an API role can write the trust evidence retention ledger or run a private step';
  END IF;
END
$postflight$;

COMMIT;
