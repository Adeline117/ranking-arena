-- Return the source's database-authoritative fetch region with every serving
-- trader resolution. Tier-C producers use it to select an isolated regional
-- queue; workers independently re-check the same source row before fetching.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.arena_resolve_trader(
  p_handle text,
  p_source text DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, arena, pg_temp
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'source', source_row.slug,
    'fetchRegion', source_row.fetch_region,
    'exchangeTraderId', trader_row.exchange_trader_id,
    'nickname', trader_row.nickname,
    'avatarMirrorUrl', trader_row.avatar_url_mirror,
    'avatarOriginUrl', trader_row.avatar_url_origin
  )
  FROM arena.traders AS trader_row
  JOIN arena.sources AS source_row
    ON source_row.id = trader_row.source_id
  WHERE (
      p_source IS NULL
      OR source_row.slug = p_source
      OR source_row.meta ->> 'legacy_platform' = p_source
    )
    AND (
      trader_row.exchange_trader_id = p_handle
      OR pg_catalog.lower(trader_row.nickname) = pg_catalog.lower(p_handle)
    )
  ORDER BY
    (trader_row.exchange_trader_id = p_handle) DESC,
    (source_row.serving_mode = 'serving') DESC,
    trader_row.last_seen_at DESC NULLS LAST
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.arena_resolve_trader(text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.arena_resolve_trader(text, text)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.arena_resolve_trader(text, text) IS
  'Resolves a serving trader and returns its database-authoritative fetchRegion for Tier-C queue routing.';

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = pg_catalog.to_regprocedure(
      'public.arena_resolve_trader(text,text)'
    )
      AND procedure.provolatile = 's'
      AND procedure.prosecdef
      AND procedure.proconfig @> ARRAY[
        'search_path=public, arena, pg_temp'
      ]::text[]
  ) THEN
    RAISE EXCEPTION 'arena_resolve_trader routing contract postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
