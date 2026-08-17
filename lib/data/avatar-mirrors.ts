/**
 * Batch-attach existing Supabase-Storage avatar mirrors to leaderboard rows.
 *
 * This read helper only exposes already-persisted URLs from the
 * `trader-avatars` bucket. It does not claim a writer is active or acquire a
 * replacement from an exchange source. Frontends can prefer a direct-safe
 * mirror when one exists and otherwise use their local avatar fallback.
 *
 * Fail-open: any error returns the input unchanged; rendering remains subject
 * to the source-level direct-safe avatar policy.
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
>(supabase: SupabaseClient, traders: T[], signal?: AbortSignal): Promise<T[]> {
  if (!traders.length) return traders
  try {
    const query = supabase.rpc('arena_avatar_mirrors', {
      p_sources: traders.map((t) => t.source),
      p_trader_ids: traders.map((t) => t.id),
    })
    const { data, error } = await (signal ? query.abortSignal(signal) : query)
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
