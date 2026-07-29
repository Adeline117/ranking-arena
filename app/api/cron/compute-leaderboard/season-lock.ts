import { randomUUID } from 'node:crypto'
import { createLogger } from '@/lib/utils/logger'
import type { Period } from '@/lib/utils/arena-score'

const logger = createLogger('compute-leaderboard')

export const LEADERBOARD_SEASON_LOCK_ORDER: readonly Period[] = ['7D', '30D', '90D']
export const LEADERBOARD_SEASON_LOCK_TTL_SECONDS = 360

const RELEASE_OWNED_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

export interface LeaderboardSeasonLockRedis {
  set(key: string, value: string, options: { nx: true; ex: number }): Promise<'OK' | null | unknown>
  eval(script: string, keys: string[], args: string[]): Promise<unknown>
}

export type LeaderboardSeasonLockFailureReason = 'conflict' | 'redis_error'

export type LeaderboardSeasonLockResult =
  | {
      acquired: true
      ownerToken: string
      seasons: Period[]
      release: () => Promise<void>
    }
  | {
      acquired: false
      reason: LeaderboardSeasonLockFailureReason
      blockedSeason: Period | null
    }

function lockKey(season: Period): string {
  return `cron:compute-leaderboard:running:${season}`
}

function canonicalSeasons(seasons: readonly Period[]): Period[] {
  const requested = new Set(seasons)
  return LEADERBOARD_SEASON_LOCK_ORDER.filter((season) => requested.has(season))
}

async function releaseOwnedLocks(
  redis: LeaderboardSeasonLockRedis,
  ownerToken: string,
  seasons: readonly Period[]
): Promise<void> {
  for (const season of [...seasons].reverse()) {
    try {
      await redis.eval(RELEASE_OWNED_LOCK_SCRIPT, [lockKey(season)], [ownerToken])
    } catch (error) {
      // Never fall back to DEL. If the lease expired and another run acquired
      // this key, an unconditional delete would admit a third concurrent writer.
      // Leaving the key for its bounded TTL is the only safe failure mode.
      logger.error(
        `[${season}] Redis season-lock release failed; leaving the lease to expire`,
        error instanceof Error ? error.message : String(error)
      )
    }
  }
}

/**
 * Acquire every requested season lease in one canonical order.
 *
 * Full-board and single-season jobs share these exact keys. If any acquisition
 * conflicts or throws, all leases already owned by this attempt are released
 * with compare-and-delete and the caller must skip the compute.
 */
export async function acquireLeaderboardSeasonLocks(
  redis: LeaderboardSeasonLockRedis,
  seasons: readonly Period[],
  ownerToken: string = randomUUID()
): Promise<LeaderboardSeasonLockResult> {
  const orderedSeasons = canonicalSeasons(seasons)
  if (orderedSeasons.length !== new Set(seasons).size || orderedSeasons.length === 0) {
    throw new TypeError('leaderboard season locks require valid canonical seasons')
  }

  const acquiredSeasons: Period[] = []
  for (const season of orderedSeasons) {
    try {
      const result = await redis.set(lockKey(season), ownerToken, {
        nx: true,
        ex: LEADERBOARD_SEASON_LOCK_TTL_SECONDS,
      })
      if (result !== 'OK') {
        await releaseOwnedLocks(redis, ownerToken, acquiredSeasons)
        return { acquired: false, reason: 'conflict', blockedSeason: season }
      }
      acquiredSeasons.push(season)
    } catch (error) {
      logger.error(
        `[${season}] Redis season-lock acquisition failed`,
        error instanceof Error ? error.message : String(error)
      )
      await releaseOwnedLocks(redis, ownerToken, acquiredSeasons)
      return { acquired: false, reason: 'redis_error', blockedSeason: season }
    }
  }

  let released = false
  return {
    acquired: true,
    ownerToken,
    seasons: orderedSeasons,
    release: async () => {
      if (released) return
      released = true
      await releaseOwnedLocks(redis, ownerToken, acquiredSeasons)
    },
  }
}
