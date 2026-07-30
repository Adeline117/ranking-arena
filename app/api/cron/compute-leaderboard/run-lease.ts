/**
 * Redis run lease for compute-leaderboard.
 *
 * Every invocation owns the complete publication-surface key set. Even two
 * disjoint single-season runs must serialize because cache tag invalidation,
 * homepage revalidation, and public success markers share global surfaces.
 * Multi-key acquisition and owner-checked release are each one Lua command so
 * no partially acquired or stale-owner release window exists.
 */

import { randomUUID } from 'node:crypto'
import { getSharedRedis } from '@/lib/cache/redis-client'
import type { Period } from '@/lib/utils/arena-score'

export const LEADERBOARD_RUN_LEASE_SEASONS = [
  '7D',
  '30D',
  '90D',
] as const satisfies readonly Period[]
export const LEADERBOARD_RUN_LEASE_TTL_SECONDS = 360

const LEASE_KEY_PREFIX = 'cron:compute-leaderboard:running:'
export const LEADERBOARD_RUN_LEASE_LEGACY_KEY = 'cron:compute-leaderboard:running'
const SEASON_SET = new Set<string>(LEADERBOARD_RUN_LEASE_SEASONS)

const ACQUIRE_LEASE_SCRIPT = `
for _, key in ipairs(KEYS) do
  if redis.call('EXISTS', key) == 1 then
    return 0
  end
end

local owner = ARGV[1]
local ttl = tonumber(ARGV[2])
for _, key in ipairs(KEYS) do
  redis.call('SET', key, owner, 'EX', ttl)
end
return 1
`

const RELEASE_LEASE_SCRIPT = `
local owner = ARGV[1]
local released = 0
local conflicts = 0

for _, key in ipairs(KEYS) do
  local current = redis.call('GET', key)
  if current == owner then
    released = released + redis.call('DEL', key)
  elseif current then
    conflicts = conflicts + 1
  end
end

return {released, conflicts}
`

export type LeaderboardRunLeaseAcquireFailureReason =
  | 'invalid_target'
  | 'redis_unavailable'
  | 'redis_error'
  | 'redis_response_invalid'
  | 'contended'

export type LeaderboardRunLeaseReleaseResult =
  | { released: true; releasedKeys: number }
  | {
      released: false
      reason: 'owner_mismatch' | 'expired_or_absent' | 'redis_error' | 'redis_response_invalid'
      releasedKeys: number
      error?: string
    }

export interface LeaderboardRunLease {
  readonly seasons: readonly Period[]
  readonly keys: readonly string[]
  /** Redis owner token used to guard publication-side atomic invalidation. */
  readonly ownerToken: string
  release(): Promise<LeaderboardRunLeaseReleaseResult>
}

export type LeaderboardRunLeaseAcquireResult =
  | { acquired: true; lease: LeaderboardRunLease }
  | {
      acquired: false
      reason: LeaderboardRunLeaseAcquireFailureReason
      error?: string
    }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function canonicalizeTargetSeasons(targetSeasons: readonly Period[]): Period[] | null {
  if (!Array.isArray(targetSeasons) || targetSeasons.length === 0) return null
  const requested = new Set<string>()
  for (const season of targetSeasons as readonly unknown[]) {
    if (typeof season !== 'string' || !SEASON_SET.has(season)) return null
    requested.add(season)
  }
  return LEADERBOARD_RUN_LEASE_SEASONS.filter((season) => requested.has(season))
}

function leaseKey(season: Period): string {
  return `${LEASE_KEY_PREFIX}${season}`
}

function parseReleaseResponse(response: unknown): [number, number] | null {
  if (!Array.isArray(response) || response.length !== 2) return null
  const [released, conflicts] = response
  return Number.isSafeInteger(released) &&
    released >= 0 &&
    Number.isSafeInteger(conflicts) &&
    conflicts >= 0
    ? [released, conflicts]
    : null
}

/**
 * Acquire an owner-token lease over every canonical target season.
 *
 * Failure is always fail-closed. The caller may distinguish contention from
 * Redis unavailability, but neither result authorizes a leaderboard run.
 */
export async function acquireLeaderboardRunLease(
  targetSeasons: readonly Period[]
): Promise<LeaderboardRunLeaseAcquireResult> {
  const seasons = canonicalizeTargetSeasons(targetSeasons)
  if (!seasons) return { acquired: false, reason: 'invalid_target' }

  let redis: Awaited<ReturnType<typeof getSharedRedis>>
  try {
    redis = await getSharedRedis()
  } catch (error) {
    return { acquired: false, reason: 'redis_error', error: errorMessage(error) }
  }
  if (!redis) return { acquired: false, reason: 'redis_unavailable' }

  let ownerToken: string
  try {
    ownerToken = randomUUID()
  } catch (error) {
    return { acquired: false, reason: 'redis_error', error: errorMessage(error) }
  }

  // The database compute target remains season-scoped, but the publication
  // surface is global. Always acquire all keys so 7D and 30D cannot race a
  // shared cache invalidation while each believes it owns publication.
  // Keep the retired all-season key for one full rolling-deploy compatibility
  // window. Old all-season handlers acquire only this key; without it, an old
  // instance and a new instance can both believe they own the live tables.
  const keys = [LEADERBOARD_RUN_LEASE_LEGACY_KEY, ...LEADERBOARD_RUN_LEASE_SEASONS.map(leaseKey)]
  let acquireResponse: unknown
  try {
    acquireResponse = await redis.eval(ACQUIRE_LEASE_SCRIPT, keys, [
      ownerToken,
      String(LEADERBOARD_RUN_LEASE_TTL_SECONDS),
    ])
  } catch (error) {
    return { acquired: false, reason: 'redis_error', error: errorMessage(error) }
  }

  if (acquireResponse === 0) return { acquired: false, reason: 'contended' }
  if (acquireResponse !== 1) {
    return { acquired: false, reason: 'redis_response_invalid' }
  }

  return {
    acquired: true,
    lease: {
      seasons: Object.freeze([...seasons]),
      keys: Object.freeze([...keys]),
      ownerToken,
      async release(): Promise<LeaderboardRunLeaseReleaseResult> {
        let releaseResponse: unknown
        try {
          releaseResponse = await redis.eval(RELEASE_LEASE_SCRIPT, keys, [ownerToken])
        } catch (error) {
          return {
            released: false,
            reason: 'redis_error',
            releasedKeys: 0,
            error: errorMessage(error),
          }
        }

        const parsed = parseReleaseResponse(releaseResponse)
        if (!parsed) {
          return { released: false, reason: 'redis_response_invalid', releasedKeys: 0 }
        }
        const [releasedKeys, conflicts] = parsed
        if (conflicts > 0) {
          return { released: false, reason: 'owner_mismatch', releasedKeys }
        }
        if (releasedKeys !== keys.length) {
          return { released: false, reason: 'expired_or_absent', releasedKeys }
        }
        return { released: true, releasedKeys }
      },
    },
  }
}
