-- Make the source registry, rather than historical snapshots or a TypeScript
-- allowlist, authoritative for pipeline health.
--
-- Active sources with no snapshots must remain visible with latest = NULL so
-- the monitor can fail loudly. Inactive, dropped, blocked, and retired sources
-- must not appear merely because they still have archived snapshot history.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_platform_freshness()
RETURNS TABLE(source text, latest timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
  SELECT
    COALESCE(
      NULLIF(pg_catalog.btrim(source_row.meta->>'legacy_platform'), ''),
      source_row.slug
    ) AS source,
    max(snapshot.scraped_at) AS latest
  FROM arena.sources AS source_row
  LEFT JOIN arena.leaderboard_snapshots AS snapshot
    ON snapshot.source_id = source_row.id
  WHERE source_row.status = 'active'
  GROUP BY source_row.id;
$$;

COMMENT ON FUNCTION public.get_platform_freshness() IS
  'Fetch freshness for every active arena source; active sources without snapshots return latest=NULL.';

REVOKE ALL ON FUNCTION public.get_platform_freshness() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_platform_freshness() TO service_role;

COMMIT;
