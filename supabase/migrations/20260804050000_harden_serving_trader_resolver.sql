-- Fail closed at the public identity boundary: only active serving sources may
-- resolve. Shadow and inactive sources remain available to ingestion and
-- validation, but they must not become public profile identities.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.arena_resolve_trader(text,text)'
     ) IS NULL THEN
    RAISE EXCEPTION 'serving trader resolver foundations are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'arena.sources'::pg_catalog.regclass
      AND attribute.attname = 'status'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'arena.sources'::pg_catalog.regclass
      AND attribute.attname = 'serving_mode'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'source status and serving_mode are required resolver boundaries';
  END IF;

  IF pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'resolver execution roles are missing';
  END IF;
END
$preflight$;

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
  WHERE source_row.status = 'active'
    AND source_row.serving_mode = 'serving'
    AND (
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
    trader_row.last_seen_at DESC NULLS LAST
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.arena_resolve_trader(text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.arena_resolve_trader(text, text)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.arena_resolve_trader(text, text) IS
  'Resolves an active serving trader and its database-authoritative fetchRegion for Tier-C routing.';

DO $postflight$
DECLARE
  resolver_definition text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(procedure.oid)
  INTO resolver_definition
  FROM pg_catalog.pg_proc AS procedure
  WHERE procedure.oid = pg_catalog.to_regprocedure(
    'public.arena_resolve_trader(text,text)'
  )
    AND procedure.provolatile = 's'
    AND procedure.prosecdef
    AND procedure.proconfig @> ARRAY[
      'search_path=public, arena, pg_temp'
    ]::text[];

  IF resolver_definition IS NULL
     OR pg_catalog.strpos(
       resolver_definition,
       'source_row.status = ''active'''
     ) = 0
     OR pg_catalog.strpos(
       resolver_definition,
       'source_row.serving_mode = ''serving'''
     ) = 0 THEN
    RAISE EXCEPTION 'active-serving resolver boundary postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
