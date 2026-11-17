-- Migration: 20261116210657_rank_publication_evidence_score_input_digest.sql
-- Description: Score-input evidence binding, step 3 of 3 (PR #476 plan,
--   option B): every sealed source's evidence row carries the digest of the
--   score-input rows that were scored.
--
-- 20261114193017 binds a sealed cohort to the snapshots, RAW objects, source
-- runs and manifests of its boards, but not to the values that were scored.
-- arena.leaderboard_rank_publication_source_evidence.score_input_sha256 is the
-- canonical sha256 (lib/rankings/publication/score-input-digest.ts, contract
-- arena-score-input-set@1) of the publication score rows
-- (arena.publication_score_rows_json) the orchestrator handed to the scorer
-- for that source. The orchestrator computes it and records it through
-- public.record_leaderboard_rank_publication_evidence in the sealing
-- transaction, so a sealed score can be recomputed from the evidence.
--
-- * The column is nullable only for evidence rows written before this
--   migration (none are expected: 20261114193017 is generated only); its CHECK
--   is a lowercase sha256.
-- * record_leaderboard_rank_publication_evidence (@3) refuses (22023) a source
--   without a well-formed digest, after the attempt-bound checks of @2.
-- * The deferred seal fence (arena.require_rank_publication_evidence) refuses
--   COMMIT of a seal whose proof source has no evidence row with a digest.
--
-- POSTDEPLOY, after 20261116210122: the deployed orchestrator sends no digest,
-- so @3 would refuse every season until the release that sends one serves;
-- that release accepts @2 (the digest is then simply not stored) and @3.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.leaderboard_rank_publication_source_evidence') IS NULL
     OR pg_catalog.to_regprocedure('arena.require_rank_publication_evidence()') IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = pg_catalog.to_regprocedure(
           'public.record_leaderboard_rank_publication_evidence(text,uuid,jsonb)'
         )
         AND pg_catalog.strpos(function_row.prosrc,
               'leaderboard-rank-publication-evidence@2') > 0
     ) THEN
    RAISE EXCEPTION 'score-input digest requires the attempt-bound publication evidence of 20261114193017';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
        'arena.leaderboard_rank_publication_source_evidence'::pg_catalog.regclass
      AND attribute.attname = 'score_input_sha256'
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'score_input_sha256 already exists';
  END IF;
END
$preflight$;

ALTER TABLE arena.leaderboard_rank_publication_source_evidence
  ADD COLUMN score_input_sha256 text;
ALTER TABLE arena.leaderboard_rank_publication_source_evidence
  ADD CONSTRAINT rank_publication_evidence_score_input_sha256_shape
  CHECK (score_input_sha256 IS NULL OR score_input_sha256 ~ '^[0-9a-f]{64}$') NOT VALID;
ALTER TABLE arena.leaderboard_rank_publication_source_evidence
  VALIDATE CONSTRAINT rank_publication_evidence_score_input_sha256_shape;
COMMENT ON COLUMN arena.leaderboard_rank_publication_source_evidence.score_input_sha256 IS
  'sha256 of the canonical score-input rows scored for this source (arena-score-input-set@1).';

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
  v_score_input_sha256 text;
  v_grades jsonb := '{}'::jsonb;
BEGIN
  -- leaderboard-rank-publication-evidence@3 (attempt-bound + score-input digest required)
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
    SELECT item.value->>'source' AS source, item.value->'snapshot_ids' AS snapshot_ids,
           item.value->>'score_input_sha256' AS score_input_sha256
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

    -- The canonical digest of the score-input rows the orchestrator scored for
    -- this source (lib/rankings/publication/score-input-digest.ts,
    -- arena-score-input-set@1), so the sealed scores can be recomputed from
    -- the evidence.
    v_score_input_sha256 := v_item.score_input_sha256;
    IF v_score_input_sha256 IS NULL OR v_score_input_sha256 !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'evidence for % needs a lowercase sha256 score_input_sha256', v_item.source
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO arena.leaderboard_rank_publication_source_evidence (
      score_cohort_id, season_id, source, evidence_grade, snapshot_ids,
      raw_object_ids, source_run_ids, manifest_raw_object_ids, score_input_sha256
    ) VALUES (
      p_score_cohort_id, p_season_id, v_item.source, 'attempt_bound', v_snapshot_ids,
      v_raw_object_ids, v_run_ids, v_manifest_ids, v_score_input_sha256
    );
    v_grades := v_grades || pg_catalog.jsonb_build_object(v_item.source, 'attempt_bound');
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-rank-publication-evidence@3',
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
      AND evidence.score_input_sha256 IS NOT NULL
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sealed % cohort % lacks attempt-bound evidence with a score-input digest for: %',
      NEW.season_id, NEW.id, pg_catalog.array_to_string(v_missing, ', ')
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$function$;

ALTER FUNCTION arena.require_rank_publication_evidence() OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.require_rank_publication_evidence()
  FROM PUBLIC, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
