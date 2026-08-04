import { get as getCache, readSharedCacheWriteFence, set as setCache } from '@/lib/cache'
import { getSharedRedis } from '@/lib/cache/redis-client'
import {
  compareAndDeleteSharedCacheLock,
  createSharedCacheLockToken,
  type SharedCacheWriteFence,
  type SharedCacheWriteLock,
} from '@/lib/cache/write-fence'
import {
  PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
  PUBLIC_RANKING_REDIS_TAG,
  publicRankingCacheKey,
} from '@/lib/rankings/publication-policy'

export const PUBLIC_RANKING_CANONICAL_LIMIT = 500
export const PUBLIC_RANKING_REQUEST_DEADLINE_MS = 6_500
export const PUBLIC_RANKING_SOURCE_BUDGET_MS = 4_500
export const PUBLIC_RANKING_FALLBACK_RESERVE_MS = 1_500
export const PUBLIC_RANKING_LIVE_TTL_SECONDS = 300
export const PUBLIC_RANKING_LKG_TTL_SECONDS = 24 * 60 * 60
export const PUBLIC_RANKING_LKG_REDIS_TAG = `rankings-lkg:${PUBLIC_RANKING_REDIS_TAG}:v1`

const CANONICAL_SCHEMA = 'public-ranking-canonical-v1'
const LOCK_TTL_SECONDS = 10
const FOLLOWER_POLL_MS = 75
const deadlineAtBySignal = new WeakMap<AbortSignal, number>()

interface CanonicalLkgEnvelope<T> {
  schema: typeof CANONICAL_SCHEMA
  publicationToken: string
  capturedAt: string
  payload: T
}

export interface CanonicalPublicRankingKeys {
  liveKey: string
  lkgKey: string
}

export interface CanonicalPublicRankingResult<T> {
  payload: T
  source: 'live' | 'fresh' | 'lkg'
}

export interface CanonicalPublicRankingLoadContext {
  signal: AbortSignal
  writeFence: SharedCacheWriteFence
}

export class PublicRankingUnavailableError extends Error {
  constructor(message = 'Public ranking data is temporarily unavailable', options?: ErrorOptions) {
    super(message, options)
    this.name = 'PublicRankingUnavailableError'
  }
}

export function canonicalPublicRankingCacheKeys(scope: string): CanonicalPublicRankingKeys {
  return {
    liveKey: publicRankingCacheKey(`canonical:v1:${scope}:live`),
    lkgKey: publicRankingCacheKey(`canonical:v1:${scope}:lkg`),
  }
}

export function createPublicRankingRequestDeadline(
  upstream?: AbortSignal,
  timeoutMs = PUBLIC_RANKING_REQUEST_DEADLINE_MS
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const abortFromUpstream = () => controller.abort(upstream?.reason)
  if (upstream?.aborted) abortFromUpstream()
  else upstream?.addEventListener('abort', abortFromUpstream, { once: true })

  const timeout = setTimeout(
    () => controller.abort(new PublicRankingUnavailableError('Public ranking request timed out')),
    timeoutMs
  )
  timeout.unref?.()
  deadlineAtBySignal.set(controller.signal, Date.now() + timeoutMs)

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      deadlineAtBySignal.delete(controller.signal)
      upstream?.removeEventListener('abort', abortFromUpstream)
    },
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new PublicRankingUnavailableError('Public ranking request was aborted')
}

export async function raceWithPublicRankingSignal<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) throw abortError(signal)

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function sameFence(expected: SharedCacheWriteFence, actual: SharedCacheWriteFence | null): boolean {
  return actual?.key === expected.key && actual.token === expected.token
}

function hasCanonicalPayloadShape(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as { traders?: unknown }).traders)
  )
}

async function verifyFence(expected: SharedCacheWriteFence, signal: AbortSignal): Promise<boolean> {
  const current = await raceWithPublicRankingSignal(
    readSharedCacheWriteFence(PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY),
    signal
  )
  return sameFence(expected, current)
}

async function readCanonicalLive<T>(
  key: string,
  writeFence: SharedCacheWriteFence,
  sanitize: (payload: T) => T,
  signal: AbortSignal
): Promise<T | null> {
  const cached = await raceWithPublicRankingSignal(getCache<T>(key, { skipMemory: true }), signal)
  if (!hasCanonicalPayloadShape(cached) || !(await verifyFence(writeFence, signal))) return null
  // Publication policy is deliberately re-applied on every read. A durable
  // fallback must never preserve a source that was quarantined after capture.
  return sanitize(cached as T)
}

