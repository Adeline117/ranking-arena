/**
 * @jest-environment node
 */

const mockGetCache = jest.fn()
const mockSetCache = jest.fn()
const mockReadFence = jest.fn()
jest.mock('@/lib/cache', () => ({
  get: (...args: unknown[]) => mockGetCache(...args),
  set: (...args: unknown[]) => mockSetCache(...args),
  readSharedCacheWriteFence: (...args: unknown[]) => mockReadFence(...args),
}))

const mockRedisSet = jest.fn()
const mockGetSharedRedis = jest.fn()
jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: (...args: unknown[]) => mockGetSharedRedis(...args),
}))

const mockReleaseLock = jest.fn()
jest.mock('@/lib/cache/write-fence', () => ({
  compareAndDeleteSharedCacheLock: (...args: unknown[]) => mockReleaseLock(...args),
  createSharedCacheLockToken: () => 'request-owner',
}))

import {
  PUBLIC_RANKING_LKG_TTL_SECONDS,
  PUBLIC_RANKING_LKG_REDIS_TAG,
  PublicRankingUnavailableError,
  canonicalPublicRankingCacheKeys,
  createPublicRankingRequestDeadline,
  getCanonicalPublicRanking,
} from '../canonical-public-cache'

const fence = { key: 'public-rankings:write-fence:v1', token: 'publication-7' }
const keys = canonicalPublicRankingCacheKeys('api:rankings:90d:all')

function lkgEnvelope(payload: unknown, publicationToken = fence.token) {
  return {
    schema: 'public-ranking-canonical-v1',
    publicationToken,
    capturedAt: new Date().toISOString(),
    payload,
  }
}

