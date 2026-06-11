/**
 * Serving-mode trader resolution (parallel-build read path).
 *
 * Legacy resolution goes through trader_sources/leaderboard_ranks; serving
 * sources resolve against arena.traders via the public arena_resolve_trader
 * RPC (arena.* is not PostgREST-exposed — all reads go through public RPCs).
 *
 * Matches by exchange_trader_id first (exact), then nickname
 * (case-insensitive) — so both /trader/beb24d718eb23b54ac91 and
 * /trader/AI-HUB resolve to the same arena row.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface ServingResolved {
  source: string
  exchangeTraderId: string
  nickname: string | null
  avatarMirrorUrl: string | null
  avatarOriginUrl: string | null
}

export async function resolveServingTrader(
  supabase: SupabaseClient,
  params: { handle: string; source?: string }
): Promise<ServingResolved | null> {
  const { data, error } = await supabase.rpc('arena_resolve_trader', {
    p_handle: params.handle,
    p_source: params.source ?? null,
  })
  if (error || !data) return null
  const d = data as Record<string, unknown>
  if (typeof d.source !== 'string' || typeof d.exchangeTraderId !== 'string') return null
  return {
    source: d.source,
    exchangeTraderId: d.exchangeTraderId,
    nickname: typeof d.nickname === 'string' ? d.nickname : null,
    avatarMirrorUrl: typeof d.avatarMirrorUrl === 'string' ? d.avatarMirrorUrl : null,
    avatarOriginUrl: typeof d.avatarOriginUrl === 'string' ? d.avatarOriginUrl : null,
  }
}