function isCanonicalLkgEnvelope<T>(
  value: unknown,
  nowMs: number
): value is CanonicalLkgEnvelope<T> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Partial<CanonicalLkgEnvelope<T>>
  if (
    candidate.schema !== CANONICAL_SCHEMA ||
    typeof candidate.publicationToken !== 'string' ||
    candidate.publicationToken.length === 0 ||
    typeof candidate.capturedAt !== 'string' ||
    !hasCanonicalPayloadShape(candidate.payload)
  ) {
    return false
  }
  const capturedAtMs = Date.parse(candidate.capturedAt)
  return (
    Number.isFinite(capturedAtMs) &&
    capturedAtMs <= nowMs + 60_000 &&
    capturedAtMs >= nowMs - PUBLIC_RANKING_LKG_TTL_SECONDS * 1000
  )
}

async function readCanonicalLkg<T>(
  key: string,
  writeFence: SharedCacheWriteFence,
  sanitize: (payload: T) => T,
  signal: AbortSignal
): Promise<T | null> {
  const cached = await raceWithPublicRankingSignal(
    getCache<CanonicalLkgEnvelope<T>>(key, { skipMemory: true }),
    signal
  )
  if (!isCanonicalLkgEnvelope<T>(cached, Date.now()) || !(await verifyFence(writeFence, signal))) {
    return null
  }
  return sanitize(cached.payload)
}

function remainingSourceBudget(parent: AbortSignal): number {
  const deadlineAt = deadlineAtBySignal.get(parent)
  if (deadlineAt === undefined) return PUBLIC_RANKING_SOURCE_BUDGET_MS
  return Math.max(
    0,
    Math.min(
      PUBLIC_RANKING_SOURCE_BUDGET_MS,
      deadlineAt - Date.now() - PUBLIC_RANKING_FALLBACK_RESERVE_MS
    )
  )
}

function childSourceDeadline(
  parent: AbortSignal,
  timeoutMs: number
): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const abortFromParent = () => controller.abort(parent.reason)
  if (parent.aborted) abortFromParent()
  else parent.addEventListener('abort', abortFromParent, { once: true })
  const timeout = setTimeout(
    () => controller.abort(new PublicRankingUnavailableError('Ranking source timed out')),
    timeoutMs
  )
  timeout.unref?.()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      parent.removeEventListener('abort', abortFromParent)
    },
  }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await raceWithPublicRankingSignal(
    new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, ms)
      timeout.unref?.()
    }),
    signal
  )
}

export async function publishCanonicalPublicRankingPayload<T>(options: {
  keys: CanonicalPublicRankingKeys
  payload: T
  sanitize: (payload: T) => T
  writeFence: SharedCacheWriteFence
  tags?: string[]
  writeLock?: SharedCacheWriteLock
  signal?: AbortSignal
}): Promise<{ liveWritten: boolean; lkgWritten: boolean; payload: T }> {
  const payload = options.sanitize(options.payload)
  if (!hasCanonicalPayloadShape(payload)) {
    throw new PublicRankingUnavailableError('Canonical ranking payload is invalid')
  }
  const liveTags = [...new Set([PUBLIC_RANKING_REDIS_TAG, ...(options.tags ?? [])])]
  const guardedOptions = {
    skipMemory: true,
    writeFence: options.writeFence,
    writeLock: options.writeLock,
  }
  const envelope: CanonicalLkgEnvelope<T> = {
    schema: CANONICAL_SCHEMA,
    publicationToken: options.writeFence.token,
    capturedAt: new Date().toISOString(),
    payload,
  }

  const liveWrite = setCache(options.keys.liveKey, payload, {
    ...guardedOptions,
    tags: liveTags,
    ttl: PUBLIC_RANKING_LIVE_TTL_SECONDS,
  })
  const liveWritten = options.signal
    ? await raceWithPublicRankingSignal(liveWrite, options.signal)
    : await liveWrite
  const lkgWrite = setCache(options.keys.lkgKey, envelope, {
    ...guardedOptions,
    // Deliberately retained across ordinary leaderboard publication. The old
    // envelope token proves it was produced by a fenced writer; the reader
    // brackets it with the *current* stable fence and re-sanitizes it before
    // serving as explicitly stale data. Late old-generation writes still fail.
    tags: [PUBLIC_RANKING_LKG_REDIS_TAG],
    ttl: PUBLIC_RANKING_LKG_TTL_SECONDS,
  })
  const lkgWritten = options.signal
    ? await raceWithPublicRankingSignal(lkgWrite, options.signal)
    : await lkgWrite

  return { liveWritten, lkgWritten, payload }
}