describe('canonical public ranking resilience', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockReadFence.mockResolvedValue(fence)
    mockSetCache.mockResolvedValue(true)
    mockReleaseLock.mockResolvedValue(true)
    mockGetSharedRedis.mockResolvedValue({ set: mockRedisSet })
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('uses one canonical key pair independent of requested limit or page', () => {
    expect(keys).toEqual({
      liveKey: 'public-rank-policy-v6:canonical:v1:api:rankings:90d:all:live',
      lkgKey: 'public-rank-policy-v6:canonical:v1:api:rankings:90d:all:lkg',
    })
  })

  it('re-sanitizes a publication-fenced live payload on every read', async () => {
    const live = { traders: [{ source: 'safe' }, { source: 'blocked' }] }
    mockGetCache.mockImplementation(async (key: string) => (key === keys.liveKey ? live : null))
    const sanitize = jest.fn((payload: typeof live) => ({
      ...payload,
      traders: payload.traders.filter(({ source }) => source !== 'blocked'),
    }))
    const load = jest.fn()

    const result = await getCanonicalPublicRanking({
      keys,
      signal: new AbortController().signal,
      sanitize,
      load,
    })

    expect(result).toEqual({
      source: 'live',
      payload: { traders: [{ source: 'safe' }] },
    })
    expect(sanitize).toHaveBeenCalledTimes(1)
    expect(load).not.toHaveBeenCalled()
    expect(mockGetSharedRedis).not.toHaveBeenCalled()
  })

  it('rejects a cached payload when publication advances during the read', async () => {
    const live = { traders: [{ source: 'safe' }] }
    mockGetCache.mockImplementation(async (key: string) => (key === keys.liveKey ? live : null))
    mockReadFence
      .mockResolvedValueOnce(fence)
      .mockResolvedValue({ ...fence, token: 'publication-8' })
    mockGetSharedRedis.mockResolvedValue(null)
    const load = jest.fn()

    await expect(
      getCanonicalPublicRanking({
        keys,
        signal: new AbortController().signal,
        sanitize: (value) => value,
        load,
      })
    ).rejects.toBeInstanceOf(PublicRankingUnavailableError)
    expect(load).not.toHaveBeenCalled()
  })

  it('lets only the lock owner load and writes separate live and 24-hour LKG entries', async () => {
    mockGetCache.mockResolvedValue(null)
    mockRedisSet.mockResolvedValue('OK')
    const payload = { traders: [{ source: 'safe', rank: 1 }] }
    const load = jest.fn(async () => payload)

    const result = await getCanonicalPublicRanking({
      keys,
      signal: new AbortController().signal,
      sanitize: (value) => value,
      load,
      tags: ['season:90D'],
    })

    expect(result).toEqual({ source: 'fresh', payload })
    expect(load).toHaveBeenCalledTimes(1)
    expect(mockSetCache).toHaveBeenNthCalledWith(
      1,
      keys.liveKey,
      payload,
      expect.objectContaining({
        ttl: 300,
        tags: ['rankings:public-rank-policy-v6', 'season:90D'],
        writeFence: fence,
        writeLock: expect.objectContaining({ ownerToken: 'request-owner' }),
      })
    )
    expect(mockSetCache).toHaveBeenNthCalledWith(
      2,
      keys.lkgKey,
      expect.objectContaining({
        schema: 'public-ranking-canonical-v1',
        publicationToken: fence.token,
        payload,
      }),
      expect.objectContaining({
        ttl: PUBLIC_RANKING_LKG_TTL_SECONDS,
        tags: [PUBLIC_RANKING_LKG_REDIS_TAG],
        writeFence: fence,
      })
    )
    expect(mockReleaseLock).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(`:fence:${fence.token}`),
      'request-owner'
    )
  })

  it('never calls the loader and re-sanitizes a retained prior-publication LKG', async () => {
    jest.useFakeTimers()
    const fallback = {
      traders: [
        { source: 'safe', rank: 1 },
        { source: 'blocked', rank: 2 },
      ],
    }
    const sanitizedFallback = { traders: [{ source: 'safe', rank: 1 }] }
    mockGetCache.mockImplementation(async (key: string) =>
      key === keys.lkgKey ? lkgEnvelope(fallback, 'publication-6') : null
    )
    mockRedisSet.mockResolvedValue(null)
    const load = jest.fn()

    const pending = getCanonicalPublicRanking({
      keys,
      signal: new AbortController().signal,
      sanitize: (value) => ({
        ...value,
        traders: value.traders.filter(({ source }) => source !== 'blocked'),
      }),
      load,
    })
    await jest.advanceTimersByTimeAsync(75)

    await expect(pending).resolves.toEqual({ source: 'lkg', payload: sanitizedFallback })
    expect(load).not.toHaveBeenCalled()
  })

  it('fails a follower quickly when neither live nor LKG exists, without herd fetch', async () => {
    jest.useFakeTimers()
    mockGetCache.mockResolvedValue(null)
    mockRedisSet.mockResolvedValue(null)
    const load = jest.fn()

    const pending = getCanonicalPublicRanking({
      keys,
      signal: new AbortController().signal,
      sanitize: (value) => value,
      load,
    })
    const rejection = expect(pending).rejects.toBeInstanceOf(PublicRankingUnavailableError)
    await jest.advanceTimersByTimeAsync(75)

    await rejection
    expect(load).not.toHaveBeenCalled()
  })

  it('aborts a hanging owner source before the request deadline and returns LKG', async () => {
    jest.useFakeTimers()
    const fallback = { traders: [{ source: 'safe', rank: 1 }] }
    mockGetCache.mockImplementation(async (key: string) =>
      key === keys.lkgKey ? lkgEnvelope(fallback) : null
    )
    mockRedisSet.mockResolvedValue('OK')
    let sourceSignal: AbortSignal | undefined
    const load = jest.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>(() => {
          sourceSignal = signal
        })
    )

    const pending = getCanonicalPublicRanking({
      keys,
      signal: new AbortController().signal,
      sanitize: (value) => value,
      load,
    })
    await jest.advanceTimersByTimeAsync(4_500)

    await expect(pending).resolves.toEqual({ source: 'lkg', payload: fallback })
    expect(sourceSignal?.aborted).toBe(true)
    expect(mockSetCache).not.toHaveBeenCalled()
  })

  it('shortens the source budget after slow coordination so LKG verification keeps time', async () => {
    jest.useFakeTimers()
    const fallback = { traders: [{ source: 'safe', rank: 1 }] }
    mockGetCache.mockImplementation(async (key: string) =>
      key === keys.lkgKey ? lkgEnvelope(fallback) : null
    )
    mockRedisSet.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('OK'), 2_500))
    )
    let sourceSignal: AbortSignal | undefined
    const load = jest.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>(() => {
          sourceSignal = signal
        })
    )
    const deadline = createPublicRankingRequestDeadline(undefined, 6_500)

    const pending = getCanonicalPublicRanking({
      keys,
      signal: deadline.signal,
      sanitize: (value) => value,
      load,
    })
    await jest.advanceTimersByTimeAsync(5_000)

    await expect(pending).resolves.toEqual({ source: 'lkg', payload: fallback })
    expect(sourceSignal?.aborted).toBe(true)
    expect(deadline.signal.aborted).toBe(false)
    deadline.dispose()
  })
})
