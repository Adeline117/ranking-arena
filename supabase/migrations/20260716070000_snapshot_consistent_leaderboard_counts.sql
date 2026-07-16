-- Keep all four leaderboard count families on one leaderboard_ranks snapshot.
-- A single INSERT statement uses one READ COMMITTED statement snapshot even
-- when another season finishes publishing during the refresh transaction.

CREATE OR REPLACE FUNCTION public.refresh_leaderboard_count_cache()
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
SET statement_timeout = '10s'
AS $$
BEGIN
  LOCK TABLE public.leaderboard_count_cache IN SHARE ROW EXCLUSIVE MODE;

  DELETE FROM public.leaderboard_count_cache;

  INSERT INTO public.leaderboard_count_cache (season_id, source, total_count, updated_at)
  SELECT season_id, '_all', COUNT(*), NOW()
  FROM public.leaderboard_ranks
  WHERE arena_score > 10 AND (is_outlier IS NULL OR is_outlier = false)
  GROUP BY season_id

  UNION ALL

  SELECT season_id, source, COUNT(*), NOW()
  FROM public.leaderboard_ranks
  WHERE arena_score > 10 AND (is_outlier IS NULL OR is_outlier = false)
  GROUP BY season_id, source

  UNION ALL

  SELECT season_id, '_all_gt0', COUNT(*), NOW()
  FROM public.leaderboard_ranks
  WHERE arena_score > 0 AND (is_outlier IS NULL OR is_outlier = false)
  GROUP BY season_id

  UNION ALL

  SELECT season_id, source || '_gt0', COUNT(*), NOW()
  FROM public.leaderboard_ranks
  WHERE arena_score > 0 AND (is_outlier IS NULL OR is_outlier = false)
  GROUP BY season_id, source;
END;
$$;

SELECT public.refresh_leaderboard_count_cache();
