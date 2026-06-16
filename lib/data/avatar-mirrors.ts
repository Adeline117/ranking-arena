/**
 * Batch-attach our own Supabase-Storage avatar mirror to leaderboard rows.
 *
 * The avatar-mirror ingest worker mirrors exchange-CDN avatars into the
 * `trader-avatars` bucket and records the public URL in
 * arena.traders.avatar_url_mirror. The legacy homepage/leaderboard path reads
 * `leaderboard_ranks` (origin URL only) and proxies the exchange CDN via
 * /api/avatar — which eats cold-burst 429s. This helper enriches those rows
 * with the mirror URL (when present) in a single index-backed RPC round trip,
 * so the frontend can prefer our CDN (no proxy, no 429) via getTraderAvatarSrc.
 *
 * Fail-open: any error returns the input unchanged — the origin proxy still
 * works, so a missing mirror never breaks rendering.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

interface MirrorRow {
  source: string
  exchange_trader_id: string
  avatar_url_mirror: string
}

export async function attachAvatarMirrors<
  T extends { source: string; id: string; avatar_url_mirror?: string | null },
>(supabase: SupabaseClient, traders: T[]): Promise<T[]> {
  if (!traders.length) return traders
  try {
    const { data, error } = await supabase.rpc('arena_avatar_mirrors', {
      p_sources: traders.map((t) => t.source),
      p_trader_ids: traders.map((t) => t.id),
    })
    if (error || !Array.isArray(data)) {
      if (error) logger.warn('[attachAvatarMirrors] RPC error:', error.message)
      return traders
    }
    const mirrorByKey = new Map<string, string>()
    for (const row of data as MirrorRow[]) {
      if (row?.avatar_url_mirror) {
        mirrorByKey.set(`${row.source}:${row.exchange_trader_id}`, row.avatar_url_mirror)
      }
    }
    if (mirrorByKey.size === 0) return traders
    return traders.map((t) => {
      const mirror = mirrorByKey.get(`${t.source}:${t.id}`)
      return mirror ? { ...t, avatar_url_mirror: mirror } : t
    })
  } catch (err) {
    logger.warn('[attachAvatarMirrors] failed:', err instanceof Error ? err.message : String(err))
    return traders
  }
}
