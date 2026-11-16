-- Migration: 20261114193017_rank_publication_requires_attempt_bound_evidence.sql
-- Created: 2026-11-15T03:30:17Z
-- Description: A public leaderboard cohort may be sealed only when every
--   published source's boards carry attempt-bound trust evidence (owner
--   decision closing audit-2 P1-4 / REC-2: one publication authority, one
--   evidence chain).
--
-- 20261113110430 recorded an evidence grade per sealed source but still let a
-- 'count_check_only' board be published, and graded by arena.metric_trust_runs
-- only (so a complete V4 attempt-bound board was graded count_check_only).
--
-- The single evidence predicate is now
--   public.rank_publication_trust_evidence(snapshot_ids):
-- a PASSED snapshot is trust-bound iff its raw_object_id is the source payload
-- of a terminal 'complete' acquisition outcome (whose CHECK implies
-- acquisition complete, population verified, capture evidence verified and a
-- source_run_id) of an attempt-bound (@3/@4) acquisition attempt for the same
-- source and timeframe, and that outcome names its population manifest.
--
-- * The orchestrator (lib/rankings/publication/publish-season.ts) calls it
--   before scoring and isolates every source with an unbound board through the
--   per-source isolation path (20261113011058), reason 'untrusted'.
-- * public.record_leaderboard_rank_publication_evidence now refuses (23514) any
--   source whose snapshots are not all trust-bound and records the outcome's
--   source_run_id / manifest as the evidence; every new row is 'attempt_bound'.
-- * A DEFERRABLE INITIALLY DEFERRED constraint trigger on
--   arena.leaderboard_rank_publications refuses COMMIT of any seal whose
--   proof sources are not each bound by an attempt_bound evidence row, so no
--   caller can serve a cohort without the evidence chain.
--
-- No table, column or constraint is dropped; existing evidence rows (none are
-- expected: 20261113110430 is generated only) are left untouched.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.leaderboard_rank_publication_source_evidence') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.record_leaderboard_rank_publication_evidence(text,uuid,jsonb)'
     ) IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_rank_publications') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_snapshots') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_attempts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_outcomes') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'attempt-bound publication evidence requires 20261113110430 and the acquisition ledger (20260722030000)';
  END IF;
END
$preflight$;

