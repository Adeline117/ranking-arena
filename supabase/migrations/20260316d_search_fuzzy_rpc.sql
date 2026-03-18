-- Migration: Fuzzy search with platform popularity boost
-- Uses pg_trgm + leaderboard_ranks to prioritize high-score, high-follower traders

CREATE EXTENSION IF NOT EXISTS pg_trgm;
SELECT set_limit(0.15);

-- Fuzzy search: text similarity + arena_score + followers boost
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
  relevance_score float
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
      -- Platform popularity boost
      + COALESCE(lr.arena_score, 0) * 2.0
      + LEAST(COALESCE(lr.followers, 0), 500) * 0.1
    ) AS relevance_score
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

-- "Did you mean" with popularity boost — suggests well-known traders first
CREATE OR REPLACE FUNCTION search_did_you_mean(
  search_query text,
  suggestion_limit int DEFAULT 5
)
RETURNS TABLE(
  suggested_query text,
  similarity_score float
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    sub.handle AS suggested_query,
    sub.combined_score::float AS similarity_score
  FROM (
    SELECT DISTINCT ON (lower(ts.handle))
      ts.handle,
      (
        GREATEST(
          similarity(COALESCE(ts.handle, ''), search_query),
          similarity(ts.source_trader_id, search_query)
        )
        + CASE WHEN lr.arena_score > 80 THEN 0.3
               WHEN lr.arena_score > 50 THEN 0.2
               WHEN lr.arena_score > 20 THEN 0.1
               ELSE 0.0
          END
        + CASE WHEN COALESCE(lr.followers, 0) > 100 THEN 0.15
               WHEN COALESCE(lr.followers, 0) > 10 THEN 0.05
               ELSE 0.0
          END
      ) AS combined_score
    FROM trader_sources ts
    LEFT JOIN leaderboard_ranks lr
      ON lr.source = ts.source
      AND lr.source_trader_id = ts.source_trader_id
      AND lr.season_id = '90D'
    WHERE
      ts.handle IS NOT NULL
      AND length(ts.handle) > 1
      AND (
        similarity(ts.handle, search_query) > 0.15
        OR similarity(ts.source_trader_id, search_query) > 0.15
      )
      AND lower(ts.handle) != lower(trim(search_query))
    ORDER BY lower(ts.handle), combined_score DESC
  ) sub
  ORDER BY sub.combined_score DESC
  LIMIT suggestion_limit;
END;
$$;

-- Click-through tracking columns
ALTER TABLE search_analytics ADD COLUMN IF NOT EXISTS clicked_result_id text;
ALTER TABLE search_analytics ADD COLUMN IF NOT EXISTS clicked_result_type text;

-- Index for popular query aggregation
CREATE INDEX IF NOT EXISTS idx_search_analytics_query_btree
  ON search_analytics(lower(query), created_at DESC);
