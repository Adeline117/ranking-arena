-- Migration: 20260615234305_arena_avatar_mirrors_batch_rpc.sql
-- Created: 2026-06-16T06:43:05Z
-- Description: Batch-resolve our own Supabase-Storage avatar mirrors
--   (arena.traders.avatar_url_mirror) for a set of (source, exchange_trader_id)
--   pairs. The legacy homepage/leaderboard path reads `leaderboard_ranks`
--   (public schema) which only carries the exchange-CDN ORIGIN url and routes
--   it through /api/avatar — which still hits the upstream exchange CDN and
--   eats cold-burst 429s. The avatar-mirror ingest worker already mirrors those
--   avatars into the `trader-avatars` public bucket and records the public URL
--   in arena.traders.avatar_url_mirror, but only the NEW serving surfaces
--   (arena_first_screen etc.) consume it.
--
--   This additive RPC lets the legacy leaderboard fetch enrich its <=50 rows
--   with the mirror url in a single index-backed round trip, WITHOUT touching
--   the perf-fragile get_diverse_leaderboard RPC. Frontend then prefers the
--   mirror (served from our CDN, no proxy, no 429) via getTraderAvatarSrc().
--
--   Index used: arena.traders unique (source_id, exchange_trader_id).
--   Returns only rows that actually have a mirror — caller treats a missing
--   pair as null and falls back to the origin proxy.

-- Up
CREATE OR REPLACE FUNCTION public.arena_avatar_mirrors(
  p_sources text[],
  p_trader_ids text[]
)
RETURNS TABLE (
  source text,
  exchange_trader_id text,
  avatar_url_mirror text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'arena', 'public'
AS $$
  SELECT s.slug, t.exchange_trader_id, t.avatar_url_mirror
    FROM unnest(p_sources, p_trader_ids) AS pair(src, tid)
    JOIN arena.sources s ON s.slug = pair.src
    JOIN arena.traders t
      ON t.source_id = s.id
     AND t.exchange_trader_id = pair.tid
   WHERE t.avatar_url_mirror IS NOT NULL;
$$;

COMMENT ON FUNCTION public.arena_avatar_mirrors(text[], text[]) IS
  'Batch-resolve arena.traders.avatar_url_mirror for (source, exchange_trader_id) pairs. Additive enrichment for the legacy leaderboard path; index-backed, returns only mirrored rows.';

GRANT EXECUTE ON FUNCTION public.arena_avatar_mirrors(text[], text[])
  TO anon, authenticated, service_role;