async function latestLkgOrUnavailable<T>(options: {
  keys: CanonicalPublicRankingKeys
  writeFence: SharedCacheWriteFence
  sanitize: (payload: T) => T
  signal: AbortSignal
  existingLkg?: T | null
  cause?: unknown
}): Promise<CanonicalPublicRankingResult<T>> {
  if (options.existingLkg != null && (await verifyFence(options.writeFence, options.signal))) {
    return { payload: options.existingLkg, source: 'lkg' }
  }
  const lkg = await readCanonicalLkg(
    options.keys.lkgKey,
    options.writeFence,
    options.sanitize,
    options.signal
  )
  if (lkg !== null) return { payload: lkg, source: 'lkg' }
  throw new PublicRankingUnavailableError('No publication-safe ranking snapshot is available', {
    cause: options.cause,
  })
}

/**
 * Resolve one canonical public leaderboard generation.
 *
 * Only the distributed-lock owner may call `load`. Followers never execute a
 * lock-timeout source fetch: they observe the owner's live write, use the
 * independent durable LKG, or fail quickly with 503 at the route boundary.
 */
export async function getCanonicalPublicRanking<T>(options: {
  keys: CanonicalPublicRankingKeys
  signal: AbortSignal
  sanitize: (payload: T) => T
  load: (context: CanonicalPublicRankingLoadContext) => Promise<T>
  tags?: string[]
}): Promise<CanonicalPublicRankingResult<T>> {
  const writeFence = await raceWithPublicRankingSignal(
    readSharedCacheWriteFence(PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY),
    options.signal
  )
  if (!writeFence) {
    throw new PublicRankingUnavailableError('Ranking publication fence is unavailable')
  }

  const live = await readCanonicalLive(
    options.keys.liveKey,
    writeFence,
    options.sanitize,
    options.signal
  )
  if (live !== null) return { payload: live, source: 'live' }

  // Read before attempting the source so followers and failed owners already
  // know whether a durable, publication-matched response exists.
  const existingLkg = await readCanonicalLkg(
    options.keys.lkgKey,
    writeFence,
    options.sanitize,
    options.signal
  )

  const redis = await raceWithPublicRankingSignal(getSharedRedis(), options.signal)
  if (!redis) {
    return latestLkgOrUnavailable({
      ...options,
      writeFence,
      existingLkg,
      cause: new PublicRankingUnavailableError('Ranking coordination cache is unavailable'),
    })
  }

  const lockKey = `lock:${options.keys.liveKey}:fence:${writeFence.token}`
  const ownerToken = createSharedCacheLockToken()
  let acquired = false
  try {
    const result = await raceWithPublicRankingSignal(
      redis.set(lockKey, ownerToken, { ex: LOCK_TTL_SECONDS, nx: true }),
      options.signal
    )
    acquired = result === 'OK'
  } catch (error) {
    return latestLkgOrUnavailable({ ...options, writeFence, existingLkg, cause: error })
  }

  if (!acquired) {
    // Give a successful owner one short opportunity to publish. There is no
    // direct source fallback here, which is the critical anti-herd property.
    await delay(FOLLOWER_POLL_MS, options.signal)
    const published = await readCanonicalLive(
      options.keys.liveKey,
      writeFence,
      options.sanitize,
      options.signal
    )
    if (published !== null) return { payload: published, source: 'live' }
    return latestLkgOrUnavailable({ ...options, writeFence, existingLkg })
  }

  const writeLock = { key: lockKey, ownerToken }
  try {
    const doubleCheck = await readCanonicalLive(
      options.keys.liveKey,
      writeFence,
      options.sanitize,
      options.signal
    )
    if (doubleCheck !== null) return { payload: doubleCheck, source: 'live' }

    const sourceBudgetMs = remainingSourceBudget(options.signal)
    if (sourceBudgetMs <= 0) {
      return latestLkgOrUnavailable({ ...options, writeFence, existingLkg })
    }
    const sourceDeadline = childSourceDeadline(options.signal, sourceBudgetMs)
    try {
      const loaded = await raceWithPublicRankingSignal(
        options.load({ signal: sourceDeadline.signal, writeFence }),
        sourceDeadline.signal
      )
      const published = await publishCanonicalPublicRankingPayload({
        keys: options.keys,
        payload: loaded,
        sanitize: options.sanitize,
        writeFence,
        writeLock,
        tags: options.tags,
        signal: options.signal,
      })
      if (!published.liveWritten || !(await verifyFence(writeFence, options.signal))) {
        throw new PublicRankingUnavailableError('Ranking publication changed during refresh')
      }
      return { payload: published.payload, source: 'fresh' }
    } finally {
      sourceDeadline.dispose()
    }
  } catch (error) {
    return latestLkgOrUnavailable({ ...options, writeFence, existingLkg, cause: error })
  } finally {
    // Never extend the public request beyond its deadline just to release a
    // lease. The compare-and-delete is ownership-safe; TTL is the final guard.
    void compareAndDeleteSharedCacheLock(redis, lockKey, ownerToken).catch(() => undefined)
  }
}
