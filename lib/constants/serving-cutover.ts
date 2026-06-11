/**
 * Per-source cutover flag (parallel-build migration).
 *
 * A source's read path switches legacy → serving per the state machine in
 * arena.sources.serving_mode; the FRONTEND decision is duplicated here via
 * env + runtime override so Vercel never needs the arena schema exposed
 * just to evaluate the flag, and rollback is a Redis flip (no deploy):
 *
 *   1. env NEXT_PUBLIC_SERVING_SOURCES="bitget_futures,bitget_spot"
 *   2. Redis runtime override key `serving_sources` (comma list) wins.
 *
 * Server-side evaluation only — pass the result down as a prop so there is
 * no hydration mismatch.
 */

const envList = (): Set<string> =>
  new Set(
    (process.env.NEXT_PUBLIC_SERVING_SOURCES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  )

let runtimeOverride: { sources: Set<string>; expiresAt: number } | null = null
const RUNTIME_TTL_MS = 60_000

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
  return envList().has(platform)
}

export type DataMode = 'serving' | 'legacy'

export async function getDataMode(platform: string): Promise<DataMode> {
  return (await isServingSource(platform)) ? 'serving' : 'legacy'
}
