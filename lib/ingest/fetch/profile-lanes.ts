/**
 * Bounded in-process leases for persistent Chromium profile directories.
 *
 * Chrome permits only one live process per user-data directory. Most ingest
 * tiers need one stable directory per source/tier so cookies stay warm without
 * cross-tier ProcessSingleton collisions. Tier C is intentionally concurrent,
 * so it gets a small fixed set of stable slots; excess callers wait for a slot
 * instead of creating unbounded profile directories or failing the job.
 */

import path from 'node:path'

export interface ProfileLaneLease {
  /** Suffix appended to `profiles/<sourceSlug>-`; absent for Tier A. */
  profileSuffix?: string
  /** Canonical physical directory owned by this logical lane slot. */
  profileDirectory: string
  /** A successful Chromium launch proves this slot healthy and resets backoff. */
  markLaunchSucceeded: () => void
  /** Idempotently return this fixed slot to the in-process pool. */
  release: () => void
  /** Return the slot only after a bounded launch-failure backoff. */
  releaseAfterLaunchFailure: () => void
  /** Permanently withhold this slot because resource closure was not proven. */
  quarantine: () => void
}

export interface ProfileLaneConfig {
  /** Logical mutex identity; deliberately independent from the directory name. */
  laneKey: string
  /** Stable directory suffix. Omit only for a single-slot unsuffixed lane. */
  profileSuffix?: string
  /** Number of fixed directories in this lane. */
  slotCount?: number
}

interface ProfileLanePool {
  sourceSlug: string
  laneKey: string
  profileSuffix?: string
  slotCount: number
  available: number[]
  quarantined: Set<number>
  cooling: Set<number>
  launchFailures: number[]
  waiters: Array<{
    resolve: (slot: number) => void
    reject: (error: Error) => void
  }>
}

const pools = new Map<string, ProfileLanePool>()
const directoryOwners = new Map<string, { poolKey: string; label: string }>()
const SAFE_SUFFIX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SAFE_SOURCE_SLUG = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/
const MAX_PROFILE_SLOTS = 16
const LAUNCH_BACKOFF_BASE_MS = 250
const LAUNCH_BACKOFF_MAX_MS = 5_000

export class ProfileLaneQuarantinedError extends Error {
  constructor(sourceSlug: string, laneKey: string) {
    super(
      `[ingest] persistent-profile lane ${sourceSlug}/${laneKey} has no healthy slots; ` +
        `worker restart required`
    )
    this.name = 'ProfileLaneQuarantinedError'
  }
}

function validateSlotCount(slotCount: number): void {
  if (!Number.isSafeInteger(slotCount) || slotCount < 1 || slotCount > MAX_PROFILE_SLOTS) {
    throw new Error(
      `[ingest] profile lane slot count must be an integer from 1 to ` +
        `${MAX_PROFILE_SLOTS}, got ${slotCount}`
    )
  }
}

export function validateProfileLaneConfig(config: ProfileLaneConfig): number {
  const { laneKey, profileSuffix } = config
  const slotCount = config.slotCount ?? 1
  if (!SAFE_SUFFIX.test(laneKey)) {
    throw new Error(`[ingest] unsafe persistent-profile lane key: ${laneKey}`)
  }
  if (profileSuffix !== undefined && !SAFE_SUFFIX.test(profileSuffix)) {
    throw new Error(`[ingest] unsafe persistent-profile suffix: ${profileSuffix}`)
  }
  validateSlotCount(slotCount)
  if (profileSuffix === undefined && slotCount !== 1) {
    throw new Error('[ingest] an unsuffixed persistent-profile lane must have exactly one slot')
  }
  return slotCount
}

function validateSourceSlug(sourceSlug: string): void {
  if (!SAFE_SOURCE_SLUG.test(sourceSlug)) {
    throw new Error(`[ingest] unsafe persistent-profile source slug: ${sourceSlug}`)
  }
}

function suffixForSlot(
  baseSuffix: string | undefined,
  slot: number,
  slotCount: number
): string | undefined {
  if (baseSuffix === undefined) return undefined
  return slotCount === 1 ? baseSuffix : `${baseSuffix}-${slot + 1}`
}

export function resolveProfileDirectory(sourceSlug: string, profileSuffix?: string): string {
  validateSourceSlug(sourceSlug)
  if (profileSuffix !== undefined && !SAFE_SUFFIX.test(profileSuffix)) {
    throw new Error(`[ingest] unsafe persistent-profile suffix: ${profileSuffix}`)
  }
  const profileName = profileSuffix ? `${sourceSlug}-${profileSuffix}` : sourceSlug
  return path.resolve(process.cwd(), '.arena-ingest', 'profiles', profileName)
}

