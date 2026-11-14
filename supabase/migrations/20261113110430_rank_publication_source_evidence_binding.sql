-- Bind every sealed public ranking to the raw evidence it was built from.
--
-- A seal receipt (arena.leaderboard_rank_publications) records only
-- (source, source_as_of, trader_ids) per source. Nothing tied a public rank to
-- the snapshots, RAW objects, acquisition runs or manifests behind it, and
-- nothing said whether a source's board came from the attempt-bound /
-- metric-trust capture or only passed the count check
-- (INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED off => publishClaimedLeaderboardSnapshot).
--
-- public.record_leaderboard_rank_publication_evidence(season, cohort, rows)
-- runs inside the sealing transaction (after the seal) and writes one
-- immutable row per published source into
-- arena.leaderboard_rank_publication_source_evidence:
--   snapshot_ids, raw_object_ids, source_run_ids, manifest_raw_object_ids and
--   evidence_grade = 'attempt_bound' when every snapshot has a metric-trust
--   run (attempt-bound capture), else 'count_check_only'.
-- It accepts only the cohort sealed by this same transaction, only the exact
-- source set of that seal, and only count-check-passed snapshots of the
-- source's own registry boards.
--
-- public.public_ranked_leaderboard_source_evidence exposes, for the currently
-- served seasons, (season_id, source, evidence_grade, source_as_of) to
-- anon/authenticated so the public UI can distinguish evidence levels.
--
-- Snapshot retention (20261113110021) is extended to keep evidence snapshots.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.leaderboard_rank_publications') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_snapshots') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.public_ranked_leaderboard_serving_heads') IS NULL
     OR pg_catalog.to_regclass('arena.public_ranked_leaderboard_serving_sources') IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.public_ranked_leaderboard_serving_seasons(timestamptz)'
     ) IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'publication evidence binding requires the sealed serving authority (20260816184500)';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS arena.leaderboard_rank_publication_source_evidence (
  score_cohort_id uuid NOT NULL,
  season_id text NOT NULL CHECK (season_id IN ('7D', '30D', '90D')),
  source text NOT NULL CHECK (source ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  evidence_grade text NOT NULL CHECK (evidence_grade IN ('attempt_bound', 'count_check_only')),
  snapshot_ids bigint[] NOT NULL CHECK (pg_catalog.cardinality(snapshot_ids) BETWEEN 1 AND 64),
  raw_object_ids bigint[] NOT NULL DEFAULT '{}',
  source_run_ids text[] NOT NULL DEFAULT '{}',
  manifest_raw_object_ids bigint[] NOT NULL DEFAULT '{}',
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  PRIMARY KEY (score_cohort_id, source),
  FOREIGN KEY (score_cohort_id, season_id)
    REFERENCES arena.leaderboard_rank_publications (id, season_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_arena_rank_publication_evidence_snapshots
  ON arena.leaderboard_rank_publication_source_evidence USING gin (snapshot_ids);

CREATE OR REPLACE FUNCTION arena.reject_rank_publication_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'rank publication evidence is immutable' USING ERRCODE = '42501';
END;
$function$;

DROP TRIGGER IF EXISTS rank_publication_evidence_immutable
  ON arena.leaderboard_rank_publication_source_evidence;
CREATE TRIGGER rank_publication_evidence_immutable
  BEFORE UPDATE OR DELETE ON arena.leaderboard_rank_publication_source_evidence
  FOR EACH ROW EXECUTE FUNCTION arena.reject_rank_publication_evidence_mutation();

ALTER TABLE arena.leaderboard_rank_publication_source_evidence OWNER TO postgres;
ALTER FUNCTION arena.reject_rank_publication_evidence_mutation() OWNER TO postgres;
ALTER TABLE arena.leaderboard_rank_publication_source_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE arena.leaderboard_rank_publication_source_evidence
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE arena.leaderboard_rank_publication_source_evidence TO service_role;
REVOKE ALL ON FUNCTION arena.reject_rank_publication_evidence_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

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
  v_trusted_count integer;
  v_grade text;
  v_grades jsonb := '{}'::jsonb;
  v_has_trust boolean := pg_catalog.to_regclass('arena.metric_trust_runs') IS NOT NULL;
BEGIN
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

    SELECT pg_catalog.count(*)::integer,
           COALESCE(
             pg_catalog.array_agg(DISTINCT snapshot.raw_object_id)
               FILTER (WHERE snapshot.raw_object_id IS NOT NULL),
             '{}'
           )
    INTO v_valid_count, v_raw_object_ids
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

    v_run_ids := '{}';
    v_manifest_ids := '{}';
    v_trusted_count := 0;
    IF v_has_trust THEN
      EXECUTE
        'SELECT COALESCE(pg_catalog.array_agg(DISTINCT run.source_run_id), ''{}''),
                COALESCE(pg_catalog.array_agg(DISTINCT run.manifest_raw_object_id), ''{}''),
                pg_catalog.count(DISTINCT run.snapshot_id)::integer
           FROM arena.metric_trust_runs AS run
          WHERE run.snapshot_id = ANY ($1)'
      INTO v_run_ids, v_manifest_ids, v_trusted_count
      USING v_snapshot_ids;
    END IF;
    v_grade := CASE
      WHEN v_trusted_count = pg_catalog.cardinality(v_snapshot_ids) THEN 'attempt_bound'
      ELSE 'count_check_only'
    END;

    INSERT INTO arena.leaderboard_rank_publication_source_evidence (
      score_cohort_id, season_id, source, evidence_grade, snapshot_ids,
      raw_object_ids, source_run_ids, manifest_raw_object_ids
    ) VALUES (
      p_score_cohort_id, p_season_id, v_item.source, v_grade, v_snapshot_ids,
      v_raw_object_ids, v_run_ids, v_manifest_ids
    );
    v_grades := v_grades || pg_catalog.jsonb_build_object(v_item.source, v_grade);
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-rank-publication-evidence@1',
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

-- Public evidence level of the currently served seasons.
CREATE OR REPLACE VIEW public.public_ranked_leaderboard_source_evidence
WITH (security_barrier = true, security_invoker = false)
AS
SELECT witness.season_id,
       witness.source,
       evidence.evidence_grade,
       witness.source_as_of
FROM arena.public_ranked_leaderboard_serving_seasons(pg_catalog.statement_timestamp()) AS serving
JOIN ONLY arena.public_ranked_leaderboard_serving_heads AS head
  ON head.season_id = serving.season_id
JOIN ONLY arena.public_ranked_leaderboard_serving_sources AS witness
  ON witness.season_id = head.season_id
 AND witness.score_cohort_id = head.score_cohort_id
LEFT JOIN arena.leaderboard_rank_publication_source_evidence AS evidence
  ON evidence.score_cohort_id = head.score_cohort_id
 AND evidence.source = witness.source;

ALTER VIEW public.public_ranked_leaderboard_source_evidence OWNER TO postgres;
REVOKE ALL ON public.public_ranked_leaderboard_source_evidence
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.public_ranked_leaderboard_source_evidence
  TO anon, authenticated, service_role;

-- Keep evidence snapshots under the snapshot retention policy.
DO $retention$
BEGIN
  IF EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid =
              pg_catalog.to_regprocedure('arena.prune_leaderboard_snapshots(integer,integer)')
          AND pg_catalog.strpos(function_row.prosrc,
                'leaderboard_rank_publication_source_evidence') = 0
     ) THEN
    EXECUTE pg_catalog.replace(
      pg_catalog.pg_get_functiondef(
        'arena.prune_leaderboard_snapshots(integer,integer)'::pg_catalog.regprocedure
      ),
      '      AND NOT EXISTS (
        SELECT 1 FROM arena.tier_a_execution_window_receipts AS receipt',
      '      AND NOT EXISTS (
        SELECT 1 FROM arena.leaderboard_rank_publication_source_evidence AS evidence
        WHERE evidence.snapshot_ids @> ARRAY[snapshot.id]
      )
      AND NOT EXISTS (
        SELECT 1 FROM arena.tier_a_execution_window_receipts AS receipt'
    );
    IF pg_catalog.strpos(
         (SELECT function_row.prosrc FROM pg_catalog.pg_proc AS function_row
           WHERE function_row.oid =
             'arena.prune_leaderboard_snapshots(integer,integer)'::pg_catalog.regprocedure),
         'leaderboard_rank_publication_source_evidence'
       ) = 0 THEN
      RAISE EXCEPTION 'snapshot retention did not take the evidence pin';
    END IF;
  END IF;
END
$retention$;

NOTIFY pgrst, 'reload schema';

COMMIT;
