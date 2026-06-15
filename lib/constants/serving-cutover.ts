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
 *   1. Redis `serving_sources` (comma list) — fast hot-path mirror, kept fresh
 *      by the worker scheduler reconcile. Wins when present.
 *   2. DB RPC `arena_serving_sources()` — self-heal when Redis is absent/flushed
 *      (cached in-process 5 min). This is what makes a Redis FLUSH safe: the
 *      set rebuilds from the DB instead of collapsing to the (possibly empty)
 *      env list and reverting every trader to the empty legacy page.
 *   3. env NEXT_PUBLIC_SERVING_SOURCES — cold-bootstrap fallback only.
 *
 * Root-cause history (2026-06-15): the Redis list was hand-edited and the env
 * was empty, so the two drifted — Redis was missing 4 legacy aliases
 * (xt/blofin/btcc/bitunix) and a Redis flush would have reverted ALL sources
 * to legacy. Making the DB authoritative (RPC + worker reconcile) removes the
 * manual editing that was the actual source of drift.
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'

const envList = (): Set<string> =>
  new Set(
    (process.env.NEXT_PUBLIC_SERVING_SOURCES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  )

let runtimeOverride: { sources: Set<string>; expiresAt: number } | null = null
const RUNTIME_TTL_MS = 60_000

let dbServingSet: { sources: Set<string>; expiresAt: number } | null = null
const DB_TTL_MS = 5 * 60_000

/**
 * Authoritative serving set from the DB (arena.sources.serving_mode), cached
 * in-process 5 min. Only consulted when Redis is unavailable — keeps the DB
 * the source of truth without adding a DB round-trip to the warm hot path.
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

async function getRuntimeOverride(): Promise<Set<string> | null> {
  if (runtimeOverride && Date.now() < runtimeOverride.expiresAt) {
    return runtimeOverride.sources
  }
  try {
    const { getSharedRedis } = await import('@/lib/cache/redis-client')
    const redis = await getSharedRedis()
    if (!redis) return null
    const raw = await redis.get('serving_sources')
    if (raw === null || raw === undefined) {
      runtimeOverride = null
      return null
    }
    const sources = new Set(
      String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    )
    runtimeOverride = { sources, expiresAt: Date.now() + RUNTIME_TTL_MS }
    return sources
  } catch {
    return null // Redis unavailable → fall back to env
  }
}

/** Is this source served from the new arena.* read path? */
export async function isServingSource(platform: string): Promise<boolean> {
  const override = await getRuntimeOverride()
  if (override !== null) return override.has(platform)
  // Redis absent/flushed → rebuild from the DB (authoritative) before ever
  // falling back to the env bootstrap list, so a flush can't revert traders
  // to the empty legacy page.
  const dbSet = await getDbServingSet()
  if (dbSet !== null) return dbSet.has(platform)
  return envList().has(platform)
}

export type DataMode = 'serving' | 'legacy'

export async function getDataMode(platform: string): Promise<DataMode> {
  return (await isServingSource(platform)) ? 'serving' : 'legacy'
}
