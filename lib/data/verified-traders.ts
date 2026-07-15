/**
 * Verified-trader lookup (A1 phase-2) — data-authenticity, Myfxbook style.
 *
 * A trader is "Verified" only after a read-only exchange API key has completed
 * a recent successful first-party sync, so their numbers are pulled
 * directly from the exchange account rather than scraped from the public
 * leaderboard ("Tracked"). This is the moat signal: a ✓ Verified badge in the
 * rankings + profile that Tracked rows don't get.
 *
 * Keyed by `${platform}:${trader_id}`. The verified set is tiny (few traders
 * opt in) and changes rarely, so it is fetched once per process and cached for
 * a short TTL — mark-up on a leaderboard page is then an O(1) Set lookup with
 * zero per-request DB cost.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export function verifiedTraderKey(platform: string, traderId: string): string {
  return `${platform.toLowerCase()}:${traderId}`
}

let cache: { keys: Set<string>; ts: number } | null = null
const TTL_MS = 5 * 60 * 1000 // 5 min — verification status changes slowly
export const VERIFIED_DATA_MAX_AGE_MS = 48 * 60 * 60 * 1000

export function verifiedDataCutoffIso(now: number = Date.now()): string {
  return new Date(now - VERIFIED_DATA_MAX_AGE_MS).toISOString()
}

export function resetVerifiedTraderCacheForTests(): void {
  if (process.env.NODE_ENV === 'test') cache = null
}

/**
 * Set of `${platform}:${trader_id}` for traders with a proven read-only key and
 * a successful first-party sync inside the freshness window. Fail closed: a
 * lookup error returns an empty set (everyone shows as Tracked).
 */
export async function getVerifiedTraderKeys(supabase: SupabaseClient): Promise<Set<string>> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.keys

  try {
    const { data, error } = await supabase
      .from('verified_data_authorizations')
      .select('platform, trader_id')

    if (error) {
      return new Set()
    }

    const keys = new Set<string>(
      (data ?? [])
        .filter((r) => r.platform && r.trader_id)
        .map((r) => verifiedTraderKey(r.platform as string, r.trader_id as string))
    )
    cache = { keys, ts: Date.now() }
    return keys
  } catch {
    return new Set()
  }
}
