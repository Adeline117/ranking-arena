/**
 * @jest-environment node
 */

const mockAdvanceSharedCacheWriteFenceAndDeleteTag = jest.fn()
const mockRevalidatePath = jest.fn()
const mockRevalidateTag = jest.fn()
const mockWarmDefaultPublicTradersCache = jest.fn()
const mockRefreshHomeInitialTradersCache = jest.fn()

jest.mock('@/lib/cache', () => ({
  advanceSharedCacheWriteFenceAndDeleteTag: (...args: unknown[]) =>
    mockAdvanceSharedCacheWriteFenceAndDeleteTag(...args),
}))

jest.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
  revalidateTag: (...args: unknown[]) => mockRevalidateTag(...args),
}))

jest.mock('@/app/api/traders/route', () => ({
  warmDefaultPublicTradersCache: (...args: unknown[]) => mockWarmDefaultPublicTradersCache(...args),
}))

jest.mock('@/lib/getInitialTraders', () => ({
  refreshHomeInitialTradersCache: (...args: unknown[]) =>
    mockRefreshHomeInitialTradersCache(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { TOP_EXCHANGE_SLUGS } from '@/lib/constants/exchange-slugs'
import { PUBLIC_RANKING_REDIS_TAG } from '@/lib/rankings/publication-policy'
import {
  revalidateRankingPages,
  warmupLeaderboardCache,
  warmupSsrHomepageCache,
} from '../post-processing'

const lease = {
  keys: ['cron:compute-leaderboard:running', 'cron:compute-leaderboard:running:7D'],
  ownerToken: 'lease-owner',
}

describe('leaderboard publication post-processing', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAdvanceSharedCacheWriteFenceAndDeleteTag.mockResolvedValue({
      fence: { key: 'public-rankings:write-fence:v1', token: '2' },
      deletedKeys: [],
    })
    mockWarmDefaultPublicTradersCache.mockResolvedValue(50)
    mockRefreshHomeInitialTradersCache.mockResolvedValue(50)
  })

  it('propagates a real public-response warmer failure', async () => {
    mockWarmDefaultPublicTradersCache.mockRejectedValue(new Error('Redis write not confirmed'))
    const supabase = { from: jest.fn() }

    await expect(warmupLeaderboardCache(supabase as never, ['30D'])).rejects.toThrow(
      'Redis write not confirmed'
    )
  })

  it('warms the exact public response for every requested season', async () => {
    const supabase = { from: jest.fn() }

    await expect(warmupLeaderboardCache(supabase as never, ['7D', '90D'])).resolves.toBeUndefined()
    expect(mockWarmDefaultPublicTradersCache).toHaveBeenNthCalledWith(1, supabase, '7D', 50)
    expect(mockWarmDefaultPublicTradersCache).toHaveBeenNthCalledWith(2, supabase, '90D', 50)
  })

  it('invalidates Redis, Next Data Cache, every exchange page, and ranking overviews', async () => {
    await expect(revalidateRankingPages(lease)).resolves.toBeUndefined()

    expect(mockAdvanceSharedCacheWriteFenceAndDeleteTag).toHaveBeenCalledWith(
      'public-rankings:write-fence:v1',
      PUBLIC_RANKING_REDIS_TAG,
      lease
    )
    expect(mockRevalidateTag).toHaveBeenCalledWith('rankings', { expire: 0 })
    for (const slug of TOP_EXCHANGE_SLUGS) {
      expect(mockRevalidatePath).toHaveBeenCalledWith(`/exchange/${slug}`)
    }
    expect(mockRevalidatePath).toHaveBeenCalledWith('/rankings/exchanges')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/rankings/weekly')
    expect(mockRevalidatePath).not.toHaveBeenCalledWith('/')
    expect(mockRevalidatePath).not.toHaveBeenCalledWith('/rankings/binance_futures')
  })

  it('warms shared SSR data before revalidating the homepage', async () => {
    const order: string[] = []
    mockRefreshHomeInitialTradersCache.mockImplementation(async () => {
      order.push('warm')
      return 50
    })
    mockRevalidatePath.mockImplementation((path: string) => {
      if (path === '/') order.push('revalidate')
    })

    await expect(warmupSsrHomepageCache()).resolves.toBeUndefined()

    expect(mockRefreshHomeInitialTradersCache).toHaveBeenCalledWith('90D', 50)
    expect(mockRevalidatePath).toHaveBeenCalledWith('/')
    expect(order).toEqual(['warm', 'revalidate'])
  })

  it('does not revalidate the homepage when its shared warmup is empty', async () => {
    mockRefreshHomeInitialTradersCache.mockResolvedValue(0)

    await expect(warmupSsrHomepageCache()).rejects.toThrow(
      'SSR homepage cache warmup returned no eligible rows'
    )
    expect(mockRevalidatePath).not.toHaveBeenCalledWith('/')
  })

  it('propagates tag invalidation failure to the lease-owning route', async () => {
    mockAdvanceSharedCacheWriteFenceAndDeleteTag.mockRejectedValue(new Error('Redis unavailable'))

    await expect(revalidateRankingPages(lease)).rejects.toThrow('Redis unavailable')
    expect(mockAdvanceSharedCacheWriteFenceAndDeleteTag).toHaveBeenCalledWith(
      'public-rankings:write-fence:v1',
      PUBLIC_RANKING_REDIS_TAG,
      lease
    )
    expect(mockRevalidateTag).not.toHaveBeenCalled()
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })
})
