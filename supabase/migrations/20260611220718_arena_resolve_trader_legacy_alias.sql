-- Migration: 20260611220718_arena_resolve_trader_legacy_alias.sql
-- Created: 2026-06-12T05:07:18Z
-- Description: ENDGAME cutover — /trader/[handle] resolves the platform from
--   legacy tables (trader_sources.source = legacy platform name, e.g. 'mexc',
--   'bybit', 'gateio'), but arena_resolve_trader only matched arena.sources.slug
--   ('mexc_futures', 'bybit_copytrade', 'gate_futures'). Sources whose slug
--   differs from their legacy platform name could therefore never take the
--   serving read path when the page passes the legacy platform. Match
--   meta->>'legacy_platform' as an alias too.

-- Up

CREATE OR REPLACE FUNCTION public.arena_resolve_trader(
  p_handle text,
  p_source text DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = arena, public
AS $$
  SELECT jsonb_build_object(
    'source', s.slug,
    'exchangeTraderId', t.exchange_trader_id,
    'nickname', t.nickname,
    'avatarMirrorUrl', t.avatar_url_mirror,
    'avatarOriginUrl', t.avatar_url_origin
  )
    FROM arena.traders t
    JOIN arena.sources s ON s.id = t.source_id
   WHERE (
           p_source IS NULL
           OR s.slug = p_source
           -- Legacy platform alias: trader_sources.source carries the OLD
           -- platform name for compat-written rows (mexc, bybit, gateio, …).
           OR s.meta ->> 'legacy_platform' = p_source
         )
     AND (t.exchange_trader_id = p_handle OR lower(t.nickname) = lower(p_handle))
   ORDER BY (t.exchange_trader_id = p_handle) DESC,  -- exact id beats nickname
            (s.serving_mode = 'serving') DESC,       -- live sources first
            t.last_seen_at DESC NULLS LAST
   LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.arena_resolve_trader(text, text) TO anon, authenticated;
