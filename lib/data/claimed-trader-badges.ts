/**
 * Claimed-trader ("✓ verified owner") badge lookup for leaderboard pages.
 *
 * verified_traders is tiny (manual owner review) and changes rarely, so the
 * full `${source}|${trader_id}` set is cached in-process for a short TTL —
 * same pattern as lib/data/verified-traders.ts. Concurrent cold requests share
 * one in-flight query. Fail-open (the badge is cosmetic): a query error logs
 * and yields an empty set for this request without poisoning the cache.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

const TTL_MS = 60_000

let cache: { keys: Set<string>; ts: number } | null = null
let inflight: Promise<Set<string>> | null = null

export function claimedTraderBadgeKey(source: string, traderId: string): string {
  return `${source}|${traderId}`
}

export function resetClaimedTraderBadgeCacheForTests(): void {
  if (process.env.NODE_ENV === 'test') {
    cache = null
    inflight = null
  }
}

async function loadClaimedTraderBadgeKeys(supabase: SupabaseClient): Promise<Set<string>> {
  try {
    const { data, error } = await supabase.from('verified_traders').select('trader_id, source')
    if (error) {
      logger.warn('[claimed-trader-badges] verified_traders query failed:', error.message)
      return new Set()
    }
    const keys = new Set<string>(
      (data ?? [])
        .filter((row) => row.source && row.trader_id)
        .map((row) => claimedTraderBadgeKey(String(row.source), String(row.trader_id)))
    )
    cache = { keys, ts: Date.now() }
    return keys
  } catch (err) {
    logger.warn(
      '[claimed-trader-badges] verified_traders query threw:',
      err instanceof Error ? err.message : String(err)
    )
    return new Set()
  }
}

export async function getClaimedTraderBadgeKeys(supabase: SupabaseClient): Promise<Set<string>> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.keys
  if (inflight) return inflight
  inflight = loadClaimedTraderBadgeKeys(supabase).finally(() => {
    inflight = null
  })
  return inflight
}
