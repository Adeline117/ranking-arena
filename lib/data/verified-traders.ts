/**
 * Verified-trader lookup (A1 phase-2) — data-authenticity, Myfxbook style.
 *
 * A trader is "Verified" when they have connected a read-only exchange API key
 * (an ACTIVE row in `trader_authorizations`), so their numbers are pulled
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

/**
 * Set of `${platform}:${trader_id}` for traders with an ACTIVE authorization
 * (read-only API key connected → data is API-verified, not scraped).
 * Fail-open: on any error returns an empty set (everyone shows as Tracked)
 * rather than throwing — a lookup failure must never break the leaderboard.
 */
export async function getVerifiedTraderKeys(supabase: SupabaseClient): Promise<Set<string>> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.keys

  try {
    const { data, error } = await supabase
      .from('trader_authorizations')
      .select('platform, trader_id')
      .eq('status', 'active')

    if (error) {
      // Stale cache is better than none; otherwise empty (all Tracked).
      return cache?.keys ?? new Set()
    }

    const keys = new Set<string>(
      (data ?? [])
        .filter((r) => r.platform && r.trader_id)
        .map((r) => verifiedTraderKey(r.platform as string, r.trader_id as string))
    )
    cache = { keys, ts: Date.now() }
    return keys
  } catch {
    return cache?.keys ?? new Set()
  }
}
