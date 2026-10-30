/**
 * Public "Verified Data" badge boundary.
 *
 * Arena V1 keeps CEX account connections private and does not publish their
 * first-party data or mint a public badge. Historical authorization-derived
 * rows are quarantined and drained separately; they must never re-enable the
 * badge merely because they remain in a legacy view during that audit window.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export function verifiedTraderKey(platform: string, traderId: string): string {
  return `${platform.toLowerCase()}:${traderId}`
}

export const VERIFIED_DATA_MAX_AGE_MS = 48 * 60 * 60 * 1000

export function verifiedDataCutoffIso(now: number = Date.now()): string {
  return new Date(now - VERIFIED_DATA_MAX_AGE_MS).toISOString()
}

export function resetVerifiedTraderCacheForTests(): void {
  // Compatibility export. V1 deliberately has no verification-status cache.
}

/** Fixed V1 fail-closed result: private CEX connections do not mint badges. */
export async function getVerifiedTraderKeys(
  _supabase: SupabaseClient,
  _signal?: AbortSignal
): Promise<Set<string>> {
  return new Set()
}
