-- Fix get_hero_stats() RPC — was counting ALL rows across ALL seasons
-- instead of just the 90D season visible on the rankings page.
-- This caused the hero to show 75K+ when actual ranked count is ~17K.

CREATE OR REPLACE FUNCTION public.get_hero_stats()
 RETURNS TABLE(exchange_count bigint, trader_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path = public
AS $$
  SELECT
    COUNT(DISTINCT source) AS exchange_count,
    COUNT(*) AS trader_count
  FROM leaderboard_ranks
  WHERE season_id = '90D'
    AND arena_score > 0
    AND (is_outlier IS NULL OR is_outlier = false);
$$;
