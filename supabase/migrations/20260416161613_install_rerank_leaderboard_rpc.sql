-- Migration: 20260416161613_install_rerank_leaderboard_rpc.sql
-- Created: 2026-04-16
-- Description: install rerank_leaderboard(season) RPC — fixes rank integrity
--
-- Root cause: compute-leaderboard's incremental upsert assigns `rank` from the
-- scored-array index, but only upserts rows whose score/rank CHANGED. When a
-- mid-rank trader's score improves, their new rank is written, but other
-- traders at that new rank are NOT updated — producing duplicate rank
-- values and inversions (rank 1 with score 99.98, rank 2 with score 99.99).
--
-- Evidence (audit 2026-04-16):
--   7D  : 14803 rows, 5664 distinct ranks, 9139 duplicates
--   30D : 13552 rows, 5045 distinct ranks, 8507 duplicates
--   90D :  9510 rows, 3246 distinct ranks, 6264 duplicates
--   Global arena_score inversions (score up but rank up): 1941 (7D), 1606 (30D), 930 (90D)
--
-- Fix: a SET-based RPC re-assigns `rank` from ROW_NUMBER() OVER (ORDER BY
-- arena_score DESC), in a single transaction — atomic, race-free, ~200ms for
-- 15K rows. rerankAllRows() already calls this RPC; it was missing, so the
-- inline batched fallback ran — but the fallback's batched UPSERTs race with
-- concurrent incremental upserts. A single SQL statement eliminates the race.

CREATE OR REPLACE FUNCTION public.rerank_leaderboard(p_season_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer;
BEGIN
  -- Assign rank = ROW_NUMBER() over arena_score DESC (ties broken by id for
  -- determinism). Only touch rows whose current rank differs to minimize
  -- write amplification / index churn. Updates run in a single statement so
  -- no other writer can observe a half-reranked state.
  WITH ordered AS (
    SELECT
      id,
      ROW_NUMBER() OVER (ORDER BY arena_score DESC NULLS LAST, id)::integer AS new_rank
    FROM public.leaderboard_ranks
    WHERE season_id = p_season_id
  )
  UPDATE public.leaderboard_ranks lr
  SET rank = o.new_rank
  FROM ordered o
  WHERE lr.id = o.id
    AND lr.rank IS DISTINCT FROM o.new_rank;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

-- Only the service role needs this (called from compute-leaderboard cron).
REVOKE ALL ON FUNCTION public.rerank_leaderboard(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rerank_leaderboard(text) TO service_role;

COMMENT ON FUNCTION public.rerank_leaderboard(text) IS
'Atomically re-rank leaderboard_ranks rows for a season by arena_score DESC. Returns number of rows whose rank changed.';