-- The one evidence predicate.
CREATE OR REPLACE FUNCTION public.rank_publication_trust_evidence(p_snapshot_ids bigint[])
RETURNS TABLE (
  snapshot_id bigint,
  trust_bound boolean,
  raw_object_id bigint,
  source_run_id text,
  manifest_raw_object_id bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT requested.id,
         bound.source_run_id IS NOT NULL,
         snapshot.raw_object_id,
         bound.source_run_id,
         bound.manifest_raw_object_id
  FROM (SELECT DISTINCT pg_catalog.unnest(p_snapshot_ids) AS id) AS requested
  LEFT JOIN arena.leaderboard_snapshots AS snapshot
    ON snapshot.id = requested.id
   AND snapshot.count_check_passed
  LEFT JOIN LATERAL (
    SELECT outcome.source_run_id, outcome.manifest_raw_object_id
    FROM arena.leaderboard_acquisition_outcomes AS outcome
    JOIN arena.leaderboard_acquisition_attempts AS attempt
      ON attempt.attempt_seq = outcome.attempt_seq
    WHERE attempt.source_id = snapshot.source_id
      AND attempt.timeframe = snapshot.timeframe
      AND attempt.capture_contract IN (
        'arena.ingest.leaderboard-acquisition-manifest@3',
        'arena.ingest.leaderboard-acquisition-manifest@4'
      )
      AND outcome.terminal_state = 'complete'
      AND outcome.source_run_id IS NOT NULL
      AND outcome.manifest_raw_object_id IS NOT NULL
      AND outcome.source_payload_raw_object_id = snapshot.raw_object_id
    ORDER BY outcome.attempt_seq DESC
    LIMIT 1
  ) AS bound ON true
  ORDER BY requested.id
$function$;

ALTER FUNCTION public.rank_publication_trust_evidence(bigint[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.rank_publication_trust_evidence(bigint[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rank_publication_trust_evidence(bigint[]) TO service_role;

-- Seal-time evidence binding: refuses unbound sources, records the
-- attempt-bound acquisition (source run + manifest) of every board.
CREATE OR REPLACE FUNCTION public.record_leaderboard_rank_publication_evidence(
  p_season_id text,
  p_score_cohort_id uuid,
  p_source_publications jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_publication arena.leaderboard_rank_publications%ROWTYPE;
  v_item record;
  v_snapshot_ids bigint[];
  v_valid_count integer;
  v_raw_object_ids bigint[];
  v_run_ids text[];
  v_manifest_ids bigint[];
  v_bound_count integer;
  v_grades jsonb := '{}'::jsonb;
BEGIN
  -- leaderboard-rank-publication-evidence@2 (attempt-bound required)
  SELECT publication.*
  INTO v_publication
  FROM ONLY arena.leaderboard_rank_publications AS publication
  WHERE publication.id = p_score_cohort_id
    AND publication.season_id = p_season_id
    AND publication.xmin = pg_catalog.pg_current_xact_id()::pg_catalog.xid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence may be recorded only by the transaction that sealed the cohort'
      USING ERRCODE = '55000';
  END IF;

  IF pg_catalog.jsonb_typeof(p_source_publications) IS DISTINCT FROM 'array'
     OR (
       SELECT pg_catalog.array_agg(item.value->>'source' ORDER BY item.value->>'source')
       FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
     ) IS DISTINCT FROM (
       SELECT pg_catalog.array_agg(proof.value->>'source' ORDER BY proof.value->>'source')
       FROM pg_catalog.jsonb_array_elements(v_publication.proofs) AS proof(value)
     ) THEN
    RAISE EXCEPTION 'evidence sources must equal the sealed publication sources'
      USING ERRCODE = '22023';
  END IF;

  FOR v_item IN
    SELECT item.value->>'source' AS source, item.value->'snapshot_ids' AS snapshot_ids
    FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
  LOOP
    IF pg_catalog.jsonb_typeof(v_item.snapshot_ids) IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(v_item.snapshot_ids) NOT BETWEEN 1 AND 64 THEN
      RAISE EXCEPTION 'evidence for % needs 1..64 snapshot ids', v_item.source
        USING ERRCODE = '22023';
    END IF;
    SELECT pg_catalog.array_agg(DISTINCT (id.value)::bigint ORDER BY (id.value)::bigint)
    INTO v_snapshot_ids
    FROM pg_catalog.jsonb_array_elements_text(v_item.snapshot_ids) AS id(value);

    SELECT pg_catalog.count(*)::integer
    INTO v_valid_count
    FROM arena.leaderboard_snapshots AS snapshot
    JOIN arena.sources AS source_row ON source_row.id = snapshot.source_id
    WHERE snapshot.id = ANY (v_snapshot_ids)
      AND snapshot.count_check_passed
      AND snapshot.timeframe = pg_catalog.rtrim(p_season_id, 'D')::smallint
      AND COALESCE(
            NULLIF(pg_catalog.btrim(source_row.meta->>'legacy_platform'), ''),
            source_row.slug
          ) = v_item.source;
    IF v_valid_count <> pg_catalog.cardinality(v_snapshot_ids) THEN
      RAISE EXCEPTION 'evidence snapshots for % are not passed % boards of that source',
        v_item.source, p_season_id
        USING ERRCODE = '23514';
    END IF;

    SELECT pg_catalog.count(*) FILTER (WHERE evidence.trust_bound)::integer,
           COALESCE(pg_catalog.array_agg(DISTINCT evidence.raw_object_id)
             FILTER (WHERE evidence.trust_bound), '{}'),
           COALESCE(pg_catalog.array_agg(DISTINCT evidence.source_run_id)
             FILTER (WHERE evidence.trust_bound), '{}'),
           COALESCE(pg_catalog.array_agg(DISTINCT evidence.manifest_raw_object_id)
             FILTER (WHERE evidence.trust_bound), '{}')
    INTO v_bound_count, v_raw_object_ids, v_run_ids, v_manifest_ids
    FROM public.rank_publication_trust_evidence(v_snapshot_ids) AS evidence;
    IF v_bound_count <> pg_catalog.cardinality(v_snapshot_ids) THEN
      RAISE EXCEPTION 'rank publication requires attempt-bound evidence: % has % of % boards bound',
        v_item.source, v_bound_count, pg_catalog.cardinality(v_snapshot_ids)
        USING ERRCODE = '23514';
    END IF;

    INSERT INTO arena.leaderboard_rank_publication_source_evidence (
      score_cohort_id, season_id, source, evidence_grade, snapshot_ids,
      raw_object_ids, source_run_ids, manifest_raw_object_ids
    ) VALUES (
      p_score_cohort_id, p_season_id, v_item.source, 'attempt_bound', v_snapshot_ids,
      v_raw_object_ids, v_run_ids, v_manifest_ids
    );
    v_grades := v_grades || pg_catalog.jsonb_build_object(v_item.source, 'attempt_bound');
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-rank-publication-evidence@2',
    'season_id', p_season_id,
    'score_cohort_id', p_score_cohort_id,
    'grades', v_grades
  );
END;
$function$;

ALTER FUNCTION public.record_leaderboard_rank_publication_evidence(text, uuid, jsonb)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_leaderboard_rank_publication_evidence(text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_leaderboard_rank_publication_evidence(text, uuid, jsonb)
  TO service_role;

-- COMMIT-time fence: a seal commits only with attempt-bound evidence for
-- every one of its proof sources.
CREATE OR REPLACE FUNCTION arena.require_rank_publication_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_missing text[];
BEGIN
  SELECT pg_catalog.array_agg(proof.value->>'source' ORDER BY proof.value->>'source')
  INTO v_missing
  FROM pg_catalog.jsonb_array_elements(NEW.proofs) AS proof(value)
  WHERE NOT EXISTS (
    SELECT 1
    FROM arena.leaderboard_rank_publication_source_evidence AS evidence
    WHERE evidence.score_cohort_id = NEW.id
      AND evidence.season_id = NEW.season_id
      AND evidence.source = proof.value->>'source'
      AND evidence.evidence_grade = 'attempt_bound'
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sealed % cohort % lacks attempt-bound evidence for: %',
      NEW.season_id, NEW.id, pg_catalog.array_to_string(v_missing, ', ')
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$function$;

ALTER FUNCTION arena.require_rank_publication_evidence() OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.require_rank_publication_evidence()
  FROM PUBLIC, anon, authenticated, service_role;

-- Constraint triggers have no OR REPLACE; this migration installs it once.
CREATE CONSTRAINT TRIGGER rank_publication_requires_attempt_bound_evidence
  AFTER INSERT ON arena.leaderboard_rank_publications
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION arena.require_rank_publication_evidence();

NOTIFY pgrst, 'reload schema';

COMMIT;