function healthySlotCount(pool: ProfileLanePool): number {
  return pool.slotCount - pool.quarantined.size
}

function noHealthySlotsError(pool: ProfileLanePool): ProfileLaneQuarantinedError {
  return new ProfileLaneQuarantinedError(pool.sourceSlug, pool.laneKey)
}

function rejectWaitersIfExhausted(pool: ProfileLanePool): void {
  if (healthySlotCount(pool) > 0) return
  const error = noHealthySlotsError(pool)
  while (pool.waiters.length > 0) pool.waiters.shift()!.reject(error)
}

function returnSlot(pool: ProfileLanePool, slot: number): void {
  if (pool.quarantined.has(slot)) return
  const waiter = pool.waiters.shift()
  if (waiter) {
    waiter.resolve(slot)
    return
  }
  // FIFO rotation: returned slots go behind never-used/previously-returned
  // slots, so a transiently bad first slot cannot monopolize healthy launches.
  pool.available.push(slot)
}

function launchBackoffMs(failures: number): number {
  return Math.min(LAUNCH_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), LAUNCH_BACKOFF_MAX_MS)
}

/**
 * Acquire one of a fixed number of stable suffixes for a source/lane pair.
 *
 * The queue is FIFO. Releasing a lease hands its exact slot directly to the
 * oldest waiter, keeping both directory count and cookie jars bounded.
 */
export async function acquireProfileLane(
  sourceSlug: string,
  config: ProfileLaneConfig
): Promise<ProfileLaneLease> {
  const { laneKey, profileSuffix } = config
  const slotCount = validateProfileLaneConfig(config)
  validateSourceSlug(sourceSlug)

  const key = `${sourceSlug}\u0000${laneKey}`
  let pool = pools.get(key)
  if (!pool) {
    const resolvedSuffixes = Array.from({ length: slotCount }, (_, slot) =>
      suffixForSlot(profileSuffix, slot, slotCount)
    )
    for (const resolvedSuffix of resolvedSuffixes) {
      const directoryKey = resolveProfileDirectory(sourceSlug, resolvedSuffix)
      const owner = directoryOwners.get(directoryKey)
      if (owner && owner.poolKey !== key) {
        throw new Error(
          `[ingest] profile directory ${directoryKey} is already owned by lane ${owner.label}`
        )
      }
    }

    pool = {
      sourceSlug,
      laneKey,
      profileSuffix,
      slotCount,
      available: Array.from({ length: slotCount }, (_, slot) => slot),
      quarantined: new Set(),
      cooling: new Set(),
      launchFailures: Array.from({ length: slotCount }, () => 0),
      waiters: [],
    }
    pools.set(key, pool)
    for (const resolvedSuffix of resolvedSuffixes) {
      directoryOwners.set(resolveProfileDirectory(sourceSlug, resolvedSuffix), {
        poolKey: key,
        label: `${sourceSlug}/${laneKey}`,
      })
    }
  } else if (pool.slotCount !== slotCount || pool.profileSuffix !== profileSuffix) {
    throw new Error(
      `[ingest] profile lane ${sourceSlug}/${laneKey} already configured as ` +
        `suffix=${pool.profileSuffix ?? '<default>'}, slots=${pool.slotCount}; ` +
        `cannot reopen as suffix=${profileSuffix ?? '<default>'}, slots=${slotCount}`
    )
  }

  if (healthySlotCount(pool) === 0) throw noHealthySlotsError(pool)

  const slot =
    pool.available.shift() ??
    (await new Promise<number>((resolve, reject) => {
      pool.waiters.push({ resolve, reject })
    }))

  let settled = false
  const settleOnce = (settle: () => void) => {
    if (settled) return
    settled = true
    settle()
  }
  const resolvedSuffix = suffixForSlot(profileSuffix, slot, slotCount)
  return {
    profileSuffix: resolvedSuffix,
    profileDirectory: resolveProfileDirectory(sourceSlug, resolvedSuffix),
    markLaunchSucceeded: () => {
      if (!settled) pool.launchFailures[slot] = 0
    },
    release: () => settleOnce(() => returnSlot(pool, slot)),
    releaseAfterLaunchFailure: () =>
      settleOnce(() => {
        pool.launchFailures[slot] += 1
        const delayMs = launchBackoffMs(pool.launchFailures[slot])
        pool.cooling.add(slot)
        const timer = setTimeout(() => {
          pool.cooling.delete(slot)
          returnSlot(pool, slot)
        }, delayMs)
        timer.unref?.()
      }),
    quarantine: () =>
      settleOnce(() => {
        pool.quarantined.add(slot)
        rejectWaitersIfExhausted(pool)
      }),
  }
}
