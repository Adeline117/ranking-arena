-- Perf: search_traders_fuzzy now returns arena_score/roi/pnl/rank/trader_type
-- from the leaderboard_ranks JOIN it already does. This eliminates a serial
-- second query in the search API (~200ms saved per search).

DROP FUNCTION IF EXISTS search_traders_fuzzy(text, integer, text);

CREATE OR REPLACE FUNCTION search_traders_fuzzy(
  search_query text,
  result_limit int DEFAULT 20,
  platform_filter text DEFAULT NULL
)
RETURNS TABLE(
  source_trader_id text,
  handle text,
  source text,
  avatar_url text,
  relevance_score float8,
  arena_score numeric,
  roi numeric,
  pnl numeric,
  rank int,
  trader_type text
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  q text := lower(trim(search_query));
BEGIN
  RETURN QUERY
  SELECT
    ts.source_trader_id,
    ts.handle,
    ts.source,
    ts.avatar_url,
    (
      CASE WHEN lower(ts.handle) = q THEN 10000.0
           WHEN lower(ts.source_trader_id) = q THEN 9000.0
           ELSE 0.0
      END
      +
      CASE WHEN lower(ts.handle) LIKE q || '%' THEN 1000.0
           WHEN lower(ts.source_trader_id) LIKE q || '%' THEN 800.0
           ELSE 0.0
      END
      +
      CASE WHEN lower(ts.handle) LIKE '%' || q || '%' THEN 100.0
           WHEN lower(ts.source_trader_id) LIKE '%' || q || '%' THEN 80.0
           ELSE 0.0
      END
      +
      GREATEST(
        similarity(COALESCE(ts.handle, ''), search_query),
        similarity(ts.source_trader_id, search_query)
      ) * 50.0
      + COALESCE(lr.arena_score, 0)::float8 * 2.0
      + LEAST(COALESCE(lr.followers, 0), 500)::float8 * 0.1
    ) AS relevance_score,
    lr.arena_score,
    lr.roi,
    lr.pnl,
    lr.rank::int,
    lr.trader_type
  FROM trader_sources ts
  LEFT JOIN leaderboard_ranks lr
    ON lr.source = ts.source
    AND lr.source_trader_id = ts.source_trader_id
    AND lr.season_id = '90D'
  WHERE
    (platform_filter IS NULL OR ts.source = platform_filter)
    AND (
      ts.handle ILIKE '%' || q || '%'
      OR ts.source_trader_id ILIKE '%' || q || '%'
      OR similarity(COALESCE(ts.handle, ''), search_query) > 0.15
      OR similarity(ts.source_trader_id, search_query) > 0.15
    )
  ORDER BY relevance_score DESC
  LIMIT result_limit;
END;
$$;
