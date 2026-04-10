/**
 * compute-leaderboard / fetch-handles
 *
 * Two-step handle + avatar lookup:
 *   Step 1: trader_profiles_v2 (primary, has display_name)
 *   Step 2: traders table fallback for any key still missing a handle
 *
 * Extracted from route.ts as part of the computeSeason main-loop split
 * (TASKS.md "Open follow-ups"). Returns a Map keyed by `${source}:${trader_id}`
 * — same key shape route.ts uses everywhere else for trader lookups.
 */

import { getSupabaseAdmin } from '@/lib/api'

export interface HandleAvatar {
  handle: string | null
  avatar_url: string | null
}

/**
 * Minimal shape needed from each trader (just source + id). Accepts any
 * superset so we can pass uniqueTraders directly.
 */
export interface TraderForHandleLookup {
  source: string
  source_trader_id: string
}

/**
 * Build a `${source}:${trader_id}` → {handle, avatar_url} map for every
 * trader in `uniqueTraders`. 0x-prefixed trader_keys are lowercased to match
 * the rest of the pipeline.
 */
export async function fetchHandleAvatarMap(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  uniqueTraders: readonly TraderForHandleLookup[],
): Promise<Map<string, HandleAvatar>> {
  const handleMap = new Map<string, HandleAvatar>()

  // Group trader_ids by source for chunked queries
  const bySource = new Map<string, string[]>()
  for (const t of uniqueTraders) {
    const ids = bySource.get(t.source) || []
    ids.push(t.source_trader_id)
    bySource.set(t.source, ids)
  }

  // Step 1: Query trader_profiles_v2 first (primary source)
  await Promise.all(
    Array.from(bySource.entries()).map(async ([source, traderIds]) => {
      for (let i = 0; i < traderIds.length; i += 500) {
        const chunk = traderIds.slice(i, i + 500)
        const { data: v2Data } = await supabase
          .from('trader_profiles_v2')
          .select('trader_key, display_name, avatar_url')
          .eq('platform', source)
          .in('trader_key', chunk)

        v2Data?.forEach((s: { trader_key: string; display_name: string | null; avatar_url: string | null }) => {
          const tid = s.trader_key.startsWith('0x') ? s.trader_key.toLowerCase() : s.trader_key
          handleMap.set(`${source}:${tid}`, {
            handle: s.display_name,
            avatar_url: s.avatar_url || null,
          })
        })
      }
    }),
  )

  // Step 2: Targeted fallback — only query traders table for keys with NULL handles
  const missingHandleBySource = new Map<string, string[]>()
  for (const t of uniqueTraders) {
    const tid = t.source_trader_id.startsWith('0x') ? t.source_trader_id.toLowerCase() : t.source_trader_id
    const key = `${t.source}:${tid}`
    const entry = handleMap.get(key)
    if (!entry || !entry.handle) {
      const ids = missingHandleBySource.get(t.source) || []
      ids.push(t.source_trader_id)
      missingHandleBySource.set(t.source, ids)
    }
  }

  if (missingHandleBySource.size === 0) return handleMap

  await Promise.all(
    Array.from(missingHandleBySource.entries()).map(async ([source, traderIds]) => {
      for (let i = 0; i < traderIds.length; i += 500) {
        const chunk = traderIds.slice(i, i + 500)
        const { data: fallbackData } = await supabase
          .from('traders')
          .select('trader_key, handle, avatar_url')
          .eq('platform', source)
          .in('trader_key', chunk)

        fallbackData?.forEach((s: { trader_key: string; handle: string | null; avatar_url: string | null }) => {
          const tid = s.trader_key.startsWith('0x') ? s.trader_key.toLowerCase() : s.trader_key
          const key = `${source}:${tid}`
          if (!handleMap.has(key) || (!handleMap.get(key)!.handle && s.handle)) {
            handleMap.set(key, {
              handle: handleMap.get(key)?.handle || s.handle,
              avatar_url: handleMap.get(key)?.avatar_url || s.avatar_url || null,
            })
          }
        })
      }
    }),
  )

  return handleMap
}
