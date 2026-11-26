-- Migration: resolve_trader_public_source
-- Description: public.arena_resolve_trader() also returns the source's public
--   name, and the database guarantees that name is unambiguous.
--
-- Why: the public leaderboard keys a source by its public name
--   (meta.legacy_platform when set, else the slug: bybit / bitunix / blofin /
--   xt ...), while the resolver returned only the registry slug
--   (bybit_copytrade / bitunix_futures / blofin_futures ...). The trader page
--   looked the trader up on the public board by slug and found nothing:
--   /api/traders/<id>/first-screen answered rank=null,
--   reason=source_not_publicly_rankable for every trader of the 11 sources
--   whose two names differ (about 6,100 public rows on 2026-11-23). The
--   application already reads an optional publicSource field.
--
-- What changes:
--   * The resolver's JSON gains publicSource =
--     COALESCE(NULLIF(meta->>'legacy_platform', ''), slug), the expression
--     arena_visible_sources and arena_freshness_expected_sources use. Nothing
--     else in the function changes.
--   * Among active + serving sources a public name must be unique, and no
--     source's public name may be another source's slug. Without that,
--     resolving by a name could pick either of two sources. Production holds
--     no violation today; the migration refuses to run if one exists.
--     - a partial unique index covers "two sources, one public name";
--     - a trigger covers "one source's alias is another source's slug", which
--       an index over one expression cannot express.
--
-- POSTDEPLOY; no application or worker release depends on it.
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure('public.arena_resolve_trader(text,text)') IS NULL
     OR (
       SELECT pg_catalog.encode(
                pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')), 'hex')
         FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid =
              'public.arena_resolve_trader(text,text)'::pg_catalog.regprocedure
     ) IS DISTINCT FROM '8970dcf3c6e7699db868d7b4b3a0d27ce52895f2f759281a88aaee28033edea7' THEN
    RAISE EXCEPTION 'trader resolver is not the 20260804050000 definition';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM arena.sources AS one
      JOIN arena.sources AS other
        ON other.id <> one.id
       AND other.status = 'active'
       AND other.serving_mode = 'serving'
     WHERE one.status = 'active'
       AND one.serving_mode = 'serving'
       AND COALESCE(NULLIF(one.meta->>'legacy_platform', ''), one.slug)
           IN (other.slug, COALESCE(NULLIF(other.meta->>'legacy_platform', ''), other.slug))
  ) THEN
    RAISE EXCEPTION 'active serving sources already share a public name';
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
    'publicSource',
      COALESCE(NULLIF(source_row.meta ->> 'legacy_platform', ''), source_row.slug),
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

-- Two active serving sources may not share one public name.
CREATE UNIQUE INDEX arena_sources_serving_public_name_key
  ON arena.sources ((COALESCE(NULLIF(meta ->> 'legacy_platform', ''), slug)))
  WHERE status = 'active' AND serving_mode = 'serving';

-- One active serving source's public name may not be another's slug (and the
-- reverse): a request by that name would match both.
CREATE FUNCTION arena.reject_ambiguous_serving_source_name()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_public_name text := COALESCE(NULLIF(NEW.meta ->> 'legacy_platform', ''), NEW.slug);
BEGIN
  IF NEW.status IS DISTINCT FROM 'active' OR NEW.serving_mode IS DISTINCT FROM 'serving' THEN
    RETURN NEW;
  END IF;
  -- Serialise concurrent registry edits so two of them cannot both pass.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('arena.sources serving public name', 0)
  );
  IF EXISTS (
    SELECT 1
      FROM arena.sources AS other
     WHERE other.id <> NEW.id
       AND other.status = 'active'
       AND other.serving_mode = 'serving'
       AND (
         other.slug = v_public_name
         OR COALESCE(NULLIF(other.meta ->> 'legacy_platform', ''), other.slug) = NEW.slug
       )
  ) THEN
    RAISE EXCEPTION 'source % public name % collides with another active serving source',
      NEW.slug, v_public_name
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION arena.reject_ambiguous_serving_source_name() OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.reject_ambiguous_serving_source_name()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER sources_reject_ambiguous_serving_name
BEFORE INSERT OR UPDATE OF slug, meta, status, serving_mode ON arena.sources
FOR EACH ROW EXECUTE FUNCTION arena.reject_ambiguous_serving_source_name();

COMMIT;
