-- Rebuild the leaderboard count cache as one atomic generation.
--
-- The previous function only UPSERTed keys that still existed in
-- leaderboard_ranks. When a source or season disappeared, its old positive
-- count remained forever and APIs advertised empty/retired boards as live.
-- A function call already runs in one transaction, so readers see either the
-- complete old generation or the complete new generation, never the DELETE in
-- between.

CREATE OR REPLACE FUNCTION public.refresh_leaderboard_count_cache()
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
SET statement_timeout = '10s'
AS $$
BEGIN
  -- Serialize cron/manual rebuilds so concurrent callers cannot interleave
  -- their DELETE/INSERT generations.
  PERFORM pg_advisory_xact_lock(hashtext('refresh_leaderboard_count_cache'));

  DELETE FROM public.leaderboard_count_cache;

  -- Quality threshold retained for legacy consumers.
  INSERT INTO public.leaderboard_count_cache (season_id, source, total_count, updated_at)
  SELECT season_id, '_all', COUNT(*), NOW()
  FROM public.leaderboard_ranks
  WHERE arena_score > 10 AND (is_outlier IS NULL OR is_outlier = false)
  GROUP BY season_id;

  INSERT INTO public.leaderboard_count_cache (season_id, source, total_count, updated_at)
  SELECT season_id, source, COUNT(*), NOW()
  FROM public.leaderboard_ranks
  WHERE arena_score > 10 AND (is_outlier IS NULL OR is_outlier = false)
  GROUP BY season_id, source;

  -- Serving threshold: every row visible to /api/traders and /api/rankings.
  INSERT INTO public.leaderboard_count_cache (season_id, source, total_count, updated_at)
  SELECT season_id, '_all_gt0', COUNT(*), NOW()
  FROM public.leaderboard_ranks
  WHERE arena_score > 0 AND (is_outlier IS NULL OR is_outlier = false)
  GROUP BY season_id;

  INSERT INTO public.leaderboard_count_cache (season_id, source, total_count, updated_at)
  SELECT season_id, source || '_gt0', COUNT(*), NOW()
  FROM public.leaderboard_ranks
  WHERE arena_score > 0 AND (is_outlier IS NULL OR is_outlier = false)
  GROUP BY season_id, source;
END;
$$;

-- Remove historical orphan keys immediately instead of waiting for the next
-- successful compute-leaderboard run.
SELECT public.refresh_leaderboard_count_cache();
