-- Migration: visible_sources_from_served_ranks
-- Description: public.arena_visible_sources() counts the ranks the public view
--   serves instead of reading public.leaderboard_count_cache.
--
-- Why: the function joined each source's '<source>_gt0' count-cache row to the
--   '_all_gt0' generation row. That cache is only rebuilt by
--   refresh_public_rank_count_cache_for_seasons(), which the sealed
--   publication path never calls. In production on 2026-11-22 the cache held
--   no '_gt0' row at all, so the function returned zero rows for every season
--   while the public view served 3,546 90D ranks from 7 sources. Consequences:
--   /api/health reported every source that HAS ranks as unknown
--   (recordCount 0, not_visible) and only zero-row sources as fresh; the
--   homepage exchange list and /api/sources/visible were empty.
--
-- What changes: the count comes from public.public_ranked_leaderboard, the
--   same sealed, fenced view the rankings read, so "visible" cannot drift from
--   what is served and needs no refresh step. cache_updated_at becomes the
--   source's publication time (leaderboard_source_freshness.recorded_at).
--   Signature, returned columns, registry filters, ordering, owner, SECURITY
--   DEFINER and grants are unchanged.
--
-- POSTDEPLOY; no application or worker release depends on it.
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

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
  WITH served AS (
    SELECT ranked.source, pg_catalog.count(*)::integer AS trader_count
    FROM public.public_ranked_leaderboard AS ranked
    WHERE ranked.season_id = p_season_id
    GROUP BY ranked.source
  )
  SELECT
    source_row.slug AS registry_slug,
    COALESCE(NULLIF(source_row.meta->>'legacy_platform', ''), source_row.slug) AS filter_source,
    exchange_row.slug AS exchange_slug,
    exchange_row.name AS exchange_name,
    source_row.product_type,
    served.trader_count,
    freshness.recorded_at AS cache_updated_at
  FROM arena.sources AS source_row
  JOIN arena.exchanges AS exchange_row ON exchange_row.id = source_row.exchange_id
  JOIN served
    ON served.source =
       COALESCE(NULLIF(source_row.meta->>'legacy_platform', ''), source_row.slug)
  LEFT JOIN public.leaderboard_source_freshness AS freshness
    ON freshness.season_id = p_season_id
   AND freshness.source = served.source
  WHERE p_season_id IN ('7D', '30D', '90D')
    AND source_row.status = 'active'
    AND source_row.serving_mode = 'serving'
    AND served.trader_count > 0
  ORDER BY exchange_row.name, source_row.product_type, source_row.slug;
$$;

REVOKE ALL ON FUNCTION public.arena_visible_sources(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.arena_visible_sources(text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.arena_visible_sources(text) IS
  'Active serving registry sources with ranks served by public_ranked_leaderboard in the requested 7D/30D/90D season.';

COMMIT;
