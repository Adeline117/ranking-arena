-- Migration: 20260610235047_arena_serving_resolve_rpc.sql
-- Created: 2026-06-11T06:50:47Z
-- Description: ARENA_DATA_SPEC v1.2 Workstream E — serving-mode trader
--   resolution RPC. The /trader/[handle] URL carries either a nickname
--   ("AI-HUB") or an exchange_trader_id ("beb24d718eb23b54ac91"); arena.*
--   is not PostgREST-exposed, so resolution goes through this public RPC.
--   Read-only SECURITY DEFINER returning only columns that already have
--   public SELECT policies on arena.traders/sources.

-- Up

-- Nickname lookups would seq-scan arena.traders; keep them indexed as
-- sources scale past Bitget (Bybit MT5 alone is ~29k rows).
CREATE INDEX IF NOT EXISTS idx_arena_traders_nickname_lower
  ON arena.traders (lower(nickname));

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
   WHERE (p_source IS NULL OR s.slug = p_source)
     AND (t.exchange_trader_id = p_handle OR lower(t.nickname) = lower(p_handle))
   ORDER BY (t.exchange_trader_id = p_handle) DESC,  -- exact id beats nickname
            (s.serving_mode = 'serving') DESC,       -- live sources first
            t.last_seen_at DESC NULLS LAST
   LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.arena_resolve_trader(text, text) TO anon, authenticated;
