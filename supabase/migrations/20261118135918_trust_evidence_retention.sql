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
--   A purge removes the snapshot's runs (cascading observations and
--   artifacts), its entries, and the snapshot row. A snapshot bound by an
--   immutable Tier-A window receipt (RESTRICT, cannot be deleted) keeps its
--   header row and loses only the heavy body (disposition body_only). Freed
--   RAW objects are not touched: they become ordinary candidates of the
--   existing cleanupRawObjects -> arena.raw_object_gc_queue path.
--
-- Mechanics
--   * arena.retain_trust_evidence(p_delete, ...) is the only delete path:
--     SECURITY DEFINER, pinned search_path, lock_timeout; refuses delete mode
--     unless arena.trust_evidence_retention_settings.delete_enabled (default
--     false, owner-only) is on and the caller bounded statement_timeout.
--     Default call counts only. Each call handles at most p_snapshot_limit
--     snapshots and stops before p_row_cap rows (a single snapshot is never
--     split). One call is one transaction: all of it or nothing.
--   * arena.reject_direct_metric_trust_mutation() keeps rejecting every
--     direct write, except DELETE of a metric_trust_runs row that the same
--     transaction recorded in arena.trust_evidence_retention_purged_runs
--     (only this function inserts there; no role is granted any write).
--   * arena.trust_evidence_retention_purges keeps one audit row per purged
--     snapshot (identity, reason, disposition, counts, run ids).
--   This migration grants no table-level write (DELETE included) to any role.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '10min';
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

-- Run -> observation cascades look observations up by source_run_id; the only
-- existing index leads with source_id. Small receipts table: snapshot lookup.
CREATE INDEX IF NOT EXISTS idx_arena_metric_trust_observations_source_run
  ON arena.metric_trust_observations (source_run_id);
CREATE INDEX IF NOT EXISTS idx_arena_tier_a_window_receipts_snapshot
  ON arena.tier_a_execution_window_receipts (snapshot_id);

CREATE TABLE IF NOT EXISTS arena.trust_evidence_retention_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  delete_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp()
);
INSERT INTO arena.trust_evidence_retention_settings (singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS arena.trust_evidence_retention_purges (
  snapshot_id bigint PRIMARY KEY,
  purge_xact pg_catalog.xid8 NOT NULL,
  source_id smallint NOT NULL,
  timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL,
  count_check_passed boolean NOT NULL,
  raw_object_id bigint,
  reason text NOT NULL CHECK (reason IN ('superseded_success', 'unpublished_failure')),
  disposition text NOT NULL CHECK (disposition IN ('snapshot', 'body_only')),
  source_run_ids text[] NOT NULL,
  deleted_entries bigint NOT NULL CHECK (deleted_entries >= 0),
  deleted_observations bigint NOT NULL CHECK (deleted_observations >= 0),
  deleted_artifacts bigint NOT NULL CHECK (deleted_artifacts >= 0),
  deleted_runs bigint NOT NULL CHECK (deleted_runs >= 0),
  purged_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp()
);

CREATE TABLE IF NOT EXISTS arena.trust_evidence_retention_purged_runs (
  source_run_id text PRIMARY KEY,
  snapshot_id bigint NOT NULL,
  purge_xact pg_catalog.xid8 NOT NULL,
  purged_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp()
);

COMMENT ON TABLE arena.trust_evidence_retention_settings IS
  'Trust evidence retention delete switch (default off; owner-only production action).';
COMMENT ON TABLE arena.trust_evidence_retention_purges IS
  'Append-only audit of snapshots whose trust evidence body was purged by arena.retain_trust_evidence.';
COMMENT ON TABLE arena.trust_evidence_retention_purged_runs IS
  'Metric-trust runs purged by arena.retain_trust_evidence; a row of the current transaction authorizes that run''s DELETE.';

CREATE OR REPLACE FUNCTION arena.metric_trust_run_purge_authorized(p_source_run_id text)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM arena.trust_evidence_retention_purged_runs AS purged
     WHERE purged.source_run_id = p_source_run_id
       AND purged.purge_xact = pg_catalog.pg_current_xact_id()
  )
