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
import { logger } from '@/lib/logger'
import { isIngestRegion, type IngestRegion } from '@/lib/ingest/core/regions'

export interface ServingResolved {
  source: string
  /**
   * Null only when the deployed resolver contract is stale or corrupt.
   * Warm reads may still render, but Tier-C enqueueing must fail closed.
   */
  fetchRegion: IngestRegion | null
  exchangeTraderId: string
  nickname: string | null
  avatarMirrorUrl: string | null
  avatarOriginUrl: string | null
}

/**
 * ROOT-CAUSE FIX (2026-06-15): the old body did `if (error || !data) return
 * null`, collapsing a transient RPC ERROR into the SAME null as a genuine
 * not-found. Under burst load — a trader page render competing with its OWN
 * concurrent asset/RSC-prefetch requests against the PostgREST endpoint — the
 * resolve RPC intermittently errors, and that null then 404'd a VALID trader
 * (observed: okx failed ~every browser load while a single curl resolved 10/10,
 * returning notFound in ~550ms — a fast error, not a timeout). The /core,
 * /records and /bot routes share this resolver and had the same latent 404.
 *
 * Now an ERROR is retried with short backoff (the burst frees in <1s) and is
 * NEVER silently treated as not-found; a genuine empty result returns null
 * immediately. If every attempt errors we log and return null (do not invent a
 * trader) — but the retries make that vanishingly rare for transient bursts.
 */
const RESOLVE_RETRY_BACKOFF_MS = [0, 150, 400] as const

export async function resolveServingTrader(
  supabase: SupabaseClient,
  params: { handle: string; source?: string }
): Promise<ServingResolved | null> {
  let lastError: unknown = null
  for (const backoff of RESOLVE_RETRY_BACKOFF_MS) {
    if (backoff > 0) await new Promise((r) => setTimeout(r, backoff))
    const { data, error } = await supabase.rpc('arena_resolve_trader', {
      p_handle: params.handle,
      p_source: params.source ?? null,
    })
    if (error) {
      lastError = error
      continue // transient — retry, do NOT mistake for not-found
    }
    if (!data) return null // genuine not-found (RPC succeeded, no row)
    const d = data as Record<string, unknown>
    if (typeof d.source !== 'string' || typeof d.exchangeTraderId !== 'string') return null
    const fetchRegion = isIngestRegion(d.fetchRegion) ? d.fetchRegion : null
    if (!fetchRegion) {
      logger.error('[resolveServingTrader] resolver returned an invalid fetch region:', {
        source: d.source,
        fetchRegion: d.fetchRegion,
      })
    }
    return {
      source: d.source,
      fetchRegion,
      exchangeTraderId: d.exchangeTraderId,
      nickname: typeof d.nickname === 'string' ? d.nickname : null,
      avatarMirrorUrl: typeof d.avatarMirrorUrl === 'string' ? d.avatarMirrorUrl : null,
      avatarOriginUrl: typeof d.avatarOriginUrl === 'string' ? d.avatarOriginUrl : null,
    }
  }
  logger.error('[resolveServingTrader] all attempts errored (NOT treated as not-found):', {
    handle: params.handle,
    source: params.source,
    error: (lastError as { message?: string })?.message ?? lastError,
  })
  return null
}
