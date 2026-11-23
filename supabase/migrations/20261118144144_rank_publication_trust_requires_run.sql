-- Migration: 20261118144144_rank_publication_trust_requires_run.sql
-- Description: public.rank_publication_trust_evidence grades a board
--   trust_bound only when its own metric-trust run still exists and the
--   board is not inside trust evidence retention.
--
-- Before (20261115141050): trust_bound = a complete / exhausted attempt-bound
-- acquisition outcome whose source payload is the board's RAW. Outcomes are
-- small append-only digests that trust evidence retention (20261118135918)
-- keeps forever, so a superseded daily representative kept without its runs
-- (disposition runs_only), or a board whose purge is in progress, would still
-- grade trust_bound = true if anybody passed its id. Today only the
-- publication orchestrator calls it, with the latest boards; this removes the
-- reliance on that convention.
--
-- After: trust_bound additionally requires
--   * an arena.metric_trust_runs row for this snapshot whose source_run_id is
--     the bound outcome's (the run trigger already forces that equality on
--     insert), and
--   * no arena.trust_evidence_retention_purges row for this snapshot that is
--     in_progress or runs_only.
-- Every other column and the outcome selection are unchanged (body otherwise
-- verbatim). Callers: lib/rankings/publication/publish-season.ts
-- readUntrustedSources (isolates untrusted sources) and the deferred seal
-- check; a board losing trust is isolated / refused, never published.
--
-- Guards: the current body must be the reviewed 20261115141050 body (prosrc
-- sha256 7f3b059f61c28a767e19f25b68a78e1154877fc9617760275b01a5187aa4a7c8) or this migration's own (replay); the only function-level
-- setting stays search_path. Depends on 20261118135918 (retention audit
-- table). Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure('public.rank_publication_trust_evidence(bigint[])') IS NULL
     OR pg_catalog.to_regclass('arena.metric_trust_runs') IS NULL
     OR pg_catalog.to_regclass('arena.trust_evidence_retention_purges') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_outcomes') IS NULL
     OR pg_catalog.to_regprocedure('arena.leaderboard_outcome_exhaustion_bound(bigint)') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION
      'trust-requires-run needs the attempt-bound evidence chain (20261115141050) and trust evidence retention (20261118135918)';
  END IF;
END
$preflight$;

DO $trust_evidence_digest$
DECLARE
  v_sha256 text;
BEGIN
  SELECT pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')), 'hex')
  INTO STRICT v_sha256
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
        pg_catalog.to_regprocedure('public.rank_publication_trust_evidence(bigint[])');

  IF v_sha256 NOT IN (
    -- after 20261115141050
    '7f3b059f61c28a767e19f25b68a78e1154877fc9617760275b01a5187aa4a7c8',
    -- this migration (replay)
    'a2ab3a86ac64f10c86f0a2e6af640c97b7af1b7ebf0e668581270033dfe93ed5'
  ) THEN
    RAISE EXCEPTION
      'rank_publication_trust_evidence body drifted from the reviewed 20261115141050 body: %',
      v_sha256;
  END IF;
END
$trust_evidence_digest$;

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
         -- rank-publication-trust-requires-run@1: an outcome alone is not
         -- enough. The board's own metric-trust run must still exist, and the
         -- board must not be inside trust evidence retention (a purge in
         -- progress, or a daily representative kept without its runs).
         bound.source_run_id IS NOT NULL
           AND EXISTS (
             SELECT 1
               FROM arena.metric_trust_runs AS run
              WHERE run.snapshot_id = snapshot.id
                AND run.source_run_id = bound.source_run_id
           )
           AND NOT EXISTS (
             SELECT 1
               FROM arena.trust_evidence_retention_purges AS purge
              WHERE purge.snapshot_id = snapshot.id
                AND (purge.state = 'in_progress' OR purge.disposition = 'runs_only')
           ),
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
      AND outcome.source_run_id IS NOT NULL
      AND outcome.manifest_raw_object_id IS NOT NULL
      AND outcome.source_payload_raw_object_id = snapshot.raw_object_id
      -- Completeness mode: a complete outcome (reported total equal to the
      -- accepted rows), or an exhausted outcome whose recorded proof holds.
      AND (
        outcome.terminal_state = 'complete'
        OR arena.leaderboard_outcome_exhaustion_bound(outcome.attempt_seq)
      )
    ORDER BY outcome.attempt_seq DESC
    LIMIT 1
  ) AS bound ON true
  ORDER BY requested.id
$function$;

ALTER FUNCTION public.rank_publication_trust_evidence(bigint[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.rank_publication_trust_evidence(bigint[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rank_publication_trust_evidence(bigint[]) TO service_role;

DO $postflight$
DECLARE
  v_function oid := pg_catalog.to_regprocedure('public.rank_publication_trust_evidence(bigint[])');
  v_row pg_catalog.pg_proc%ROWTYPE;
BEGIN
  SELECT function_row.* INTO STRICT v_row
    FROM pg_catalog.pg_proc AS function_row
   WHERE function_row.oid = v_function;
  IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_row.prosrc, 'UTF8')), 'hex')
       <> 'a2ab3a86ac64f10c86f0a2e6af640c97b7af1b7ebf0e668581270033dfe93ed5'
     OR v_row.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
     OR NOT v_row.prosecdef
     OR v_row.provolatile <> 's'
     OR v_row.proowner <> 'postgres'::pg_catalog.regrole
     OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE') THEN
    RAISE EXCEPTION 'rank_publication_trust_evidence did not take the reviewed trust-requires-run shape';
  END IF;
END
$postflight$;

COMMIT;
