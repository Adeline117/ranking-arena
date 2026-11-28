/**
 * Per-source cutover flag (parallel-build migration).
 *
 * arena.sources.serving_mode is the SINGLE SOURCE OF TRUTH for whether a
 * source's read path is legacy or serving. The frontend resolves traders by
 * BOTH the arena slug (e.g. gate_futures) and the legacy platform alias (e.g.
 * gateio, from meta.legacy_platform), so the serving SET must expose both —
 * the `arena_serving_sources()` RPC derives exactly that from the DB.
 *
 * Resolution order (server-side only — pass the result down as a prop so there
 * is no hydration mismatch):
 *
 *   1. DB RPC `arena_serving_sources()`, cached in-process 5 min.
 *   2. env NEXT_PUBLIC_SERVING_SOURCES — only when the DB cannot be read.
 *
 * There is deliberately no Redis copy of the set. A Redis `serving_sources`
 * list used to win over the database, and a list missing an alias made that
 * alias non-serving with no error: the trader page then could not resolve the
 * alias URL (2026-06-15: xt/blofin/btcc/bitunix were missing; issue #543).
 * Production has answered from the database since Upstash went away, so the
 * copy bought nothing and was a second place for the set to be wrong.
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'

const envList = (): Set<string> =>
  new Set(
    (process.env.NEXT_PUBLIC_SERVING_SOURCES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  )

let dbServingSet: { sources: Set<string>; expiresAt: number } | null = null
const DB_TTL_MS = 5 * 60_000

/**
 * Authoritative serving set from the DB (arena.sources.serving_mode), cached
 * in-process 5 min.
 */
async function getDbServingSet(): Promise<Set<string> | null> {
  if (dbServingSet && Date.now() < dbServingSet.expiresAt) {
    return dbServingSet.sources
  }
  try {
    const { data, error } = await getSupabaseAdmin().rpc('arena_serving_sources')
    if (error || !Array.isArray(data)) return null
    const sources = new Set((data as string[]).filter((s) => typeof s === 'string' && s))
    dbServingSet = { sources, expiresAt: Date.now() + DB_TTL_MS }
    return sources
  } catch {
    return null // DB unavailable → fall back to env bootstrap list
  }
}

/** Is this source served from the new arena.* read path? */
export async function isServingSource(platform: string): Promise<boolean> {
  const dbSet = await getDbServingSet()
  if (dbSet !== null) return dbSet.has(platform)
  return envList().has(platform)
}

export type DataMode = 'serving' | 'legacy'

export async function getDataMode(platform: string): Promise<DataMode> {
  return (await isServingSource(platform)) ? 'serving' : 'legacy'
}
