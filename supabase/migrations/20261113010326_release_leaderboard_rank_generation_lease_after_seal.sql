-- Release a season's generation lease in the same transaction that sealed it.
--
-- claim_leaderboard_rank_generation (20260725015500) leaves the season head in
-- phase 'claimed' with a lease; the direct-write publication route (method A,
-- docs/RANK_PUBLICATION_PROTOCOL.md) never moves it on, so after COMMIT the
-- lease keeps blocking every other publication of that season until it
-- expires (55P03 "another leaderboard generation owns the active lease").
--
-- public.release_leaderboard_rank_generation_lease(season, cohort) moves the
-- head to the terminal phase 'sealed' (lease NULL), which the head CHECK
-- already allows and which the claim treats as free. It is bound to the run
-- that owns it:
--   * the head must still be this cohort's claim (same generation, phase
--     'claimed', lease matching the immutable claim row);
--   * this transaction itself must have inserted the cohort's immutable seal
--     receipt (arena.leaderboard_rank_publications.xmin = current xact), so a
--     lease can never be released for an unsealed or someone else's cohort;
--   * the public serving head must already point at this cohort.
-- A failure raises and rolls back the whole publication with it.
--
-- Owner-only definer; EXECUTE for service_role only. No table ACL changes.
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.leaderboard_rank_generation_heads') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_rank_generation_claims') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_rank_publications') IS NULL
     OR pg_catalog.to_regclass('arena.public_ranked_leaderboard_serving_heads') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'
     ) IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION
      'lease release requires the generation claim, seal receipt and serving head foundations';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.release_leaderboard_rank_generation_lease(
  p_season_id text,
  p_score_cohort_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_head arena.leaderboard_rank_generation_heads%ROWTYPE;
  v_claim arena.leaderboard_rank_generation_claims%ROWTYPE;
  v_now timestamptz;
  v_updated integer;
BEGIN
  IF p_season_id IS NULL OR p_season_id NOT IN ('7D', '30D', '90D') THEN
    RAISE EXCEPTION 'invalid generation season: %', p_season_id
      USING ERRCODE = '22023';
  END IF;
  IF p_score_cohort_id IS NULL THEN
    RAISE EXCEPTION 'generation score cohort is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT head.*
  INTO STRICT v_head
  FROM ONLY arena.leaderboard_rank_generation_heads AS head
  WHERE head.season_id = p_season_id
  FOR UPDATE;

  IF v_head.score_cohort_id IS DISTINCT FROM p_score_cohort_id
     OR v_head.phase IS DISTINCT FROM 'claimed' THEN
    RAISE EXCEPTION 'generation head is not this cohort''s active claim'
      USING ERRCODE = '55000';
  END IF;

  SELECT claim.*
  INTO STRICT v_claim
  FROM ONLY arena.leaderboard_rank_generation_claims AS claim
  WHERE claim.season_id = v_head.season_id
    AND claim.generation_seq = v_head.generation_seq
    AND claim.score_cohort_id = v_head.score_cohort_id;
  IF v_head.lease_expires_at IS DISTINCT FROM v_claim.lease_expires_at THEN
    RAISE EXCEPTION 'active generation head lease disagrees with its claim'
      USING ERRCODE = '55000';
  END IF;

  -- Bound to the run: only the transaction that inserted the immutable seal
  -- receipt for this cohort may release the cohort's lease.
  IF NOT EXISTS (
    SELECT 1
    FROM ONLY arena.leaderboard_rank_publications AS publication
    WHERE publication.id = p_score_cohort_id
      AND publication.season_id = p_season_id
      AND publication.xmin = pg_catalog.pg_current_xact_id()::pg_catalog.xid
  ) THEN
    RAISE EXCEPTION 'generation lease may be released only by the transaction that sealed it'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM ONLY arena.public_ranked_leaderboard_serving_heads AS serving
    WHERE serving.season_id = p_season_id
      AND serving.score_cohort_id = p_score_cohort_id
  ) THEN
    RAISE EXCEPTION 'sealed cohort is not the season serving head'
      USING ERRCODE = '55000';
  END IF;

  v_now := pg_catalog.clock_timestamp();
  UPDATE ONLY arena.leaderboard_rank_generation_heads AS head
  SET phase = 'sealed',
      lease_expires_at = NULL,
      updated_at = v_now
  WHERE head.season_id = p_season_id
    AND head.generation_seq = v_head.generation_seq
    AND head.score_cohort_id = p_score_cohort_id
    AND head.phase = 'claimed';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'generation head lease release did not update exactly one row'
      USING ERRCODE = '55000';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-rank-generation-lease-release@1',
    'season_id', p_season_id,
    'score_cohort_id', p_score_cohort_id,
    'generation_seq', v_head.generation_seq,
    'phase', 'sealed'
  );
END;
$function$;

ALTER FUNCTION public.release_leaderboard_rank_generation_lease(text, uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.release_leaderboard_rank_generation_lease(text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_leaderboard_rank_generation_lease(text, uuid)
  TO service_role;

COMMENT ON FUNCTION public.release_leaderboard_rank_generation_lease(text, uuid) IS
  'Move a season generation head from claimed to sealed (lease NULL) inside the transaction that sealed the cohort. Bound to that cohort and transaction.';

NOTIFY pgrst, 'reload schema';

COMMIT;
