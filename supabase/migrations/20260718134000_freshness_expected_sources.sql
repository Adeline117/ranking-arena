-- Independent freshness membership authority.
--
-- arena_visible_sources intentionally returns only boards that have a positive
-- row in the current leaderboard count-cache generation. That makes it the
-- right public navigation contract, but the wrong expected set for monitoring:
-- a serving source whose cache disappears or falls to zero would disappear
-- from the monitor too. This RPC returns every active+serving declared ranking
-- window without consulting ranks, count caches, snapshots, or watermarks.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE OR REPLACE FUNCTION public.arena_freshness_expected_sources()
RETURNS TABLE (
  registry_slug text,
  filter_source text,
  exchange_name text,
  season_id text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, arena, pg_temp
AS $$
  SELECT
    source_row.slug AS registry_slug,
    COALESCE(
      NULLIF(pg_catalog.btrim(source_row.meta->>'legacy_platform'), ''),
      source_row.slug
    ) AS filter_source,
    exchange_row.name AS exchange_name,
    (timeframe.day_count::text || 'D') AS season_id
  FROM arena.sources AS source_row
  JOIN arena.exchanges AS exchange_row
    ON exchange_row.id = source_row.exchange_id
  CROSS JOIN LATERAL (
    SELECT DISTINCT declared.day_count
    FROM unnest(
      source_row.timeframes_native || source_row.timeframes_derived
    ) AS declared(day_count)
    WHERE declared.day_count IN (7, 30, 90)
  ) AS timeframe
  WHERE source_row.status = 'active'
    AND source_row.serving_mode = 'serving'
    -- Historical registry imports used the JSON string "null" as a sentinel.
    -- Score inputs and source-watermark publication exclude it too.
    AND pg_catalog.btrim(
      COALESCE(source_row.meta->>'legacy_platform', '')
    ) <> 'null'
  ORDER BY
    exchange_row.name,
    source_row.slug,
    timeframe.day_count;
$$;

REVOKE ALL ON FUNCTION public.arena_freshness_expected_sources()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arena_freshness_expected_sources()
  TO service_role;

COMMENT ON FUNCTION public.arena_freshness_expected_sources() IS
  'Active+serving declared 7D/30D/90D registry promises. Independent of leaderboard counts and source watermarks.';

NOTIFY pgrst, 'reload schema';

COMMIT;
