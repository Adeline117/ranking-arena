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
 *
 * In-process cache: mirror URLs are effectively immutable once written, so
 * per-trader lookups (including "no mirror yet") are cached for a short TTL
 * in a bounded Map. Only cache misses hit the RPC; errors are never cached.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

const MIRROR_CACHE_TTL_MS = 10 * 60_000
const MIRROR_CACHE_MAX_ENTRIES = 5_000

const mirrorCache = new Map<string, { mirror: string | null; ts: number }>()

export function resetAvatarMirrorCacheForTests(): void {
  if (process.env.NODE_ENV === 'test') mirrorCache.clear()
}

function rememberMirror(key: string, mirror: string | null, now: number): void {
  mirrorCache.delete(key)
  mirrorCache.set(key, { mirror, ts: now })
  if (mirrorCache.size > MIRROR_CACHE_MAX_ENTRIES) {
    // Map preserves insertion order: evict the oldest entries first.
    const excess = mirrorCache.size - MIRROR_CACHE_MAX_ENTRIES
    let removed = 0
    for (const staleKey of mirrorCache.keys()) {
      if (removed >= excess) break
      mirrorCache.delete(staleKey)
      removed += 1
    }
  }
}

function applyMirrors<T extends { source: string; id: string; avatar_url_mirror?: string | null }>(
  traders: T[],
  mirrorByKey: Map<string, string | null>
): T[] {
  let changed = false
  const next = traders.map((t) => {
    const mirror = mirrorByKey.get(`${t.source}:${t.id}`)
    if (!mirror) return t
    changed = true
    return { ...t, avatar_url_mirror: mirror }
  })
  return changed ? next : traders
}

interface MirrorRow {
  source: string
  exchange_trader_id: string
  avatar_url_mirror: string
}

export async function attachAvatarMirrors<
  T extends { source: string; id: string; avatar_url_mirror?: string | null },
>(supabase: SupabaseClient, traders: T[], signal?: AbortSignal): Promise<T[]> {
  if (!traders.length) return traders
  const now = Date.now()
  const known = new Map<string, string | null>()
  const missing: T[] = []
  const missingKeys = new Set<string>()
  for (const t of traders) {
    const key = `${t.source}:${t.id}`
    const hit = mirrorCache.get(key)
    if (hit && now - hit.ts < MIRROR_CACHE_TTL_MS) {
      known.set(key, hit.mirror)
    } else if (!missingKeys.has(key)) {
      missingKeys.add(key)
      missing.push(t)
    }
  }
  if (missing.length === 0) return applyMirrors(traders, known)

  try {
    const query = supabase.rpc('arena_avatar_mirrors', {
      p_sources: missing.map((t) => t.source),
      p_trader_ids: missing.map((t) => t.id),
    })
    const { data, error } = await (signal ? query.abortSignal(signal) : query)
    if (error || !Array.isArray(data)) {
      if (error) logger.warn('[attachAvatarMirrors] RPC error:', error.message)
      return applyMirrors(traders, known)
    }
    const fetched = new Map<string, string>()
    for (const row of data as MirrorRow[]) {
      if (row?.avatar_url_mirror) {
        fetched.set(`${row.source}:${row.exchange_trader_id}`, row.avatar_url_mirror)
      }
    }
    const storedAt = Date.now()
    for (const key of missingKeys) {
      const mirror = fetched.get(key) ?? null
      rememberMirror(key, mirror, storedAt)
      known.set(key, mirror)
    }
    return applyMirrors(traders, known)
  } catch (err) {
    logger.warn('[attachAvatarMirrors] failed:', err instanceof Error ? err.message : String(err))
    return applyMirrors(traders, known)
  }
}
