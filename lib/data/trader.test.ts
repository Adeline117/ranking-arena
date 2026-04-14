/**
 * Trader Data Adapter Tests
 * 测试交易员数据适配层
 */

// Mock modules BEFORE imports - factories must not reference outer scope
jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn(),
    single: jest.fn(),
  },
}))

jest.mock('@/lib/cache', () => ({
  getOrSet: jest.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
  CacheKey: {
    traders: {
      detail: (handle: string) => `trader:${handle}`,
      performance: (handle: string, period: string) => `trader:${handle}:${period}`,
    },
  },
  CACHE_TTL: {
    TRADER_DETAIL: 300,
    TRADER_PERFORMANCE: 300,
  },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  }),
}))

jest.mock('./trader-followers', () => ({
  getTraderArenaFollowersCount: jest.fn().mockResolvedValue(100),
}))

// Now import modules after mocks are set up
import {
  TRADER_SOURCES,
  TRADER_SOURCES_WITH_WEB3,
  findTraderAcrossSources,
  findTradersAcrossSources,
  getTraderByHandle,
  getTraderStats,
  clearSourceCache,
} from './trader'
import { supabase } from '@/lib/supabase/client'

// Cast to jest mocks for type safety
const mockSupabase = supabase as jest.Mocked<typeof supabase>

describe('Trader Constants', () => {
  test('TRADER_SOURCES should contain expected exchanges', () => {
    expect(TRADER_SOURCES).toContain('binance')
    expect(TRADER_SOURCES).toContain('bybit')
    expect(TRADER_SOURCES).toContain('bitget')
    expect(TRADER_SOURCES).toContain('okx')
    expect(TRADER_SOURCES.length).toBe(8)
  })

  test('TRADER_SOURCES_WITH_WEB3 should include binance_web3', () => {
    expect(TRADER_SOURCES_WITH_WEB3).toContain('binance_web3')
    expect(TRADER_SOURCES_WITH_WEB3.length).toBe(TRADER_SOURCES.length + 1)
  })
})

describe('findTraderAcrossSources', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    clearSourceCache()
    // Reset mock chain
    ;(mockSupabase.from as jest.Mock).mockReturnThis()
    ;(mockSupabase.select as jest.Mock).mockReturnThis()
    ;(mockSupabase.eq as jest.Mock).mockReturnThis()
    ;(mockSupabase.order as jest.Mock).mockReturnThis()
    ;(mockSupabase.limit as jest.Mock).mockReturnThis()
  })

  test('should return null for empty handle', async () => {
    ;(mockSupabase.limit as jest.Mock).mockResolvedValue({ data: [], error: null })

    const result = await findTraderAcrossSources('')
    expect(result).toBeNull()
  })

  test('should return trader source record when found', async () => {
    const mockTrader = {
      source_trader_id: 'trader123',
      handle: 'testTrader',
      profile_url: 'https://example.com/avatar.png',
      source: 'binance',
    }

    ;(mockSupabase.limit as jest.Mock).mockResolvedValue({ data: [mockTrader], error: null })

    const result = await findTraderAcrossSources('testTrader')
    expect(result).toEqual(mockTrader)
  })

  test('should return null when no trader found', async () => {
    ;(mockSupabase.limit as jest.Mock).mockResolvedValue({ data: [], error: null })

    const result = await findTraderAcrossSources('nonexistent')
    expect(result).toBeNull()
  })

  test('should return null on error', async () => {
    ;(mockSupabase.limit as jest.Mock).mockResolvedValue({ data: null, error: new Error('DB error') })

    const result = await findTraderAcrossSources('testTrader')
    expect(result).toBeNull()
  })
})

describe('findTradersAcrossSources', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(mockSupabase.from as jest.Mock).mockReturnThis()
    ;(mockSupabase.select as jest.Mock).mockReturnThis()
    ;(mockSupabase.in as jest.Mock).mockReturnThis()
    ;(mockSupabase.order as jest.Mock).mockReturnThis()
  })

  test('should return empty Map for empty handles', async () => {
    const result = await findTradersAcrossSources([])
    expect(result).toBeInstanceOf(Map)
    expect(result.size).toBe(0)
  })

  test('should return Map of traders for given handles', async () => {
    const mockTraders = [
      { handle: 'trader1', source: 'binance' },
      { handle: 'trader2', source: 'bybit' },
    ]

    ;(mockSupabase.order as jest.Mock).mockResolvedValue({ data: mockTraders, error: null })

    const result = await findTradersAcrossSources(['trader1', 'trader2'])
    expect(result).toBeInstanceOf(Map)
    // The result is a Map keyed by handle
  })

  test('should return empty Map on error', async () => {
    ;(mockSupabase.order as jest.Mock).mockResolvedValue({ data: null, error: new Error('DB error') })

    const result = await findTradersAcrossSources(['trader1'])
    expect(result).toBeInstanceOf(Map)
    expect(result.size).toBe(0)
  })
})

describe('getTraderByHandle', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(mockSupabase.from as jest.Mock).mockReturnThis()
    ;(mockSupabase.select as jest.Mock).mockReturnThis()
    ;(mockSupabase.eq as jest.Mock).mockReturnThis()
    ;(mockSupabase.order as jest.Mock).mockReturnThis()
    ;(mockSupabase.maybeSingle as jest.Mock).mockReturnThis()
  })

  test('should return null for empty handle', async () => {
    const result = await getTraderByHandle('')
    expect(result).toEqual({ ok: true, data: null })
  })

  test('should return null when trader not found', async () => {
    // Mock the order query to return no results
    ;(mockSupabase.order as jest.Mock).mockResolvedValue({ data: [], error: null })

    const result = await getTraderByHandle('nonexistent')
    expect(result.ok).toBe(true)
    expect(result.data).toBeNull()
  })
})

describe('getTraderStats', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(mockSupabase.from as jest.Mock).mockReturnThis()
    ;(mockSupabase.select as jest.Mock).mockReturnThis()
    ;(mockSupabase.eq as jest.Mock).mockReturnThis()
    ;(mockSupabase.order as jest.Mock).mockReturnThis()
    ;(mockSupabase.limit as jest.Mock).mockReturnThis()
    ;(mockSupabase.maybeSingle as jest.Mock).mockReturnThis()
  })

  test('should return default stats when trader not found', async () => {
    // Mock the order query to return no results (trader not found)
    ;(mockSupabase.order as jest.Mock).mockResolvedValue({ data: [], error: null })

    const result = await getTraderStats('nonexistent')
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ additionalStats: {} })
  })

  test('should return stats object structure', async () => {
    // The function always returns a DataResult wrapping TraderStats
    ;(mockSupabase.order as jest.Mock).mockResolvedValue({ data: [], error: null })

    const result = await getTraderStats('testTrader')
    expect(result.ok).toBe(true)
    expect(result.data).toHaveProperty('additionalStats')
  })
})
