-- Public read contract for sources that can actually return leaderboard rows.
-- Keeps arena registry slugs separate from the legacy filter aliases currently
-- stored in public.leaderboard_ranks.

CREATE OR REPLACE FUNCTION public.arena_visible_sources(p_season_id text DEFAULT '90D')
RETURNS TABLE (
  registry_slug text,
  filter_source text,
  exchange_slug text,
  exchange_name text,
  product_type text,
  trader_count integer,
  cache_updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, arena, pg_temp
AS $$
  WITH generation AS (
    SELECT updated_at
    FROM public.leaderboard_count_cache
    WHERE season_id = p_season_id
      AND source = '_all_gt0'
    LIMIT 1
  )
  SELECT
    source_row.slug AS registry_slug,
    COALESCE(NULLIF(source_row.meta->>'legacy_platform', ''), source_row.slug) AS filter_source,
    exchange_row.slug AS exchange_slug,
    exchange_row.name AS exchange_name,
    source_row.product_type,
    count_row.total_count AS trader_count,
    count_row.updated_at AS cache_updated_at
  FROM arena.sources AS source_row
  JOIN arena.exchanges AS exchange_row ON exchange_row.id = source_row.exchange_id
  JOIN public.leaderboard_count_cache AS count_row
    ON count_row.season_id = p_season_id
   AND count_row.source =
     COALESCE(NULLIF(source_row.meta->>'legacy_platform', ''), source_row.slug) || '_gt0'
  JOIN generation ON generation.updated_at = count_row.updated_at
  WHERE p_season_id IN ('7D', '30D', '90D')
    AND source_row.status = 'active'
    AND source_row.serving_mode = 'serving'
    AND count_row.total_count > 0
  ORDER BY exchange_row.name, source_row.product_type, source_row.slug;
$$;

REVOKE ALL ON FUNCTION public.arena_visible_sources(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.arena_visible_sources(text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.arena_visible_sources(text) IS
  'Active serving registry sources with score-visible public leaderboard rows in the requested 7D/30D/90D generation.';