$function$;

-- Same contract as 20260721120000 plus one exception: the retention
-- function's own, same-transaction-authorized run deletes.
CREATE OR REPLACE FUNCTION arena.reject_direct_metric_trust_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE'
     AND TG_LEVEL = 'ROW'
     AND TG_TABLE_SCHEMA = 'arena'
     AND TG_TABLE_NAME = 'metric_trust_runs' THEN
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

CREATE OR REPLACE FUNCTION arena.retain_trust_evidence(
  p_delete boolean DEFAULT false,
  p_superseded_days integer DEFAULT 14,
  p_failed_days integer DEFAULT 7,
  p_snapshot_limit integer DEFAULT 50,
  p_row_cap integer DEFAULT 250000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_success_cutoff timestamptz;
  v_failed_cutoff timestamptz;
  v_eligible_total bigint;
  v_eligible_superseded bigint;
  v_eligible_failed bigint;
  v_detail jsonb;
  v_ids bigint[];
  v_scraped timestamptz[];
  v_header_ids bigint[];
  v_run_ids text[];
  v_entries bigint;
  v_observations bigint;
  v_artifacts bigint;
  v_raw_refs bigint;
  v_xact pg_catalog.xid8;
  v_count bigint;
  v_batch jsonb;
BEGIN
  IF p_delete IS NULL THEN
    RAISE EXCEPTION 'retention mode must be explicit' USING ERRCODE = '22023';
  END IF;
  IF p_superseded_days IS NULL OR p_superseded_days < 14 OR p_superseded_days > 3650 THEN
    RAISE EXCEPTION 'superseded snapshot retention must be between 14 and 3650 days'
      USING ERRCODE = '22023';
  END IF;
  IF p_failed_days IS NULL OR p_failed_days < 7 OR p_failed_days > 3650 THEN
    RAISE EXCEPTION 'failed snapshot retention must be between 7 and 3650 days'
      USING ERRCODE = '22023';
  END IF;
  IF p_snapshot_limit IS NULL OR p_snapshot_limit < 1 OR p_snapshot_limit > 500 THEN
    RAISE EXCEPTION 'snapshot batch must be between 1 and 500' USING ERRCODE = '22023';
  END IF;
  IF p_row_cap IS NULL OR p_row_cap < 1000 OR p_row_cap > 5000000 THEN
    RAISE EXCEPTION 'row cap must be between 1000 and 5000000' USING ERRCODE = '22023';
  END IF;

  IF p_delete THEN
    IF NOT COALESCE(
         (SELECT settings.delete_enabled
            FROM arena.trust_evidence_retention_settings AS settings
           WHERE settings.singleton),
         false
       ) THEN
      RAISE EXCEPTION 'trust evidence retention delete switch is off' USING ERRCODE = '55000';
    END IF;
    IF pg_catalog.current_setting('statement_timeout') IN ('0', '0ms') THEN
      RAISE EXCEPTION 'trust evidence retention delete requires a bounded statement_timeout'
        USING ERRCODE = '55000';
    END IF;
    -- One purge at a time; a concurrent caller is a no-op, not a waiter.
    IF NOT pg_catalog.pg_try_advisory_xact_lock(
         pg_catalog.hashtextextended('arena.retain_trust_evidence', 0)
       ) THEN
      RETURN pg_catalog.jsonb_build_object(
        'contract', 'arena.trust-evidence-retention@1',
        'mode', 'delete',
        'skipped', 'concurrent_purge'
      );
    END IF;
  END IF;

  v_success_cutoff := v_now - pg_catalog.make_interval(days => p_superseded_days);
  v_failed_cutoff := v_now - pg_catalog.make_interval(days => p_failed_days);

  WITH pinned_cohort AS MATERIALIZED (
    SELECT publication.id
      FROM arena.leaderboard_rank_publications AS publication
     WHERE publication.published_at >= v_success_cutoff
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
             OR plan.planned_at >= v_success_cutoff
      FROM arena.leaderboard_rank_generation_publication_plan_sources AS plan_source
      JOIN arena.leaderboard_rank_generation_publication_plans AS plan
        ON plan.season_id = plan_source.season_id
       AND plan.generation_seq = plan_source.generation_seq
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
  candidate AS MATERIALIZED (
    SELECT snapshot.id,
           snapshot.source_id,
           snapshot.timeframe,
           snapshot.scraped_at,
           snapshot.count_check_passed,
           snapshot.raw_object_id,
           CASE WHEN snapshot.count_check_passed THEN 'superseded_success'
                ELSE 'unpublished_failure' END AS reason
      FROM arena.leaderboard_snapshots AS snapshot
      JOIN arena.sources AS source_row ON source_row.id = snapshot.source_id
     CROSS JOIN LATERAL (
       SELECT COALESCE(
                NULLIF(pg_catalog.btrim(source_row.meta->>'legacy_platform'), ''),
                source_row.slug
              ) AS alias
     ) AS source_alias
     WHERE (
             (
               snapshot.count_check_passed
               AND snapshot.scraped_at < v_success_cutoff
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
               AND snapshot.scraped_at < v_failed_cutoff
               AND NOT EXISTS (SELECT 1 FROM id_pin WHERE id_pin.snapshot_id = snapshot.id)
               AND NOT EXISTS (
                 SELECT 1 FROM board_pin
                  WHERE board_pin.source = source_alias.alias
                    AND board_pin.source_as_of = snapshot.scraped_at
               )
             )
           )
       -- Something left to purge: a deletable header or a remaining body.
       AND (
             NOT EXISTS (
               SELECT 1 FROM arena.tier_a_execution_window_receipts AS receipt
                WHERE receipt.snapshot_id = snapshot.id
             )
             OR EXISTS (
               SELECT 1 FROM arena.metric_trust_runs AS run WHERE run.snapshot_id = snapshot.id
             )
             OR EXISTS (
               SELECT 1 FROM arena.metric_trust_observations AS observation
                WHERE observation.snapshot_id = snapshot.id
             )
             OR EXISTS (
               SELECT 1 FROM arena.leaderboard_entries AS entry
                WHERE entry.snapshot_id = snapshot.id AND entry.scraped_at = snapshot.scraped_at
             )
           )
  ),
  batch AS MATERIALIZED (
    SELECT candidate.*
      FROM candidate
     ORDER BY candidate.scraped_at, candidate.id
     LIMIT p_snapshot_limit
  ),
  sized AS MATERIALIZED (
    SELECT batch.*,
           NOT EXISTS (
             SELECT 1 FROM arena.tier_a_execution_window_receipts AS receipt
              WHERE receipt.snapshot_id = batch.id
           ) AS header_deletable,
           (SELECT pg_catalog.count(*) FROM arena.leaderboard_entries AS entry
             WHERE entry.snapshot_id = batch.id AND entry.scraped_at = batch.scraped_at) AS entries,
           (SELECT pg_catalog.count(*) FROM arena.metric_trust_observations AS observation
             WHERE observation.snapshot_id = batch.id) AS observations,
           (SELECT pg_catalog.count(*)
              FROM arena.metric_trust_artifacts AS artifact
              JOIN arena.metric_trust_observations AS observation
                ON observation.id = artifact.observation_id
             WHERE observation.snapshot_id = batch.id) AS artifacts,
           COALESCE((
             SELECT pg_catalog.array_agg(DISTINCT run_id.source_run_id ORDER BY run_id.source_run_id)
               FROM (
                 SELECT run.source_run_id FROM arena.metric_trust_runs AS run
                  WHERE run.snapshot_id = batch.id
                 UNION
                 SELECT observation.source_run_id FROM arena.metric_trust_observations AS observation
                  WHERE observation.snapshot_id = batch.id
               ) AS run_id
           ), '{}'::text[]) AS run_ids
      FROM batch
  ),
  capped AS MATERIALIZED (
    SELECT sized.*,
           pg_catalog.row_number() OVER (ORDER BY sized.scraped_at, sized.id) AS ordinal,
           pg_catalog.sum(
             sized.entries + sized.observations + sized.artifacts
             + pg_catalog.cardinality(sized.run_ids) + 1
           ) OVER (ORDER BY sized.scraped_at, sized.id ROWS UNBOUNDED PRECEDING) AS rows_through
      FROM sized
  )
  SELECT (SELECT pg_catalog.count(*) FROM candidate),
         (SELECT pg_catalog.count(*) FROM candidate WHERE candidate.reason = 'superseded_success'),
         (SELECT pg_catalog.count(*) FROM candidate WHERE candidate.reason = 'unpublished_failure'),
         COALESCE((
           SELECT pg_catalog.jsonb_agg(
                    pg_catalog.jsonb_build_object(
                      'snapshot_id', capped.id,
                      'source_id', capped.source_id,
                      'timeframe', capped.timeframe,
                      'scraped_at', capped.scraped_at,
                      'count_check_passed', capped.count_check_passed,
                      'raw_object_id', capped.raw_object_id,
                      'reason', capped.reason,
                      'disposition', CASE WHEN capped.header_deletable THEN 'snapshot' ELSE 'body_only' END,
                      'source_run_ids', pg_catalog.to_jsonb(capped.run_ids),
                      'entries', capped.entries,
                      'observations', capped.observations,
                      'artifacts', capped.artifacts,
                      'runs', pg_catalog.cardinality(capped.run_ids)
                    )
                    ORDER BY capped.ordinal
                  )
             FROM capped
            WHERE capped.ordinal = 1 OR capped.rows_through <= p_row_cap
         ), '[]'::jsonb)
    INTO v_eligible_total, v_eligible_superseded, v_eligible_failed, v_detail;

  SELECT COALESCE(pg_catalog.array_agg((item.value->>'snapshot_id')::bigint), '{}'),
         COALESCE(pg_catalog.array_agg((item.value->>'scraped_at')::timestamptz), '{}'),
         COALESCE(
           pg_catalog.array_agg((item.value->>'snapshot_id')::bigint)
             FILTER (WHERE item.value->>'disposition' = 'snapshot'),
           '{}'
         ),
         COALESCE(pg_catalog.sum((item.value->>'entries')::bigint), 0),
         COALESCE(pg_catalog.sum((item.value->>'observations')::bigint), 0),
         COALESCE(pg_catalog.sum((item.value->>'artifacts')::bigint), 0)
    INTO v_ids, v_scraped, v_header_ids, v_entries, v_observations, v_artifacts
    FROM pg_catalog.jsonb_array_elements(v_detail) AS item(value);

  SELECT COALESCE(pg_catalog.array_agg(DISTINCT run_id.value), '{}')
    INTO v_run_ids
    FROM pg_catalog.jsonb_array_elements(v_detail) AS item(value)
   CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(item.value->'source_run_ids') AS run_id(value);

  -- RAW pointers this batch stops referencing, minus those a surviving
  -- snapshot header still pins (cleanupRawObjects re-checks every pin before
  -- queueing anything).
  SELECT pg_catalog.count(DISTINCT released.raw_object_id)
    INTO v_raw_refs
    FROM (
      SELECT snapshot.raw_object_id
        FROM arena.leaderboard_snapshots AS snapshot
       WHERE snapshot.id = ANY (v_header_ids) AND snapshot.raw_object_id IS NOT NULL
      UNION ALL
      SELECT run.population_raw_object_id FROM arena.metric_trust_runs AS run
       WHERE run.source_run_id = ANY (v_run_ids)
      UNION ALL
      SELECT run.manifest_raw_object_id FROM arena.metric_trust_runs AS run
       WHERE run.source_run_id = ANY (v_run_ids)
      UNION ALL
      SELECT artifact.raw_object_id
        FROM arena.metric_trust_artifacts AS artifact
        JOIN arena.metric_trust_observations AS observation
          ON observation.id = artifact.observation_id
       WHERE observation.snapshot_id = ANY (v_ids)
    ) AS released
   WHERE NOT EXISTS (
     SELECT 1 FROM arena.leaderboard_snapshots AS survivor
      WHERE survivor.raw_object_id = released.raw_object_id
        AND NOT (survivor.id = ANY (v_header_ids))
   );

  v_batch := pg_catalog.jsonb_build_object(
    'snapshots', pg_catalog.cardinality(v_ids),
    'snapshot_rows', pg_catalog.cardinality(v_header_ids),
    'body_only_snapshots', pg_catalog.cardinality(v_ids) - pg_catalog.cardinality(v_header_ids),
    'leaderboard_entries', v_entries,
    'metric_trust_observations', v_observations,
    'metric_trust_artifacts', v_artifacts,
    'metric_trust_runs', pg_catalog.cardinality(v_run_ids),
    'raw_object_refs_released', v_raw_refs
  );

  IF NOT p_delete OR pg_catalog.cardinality(v_ids) = 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'contract', 'arena.trust-evidence-retention@1',
      'mode', CASE WHEN p_delete THEN 'delete' ELSE 'count' END,
      'superseded_days', p_superseded_days,
      'failed_days', p_failed_days,
      'snapshot_limit', p_snapshot_limit,
      'row_cap', p_row_cap,
      'eligible_snapshots_total', v_eligible_total,
      'eligible_superseded_success', v_eligible_superseded,
      'eligible_unpublished_failure', v_eligible_failed,
      'would_delete', CASE WHEN p_delete THEN NULL ELSE v_batch END,
      'deleted', CASE WHEN p_delete THEN v_batch ELSE NULL END
    );
  END IF;

  -- ── Delete mode: one atomic batch; any surprise aborts all of it. ──
  PERFORM 1
     FROM arena.leaderboard_snapshots AS snapshot
    WHERE snapshot.id = ANY (v_ids)
    ORDER BY snapshot.id
      FOR UPDATE;

  IF EXISTS (
       SELECT 1 FROM arena.metric_trust_runs AS run
        WHERE run.source_run_id = ANY (v_run_ids)
          AND NOT (run.snapshot_id = ANY (v_ids))
     ) OR EXISTS (
       SELECT 1 FROM arena.metric_trust_observations AS observation
        WHERE observation.source_run_id = ANY (v_run_ids)
          AND NOT (observation.snapshot_id = ANY (v_ids))
     ) THEN
    RAISE EXCEPTION 'a purged run is bound to a snapshot outside this batch'
      USING ERRCODE = '55000';
  END IF;

  v_xact := pg_catalog.pg_current_xact_id();
  INSERT INTO arena.trust_evidence_retention_purged_runs (source_run_id, snapshot_id, purge_xact)
  SELECT run.source_run_id, run.snapshot_id, v_xact
    FROM arena.metric_trust_runs AS run
   WHERE run.source_run_id = ANY (v_run_ids);

  -- Runs cascade to their observations, observations to their artifacts.
  DELETE FROM arena.metric_trust_runs AS run WHERE run.source_run_id = ANY (v_run_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> pg_catalog.cardinality(v_run_ids) THEN
    RAISE EXCEPTION 'expected % metric-trust runs, deleted %', pg_catalog.cardinality(v_run_ids), v_count
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM arena.metric_trust_observations AS observation
     WHERE observation.snapshot_id = ANY (v_ids)
  ) THEN
    RAISE EXCEPTION 'metric-trust observations of a purged snapshot survived their runs'
      USING ERRCODE = '55000';
  END IF;

  DELETE FROM arena.leaderboard_entries AS entry
   USING ROWS FROM (unnest(v_ids), unnest(v_scraped)) AS victim(id, scraped_at)
   WHERE entry.snapshot_id = victim.id
     AND entry.scraped_at = victim.scraped_at;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> v_entries THEN
    RAISE EXCEPTION 'expected % leaderboard entries, deleted %', v_entries, v_count
      USING ERRCODE = '55000';
  END IF;

  DELETE FROM arena.leaderboard_snapshots AS snapshot WHERE snapshot.id = ANY (v_header_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> pg_catalog.cardinality(v_header_ids) THEN
    RAISE EXCEPTION 'expected % snapshots, deleted %', pg_catalog.cardinality(v_header_ids), v_count
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO arena.trust_evidence_retention_purges (
    snapshot_id, purge_xact, source_id, timeframe, scraped_at, count_check_passed,
    raw_object_id, reason, disposition, source_run_ids, deleted_entries,
    deleted_observations, deleted_artifacts, deleted_runs
  )
  SELECT (item.value->>'snapshot_id')::bigint,
         v_xact,
         (item.value->>'source_id')::smallint,
         (item.value->>'timeframe')::smallint,
         (item.value->>'scraped_at')::timestamptz,
         (item.value->>'count_check_passed')::boolean,
         (item.value->>'raw_object_id')::bigint,
         item.value->>'reason',
         item.value->>'disposition',
         ARRAY(SELECT pg_catalog.jsonb_array_elements_text(item.value->'source_run_ids')),
         (item.value->>'entries')::bigint,
         (item.value->>'observations')::bigint,
         (item.value->>'artifacts')::bigint,
         (item.value->>'runs')::bigint
    FROM pg_catalog.jsonb_array_elements(v_detail) AS item(value);

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'arena.trust-evidence-retention@1',
    'mode', 'delete',
    'superseded_days', p_superseded_days,
    'failed_days', p_failed_days,
    'snapshot_limit', p_snapshot_limit,
    'row_cap', p_row_cap,
    'eligible_snapshots_total', v_eligible_total,
    'eligible_superseded_success', v_eligible_superseded,
    'eligible_unpublished_failure', v_eligible_failed,
    'would_delete', NULL,
    'deleted', v_batch
  );
END;
$function$;

ALTER TABLE arena.trust_evidence_retention_settings OWNER TO postgres;
ALTER TABLE arena.trust_evidence_retention_purges OWNER TO postgres;
ALTER TABLE arena.trust_evidence_retention_purged_runs OWNER TO postgres;
ALTER FUNCTION arena.metric_trust_run_purge_authorized(text) OWNER TO postgres;
ALTER FUNCTION arena.reject_direct_metric_trust_mutation() OWNER TO postgres;
ALTER FUNCTION arena.retain_trust_evidence(boolean, integer, integer, integer, integer) OWNER TO postgres;

ALTER TABLE arena.trust_evidence_retention_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.trust_evidence_retention_purges ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.trust_evidence_retention_purged_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  arena.trust_evidence_retention_settings,
  arena.trust_evidence_retention_purges,
  arena.trust_evidence_retention_purged_runs
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE
  arena.trust_evidence_retention_settings,
  arena.trust_evidence_retention_purges
  TO service_role;

REVOKE ALL ON FUNCTION arena.metric_trust_run_purge_authorized(text)
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
        ('arena.trust_evidence_retention_purged_runs')
      ) AS guarded(relation)
     CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS api(role_name)
     WHERE pg_catalog.has_table_privilege(api.role_name, guarded.relation, 'INSERT')
        OR pg_catalog.has_table_privilege(api.role_name, guarded.relation, 'UPDATE')
        OR pg_catalog.has_table_privilege(api.role_name, guarded.relation, 'DELETE')
        OR pg_catalog.has_table_privilege(api.role_name, guarded.relation, 'TRUNCATE')
  ) OR pg_catalog.has_function_privilege(
         'service_role', 'arena.metric_trust_run_purge_authorized(text)', 'EXECUTE'
       ) THEN
    RAISE EXCEPTION 'an API role can write the trust evidence retention ledger';
  END IF;
END
$postflight$;

COMMIT;
