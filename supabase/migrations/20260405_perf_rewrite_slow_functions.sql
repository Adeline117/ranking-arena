-- Performance: rewrite 2 slowest DB functions (measured via pg_stat_statements)
--
-- 1. fill_null_pnl_from_siblings: 7.4s avg → CTE join (was correlated subquery+EXISTS)
-- 2. update_post_velocity: 71ms avg × 13K calls → JOIN + early exit (was N+1 correlated)

-- (1) fill_null_pnl_from_siblings: CTE join instead of correlated subquery+EXISTS
CREATE OR REPLACE FUNCTION public.fill_null_pnl_from_siblings()
 RETURNS integer
 LANGUAGE plpgsql
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  updated_count INTEGER := 0;
BEGIN
  WITH candidates AS (
    SELECT id, platform, trader_key, "window"
    FROM trader_snapshots_v2
    WHERE pnl_usd IS NULL
      AND updated_at > NOW() - INTERVAL '72 hours'
      AND roi_pct IS NOT NULL
  ),
  best_sibling AS (
    SELECT DISTINCT ON (c.id) c.id, sv2.pnl_usd
    FROM candidates c
    JOIN trader_snapshots_v2 sv2
      ON sv2.platform = c.platform
      AND sv2.trader_key = c.trader_key
      AND sv2."window" != c."window"
      AND sv2.pnl_usd IS NOT NULL
      AND sv2.updated_at > NOW() - INTERVAL '7 days'
    ORDER BY c.id, sv2.updated_at DESC
  )
  UPDATE trader_snapshots_v2 t
  SET pnl_usd = s.pnl_usd
  FROM best_sibling s
  WHERE t.id = s.id;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$function$;

-- (2) update_post_velocity: JOIN-based + early exit guard
CREATE OR REPLACE FUNCTION public.update_post_velocity()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE updated_count INTEGER;
BEGIN
  -- Early exit: skip if no posts in last 7 days
  IF NOT EXISTS (SELECT 1 FROM posts WHERE created_at > NOW() - INTERVAL '7 days' LIMIT 1) THEN
    RETURN 0;
  END IF;

  -- JOIN-based update: scans post_reactions and comments once each
  -- (was: correlated subquery per post = N+1 pattern)
  UPDATE posts p SET
    likes_last_hour = COALESCE(pr_agg.cnt, 0),
    comments_last_hour = COALESCE(c_agg.cnt, 0),
    velocity_updated_at = NOW()
  FROM (SELECT id FROM posts WHERE created_at > NOW() - INTERVAL '7 days') target
  LEFT JOIN LATERAL (
    SELECT COUNT(*) as cnt FROM post_reactions pr
    WHERE pr.post_id = target.id AND pr.reaction_type = 'up'
      AND pr.created_at > NOW() - INTERVAL '1 hour'
  ) pr_agg ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*) as cnt FROM comments c
    WHERE c.post_id = target.id
      AND c.created_at > NOW() - INTERVAL '1 hour'
  ) c_agg ON true
  WHERE p.id = target.id;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$function$;
